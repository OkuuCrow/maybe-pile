/**
 * Progress tracking for all media types. Every update:
 * 1. validates the entry against the item's type and current scheme,
 * 2. records a history row (in the unit it was made in),
 * 3. recomputes the cached progress columns,
 * 4. derives status *suggestions* (never forced changes),
 * all inside one transaction.
 */
import { type z } from 'zod';
import { appError } from '../../shared/result';
import type {
  AddProgressInput,
  EditProgressInput,
  EpisodeToggleInput,
  EpisodeUpsertSchema,
  MilestonesSetSchema,
  SeasonUpsertSchema,
  ViewingEditSchema,
  ViewingInputSchema,
} from '../../shared/schemas';
import type {
  MutationOutcome,
  ProgressEventView,
  ProgressSummary,
  StatusSuggestion,
  ViewingView,
} from '../../shared/types';
import { allowedEntryKinds } from '../../domain/progress';
import { suggestionsAfterProgress } from '../../domain/status-rules';
import * as items from '../../db/repositories/items-repo';
import * as prog from '../../db/repositories/progress-repo';
import type { ServiceContext } from './context';
import type { LibraryService } from './library-service';

export class ProgressService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
  ) {}

  private get db() {
    return this.ctx.db();
  }
  private nowIso() {
    return this.ctx.clock.now().toISOString();
  }

  private requireItem(id: string) {
    const row = items.getItemRow(this.db, id);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    return row;
  }

  /**
   * Wraps a progress mutation: captures before/after progress, computes
   * suggestions, applies auto-applicable ones if enabled.
   */
  private withSuggestions(
    itemId: string,
    mutate: () => void,
    extra: (after: ProgressSummary) => StatusSuggestion[] = () => [],
  ): MutationOutcome {
    const db = this.db;
    let pending: StatusSuggestion[] = [];
    let applied: StatusSuggestion[] = [];
    db.transaction(() => {
      const before = items.computeProgress(db, itemId);
      mutate();
      const after = items.recomputeProgress(db, itemId);
      const row = this.requireItem(itemId);
      const suggestions = suggestionsAfterProgress(
        {
          type: row.type,
          status: row.status,
          dateStarted: row.date_started,
          dateCompleted: row.date_completed,
          pass: row.pass,
        },
        before,
        after,
        this.library.today(),
      );
      for (const s of extra(after)) if (!suggestions.some((x) => x.kind === s.kind)) suggestions.push(s);
      ({ pending, applied } = this.library.resolveSuggestions(itemId, suggestions));
      items.touch(db, itemId, this.nowIso());
    });
    return { item: this.library.get(itemId), suggestions: pending, applied };
  }

  /* ---------------------------------------------------------------- generic entries */

  add(input: AddProgressInput): MutationOutcome {
    const row = this.requireItem(input.itemId);
    const db = this.db;
    const scheme =
      row.type === 'game'
        ? (db.get<{ progress_scheme: 'percent' | 'hours' | 'milestones' | 'text' }>(
            'SELECT progress_scheme FROM game_details WHERE item_id = ?',
            [row.id],
          )?.progress_scheme ?? 'percent')
        : null;
    const allowed = allowedEntryKinds(row.type, scheme);
    if (!allowed.includes(input.entry.kind)) {
      throw appError(
        'VALIDATION',
        `This kind of progress ("${input.entry.kind}") can't be recorded for this item.`,
        {
          recovery:
            row.type === 'game'
              ? 'Switch the game’s progress scheme first.'
              : 'Use the progress controls shown for this item.',
        },
      );
    }
    const now = this.nowIso();
    const e = input.entry;
    let milestoneTitle: string | null = null;
    if (e.kind === 'milestone') {
      const m = db.get<{ title: string }>('SELECT title FROM game_milestones WHERE id = ? AND item_id = ?', [
        e.milestoneId,
        row.id,
      ]);
      if (!m) throw appError('VALIDATION', 'That milestone no longer exists.');
      milestoneTitle = m.title;
    }
    const pageCount =
      row.type === 'book'
        ? (db.get<{ page_count: number | null }>('SELECT page_count FROM book_details WHERE item_id = ?', [
            row.id,
          ])?.page_count ?? null)
        : null;
    return this.withSuggestions(row.id, () => {
      prog.insertProgressEvent(db, {
        itemId: row.id,
        kind: e.kind,
        value: 'value' in e ? e.value : null,
        text: e.kind === 'text' ? e.text : null,
        totalAtTime: e.kind === 'pages' ? pageCount : null,
        milestoneId: e.kind === 'milestone' ? e.milestoneId : null,
        milestoneTitle,
        episodeId: null,
        episodeLabel: null,
        watched: null,
        scheme,
        pass: row.pass,
        occurredAt: input.occurredAt ?? now,
        recordedAt: now,
        note: input.note,
      });
    });
  }

  history(itemId: string): ProgressEventView[] {
    this.requireItem(itemId);
    return prog.listHistory(this.db, itemId);
  }

  edit(input: EditProgressInput): MutationOutcome {
    const ev = prog.getEvent(this.db, input.eventId);
    if (!ev) throw appError('NOT_FOUND', 'That history entry no longer exists.');
    if (ev.kind === 'percent' && input.value !== null && input.value > 100) {
      throw appError('VALIDATION', 'Percent must be between 0 and 100.', {
        fieldErrors: { value: 'Use 0–100.' },
      });
    }
    const numeric = ['percent', 'hours', 'pages', 'audio'].includes(ev.kind);
    return this.withSuggestions(ev.item_id, () => {
      prog.updateEvent(this.db, ev.id, {
        occurredAt: input.occurredAt,
        note: input.note,
        value: numeric ? input.value : null,
        text: ev.kind === 'text' ? input.text : null,
      });
    });
  }

  remove(eventId: string): MutationOutcome {
    const ev = prog.getEvent(this.db, eventId);
    if (!ev) throw appError('NOT_FOUND', 'That history entry no longer exists.');
    return this.withSuggestions(ev.item_id, () => prog.softDeleteEvent(this.db, eventId, this.nowIso()));
  }

  /* ---------------------------------------------------------------- movies */

  addViewing(input: z.infer<typeof ViewingInputSchema>): MutationOutcome {
    const row = this.requireItem(input.itemId);
    if (row.type !== 'movie') throw appError('VALIDATION', 'Viewings can only be logged for movies.');
    return this.withSuggestions(row.id, () => {
      prog.addViewing(this.db, row.id, input.watchedAt, input.note, row.pass, this.nowIso());
    });
  }

  editViewing(input: z.infer<typeof ViewingEditSchema>): MutationOutcome {
    const v = prog.getViewing(this.db, input.viewingId);
    if (!v) throw appError('NOT_FOUND', 'That viewing no longer exists.');
    return this.withSuggestions(v.item_id, () => {
      this.db.run('UPDATE viewing_events SET watched_at = ?, note = ? WHERE id = ?', [
        input.watchedAt,
        input.note,
        input.viewingId,
      ]);
    });
  }

  removeViewing(viewingId: string): MutationOutcome {
    const v = prog.getViewing(this.db, viewingId);
    if (!v) throw appError('NOT_FOUND', 'That viewing no longer exists.');
    return this.withSuggestions(v.item_id, () => {
      this.db.run('DELETE FROM viewing_events WHERE id = ?', [viewingId]);
    });
  }

  viewings(itemId: string): ViewingView[] {
    this.requireItem(itemId);
    return prog.listViewings(this.db, itemId);
  }

  /* ---------------------------------------------------------------- TV */

  toggleEpisodes(input: EpisodeToggleInput): MutationOutcome {
    const row = this.requireItem(input.itemId);
    if (row.type !== 'tv') throw appError('VALIDATION', 'Episodes belong to TV shows only.');
    const db = this.db;
    const eps = prog.episodesForItem(db, row.id, input.episodeIds);
    if (eps.length !== new Set(input.episodeIds).size)
      throw appError('VALIDATION', 'Some episodes do not belong to this show.');
    const changing = eps.filter((e) => (e.watched === 1) !== input.watched);
    const now = this.nowIso();
    return this.withSuggestions(
      row.id,
      () => {
        if (changing.length === 0) return;
        prog.setEpisodesWatched(
          db,
          changing.map((e) => e.id),
          input.watched,
          now,
        );
        const base = {
          itemId: row.id,
          totalAtTime: null,
          milestoneId: null,
          milestoneTitle: null,
          scheme: null,
          pass: row.pass,
          occurredAt: now,
          recordedAt: now,
          note: null,
          watched: input.watched,
        } as const;
        if (input.scope === 'episode' && changing.length === 1) {
          const e = changing[0];
          if (!e) return;
          prog.insertProgressEvent(db, {
            ...base,
            kind: 'episode',
            value: null,
            text: null,
            episodeId: e.id,
            episodeLabel: prog.episodeLabel(e.season_number, e.episode_number),
          });
        } else {
          const sorted = [...changing].sort(
            (a, b) => a.season_number - b.season_number || a.episode_number - b.episode_number,
          );
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const range =
            first && last
              ? `${prog.episodeLabel(first.season_number, first.episode_number)}–${prog.episodeLabel(last.season_number, last.episode_number)}`
              : '';
          prog.insertProgressEvent(db, {
            ...base,
            kind: 'season',
            value: changing.length,
            text: `${input.watched ? 'Watched' : 'Unwatched'} ${changing.length} episode(s) ${range}`,
            episodeId: null,
            episodeLabel: range,
          });
        }
      },
      // Un-watching anything in a Completed show prompts to move back to In Progress.
      () =>
        !input.watched && row.status === 'completed' && changing.length > 0
          ? [
              {
                kind: 'reopen',
                status: 'in_progress',
                message: 'You un-watched an episode of a Completed show. Move it back to In Progress?',
                setDateStarted: null,
              },
            ]
          : [],
    );
  }

  upsertSeason(input: z.infer<typeof SeasonUpsertSchema>): MutationOutcome {
    const row = this.requireItem(input.itemId);
    if (row.type !== 'tv') throw appError('VALIDATION', 'Seasons belong to TV shows only.');
    const db = this.db;
    const clash = db.get<{ id: string }>('SELECT id FROM seasons WHERE item_id = ? AND season_number = ?', [
      row.id,
      input.number,
    ]);
    if (clash && clash.id !== input.seasonId) {
      throw appError('CONFLICT', `Season ${input.number} already exists.`, {
        fieldErrors: { number: 'This season number is already used.' },
      });
    }
    return this.withSuggestions(row.id, () => {
      if (input.seasonId) {
        const r = db.run(
          'UPDATE seasons SET season_number = ?, title = ?, episode_count_known = ? WHERE id = ? AND item_id = ?',
          [input.number, input.title, input.episodeCountKnown, input.seasonId, row.id],
        );
        if (r.changes === 0) throw appError('NOT_FOUND', 'That season no longer exists.');
      } else {
        prog.insertSeasons(
          db,
          row.id,
          [
            {
              number: input.number,
              title: input.title,
              episodeCountKnown: input.episodeCountKnown,
              episodes: [],
            },
          ],
          'user',
        );
      }
    });
  }

  deleteSeason(itemId: string, seasonId: string): MutationOutcome {
    this.requireItem(itemId);
    return this.withSuggestions(itemId, () => {
      const r = this.db.run('DELETE FROM seasons WHERE id = ? AND item_id = ?', [seasonId, itemId]);
      if (r.changes === 0) throw appError('NOT_FOUND', 'That season no longer exists.');
    });
  }

  upsertEpisode(input: z.infer<typeof EpisodeUpsertSchema>): MutationOutcome {
    const row = this.requireItem(input.itemId);
    const db = this.db;
    const season = db.get<{ id: string }>('SELECT id FROM seasons WHERE id = ? AND item_id = ?', [
      input.seasonId,
      row.id,
    ]);
    if (!season) throw appError('NOT_FOUND', 'That season no longer exists.');
    const clash = db.get<{ id: string }>(
      'SELECT id FROM episodes WHERE season_id = ? AND episode_number = ?',
      [season.id, input.number],
    );
    if (clash && clash.id !== input.episodeId) {
      throw appError('CONFLICT', `Episode ${input.number} already exists in this season.`, {
        fieldErrors: { number: 'This episode number is already used.' },
      });
    }
    return this.withSuggestions(row.id, () => {
      if (input.episodeId) {
        // User edits convert a provider episode to a user episode so refreshes won't overwrite them.
        const r = db.run(
          "UPDATE episodes SET episode_number = ?, title = ?, air_date = ?, runtime = ?, source = 'user' WHERE id = ? AND item_id = ?",
          [input.number, input.title, input.airDate, input.runtime, input.episodeId, row.id],
        );
        if (r.changes === 0) throw appError('NOT_FOUND', 'That episode no longer exists.');
      } else {
        db.run(
          `INSERT INTO episodes (id, season_id, item_id, episode_number, title, air_date, runtime, watched, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'user')`,
          [items.newId(), season.id, row.id, input.number, input.title, input.airDate, input.runtime],
        );
      }
    });
  }

  deleteEpisode(itemId: string, episodeId: string): MutationOutcome {
    this.requireItem(itemId);
    return this.withSuggestions(itemId, () => {
      const r = this.db.run('DELETE FROM episodes WHERE id = ? AND item_id = ?', [episodeId, itemId]);
      if (r.changes === 0) throw appError('NOT_FOUND', 'That episode no longer exists.');
    });
  }

  /* ---------------------------------------------------------------- games */

  setMilestones(input: z.infer<typeof MilestonesSetSchema>): MutationOutcome {
    const row = this.requireItem(input.itemId);
    if (row.type !== 'game') throw appError('VALIDATION', 'Milestones belong to games only.');
    return this.withSuggestions(row.id, () => prog.setMilestones(this.db, row.id, input.milestones));
  }

  setScheme(itemId: string, scheme: 'percent' | 'hours' | 'milestones' | 'text'): MutationOutcome {
    const row = this.requireItem(itemId);
    if (row.type !== 'game') throw appError('VALIDATION', 'Only games have a progress scheme.');
    // Switching never touches history: entries keep the scheme they were made under.
    return this.withSuggestions(row.id, () => {
      this.db.run('UPDATE game_details SET progress_scheme = ? WHERE item_id = ?', [scheme, row.id]);
    });
  }
}

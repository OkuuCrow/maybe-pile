/**
 * Pick for Me: loads candidates with one indexed query, filters and picks with
 * the pure domain functions, and records picks / skips locally.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { MediaType, Status } from '../../shared/enums';
import { appError } from '../../shared/result';
import type { PickRequest } from '../../shared/schemas';
import type { PickHistoryView, PickResultView } from '../../shared/types';
import { addDays } from '../../domain/calendar';
import { localDate } from '../../domain/dates';
import {
  CONSTRAINT_LABELS,
  filterCandidates,
  mulberry32,
  pickReasons,
  pickWeighted,
  type PickCandidate,
} from '../../domain/pick';
import { readSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';
import type { LibraryService } from './library-service';

const SEP = '\u001f';

export class PickService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
  ) {}

  private get db() {
    return this.ctx.db();
  }
  private today(): string {
    return localDate(this.ctx.clock.now());
  }

  candidates(): PickCandidate[] {
    const today = this.today();
    return this.db
      .all<{
        id: string;
        title: string;
        type: MediaType;
        status: Status;
        date_added: string;
        rating: number | null;
        progress_pct: number | null;
        runtime: number | null;
        ep_runtime: number | null;
        tags: string | null;
        genres: string | null;
        lists: string | null;
        queued: number;
        snoozed: number;
        skipped: number;
      }>(
        `SELECT i.id, i.title, i.type, i.status, i.date_added, i.rating, i.progress_pct,
                md.runtime_minutes AS runtime, td.episode_runtime AS ep_runtime,
                (SELECT group_concat(t.name, '${SEP}') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id) AS tags,
                (SELECT group_concat(g.name, '${SEP}') FROM item_genres ig JOIN genres g ON g.id = ig.genre_id WHERE ig.item_id = i.id) AS genres,
                (SELECT group_concat(li.list_id, '${SEP}') FROM list_items li WHERE li.item_id = i.id) AS lists,
                EXISTS (SELECT 1 FROM up_next u WHERE u.item_id = i.id) AS queued,
                EXISTS (SELECT 1 FROM item_snoozes z WHERE z.item_id = i.id AND z.reason <> 'keep' AND z.until >= ?) AS snoozed,
                EXISTS (SELECT 1 FROM pick_history h WHERE h.item_id = i.id AND h.skip_until >= ?) AS skipped
         FROM items i
         LEFT JOIN movie_details md ON md.item_id = i.id
         LEFT JOIN tv_details td ON td.item_id = i.id
         WHERE i.deleted_at IS NULL AND i.status IN ('planned', 'in_progress', 'on_hold')`,
        [today, today],
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        status: r.status,
        dateAdded: r.date_added,
        rating: r.rating,
        progressPercent: r.progress_pct,
        runtimeMinutes: r.runtime,
        episodeRuntime: r.ep_runtime,
        tags: r.tags ? r.tags.split(SEP) : [],
        genres: r.genres ? r.genres.split(SEP) : [],
        listIds: r.lists ? r.lists.split(SEP) : [],
        inUpNext: r.queued === 1,
        excluded: r.snoozed === 1 ? 'snoozed' : r.skipped === 1 ? 'skipped' : null,
      }));
  }

  roll(req: PickRequest): PickResultView {
    const { pick: prefs } = readSettings(this.db).settings;
    const today = this.today();
    const { eligible, emptiedBy } = filterCandidates(this.candidates(), req.constraints);
    const rng = mulberry32(req.seed ?? randomInt(0, 2 ** 32 - 1));
    const chosen = pickWeighted(eligible, prefs, today, rng, req.avoid);
    if (!chosen) {
      return {
        historyId: null,
        pick: null,
        reasons: [],
        eligibleCount: 0,
        emptiedBy,
        emptiedByLabel: emptiedBy ? CONSTRAINT_LABELS[emptiedBy] : null,
      };
    }
    const historyId = randomUUID();
    this.db.transaction(() => {
      this.db.run("INSERT INTO pick_history (id, item_id, picked_at, outcome) VALUES (?, ?, ?, 'shown')", [
        historyId,
        chosen.id,
        this.ctx.clock.now().toISOString(),
      ]);
      // Keep the local history small: the last 200 picks.
      this.db.run(
        'DELETE FROM pick_history WHERE id NOT IN (SELECT id FROM pick_history ORDER BY picked_at DESC LIMIT 200) AND (skip_until IS NULL OR skip_until < ?)',
        [today],
      );
    });
    return {
      historyId,
      pick: items.summariesWhere(this.db, 'i.id = ?', [chosen.id], '')[0] ?? null,
      reasons: pickReasons(chosen, req.constraints, today),
      eligibleCount: eligible.length,
      emptiedBy: null,
      emptiedByLabel: null,
    };
  }

  /**
   * Records what the user did with a pick:
   * - started: status → In Progress (the UI confirms first)
   * - skipped: "Not now" for `settings.pick.skipDays` days
   * - queued:  added to Up Next
   */
  respond(historyId: string, outcome: 'started' | 'skipped' | 'queued'): PickHistoryView[] {
    const h = this.db.get<{ item_id: string }>('SELECT item_id FROM pick_history WHERE id = ?', [historyId]);
    if (!h) throw appError('NOT_FOUND', 'That pick is no longer in the history.');
    const { pick } = readSettings(this.db).settings;
    if (outcome === 'started') {
      this.library.setStatus({
        id: h.item_id,
        status: 'in_progress',
        startNewPass: false,
        clearDateCompleted: false,
        fillRemaining: false,
      });
    } else if (outcome === 'queued') {
      this.library.setUpNext(h.item_id, true);
    }
    this.db.run('UPDATE pick_history SET outcome = ?, skip_until = ? WHERE id = ?', [
      outcome,
      outcome === 'skipped' ? addDays(this.today(), pick.skipDays) : null,
      historyId,
    ]);
    return this.history();
  }

  history(limit = 8): PickHistoryView[] {
    return this.db
      .all<{
        id: string;
        item_id: string;
        title: string;
        type: MediaType;
        picked_at: string;
        outcome: PickHistoryView['outcome'];
        skip_until: string | null;
      }>(
        `SELECT h.id, h.item_id, i.title, i.type, h.picked_at, h.outcome, h.skip_until
         FROM pick_history h JOIN items i ON i.id = h.item_id
         WHERE i.deleted_at IS NULL ORDER BY h.picked_at DESC, h.rowid DESC LIMIT ?`,
        [limit],
      )
      .map((r) => ({
        id: r.id,
        itemId: r.item_id,
        title: r.title,
        type: r.type,
        pickedAt: r.picked_at,
        outcome: r.outcome,
        skipUntil: r.skip_until,
      }));
  }

  /** Clears "Not now" skips so everything is eligible again. */
  clearSkips(): number {
    return this.db.run('UPDATE pick_history SET skip_until = NULL WHERE skip_until IS NOT NULL').changes;
  }
}

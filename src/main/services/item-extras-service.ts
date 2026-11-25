/**
 * Per-item extras that are neither metadata nor progress: preferences
 * (spoiler shield, notes-contain-spoilers, hours source of truth, sub/dub),
 * runs (rewatch history), documented streaming links, and franchise
 * relations/suggestions with "Next in series".
 */
import type {
  FranchiseView,
  ItemPrefsView,
  RelationView,
  RunView,
  StreamingLinkView,
  SuggestionView,
} from '../../shared/types';
import { appError } from '../../shared/result';
import type { AudioPref, HoursSource, RelationInput, RelationType, SpoilerMode } from '../../shared/enums';
import { readSettings } from '../../db/repositories/config-repo';
import { loadStreamingLinks } from '../../db/repositories/extras-repo';
import { newId } from '../../db/repositories/items-repo';
import * as runsRepo from '../../db/repositories/runs-repo';
import { titleKey } from '../../domain/normalize';
import { matchesAudio } from '../../domain/anime';
import { nextInSeries, reorderPositions, type FranchiseEntry } from '../../domain/franchise';
import { shieldActive } from '../../domain/spoilers';
import type { ServiceContext } from './context';

export class ItemExtrasService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }

  private requireItem(id: string): { status: string } {
    const r = this.db.get<{ status: string }>(
      'SELECT status FROM items WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    if (!r) throw appError('NOT_FOUND', 'That item no longer exists.');
    return r;
  }

  /* ---------------------------------------------------------------- prefs */

  prefs(itemId: string): ItemPrefsView {
    const item = this.requireItem(itemId);
    const p = this.db.get<{
      spoiler_mode: SpoilerMode;
      notes_spoiler: number;
      hours_source: HoursSource;
      audio_pref: AudioPref | null;
    }>('SELECT spoiler_mode, notes_spoiler, hours_source, audio_pref FROM item_prefs WHERE item_id = ?', [
      itemId,
    ]);
    const { settings } = readSettings(this.db);
    const mode = p?.spoiler_mode ?? 'default';
    return {
      spoilerMode: mode,
      notesSpoiler: (p?.notes_spoiler ?? (settings.spoilers.shieldNotes ? 1 : 0)) === 1,
      hoursSource: p?.hours_source ?? 'manual',
      audioPref: p?.audio_pref ?? null,
      shieldActive: shieldActive({
        mode,
        shieldByDefault: settings.spoilers.shieldByDefault,
        status: item.status,
      }),
    };
  }

  setPrefs(
    itemId: string,
    patch: {
      spoilerMode?: SpoilerMode | undefined;
      notesSpoiler?: boolean | undefined;
      hoursSource?: HoursSource | undefined;
      audioPref?: AudioPref | null | undefined;
    },
  ): ItemPrefsView {
    this.requireItem(itemId);
    const cur = this.prefs(itemId);
    const next = {
      spoilerMode: patch.spoilerMode ?? cur.spoilerMode,
      notesSpoiler: patch.notesSpoiler ?? cur.notesSpoiler,
      hoursSource: patch.hoursSource ?? cur.hoursSource,
      audioPref: patch.audioPref === undefined ? cur.audioPref : patch.audioPref,
    };
    this.db.run(
      `INSERT INTO item_prefs (item_id, spoiler_mode, notes_spoiler, hours_source, audio_pref) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET spoiler_mode = excluded.spoiler_mode, notes_spoiler = excluded.notes_spoiler,
         hours_source = excluded.hours_source, audio_pref = excluded.audio_pref`,
      [itemId, next.spoilerMode, next.notesSpoiler ? 1 : 0, next.hoursSource, next.audioPref],
    );
    return this.prefs(itemId);
  }

  /* ---------------------------------------------------------------- runs */

  runs(itemId: string): RunView[] {
    this.requireItem(itemId);
    const db = this.db;
    db.transaction(() => runsRepo.syncRuns(db, itemId, this.ctx.clock.now().toISOString()));
    const pass = db.get<{ pass: number }>('SELECT pass FROM items WHERE id = ?', [itemId])?.pass ?? 1;
    return runsRepo.listRuns(db, itemId).map((r) => ({
      runNumber: r.run_number,
      status: r.status,
      dateStarted: r.date_started,
      dateCompleted: r.date_completed,
      rating: r.rating,
      notes: r.notes,
      episodesWatched: r.episodes_watched,
      current: r.run_number === pass,
    }));
  }

  /** Edits a finished run's dates/rating/notes (the current run is edited through the item itself). */
  updateRun(
    itemId: string,
    runNumber: number,
    patch: {
      dateStarted?: string | null | undefined;
      dateCompleted?: string | null | undefined;
      rating?: number | null | undefined;
      notes?: string | undefined;
    },
  ): RunView[] {
    this.requireItem(itemId);
    const db = this.db;
    const pass = db.get<{ pass: number }>('SELECT pass FROM items WHERE id = ?', [itemId])?.pass ?? 1;
    const run = db.get<{ id: string }>('SELECT id FROM item_runs WHERE item_id = ? AND run_number = ?', [
      itemId,
      runNumber,
    ]);
    if (!run) throw appError('NOT_FOUND', 'That run no longer exists.');
    if (
      runNumber === pass &&
      (patch.dateStarted !== undefined || patch.dateCompleted !== undefined || patch.rating !== undefined)
    )
      throw appError('VALIDATION', "Edit the current run's status, dates and rating on the item itself.");
    const now = this.ctx.clock.now().toISOString();
    db.transaction(() => {
      if (patch.dateStarted !== undefined)
        db.run('UPDATE item_runs SET date_started = ?, updated_at = ? WHERE id = ?', [
          patch.dateStarted,
          now,
          run.id,
        ]);
      if (patch.dateCompleted !== undefined)
        db.run('UPDATE item_runs SET date_completed = ?, updated_at = ? WHERE id = ?', [
          patch.dateCompleted,
          now,
          run.id,
        ]);
      if (patch.rating !== undefined)
        db.run('UPDATE item_runs SET rating = ?, updated_at = ? WHERE id = ?', [patch.rating, now, run.id]);
      if (patch.notes !== undefined)
        db.run('UPDATE item_runs SET notes = ?, updated_at = ? WHERE id = ?', [patch.notes, now, run.id]);
    });
    return this.runs(itemId);
  }

  /* ---------------------------------------------------------------- streaming links */

  streaming(itemId: string): StreamingLinkView[] {
    this.requireItem(itemId);
    const pref = this.prefs(itemId).audioPref ?? readSettings(this.db).settings.anime.audioPref;
    return loadStreamingLinks(this.db, itemId).map((l) => ({
      providerId: l.providerId,
      service: l.service,
      url: l.url,
      subs: l.subs,
      dubs: l.dubs,
      matchesPref: matchesAudio(l, pref),
    }));
  }

  /* ---------------------------------------------------------------- relations */

  relations(itemId: string): RelationView[] {
    this.requireItem(itemId);
    const rows = this.db.all<{
      id: string;
      from_item_id: string;
      to_item_id: string;
      type: RelationType;
      origin: 'user' | 'provider';
      title: string;
      itype: string;
      status: string;
    }>(
      `SELECT r.id, r.from_item_id, r.to_item_id, r.type, r.origin, i.title, i.type AS itype, i.status
         FROM item_relations r
         JOIN items i ON i.id = CASE WHEN r.from_item_id = ? THEN r.to_item_id ELSE r.from_item_id END
        WHERE (r.from_item_id = ? OR r.to_item_id = ?) AND i.deleted_at IS NULL
        ORDER BY i.release_date, i.title`,
      [itemId, itemId, itemId],
    );
    // Stored as "from → to": "to is a <type> of from" e.g. sequel: to is the sequel of from.
    return rows.map((r) => {
      const outgoing = r.from_item_id === itemId;
      let relation: RelationView['relation'] = r.type;
      if (!outgoing) {
        if (r.type === 'sequel') relation = 'prequel';
        else if (r.type === 'adaptation_of') relation = 'adapted_as';
      }
      return {
        id: r.id,
        otherItemId: outgoing ? r.to_item_id : r.from_item_id,
        otherTitle: r.title,
        otherType: r.itype,
        otherStatus: r.status,
        relation,
        origin: r.origin,
      };
    });
  }

  /**
   * Links two items. `relation` is how `otherId` relates to `itemId`
   * ("prequel" is stored as the inverse "sequel"; "adapted_as" as inverse "adaptation_of").
   */
  addRelation(
    itemId: string,
    otherId: string,
    relation: RelationInput | 'adapted_as',
    origin: 'user' | 'provider' = 'user',
  ): RelationView[] {
    if (itemId === otherId) throw appError('VALIDATION', "An item can't be related to itself.");
    this.requireItem(itemId);
    this.requireItem(otherId);
    let from = itemId;
    let to = otherId;
    let type: RelationType;
    if (relation === 'prequel') {
      from = otherId;
      to = itemId;
      type = 'sequel';
    } else if (relation === 'adapted_as') {
      from = otherId;
      to = itemId;
      type = 'adaptation_of';
    } else type = relation;
    this.db.run(
      `INSERT OR IGNORE INTO item_relations (id, from_item_id, to_item_id, type, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [newId(), from, to, type, origin, this.ctx.clock.now().toISOString()],
    );
    return this.relations(itemId);
  }

  removeRelation(itemId: string, relationId: string): RelationView[] {
    this.db.run('DELETE FROM item_relations WHERE id = ? AND (from_item_id = ? OR to_item_id = ?)', [
      relationId,
      itemId,
      itemId,
    ]);
    return this.relations(itemId);
  }

  suggestions(itemId: string): SuggestionView[] {
    this.requireItem(itemId);
    return this.db
      .all<{
        id: string;
        provider_id: string;
        target_title: string;
        target_year: number | null;
        target_type: string;
        relation: RelationInput | 'adapted_as';
        target_item_id: string | null;
      }>(
        `SELECT s.id, s.provider_id, s.target_title, s.target_year, s.target_type, s.relation, s.target_item_id
           FROM relation_suggestions s WHERE s.item_id = ? AND s.state = 'pending' ORDER BY s.relation, s.target_title`,
        [itemId],
      )
      .map((s) => ({
        id: s.id,
        providerId: s.provider_id,
        title: s.target_title,
        year: s.target_year,
        type: s.target_type,
        relation: s.relation,
        targetItemId: s.target_item_id,
      }));
  }

  /** Accepting links the target when it's in the library; otherwise it just records the decision. */
  resolveSuggestion(
    itemId: string,
    suggestionId: string,
    accept: boolean,
  ): { relations: RelationView[]; suggestions: SuggestionView[] } {
    const s = this.db.get<{ target_item_id: string | null; relation: RelationInput | 'adapted_as' }>(
      "SELECT target_item_id, relation FROM relation_suggestions WHERE id = ? AND item_id = ? AND state = 'pending'",
      [suggestionId, itemId],
    );
    if (!s) throw appError('NOT_FOUND', 'That suggestion is no longer available.');
    this.db.transaction(() => {
      if (accept && s.target_item_id) this.addRelation(itemId, s.target_item_id, s.relation, 'provider');
      this.db.run('UPDATE relation_suggestions SET state = ? WHERE id = ?', [
        accept ? 'accepted' : 'dismissed',
        suggestionId,
      ]);
    });
    return { relations: this.relations(itemId), suggestions: this.suggestions(itemId) };
  }

  /* ---------------------------------------------------------------- franchises */

  franchises(): FranchiseView[] {
    const fr = this.db.all<{ id: string; name: string; respect_order: number }>(
      'SELECT id, name, respect_order FROM franchises ORDER BY name',
    );
    return fr.map((f) => this.franchiseView(f));
  }

  franchise(id: string): FranchiseView {
    const f = this.db.get<{ id: string; name: string; respect_order: number }>(
      'SELECT id, name, respect_order FROM franchises WHERE id = ?',
      [id],
    );
    if (!f) throw appError('NOT_FOUND', 'That series no longer exists.');
    return this.franchiseView(f);
  }

  private franchiseView(f: { id: string; name: string; respect_order: number }): FranchiseView {
    const entries = this.db
      .all<{
        item_id: string;
        title: string;
        type: string;
        status: string;
        position: number;
        mainline: number;
      }>(
        `SELECT fi.item_id, i.title, i.type, i.status, fi.position, fi.mainline
           FROM franchise_items fi JOIN items i ON i.id = fi.item_id
          WHERE fi.franchise_id = ? AND i.deleted_at IS NULL ORDER BY fi.position`,
        [f.id],
      )
      .map((e) => ({
        itemId: e.item_id,
        title: e.title,
        type: e.type,
        status: e.status,
        position: e.position,
        mainline: e.mainline === 1,
      }));
    const fe: FranchiseEntry[] = entries.map((e) => ({
      itemId: e.itemId,
      position: e.position,
      mainline: e.mainline,
      status: e.status,
    }));
    return {
      id: f.id,
      name: f.name,
      respectOrder: f.respect_order === 1,
      entries,
      nextItemId: nextInSeries(fe, f.respect_order === 1),
    };
  }

  franchisesForItem(itemId: string): FranchiseView[] {
    return this.db
      .all<{ id: string; name: string; respect_order: number }>(
        `SELECT f.id, f.name, f.respect_order FROM franchises f JOIN franchise_items fi ON fi.franchise_id = f.id
          WHERE fi.item_id = ? ORDER BY f.name`,
        [itemId],
      )
      .map((f) => this.franchiseView(f));
  }

  createFranchise(name: string, itemIds: string[]): FranchiseView {
    const key = titleKey(name);
    if (!key) throw appError('VALIDATION', 'Give the series a name.');
    if (this.db.get('SELECT 1 FROM franchises WHERE name_key = ?', [key]))
      throw appError('CONFLICT', 'A series with that name already exists.');
    const id = newId();
    const now = this.ctx.clock.now().toISOString();
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO franchises (id, name, name_key, respect_order, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
        [id, name.trim(), key, now, now],
      );
      this.setEntries(
        id,
        itemIds.map((itemId) => ({ itemId, mainline: true })),
      );
    });
    return this.franchise(id);
  }

  updateFranchise(
    id: string,
    patch: { name?: string | undefined; respectOrder?: boolean | undefined },
  ): FranchiseView {
    this.franchise(id);
    const now = this.ctx.clock.now().toISOString();
    if (patch.name !== undefined) {
      const key = titleKey(patch.name);
      if (!key) throw appError('VALIDATION', 'Give the series a name.');
      if (this.db.get('SELECT 1 FROM franchises WHERE name_key = ? AND id <> ?', [key, id]))
        throw appError('CONFLICT', 'A series with that name already exists.');
      this.db.run('UPDATE franchises SET name = ?, name_key = ?, updated_at = ? WHERE id = ?', [
        patch.name.trim(),
        key,
        now,
        id,
      ]);
    }
    if (patch.respectOrder !== undefined)
      this.db.run('UPDATE franchises SET respect_order = ?, updated_at = ? WHERE id = ?', [
        patch.respectOrder ? 1 : 0,
        now,
        id,
      ]);
    return this.franchise(id);
  }

  /** Replaces the ordered entry list (transactional). Unknown/deleted items are skipped. */
  setEntries(id: string, entries: { itemId: string; mainline: boolean }[]): FranchiseView {
    const db = this.db;
    db.transaction(() => {
      if (!db.get('SELECT 1 FROM franchises WHERE id = ?', [id]))
        throw appError('NOT_FOUND', 'That series no longer exists.');
      const seen = new Set<string>();
      const valid = entries.filter((e) => {
        if (seen.has(e.itemId)) return false;
        seen.add(e.itemId);
        return Boolean(db.get('SELECT 1 FROM items WHERE id = ? AND deleted_at IS NULL', [e.itemId]));
      });
      const pos = reorderPositions(valid.map((e) => e.itemId));
      db.run('DELETE FROM franchise_items WHERE franchise_id = ?', [id]);
      for (const e of valid)
        db.run(
          'INSERT INTO franchise_items (franchise_id, item_id, position, mainline) VALUES (?, ?, ?, ?)',
          [id, e.itemId, pos.get(e.itemId) ?? 0, e.mainline ? 1 : 0],
        );
      db.run('UPDATE franchises SET updated_at = ? WHERE id = ?', [this.ctx.clock.now().toISOString(), id]);
    });
    return this.franchise(id);
  }

  deleteFranchise(id: string): void {
    this.db.run('DELETE FROM franchises WHERE id = ?', [id]);
  }

  /** "Next in series" across all franchises (for Up Next / recommendations). */
  nextInSeriesIds(): Set<string> {
    return new Set(
      this.franchises()
        .map((f) => f.nextItemId)
        .filter((x): x is string => x !== null),
    );
  }
}

/**
 * Library service: item create/update/delete, status changes, bulk actions,
 * duplicates, dashboard. Every multi-row write runs in one transaction so a
 * failure never leaves a half-created or half-updated item.
 */
import type { MediaType, Status } from '../../shared/enums';
import { appError } from '../../shared/result';
import type {
  BulkActionInput,
  DuplicateCheckInput,
  ItemCreateInput,
  ItemUpdateInput,
  LibraryQuery,
  MetadataField,
  MetadataFields,
  PersonalFields,
  SeasonInput,
  StatusChangeInput,
} from '../../shared/schemas';
import type {
  DashboardData,
  DuplicateMatch,
  ItemDetail,
  ItemSummary,
  LibraryPage,
  MutationOutcome,
  StatusSuggestion,
} from '../../shared/types';
import { localDate, weekStartUtc } from '../../domain/dates';
import { addDays, addMonths } from '../../domain/calendar';
import { externalIdError } from '../../domain/links';
import { canonicalValue, FIELDS_BY_TYPE, isEmptyValue, pruneMetaForType } from '../../domain/metadata';
import { isAutoApplicable, planStatusChange } from '../../domain/status-rules';
import { tvTotals } from '../../domain/progress';
import {
  addAudit,
  customFieldOptions,
  customFieldTypes,
  tagCounts,
} from '../../db/repositories/catalog-repo';
import { readSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import * as prog from '../../db/repositories/progress-repo';
import type { ServiceContext } from './context';

export interface CreateOrigin {
  kind: 'manual' | 'provider' | 'import';
  providerId?: string;
  providerRef?: string;
  providerUrl?: string | null;
  artworkId?: string | null;
}

export type CreateResult =
  { kind: 'created'; item: ItemDetail } | { kind: 'duplicates'; matches: DuplicateMatch[] };

export class LibraryService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }
  private nowIso(): string {
    return this.ctx.clock.now().toISOString();
  }
  today(): string {
    return localDate(this.ctx.clock.now());
  }

  /* ---------------------------------------------------------------- validation */

  validateMeta(type: MediaType, meta: MetadataFields): void {
    const fieldErrors: Record<string, string> = {};
    meta.externalIds.forEach((e, i) => {
      const msg = externalIdError(e);
      if (msg) fieldErrors[`meta.externalIds.${i}.value`] = msg;
    });
    if (type === 'book' && meta.isbn13 && !/^\d{13}$/.test(meta.isbn13.replace(/-/g, ''))) {
      fieldErrors['meta.isbn13'] = 'ISBN-13 must be 13 digits.';
    }
    if (type === 'book' && meta.isbn10 && !/^\d{9}[\dXx]$/.test(meta.isbn10.replace(/-/g, ''))) {
      fieldErrors['meta.isbn10'] = 'ISBN-10 must be 9 digits followed by a digit or X.';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw appError('VALIDATION', 'Some fields need attention.', { fieldErrors });
    }
  }

  validatePersonal(type: MediaType, p: PersonalFields): PersonalFields {
    const types = customFieldTypes(this.db);
    const fieldErrors: Record<string, string> = {};
    p.customFields.forEach((cf, i) => {
      const t = types.get(cf.defId);
      const path = `personal.customFields.${i}.value`;
      if (!t) {
        fieldErrors[path] = 'This custom field no longer exists.';
        return;
      }
      if (cf.value === null || cf.value === '') return;
      if (t === 'number' && typeof cf.value !== 'number') fieldErrors[path] = 'Enter a number.';
      if (t === 'boolean' && typeof cf.value !== 'boolean') fieldErrors[path] = 'Choose yes or no.';
      if ((t === 'text' || t === 'date' || t === 'select') && typeof cf.value !== 'string')
        fieldErrors[path] = 'Enter text.';
      if (t === 'date' && typeof cf.value === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(cf.value))
        fieldErrors[path] = 'Use YYYY-MM-DD.';
      if (
        t === 'select' &&
        typeof cf.value === 'string' &&
        !customFieldOptions(this.db, cf.defId).includes(cf.value)
      ) {
        fieldErrors[path] = 'Choose one of the listed options.';
      }
    });
    if (Object.keys(fieldErrors).length > 0)
      throw appError('VALIDATION', 'Some custom fields need attention.', { fieldErrors });
    return {
      ...p,
      gameScheme: type === 'game' ? (p.gameScheme ?? 'percent') : null,
      platforms: type === 'game' ? p.platforms : [],
      bookFormat: type === 'book' ? (p.bookFormat ?? 'print') : null,
    };
  }

  /* ---------------------------------------------------------------- create */

  checkDuplicates(input: DuplicateCheckInput): DuplicateMatch[] {
    return items.findDuplicates(this.db, input);
  }

  create(input: ItemCreateInput, origin: CreateOrigin = { kind: 'manual' }): CreateResult {
    const meta = pruneMetaForType(input.type, input.meta);
    this.validateMeta(input.type, meta);
    const personal = this.validatePersonal(input.type, input.personal);
    if (!input.allowDuplicate) {
      const matches = items.findDuplicates(this.db, {
        type: input.type,
        title: meta.title,
        releaseDate: meta.releaseDate,
        externalIds: meta.externalIds,
        excludeId: null,
      });
      if (matches.length > 0) return { kind: 'duplicates', matches };
    }
    const id = items.newId();
    const now = this.nowIso();
    this.db.transaction(() => {
      this.insertItem(id, input.type, meta, personal, input.seasons, input.milestones, origin, now);
    });
    const item = items.loadDetail(this.db, id);
    if (!item) throw appError('INTERNAL', 'The item was saved but could not be loaded.');
    this.ctx.log.info('item.created', { id, type: input.type, origin: origin.kind });
    return { kind: 'created', item };
  }

  /** Inserts an item and all related rows. Must run inside a transaction. */
  insertItem(
    id: string,
    type: MediaType,
    meta: MetadataFields,
    personal: PersonalFields,
    seasons: readonly SeasonInput[],
    milestones: readonly string[],
    origin: CreateOrigin,
    now: string,
  ): void {
    const db = this.db;
    items.insertItemRow(db, id, type, meta, personal, now);
    items.writeMeta(db, id, type, meta);
    items.writePersonal(db, id, type, personal, customFieldTypes(db));
    const fromProvider = origin.kind === 'provider' && origin.providerId;
    for (const f of FIELDS_BY_TYPE[type]) {
      if (isEmptyValue(meta[f])) continue;
      items.setProvenance(
        db,
        id,
        f,
        fromProvider ? 'provider' : 'manual-entry',
        fromProvider ? (origin.providerId ?? null) : null,
        fromProvider ? canonicalValue(f, meta[f]) : null,
        now,
      );
    }
    if (fromProvider && origin.providerId && origin.providerRef) {
      items.setSource(db, id, origin.providerId, origin.providerRef, origin.providerUrl ?? null, now);
    }
    if (origin.artworkId) db.run('UPDATE items SET artwork_id = ? WHERE id = ?', [origin.artworkId, id]);
    if (type === 'tv' && seasons.length > 0)
      prog.insertSeasons(db, id, seasons, fromProvider ? 'provider' : 'user');
    if (type === 'game' && milestones.length > 0)
      prog.setMilestones(
        db,
        id,
        milestones.map((title) => ({ id: null, title })),
      );
    if (origin.kind !== 'import')
      addAudit(db, id, fromProvider ? 'import' : 'create', origin.providerId ?? null, [], now);
    items.reindexItem(db, id);
    items.recomputeProgress(db, id);
  }

  /* ---------------------------------------------------------------- read */

  get(id: string): ItemDetail {
    const item = items.loadDetail(this.db, id);
    if (!item)
      throw appError('NOT_FOUND', 'That item no longer exists.', {
        recovery: 'It may have been deleted. Return to the library.',
      });
    return item;
  }

  query(q: LibraryQuery): LibraryPage {
    return items.queryLibrary(this.db, q, this.healthContext());
  }

  /** Cut-off dates for the Pile Health "stale" filter, from settings. */
  healthContext(): items.HealthFilterContext {
    const t = readSettings(this.db).settings.pileHealth;
    const today = this.today();
    return {
      today,
      plannedCutoff: addMonths(today, -t.plannedStaleMonths),
      idleCutoff: addDays(today, -t.inProgressStaleDays),
    };
  }

  /* ---------------------------------------------------------------- update */

  update(input: ItemUpdateInput): ItemDetail {
    const db = this.db;
    const row = items.getItemRow(db, input.id);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const now = this.nowIso();
    const meta = input.meta ? pruneMetaForType(row.type, input.meta) : null;
    if (meta) this.validateMeta(row.type, meta);
    const personal = input.personal ? this.validatePersonal(row.type, input.personal) : null;
    db.transaction(() => {
      if (meta) {
        const before = items.loadMeta(db, row);
        items.writeMeta(db, row.id, row.type, meta);
        const prov = items.loadProvenance(db, row.id);
        for (const f of FIELDS_BY_TYPE[row.type]) {
          if (canonicalValue(f, before[f]) === canonicalValue(f, meta[f])) continue;
          const p = prov[f];
          // Keep the provider's last value so a later refresh can show what the provider says.
          items.setProvenance(db, row.id, f, 'user', p?.providerId ?? null, p?.providerValue ?? null, now);
        }
      }
      if (personal) items.writePersonal(db, row.id, row.type, personal, customFieldTypes(db));
      items.touch(db, row.id, now);
      items.reindexItem(db, row.id);
      items.recomputeProgress(db, row.id);
    });
    this.ctx.log.info('item.updated', { id: row.id, meta: Boolean(meta), personal: Boolean(personal) });
    return this.get(row.id);
  }

  setRating(id: string, rating: number | null): ItemDetail {
    const r = this.db.run('UPDATE items SET rating = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [
      rating,
      this.nowIso(),
      id,
    ]);
    if (r.changes === 0) throw appError('NOT_FOUND', 'That item no longer exists.');
    return this.get(id);
  }

  /* ---------------------------------------------------------------- status */

  setStatus(input: StatusChangeInput): MutationOutcome {
    const db = this.db;
    const row = items.getItemRow(db, input.id);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const today = this.today();
    const now = this.nowIso();
    const plan = planStatusChange(
      {
        type: row.type,
        status: row.status,
        dateStarted: row.date_started,
        dateCompleted: row.date_completed,
        pass: row.pass,
      },
      input,
      today,
    );
    if (!plan.changed) return { item: this.get(row.id), suggestions: [], applied: [] };
    db.transaction(() => {
      db.run(
        'UPDATE items SET status = ?, date_started = ?, date_completed = ?, pass = ?, updated_at = ? WHERE id = ?',
        [plan.status, plan.dateStarted, plan.dateCompleted, plan.pass, now, row.id],
      );
      if (plan.pass !== row.pass && row.type === 'tv') {
        // A new rewatch pass starts with fresh checkmarks; history keeps the earlier pass.
        prog.resetEpisodes(db, row.id);
      }
      if (input.fillRemaining && plan.offerFillRemaining)
        this.fillRemaining(row.id, row.type, plan.pass, now);
      this.leaveQueueIfDone(row.id, plan.status);
      items.recomputeProgress(db, row.id);
    });
    this.ctx.log.info('item.status', { id: row.id, from: row.status, to: plan.status, pass: plan.pass });
    return { item: this.get(row.id), suggestions: [], applied: [] };
  }

  /** "Fill remaining progress" when the user marks something Completed. */
  private fillRemaining(id: string, type: MediaType, pass: number, now: string): void {
    const db = this.db;
    if (type === 'movie') {
      const has = db.get<{ n: number }>(
        'SELECT count(*) AS n FROM viewing_events WHERE item_id = ? AND pass = ?',
        [id, pass],
      );
      if ((has?.n ?? 0) === 0) prog.addViewing(db, id, now, null, pass, now);
      return;
    }
    const base = {
      itemId: id,
      text: null,
      totalAtTime: null,
      milestoneId: null,
      milestoneTitle: null,
      episodeId: null,
      episodeLabel: null,
      watched: null,
      scheme: null,
      pass,
      occurredAt: now,
      recordedAt: now,
      note: 'Filled when marked Completed',
    } as const;
    if (type === 'tv') {
      const unwatched = db.all<{ id: string }>(
        `SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.item_id = ? AND s.season_number > 0 AND e.watched = 0`,
        [id],
      );
      if (unwatched.length === 0) return;
      prog.setEpisodesWatched(
        db,
        unwatched.map((e) => e.id),
        true,
        now,
      );
      prog.insertProgressEvent(db, {
        ...base,
        kind: 'season',
        value: unwatched.length,
        watched: true,
        text: `Marked ${unwatched.length} remaining episode(s) watched`,
      });
      return;
    }
    if (type === 'book') {
      const b = db.get<{ page_count: number | null }>(
        'SELECT page_count FROM book_details WHERE item_id = ?',
        [id],
      );
      if (b?.page_count)
        prog.insertProgressEvent(db, {
          ...base,
          kind: 'pages',
          value: b.page_count,
          totalAtTime: b.page_count,
        });
      else prog.insertProgressEvent(db, { ...base, kind: 'percent', value: 100 });
      return;
    }
    const g = db.get<{ progress_scheme: string }>(
      'SELECT progress_scheme FROM game_details WHERE item_id = ?',
      [id],
    );
    if (g?.progress_scheme === 'percent')
      prog.insertProgressEvent(db, { ...base, kind: 'percent', value: 100, scheme: 'percent' });
    if (g?.progress_scheme === 'milestones') {
      const last = db.get<{ id: string; title: string }>(
        'SELECT id, title FROM game_milestones WHERE item_id = ? ORDER BY position DESC LIMIT 1',
        [id],
      );
      if (last)
        prog.insertProgressEvent(db, {
          ...base,
          kind: 'milestone',
          value: null,
          milestoneId: last.id,
          milestoneTitle: last.title,
          scheme: 'milestones',
        });
    }
  }

  /**
   * Applies suggestions that the auto-apply setting allows; returns the
   * remaining ones for the UI to prompt. Runs inside the caller's transaction.
   */
  resolveSuggestions(
    id: string,
    suggestions: StatusSuggestion[],
  ): { pending: StatusSuggestion[]; applied: StatusSuggestion[] } {
    const { settings } = readSettings(this.db);
    if (!settings.autoApplySuggestions) return { pending: suggestions, applied: [] };
    const applied: StatusSuggestion[] = [];
    const pending: StatusSuggestion[] = [];
    for (const s of suggestions) {
      if (!isAutoApplicable(s)) {
        pending.push(s);
        continue;
      }
      this.db.run('UPDATE items SET status = ?, date_started = COALESCE(date_started, ?) WHERE id = ?', [
        s.status,
        s.setDateStarted,
        id,
      ]);
      applied.push(s);
    }
    return { pending, applied };
  }

  /** Accepts a suggestion the user clicked. */
  acceptSuggestion(id: string, s: StatusSuggestion): MutationOutcome {
    const db = this.db;
    const row = items.getItemRow(db, id);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const now = this.nowIso();
    db.transaction(() => {
      db.run('UPDATE items SET status = ?, updated_at = ? WHERE id = ?', [s.status, now, id]);
      if (s.setDateStarted)
        db.run('UPDATE items SET date_started = COALESCE(date_started, ?) WHERE id = ?', [
          s.setDateStarted,
          id,
        ]);
      if (s.status === 'completed')
        db.run('UPDATE items SET date_completed = COALESCE(date_completed, ?) WHERE id = ?', [
          this.today(),
          id,
        ]);
      this.leaveQueueIfDone(id, s.status);
    });
    return { item: this.get(id), suggestions: [], applied: [s] };
  }

  /* ---------------------------------------------------------------- delete */

  /**
   * Soft-deletes items so the UI can offer Undo. Soft-deleted items are hidden
   * everywhere, excluded from exports/backups, and purged at next startup.
   */
  softDelete(ids: readonly string[]): number {
    const db = this.db;
    const now = this.nowIso();
    let n = 0;
    db.transaction(() => {
      for (const id of ids) {
        n += db.run('UPDATE items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [now, id]).changes;
        items.reindexItem(db, id);
      }
    });
    this.ctx.log.info('item.softDeleted', { count: n });
    return n;
  }

  undoDelete(ids: readonly string[]): number {
    const db = this.db;
    let n = 0;
    db.transaction(() => {
      for (const id of ids) {
        n += db.run('UPDATE items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL', [
          id,
        ]).changes;
        items.reindexItem(db, id);
      }
    });
    return n;
  }

  /** Permanently removes soft-deleted items; returns artwork ids that may now be orphaned. */
  purgeDeleted(): { purged: number } {
    const db = this.db;
    let purged = 0;
    db.transaction(() => {
      const rows = db.all<{ rid: number }>('SELECT rid FROM items WHERE deleted_at IS NOT NULL');
      for (const r of rows) db.run('DELETE FROM items_fts WHERE rowid = ?', [r.rid]);
      purged = db.run('DELETE FROM items WHERE deleted_at IS NOT NULL').changes;
      items.pruneOrphans(db);
    });
    if (purged > 0) this.ctx.log.info('item.purged', { count: purged });
    return { purged };
  }

  /* ---------------------------------------------------------------- bulk */

  bulk(input: BulkActionInput): { affected: number } {
    const db = this.db;
    if (input.action === 'delete') return { affected: this.softDelete(input.ids) };
    const now = this.nowIso();
    const today = this.today();
    let affected = 0;
    db.transaction(() => {
      for (const id of input.ids) {
        const row = items.getItemRow(db, id);
        if (!row) continue;
        if (input.action === 'setStatus') {
          // Bulk status changes apply date auto-fill but never start new passes or fill progress.
          const plan = planStatusChange(
            {
              type: row.type,
              status: row.status,
              dateStarted: row.date_started,
              dateCompleted: row.date_completed,
              pass: row.pass,
            },
            { status: input.status, startNewPass: false, clearDateCompleted: false },
            today,
          );
          if (!plan.changed) continue;
          db.run(
            'UPDATE items SET status = ?, date_started = ?, date_completed = ?, updated_at = ? WHERE id = ?',
            [plan.status, plan.dateStarted, plan.dateCompleted, now, id],
          );
          this.leaveQueueIfDone(id, plan.status);
        } else if (input.action === 'addUpNext') {
          if (row.up_next_position !== null || row.status === 'completed' || row.status === 'dropped')
            continue;
          if (!this.enqueue(id, now)) continue; // queue full
        } else if (input.action === 'addToList') {
          if (!db.get('SELECT 1 FROM lists WHERE id = ?', [input.listId]))
            throw appError('NOT_FOUND', 'That list no longer exists.');
          const pos =
            (db.get<{ p: number | null }>('SELECT max(position) AS p FROM list_items WHERE list_id = ?', [
              input.listId,
            ])?.p ?? -1) + 1;
          if (
            db.run(
              'INSERT INTO list_items (list_id, item_id, position, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
              [input.listId, id, pos, now],
            ).changes === 0
          )
            continue;
        } else if (input.action === 'snooze') {
          db.run(
            `INSERT INTO item_snoozes (item_id, until, reason, created_at) VALUES (?, ?, 'pile-health', ?)
             ON CONFLICT(item_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_at = excluded.created_at`,
            [id, input.until, now],
          );
        } else if (input.action === 'addTag') {
          items.addTag(db, id, input.tag);
          items.touch(db, id, now);
          items.reindexItem(db, id);
        } else {
          items.removeTag(db, id, input.tag);
          items.touch(db, id, now);
          items.reindexItem(db, id);
        }
        affected++;
      }
      items.pruneOrphans(db);
    });
    this.ctx.log.info('item.bulk', { action: input.action, affected });
    return { affected };
  }

  /* ---------------------------------------------------------------- dashboard */

  dashboard(): DashboardData {
    const db = this.db;
    const countsByType: Record<MediaType, number> = { movie: 0, tv: 0, game: 0, book: 0 };
    for (const r of db.all<{ type: MediaType; n: number }>(
      'SELECT type, count(*) AS n FROM items WHERE deleted_at IS NULL GROUP BY type',
    )) {
      countsByType[r.type] = r.n;
    }
    const countsByStatus: Record<Status, number> = {
      planned: 0,
      in_progress: 0,
      completed: 0,
      on_hold: 0,
      dropped: 0,
    };
    for (const r of db.all<{ status: Status; n: number }>(
      'SELECT status, count(*) AS n FROM items WHERE deleted_at IS NULL GROUP BY status',
    )) {
      countsByStatus[r.status] = r.n;
    }
    const total = Object.values(countsByType).reduce((a, b) => a + b, 0);
    const continueRows = items.summariesWhere(
      db,
      "i.status = 'in_progress'",
      [],
      'ORDER BY i.updated_at DESC LIMIT 12',
    );
    const continueItems = continueRows.map((s) => {
      const p = items.computeProgress(db, s.id);
      return { ...s, nextAction: p.nextAction };
    });
    const recentlyUpdated = items.summariesWhere(db, '1=1', [], 'ORDER BY i.updated_at DESC, i.id LIMIT 8');
    const recentlyAdded = items.summariesWhere(
      db,
      '1=1',
      [],
      'ORDER BY i.date_added DESC, i.created_at DESC LIMIT 8',
    );
    const recentlyCompleted = items.summariesWhere(
      db,
      "i.status = 'completed'",
      [],
      'ORDER BY i.date_completed IS NULL, i.date_completed DESC, i.updated_at DESC LIMIT 8',
    );

    // Real activity only: progress entries + viewings + completions per week, last 12 weeks.
    const now = this.ctx.clock.now();
    const weeks: { weekStart: string; entries: number; completed: number }[] = [];
    const startOfThisWeek = new Date(`${weekStartUtc(now)}T00:00:00.000Z`);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(startOfThisWeek);
      d.setUTCDate(d.getUTCDate() - i * 7);
      weeks.push({ weekStart: d.toISOString().slice(0, 10), entries: 0, completed: 0 });
    }
    const since = weeks[0]?.weekStart ?? '0000';
    const bucket = (iso: string) => weeks.find((w) => w.weekStart === weekStartUtc(new Date(iso)));
    for (const r of db.all<{ at: string }>(
      `SELECT COALESCE(p.occurred_at, p.recorded_at) AS at FROM progress_events p JOIN items i ON i.id = p.item_id
       WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL AND COALESCE(p.occurred_at, p.recorded_at) >= ?`,
      [since],
    )) {
      const b = bucket(r.at);
      if (b) b.entries++;
    }
    for (const r of db.all<{ at: string }>(
      `SELECT COALESCE(v.watched_at, v.created_at) AS at FROM viewing_events v JOIN items i ON i.id = v.item_id
       WHERE i.deleted_at IS NULL AND COALESCE(v.watched_at, v.created_at) >= ?`,
      [since],
    )) {
      const b = bucket(r.at);
      if (b) b.entries++;
    }
    for (const r of db.all<{ d: string }>(
      "SELECT date_completed AS d FROM items WHERE deleted_at IS NULL AND status = 'completed' AND date_completed >= ?",
      [since],
    )) {
      const b = bucket(`${r.d}T12:00:00.000Z`);
      if (b) b.completed++;
    }
    return {
      countsByType,
      countsByStatus,
      total,
      continueItems,
      recentlyUpdated,
      recentlyAdded,
      recentlyCompleted,
      activityByWeek: weeks,
      tagCounts: tagCounts(db, 30),
      upNext: this.upNext(),
      yearStats: this.yearStats(),
    };
  }

  /* ---------------------------------------------------------------- Up Next queue */

  /**
   * "Up Next" is a short, user-ordered queue of what to start soon, stored in
   * the `up_next` table with a UNIQUE position. Positions are compacted to
   * 0..n-1 after every change. Completing or dropping an item takes it out of
   * the queue automatically. The queue holds at most `settings.upNextMax`.
   */
  upNext(): (ItemSummary & { nextAction: string | null })[] {
    const db = this.db;
    return items
      .summariesWhere(
        db,
        'EXISTS (SELECT 1 FROM up_next u WHERE u.item_id = i.id)',
        [],
        'ORDER BY (SELECT u.position FROM up_next u WHERE u.item_id = i.id) ASC, i.id LIMIT 50',
      )
      .map((s) => ({ ...s, nextAction: items.computeProgress(db, s.id).nextAction }));
  }

  upNextMax(): number {
    return readSettings(this.db).settings.upNextMax;
  }

  /** Live (non-deleted) queue ids in order. */
  private queueIds(): string[] {
    return this.db
      .all<{ item_id: string }>(
        `SELECT u.item_id FROM up_next u JOIN items i ON i.id = u.item_id
         WHERE i.deleted_at IS NULL ORDER BY u.position, u.item_id`,
      )
      .map((r) => r.item_id);
  }

  private nextQueuePosition(): number {
    return (this.db.get<{ p: number | null }>('SELECT max(position) AS p FROM up_next')?.p ?? -1) + 1;
  }

  /**
   * Renumbers the queue 0..n-1 in its current order. Ascending reassignment
   * never collides with the UNIQUE constraint (each row only moves down).
   */
  compactQueue(): void {
    const rows = this.db.all<{ item_id: string }>('SELECT item_id FROM up_next ORDER BY position, item_id');
    rows.forEach((r, i) => this.db.run('UPDATE up_next SET position = ? WHERE item_id = ?', [i, r.item_id]));
  }

  /** Appends an item if there is room; returns false when the queue is full or it is already queued. */
  enqueue(id: string, now: string): boolean {
    const db = this.db;
    if (db.get('SELECT 1 FROM up_next WHERE item_id = ?', [id])) return false;
    if (this.queueIds().length >= this.upNextMax()) return false;
    db.run('INSERT INTO up_next (item_id, position, added_at) VALUES (?, ?, ?)', [
      id,
      this.nextQueuePosition(),
      now,
    ]);
    return true;
  }

  leaveQueueIfDone(id: string, status: Status): void {
    if (status !== 'completed' && status !== 'dropped') return;
    const r = this.db.run('DELETE FROM up_next WHERE item_id = ?', [id]);
    if (r.changes > 0) this.compactQueue();
  }

  setUpNext(id: string, queued: boolean): ItemDetail {
    const db = this.db;
    const row = items.getItemRow(db, id);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    db.transaction(() => {
      if (queued && row.up_next_position === null) {
        const max = this.upNextMax();
        if (this.queueIds().length >= max)
          throw appError('CONFLICT', `Up Next is full (${max} items).`, {
            recovery: 'Remove something from Up Next first, or raise the limit in Settings → Library.',
          });
        this.enqueue(id, this.nowIso());
      } else if (!queued && row.up_next_position !== null) {
        db.run('DELETE FROM up_next WHERE item_id = ?', [id]);
      }
      this.compactQueue();
    });
    return this.get(id);
  }

  moveUpNext(id: string, direction: 'up' | 'down'): (ItemSummary & { nextAction: string | null })[] {
    const db = this.db;
    db.transaction(() => {
      this.compactQueue();
      const ids = db
        .all<{ item_id: string }>('SELECT item_id FROM up_next ORDER BY position')
        .map((r) => r.item_id);
      const i = ids.indexOf(id);
      if (i === -1) throw appError('NOT_FOUND', 'That item is not in Up Next.');
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      // Swap through a free temporary slot so the UNIQUE(position) constraint always holds.
      const tmp = ids.length;
      db.run('UPDATE up_next SET position = ? WHERE item_id = ?', [tmp, id]);
      db.run('UPDATE up_next SET position = ? WHERE item_id = ?', [i, ids[j] ?? '']);
      db.run('UPDATE up_next SET position = ? WHERE item_id = ?', [j, id]);
    });
    return this.upNext();
  }

  /* ---------------------------------------------------------------- pick for me (legacy, uniform) */

  /** A random Planned item not already in Up Next (optionally limited to some types). Kept for the simple widget API. */
  pickRandom(types: readonly MediaType[], excludeId: string | null): ItemSummary | null {
    const where = [
      `i.status = 'planned'`,
      'NOT EXISTS (SELECT 1 FROM up_next u WHERE u.item_id = i.id)',
      'i.id <> ?',
    ];
    const params: (string | number)[] = [excludeId ?? ''];
    if (types.length > 0) {
      where.push(`i.type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    return items.summariesWhere(this.db, where.join(' AND '), params, 'ORDER BY random() LIMIT 1')[0] ?? null;
  }

  /* ---------------------------------------------------------------- year in review */

  yearStats(): DashboardData['yearStats'] {
    const db = this.db;
    const year = this.ctx.clock.now().getFullYear();
    const from = `${year}-01-01`;
    const completedByType: Record<MediaType, number> = { movie: 0, tv: 0, game: 0, book: 0 };
    for (const r of db.all<{ type: MediaType; n: number }>(
      `SELECT type, count(*) AS n FROM items
       WHERE deleted_at IS NULL AND status = 'completed' AND date_completed >= ? GROUP BY type`,
      [from],
    ))
      completedByType[r.type] = r.n;
    const n = (sql: string) => db.get<{ n: number }>(sql, [from])?.n ?? 0;
    return {
      year,
      completedByType,
      completedTotal: Object.values(completedByType).reduce((a, b) => a + b, 0),
      added: n('SELECT count(*) AS n FROM items WHERE deleted_at IS NULL AND date_added >= ?'),
      episodesWatched: n(
        `SELECT count(*) AS n FROM episodes e JOIN items i ON i.id = e.item_id
         WHERE i.deleted_at IS NULL AND e.watched = 1 AND e.watched_at >= ?`,
      ),
      viewings: n(
        `SELECT count(*) AS n FROM viewing_events v JOIN items i ON i.id = v.item_id
         WHERE i.deleted_at IS NULL AND COALESCE(v.watched_at, v.created_at) >= ?`,
      ),
      progressEntries: n(
        `SELECT count(*) AS n FROM progress_events p JOIN items i ON i.id = p.item_id
         WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL AND COALESCE(p.occurred_at, p.recorded_at) >= ?`,
      ),
    };
  }

  /** Whether an item's TV totals are complete; used by tests and UI hints. */
  tvComplete(id: string): boolean {
    const t = tvTotals(items.loadSeasons(this.db, id));
    return t.totalKnown && t.watched >= t.total;
  }

  /** Metadata fields where the current value was set by the user (used by refresh UI). */
  userEditedFields(id: string): MetadataField[] {
    const prov = items.loadProvenance(this.db, id);
    return (Object.keys(prov) as MetadataField[]).filter((f) => prov[f]?.origin === 'user');
  }
}

/**
 * §16.1 Recently deleted (trash) + Recent changes (change log).
 *
 * Trash: deleting sets items.deleted_at; every related row stays in place
 * (history, runs, tags, lists, artwork, checklists, loans…), so restoring is
 * complete by construction. Items are purged after `trash.retentionDays`.
 * Soft-deleted items never trigger reminders and are excluded from queries.
 *
 * Change log: snapshot-diff of a fixed set of non-sensitive fields around
 * each mutating command. Notes are logged as "notes edited" only — never text.
 * Per-change Undo applies only while the field still has the logged new value.
 */
import { randomUUID } from 'node:crypto';
import { appError } from '../../shared/result';
import type { Status } from '../../shared/enums';
import { readSettings } from '../../db/repositories/config-repo';
import type { ServiceContext } from './context';
import type { LibraryService } from './library-service';
import * as items from '../../db/repositories/items-repo';

export const LOGGED_FIELDS = [
  'title',
  'status',
  'rating',
  'dateStarted',
  'dateCompleted',
  'tags',
  'notes',
  'nextStep',
  'deleted',
] as const;
export type LoggedField = (typeof LOGGED_FIELDS)[number];
export type ChangeSource = 'user' | 'bulk' | 'rule' | 'triage' | 'restore' | 'trash';

type Snap = Record<LoggedField, string | null>;

const FIELD_LABELS: Record<LoggedField, string> = {
  title: 'Title',
  status: 'Status',
  rating: 'Rating',
  dateStarted: 'Date started',
  dateCompleted: 'Date completed',
  tags: 'Tags',
  notes: 'Notes',
  nextStep: 'Next step',
  deleted: 'Deleted',
};

export interface TrashEntryView {
  id: string;
  title: string;
  type: string;
  deletedAt: string;
  purgeOn: string;
}

export interface ChangeView {
  id: number;
  batchId: string;
  itemId: string;
  itemTitle: string;
  at: string;
  source: ChangeSource;
  field: LoggedField;
  fieldLabel: string;
  oldValue: string | null;
  newValue: string | null;
  undone: boolean;
  undoable: boolean;
  whyNotUndoable: string | null;
}

export class HistoryService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
  ) {}

  private get db() {
    return this.ctx.db();
  }
  private now() {
    return this.ctx.clock.now();
  }

  /* ---------------------------------------------------------------- trash */

  retentionDays(): number {
    return readSettings(this.db).settings.trash.retentionDays;
  }

  trash(): TrashEntryView[] {
    const days = this.retentionDays();
    return this.db
      .all<{ id: string; title: string; type: string; deleted_at: string }>(
        'SELECT id, title, type, deleted_at FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 2000',
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        deletedAt: r.deleted_at,
        purgeOn: new Date(Date.parse(r.deleted_at) + days * 86_400_000).toISOString().slice(0, 10),
      }));
  }

  restore(ids: readonly string[]): number {
    const before = this.capture(ids, true);
    const n = this.library.undoDelete(ids);
    this.commit(before, 'restore');
    return n;
  }

  /** Permanently deletes the given trashed items (explicit confirmation happens in the UI). */
  purge(ids: readonly string[]): number {
    const db = this.db;
    return db.transaction(() => {
      let n = 0;
      for (const id of ids) {
        const r = db.get<{ rid: number }>('SELECT rid FROM items WHERE id = ? AND deleted_at IS NOT NULL', [
          id,
        ]);
        if (!r) continue;
        db.run('DELETE FROM items_fts WHERE rowid = ?', [r.rid]);
        n += db.run('DELETE FROM items WHERE id = ?', [id]).changes;
      }
      if (n > 0) items.pruneOrphans(db);
      return n;
    });
  }

  emptyTrash(): number {
    return this.purge(
      this.db.all<{ id: string }>('SELECT id FROM items WHERE deleted_at IS NOT NULL').map((r) => r.id),
    );
  }

  /** Startup housekeeping: purge items deleted more than `retentionDays` ago. */
  purgeExpired(): number {
    const cutoff = new Date(this.now().getTime() - this.retentionDays() * 86_400_000).toISOString();
    const ids = this.db
      .all<{ id: string }>('SELECT id FROM items WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff])
      .map((r) => r.id);
    return ids.length ? this.purge(ids) : 0;
  }

  /* ---------------------------------------------------------------- change log */

  private snap(id: string, includeDeleted = false): Snap | null {
    const r = this.db.get<{
      title: string;
      status: string;
      rating: number | null;
      date_started: string | null;
      date_completed: string | null;
      notes: string;
      deleted_at: string | null;
      tags: string | null;
      next_step: string | null;
    }>(
      `SELECT i.title, i.status, i.rating, i.date_started, i.date_completed, i.notes, i.deleted_at,
              (SELECT group_concat(name, ', ') FROM (SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id ORDER BY t.name_key)) AS tags,
              (SELECT text FROM item_next_steps WHERE item_id = i.id) AS next_step
         FROM items i WHERE i.id = ? ${includeDeleted ? '' : 'AND i.deleted_at IS NULL'}`,
      [id],
    );
    if (!r) return null;
    return {
      title: r.title,
      status: r.status,
      rating: r.rating === null ? null : String(r.rating),
      dateStarted: r.date_started,
      dateCompleted: r.date_completed,
      tags: r.tags,
      // Never the text: only a fingerprint so a change is detectable.
      notes: r.notes === '' ? null : `len:${r.notes.length}:${hash(r.notes)}`,
      nextStep: r.next_step,
      deleted: r.deleted_at ? 'yes' : null,
    };
  }

  capture(ids: readonly string[], includeDeleted = true): Map<string, Snap | null> {
    const m = new Map<string, Snap | null>();
    for (const id of ids.slice(0, 20_000)) m.set(id, this.snap(id, includeDeleted));
    return m;
  }

  /** Writes one batch with every changed field. Returns the batch id (or null if nothing changed). */
  commit(before: Map<string, Snap | null>, source: ChangeSource): string | null {
    const s = readSettings(this.db).settings.changeLog;
    if (!s.enabled) return null;
    const batch = randomUUID();
    const at = this.now().toISOString();
    let wrote = 0;
    this.db.transaction(() => {
      for (const [id, b] of before) {
        const a = this.snap(id, true);
        if (!a || !b) continue;
        for (const f of LOGGED_FIELDS) {
          if (a[f] === b[f]) continue;
          const isNotes = f === 'notes';
          this.db.run(
            'INSERT INTO change_log (batch_id, item_id, at, source, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [batch, id, at, source, f, isNotes ? null : clip(b[f]), isNotes ? null : clip(a[f])],
          );
          wrote++;
        }
      }
    });
    if (wrote > 0) this.pruneLog();
    return wrote > 0 ? batch : null;
  }

  /** Runs `fn` and logs what changed for `ids`. */
  logged<T>(ids: readonly string[], source: ChangeSource, fn: () => T): T {
    const before = this.capture(ids);
    const r = fn();
    this.commit(before, source);
    return r;
  }

  async loggedAsync<T>(ids: readonly string[], source: ChangeSource, fn: () => Promise<T>): Promise<T> {
    const before = this.capture(ids);
    const r = await fn();
    this.commit(before, source);
    return r;
  }

  pruneLog(): void {
    const s = readSettings(this.db).settings.changeLog;
    const cutoff = new Date(this.now().getTime() - s.retentionDays * 86_400_000).toISOString();
    this.db.run('DELETE FROM change_log WHERE at < ?', [cutoff]);
    const n = this.db.get<{ n: number }>('SELECT count(*) AS n FROM change_log')?.n ?? 0;
    if (n > s.maxEntries)
      this.db.run('DELETE FROM change_log WHERE id IN (SELECT id FROM change_log ORDER BY id LIMIT ?)', [
        n - s.maxEntries,
      ]);
  }

  clearLog(): number {
    return this.db.run('DELETE FROM change_log').changes;
  }

  changes(limit = 300): ChangeView[] {
    const rows = this.db.all<{
      id: number;
      batch_id: string;
      item_id: string;
      title: string;
      at: string;
      source: ChangeSource;
      field: LoggedField;
      old_value: string | null;
      new_value: string | null;
      undone_at: string | null;
    }>(`SELECT c.*, i.title FROM change_log c JOIN items i ON i.id = c.item_id ORDER BY c.id DESC LIMIT ?`, [
      Math.max(1, Math.min(2000, limit)),
    ]);
    return rows.map((r) => {
      const why = this.whyNotUndoable(r.item_id, r.field, r.new_value, r.undone_at);
      return {
        id: r.id,
        batchId: r.batch_id,
        itemId: r.item_id,
        itemTitle: r.title,
        at: r.at,
        source: r.source,
        field: r.field,
        fieldLabel: FIELD_LABELS[r.field] ?? r.field,
        oldValue: r.field === 'notes' ? null : r.old_value,
        newValue: r.field === 'notes' ? 'notes edited' : r.new_value,
        undone: r.undone_at !== null,
        undoable: why === null,
        whyNotUndoable: why,
      };
    });
  }

  private whyNotUndoable(
    itemId: string,
    field: LoggedField,
    newValue: string | null,
    undoneAt: string | null,
  ): string | null {
    if (undoneAt) return 'Already undone.';
    if (field === 'notes') return 'Notes are not stored in the log, so this cannot be undone here.';
    const cur = this.snap(itemId, true);
    if (!cur) return 'The item no longer exists.';
    if (cur[field] !== newValue) return 'Changed again since then.';
    return null;
  }

  undoChange(id: number): ChangeView {
    const r = this.db.get<{
      item_id: string;
      field: LoggedField;
      old_value: string | null;
      new_value: string | null;
      undone_at: string | null;
    }>('SELECT item_id, field, old_value, new_value, undone_at FROM change_log WHERE id = ?', [id]);
    if (!r) throw appError('NOT_FOUND', 'That change is no longer in the log.');
    const why = this.whyNotUndoable(r.item_id, r.field, r.new_value, r.undone_at);
    if (why) throw appError('CONFLICT', why);
    this.applyValue(r.item_id, r.field, r.old_value);
    this.db.run('UPDATE change_log SET undone_at = ? WHERE id = ?', [this.now().toISOString(), id]);
    const v = this.changes(2000).find((c) => c.id === id);
    if (!v) throw appError('NOT_FOUND', 'That change is no longer in the log.');
    return v;
  }

  /** Undoes every still-undoable change of a batch (bulk edit, rules, triage). */
  undoBatch(batchId: string): { undone: number; skipped: number } {
    const rows = this.db.all<{ id: number }>(
      'SELECT id FROM change_log WHERE batch_id = ? ORDER BY id DESC',
      [batchId],
    );
    let undone = 0;
    let skipped = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        try {
          this.undoChange(r.id);
          undone++;
        } catch {
          skipped++;
        }
      }
    });
    return { undone, skipped };
  }

  private applyValue(itemId: string, field: LoggedField, value: string | null): void {
    const lib = this.library;
    switch (field) {
      case 'status':
        lib.setStatus({
          id: itemId,
          status: value as Status,
          startNewPass: false,
          clearDateCompleted: value !== 'completed',
          fillRemaining: false,
        });
        return;
      case 'rating':
        lib.setRating(itemId, value === null ? null : Number(value));
        return;
      case 'deleted':
        if (value === 'yes') lib.softDelete([itemId]);
        else lib.undoDelete([itemId]);
        return;
      case 'nextStep':
        if (value === null) this.db.run('DELETE FROM item_next_steps WHERE item_id = ?', [itemId]);
        else
          this.db.run(
            'INSERT INTO item_next_steps (item_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
            [itemId, value, this.now().toISOString()],
          );
        return;
      case 'title': {
        const d = lib.get(itemId);
        lib.update({ id: itemId, meta: { ...d.meta, title: value ?? d.meta.title } });
        return;
      }
      case 'dateStarted':
      case 'dateCompleted':
      case 'tags': {
        const d = lib.get(itemId);
        const p = { ...d.personal };
        if (field === 'dateStarted') p.dateStarted = value;
        else if (field === 'dateCompleted') p.dateCompleted = value;
        else p.tags = value ? value.split(', ') : [];
        lib.update({ id: itemId, personal: p });
        return;
      }
      case 'notes':
        throw appError('CONFLICT', 'Notes cannot be undone from the log.');
    }
  }
}

const clip = (v: string | null) => (v === null ? null : v.slice(0, 600));

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Import batches: every Steam / manual-list / tracker import is recorded so it
 * can be audited and undone.
 *
 * Undo rule: only items the user has NOT touched since the import are removed.
 * "Touched" = the item's `updated_at` changed (any edit: notes, rating, status,
 * metadata, tags, dates) or its history grew/shrank (progress entries,
 * viewings). Touched items are kept and listed with the reason.
 *
 * Batch records (not the items) are purged after `importUndoRetentionDays`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appError } from '../../shared/result';
import type { ImportBatchView, UndoPreviewView } from '../../shared/types';
import { addDays } from '../../domain/calendar';
import { localDate } from '../../domain/dates';
import { readSettings } from '../../db/repositories/config-repo';
import type { ServiceContext } from './context';
import type { LibraryService } from './library-service';

export type BatchKind = ImportBatchView['kind'];

export class ImportBatchService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  /** Counts history rows used for the "touched since import" check. */
  eventCount(itemId: string): number {
    return (
      this.db.get<{ n: number }>(
        `SELECT (SELECT count(*) FROM progress_events WHERE item_id = ? AND deleted_at IS NULL)
              + (SELECT count(*) FROM viewing_events WHERE item_id = ?) AS n`,
        [itemId, itemId],
      )?.n ?? 0
    );
  }

  /** Creates a batch. Must run inside the caller's transaction together with the item inserts. */
  begin(kind: BatchKind, label: string, sourceId: string | null): string {
    const id = randomUUID();
    this.db.run(
      'INSERT INTO import_batches (id, kind, source_id, label, created_at, item_count) VALUES (?, ?, ?, ?, ?, 0)',
      [id, kind, sourceId, label.slice(0, 200), this.ctx.clock.now().toISOString()],
    );
    return id;
  }

  /**
   * Content fingerprint of everything a user can edit on an item (metadata,
   * personal fields, tags, genres, creators, ids, custom fields, game/book
   * details). Stored with `updated_at` so an edit is detected even if it
   * happens within the same millisecond as the import.
   */
  fingerprint(itemId: string): string | null {
    const db = this.db;
    const row = db.get<Record<string, unknown>>(
      `SELECT title, description, release_date, status, rating, notes, date_added, date_started, date_completed, pass,
              artwork_id, updated_at FROM items WHERE id = ?`,
      [itemId],
    );
    if (!row) return null;
    const parts = [
      row,
      db.all('SELECT tag_id FROM item_tags WHERE item_id = ? ORDER BY tag_id', [itemId]),
      db.all('SELECT genre_id FROM item_genres WHERE item_id = ? ORDER BY genre_id', [itemId]),
      db.all('SELECT creator_id, role FROM item_creators WHERE item_id = ? ORDER BY creator_id, role', [
        itemId,
      ]),
      db.all('SELECT kind, value FROM external_ids WHERE item_id = ? ORDER BY kind', [itemId]),
      db.all(
        'SELECT def_id, text_value, number_value FROM custom_field_values WHERE item_id = ? ORDER BY def_id',
        [itemId],
      ),
      db.all('SELECT progress_scheme FROM game_details WHERE item_id = ?', [itemId]),
      db.all('SELECT page_count, format, publisher FROM book_details WHERE item_id = ?', [itemId]),
      db.all('SELECT name, owned, played FROM game_platforms WHERE item_id = ? ORDER BY position', [itemId]),
    ];
    return `${String(row['updated_at'])}|${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
  }

  /** Records an imported item's baseline. Call after all of the import's own writes to the item. */
  record(batchId: string, itemId: string): void {
    const row = this.db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', [itemId]);
    const fp = this.fingerprint(itemId);
    if (!row || !fp) return;
    this.db.run(
      'INSERT OR REPLACE INTO import_batch_items (batch_id, item_id, title, baseline_updated_at, baseline_events) VALUES (?, ?, ?, ?, ?)',
      [batchId, itemId, row.title, fp, this.eventCount(itemId)],
    );
    this.db.run(
      'UPDATE import_batches SET item_count = (SELECT count(*) FROM import_batch_items WHERE batch_id = ?) WHERE id = ?',
      [batchId, batchId],
    );
  }

  /** Drops an empty batch (nothing was added). */
  discardIfEmpty(batchId: string): boolean {
    return (
      this.db.run(
        'DELETE FROM import_batches WHERE id = ? AND NOT EXISTS (SELECT 1 FROM import_batch_items WHERE batch_id = ?)',
        [batchId, batchId],
      ).changes > 0
    );
  }

  list(): ImportBatchView[] {
    return this.db
      .all<{
        id: string;
        kind: BatchKind;
        label: string;
        created_at: string;
        undone_at: string | null;
        item_count: number;
      }>(
        'SELECT id, kind, label, created_at, undone_at, item_count FROM import_batches ORDER BY created_at DESC LIMIT 100',
      )
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        createdAt: r.created_at,
        undoneAt: r.undone_at,
        itemCount: r.item_count,
        canUndo: r.undone_at === null && r.item_count > 0,
      }));
  }

  undoPreview(batchId: string): UndoPreviewView {
    const b = this.db.get<{ label: string; undone_at: string | null }>(
      'SELECT label, undone_at FROM import_batches WHERE id = ?',
      [batchId],
    );
    if (!b)
      throw appError('NOT_FOUND', 'That import is no longer available to undo.', {
        recovery: 'Undo is kept for a limited time (Settings → Library).',
      });
    if (b.undone_at) throw appError('CONFLICT', 'This import was already undone.');
    const rows = this.db.all<{
      item_id: string;
      title: string;
      baseline_updated_at: string;
      baseline_events: number;
      updated_at: string | null;
      deleted_at: string | null;
      cur_title: string | null;
    }>(
      `SELECT bi.item_id, bi.title, bi.baseline_updated_at, bi.baseline_events, i.updated_at, i.deleted_at, i.title AS cur_title
       FROM import_batch_items bi LEFT JOIN items i ON i.id = bi.item_id WHERE bi.batch_id = ? ORDER BY bi.title`,
      [batchId],
    );
    const removable: UndoPreviewView['removable'] = [];
    const kept: UndoPreviewView['kept'] = [];
    let alreadyGone = 0;
    for (const r of rows) {
      if (r.updated_at === null || r.deleted_at !== null) {
        alreadyGone++;
        continue;
      }
      const title = r.cur_title ?? r.title;
      const fp = this.fingerprint(r.item_id) ?? '';
      // Baselines from older exports may hold only the timestamp; compare what is available.
      const edited = r.baseline_updated_at.includes('|')
        ? fp !== r.baseline_updated_at
        : r.updated_at !== r.baseline_updated_at;
      if (edited)
        kept.push({
          itemId: r.item_id,
          title,
          reason: 'Edited since import (details, status, rating, notes or tags).',
        });
      else if (this.eventCount(r.item_id) !== r.baseline_events)
        kept.push({ itemId: r.item_id, title, reason: 'Progress or viewings were logged since import.' });
      else removable.push({ itemId: r.item_id, title });
    }
    return { batchId, label: b.label, removable, kept, alreadyGone };
  }

  /** Removes untouched items (soft delete, purged at next start) and marks the batch undone. */
  undo(batchId: string): UndoPreviewView {
    const preview = this.undoPreview(batchId);
    this.db.transaction(() => {
      if (preview.removable.length > 0) this.library.softDelete(preview.removable.map((r) => r.itemId));
      this.db.run('UPDATE import_batches SET undone_at = ? WHERE id = ?', [
        this.ctx.clock.now().toISOString(),
        batchId,
      ]);
      // Steam/manual source entries that pointed at removed items become "not in pile" again.
      for (const r of preview.removable)
        this.db.run('UPDATE library_source_entries SET item_id = NULL WHERE item_id = ?', [r.itemId]);
    });
    this.ctx.log.info('import.undo', { removed: preview.removable.length, kept: preview.kept.length });
    return preview;
  }

  /** Purges batch records older than the retention period. Items are never touched. */
  purgeExpired(): number {
    const days = readSettings(this.db).settings.importUndoRetentionDays;
    const cutoff = `${addDays(localDate(this.ctx.clock.now()), -days)}T00:00:00.000Z`;
    return this.db.run('DELETE FROM import_batches WHERE created_at < ?', [cutoff]).changes;
  }
}

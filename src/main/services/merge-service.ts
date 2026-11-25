/**
 * Duplicate merge with snapshot undo.
 *
 * Finding: pairs of live items of the same type that share an external id or
 * a normalized title (+ year when both have one), minus dismissed pairs.
 *
 * Merging keeps item A, takes the fields the user chose from B, unions ids,
 * alt titles, tags, genres and moods, moves B's logs (sessions, purchases,
 * availability, viewings, list memberships, series membership, relations) to
 * A, moves B's episode/progress history only when A has none, and soft-deletes
 * B (recorded in `merged_ids`).
 *
 * Undo: before merging, every row referencing A or B is captured generically
 * (all tables with a foreign key to items, plus tables that reference those
 * rows), so undo restores both items exactly. Undo is refused if A changed
 * after the merge, because restoring would silently discard that change.
 */
import type { DuplicatePair, MergeFieldRow, MergePreview } from '../../shared/types';
import { appError } from '../../shared/result';
import type { MediaType, Status } from '../../shared/enums';
import type { MetadataField, MetadataFields } from '../../shared/schemas';
import type { Db } from '../../db/connection';
import * as items from '../../db/repositories/items-repo';
import { FIELDS_BY_TYPE, canonicalValue, displayValue, FIELD_LABELS } from '../../domain/metadata';
import { titleKey } from '../../domain/normalize';
import type { ServiceContext } from './context';

export interface MergeChoices {
  /** field → which side wins ('a' = kept item). Missing fields keep A. `notes` also accepts 'both'. */
  fields: Record<string, 'a' | 'b' | 'both'>;
}

type Snapshot = { tables: Record<string, Record<string, unknown>[]>; items: Record<string, unknown>[] };

const PERSONAL_FIELDS = ['status', 'rating', 'notes'] as const;

/** Tables with a foreign key to items(id), and second-level tables referencing their `id`. */
function referencingTables(db: Db): {
  level1: { table: string; col: string }[];
  level2: { table: string; col: string; parent: string }[];
} {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'",
    )
    .map((r) => r.name);
  const fks = new Map<string, { table: string; from: string }[]>();
  for (const t of tables)
    fks.set(t, db.all<{ table: string; from: string }>(`PRAGMA foreign_key_list("${t.replace(/"/g, '')}")`));
  const level1 = tables.flatMap((t) =>
    (fks.get(t) ?? []).filter((f) => f.table === 'items').map((f) => ({ table: t, col: f.from })),
  );
  const l1names = new Set(level1.map((l) => l.table));
  const level2 = tables.flatMap((t) =>
    (fks.get(t) ?? [])
      .filter((f) => l1names.has(f.table) && f.table !== t && !level1.some((l) => l.table === t))
      .map((f) => ({ table: t, col: f.from, parent: f.table })),
  );
  return { level1, level2 };
}

const q = (id: string) => `"${id.replace(/"/g, '')}"`;

export class MergeService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }

  /* ---------------------------------------------------------------- finding */

  findPairs(limit = 200): DuplicatePair[] {
    const db = this.db;
    const rows = db.all<{
      id: string;
      title: string;
      type: MediaType;
      release_year: number | null;
      status: Status;
    }>('SELECT id, title, type, release_year, status FROM items WHERE deleted_at IS NULL');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const dismissed = new Set(
      db
        .all<{ a_id: string; b_id: string }>('SELECT a_id, b_id FROM duplicate_dismissals')
        .map((d) => `${d.a_id}|${d.b_id}`),
    );
    const pairs = new Map<string, DuplicatePair>();
    const add = (x: string, y: string, reason: string) => {
      if (x === y) return;
      const [a, b] = x < y ? [x, y] : [y, x];
      const k = `${a}|${b}`;
      if (dismissed.has(k) || pairs.has(k)) return;
      const ra = byId.get(a);
      const rb = byId.get(b);
      if (!ra || !rb || ra.type !== rb.type) return;
      const v = (r: typeof ra) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        year: r.release_year,
        status: r.status,
      });
      pairs.set(k, { a: v(ra), b: v(rb), reason });
    };
    // Shared external ids.
    for (const r of db.all<{ a: string; b: string; kind: string }>(
      `SELECT e1.item_id AS a, e2.item_id AS b, e1.kind FROM external_ids e1
         JOIN external_ids e2 ON e2.kind = e1.kind AND e2.value = e1.value AND e2.item_id > e1.item_id`,
    ))
      add(r.a, r.b, `Same ${r.kind.toUpperCase()} id`);
    // Same normalized title and type (and year when both known).
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.type}|${titleKey(r.title)}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    for (const g of groups.values()) {
      if (g.length < 2 || g.length > 20) continue;
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) {
          const x = g[i];
          const y = g[j];
          if (!x || !y) continue;
          if (x.release_year && y.release_year && x.release_year !== y.release_year) continue;
          add(x.id, y.id, 'Same title');
        }
    }
    return [...pairs.values()].slice(0, limit);
  }

  dismiss(aId: string, bId: string): void {
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    this.db.run('INSERT OR IGNORE INTO duplicate_dismissals (a_id, b_id, created_at) VALUES (?, ?, ?)', [
      a,
      b,
      this.ctx.clock.now().toISOString(),
    ]);
  }

  /* ---------------------------------------------------------------- preview */

  private pair(keepId: string, removeId: string) {
    if (keepId === removeId) throw appError('VALIDATION', 'Choose two different items.');
    const a = items.getItemRow(this.db, keepId);
    const b = items.getItemRow(this.db, removeId);
    if (!a || !b) throw appError('NOT_FOUND', 'One of those items no longer exists.');
    if (a.type !== b.type) throw appError('VALIDATION', 'Only items of the same type can be merged.');
    return { a, b, ma: items.loadMeta(this.db, a), mb: items.loadMeta(this.db, b) };
  }

  preview(keepId: string, removeId: string): MergePreview {
    const { a, b, ma, mb } = this.pair(keepId, removeId);
    const rows: MergeFieldRow[] = [];
    for (const f of FIELDS_BY_TYPE[a.type]) {
      if (f === 'externalIds' || f === 'altTitles') continue; // always unioned
      if (canonicalValue(f, ma[f]) === canonicalValue(f, mb[f])) continue;
      rows.push({
        field: f,
        label: FIELD_LABELS[f] ?? f,
        a: displayValue(f, ma[f]),
        b: displayValue(f, mb[f]),
      });
    }
    const personal = (r: typeof a) => ({
      status: r.status,
      rating: r.rating === null ? null : `${r.rating / 2}★`,
      notes: r.notes || null,
    });
    const pa = personal(a);
    const pb = personal(b);
    for (const f of PERSONAL_FIELDS)
      if (pa[f] !== pb[f])
        rows.push({ field: f, label: f.charAt(0).toUpperCase() + f.slice(1), a: pa[f], b: pb[f] });
    return {
      keepId,
      removeId,
      rows,
      moves: [
        'IDs, alternative titles, tags, genres and moods are combined.',
        'Sessions, purchases, availability, viewing history, lists and series memberships move to the kept item.',
        'Episode and progress history move only if the kept item has none.',
        `“${b.title}” is removed (you can undo this merge).`,
      ],
    };
  }

  /* ---------------------------------------------------------------- snapshot */

  private snapshot(ids: string[]): Snapshot {
    const db = this.db;
    const { level1, level2 } = referencingTables(db);
    const ph = ids.map(() => '?').join(',');
    const tables: Snapshot['tables'] = {};
    for (const l of level1) {
      const rows = db.all<Record<string, unknown>>(
        `SELECT * FROM ${q(l.table)} WHERE ${q(l.col)} IN (${ph})`,
        ids,
      );
      tables[`${l.table}.${l.col}`] = rows;
    }
    for (const l of level2) {
      const parents = tables[Object.keys(tables).find((k) => k.startsWith(`${l.parent}.`)) ?? ''] ?? [];
      const pids = parents.map((p) => p['id']).filter((x): x is string => typeof x === 'string');
      if (pids.length === 0) {
        tables[`${l.table}.${l.col}`] = [];
        continue;
      }
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < pids.length; i += 500) {
        const chunk = pids.slice(i, i + 500);
        rows.push(
          ...db.all<Record<string, unknown>>(
            `SELECT * FROM ${q(l.table)} WHERE ${q(l.col)} IN (${chunk.map(() => '?').join(',')})`,
            chunk,
          ),
        );
      }
      tables[`${l.table}.${l.col}`] = rows;
    }
    const itemsRows = db.all<Record<string, unknown>>(`SELECT * FROM items WHERE id IN (${ph})`, ids);
    return { tables, items: itemsRows };
  }

  private restore(s: Snapshot, ids: string[]): void {
    const db = this.db;
    const ph = ids.map(() => '?').join(',');
    const { level1 } = referencingTables(db);
    // Delete everything referencing the two items now (cascades to level-2 rows), then re-insert the snapshot.
    for (const l of level1) db.run(`DELETE FROM ${q(l.table)} WHERE ${q(l.col)} IN (${ph})`, ids);
    const insert = (key: string, rows: Record<string, unknown>[]) => {
      const table = key.slice(0, key.indexOf('.'));
      for (const r of rows) {
        const cols = Object.keys(r);
        db.run(
          `INSERT OR REPLACE INTO ${q(table)} (${cols.map(q).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
          cols.map((c) => r[c] as never),
        );
      }
    };
    const keys = Object.keys(s.tables);
    const l1 = new Set(level1.map((l) => `${l.table}.${l.col}`));
    // Parents (level 1) before children (level 2); items.artwork_id is restored last (artwork rows exist by then).
    for (const k of keys.filter((k) => l1.has(k))) insert(k, s.tables[k] ?? []);
    for (const k of keys.filter((k) => !l1.has(k))) insert(k, s.tables[k] ?? []);
    for (const it of s.items) {
      const cols = Object.keys(it).filter((c) => c !== 'id' && c !== 'rid');
      db.run(`UPDATE items SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE id = ?`, [
        ...cols.map((c) => it[c] as never),
        it['id'] as string,
      ]);
    }
  }

  /* ---------------------------------------------------------------- merge / undo */

  merge(keepId: string, removeId: string, choices: MergeChoices): { snapshotId: string } {
    const db = this.db;
    const { a, b, ma, mb } = this.pair(keepId, removeId);
    const now = this.ctx.clock.now().toISOString();
    const snapshotId = items.newId();
    db.transaction(() => {
      const snap = this.snapshot([keepId, removeId]);
      // Metadata: chosen fields from B, unions for ids/alt titles/genres.
      const meta: MetadataFields = { ...ma };
      for (const f of FIELDS_BY_TYPE[a.type]) {
        if (choices.fields[f] === 'b') (meta as Record<MetadataField, unknown>)[f] = mb[f];
      }
      const ids = [...ma.externalIds];
      for (const e of mb.externalIds) if (!ids.some((x) => x.kind === e.kind)) ids.push(e);
      meta.externalIds = ids;
      meta.altTitles = [
        ...new Set([...ma.altTitles, ...mb.altTitles, mb.title, ma.title].filter((t) => t !== meta.title)),
      ].slice(0, 20);
      meta.genres = [...new Set([...ma.genres, ...mb.genres])].slice(0, 20);
      items.writeMeta(db, keepId, a.type, meta);
      // Personal fields.
      const status = choices.fields['status'] === 'b' ? b.status : a.status;
      const rating = choices.fields['rating'] === 'b' ? b.rating : a.rating;
      const notes =
        choices.fields['notes'] === 'b'
          ? b.notes
          : choices.fields['notes'] === 'both' && b.notes
            ? [a.notes, b.notes].filter(Boolean).join('\n\n---\n\n')
            : a.notes;
      const dates =
        choices.fields['status'] === 'b'
          ? { s: b.date_started, c: b.date_completed }
          : { s: a.date_started, c: a.date_completed };
      db.run(
        'UPDATE items SET status = ?, rating = ?, notes = ?, date_started = ?, date_completed = ?, date_added = min(date_added, ?), updated_at = ? WHERE id = ?',
        [status, rating, notes.slice(0, 100_000), dates.s, dates.c, b.date_added, now, keepId],
      );
      // Unions of tags and moods.
      db.run(
        'INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT ?, tag_id FROM item_tags WHERE item_id = ?',
        [keepId, removeId],
      );
      db.run(
        'INSERT OR IGNORE INTO item_moods (item_id, mood_id) SELECT ?, mood_id FROM item_moods WHERE item_id = ?',
        [keepId, removeId],
      );
      // Logs that simply move.
      for (const t of ['sessions', 'purchases', 'availability_entries', 'viewing_events'])
        db.run(`UPDATE ${t} SET item_id = ? WHERE item_id = ?`, [keepId, removeId]);
      db.run('UPDATE OR IGNORE list_items SET item_id = ? WHERE item_id = ?', [keepId, removeId]);
      db.run('UPDATE OR IGNORE franchise_items SET item_id = ? WHERE item_id = ?', [keepId, removeId]);
      db.run(
        'UPDATE OR IGNORE item_relations SET from_item_id = ? WHERE from_item_id = ? AND to_item_id <> ?',
        [keepId, removeId, keepId],
      );
      db.run(
        'UPDATE OR IGNORE item_relations SET to_item_id = ? WHERE to_item_id = ? AND from_item_id <> ?',
        [keepId, removeId, keepId],
      );
      // Episodes/progress only when A has none (no attempt to interleave two histories).
      const aHasEpisodes = Boolean(db.get('SELECT 1 FROM seasons WHERE item_id = ?', [keepId]));
      if (!aHasEpisodes) {
        db.run('UPDATE seasons SET item_id = ? WHERE item_id = ?', [keepId, removeId]);
        db.run('UPDATE episodes SET item_id = ? WHERE item_id = ?', [keepId, removeId]);
      }
      const aHasProgress = Boolean(
        db.get('SELECT 1 FROM progress_events WHERE item_id = ? AND deleted_at IS NULL', [keepId]),
      );
      if (!aHasProgress)
        db.run('UPDATE progress_events SET item_id = ? WHERE item_id = ?', [keepId, removeId]);
      // Remove B.
      db.run('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, removeId]);
      db.run('DELETE FROM up_next WHERE item_id = ?', [removeId]);
      db.run(
        'INSERT OR REPLACE INTO merged_ids (old_id, item_id, old_title, merged_at) VALUES (?, ?, ?, ?)',
        [removeId, keepId, b.title.slice(0, 500), now],
      );
      items.reindexItem(db, keepId);
      items.reindexItem(db, removeId);
      items.recomputeProgress(db, keepId);
      items.pruneOrphans(db);
      db.run(
        'INSERT INTO merge_snapshots (id, kept_item_id, removed_item_id, snapshot, kept_updated_at, created_at, undone_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        [snapshotId, keepId, removeId, JSON.stringify(snap), now, now],
      );
    });
    this.ctx.log.info('merge.done', { keepId, removeId });
    return { snapshotId };
  }

  lastUndoable(): { snapshotId: string; keptTitle: string; removedTitle: string; createdAt: string } | null {
    const r = this.db.get<{ id: string; kept_item_id: string; removed_item_id: string; created_at: string }>(
      'SELECT id, kept_item_id, removed_item_id, created_at FROM merge_snapshots WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1',
    );
    if (!r) return null;
    const t = (id: string) =>
      this.db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', [id])?.title ?? '(deleted)';
    return {
      snapshotId: r.id,
      keptTitle: t(r.kept_item_id),
      removedTitle: t(r.removed_item_id),
      createdAt: r.created_at,
    };
  }

  undo(snapshotId: string): void {
    const db = this.db;
    const s = db.get<{
      kept_item_id: string;
      removed_item_id: string;
      snapshot: string;
      kept_updated_at: string;
      undone_at: string | null;
    }>(
      'SELECT kept_item_id, removed_item_id, snapshot, kept_updated_at, undone_at FROM merge_snapshots WHERE id = ?',
      [snapshotId],
    );
    if (!s || s.undone_at) throw appError('NOT_FOUND', 'That merge can no longer be undone.');
    const kept = db.get<{ updated_at: string; deleted_at: string | null }>(
      'SELECT updated_at, deleted_at FROM items WHERE id = ?',
      [s.kept_item_id],
    );
    if (!kept || kept.deleted_at)
      throw appError('CONFLICT', 'The kept item was deleted, so this merge cannot be undone.');
    if (kept.updated_at !== s.kept_updated_at)
      throw appError(
        'CONFLICT',
        'The kept item changed after the merge, so undo would discard those changes.',
        {
          recovery: 'Edit the items by hand instead.',
        },
      );
    const snap = JSON.parse(s.snapshot) as Snapshot;
    db.transaction(() => {
      this.restore(snap, [s.kept_item_id, s.removed_item_id]);
      db.run('DELETE FROM merged_ids WHERE old_id = ?', [s.removed_item_id]);
      db.run('UPDATE merge_snapshots SET undone_at = ? WHERE id = ?', [
        this.ctx.clock.now().toISOString(),
        snapshotId,
      ]);
      items.reindexItem(db, s.kept_item_id);
      items.reindexItem(db, s.removed_item_id);
      items.pruneOrphans(db);
    });
    this.ctx.log.info('merge.undone', { snapshotId });
  }

  /** Follows merged ids (for links/imports referencing a removed item). */
  resolveId(id: string): string {
    return (
      this.db.get<{ item_id: string }>('SELECT item_id FROM merged_ids WHERE old_id = ?', [id])?.item_id ?? id
    );
  }
}

/**
 * Custom lists: user-made collections that can mix media types. An item can be
 * in many lists. Deleting a list never deletes its items (only memberships).
 * List and item order are explicit `position` columns compacted after changes.
 */
import { randomUUID } from 'node:crypto';
import { appError } from '../../shared/result';
import type { ListInput } from '../../shared/schemas';
import type { ListDetailView, ListSummaryView } from '../../shared/types';
import { tagKey } from '../../domain/normalize';
import * as items from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';

interface ListRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export class ListsService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }
  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  list(): ListSummaryView[] {
    const rows = this.db.all<ListRow & { total: number; completed: number }>(
      `SELECT l.*,
              (SELECT count(*) FROM list_items li JOIN items i ON i.id = li.item_id WHERE li.list_id = l.id AND i.deleted_at IS NULL) AS total,
              (SELECT count(*) FROM list_items li JOIN items i ON i.id = li.item_id WHERE li.list_id = l.id AND i.deleted_at IS NULL AND i.status = 'completed') AS completed
       FROM lists l ORDER BY l.position, l.name COLLATE NOCASE`,
    );
    return rows.map((r) => this.summary(r, r.total, r.completed));
  }

  private summary(r: ListRow, total: number, completed: number): ListSummaryView {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color as ListSummaryView['color'],
      icon: r.icon as ListSummaryView['icon'],
      position: r.position,
      total,
      completed,
      updatedAt: r.updated_at,
    };
  }

  get(id: string): ListDetailView {
    const s = this.list().find((l) => l.id === id);
    if (!s) throw appError('NOT_FOUND', 'That list no longer exists.');
    const entries = items.summariesWhere(
      this.db,
      'i.id IN (SELECT item_id FROM list_items WHERE list_id = ?)',
      // Positional params bind in SQL order: the WHERE placeholder first, then ORDER BY's.
      [id, id],
      'ORDER BY (SELECT position FROM list_items WHERE list_id = ? AND item_id = i.id), i.sort_title',
    );
    return { ...s, items: entries };
  }

  save(input: ListInput): ListSummaryView[] {
    const db = this.db;
    const key = tagKey(input.name);
    const clash = db.get<{ id: string }>('SELECT id FROM lists WHERE name_key = ?', [key]);
    if (clash && clash.id !== input.id)
      throw appError('CONFLICT', `A list called “${input.name}” already exists.`, {
        fieldErrors: { name: 'Choose a different name.' },
      });
    const now = this.now();
    db.transaction(() => {
      if (input.id) {
        const r = db.run(
          'UPDATE lists SET name = ?, name_key = ?, description = ?, color = ?, icon = ?, updated_at = ? WHERE id = ?',
          [input.name, key, input.description, input.color, input.icon, now, input.id],
        );
        if (r.changes === 0) throw appError('NOT_FOUND', 'That list no longer exists.');
      } else {
        const pos = (db.get<{ p: number | null }>('SELECT max(position) AS p FROM lists')?.p ?? -1) + 1;
        db.run(
          'INSERT INTO lists (id, name, name_key, description, color, icon, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), input.name, key, input.description, input.color, input.icon, pos, now, now],
        );
      }
    });
    return this.list();
  }

  /** Creates a list by name if missing (used by imports); returns its id. */
  ensure(name: string): string {
    const key = tagKey(name);
    const existing = this.db.get<{ id: string }>('SELECT id FROM lists WHERE name_key = ?', [key]);
    if (existing) return existing.id;
    const now = this.now();
    const id = randomUUID();
    const pos = (this.db.get<{ p: number | null }>('SELECT max(position) AS p FROM lists')?.p ?? -1) + 1;
    this.db.run(
      'INSERT INTO lists (id, name, name_key, description, color, icon, position, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)',
      [id, name.slice(0, 80), key, pos, now, now],
    );
    return id;
  }

  remove(id: string): ListSummaryView[] {
    this.db.transaction(() => {
      // list_items cascade; items themselves are untouched.
      this.db.run('DELETE FROM lists WHERE id = ?', [id]);
      this.compactLists();
    });
    return this.list();
  }

  private compactLists(): void {
    this.db
      .all<{ id: string }>('SELECT id FROM lists ORDER BY position, name COLLATE NOCASE')
      .forEach((r, i) => this.db.run('UPDATE lists SET position = ? WHERE id = ?', [i, r.id]));
  }

  move(id: string, direction: 'up' | 'down'): ListSummaryView[] {
    this.db.transaction(() => {
      this.compactLists();
      const ids = this.db.all<{ id: string }>('SELECT id FROM lists ORDER BY position').map((r) => r.id);
      const i = ids.indexOf(id);
      if (i === -1) throw appError('NOT_FOUND', 'That list no longer exists.');
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      this.db.run('UPDATE lists SET position = ? WHERE id = ?', [j, id]);
      this.db.run('UPDATE lists SET position = ? WHERE id = ?', [i, ids[j] ?? '']);
    });
    return this.list();
  }

  /** Adds or removes items; returns how many memberships changed. Must be safe inside a caller's transaction. */
  setMembership(listId: string, itemIds: readonly string[], member: boolean): number {
    const db = this.db;
    if (!db.get('SELECT 1 FROM lists WHERE id = ?', [listId]))
      throw appError('NOT_FOUND', 'That list no longer exists.');
    const now = this.now();
    let changed = 0;
    db.transaction(() => {
      for (const itemId of itemIds) {
        if (member) {
          if (!items.getItemRow(db, itemId)) continue;
          const pos =
            (db.get<{ p: number | null }>('SELECT max(position) AS p FROM list_items WHERE list_id = ?', [
              listId,
            ])?.p ?? -1) + 1;
          changed += db.run(
            'INSERT INTO list_items (list_id, item_id, position, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
            [listId, itemId, pos, now],
          ).changes;
        } else {
          changed += db.run('DELETE FROM list_items WHERE list_id = ? AND item_id = ?', [
            listId,
            itemId,
          ]).changes;
        }
      }
      if (!member) this.compactItems(listId);
      db.run('UPDATE lists SET updated_at = ? WHERE id = ?', [now, listId]);
    });
    return changed;
  }

  private compactItems(listId: string): void {
    this.db
      .all<{ item_id: string }>(
        'SELECT item_id FROM list_items WHERE list_id = ? ORDER BY position, item_id',
        [listId],
      )
      .forEach((r, i) =>
        this.db.run('UPDATE list_items SET position = ? WHERE list_id = ? AND item_id = ?', [
          i,
          listId,
          r.item_id,
        ]),
      );
  }

  moveItem(listId: string, itemId: string, direction: 'up' | 'down'): ListDetailView {
    this.db.transaction(() => {
      this.compactItems(listId);
      const ids = this.db
        .all<{ item_id: string }>('SELECT item_id FROM list_items WHERE list_id = ? ORDER BY position', [
          listId,
        ])
        .map((r) => r.item_id);
      const i = ids.indexOf(itemId);
      if (i === -1) throw appError('NOT_FOUND', 'That item is not in this list.');
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      this.db.run('UPDATE list_items SET position = ? WHERE list_id = ? AND item_id = ?', [
        j,
        listId,
        itemId,
      ]);
      this.db.run('UPDATE list_items SET position = ? WHERE list_id = ? AND item_id = ?', [
        i,
        listId,
        ids[j] ?? '',
      ]);
    });
    return this.get(listId);
  }

  listsForItem(itemId: string): { id: string; name: string }[] {
    return this.db.all<{ id: string; name: string }>(
      'SELECT l.id, l.name FROM lists l JOIN list_items li ON li.list_id = l.id WHERE li.item_id = ? ORDER BY l.position',
      [itemId],
    );
  }
}

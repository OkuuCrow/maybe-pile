/**
 * Moods: small, user-editable labels ("Cozy", "Short on time") attached to
 * items, used by filters, Pick for Me and recommendations. Built-in moods can
 * be renamed/hidden/reordered but not deleted; custom moods can be deleted.
 */
import type { MoodView } from '../../shared/types';
import { appError } from '../../shared/result';
import { MOOD_ICONS, type MoodColor, type MoodIcon } from '../../shared/enums';
import { titleKey } from '../../domain/normalize';
import { newId } from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';

interface MoodRow {
  id: string;
  name: string;
  icon: MoodIcon;
  color: MoodColor | null;
  hidden: number;
  position: number;
  builtin_key: string | null;
  n: number;
}

export const MAX_MOODS = 60;
export const MAX_MOODS_PER_ITEM = 12;

export class MoodsService {
  constructor(private readonly ctx: ServiceContext) {}

  list(): MoodView[] {
    return this.ctx
      .db()
      .all<MoodRow>(
        `SELECT m.id, m.name, m.icon, m.color, m.hidden, m.position, m.builtin_key,
                (SELECT count(*) FROM item_moods im JOIN items i ON i.id = im.item_id
                  WHERE im.mood_id = m.id AND i.deleted_at IS NULL) AS n
           FROM moods m ORDER BY m.position, m.name`,
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        icon: r.icon,
        color: r.color,
        hidden: r.hidden === 1,
        position: r.position,
        builtin: r.builtin_key !== null,
        itemCount: r.n,
      }));
  }

  create(input: { name: string; icon: MoodIcon; color: MoodColor | null }): MoodView[] {
    const db = this.ctx.db();
    const key = titleKey(input.name);
    if (!key) throw appError('VALIDATION', 'Give the mood a name.');
    const count = db.get<{ n: number }>('SELECT count(*) AS n FROM moods')?.n ?? 0;
    if (count >= MAX_MOODS) throw appError('VALIDATION', `You can have up to ${MAX_MOODS} moods.`);
    if (db.get('SELECT 1 FROM moods WHERE name_key = ?', [key]))
      throw appError('CONFLICT', 'A mood with that name already exists.');
    if (!MOOD_ICONS.includes(input.icon)) throw appError('VALIDATION', 'Unknown icon.');
    const pos = (db.get<{ p: number | null }>('SELECT max(position) AS p FROM moods')?.p ?? -1) + 1;
    db.run(
      `INSERT INTO moods (id, name, name_key, icon, color, hidden, position, builtin_key, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
      [newId(), input.name.trim(), key, input.icon, input.color, pos, this.ctx.clock.now().toISOString()],
    );
    return this.list();
  }

  update(input: {
    id: string;
    name?: string | undefined;
    icon?: MoodIcon | undefined;
    color?: MoodColor | null | undefined;
    hidden?: boolean | undefined;
  }): MoodView[] {
    const db = this.ctx.db();
    const row = db.get<{ id: string }>('SELECT id FROM moods WHERE id = ?', [input.id]);
    if (!row) throw appError('NOT_FOUND', 'That mood no longer exists.');
    db.transaction(() => {
      if (input.name !== undefined) {
        const key = titleKey(input.name);
        if (!key) throw appError('VALIDATION', 'Give the mood a name.');
        if (db.get('SELECT 1 FROM moods WHERE name_key = ? AND id <> ?', [key, input.id]))
          throw appError('CONFLICT', 'A mood with that name already exists.');
        db.run('UPDATE moods SET name = ?, name_key = ? WHERE id = ?', [input.name.trim(), key, input.id]);
      }
      if (input.icon !== undefined) db.run('UPDATE moods SET icon = ? WHERE id = ?', [input.icon, input.id]);
      if (input.color !== undefined)
        db.run('UPDATE moods SET color = ? WHERE id = ?', [input.color, input.id]);
      if (input.hidden !== undefined)
        db.run('UPDATE moods SET hidden = ? WHERE id = ?', [input.hidden ? 1 : 0, input.id]);
    });
    return this.list();
  }

  remove(id: string): MoodView[] {
    const db = this.ctx.db();
    const row = db.get<{ builtin_key: string | null }>('SELECT builtin_key FROM moods WHERE id = ?', [id]);
    if (!row) throw appError('NOT_FOUND', 'That mood no longer exists.');
    if (row.builtin_key) throw appError('VALIDATION', 'Built-in moods can be hidden but not deleted.');
    db.run('DELETE FROM moods WHERE id = ?', [id]);
    return this.list();
  }

  reorder(ids: string[]): MoodView[] {
    const db = this.ctx.db();
    db.transaction(() => {
      const known = new Set(db.all<{ id: string }>('SELECT id FROM moods').map((r) => r.id));
      const ordered = ids.filter((id) => known.has(id));
      const rest = [...known].filter((id) => !ordered.includes(id));
      [...ordered, ...rest].forEach((id, i) => db.run('UPDATE moods SET position = ? WHERE id = ?', [i, id]));
    });
    return this.list();
  }

  forItem(itemId: string): string[] {
    return this.ctx
      .db()
      .all<{ mood_id: string }>(
        'SELECT im.mood_id FROM item_moods im JOIN moods m ON m.id = im.mood_id WHERE im.item_id = ? ORDER BY m.position',
        [itemId],
      )
      .map((r) => r.mood_id);
  }

  setForItem(itemId: string, moodIds: string[]): string[] {
    const db = this.ctx.db();
    if (!db.get('SELECT 1 FROM items WHERE id = ? AND deleted_at IS NULL', [itemId]))
      throw appError('NOT_FOUND', 'That item no longer exists.');
    const unique = [...new Set(moodIds)];
    if (unique.length > MAX_MOODS_PER_ITEM)
      throw appError('VALIDATION', `Up to ${MAX_MOODS_PER_ITEM} moods per item.`);
    db.transaction(() => {
      const known = new Set(db.all<{ id: string }>('SELECT id FROM moods').map((r) => r.id));
      db.run('DELETE FROM item_moods WHERE item_id = ?', [itemId]);
      for (const id of unique)
        if (known.has(id)) db.run('INSERT INTO item_moods (item_id, mood_id) VALUES (?, ?)', [itemId, id]);
      db.run('UPDATE items SET updated_at = ? WHERE id = ?', [this.ctx.clock.now().toISOString(), itemId]);
    });
    return this.forItem(itemId);
  }

  /** Bulk add/remove one mood on many items (transactional). */
  bulk(itemIds: string[], moodId: string, add: boolean): number {
    const db = this.ctx.db();
    if (!db.get('SELECT 1 FROM moods WHERE id = ?', [moodId]))
      throw appError('NOT_FOUND', 'That mood no longer exists.');
    let n = 0;
    db.transaction(() => {
      for (const id of itemIds) {
        n += add
          ? db.run(
              'INSERT OR IGNORE INTO item_moods (item_id, mood_id) SELECT id, ? FROM items WHERE id = ? AND deleted_at IS NULL',
              [moodId, id],
            ).changes
          : db.run('DELETE FROM item_moods WHERE item_id = ? AND mood_id = ?', [id, moodId]).changes;
      }
    });
    return n;
  }

  /** Item ids having ALL the given moods (live items only). */
  itemsWithMoods(moodIds: string[]): Set<string> {
    if (moodIds.length === 0) return new Set();
    const ph = moodIds.map(() => '?').join(',');
    return new Set(
      this.ctx
        .db()
        .all<{ item_id: string }>(
          `SELECT im.item_id FROM item_moods im JOIN items i ON i.id = im.item_id
            WHERE i.deleted_at IS NULL AND im.mood_id IN (${ph})
            GROUP BY im.item_id HAVING count(DISTINCT im.mood_id) = ?`,
          [...moodIds, moodIds.length],
        )
        .map((r) => r.item_id),
    );
  }
}

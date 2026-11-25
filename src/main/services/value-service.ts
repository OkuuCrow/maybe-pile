/** Pile Value: purchases per item and per-currency totals (no conversion, no network). */
import type { PurchaseInput, PurchaseView } from '../../shared/types';
import { appError } from '../../shared/result';
import { newId } from '../../db/repositories/items-repo';
import { summarizeValue, type CurrencyTotals } from '../../domain/value';
import type { ServiceContext } from './context';

export const MAX_PURCHASES_PER_ITEM = 50;

interface Row {
  id: string;
  item_id: string;
  amount_minor: number;
  currency: string;
  purchased_on: string | null;
  store: string | null;
  edition: string | null;
  notes: string | null;
}

const view = (r: Row): PurchaseView => ({
  id: r.id,
  itemId: r.item_id,
  amountMinor: r.amount_minor,
  currency: r.currency,
  purchasedOn: r.purchased_on,
  store: r.store,
  edition: r.edition,
  notes: r.notes,
});

export class ValueService {
  constructor(private readonly ctx: ServiceContext) {}

  list(itemId: string): PurchaseView[] {
    return this.ctx
      .db()
      .all<Row>('SELECT * FROM purchases WHERE item_id = ? ORDER BY purchased_on, created_at', [itemId])
      .map(view);
  }

  add(itemId: string, p: PurchaseInput): PurchaseView[] {
    const db = this.ctx.db();
    if (!db.get('SELECT 1 FROM items WHERE id = ? AND deleted_at IS NULL', [itemId]))
      throw appError('NOT_FOUND', 'That item no longer exists.');
    const n =
      db.get<{ n: number }>('SELECT count(*) AS n FROM purchases WHERE item_id = ?', [itemId])?.n ?? 0;
    if (n >= MAX_PURCHASES_PER_ITEM)
      throw appError('VALIDATION', `Up to ${MAX_PURCHASES_PER_ITEM} purchases per item.`);
    const now = this.ctx.clock.now().toISOString();
    db.run(
      `INSERT INTO purchases (id, item_id, amount_minor, currency, purchased_on, store, edition, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), itemId, p.amountMinor, p.currency, p.purchasedOn, p.store, p.edition, p.notes, now, now],
    );
    return this.list(itemId);
  }

  update(id: string, p: PurchaseInput): PurchaseView[] {
    const db = this.ctx.db();
    const row = db.get<{ item_id: string }>('SELECT item_id FROM purchases WHERE id = ?', [id]);
    if (!row) throw appError('NOT_FOUND', 'That purchase no longer exists.');
    db.run(
      `UPDATE purchases SET amount_minor = ?, currency = ?, purchased_on = ?, store = ?, edition = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      [
        p.amountMinor,
        p.currency,
        p.purchasedOn,
        p.store,
        p.edition,
        p.notes,
        this.ctx.clock.now().toISOString(),
        id,
      ],
    );
    return this.list(row.item_id);
  }

  remove(id: string): PurchaseView[] {
    const db = this.ctx.db();
    const row = db.get<{ item_id: string }>('SELECT item_id FROM purchases WHERE id = ?', [id]);
    if (!row) throw appError('NOT_FOUND', 'That purchase no longer exists.');
    db.run('DELETE FROM purchases WHERE id = ?', [id]);
    return this.list(row.item_id);
  }

  /** Library-wide totals, one row per currency. Hours come from the latest 'hours' progress entry. */
  summary(): CurrencyTotals[] {
    const rows = this.ctx
      .db()
      .all<{ item_id: string; status: string; amount_minor: number; currency: string; hours: number | null }>(
        `SELECT p.item_id, i.status, p.amount_minor, p.currency,
              (SELECT pe.value FROM progress_events pe WHERE pe.item_id = i.id AND pe.kind = 'hours'
                 AND pe.deleted_at IS NULL ORDER BY pe.seq DESC LIMIT 1) AS hours
         FROM purchases p JOIN items i ON i.id = p.item_id WHERE i.deleted_at IS NULL`,
      );
    return summarizeValue(
      rows.map((r) => ({
        itemId: r.item_id,
        status: r.status,
        amountMinor: r.amount_minor,
        currency: r.currency,
        hours: r.hours,
      })),
    );
  }
}

/**
 * Ownership, subscriptions and "Leaving Soon". Everything here is entered by
 * the user (no catalog scraping): where they own or can access an item, and
 * optionally until when. Leaving Soon lists entries whose date is within the
 * configured window; notifications fire at most once per entry and date.
 */
import type { AvailabilityInput, AvailabilityView, LeavingSoonView, ServiceView } from '../../shared/types';
import { appError } from '../../shared/result';
import type { AvailabilityKind, ServiceKind } from '../../shared/enums';
import { ACCESSIBLE_KINDS } from '../../shared/enums';
import { readSettings } from '../../db/repositories/config-repo';
import { newId } from '../../db/repositories/items-repo';
import { titleKey } from '../../domain/normalize';
import { addDays, daysBetween } from '../../domain/dates';
import type { ServiceContext } from './context';

interface Row {
  id: string;
  item_id: string;
  kind: AvailabilityKind;
  service_id: string | null;
  service_name: string | null;
  platform: string | null;
  available_until: string | null;
  remind_days: number | null;
  notes: string | null;
}

const SELECT = `SELECT a.*, s.name AS service_name FROM availability_entries a LEFT JOIN services s ON s.id = a.service_id`;

const view = (r: Row): AvailabilityView => ({
  id: r.id,
  itemId: r.item_id,
  kind: r.kind,
  serviceId: r.service_id,
  serviceName: r.service_name,
  platform: r.platform,
  availableUntil: r.available_until,
  remindDays: r.remind_days,
  notes: r.notes,
});

export const MAX_SERVICES = 100;
export const MAX_ENTRIES_PER_ITEM = 20;

export class AvailabilityService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly today: () => string,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  /* ---------------------------------------------------------------- services */

  services(): ServiceView[] {
    return this.db
      .all<{ id: string; name: string; kind: ServiceKind; active: number; n: number }>(
        `SELECT s.id, s.name, s.kind, s.active, (SELECT count(*) FROM availability_entries a WHERE a.service_id = s.id) AS n
           FROM services s ORDER BY s.name`,
      )
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind, active: r.active === 1, entryCount: r.n }));
  }

  addService(name: string, kind: ServiceKind): ServiceView[] {
    const key = titleKey(name);
    if (!key) throw appError('VALIDATION', 'Give the service a name.');
    if ((this.db.get<{ n: number }>('SELECT count(*) AS n FROM services')?.n ?? 0) >= MAX_SERVICES)
      throw appError('VALIDATION', `Up to ${MAX_SERVICES} services.`);
    if (this.db.get('SELECT 1 FROM services WHERE name_key = ?', [key]))
      throw appError('CONFLICT', 'A service with that name already exists.');
    this.db.run(
      'INSERT INTO services (id, name, name_key, kind, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [newId(), name.trim(), key, kind, this.ctx.clock.now().toISOString()],
    );
    return this.services();
  }

  updateService(
    id: string,
    patch: { name?: string | undefined; kind?: ServiceKind | undefined; active?: boolean | undefined },
  ): ServiceView[] {
    if (!this.db.get('SELECT 1 FROM services WHERE id = ?', [id]))
      throw appError('NOT_FOUND', 'That service no longer exists.');
    this.db.transaction(() => {
      if (patch.name !== undefined) {
        const key = titleKey(patch.name);
        if (!key) throw appError('VALIDATION', 'Give the service a name.');
        if (this.db.get('SELECT 1 FROM services WHERE name_key = ? AND id <> ?', [key, id]))
          throw appError('CONFLICT', 'A service with that name already exists.');
        this.db.run('UPDATE services SET name = ?, name_key = ? WHERE id = ?', [patch.name.trim(), key, id]);
      }
      if (patch.kind !== undefined)
        this.db.run('UPDATE services SET kind = ? WHERE id = ?', [patch.kind, id]);
      if (patch.active !== undefined)
        this.db.run('UPDATE services SET active = ? WHERE id = ?', [patch.active ? 1 : 0, id]);
    });
    return this.services();
  }

  removeService(id: string): ServiceView[] {
    this.db.run('DELETE FROM services WHERE id = ?', [id]);
    return this.services();
  }

  /* ---------------------------------------------------------------- entries */

  forItem(itemId: string): AvailabilityView[] {
    return this.db.all<Row>(`${SELECT} WHERE a.item_id = ? ORDER BY a.created_at`, [itemId]).map(view);
  }

  add(itemId: string, e: AvailabilityInput): AvailabilityView[] {
    if (!this.db.get('SELECT 1 FROM items WHERE id = ? AND deleted_at IS NULL', [itemId]))
      throw appError('NOT_FOUND', 'That item no longer exists.');
    if (
      (this.db.get<{ n: number }>('SELECT count(*) AS n FROM availability_entries WHERE item_id = ?', [
        itemId,
      ])?.n ?? 0) >= MAX_ENTRIES_PER_ITEM
    )
      throw appError('VALIDATION', `Up to ${MAX_ENTRIES_PER_ITEM} entries per item.`);
    if (e.serviceId && !this.db.get('SELECT 1 FROM services WHERE id = ?', [e.serviceId]))
      throw appError('NOT_FOUND', 'That service no longer exists.');
    const now = this.ctx.clock.now().toISOString();
    this.db.run(
      `INSERT INTO availability_entries (id, item_id, kind, service_id, platform, available_until, remind_days, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), itemId, e.kind, e.serviceId, e.platform, e.availableUntil, e.remindDays, e.notes, now, now],
    );
    return this.forItem(itemId);
  }

  update(id: string, e: AvailabilityInput): AvailabilityView[] {
    const row = this.db.get<{ item_id: string }>('SELECT item_id FROM availability_entries WHERE id = ?', [
      id,
    ]);
    if (!row) throw appError('NOT_FOUND', 'That entry no longer exists.');
    if (e.serviceId && !this.db.get('SELECT 1 FROM services WHERE id = ?', [e.serviceId]))
      throw appError('NOT_FOUND', 'That service no longer exists.');
    this.db.run(
      `UPDATE availability_entries SET kind = ?, service_id = ?, platform = ?, available_until = ?, remind_days = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      [
        e.kind,
        e.serviceId,
        e.platform,
        e.availableUntil,
        e.remindDays,
        e.notes,
        this.ctx.clock.now().toISOString(),
        id,
      ],
    );
    return this.forItem(row.item_id);
  }

  remove(id: string): AvailabilityView[] {
    const row = this.db.get<{ item_id: string }>('SELECT item_id FROM availability_entries WHERE id = ?', [
      id,
    ]);
    if (!row) throw appError('NOT_FOUND', 'That entry no longer exists.');
    this.db.run('DELETE FROM availability_entries WHERE id = ?', [id]);
    return this.forItem(row.item_id);
  }

  /** Unfinished items whose access ends within the window (or the entry's own reminder window). */
  leavingSoon(windowDays?: number): LeavingSoonView[] {
    const days = windowDays ?? readSettings(this.db).settings.availability.leavingSoonDays;
    const today = this.today();
    const until = addDays(today, 90);
    return this.db
      .all<Row & { title: string; type: string; status: string }>(
        `${SELECT.replace('SELECT a.*,', 'SELECT a.*, i.title, i.type, i.status,')}
           JOIN items i ON i.id = a.item_id
          WHERE i.deleted_at IS NULL AND i.status NOT IN ('completed', 'dropped')
            AND a.available_until IS NOT NULL AND a.available_until >= ? AND a.available_until <= ?
          ORDER BY a.available_until, i.title`,
        [today, until],
      )
      .map((r) => ({
        ...view(r),
        itemTitle: r.title,
        itemType: r.type,
        itemStatus: r.status,
        daysLeft: daysBetween(today, r.available_until ?? today),
      }))
      .filter((r) => r.daysLeft <= (r.remindDays ?? days));
  }

  /** Entries that should notify now and haven't yet (marks them as notified). */
  takeDueNotifications(): LeavingSoonView[] {
    const { settings } = readSettings(this.db);
    if (!settings.availability.notifications) return [];
    const due = this.leavingSoon().filter(
      (e) =>
        !this.db.get('SELECT 1 FROM availability_notifications WHERE entry_id = ? AND until = ?', [
          e.id,
          e.availableUntil,
        ]),
    );
    const now = this.ctx.clock.now().toISOString();
    this.db.transaction(() => {
      for (const e of due)
        this.db.run(
          'INSERT OR IGNORE INTO availability_notifications (entry_id, until, notified_at) VALUES (?, ?, ?)',
          [e.id, e.availableUntil, now],
        );
    });
    return due;
  }

  /** Item ids the user can access right now (owned, subscribed, borrowed…), for filters. */
  accessibleItemIds(): Set<string> {
    const ph = ACCESSIBLE_KINDS.map(() => '?').join(',');
    const today = this.today();
    return new Set(
      this.db
        .all<{ item_id: string }>(
          `SELECT DISTINCT a.item_id FROM availability_entries a LEFT JOIN services s ON s.id = a.service_id
            WHERE a.kind IN (${ph}) AND (a.available_until IS NULL OR a.available_until >= ?)
              AND (s.id IS NULL OR s.active = 1)`,
          [...ACCESSIBLE_KINDS, today],
        )
        .map((r) => r.item_id),
    );
  }
}

/**
 * Pile Health: stale-item nudges, snoozes and pile statistics. Never sends OS
 * notifications. Turning it off in Settings hides the panel and nudges (the
 * data model keeps working so turning it back on loses nothing).
 *
 * Snooze reasons:
 * - `pile-health` / `manual`: hidden from nudges AND from Pick for Me until the date.
 * - `keep`: the user said "Keep" — hidden from nudges only, for one threshold period.
 */
import type { MediaType, Status } from '../../shared/enums';
import { appError } from '../../shared/result';
import type { HealthOverview, HealthItemView, SnoozedItemView } from '../../shared/types';
import { addDays, addMonths } from '../../domain/calendar';
import { localDate } from '../../domain/dates';
import { pileStats, staleness, stalenessText, type HealthRow } from '../../domain/pile-health';
import { readSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import { LAST_ACTIVITY_SQL } from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';

export class PileHealthService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }
  today(): string {
    return localDate(this.ctx.clock.now());
  }

  rows(): HealthRow[] {
    return this.db
      .all<{
        id: string;
        type: MediaType;
        status: Status;
        date_added: string;
        date_started: string | null;
        date_completed: string | null;
        last_activity: string | null;
        until: string | null;
      }>(
        `SELECT i.id, i.type, i.status, i.date_added, i.date_started, i.date_completed,
                ${LAST_ACTIVITY_SQL} AS last_activity,
                z.until
         FROM items i LEFT JOIN item_snoozes z ON z.item_id = i.id
         WHERE i.deleted_at IS NULL`,
      )
      .map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        dateAdded: r.date_added,
        dateStarted: r.date_started,
        dateCompleted: r.date_completed,
        lastActivity: r.last_activity,
        snoozedUntil: r.until,
      }));
    // LAST_ACTIVITY_SQL falls back to start/added dates, which staleness() handles identically.
  }

  overview(limit = 50): HealthOverview {
    const { pileHealth } = readSettings(this.db).settings;
    const today = this.today();
    const rows = this.rows();
    const stale = rows
      .map((r) => ({ r, s: staleness(r, pileHealth, today) }))
      .filter((x): x is { r: HealthRow; s: NonNullable<typeof x.s> } => x.s !== null)
      .sort((a, b) => b.s.days - a.s.days || (a.r.id < b.r.id ? -1 : 1));
    const ids = stale.slice(0, limit).map((x) => x.r.id);
    const summaries = new Map(
      ids.length === 0
        ? []
        : items
            .summariesWhere(this.db, `i.id IN (${ids.map(() => '?').join(',')})`, ids, '')
            .map((s) => [s.id, s]),
    );
    const staleViews: HealthItemView[] = [];
    for (const x of stale.slice(0, limit)) {
      const s = summaries.get(x.r.id);
      if (s) staleViews.push({ ...s, reason: stalenessText(x.s), kind: x.s.kind, days: x.s.days });
    }
    const snoozed: SnoozedItemView[] = this.db
      .all<{ id: string; until: string; reason: SnoozedItemView['snoozeReason'] }>(
        `SELECT z.item_id AS id, z.until, z.reason FROM item_snoozes z JOIN items i ON i.id = z.item_id
         WHERE i.deleted_at IS NULL AND z.until >= ? AND z.reason <> 'keep' ORDER BY z.until LIMIT 100`,
        [today],
      )
      .flatMap((z) => {
        const s = items.summariesWhere(this.db, 'i.id = ?', [z.id], '')[0];
        return s ? [{ ...s, snoozedUntil: z.until, snoozeReason: z.reason }] : [];
      });
    return {
      enabled: pileHealth.enabled,
      thresholds: {
        plannedStaleMonths: pileHealth.plannedStaleMonths,
        inProgressStaleDays: pileHealth.inProgressStaleDays,
      },
      stale: staleViews,
      staleTotal: stale.length,
      snoozed,
      stats: pileStats(rows, today),
    };
  }

  snooze(ids: readonly string[], until: string, reason: 'pile-health' | 'manual' = 'pile-health'): number {
    const today = this.today();
    if (until < today)
      throw appError('VALIDATION', 'Choose a date from today onward.', {
        fieldErrors: { until: 'Choose a date from today onward.' },
      });
    const now = this.ctx.clock.now().toISOString();
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        if (!items.getItemRow(this.db, id)) continue;
        n += this.db.run(
          `INSERT INTO item_snoozes (item_id, until, reason, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(item_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_at = excluded.created_at`,
          [id, until, reason, now],
        ).changes;
      }
    });
    this.ctx.log.info('health.snooze', { count: n });
    return n;
  }

  unsnooze(ids: readonly string[]): number {
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) n += this.db.run('DELETE FROM item_snoozes WHERE item_id = ?', [id]).changes;
    });
    return n;
  }

  /** "Keep": stop nudging about this item for one more threshold period. Pick for Me still includes it. */
  keep(ids: readonly string[]): number {
    const { pileHealth } = readSettings(this.db).settings;
    const today = this.today();
    const now = this.ctx.clock.now().toISOString();
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        const row = items.getItemRow(this.db, id);
        if (!row) continue;
        const until =
          row.status === 'in_progress'
            ? addDays(today, pileHealth.inProgressStaleDays)
            : addMonths(today, pileHealth.plannedStaleMonths);
        n += this.db.run(
          `INSERT INTO item_snoozes (item_id, until, reason, created_at) VALUES (?, ?, 'keep', ?)
           ON CONFLICT(item_id) DO UPDATE SET until = excluded.until, reason = 'keep', created_at = excluded.created_at`,
          [id, until, now],
        ).changes;
      }
    });
    return n;
  }

  /** Removes expired snoozes (housekeeping at startup). */
  purgeExpired(): number {
    return this.db.run('DELETE FROM item_snoozes WHERE until < ?', [this.today()]).changes;
  }
}

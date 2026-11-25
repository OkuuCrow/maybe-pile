/**
 * Pile Health: gentle staleness detection and pile statistics. Pure functions
 * with an injected "today" so thresholds and snooze expiry are testable.
 */
import type { MediaType, Status } from '../shared/enums';
import { addDays, addMonths, daysBetween, median, monthEnd } from './calendar';

export interface HealthRow {
  id: string;
  type: MediaType;
  status: Status;
  dateAdded: string;
  dateStarted: string | null;
  dateCompleted: string | null;
  /** Local date of the latest progress entry / viewing / episode watch, or null. */
  lastActivity: string | null;
  /** Snooze end date (inclusive), or null. */
  snoozedUntil: string | null;
}

export interface HealthThresholds {
  plannedStaleMonths: number;
  inProgressStaleDays: number;
}

export type Staleness =
  | { kind: 'planned-old'; days: number; since: string }
  | { kind: 'in-progress-idle'; days: number; since: string };

/** A snooze hides an item through its `until` date and expires the day after. */
export function isSnoozed(until: string | null, today: string): boolean {
  return until !== null && until >= today;
}

export function staleness(r: HealthRow, t: HealthThresholds, today: string): Staleness | null {
  if (isSnoozed(r.snoozedUntil, today)) return null;
  if (r.status === 'planned') {
    const cutoff = addMonths(today, -t.plannedStaleMonths);
    if (r.dateAdded <= cutoff)
      return { kind: 'planned-old', days: daysBetween(r.dateAdded, today), since: r.dateAdded };
    return null;
  }
  if (r.status === 'in_progress') {
    const since = r.lastActivity ?? r.dateStarted ?? r.dateAdded;
    const days = daysBetween(since, today);
    if (days >= t.inProgressStaleDays) return { kind: 'in-progress-idle', days, since };
  }
  return null;
}

export function stalenessText(s: Staleness): string {
  const span =
    s.days >= 730
      ? `${Math.floor(s.days / 365.25)} years`
      : s.days >= 60
        ? `${Math.floor(s.days / 30.44)} months`
        : `${s.days} days`;
  return s.kind === 'planned-old' ? `Planned for ${span}` : `No progress for ${span}`;
}

/** Statuses that count as "on the pile". */
export const PILE_STATUSES: readonly Status[] = ['planned', 'in_progress', 'on_hold'];

export interface PileStats {
  sizeByType: Record<MediaType, number>;
  total: number;
  plannedCount: number;
  /** Median age in days of Planned items, or null when there are none. */
  medianPlannedAgeDays: number | null;
  windows: { days: 30 | 90; added: number; completed: number }[];
  /** Month-end pile size for the last 12 months, oldest first. */
  trend: { month: string; size: number }[];
  /** True when there's too little data for the trend to mean much (fewer than 5 items ever). */
  smallSample: boolean;
}

/**
 * Pile size at a month end = items added on or before that day that were not
 * completed by then and are not currently Dropped. (Drop dates are not
 * recorded, so a dropped item leaves the whole series — a documented
 * approximation.)
 */
export function pileStats(rows: readonly HealthRow[], today: string): PileStats {
  const sizeByType: Record<MediaType, number> = { movie: 0, tv: 0, game: 0, book: 0, anime: 0 };
  let total = 0;
  const plannedAges: number[] = [];
  for (const r of rows) {
    if (PILE_STATUSES.includes(r.status)) {
      sizeByType[r.type]++;
      total++;
    }
    if (r.status === 'planned') plannedAges.push(Math.max(0, daysBetween(r.dateAdded, today)));
  }
  const windows = ([30, 90] as const).map((days) => {
    const from = addDays(today, -days);
    return {
      days,
      added: rows.filter((r) => r.dateAdded > from && r.dateAdded <= today).length,
      completed: rows.filter(
        (r) =>
          r.status === 'completed' &&
          r.dateCompleted !== null &&
          r.dateCompleted > from &&
          r.dateCompleted <= today,
      ).length,
    };
  });
  const trend: { month: string; size: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const end = i === 0 ? today : monthEnd(addMonths(today, -i));
    const size = rows.filter(
      (r) =>
        r.status !== 'dropped' &&
        r.dateAdded <= end &&
        !(r.status === 'completed' && r.dateCompleted !== null && r.dateCompleted <= end),
    ).length;
    trend.push({ month: end.slice(0, 7), size });
  }
  const m = median(plannedAges);
  return {
    sizeByType,
    total,
    plannedCount: plannedAges.length,
    medianPlannedAgeDays: m === null ? null : Math.round(m),
    windows,
    trend,
    smallSample: rows.length < 5,
  };
}

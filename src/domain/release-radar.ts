/**
 * Release Radar: which partial release dates are still upcoming, how precise
 * they are, and when to fire "today / tomorrow" notifications. Pure.
 */
import { addDays, daysBetween } from './calendar';

export type Precision = 'year' | 'month' | 'day';

export function precisionOf(partial: string): Precision {
  return partial.length === 4 ? 'year' : partial.length === 7 ? 'month' : 'day';
}

/** Earliest and latest calendar days a partial date can refer to. */
export function dateSpan(partial: string): { first: string; last: string } {
  const p = precisionOf(partial);
  if (p === 'day') return { first: partial, last: partial };
  if (p === 'month') {
    const [y, m] = partial.split('-').map(Number);
    const last = new Date(Date.UTC(y ?? 0, m ?? 1, 0)).toISOString().slice(0, 10);
    return { first: `${partial}-01`, last };
  }
  return { first: `${partial}-01-01`, last: `${partial}-12-31` };
}

/** Upcoming when the release could still be today or later. */
export function isUpcoming(partial: string | null, today: string): boolean {
  if (!partial) return false;
  return dateSpan(partial).last >= today;
}

export function relativeLabel(partial: string, today: string): string {
  const p = precisionOf(partial);
  const { first, last } = dateSpan(partial);
  if (p === 'day') {
    const d = daysBetween(today, first);
    if (d === 0) return 'today';
    if (d === 1) return 'tomorrow';
    if (d < 14) return `in ${d} days`;
    if (d < 60) return `in ${Math.round(d / 7)} weeks`;
    if (d < 730) return `in ${Math.round(d / 30.44)} months`;
    return `in ${Math.round(d / 365.25)} years`;
  }
  if (first <= today && today <= last) return p === 'month' ? 'sometime this month' : 'sometime this year';
  if (p === 'month') {
    const months = Math.round(daysBetween(today, first) / 30.44);
    return months <= 1 ? 'next month' : `in about ${months} months`;
  }
  return `in ${partial}`;
}

export const PRECISION_LABELS: Record<Precision, string> = {
  day: 'Exact date',
  month: 'Month only',
  year: 'Year only',
};

/** Notification due for a release, or null. Only exact dates can notify. */
export function notificationKind(partial: string | null, today: string): 'today' | 'tomorrow' | null {
  if (!partial || precisionOf(partial) !== 'day') return null;
  if (partial === today) return 'today';
  if (partial === addDays(today, 1)) return 'tomorrow';
  return null;
}

/** Sort key: earliest possible day, then precision (exact dates first). */
export function radarSortKey(partial: string): string {
  const order: Record<Precision, number> = { day: 0, month: 1, year: 2 };
  return `${dateSpan(partial).first}:${order[precisionOf(partial)]}`;
}

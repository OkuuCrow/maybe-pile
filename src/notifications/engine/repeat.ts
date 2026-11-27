/**
 * Custom reminder repeat rules — structured fields only (never cron strings or
 * expressions that get evaluated). Occurrences advance from the *scheduled*
 * time, not from when a notification was delivered: a reminder delivered late
 * (or snoozed) does not shift the series.
 */
import { addDays, daysBetween, localDateString, weekdayOf, zonedToUtc } from './time';
import type { RepeatRule } from './types';

export const MAX_INTERVAL = { daily: 30, weekly: 30, monthly: 12, weekdays: 1 } as const;

export function validateRule(rule: RepeatRule): string | null {
  if (!['daily', 'weekly', 'monthly', 'weekdays'].includes(rule.freq)) return 'Unknown repeat frequency.';
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL[rule.freq])
    return 'Repeat interval is out of range.';
  if (rule.freq === 'weekdays') {
    if (rule.weekdays.length === 0 || rule.weekdays.length > 7) return 'Choose at least one day.';
    if (rule.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Invalid weekday.';
    if (new Set(rule.weekdays).size !== rule.weekdays.length) return 'Duplicate weekday.';
  } else if (rule.weekdays.length !== 0) return 'Weekdays only apply to "on these days".';
  return null;
}

function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whether `date` (local YYYY-MM-DD) is an occurrence date of the rule anchored at `anchorDate`. */
export function matchesRule(rule: RepeatRule, anchorDate: string, date: string): boolean {
  if (date < anchorDate) return false;
  const days = daysBetween(anchorDate, date);
  switch (rule.freq) {
    case 'daily':
      return days % rule.interval === 0;
    case 'weekly':
      return days % 7 === 0 && (days / 7) % rule.interval === 0;
    case 'weekdays':
      return rule.weekdays.includes(weekdayOf(date));
    case 'monthly': {
      const months = monthsBetween(anchorDate, date);
      if (months % rule.interval !== 0) return false;
      const [y, m, d] = date.split('-').map(Number) as [number, number, number];
      const anchorDay = Number(anchorDate.slice(8, 10));
      // Anchors on the 29th–31st fall back to the month's last day in shorter months.
      return d === Math.min(anchorDay, daysInMonth(y, m));
    }
  }
}

/**
 * Occurrences of a repeating reminder within (from, to], as UTC instants,
 * evaluating `localTime` in the given zone (DST-safe). Bounded scan.
 */
export function occurrencesBetween(
  rule: RepeatRule,
  anchorDate: string,
  localTime: string,
  from: Date,
  to: Date,
  tz: string,
): Date[] {
  const out: Date[] = [];
  const startDate = addDays(localDateString(from, tz), -1);
  const endDate = addDays(localDateString(to, tz), 1);
  const span = Math.min(400, Math.max(0, daysBetween(startDate, endDate)));
  for (let i = 0; i <= span; i++) {
    const date = addDays(startDate, i);
    if (!matchesRule(rule, anchorDate, date)) continue;
    const at = zonedToUtc(date, localTime, tz);
    if (at.getTime() > from.getTime() && at.getTime() <= to.getTime()) out.push(at);
  }
  return out;
}

/** Next occurrence strictly after `after` (for "next fire time" in Settings), scanning ≤ 400 days. */
export function nextOccurrence(
  rule: RepeatRule,
  anchorDate: string,
  localTime: string,
  after: Date,
  tz: string,
): Date | null {
  const start =
    localDateString(after, tz) < anchorDate ? anchorDate : addDays(localDateString(after, tz), -1);
  for (let i = 0; i <= 400; i++) {
    const date = addDays(start, i);
    if (!matchesRule(rule, anchorDate, date)) continue;
    const at = zonedToUtc(date, localTime, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

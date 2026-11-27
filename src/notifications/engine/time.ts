/**
 * Time-zone aware helpers for the reminder engine. Pure; no Date.now(), the
 * clock is always passed in. Uses only Intl (no tz database dependency).
 *
 * Policy (docs/notifications.md):
 * - Instants are stored in UTC; schedules ("18:00") are evaluated in the user's
 *   *current* zone, so travelling re-anchors schedules to local time.
 * - Nonexistent local times (spring-forward gap) shift forward by the gap
 *   (02:30 → 03:30). Ambiguous local times (fall-back overlap) resolve to the
 *   first occurrence.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone to evaluate schedules in: configured zone if valid, else the OS zone, else UTC. */
export function resolveTimeZone(configured: string | null, osZone?: string): string {
  if (configured && isValidTimeZone(configured)) return configured;
  const os = osZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return os && isValidTimeZone(os) ? os : 'UTC';
}

export function localParts(d: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Offset (local − UTC) in minutes at instant `d`. */
export function offsetMinutes(d: Date, tz: string): number {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const floored = Math.floor(d.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - floored) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localDateString(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number) as [number, number, number];
  const pb = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000);
}

export function parseHhmm(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

/**
 * Local wall time → UTC instant (DST-safe, see module doc).
 * `date` is YYYY-MM-DD, `hhmm` is HH:MM.
 */
export function zonedToUtc(date: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const { h, m } = parseHhmm(hhmm);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const before = offsetMinutes(new Date(guess - 24 * 3_600_000), tz);
  const after = offsetMinutes(new Date(guess + 24 * 3_600_000), tz);
  const candidates = [...new Set([guess - before * 60_000, guess - after * 60_000])].sort((a, b) => a - b);
  const matches = candidates.filter((t) => {
    const p = localParts(new Date(t), tz);
    return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === m;
  });
  if (matches.length > 0) return new Date(matches[0] as number); // ambiguous → first occurrence
  // Nonexistent (spring-forward gap): use the pre-transition offset, which lands after the gap.
  return new Date(guess - before * 60_000);
}

/**
 * Most recent scheduled instant ≤ now for a daily/weekly local-time schedule,
 * or null if none in the last 8 days (cannot happen for valid input).
 */
export function lastOccurrence(
  now: Date,
  tz: string,
  hhmm: string,
  frequency: 'daily' | 'weekly',
  weekday: number,
): { at: Date; date: string } | null {
  const today = localDateString(now, tz);
  for (let i = 0; i <= 8; i++) {
    const date = addDays(today, -i);
    if (frequency === 'weekly' && weekdayOf(date) !== weekday) continue;
    const at = zonedToUtc(date, hhmm, tz);
    if (at.getTime() <= now.getTime()) return { at, date };
  }
  return null;
}

export interface QuietConfig {
  enabled: boolean;
  start: string;
  end: string;
  days: readonly number[];
}

/**
 * If `at` falls inside quiet time (quiet hours, or a weekday on which
 * notifications are not allowed), returns the instant quiet time ends;
 * otherwise null. Chained windows (quiet hours ending on a disallowed day)
 * are followed.
 */
export function quietUntil(
  at: Date,
  quiet: QuietConfig,
  allowedDays: readonly number[],
  tz: string,
): Date | null {
  let t = at;
  let moved = false;
  for (let guard = 0; guard < 10; guard++) {
    const next = quietStep(t, quiet, allowedDays, tz);
    if (!next) break;
    t = next;
    moved = true;
  }
  return moved ? t : null;
}

function quietStep(at: Date, quiet: QuietConfig, allowedDays: readonly number[], tz: string): Date | null {
  const today = localDateString(at, tz);
  if (allowedDays.length > 0 && allowedDays.length < 7 && !allowedDays.includes(weekdayOf(today))) {
    let d = addDays(today, 1);
    for (let i = 0; i < 7 && !allowedDays.includes(weekdayOf(d)); i++) d = addDays(d, 1);
    return zonedToUtc(d, '00:00', tz);
  }
  if (!quiet.enabled || quiet.start === quiet.end) return null;
  const spansMidnight = quiet.end <= quiet.start;
  for (const startDay of [addDays(today, -1), today]) {
    if (!quiet.days.includes(weekdayOf(startDay))) continue;
    const s = zonedToUtc(startDay, quiet.start, tz);
    const e = zonedToUtc(spansMidnight ? addDays(startDay, 1) : startDay, quiet.end, tz);
    if (at.getTime() >= s.getTime() && at.getTime() < e.getTime()) return e;
  }
  return null;
}

/** Start of the local day containing `now`, as a UTC instant (for "today" caps). */
export function startOfLocalDay(now: Date, tz: string): Date {
  return zonedToUtc(localDateString(now, tz), '00:00', tz);
}

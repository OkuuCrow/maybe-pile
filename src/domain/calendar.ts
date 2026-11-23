/**
 * Calendar-date arithmetic on "YYYY-MM-DD" strings (no time zone involved),
 * plus conversion of UTC instants to a local calendar date in a given zone.
 *
 * Boundary rule used by Stats, Goals and Release Radar: personal dates
 * (added/started/completed) are already local calendar dates and are used as
 * is; history instants (progress entries, episode watches, viewings) are UTC
 * and are converted to the user's local calendar date first. Years and months
 * are then taken from the local date.
 */

const DAY_MS = 86_400_000;

function toUtcMs(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function addMonths(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const d = Number(date.slice(8, 10));
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromUtcMs(Date.UTC(ty, tm, Math.min(d, last)));
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function monthEnd(date: string): string {
  return addDays(addMonths(monthStart(date), 1), -1);
}

/** Formatter cache: building an Intl.DateTimeFormat is expensive, and stats convert 100k+ instants. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    FORMATTERS.set(key, f);
  }
  return f;
}

/** Local calendar date of a UTC instant in `timeZone` (IANA name), or the process zone when omitted. */
export function instantToLocalDate(iso: string, timeZone?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = formatterFor(timeZone).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Median of a numeric list, or null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * Date helpers. Two representations are used throughout the app:
 *
 * - Partial dates for release/air/publication dates: "YYYY", "YYYY-MM" or
 *   "YYYY-MM-DD". Providers and users often know only the year.
 * - Calendar dates for personal dates (added/started/completed): "YYYY-MM-DD"
 *   in the user's local calendar. They are dates, not instants, so they are
 *   never converted between time zones.
 *
 * Timestamps (created/updated/occurred) are ISO-8601 UTC strings.
 */

const PARTIAL_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidPartialDate(value: string): boolean {
  const m = PARTIAL_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < 1000 || year > 9999) return false;
  if (m[2] === undefined) return true;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const day = Number(m[3]);
  return day >= 1 && day <= daysInMonth(year, month);
}

export function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && isValidPartialDate(value);
}

export function yearOf(partial: string | null | undefined): number | null {
  if (!partial) return null;
  const m = PARTIAL_RE.exec(partial);
  return m ? Number(m[1]) : null;
}

/** Local calendar date for `now`, as YYYY-MM-DD. */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * Normalizes loosely formatted provider dates ("2010-07-16", "July 16, 2010",
 * "2010", "Jul 2010") into a partial date, or null if it cannot be done safely.
 */
export function toPartialDate(input: unknown): string | null {
  if (typeof input === 'number' && Number.isInteger(input) && input >= 1000 && input <= 9999) {
    return String(input);
  }
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s === '') return null;
  const iso = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(s);
  if (iso) {
    const parts = [iso[1]];
    if (iso[2]) parts.push(iso[2].padStart(2, '0'));
    if (iso[2] && iso[3]) parts.push(iso[3].padStart(2, '0'));
    const candidate = parts.join('-');
    if (isValidPartialDate(candidate)) return candidate;
    return isValidPartialDate(parts[0] ?? '') ? (parts[0] ?? null) : null;
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /^(?:(\d{1,2})\s+)?([A-Za-z]{3,})\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})$/.exec(s);
  if (named) {
    const monthIdx = months.indexOf((named[2] ?? '').slice(0, 3).toLowerCase());
    const year = named[4] ?? '';
    if (monthIdx === -1) return isValidPartialDate(year) ? year : null;
    const month = String(monthIdx + 1).padStart(2, '0');
    const day = named[1] ?? named[3];
    const candidate = day ? `${year}-${month}-${day.padStart(2, '0')}` : `${year}-${month}`;
    return isValidPartialDate(candidate) ? candidate : `${year}-${month}`;
  }
  const yearOnly = /\b(\d{4})\b/.exec(s);
  if (yearOnly?.[1] && isValidPartialDate(yearOnly[1])) return yearOnly[1];
  return null;
}

/** Monday (UTC) of the ISO week containing the given instant, as YYYY-MM-DD. */
export function weekStartUtc(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

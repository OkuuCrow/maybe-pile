/**
 * Pile Value: money spent on the backlog. Amounts are integer minor units
 * (cents) with an ISO 4217 code. There is no currency conversion and no
 * network exchange-rate lookup: totals are always per currency.
 */

/** Minor-unit exponent per currency (ISO 4217). Unknown codes default to 2. */
const EXPONENTS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  HUF: 2,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

export function currencyExponent(code: string): number {
  return EXPONENTS[code] ?? 2;
}

/** Parses a user-typed amount ("12.99", "1,299.50", "1200") into minor units. Null if invalid. */
export function parseAmount(text: string, currency: string): number | null {
  const t = text.trim().replace(/[\s,_]/g, '');
  if (!/^\d{1,12}(?:\.\d{0,3})?$/.test(t)) return null;
  const exp = currencyExponent(currency);
  const [whole, frac = ''] = t.split('.');
  if (frac.length > exp) return null;
  const minor = Number(whole) * 10 ** exp + Number((frac + '000').slice(0, exp) || '0');
  return Number.isSafeInteger(minor) && minor <= 100_000_000_000 ? minor : null;
}

/** Formats minor units for display using the locale (no conversion). */
export function formatMoney(minor: number, currency: string, locale?: string): string {
  const exp = currencyExponent(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    }).format(minor / 10 ** exp);
  } catch {
    return `${(minor / 10 ** exp).toFixed(exp)} ${currency}`;
  }
}

export interface ValueRow {
  itemId: string;
  status: string;
  amountMinor: number;
  currency: string;
  hours: number | null;
}

export interface CurrencyTotals {
  currency: string;
  spentMinor: number;
  /** Planned / in progress / on hold — bought but not finished. */
  unfinishedMinor: number;
  /** Never started (planned). */
  untouchedMinor: number;
  items: number;
  /** Cost per hour over items with recorded hours, or null. */
  costPerHourMinor: number | null;
}

export function summarizeValue(rows: ValueRow[]): CurrencyTotals[] {
  const by = new Map<string, CurrencyTotals & { hours: number; hoursSpend: number; ids: Set<string> }>();
  for (const r of rows) {
    let t = by.get(r.currency);
    if (!t) {
      t = {
        currency: r.currency,
        spentMinor: 0,
        unfinishedMinor: 0,
        untouchedMinor: 0,
        items: 0,
        costPerHourMinor: null,
        hours: 0,
        hoursSpend: 0,
        ids: new Set(),
      };
      by.set(r.currency, t);
    }
    t.spentMinor += r.amountMinor;
    if (r.status === 'planned' || r.status === 'in_progress' || r.status === 'on_hold')
      t.unfinishedMinor += r.amountMinor;
    if (r.status === 'planned') t.untouchedMinor += r.amountMinor;
    t.ids.add(r.itemId);
    if (r.hours !== null && r.hours > 0) {
      t.hours += r.hours;
      t.hoursSpend += r.amountMinor;
    }
  }
  return [...by.values()]
    .map(({ hours, hoursSpend, ids, ...t }) => ({
      ...t,
      items: ids.size,
      costPerHourMinor: hours > 0 ? Math.round(hoursSpend / hours) : null,
    }))
    .sort((a, b) => b.spentMinor - a.spentMinor);
}

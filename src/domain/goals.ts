/**
 * Goals: period boundaries and pace. Pure, with an injected "today".
 *
 * Pace formula (shown to the user verbatim):
 *   elapsed   = days from start through today (inclusive), clamped to the period
 *   expected  = target × elapsed ÷ total days in the period
 *   tolerance = max(1 unit, 10% of expected)
 *   ahead     when progress ≥ expected + tolerance
 *   behind    when progress <  expected − tolerance
 *   on pace   otherwise
 */
import { addDays, daysBetween, monthEnd, monthStart } from './calendar';

export type GoalPeriod = 'year' | 'month' | 'custom';
export type GoalMetric = 'items' | 'pages' | 'episodes' | 'hours';

export function periodRange(
  period: GoalPeriod,
  anchor: string,
  custom?: { start: string; end: string },
): { start: string; end: string } {
  if (period === 'year') return { start: `${anchor.slice(0, 4)}-01-01`, end: `${anchor.slice(0, 4)}-12-31` };
  if (period === 'month') return { start: monthStart(anchor), end: monthEnd(anchor) };
  if (!custom) throw new Error('custom period needs a range');
  return custom;
}

export type PaceStatus = 'done' | 'ahead' | 'on-pace' | 'behind' | 'not-started' | 'ended-short';

export interface Pace {
  status: PaceStatus;
  label: string;
  expected: number;
  elapsedDays: number;
  totalDays: number;
  math: string;
}

export const PACE_LABELS: Record<PaceStatus, string> = {
  done: 'Goal reached',
  ahead: 'Ahead of pace',
  'on-pace': 'On pace',
  behind: 'Behind pace',
  'not-started': 'Not started yet',
  'ended-short': 'Period ended',
};

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

export function pace(progress: number, target: number, start: string, end: string, today: string): Pace {
  const totalDays = daysBetween(start, end) + 1;
  const elapsedDays = Math.min(totalDays, Math.max(0, daysBetween(start, today) + 1));
  const expected = (target * elapsedDays) / totalDays;
  const math = `${fmt(progress)} of ${target} done · expected by today: ${target} × ${elapsedDays}/${totalDays} days = ${fmt(expected)}`;
  let status: PaceStatus;
  if (progress >= target) status = 'done';
  else if (today < start) status = 'not-started';
  else if (today > end) status = 'ended-short';
  else {
    const tol = Math.max(1, expected * 0.1);
    status = progress >= expected + tol ? 'ahead' : progress < expected - tol ? 'behind' : 'on-pace';
  }
  return { status, label: PACE_LABELS[status], expected, elapsedDays, totalDays, math };
}

/** "Remaining per week" hint, or null when done or the period is over. */
export function neededPerWeek(progress: number, target: number, end: string, today: string): number | null {
  if (progress >= target || today > end) return null;
  const days = Math.max(1, daysBetween(today, addDays(end, 1)));
  return Math.round(((target - progress) / days) * 7 * 10) / 10;
}

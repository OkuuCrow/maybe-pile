/**
 * Session timer math. A timer's state lives in the database (not memory), so
 * it survives restarts and crashes: elapsed = accumulated + (now − segment start)
 * while running. Clock skew (now before the segment start) counts as zero.
 *
 * Hours source of truth (per item, `item_prefs.hours_source`):
 *  - 'manual'   — the hours field the user types is authoritative (default; matches 1.x).
 *  - 'sessions' — hours = sum of finished sessions; the field becomes read-only.
 *  - 'steam'    — hours come from Steam playtime imports; sessions are kept as a log.
 * Sessions never silently overwrite manual hours.
 */
export const MAX_SESSION_SECONDS = 30 * 24 * 3600;

export interface TimerState {
  state: 'running' | 'paused' | 'done';
  accumulatedSeconds: number;
  segmentStartedAt: string | null;
}

export function elapsedSeconds(t: TimerState, nowMs: number): number {
  let live = 0;
  if (t.state === 'running' && t.segmentStartedAt) {
    const start = Date.parse(t.segmentStartedAt);
    if (Number.isFinite(start)) live = Math.max(0, Math.floor((nowMs - start) / 1000));
  }
  return Math.min(MAX_SESSION_SECONDS, t.accumulatedSeconds + live);
}

/** A session longer than `maxHours` (e.g. a timer left running overnight) needs review. */
export function needsReview(seconds: number, maxHours: number): boolean {
  return seconds > maxHours * 3600;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export function hoursFromSeconds(total: number): number {
  return Math.round((total / 3600) * 10) / 10;
}

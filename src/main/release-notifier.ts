/**
 * Release Radar local notifications (opt-in, off by default).
 *
 * Runs only while Maybe Pile is open: checks at start-up and then hourly.
 * There is no background service or login item, so nothing fires while the
 * app is closed (documented in docs/features/release-radar.md).
 */
import type { DueNotification } from './services/release-radar-service';

export interface NotifierDeps {
  due(): DueNotification[];
  notify(n: DueNotification): void;
  isSupported(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const CHECK_EVERY_MS = 60 * 60 * 1000;

export function startReleaseNotifier(d: NotifierDeps): { check: () => number; stop: () => void } {
  const check = (): number => {
    if (!d.isSupported()) return 0;
    let n = 0;
    for (const item of d.due()) {
      d.notify(item);
      n++;
    }
    return n;
  };
  check();
  const handle = d.setInterval(check, CHECK_EVERY_MS);
  return { check, stop: () => d.clearInterval(handle) };
}

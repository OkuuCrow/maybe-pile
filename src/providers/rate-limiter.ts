/**
 * Sliding-window rate limiter shared by all requests to one provider.
 *
 * - At most `maxRequests` per `perMs` window. When full, waits for a free slot
 *   if the wait is short (≤ maxWaitMs), otherwise reports "rate limited" so the
 *   UI can tell the user instead of hanging.
 * - After a 429, `blockFor(seconds)` blocks all requests until Retry-After passes.
 * Clock and sleep are injectable for deterministic tests.
 */
export interface LimiterOptions {
  maxRequests: number;
  perMs: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type Slot = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly stamps: number[] = [];
  private blockedUntil = 0;
  private readonly maxWaitMs: number;
  readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes acquisitions so concurrent callers don't overshoot. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LimiterOptions) {
    this.maxWaitMs = opts.maxWaitMs ?? 8_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  acquire(): Promise<Slot> {
    const run = this.queue.then(() => this.acquireInner());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async acquireInner(): Promise<Slot> {
    for (;;) {
      const now = this.now();
      if (this.blockedUntil > now) {
        return { ok: false, retryAfterSeconds: Math.ceil((this.blockedUntil - now) / 1000) };
      }
      while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= now - this.opts.perMs) this.stamps.shift();
      if (this.stamps.length < this.opts.maxRequests) {
        this.stamps.push(now);
        return { ok: true };
      }
      const wait = (this.stamps[0] ?? now) + this.opts.perMs - now;
      if (wait > this.maxWaitMs) return { ok: false, retryAfterSeconds: Math.ceil(wait / 1000) };
      await this.sleep(wait);
    }
  }

  blockFor(seconds: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1000);
  }

  get isBlocked(): boolean {
    return this.blockedUntil > this.now();
  }
}

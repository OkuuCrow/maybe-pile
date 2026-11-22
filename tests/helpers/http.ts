import type { HttpClient, HttpRequest, HttpResponse } from '../../src/providers/http';
import { HttpFailure } from '../../src/providers/http';
import { RateLimiter } from '../../src/providers/rate-limiter';

export type Route = (req: HttpRequest) => HttpResponse | HttpFailure | Promise<HttpResponse | HttpFailure>;

/** Deterministic fake HTTP client. Routes match by URL substring; unmatched URLs fail loudly. */
export class FakeHttp implements HttpClient {
  readonly calls: HttpRequest[] = [];
  constructor(private readonly routes: [string | RegExp, Route][] = []) {}

  on(match: string | RegExp, route: Route): this {
    this.routes.unshift([match, route]);
    return this;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    for (const [m, r] of this.routes) {
      if (typeof m === 'string' ? req.url.includes(m) : m.test(req.url)) {
        const out = await r(req);
        if (out instanceof HttpFailure) throw out;
        return out;
      }
    }
    throw new Error(`FakeHttp: no route for ${req.url}`);
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

export const raw = (text: string, status = 200, contentType = 'application/json'): HttpResponse => ({
  status,
  headers: { 'content-type': contentType },
  body: new TextEncoder().encode(text),
});

/** A 1x1 PNG. */
export const PNG_1PX = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

export const image = (bytes: Uint8Array = PNG_1PX, ct = 'image/png'): HttpResponse => ({
  status: 200,
  headers: { 'content-type': ct },
  body: bytes,
});

/** Limiter that never waits (fake clock) – tests stay instant and deterministic. */
export function instantLimiter(max = 1000): RateLimiter {
  let t = 1_000_000;
  return new RateLimiter({
    maxRequests: max,
    perMs: 1000,
    now: () => t,
    sleep: async (ms) => void (t += ms),
  });
}

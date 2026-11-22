/**
 * The single HTTP entry point for all outbound requests. Everything network
 * related goes through an injected `HttpClient` so tests supply fakes and
 * never touch live services.
 *
 * The production client (in main) uses Electron's `net.fetch` (respects system
 * proxy settings); scripts use global `fetch`. Both enforce a per-request
 * timeout, an abort signal and a response-size cap.
 */
import type { z } from 'zod';
import type { RateLimiter } from './rate-limiter';
import type { ProviderResult } from './types';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type HttpFailureKind = 'network' | 'timeout' | 'too-large' | 'aborted';

export class HttpFailure extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'follow' | 'error';
  },
) => Promise<Response>;

export const USER_AGENT = 'MaybePile/1.0 (desktop media backlog; +https://github.com/maybe-pile/maybe-pile)';

/** Creates a client over a fetch implementation (global fetch or Electron net.fetch). */
export function createFetchClient(fetchImpl: FetchLike): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), req.timeoutMs);
      const onAbort = () => controller.abort(new Error('aborted'));
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let res: Response;
        try {
          res = await fetchImpl(req.url, {
            method: req.method ?? 'GET',
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...req.headers },
            ...(req.body !== undefined ? { body: req.body } : {}),
            signal: controller.signal,
            redirect: 'follow',
          });
        } catch (e) {
          if (controller.signal.aborted) {
            const reason = controller.signal.reason as Error | undefined;
            throw new HttpFailure(
              reason?.message === 'timeout' ? 'timeout' : 'aborted',
              'Request did not complete.',
            );
          }
          throw new HttpFailure('network', e instanceof Error ? e.message : 'Network error');
        }
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > req.maxBytes) throw new HttpFailure('too-large', 'Response too large.');
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const chunk = await reader.read().catch(() => {
              if (controller.signal.aborted) throw new HttpFailure('timeout', 'Response timed out.');
              throw new HttpFailure('network', 'Connection interrupted.');
            });
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > req.maxBytes) {
              await reader.cancel();
              throw new HttpFailure('too-large', 'Response too large.');
            }
            chunks.push(chunk.value);
          }
        }
        const body = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          body.set(c, off);
          off += c.byteLength;
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        return { status: res.status, headers, body };
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Parses Retry-After (delta-seconds or HTTP-date). Defaults to 10s, capped at 1 hour. */
export function parseRetryAfter(value: string | undefined, now: number): number {
  if (!value) return 10;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(3600, Math.ceil(secs));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(3600, Math.max(1, Math.ceil((date - now) / 1000)));
  return 10;
}

export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024;

export interface JsonRequestOptions extends Omit<HttpRequest, 'timeoutMs' | 'maxBytes'> {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Performs a rate-limited JSON request and validates the body against `schema`.
 * Maps every failure mode to a `ProviderResult` variant; never throws for
 * expected failures.
 */
export async function requestJson<S extends z.ZodType>(
  http: HttpClient,
  limiter: RateLimiter,
  opts: JsonRequestOptions,
  schema: S,
): Promise<ProviderResult<z.infer<S>>> {
  const slot = await limiter.acquire();
  if (!slot.ok) return { kind: 'rateLimited', retryAfterSeconds: slot.retryAfterSeconds };
  let res: HttpResponse;
  try {
    res = await http.request({
      ...opts,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES,
    });
  } catch (e) {
    if (e instanceof HttpFailure) {
      if (e.kind === 'timeout') return { kind: 'timeout' };
      if (e.kind === 'too-large')
        return { kind: 'malformedResponse', detail: 'Response exceeded the size limit.' };
      if (e.kind === 'aborted') return { kind: 'networkError', detail: 'Cancelled.' };
      return { kind: 'networkError', detail: 'Could not reach the service.' };
    }
    throw e;
  }
  if (res.status === 429) {
    const retry = parseRetryAfter(res.headers['retry-after'], limiter.now());
    limiter.blockFor(retry);
    return { kind: 'rateLimited', retryAfterSeconds: retry };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
  if (res.status === 404) return { kind: 'notFound' };
  if (res.status >= 500) return { kind: 'unavailable', status: res.status };
  if (res.status < 200 || res.status >= 300) return { kind: 'unavailable', status: res.status };
  const ct = res.headers['content-type'] ?? '';
  if (!/\bjson\b/i.test(ct)) return { kind: 'malformedResponse', detail: 'Unexpected content type.' };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(res.body));
  } catch {
    return { kind: 'malformedResponse', detail: 'Invalid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { kind: 'malformedResponse', detail: 'Unexpected response structure.' };
  return { kind: 'ok', value: parsed.data };
}

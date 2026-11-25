/**
 * Electron adapter for the shared HTTP client (src/providers/http.ts).
 *
 * - Normal requests use `net.fetch` (system proxy settings, Chromium stack).
 * - `redirect: 'manual'` requests (all image fetches) use `net.request`,
 *   because Electron's `net.fetch` does not expose a manual redirect response:
 *   it rejects with "Redirect was cancelled" (verified in the e2e suite,
 *   tests/e2e/pack2.spec.ts). On the `redirect` event we abort and hand a
 *   synthetic 3xx response (status + Location) back to the shared client,
 *   which validates the next hop against the allowlist and decides whether
 *   to continue. The body is streamed so the client's size cap still applies.
 */
import type { net as ElectronNet } from 'electron';

type Init = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  redirect: 'follow' | 'error' | 'manual';
};

export function createElectronFetch(net: typeof ElectronNet) {
  return (url: string, init: Init): Promise<Response> => {
    if (init.redirect !== 'manual') return net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const req = net.request({ url, method: init.method, redirect: 'manual' });
      for (const [k, v] of Object.entries(init.headers)) req.setHeader(k, v);
      const onAbort = () => {
        req.abort();
        done(() => reject(new Error('aborted')));
      };
      if (init.signal.aborted) return onAbort();
      init.signal.addEventListener('abort', onAbort, { once: true });
      req.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
        req.abort();
        done(() => resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } })));
      });
      req.on('response', (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) headers.append(k, x);
          else if (typeof v === 'string') headers.set(k, v);
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on('end', () => controller.close());
            res.on('error', (e: Error) => controller.error(e));
          },
          cancel() {
            req.abort();
          },
        });
        const status = res.statusCode;
        // Response() can't carry a body for these statuses.
        const nullBody = status === 204 || status === 205 || status === 304;
        done(() => resolve(new Response(nullBody ? null : body, { status, headers })));
      });
      req.on('error', (e: Error) => done(() => reject(e)));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  };
}

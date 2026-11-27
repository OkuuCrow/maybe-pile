/**
 * Expansion Pack 2 end-to-end checks against the built app:
 *  - Electron's net.fetch with redirect:'manual' exposes the real 3xx status and
 *    Location header (the image redirect allowlist depends on this);
 *  - the new Pile page, item panels and settings render in the real renderer
 *    (sandboxed preload, real IPC, real SQLite at schema v5).
 * No external network is used (a loopback server only).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Http from 'node:http';
import { _electron as electron, expect, test } from '@playwright/test';
import { skipWelcomeAndUseFullMode } from './first-run';

const root = process.cwd();

test('Expansion Pack 2: manual redirects in main, Pile page and item panels', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mp-e2e-p2-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  env['MAYBEPILE_USER_DATA'] = userData;
  env['MAYBEPILE_E2E_HOOKS'] = '1';
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('h1');
    await skipWelcomeAndUseFullMode(page);

    // 1) Electron's own net.fetch rejects manual redirects (why the adapter exists).
    // 2) The app's real HTTP client: plain GET works in manual mode; a redirect reaches the
    //    shared hop validator (here refused because loopback http isn't https) instead of
    //    failing as a generic network error.
    const r = await app.evaluate(async ({ net }) => {
      const http = process.getBuiltinModule('node:http') as typeof Http;
      const server = http.createServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { location: '/next' });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
        }
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      type Client = {
        request(r: {
          url: string;
          timeoutMs: number;
          maxBytes: number;
          redirectHosts?: string[];
        }): Promise<{ status: number; body: Uint8Array }>;
      };
      const client = (globalThis as { __maybePileHttp?: Client }).__maybePileHttp;
      const out: Record<string, unknown> = { hook: Boolean(client) };
      try {
        await net.fetch(`${base}/start`, { redirect: 'manual', bypassCustomProtocolHandlers: true });
        out['netFetchManual'] = 'resolved';
      } catch (e) {
        out['netFetchManual'] = String((e as Error).message);
      }
      if (client) {
        const ok = await client.request({
          url: `${base}/plain`,
          timeoutMs: 5000,
          maxBytes: 1000,
          redirectHosts: [],
        });
        out['plain'] = [ok.status, new TextDecoder().decode(ok.body)];
        try {
          await client.request({
            url: `${base}/start`,
            timeoutMs: 5000,
            maxBytes: 1000,
            redirectHosts: ['127.0.0.1'],
          });
          out['redirect'] = 'followed';
        } catch (e) {
          out['redirect'] = (e as { kind?: string }).kind ?? String(e);
        }
      }
      server.close();
      return out;
    });
    expect(r).toEqual({
      hook: true,
      netFetchManual: 'Redirect was cancelled',
      plain: [200, 'ok'],
      redirect: 'redirect-blocked',
    });

    // Pile page renders from real IPC.
    await page.evaluate(() => (window.location.hash = '#/pile'));
    await expect(page.getByRole('heading', { name: 'Your pile', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pile Time', level: 2 })).toBeVisible();

    // Add an anime manually and check the new panels.
    await page.getByRole('button', { name: 'Add item' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add an item' });
    await dlg.getByRole('tab', { name: 'Enter manually' }).click();
    await dlg.getByRole('radio', { name: 'Anime', exact: true }).check();
    await dlg.getByLabel('Title', { exact: false }).first().fill('Mushishi');
    await dlg.getByRole('button', { name: 'Add to library' }).click();
    await expect(page.getByRole('heading', { name: 'Mushishi', level: 1 })).toBeVisible({ timeout: 15_000 });
    for (const h of ['Time', 'Runs', 'Moods', 'Artwork', 'Preferences', 'Ownership & access'])
      await expect(page.getByRole('heading', { name: h, level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Start timer' }).click();
    await expect(page.getByRole('group', { name: 'Session timer' })).toBeVisible();
    await expect(page.locator('a.header-timer')).toBeVisible();
  } finally {
    await app.close();
  }
});

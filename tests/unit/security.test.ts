import { resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ALL_CHANNELS, API_SHAPE, buildApi, type Channel } from '../../src/shared/ipc-channels';
import { REQUEST_SCHEMAS } from '../../src/shared/ipc-contract';
import {
  createDispatcher,
  makeTrustCheck,
  type Handlers,
  type SenderInfo,
} from '../../src/main/ipc/register';
import { MemoryLogger } from '../../src/main/services/logger';
import { AppError } from '../../src/shared/result';
import {
  APP_ORIGIN,
  PROD_CSP,
  checkOpenExternal,
  devCsp,
  isAllowedNavigation,
  resolveRendererPath,
  secureWebPreferences,
} from '../../src/main/security/policy';
import { resolveDataLocation } from '../../src/main/portable';
import { decodeText } from '../../src/main/ipc/handlers';

const trusted: SenderInfo = { frameUrl: `${APP_ORIGIN}/index.html`, isMainFrame: true, webContentsId: 1 };
const trust = makeTrustCheck([APP_ORIGIN], () => 1);

function fakeHandlers(): Handlers {
  const h: Record<string, () => unknown> = {};
  for (const c of ALL_CHANNELS) h[c] = vi.fn(() => ({ ok: c }));
  return h as unknown as Handlers;
}

describe('preload API surface', () => {
  it('matches the documented snapshot (namespaces → methods → channels)', () => {
    expect(API_SHAPE).toMatchSnapshot();
  });
  it('each method invokes only its own fixed channel; no generic invoke exists', async () => {
    const calls: [Channel, unknown][] = [];
    const api = buildApi(async (c, p) => (calls.push([c, p]), null));
    expect(Object.keys(api).sort()).toEqual(Object.keys(API_SHAPE).sort());
    for (const ns of Object.values(api)) expect(Object.isFrozen(ns)).toBe(true);
    expect('invoke' in api).toBe(false);
    await api['items']?.['get']?.({ id: 'x' });
    expect(calls).toEqual([['items:get', { id: 'x' }]]);
    expect(new Set(ALL_CHANNELS).size).toBe(ALL_CHANNELS.length);
  });
  it('every channel has a request schema', () => {
    for (const c of ALL_CHANNELS) expect(REQUEST_SCHEMAS[c], c).toBeDefined();
  });
});

describe('IPC dispatcher', () => {
  const garbage: unknown[] = [
    { unexpected: 'key', __proto__: { polluted: true } },
    'string',
    42,
    [1, 2],
    { id: '../../etc/passwd' },
  ];

  it.each(ALL_CHANNELS.map((c) => [c]))(
    '%s rejects invalid payloads without calling the handler',
    async (channel) => {
      const handlers = fakeHandlers();
      const dispatch = createDispatcher(handlers, trust, new MemoryLogger());
      for (const g of garbage) {
        const r = await dispatch(channel, trusted, g);
        // Channels taking no payload reject anything but undefined.
        expect(r.ok, `${channel} accepted ${JSON.stringify(g)}`).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('VALIDATION');
      }
      expect(handlers[channel]).not.toHaveBeenCalled();
    },
  );

  it('rejects untrusted senders (wrong origin, subframe, other webContents, missing frame)', async () => {
    const handlers = fakeHandlers();
    const dispatch = createDispatcher(handlers, trust, new MemoryLogger());
    for (const s of [
      { ...trusted, frameUrl: 'https://evil.example.com/' },
      { ...trusted, frameUrl: 'file:///C:/x.html' },
      { ...trusted, isMainFrame: false },
      { ...trusted, webContentsId: 99 },
      { ...trusted, frameUrl: null },
      { ...trusted, frameUrl: 'app://evil/index.html' },
    ]) {
      const r = await dispatch('app:info', s, undefined);
      expect(r).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'This request is not allowed.' } });
    }
    expect(handlers['app:info']).not.toHaveBeenCalled();
    expect((await dispatch('app:info', trusted, undefined)).ok).toBe(true);
  });

  it('returns structured errors and never leaks stacks or paths', async () => {
    const handlers = fakeHandlers();
    (handlers as unknown as Record<string, () => unknown>)['app:info'] = () => {
      throw new Error('ENOENT: C:\\Users\\secret\\file at Object.<anonymous> (main.cjs:1:1)');
    };
    (handlers as unknown as Record<string, () => unknown>)['settings:get'] = () => {
      throw new AppError({ code: 'NOT_FOUND', message: 'Gone', recovery: 'Try again' });
    };
    const log = new MemoryLogger();
    const dispatch = createDispatcher(handlers, trust, log);
    const r = await dispatch('app:info', trusted, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INTERNAL');
      expect(JSON.stringify(r.error)).not.toMatch(/secret|main\.cjs|ENOENT/);
    }
    expect(log.text()).not.toContain('secret');
    expect(await dispatch('settings:get', trusted, undefined)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Gone', recovery: 'Try again' },
    });
  });
});

describe('window & navigation hardening', () => {
  it('uses secure webPreferences', () => {
    expect(secureWebPreferences('/p.cjs')).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });
  it('production CSP forbids inline/remote script and limits images', () => {
    expect(PROD_CSP).toContain("script-src 'self'");
    expect(PROD_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(PROD_CSP).toContain("img-src 'self' data: maybepile-art:");
    expect(PROD_CSP).toContain("object-src 'none'");
    expect(devCsp('http://localhost:5173')).toContain('ws://localhost:5173');
  });
  it('only allows navigation within the app origin', () => {
    expect(isAllowedNavigation('app://maybepile/index.html#/library', [APP_ORIGIN])).toBe(true);
    for (const u of [
      'https://www.imdb.com/',
      'file:///etc/passwd',
      'app://other/x',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isAllowedNavigation(u, [APP_ORIGIN])).toBe(false);
    }
  });
  it('external opener allows only https on known hosts', () => {
    expect(checkOpenExternal('https://www.imdb.com/title/tt0133093/').ok).toBe(true);
    expect(checkOpenExternal('https://store.steampowered.com/app/1/').ok).toBe(true);
    for (const u of [
      'http://www.imdb.com/',
      'javascript:alert(1)',
      'file:///C:/Windows/system32/calc.exe',
      'data:text/html,x',
      'https://a:b@www.imdb.com/',
      'https://evil.example.com/',
      'ms-settings:privacy',
      'ftp://x.com',
    ]) {
      expect(checkOpenExternal(u).ok, u).toBe(false);
    }
  });
  it('renderer file server cannot escape the build directory', () => {
    const root = resolve('dist/renderer');
    expect(resolveRendererPath(root, '/index.html', sep, resolve)).toBe(resolve(root, 'index.html'));
    expect(resolveRendererPath(root, '/', sep, resolve)).toBe(resolve(root, 'index.html'));
    for (const p of [
      '/../main/main.cjs',
      '/%2e%2e/%2e%2e/package.json',
      '/..%5c..%5cpackage.json',
      '/a%00.js',
      '/%E0%A4%A',
    ]) {
      expect(resolveRendererPath(root, p, sep, resolve), p).toBeNull();
    }
  });
});

describe('portable data location', () => {
  const base = { appDataDir: '/appdata', exeDir: '/apps/mp', exists: () => false, isWritableDir: () => true };
  it('installed builds use <appData>/MaybePile', () => {
    const r = resolveDataLocation({ ...base, env: {} });
    expect(r).toMatchObject({ portable: false, notice: null });
    expect(r.dir.replace(/\\/g, '/')).toBe('/appdata/MaybePile');
  });
  it('portable builds keep data next to the exe, separate from the installed copy', () => {
    const r = resolveDataLocation({ ...base, env: { PORTABLE_EXECUTABLE_DIR: '/usb/MaybePile' } });
    expect(r.portable).toBe(true);
    expect(r.dir.replace(/\\/g, '/')).toBe('/usb/MaybePile/MaybePileData');
    const flag = resolveDataLocation({
      ...base,
      env: {},
      exists: (p) => p.replace(/\\/g, '/').endsWith('/apps/mp/portable.flag'),
    });
    expect(flag.dir.replace(/\\/g, '/')).toBe('/apps/mp/MaybePileData');
  });
  it('falls back with a notice when the exe folder is read-only', () => {
    const r = resolveDataLocation({
      ...base,
      env: { PORTABLE_EXECUTABLE_DIR: '/ro' },
      isWritableDir: () => false,
    });
    expect(r.dir.replace(/\\/g, '/')).toBe('/appdata/MaybePile-Portable');
    expect(r.notice).toMatch(/read-only/);
  });
  it('MAYBEPILE_USER_DATA overrides everything (tests)', () => {
    expect(
      resolveDataLocation({ ...base, env: { MAYBEPILE_USER_DATA: '/tmp/x', PORTABLE_EXECUTABLE_DIR: '/p' } })
        .dir,
    ).toBe('/tmp/x');
  });
});

describe('text import decoding', () => {
  it('handles UTF-8, UTF-8 BOM, UTF-16 LE/BE and Windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('Amélie'))).toBe('Amélie');
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('A'); // BOM stripped
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toBe('A');
    expect(decodeText(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toBe('A');
    expect(decodeText(Uint8Array.from([0x41, 0x6d, 0xe9, 0x6c, 0x69, 0x65]))).toBe('Amélie');
  });
});

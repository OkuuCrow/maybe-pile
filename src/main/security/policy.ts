/**
 * Electron hardening helpers that don't depend on a live BrowserWindow, so
 * they are unit-testable: window options, CSP strings, navigation decisions
 * and the external-link opener's URL policy.
 */
import { ALL_LINK_HOSTS, INFO_HOSTS, checkExternalUrl, type UrlCheck } from '../../domain/links';

export const APP_SCHEME = 'app';
export const APP_HOST = 'maybepile';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const ART_SCHEME = 'maybepile-art';

/** BrowserWindow webPreferences — asserted by tests/unit/security.test.ts. */
export function secureWebPreferences(preloadPath: string) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: true,
    devTools: true,
  } as const;
}

export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data: ${ART_SCHEME}:`,
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
].join('; ');

/** Dev server CSP: Vite needs inline styles (HMR) and a websocket. Never used in packaged builds. */
export function devCsp(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    `script-src 'self' ${devOrigin}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${ART_SCHEME}:`,
    "font-src 'self'",
    `connect-src 'self' ${devOrigin} ${ws}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Whether in-window navigation to `url` is allowed (only our own app origin). */
export function isAllowedNavigation(url: string, allowedOrigins: readonly string[]): boolean {
  try {
    const u = new URL(url);
    const origin = u.protocol === `${APP_SCHEME}:` ? `${APP_SCHEME}://${u.host}` : u.origin;
    return allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

/**
 * The only path to `shell.openExternal`. https only, no credentials, no custom
 * ports, host must be one of the link or attribution hosts the app knows about.
 */
export function checkOpenExternal(url: string): UrlCheck {
  return checkExternalUrl(url, new Set([...ALL_LINK_HOSTS, ...INFO_HOSTS]));
}

/** Restricts the renderer file server to files inside the renderer build dir. */
export function resolveRendererPath(
  root: string,
  requestPath: string,
  sep: string,
  resolve: (...p: string[]) => string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  // Reject NUL and backslashes on every OS: "\" is a separator on Windows but an ordinary
  // filename character elsewhere, so allowing it would make the policy platform-dependent.
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rel = decoded.replace(/^\/+/, '') || 'index.html';
  const full = resolve(root, rel);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

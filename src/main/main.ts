/**
 * Electron main process: lifecycle, security hardening, protocols, window,
 * menu and service wiring. Business logic lives in ./services.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { ALL_CHANNELS, EVENT_CHANNELS, type Channel, type MenuCommand } from '../shared/ipc-channels';
import { AppError } from '../shared/result';
import type { AppInfo } from '../shared/types';
import { LATEST_SCHEMA_VERSION } from '../db/migrate';
import { writeSettings } from '../db/repositories/config-repo';
import { createFetchClient, type HttpClient } from '../providers/http';
import { ARTWORK_HOSTS } from '../providers/registry';
import { checkExternalUrl } from '../domain/links';
import { buildHandlers, decodeText, type Platform } from './ipc/handlers';
import { QuickCaptureShortcut } from './quick-capture';
import { startReleaseNotifier } from './release-notifier';
import { createFeatureServices } from './services/feature-services';
import { createDispatcher, makeTrustCheck } from './ipc/register';
import { resolveDataLocation } from './portable';
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  ART_SCHEME,
  checkOpenExternal,
  devCsp,
  isAllowedNavigation,
  MIME,
  PROD_CSP,
  resolveRendererPath,
  secureWebPreferences,
} from './security/policy';
import { ArtworkService, type ImageKind, type ImageProcessor } from './services/artwork-service';
import { BackupService } from './services/backup-service';
import { CatalogService } from './services/catalog-service';
import { pathsFor, systemClock, type ServiceContext } from './services/context';
import { CustomizationService } from './services/customization-service';
import { DatabaseManager } from './services/db-manager';
import { LibraryService } from './services/library-service';
import { FileLogger } from './services/logger';
import { ProgressService } from './services/progress-service';
import { ProviderService } from './services/provider-service';
import { SecretsService } from './services/secrets-service';

const DEV_SERVER = process.env['MAYBEPILE_DEV_SERVER_URL'] ?? null;
const IS_DEV = !app.isPackaged && DEV_SERVER !== null;
const ALLOWED_ORIGINS = [APP_ORIGIN, ...(IS_DEV && DEV_SERVER ? [new URL(DEV_SERVER).origin] : [])];

/* ------------------------------------------------------------------ data location (before ready) */

const location = resolveDataLocation({
  env: process.env,
  appDataDir: app.getPath('appData'),
  exeDir: dirname(app.getPath('exe')),
  exists: existsSync,
  isWritableDir: (p) => {
    try {
      mkdirSync(p, { recursive: true });
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
});
mkdirSync(location.dir, { recursive: true });
app.setPath('userData', location.dir);
app.setPath('sessionData', join(location.dir, 'session'));
const paths = pathsFor(location.dir);
const log = new FileLogger(paths.logs);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

/* ------------------------------------------------------------------ single instance */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(start);
}

let mainWindow: BrowserWindow | null = null;
let dbm: DatabaseManager | null = null;
const runningMarker = join(location.dir, '.running');

/* ------------------------------------------------------------------ adapters */

const imageProcessor: ImageProcessor = {
  process(buf: Uint8Array, kind: ImageKind) {
    const img = nativeImage.createFromBuffer(Buffer.from(buf));
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (width < 1 || height < 1 || width > 12_000 || height > 12_000) return null;
    // Re-encoding drops EXIF/metadata. Large images are scaled down to 1200px wide.
    const full = width > 1200 ? img.resize({ width: 1200, quality: 'best' }) : img;
    const thumb = img.resize({ width: Math.min(320, width), quality: 'good' }).toJPEG(80);
    const asPng = kind !== 'jpeg';
    return { data: asPng ? full.toPNG() : full.toJPEG(88), ext: asPng ? 'png' : 'jpg', thumb };
  },
};

const httpClient: HttpClient = createFetchClient((url, init) =>
  net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }),
);

const platform: Platform = {
  async saveDialog(opts) {
    const r = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  async openDialog(opts) {
    const o = { title: opts.title, filters: opts.filters, properties: ['openFile' as const] };
    const r = mainWindow ? await dialog.showOpenDialog(mainWindow, o) : await dialog.showOpenDialog(o);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async folderDialog(opts) {
    const o = {
      title: opts.title,
      defaultPath: opts.defaultPath,
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const r = mainWindow ? await dialog.showOpenDialog(mainWindow, o) : await dialog.showOpenDialog(o);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async openPath(dir) {
    const e = await shell.openPath(dir);
    if (e) log.warn('shell.openPathFailed');
  },
  async openExternal(url) {
    // Final re-validation right before handing the URL to the OS.
    const c = checkOpenExternal(url);
    if (!c.ok) throw new AppError({ code: 'FORBIDDEN', message: c.reason });
    await shell.openExternal(c.url, { activate: true });
  },
  async capturePng(rect) {
    if (!mainWindow) return null;
    const img = await mainWindow.webContents.capturePage(rect);
    return img.isEmpty() ? null : new Uint8Array(img.toPNG());
  },
};

/* ------------------------------------------------------------------ remote artwork proxy */

const remoteCache = new Map<string, { body: Uint8Array; type: string }>();
async function proxyImage(url: string): Promise<Response> {
  const check = checkExternalUrl(url, ARTWORK_HOSTS);
  if (!check.ok) return new Response(null, { status: 403 });
  const cached = remoteCache.get(check.url);
  if (cached)
    return new Response(Buffer.from(cached.body), {
      headers: { 'content-type': cached.type, 'x-content-type-options': 'nosniff' },
    });
  try {
    const res = await httpClient.request({
      url: check.url,
      timeoutMs: 10_000,
      maxBytes: 8 * 1024 * 1024,
      headers: { Accept: 'image/*' },
    });
    const type = res.headers['content-type'] ?? '';
    if (res.status !== 200 || !/^image\/(png|jpeg|webp|gif)/i.test(type))
      return new Response(null, { status: 502 });
    remoteCache.set(check.url, { body: res.body, type });
    while (remoteCache.size > 150) {
      const k = remoteCache.keys().next().value;
      if (k === undefined) break;
      remoteCache.delete(k);
    }
    return new Response(Buffer.from(res.body), {
      headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
    });
  } catch {
    return new Response(null, { status: 504 });
  }
}

/* ------------------------------------------------------------------ startup */

async function start(): Promise<void> {
  log.info('app.start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    portable: location.portable,
  });
  hardenSession();

  const unclean = existsSync(runningMarker);
  writeFileSync(runningMarker, String(process.pid));

  dbm = new DatabaseManager(paths, log);
  let readOnly = false;
  try {
    dbm.open();
  } catch (e) {
    if (e instanceof AppError && e.safe.code === 'UNSUPPORTED_VERSION') {
      const choice = await dialog.showMessageBox({
        type: 'warning',
        title: 'Newer library',
        message: e.safe.message,
        detail:
          'You can open it read-only (no changes will be saved) or quit and install the latest version.',
        buttons: ['Open read-only', 'Quit'],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice.response !== 0) return app.quit();
      dbm.open({ readOnlyIfNewer: true });
      readOnly = true;
    } else {
      const safe =
        e instanceof AppError ? e.safe : { message: 'The library could not be opened.', recovery: undefined };
      log.error('app.dbOpenFailed', { error: e });
      await dialog.showMessageBox({
        type: 'error',
        title: 'Maybe Pile could not open your library',
        message: safe.message,
        detail: `${safe.recovery ?? ''}\n\nYour data has not been deleted. Pre-upgrade copies are kept in the "backups" folder inside the Maybe Pile data folder. See docs/troubleshooting.md.`,
      });
      await shell.openPath(location.dir);
      return app.quit();
    }
  }
  const db = dbm;
  const ctx: ServiceContext = {
    db: () => db.db,
    clock: systemClock,
    log,
    paths,
    appVersion: app.getVersion(),
  };
  // Electron 45 deprecates the sync availability check; resolve it once at startup.
  const osEncryption =
    (await safeStorage.isAsyncEncryptionAvailable().catch(() => false)) &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  const cipher = {
    isEncryptionAvailable: () => osEncryption,
    encrypt: (s: string) => safeStorage.encryptString(s),
    decrypt: (b: Buffer) => safeStorage.decryptString(b),
  };
  const secrets = new SecretsService(paths.secrets, cipher, log);
  const library = new LibraryService(ctx);
  const artwork = new ArtworkService(ctx, imageProcessor, httpClient);
  const providers = new ProviderService(ctx, httpClient, secrets, library, artwork);
  const backup = new BackupService(ctx, db, artwork);
  const custom = new CustomizationService(ctx);
  const features = createFeatureServices(ctx, { library, providers, secrets, http: httpClient, decodeText });

  // Startup housekeeping: purge soft-deleted items, orphaned artwork, interrupted restores.
  if (!readOnly) {
    try {
      library.purgeDeleted();
      artwork.gc();
      backup.cleanupStaging();
      features.health.purgeExpired();
      features.batches.purgeExpired();
    } catch (e) {
      log.warn('startup.housekeepingFailed', { error: e });
    }
  }

  let recoveryNotice: string | null = null;
  if (unclean) {
    const problems = db.db.integrityCheck(false);
    log.warn('app.uncleanShutdown', { problems: problems.length });
    recoveryNotice =
      problems.length > 0
        ? 'Maybe Pile did not shut down cleanly and the library failed its integrity check. Restore your latest snapshot from Settings → Backup & Restore.'
        : null;
  }
  const open = db.lastOpen;
  let upgradeNotice: string | null =
    open?.migratedFrom != null
      ? `Your library was upgraded from schema v${open.migratedFrom} to v${open.migratedTo}. A copy of the previous version was saved in the backups folder.`
      : null;

  const exportDirKey = 'main.exportDir';
  const getExportDir = () => {
    const row = db.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [exportDirKey]);
    try {
      const v = row ? (JSON.parse(row.value) as unknown) : null;
      if (typeof v === 'string' && existsSync(v)) return v;
    } catch {
      /* fall through to default */
    }
    return app.getPath('documents');
  };

  const appInfo = (): AppInfo => ({
    name: 'Maybe Pile',
    version: app.getVersion(),
    tagline: 'Someday, maybe. Now organized.',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sqlite: db.db.sqliteVersion(),
    schemaVersion: LATEST_SCHEMA_VERSION,
    platform: `${process.platform} ${process.arch}`,
    portable: location.portable,
    dataLocationLabel: location.dir,
    dataLocationNotice: location.notice,
    secretStorage: secrets.storage,
    upgradeNotice,
    recoveryNotice,
    backupLocationLabel: getExportDir(),
    readOnly,
  });

  const handlers = buildHandlers({
    ctx,
    library,
    progress: new ProgressService(ctx, library),
    catalog: new CatalogService(ctx),
    custom,
    providers,
    artwork,
    backup,
    secrets,
    platform,
    ...features,
    onSettingsChanged: (s) => {
      quickCapture.apply(s.quickCapture);
    },
    appInfo,
    acknowledgeNotices: () => {
      upgradeNotice = null;
      recoveryNotice = null;
    },
    exportLogText: () => log.exportRedacted(),
    getExportDir,
    setExportDir: (dir) => writeSettings(db.db, { [exportDirKey]: dir } as never),
  });

  const trusted = makeTrustCheck(ALLOWED_ORIGINS, () => mainWindow?.webContents.id ?? null);
  const dispatch = createDispatcher(handlers, trusted, log);
  for (const channel of ALL_CHANNELS) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) =>
      dispatch(
        channel as Channel,
        {
          frameUrl: event.senderFrame?.url ?? null,
          isMainFrame: event.senderFrame?.parent === null,
          webContentsId: event.sender.id,
        },
        payload,
      ),
    );
  }

  registerProtocols(artwork, providers.previewThumbs);
  buildMenu();
  createWindow();

  // Opt-in global Quick Capture shortcut (failure-tolerant if another app owns it).
  quickCapture = new QuickCaptureShortcut(globalShortcut, () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendMenu('quick-capture');
  });
  const startSettings = custom.getSettings();
  if (!readOnly) {
    const qs = quickCapture.apply(startSettings.quickCapture);
    if (qs.message) log.warn('quickCapture.registerFailed');
    // Opt-in local release notifications, only while the app is running.
    startReleaseNotifier({
      due: () => {
        try {
          return features.radar.dueNotifications();
        } catch (e) {
          log.warn('radar.notifyFailed', { error: e });
          return [];
        }
      },
      notify: (n) => new Notification({ title: n.title, body: n.body, silent: false }).show(),
      isSupported: () => Notification.isSupported(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    });
    // Opt-in: look for release-date changes shortly after start (diff is shown later; nothing is applied).
    if (startSettings.releaseRadar.refreshOnStart) {
      setTimeout(() => {
        void features.radar
          .refreshPreview()
          .catch((e: unknown) => log.warn('radar.startupRefreshFailed', { error: e }));
      }, 15_000);
    }
  }
}

let quickCapture: QuickCaptureShortcut = new QuickCaptureShortcut(
  { register: () => false, unregister: () => undefined, isRegistered: () => false },
  () => undefined,
);

function hardenSession(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
  if (IS_DEV && DEV_SERVER) {
    const csp = devCsp(new URL(DEV_SERVER).origin);
    s.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }
}

function registerProtocols(artwork: ArtworkService, previewThumbs: Map<string, string>): void {
  const rendererRoot = resolve(__dirname, '../renderer');
  protocol.handle(APP_SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.host !== APP_HOST || req.method !== 'GET') return new Response(null, { status: 404 });
    const file = resolveRendererPath(rendererRoot, u.pathname, sep, resolve);
    if (!file || !existsSync(file)) return new Response(null, { status: 404 });
    return new Response(readFileSync(file), {
      headers: {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': PROD_CSP,
        'x-content-type-options': 'nosniff',
        'cross-origin-opener-policy': 'same-origin',
      },
    });
  });
  // Read-only artwork protocol: files only from the artwork cache (validated names), or proxied allowlisted remote images.
  protocol.handle(ART_SCHEME, async (req) => {
    const u = new URL(req.url);
    if (req.method !== 'GET') return new Response(null, { status: 405 });
    const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    if (u.host === 'file') {
      const p = artwork.resolveFile(name);
      if (!p) return new Response(null, { status: 404 });
      return new Response(readFileSync(p), {
        headers: {
          'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (u.host === 'remote' && /^[0-9a-f-]{36}$/.test(name)) {
      const url = artwork.remoteUrl(name, ARTWORK_HOSTS);
      return url ? proxyImage(url) : new Response(null, { status: 404 });
    }
    if (u.host === 'preview' && /^[0-9a-f]{32}$/.test(name)) {
      const url = previewThumbs.get(name);
      return url ? proxyImage(url) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  });
}

function sendMenu(command: MenuCommand): void {
  mainWindow?.webContents.send(EVENT_CHANNELS.menuCommand, command);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'New Item…', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-item') },
        { label: 'Quick Capture…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenu('quick-capture') },
        { type: 'separator' },
        { label: 'Import…', click: () => sendMenu('import') },
        { label: 'Export…', click: () => sendMenu('export') },
        { label: 'Back Up…', click: () => sendMenu('backup') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => sendMenu('go-dashboard') },
        { label: 'Library', accelerator: 'CmdOrCtrl+2', click: () => sendMenu('go-library') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('go-settings') },
        { label: 'Find in Library', accelerator: 'CmdOrCtrl+F', click: () => sendMenu('focus-search') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('command-palette') },
        { label: 'Pick for Me…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendMenu('pick-for-me') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }]),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'Shift+/',
          registerAccelerator: false,
          click: () => sendMenu('show-shortcuts'),
        },
        { label: 'About Maybe Pile', click: () => sendMenu('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const iconPath = join(__dirname, '../../build/icon.png');
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Maybe Pile',
    backgroundColor: '#F6F5F2',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: secureWebPreferences(join(__dirname, '../preload/preload.cjs')),
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => log.info('window.loaded', { packaged: app.isPackaged }));
  win.webContents.on('did-fail-load', (_e, code) => log.error('window.loadFailed', { code }));
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log.warn('renderer.consoleError');
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // Never open new windows. Valid https links go to the default browser via the policy-checked opener.
    if (checkOpenExternal(url).ok) void platform.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isAllowedNavigation(url, ALLOWED_ORIGINS)) {
      e.preventDefault();
      log.warn('nav.blocked');
    }
  });
  wc.on('will-redirect', (e, url) => {
    if (!isAllowedNavigation(url, ALLOWED_ORIGINS)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('render-process-gone', (_e, details) => {
    log.error('renderer.gone', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason !== 'clean-exit') {
      void dialog
        .showMessageBox(win, {
          type: 'error',
          message: 'The Maybe Pile window stopped unexpectedly.',
          detail: 'Your saved data is safe. Reload the window?',
          buttons: ['Reload', 'Quit'],
        })
        .then((r) => (r.response === 0 ? wc.reload() : app.quit()));
    }
  });
  win.on('unresponsive', () => {
    log.warn('renderer.unresponsive');
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        message: 'Maybe Pile is not responding.',
        buttons: ['Keep waiting', 'Reload'],
        defaultId: 0,
      })
      .then((r) => r.response === 1 && wc.reload());
  });

  if (IS_DEV && DEV_SERVER) void win.loadURL(DEV_SERVER);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);
}

/* ------------------------------------------------------------------ shutdown */

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  try {
    quickCapture.dispose();
    globalShortcut.unregisterAll();
    dbm?.close();
    rmSync(runningMarker, { force: true });
    log.info('app.quit');
  } catch (e) {
    log.error('app.quitFailed', { error: e });
  }
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

process.on('uncaughtException', (e) => {
  log.error('main.uncaught', { error: e });
});

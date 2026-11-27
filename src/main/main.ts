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
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { ALL_CHANNELS, EVENT_CHANNELS, type Channel, type MenuCommand } from '../shared/ipc-channels';
import { AppError } from '../shared/result';
import type { AppInfo } from '../shared/types';
import { LATEST_SCHEMA_VERSION } from '../db/migrate';
import { readSettings, writeSettings } from '../db/repositories/config-repo';
import { createFetchClient, type HttpClient } from '../providers/http';
import { createElectronFetch } from './electron-fetch';
import { ARTWORK_HOSTS, ARTWORK_REDIRECT_HOSTS } from '../providers/registry';
import { checkExternalUrl } from '../domain/links';
import { buildHandlers, decodeText, type Platform } from './ipc/handlers';
import { QuickCaptureShortcut } from './quick-capture';
import { applySilentAction } from '../notifications/actions';
import { resolveTimeZone } from '../notifications/engine/time';
import { nodeExec } from '../notifications/exec';
import { EXIT, HELPER_TIMEOUT_MS, runHelper, STATE_FILE } from '../notifications/helper';
import { findProtocolArg, parseProtocolUrl, type ProtocolCommand } from '../notifications/protocol';
import { Installer } from '../notifications/registration/installer';
import { NotifyState } from '../notifications/state/notify-state';
import { dbusEnv } from '../notifications/adapters/linux';
import type { NotificationSettings } from '../shared/notification-settings';
import { activeLibrary, listLibraries } from './services/library-registry';
import { NotificationService } from './services/notification-service';
import { createPack21Services } from './services/pack21-services';
import {
  APP_USER_MODEL_ID,
  createElectronNotifier,
  createInAppNotifier,
  linuxTrayAvailable,
  protocolOps,
  realInstallerFs,
  ResidentScheduler,
  stableExecutable,
  startMenuDir,
  TrayController,
} from './notify-electron';
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
import {
  ArtworkService,
  imageDimensions,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  sniffImage,
  type ImageKind,
  type ImageProcessor,
} from './services/artwork-service';
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
// Multiple libraries (§16.11): the active library's folder holds its database, artwork and backups;
// logs, API keys and notify-state.sqlite stay in the user-data root.
const activeLib = activeLibrary(location.dir);
const paths = {
  ...pathsFor(activeLib.dir),
  logs: join(location.dir, 'logs'),
  secrets: join(location.dir, 'secrets.json'),
};
const log = new FileLogger(paths.logs);
const osZone = () => resolveTimeZone(null);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

/* ------------------------------------------------------------------ process modes */

const ARGV = process.argv.slice(1);
/** Scheduled-mode helper launched by Task Scheduler (Windows): no window, no renderer, read-only library. */
const HELPER_MODE = ARGV.includes('--reminder-check');
/** Launched at login for tray mode. */
const START_HIDDEN = ARGV.includes('--hidden');
const startupCommand = parseProtocolUrl(findProtocolArg(ARGV));
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

let mainWindow: BrowserWindow | null = null;
let dbm: DatabaseManager | null = null;
let notifications: NotificationService | null = null;
let resident: ResidentScheduler | null = null;
let tray: TrayController | null = null;
let trayAvailable = process.platform !== 'linux';
let quitting = false;
let pendingItem: string | null = startupCommand?.kind === 'item' ? startupCommand.id : null;
const runningMarker = join(location.dir, '.running');

if (HELPER_MODE) {
  runHelperProcess();
} else if (startupCommand && (startupCommand.kind === 'snooze' || startupCommand.kind === 'mute')) {
  runSilentAction(startupCommand);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const cmd = parseProtocolUrl(findProtocolArg(argv.slice(1)));
    if (cmd && (cmd.kind === 'snooze' || cmd.kind === 'mute')) {
      // Normally handled by the short-lived action process; never opens a window.
      notifications?.applyProtocol(cmd);
      return;
    }
    showWindow();
    if (cmd?.kind === 'item') openItemInWindow(cmd.id);
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  void app.whenReady().then(start);
}

/** Windows scheduled helper: shows due reminders with toasts, then exits (hard timeout). */
function runHelperProcess(): void {
  const hard = setTimeout(() => app.exit(EXIT.timeout), HELPER_TIMEOUT_MS + 3_000);
  void app.whenReady().then(async () => {
    const notifier = createElectronNotifier({ Notification, platform: process.platform, icon: null, log });
    const r = await runHelper({ dataDir: location.dir, notifier, log, osTimeZone: osZone() }).catch(() => ({
      code: EXIT.unexpected,
      delivered: 0,
    }));
    clearTimeout(hard);
    // Give the OS a moment to hand the toast to the notification center before exiting.
    setTimeout(() => app.exit(r.code), r.delivered > 0 ? 1_500 : 0);
  });
}

/** maybepile://action/... — snooze/mute in notify-state.sqlite only, then exit. No window, no library DB. */
function runSilentAction(cmd: ProtocolCommand): void {
  try {
    const state = NotifyState.open(join(location.dir, STATE_FILE));
    try {
      applySilentAction(
        state,
        listLibraries(location.dir).map((l) => l.id),
        cmd,
        new Date(),
        osZone(),
      );
      log.info('notify.silentAction', { kind: cmd.kind });
    } finally {
      state.close();
    }
  } catch (e) {
    log.warn('notify.silentActionFailed', { error: e });
  }
  app.exit(0);
}

/* ------------------------------------------------------------------ adapters */

const imageProcessor: ImageProcessor = {
  process(buf: Uint8Array, kind: ImageKind, opts?: { maxWidth?: number }) {
    // Header dimensions were already checked (assertSafeDimensions) before we decode.
    const img = nativeImage.createFromBuffer(Buffer.from(buf));
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (width < 1 || height < 1 || width > 12_000 || height > 12_000) return null;
    // Re-encoding drops EXIF/metadata. Large images are scaled down (1200px wide; 2560 for banners/backgrounds).
    const maxWidth = opts?.maxWidth ?? 1200;
    const full = width > maxWidth ? img.resize({ width: maxWidth, quality: 'best' }) : img;
    const thumb = img.resize({ width: Math.min(320, width), quality: 'good' }).toJPEG(80);
    const asPng = kind !== 'jpeg';
    const size = full.getSize();
    return {
      data: asPng ? full.toPNG() : full.toJPEG(88),
      ext: asPng ? 'png' : 'jpg',
      thumb,
      width: size.width,
      height: size.height,
    };
  },
};

const httpClient: HttpClient = createFetchClient(createElectronFetch(net));
// E2E-only hook (env-gated, main-process global, unreachable from the renderer):
// lets the Playwright suite exercise the real Electron HTTP adapter.
if (process.env['MAYBEPILE_E2E_HOOKS'] === '1')
  (globalThis as { __maybePileHttp?: HttpClient }).__maybePileHttp = httpClient;

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
      redirectHosts: ARTWORK_REDIRECT_HOSTS,
    });
    const declared = res.headers['content-type'] ?? '';
    if (res.status !== 200 || !/^image\/(png|jpeg|webp|gif)/i.test(declared))
      return new Response(null, { status: 502 });
    // Never trust the declared type: magic bytes decide (SVG and anything else is rejected),
    // and oversized images are refused before the renderer ever decodes them.
    const kind = sniffImage(res.body);
    const dims = kind ? imageDimensions(res.body, kind) : null;
    if (
      !kind ||
      !dims ||
      dims.width > MAX_IMAGE_DIMENSION ||
      dims.height > MAX_IMAGE_DIMENSION ||
      dims.width * dims.height > MAX_IMAGE_PIXELS
    )
      return new Response(null, { status: 502 });
    const type = `image/${kind}`;
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
  const progress = new ProgressService(ctx, library);
  const pack21 = createPack21Services(ctx, {
    library,
    progress,
    providers,
    artwork,
    features,
    decodeImage: decodeSmallRgba,
    root: location.dir,
    activeLibraryId: activeLib.id,
    relaunch: () => {
      quitting = true;
      app.relaunch();
      app.exit(0);
    },
    backgroundHealth: async () => {
      const st = await notifications?.status();
      const bad = !!st && ['path_changed', 'disabled_by_os', 'error'].includes(st.service.state);
      return { ok: !bad, message: st?.service.message ?? '' };
    },
    repairBackground: async () => {
      await notifications?.repair();
    },
  });

  // Startup housekeeping: purge soft-deleted items, orphaned artwork, interrupted restores.
  if (!readOnly) {
    try {
      // 2.1: Recently deleted keeps items for trash.retentionDays (was: purge on every start).
      pack21.history.purgeExpired();
      pack21.history.pruneLog();
      artwork.gc();
      pack21.backdrops.enforceCap();
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
    extraNotices: notifications?.notices ?? [],
    libraryName: listLibraries(location.dir).length > 1 ? activeLib.name : null,
  });

  /* ---------------------------------------------------------------- notifications (2.1) */
  if (process.platform === 'linux')
    trayAvailable = await linuxTrayAvailable(nodeExec, dbusEnv(process.env, existsSync));
  const exe = stableExecutable(process.env, app.getPath('exe'));
  // Background registrations point at the installed/portable executable; a dev checkout (plain electron.exe)
  // cannot be registered meaningfully, so it needs an explicit opt-in.
  const allowBackground = app.isPackaged || process.env['MAYBEPILE_DEV_BACKGROUND'] === '1';
  const installer =
    allowBackground && (process.platform === 'win32' || process.platform === 'linux')
      ? new Installer({
          platform: process.platform,
          exec: nodeExec,
          fs: realInstallerFs(),
          paths: {
            userData: location.dir,
            home: app.getPath('home'),
            exePath: exe.path,
            isAppImage: exe.appImage,
            isPortable: exe.portable,
            helperSource: join(__dirname, '../helper/reminder-check.cjs'),
            tempDir: join(location.dir, 'tmp'),
            startMenuDir: startMenuDir(app.getPath('appData')),
          },
          loginItem: {
            get: () => {
              const s = app.getLoginItemSettings({ path: exe.path, args: ['--hidden'] });
              return { openAtLogin: s.openAtLogin, path: exe.path, args: ['--hidden'] };
            },
            set: (open, path, args) => app.setLoginItemSettings({ openAtLogin: open, path, args }),
          },
          shortcut: {
            read: (p) => {
              try {
                const l = shell.readShortcutLink(p);
                return { target: l.target, appUserModelId: l.appUserModelId ?? null };
              } catch {
                return null;
              }
            },
            write: (p, target) =>
              shell.writeShortcutLink(p, existsSync(p) ? 'replace' : 'create', {
                target,
                appUserModelId: APP_USER_MODEL_ID,
                description: 'Maybe Pile',
              }),
          },
          protocol: protocolOps(app, exe.path),
          appUserModelId: APP_USER_MODEL_ID,
          author: 'Maybe Pile',
        })
      : null;
  const iconFile = join(__dirname, '../../build/icon.png');
  const osNotifier = createElectronNotifier({
    Notification,
    platform: process.platform,
    icon: existsSync(iconFile) ? iconFile : null,
    onClick: (n) => {
      showWindow();
      if (n.itemId) openItemInWindow(n.itemId);
    },
    log,
  });
  notifications = new NotificationService(
    ctx,
    {
      os: process.platform,
      installer,
      notifier: osNotifier,
      inApp: createInAppNotifier({ getWindow: () => mainWindow, channel: EVENT_CHANNELS.inAppNotification }),
      trayAvailable: () => trayAvailable,
      osTimeZone: osZone,
      portable: exe.portable,
      appImage: exe.appImage,
      onModeChanged: (s) => applyNotificationMode(s),
      nextResidentCheck: () => resident?.nextAt() ?? null,
    },
    { libraryId: activeLib.id, statePath: join(location.dir, STATE_FILE) },
  );
  if (!readOnly) notifications.migrateLegacyFlags();
  const notify = notifications;
  resident = new ResidentScheduler(async () => {
    const hidden = !mainWindow || !mainWindow.isVisible();
    await notify
      .runCheck(tray?.active && hidden ? 'resident' : 'open')
      .catch((e: unknown) => log.warn('notify.checkFailed', { error: e }));
    tray?.refresh();
  });
  tray = new TrayController({
    Tray,
    buildMenu: (t) => Menu.buildFromTemplate(t),
    icon: existsSync(iconFile)
      ? nativeImage.createFromPath(iconFile).resize({ width: 16, height: 16 })
      : nativeImage.createEmpty(),
    onOpen: () => showWindow(),
    onQuit: () => {
      quitting = true;
      app.quit();
    },
    onPause: (d) => {
      notify.pause(d);
      tray?.refresh();
    },
    pausedUntil: () => notify.stateDb?.pausedUntil(new Date()) ?? null,
    onRunCheck: () => void resident?.kick('tray'),
    onQuickCapture: () => {
      showWindow();
      sendMenu('quick-capture');
    },
    onPickForMe: () => {
      showWindow();
      sendMenu('pick-for-me');
    },
    onOpenItem: (id) => {
      showWindow();
      openItemInWindow(id);
    },
    upNext: () => trayUpNext(library, notifySettings()),
    timer: () => trayTimer(features.sessions, notifySettings()),
    onToggleTimer: () => {
      const t = features.sessions.open().find((x) => x.state === 'running') ?? features.sessions.open()[0];
      if (!t) return;
      try {
        if (t.state === 'running') features.sessions.pause(t.id);
        else features.sessions.resume(t.id);
      } catch (e) {
        log.warn('tray.timerFailed', { error: e });
      }
      tray?.refresh();
    },
  });

  const handlers = buildHandlers({
    notifications,
    ctx,
    library,
    progress,
    pack21,
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
      if (notifications) notifications.notices.length = 0;
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
  const hideAtStart = START_HIDDEN && notifySettings().mode === 'tray' && trayAvailable;
  if (!hideAtStart) createWindow();
  applyNotificationMode(notifySettings());
  powerMonitor.on('resume', () => void resident?.kick('resume'));
  powerMonitor.on('unlock-screen', () => void resident?.kick('unlock'));
  if (!readOnly) {
    void notifications.selfHeal().catch((e: unknown) => log.warn('notify.selfHealFailed', { error: e }));
    // Offline add queue: retry lookups shortly after start and every 10 minutes while online.
    const processQueue = () => {
      if (!net.isOnline()) return;
      void pack21.import21
        .processQueue()
        .catch((e: unknown) => log.warn('queue.processFailed', { error: e }));
    };
    setTimeout(processQueue, 20_000).unref();
    setInterval(processQueue, 10 * 60_000).unref();
    // Opt-in automatic status rules: on start and daily (app process only — they write the library).
    const runRules = () => {
      try {
        pack21.maintenance.runRules();
      } catch (e) {
        log.warn('rules.failed', { error: e });
      }
    };
    setTimeout(runRules, 30_000).unref();
    setInterval(runRules, 24 * 3_600_000).unref();
  }

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

function notifySettings(): NotificationSettings {
  try {
    return dbm ? readSettings(dbm.db).settings.notifications : ({ mode: 'off' } as NotificationSettings);
  } catch {
    return { mode: 'off' } as NotificationSettings;
  }
}

/** Starts/stops the in-process checker and the tray to match the chosen delivery mode. */
function applyNotificationMode(s: NotificationSettings): void {
  if (!resident || !tray) return;
  if (s.mode === 'off') resident.stop();
  else resident.start();
  if (s.mode === 'tray' && trayAvailable) tray.ensure();
  else {
    tray.destroy();
    // Without a tray the window must not stay hidden "in a void".
    if (!mainWindow && app.isReady() && dbm) createWindow();
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const w = mainWindow;
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function openItemInWindow(id: string): void {
  const w = mainWindow;
  if (!w || w.webContents.isLoading()) {
    pendingItem = id;
    return;
  }
  w.webContents.send(EVENT_CHANNELS.openItem, id);
}

/** Saved geometry is used only if it lands on a display that exists now (never off-screen). */
function restoredBounds(): { x?: number; y?: number; width: number; height: number; maximized: boolean } {
  const fallback = { width: 1280, height: 820, maximized: false };
  try {
    const w = dbm ? readSettings(dbm.db).settings.window : null;
    if (!w) return fallback;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      const ix = Math.min(a.x + a.width, w.x + w.width) - Math.max(a.x, w.x);
      const iy = Math.min(a.y + a.height, w.y + w.height) - Math.max(a.y, w.y);
      return ix >= 120 && iy >= 80;
    });
    return visible
      ? { x: w.x, y: w.y, width: w.width, height: w.height, maximized: w.maximized }
      : { ...fallback, maximized: w.maximized };
  } catch {
    return fallback;
  }
}

function saveBounds(win: BrowserWindow): void {
  try {
    if (!dbm || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    writeSettings(dbm.db, {
      window: {
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.max(400, Math.round(b.width)),
        height: Math.max(300, Math.round(b.height)),
        maximized: win.isMaximized(),
      },
    });
  } catch (e) {
    log.warn('window.saveBoundsFailed', { error: e });
  }
}

function createWindow(): void {
  const iconPath = join(__dirname, '../../build/icon.png');
  const bounds = restoredBounds();
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Maybe Pile',
    backgroundColor: '#F6F5F2',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: secureWebPreferences(join(__dirname, '../preload/preload.cjs')),
  });
  mainWindow = win;
  win.once('ready-to-show', () => {
    if (bounds.maximized) win.maximize();
    win.show();
  });
  win.webContents.on('did-finish-load', () => {
    log.info('window.loaded', { packaged: app.isPackaged });
    if (pendingItem) {
      win.webContents.send(EVENT_CHANNELS.openItem, pendingItem);
      pendingItem = null;
    }
  });
  win.on('close', (e) => {
    saveBounds(win);
    const s = notifySettings();
    if (quitting || s.mode !== 'tray') return;
    if (tray?.active && s.closeToTray) {
      e.preventDefault();
      win.hide();
    } else if (!trayAvailable && s.closeToTray) {
      // No tray on this desktop: minimize instead of hiding into nothing.
      e.preventDefault();
      win.minimize();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
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
  // In tray mode the process keeps running (reminders keep arriving) until "Quit completely".
  if (tray?.active && !quitting) return;
  app.quit();
});

app.on('will-quit', () => {
  try {
    quickCapture.dispose();
    globalShortcut.unregisterAll();
    resident?.stop();
    tray?.destroy();
    notifications?.close();
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

/* ------------------------------------------------------------------ tray menu data (privacy-aware) */

function trayUpNext(library: LibraryService, s: NotificationSettings): { id: string; label: string }[] {
  try {
    return library
      .upNext()
      .slice(0, 3)
      .map((i, n) => ({
        id: i.id,
        label: s.privacy === 'titles' ? i.title.slice(0, 48) : `Up Next #${n + 1}`,
      }));
  } catch {
    return [];
  }
}

function trayTimer(
  sessions: { open(): { itemId: string; itemTitle: string; state: string }[] },
  s: NotificationSettings,
): { itemId: string; label: string; running: boolean } | null {
  try {
    const open = sessions.open();
    const t = open.find((x) => x.state === 'running') ?? open[0];
    if (!t) return null;
    return {
      itemId: t.itemId,
      label: s.privacy === 'titles' ? t.itemTitle.slice(0, 40) : 'current item',
      running: t.state === 'running',
    };
  } catch {
    return null;
  }
}

/** Small RGBA bitmap for palette extraction (nativeImage gives BGRA). */
function decodeSmallRgba(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } | null {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return null;
  const small = img.getSize().width > 64 ? img.resize({ width: 64, quality: 'good' }) : img;
  const { width, height } = small.getSize();
  const bgra = small.toBitmap();
  if (bgra.length < width * height * 4) return null;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height * 4; i += 4) {
    data[i] = bgra[i + 2] ?? 0;
    data[i + 1] = bgra[i + 1] ?? 0;
    data[i + 2] = bgra[i] ?? 0;
    data[i + 3] = bgra[i + 3] ?? 255;
  }
  return { width, height, data };
}

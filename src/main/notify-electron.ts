/**
 * Electron-side notification plumbing (main process only):
 * OS notifier, in-app banner notifier, resident scheduler, tray, Linux tray
 * probe and the real OS operations behind the background-component Installer.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserWindow, MenuItemConstructorOptions, NativeImage, Tray as TrayType } from 'electron';
import { buildToastXml } from '../notifications/adapters/windows-toast';
import type { Capabilities, DeliveryResult, ExecFn, Notifier } from '../notifications/adapters/types';
import type { PlannedNotification } from '../notifications/engine/types';
import type { InstallerDeps } from '../notifications/registration/installer';
import { PROTOCOL_SCHEME } from '../notifications/protocol';

export const APP_USER_MODEL_ID = 'app.maybepile.desktop';

/* ------------------------------------------------------------------ OS notifier */

interface ElectronNotificationCtor {
  new (opts: Record<string, unknown>): {
    on(ev: 'show' | 'click' | 'close', cb: () => void): void;
    on(ev: 'failed', cb: (e: unknown, error: string) => void): void;
    show(): void;
  };
  isSupported(): boolean;
}

export function createElectronNotifier(d: {
  Notification: ElectronNotificationCtor;
  platform: NodeJS.Platform;
  icon: string | null;
  /** Linux/macOS click (Windows toasts use protocol activation instead). */
  onClick?: (n: PlannedNotification) => void;
  waitMs?: number;
  log?: { warn(e: string, d?: Record<string, unknown>): void };
}): Notifier {
  const live = new Set<unknown>();
  const caps: Capabilities = {
    actions: d.platform === 'win32',
    bodyMarkup: false,
    persistent: d.platform === 'win32',
    icon: !!d.icon,
  };
  return {
    id: 'electron',
    probe: async () =>
      d.Notification.isSupported()
        ? { available: true, reason: null, capabilities: caps }
        : {
            available: false,
            reason: 'This system does not support desktop notifications.',
            capabilities: { ...caps, actions: false },
          },
    show: (n, opts) =>
      new Promise<DeliveryResult>((resolveResult) => {
        if (!d.Notification.isSupported())
          return resolveResult({ status: 'unsupported', reason: 'notifications unsupported' });
        let settled = false;
        const done = (r: DeliveryResult) => {
          if (settled) return;
          settled = true;
          resolveResult(r);
        };
        try {
          const notif =
            d.platform === 'win32'
              ? new d.Notification({ toastXml: buildToastXml(n, { sound: opts.sound, actions: true }) })
              : new d.Notification({
                  title: n.title,
                  body: n.body,
                  silent: !opts.sound,
                  ...(d.icon ? { icon: d.icon } : {}),
                  ...(d.platform === 'linux' ? { urgency: n.urgency === 'normal' ? 'normal' : 'low' } : {}),
                });
          live.add(notif);
          notif.on('show', () => done({ status: 'delivered' }));
          notif.on('failed', (_e, error) => done({ status: 'failed', reason: String(error).slice(0, 120) }));
          notif.on('click', () => d.onClick?.(n));
          notif.on('close', () => live.delete(notif));
          notif.show();
          // Keep a reference so click handlers survive GC; drop it after 15 min.
          const keep = setTimeout(() => live.delete(notif), 15 * 60_000);
          (keep as { unref?: () => void }).unref?.();
        } catch {
          return done({ status: 'failed', reason: 'could not create notification' });
        }
        const wait = setTimeout(() => {
          d.log?.warn('notify.showUnconfirmed');
          done({ status: 'delivered' });
        }, d.waitMs ?? 4_000);
        (wait as { unref?: () => void }).unref?.();
      }),
  };
}

/** In-app banner (renderer toast) — only while a window is visible. */
export function createInAppNotifier(d: { getWindow: () => BrowserWindow | null; channel: string }): Notifier {
  return {
    id: 'in-app',
    probe: async () => ({
      available: !!d.getWindow(),
      reason: null,
      capabilities: { actions: false, bodyMarkup: false, persistent: false, icon: false },
    }),
    show: async (n) => {
      const w = d.getWindow();
      if (!w || w.isDestroyed() || !w.isVisible())
        return { status: 'unsupported', reason: 'no visible window' };
      w.webContents.send(d.channel, { title: n.title, body: n.body, itemId: n.itemId });
      return { status: 'delivered' };
    },
  };
}

/* ------------------------------------------------------------------ resident scheduler */

export const RESIDENT_TICK_MS = 5 * 60_000;

/**
 * Runs the engine every few minutes while the main process lives, plus on
 * resume/unlock and when a clock jump is detected. Timers are unref'd and
 * cleared on stop/quit; runs never overlap.
 */
export class ResidentScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTick = 0;
  private next: number | null = null;

  constructor(
    private readonly run: (reason: string) => Promise<void>,
    private readonly opts: { tickMs?: number; now?: () => number } = {},
  ) {}

  private get tickMs() {
    return this.opts.tickMs ?? RESIDENT_TICK_MS;
  }
  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastTick = this.now();
    this.next = this.lastTick + this.tickMs;
    this.timer = setInterval(() => {
      const now = this.now();
      const drift = Math.abs(now - this.lastTick - this.tickMs);
      this.lastTick = now;
      this.next = now + this.tickMs;
      void this.kick(drift > 2 * 60_000 ? 'clock-change' : 'tick');
    }, this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.kick('start');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.next = null;
  }

  get active(): boolean {
    return this.timer !== null;
  }

  nextAt(): Date | null {
    return this.next ? new Date(this.next) : null;
  }

  async kick(reason: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.run(reason);
    } finally {
      this.running = false;
    }
  }
}

/* ------------------------------------------------------------------ Linux tray availability */

/**
 * Tray icons on Linux need a StatusNotifierItem host (KDE, Cinnamon, XFCE with
 * the plugin, GNOME only with the AppIndicator extension). Without a watcher,
 * X11 desktops other than GNOME may still show a legacy (XEmbed) icon.
 * Verified status per desktop is documented in docs/notifications.md.
 */
export async function linuxTrayAvailable(exec: ExecFn, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const r = await exec(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        "'org.kde.StatusNotifierWatcher'",
      ],
      { timeoutMs: 3_000, env },
    );
    if (r.code === 0 && /true/.test(r.stdout)) return true;
  } catch {
    /* gdbus missing */
  }
  const desktop = (env['XDG_CURRENT_DESKTOP'] ?? '').toLowerCase();
  return env['XDG_SESSION_TYPE'] === 'x11' && !desktop.includes('gnome');
}

/* ------------------------------------------------------------------ tray */

export interface TrayDeps {
  Tray: new (image: NativeImage | string) => TrayType;
  buildMenu: (template: MenuItemConstructorOptions[]) => Electron.Menu;
  icon: NativeImage | string;
  onOpen(): void;
  onQuit(): void;
  onPause(d: '1h' | 'tomorrow' | 'indefinite' | 'resume'): void;
  pausedUntil(): Date | null;
  onRunCheck(): void;
  onQuickCapture(): void;
  onPickForMe(): void;
  onOpenItem(id: string): void;
  /** Up Next (top 3) already privacy-rendered (titles hidden unless allowed / not adult). */
  upNext(): { id: string; label: string }[];
  timer(): { itemId: string; label: string; running: boolean } | null;
  onToggleTimer(): void;
}

export class TrayController {
  private tray: TrayType | null = null;
  constructor(private readonly d: TrayDeps) {}

  get active(): boolean {
    return this.tray !== null;
  }

  ensure(): void {
    if (this.tray) return this.refresh();
    this.tray = new this.d.Tray(this.d.icon);
    this.tray.setToolTip('Maybe Pile');
    this.tray.on('click', () => this.d.onOpen());
    this.refresh();
  }

  refresh(): void {
    if (!this.tray) return;
    const paused = this.d.pausedUntil();
    const up = this.d.upNext();
    const timer = this.d.timer();
    const template: MenuItemConstructorOptions[] = [
      { label: 'Open Maybe Pile', click: () => this.d.onOpen() },
      { type: 'separator' },
      {
        label: 'Up Next',
        enabled: up.length > 0,
        submenu:
          up.length > 0
            ? up.map((u) => ({ label: u.label, click: () => this.d.onOpenItem(u.id) }))
            : [{ label: 'Nothing queued', enabled: false }],
      },
      timer
        ? {
            label: timer.running ? `Pause timer (${timer.label})` : `Resume timer (${timer.label})`,
            click: () => this.d.onToggleTimer(),
          }
        : { label: 'No timer running', enabled: false },
      { label: 'Quick Capture…', click: () => this.d.onQuickCapture() },
      { label: 'Pick for Me…', click: () => this.d.onPickForMe() },
      { type: 'separator' },
      paused
        ? {
            label: `Resume notifications (paused until ${paused.getFullYear() > 9000 ? 'you resume' : paused.toLocaleString()})`,
            click: () => this.d.onPause('resume'),
          }
        : {
            label: 'Pause notifications',
            submenu: [
              { label: 'For 1 hour', click: () => this.d.onPause('1h') },
              { label: 'Until tomorrow 08:00', click: () => this.d.onPause('tomorrow') },
              { label: 'Until I resume', click: () => this.d.onPause('indefinite') },
            ],
          },
      { label: 'Run reminder check now', click: () => this.d.onRunCheck() },
      { type: 'separator' },
      { label: 'Quit Maybe Pile completely', click: () => this.d.onQuit() },
    ];
    this.tray.setContextMenu(this.d.buildMenu(template));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

/* ------------------------------------------------------------------ installer OS ops */

export function realInstallerFs(): InstallerDeps['fs'] {
  return {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, data) => writeFileSync(p, data),
    mkdir: (p) => void mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { force: true }),
    // Reads through Electron's asar-aware fs, so the bundled helper can be copied out of app.asar.
    copy: (src, dest) => writeFileSync(dest, readFileSync(src)),
  };
}

/** The executable to register: the portable .exe / AppImage file, never a temp extraction path. */
export function stableExecutable(
  env: NodeJS.ProcessEnv,
  exe: string,
): { path: string; portable: boolean; appImage: boolean } {
  if (env['PORTABLE_EXECUTABLE_FILE'])
    return { path: env['PORTABLE_EXECUTABLE_FILE'], portable: true, appImage: false };
  if (env['APPIMAGE']) return { path: env['APPIMAGE'], portable: false, appImage: true };
  return { path: exe, portable: false, appImage: false };
}

export function protocolOps(app: Electron.App, exePath: string): NonNullable<InstallerDeps['protocol']> {
  const args = process.defaultApp && process.argv[1] ? [resolve(process.argv[1])] : [];
  return {
    isRegistered: () => app.isDefaultProtocolClient(PROTOCOL_SCHEME, exePath, args),
    register: () => app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, exePath, args),
    unregister: () => app.removeAsDefaultProtocolClient(PROTOCOL_SCHEME, exePath, args),
  };
}

export const startMenuDir = (appData: string) =>
  join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

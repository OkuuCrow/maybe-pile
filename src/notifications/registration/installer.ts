/**
 * Background components: plan (what the confirmation dialog lists), install
 * with rollback, verified removal, status and self-healing repair.
 *
 * Every OS operation is injected (InstallerDeps) so tests never touch the
 * developer's real Task Scheduler, registry, autostart folder or systemd.
 * Everything is per-user; nothing asks for admin/root.
 */
import { posix, win32 } from 'node:path';
import type { NotificationSettings } from '../../shared/notification-settings';
import type { ExecFn } from '../adapters/types';
import {
  AUTOSTART_FILE,
  buildAutostartEntry,
  buildSystemdService,
  buildSystemdTimer,
  buildUrlHandlerEntry,
  buildWindowsTaskXml,
  CHECK_ARG,
  HELPER_SCRIPT,
  HIDDEN_ARG,
  parseWindowsTaskXml,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  schtasksQueryArgs,
  schtasksRunArgs,
  systemctl,
  SYSTEMD_UNIT,
  URL_HANDLER_FILE,
  validatePosixPath,
  validateWindowsPath,
  WIN_TASK_NAME,
} from './templates';

export type ComponentId =
  | 'win-task'
  | 'win-login-item'
  | 'win-aumid-shortcut'
  | 'win-protocol'
  | 'linux-helper-script'
  | 'linux-systemd-service'
  | 'linux-systemd-timer'
  | 'linux-autostart'
  | 'linux-url-handler';

export interface PlannedComponent {
  id: ComponentId;
  label: string;
  /** Exactly where it is created (file path, task name or registry key). */
  location: string;
  /** Command line / contents summary. */
  detail: string;
  /** How to undo it manually. */
  undo: string;
}

export type ServiceState =
  'not_installed' | 'healthy' | 'path_changed' | 'disabled_by_os' | 'error' | 'unsupported';

export interface ComponentStatus {
  id: ComponentId;
  present: boolean;
  ok: boolean;
  problem: string | null;
}

export interface ServiceStatus {
  state: ServiceState;
  components: ComponentStatus[];
  message: string;
}

export interface FsOps {
  exists(p: string): boolean;
  read(p: string): string;
  write(p: string, data: string | Uint8Array): void;
  mkdir(p: string): void;
  remove(p: string): void;
  copy(src: string, dest: string): void;
}

export interface InstallerDeps {
  platform: NodeJS.Platform;
  exec: ExecFn;
  fs: FsOps;
  paths: {
    userData: string;
    home: string;
    /** The stable executable to register (portable: original .exe; AppImage: $APPIMAGE). */
    exePath: string;
    isAppImage: boolean;
    isPortable: boolean;
    /** Bundled helper script (Linux), copied next to the user data. */
    helperSource: string;
    tempDir: string;
    /** Windows: %APPDATA%\Microsoft\Windows\Start Menu\Programs */
    startMenuDir: string;
  };
  /** Windows login item (Electron app.get/setLoginItemSettings). */
  loginItem?: {
    get(): { openAtLogin: boolean; path: string | null; args: string[] };
    set(open: boolean, path: string, args: string[]): void;
  };
  /** Windows Start Menu shortcut carrying the AppUserModelID. */
  shortcut?: {
    read(p: string): { target: string; appUserModelId: string | null } | null;
    write(p: string, target: string): boolean;
  };
  /** Windows per-user protocol registration (portable builds; NSIS does it for installs). */
  protocol?: { isRegistered(): boolean; register(): boolean; unregister(): boolean };
  /** XDG config home (Linux), defaults to ~/.config. */
  xdgConfigHome?: string;
  xdgDataHome?: string;
  appUserModelId: string;
  author: string;
}

export const SHORTCUT_NAME = 'Maybe Pile.lnk';

export class Installer {
  constructor(private readonly d: InstallerDeps) {}

  /** Path joining for the *target* OS (tests run Linux plans on Windows and vice versa). */
  private join(...parts: string[]): string {
    return this.d.platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
  }

  get supported(): boolean {
    return this.d.platform === 'win32' || this.d.platform === 'linux';
  }

  private get cfg() {
    return this.d.xdgConfigHome ?? this.join(this.d.paths.home, '.config');
  }
  private get dataHome() {
    return this.d.xdgDataHome ?? this.join(this.d.paths.home, '.local', 'share');
  }
  get files() {
    return {
      service: this.join(this.cfg, 'systemd', 'user', `${SYSTEMD_UNIT}.service`),
      timer: this.join(this.cfg, 'systemd', 'user', `${SYSTEMD_UNIT}.timer`),
      autostart: this.join(this.cfg, 'autostart', AUTOSTART_FILE),
      urlHandler: this.join(this.dataHome, 'applications', URL_HANDLER_FILE),
      helper: this.join(this.d.paths.userData, 'helper', HELPER_SCRIPT),
      shortcut: this.join(this.d.paths.startMenuDir, SHORTCUT_NAME),
    };
  }

  private wantsScheduled(s: NotificationSettings) {
    return s.mode === 'scheduled' || (s.mode === 'tray' && s.alsoScheduled);
  }
  private wantsLogin(s: NotificationSettings) {
    return s.mode === 'tray' && s.startAtLogin;
  }
  private needsBackground(s: NotificationSettings) {
    return s.mode === 'tray' || s.mode === 'scheduled';
  }

  /** What would be created for these settings — the confirmation dialog shows exactly this. */
  plan(s: NotificationSettings): PlannedComponent[] {
    if (!this.supported || !this.needsBackground(s)) return [];
    const out: PlannedComponent[] = [];
    const exe = this.d.paths.exePath;
    if (this.d.platform === 'win32') {
      validateWindowsPath(exe, 'application');
      if (this.wantsScheduled(s))
        out.push({
          id: 'win-task',
          label: 'Scheduled task (your account only)',
          location: `Task Scheduler › ${WIN_TASK_NAME}`,
          detail: `"${exe}" ${CHECK_ARG} — every ${s.intervalMinutes} min, only while you are signed in, hidden, 1-minute limit`,
          undo: `schtasks /Delete /TN "${WIN_TASK_NAME}" /F`,
        });
      if (this.wantsLogin(s))
        out.push({
          id: 'win-login-item',
          label: 'Start at sign-in (hidden in the tray)',
          location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          detail: `"${exe}" ${HIDDEN_ARG}`,
          undo: 'Turn off "Start at login" here, or disable Maybe Pile in Task Manager › Startup apps',
        });
      if (!this.shortcutOk())
        out.push({
          id: 'win-aumid-shortcut',
          label: 'Start Menu shortcut (Windows needs it to show notifications)',
          location: this.files.shortcut,
          detail: `Shortcut to "${exe}" with app ID ${this.d.appUserModelId}`,
          undo: 'Delete the shortcut from the Start Menu folder',
        });
      if (this.d.paths.isPortable && this.d.protocol && !this.d.protocol.isRegistered())
        out.push({
          id: 'win-protocol',
          label: 'Link handler for notification clicks',
          location: 'HKCU\\Software\\Classes\\maybepile',
          detail: `maybepile:// links open "${exe}"`,
          undo: 'Remove background components here (also removes the link handler)',
        });
    } else {
      validatePosixPath(exe, 'application');
      if (this.wantsScheduled(s)) {
        out.push({
          id: 'linux-helper-script',
          label: 'Reminder check script',
          location: this.files.helper,
          detail: 'A copy of the read-only reminder check (no network, no window)',
          undo: `rm "${this.files.helper}"`,
        });
        out.push({
          id: 'linux-systemd-service',
          label: 'systemd user service',
          location: this.files.service,
          detail: `ELECTRON_RUN_AS_NODE=1 "${exe}" "${this.files.helper}" ${CHECK_ARG} --data-dir "${this.d.paths.userData}"`,
          undo: `systemctl --user disable --now ${SYSTEMD_UNIT}.timer && rm "${this.files.service}"`,
        });
        out.push({
          id: 'linux-systemd-timer',
          label: 'systemd user timer',
          location: this.files.timer,
          detail: `Every ${s.intervalMinutes} min (catches up after sleep), enabled with systemctl --user enable --now`,
          undo: `systemctl --user disable --now ${SYSTEMD_UNIT}.timer && rm "${this.files.timer}"`,
        });
      }
      if (this.wantsLogin(s))
        out.push({
          id: 'linux-autostart',
          label: 'Start at login (hidden in the tray)',
          location: this.files.autostart,
          detail: `"${exe}" ${HIDDEN_ARG}`,
          undo: `rm "${this.files.autostart}"`,
        });
      if (this.d.paths.isAppImage)
        out.push({
          id: 'linux-url-handler',
          label: 'Link handler for notification clicks (AppImage)',
          location: this.files.urlHandler,
          detail: `maybepile:// links open "${exe}"`,
          undo: `rm "${this.files.urlHandler}"`,
        });
    }
    return out;
  }

  private shortcutOk(): boolean {
    if (this.d.platform !== 'win32' || !this.d.shortcut) return true;
    const s = this.d.shortcut.read(this.files.shortcut);
    return !!s && s.appUserModelId === this.d.appUserModelId;
  }

  /** Creates the planned components. On any failure, everything created by this call is rolled back. */
  async install(
    s: NotificationSettings,
  ): Promise<{ ok: boolean; created: ComponentId[]; error: string | null }> {
    const created: ComponentId[] = [];
    let plan: PlannedComponent[];
    try {
      plan = this.plan(s);
    } catch (e) {
      return { ok: false, created: [], error: e instanceof Error ? e.message : 'Registration failed.' };
    }
    try {
      for (const c of plan) {
        await this.create(c.id, s);
        created.push(c.id);
      }
      // Components the new settings no longer need are removed (clean mode transitions).
      const wanted = new Set(plan.map((c) => c.id));
      for (const id of this.allComponentIds())
        if (!wanted.has(id) && id !== 'win-aumid-shortcut') await this.removeOne(id).catch(() => undefined);
      return { ok: true, created, error: null };
    } catch (e) {
      for (const id of [...created].reverse()) await this.removeOne(id).catch(() => undefined);
      return { ok: false, created: [], error: e instanceof Error ? e.message : 'Registration failed.' };
    }
  }

  private allComponentIds(): ComponentId[] {
    return this.d.platform === 'win32'
      ? ['win-task', 'win-login-item', 'win-protocol']
      : [
          'linux-systemd-timer',
          'linux-systemd-service',
          'linux-helper-script',
          'linux-autostart',
          'linux-url-handler',
        ];
  }

  private async run(file: string, args: string[]) {
    const r = await this.d.exec(file, args, { timeoutMs: 15_000 });
    return r;
  }

  private async create(id: ComponentId, s: NotificationSettings): Promise<void> {
    const f = this.files;
    const exe = this.d.paths.exePath;
    switch (id) {
      case 'win-task': {
        const xml = buildWindowsTaskXml({
          exePath: exe,
          intervalMinutes: s.intervalMinutes,
          startBoundary: '2026-01-01T00:00:00',
          author: this.d.author,
        });
        this.d.fs.mkdir(this.d.paths.tempDir);
        const tmp = this.join(this.d.paths.tempDir, `mp-task-${Date.now()}.xml`);
        // Task Scheduler reads UTF-16 LE with a BOM most reliably.
        this.d.fs.write(tmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
        try {
          const r = await this.run('schtasks', schtasksCreateArgs(tmp));
          if (r.code !== 0) throw new Error('Task Scheduler refused to create the reminder task.');
        } finally {
          this.d.fs.remove(tmp);
        }
        return;
      }
      case 'win-login-item':
        if (!this.d.loginItem) throw new Error('Login items are unavailable.');
        this.d.loginItem.set(true, exe, [HIDDEN_ARG]);
        return;
      case 'win-aumid-shortcut':
        if (!this.d.shortcut || !this.d.shortcut.write(f.shortcut, exe))
          throw new Error('The Start Menu shortcut Windows needs for notifications could not be created.');
        return;
      case 'win-protocol':
        if (!this.d.protocol?.register()) throw new Error('The link handler could not be registered.');
        return;
      case 'linux-helper-script':
        this.d.fs.mkdir(this.join(this.d.paths.userData, 'helper'));
        this.d.fs.copy(this.d.paths.helperSource, f.helper);
        return;
      case 'linux-systemd-service': {
        const probe = await this.run('systemctl', systemctl.probe()).catch(() => ({
          code: 1,
          stdout: '',
          stderr: 'missing',
        }));
        if (probe.code !== 0 && !/running|degraded|starting/.test(probe.stdout))
          throw new Error('No systemd user session is available. Use "Keep running in the tray" instead.');
        this.d.fs.mkdir(this.join(this.cfg, 'systemd', 'user'));
        this.d.fs.write(
          f.service,
          buildSystemdService({
            exePath: exe,
            helperPath: f.helper,
            dataDir: this.d.paths.userData,
            intervalMinutes: s.intervalMinutes,
          }),
        );
        return;
      }
      case 'linux-systemd-timer': {
        this.d.fs.write(f.timer, buildSystemdTimer(s.intervalMinutes));
        const reload = await this.run('systemctl', systemctl.reload());
        if (reload.code !== 0) throw new Error('systemctl --user daemon-reload failed.');
        const en = await this.run('systemctl', systemctl.enable());
        if (en.code !== 0) throw new Error('The systemd timer could not be enabled.');
        return;
      }
      case 'linux-autostart':
        this.d.fs.mkdir(this.join(this.cfg, 'autostart'));
        this.d.fs.write(f.autostart, buildAutostartEntry(exe));
        return;
      case 'linux-url-handler':
        this.d.fs.mkdir(this.join(this.dataHome, 'applications'));
        this.d.fs.write(f.urlHandler, buildUrlHandlerEntry(exe));
        await this.run('xdg-mime', ['default', URL_HANDLER_FILE, 'x-scheme-handler/maybepile']).catch(
          () => undefined,
        );
        return;
    }
  }

  private async removeOne(id: ComponentId): Promise<void> {
    const f = this.files;
    switch (id) {
      case 'win-task': {
        const q = await this.run('schtasks', schtasksQueryArgs()).catch(() => ({
          code: 1,
          stdout: '',
          stderr: '',
        }));
        if (q.code === 0) await this.run('schtasks', schtasksDeleteArgs());
        return;
      }
      case 'win-login-item':
        if (this.d.loginItem?.get().openAtLogin)
          this.d.loginItem.set(false, this.d.paths.exePath, [HIDDEN_ARG]);
        return;
      case 'win-protocol':
        if (this.d.paths.isPortable && this.d.protocol?.isRegistered()) this.d.protocol.unregister();
        return;
      case 'win-aumid-shortcut':
        return; // Never removed: it is also the user's normal Start Menu entry.
      case 'linux-systemd-timer':
        if (this.d.fs.exists(f.timer)) {
          await this.run('systemctl', systemctl.disable()).catch(() => undefined);
          this.d.fs.remove(f.timer);
          await this.run('systemctl', systemctl.reload()).catch(() => undefined);
        }
        return;
      case 'linux-systemd-service':
        if (this.d.fs.exists(f.service)) this.d.fs.remove(f.service);
        return;
      case 'linux-helper-script':
        if (this.d.fs.exists(f.helper)) this.d.fs.remove(f.helper);
        return;
      case 'linux-autostart':
        if (this.d.fs.exists(f.autostart)) this.d.fs.remove(f.autostart);
        return;
      case 'linux-url-handler':
        if (this.d.fs.exists(f.urlHandler)) this.d.fs.remove(f.urlHandler);
        return;
    }
  }

  /** Removes every background component (idempotent), then re-queries to prove it. */
  async removeAll(): Promise<{ removed: ComponentId[]; verified: boolean; remaining: ComponentId[] }> {
    if (!this.supported) return { removed: [], verified: true, remaining: [] };
    const before = await this.presentComponents();
    for (const id of this.allComponentIds()) await this.removeOne(id).catch(() => undefined);
    const after = await this.presentComponents();
    return {
      removed: before.filter((id) => !after.includes(id)),
      verified: after.length === 0,
      remaining: after,
    };
  }

  private async presentComponents(): Promise<ComponentId[]> {
    const out: ComponentId[] = [];
    const f = this.files;
    if (this.d.platform === 'win32') {
      const q = await this.run('schtasks', schtasksQueryArgs()).catch(() => ({
        code: 1,
        stdout: '',
        stderr: '',
      }));
      if (q.code === 0) out.push('win-task');
      if (this.d.loginItem?.get().openAtLogin) out.push('win-login-item');
      if (this.d.paths.isPortable && this.d.protocol?.isRegistered()) out.push('win-protocol');
    } else if (this.d.platform === 'linux') {
      if (this.d.fs.exists(f.timer)) out.push('linux-systemd-timer');
      if (this.d.fs.exists(f.service)) out.push('linux-systemd-service');
      if (this.d.fs.exists(f.helper)) out.push('linux-helper-script');
      if (this.d.fs.exists(f.autostart)) out.push('linux-autostart');
      if (this.d.fs.exists(f.urlHandler)) out.push('linux-url-handler');
    }
    return out;
  }

  /** Compares what exists with what the settings need (path, interval, enabled state). */
  async status(s: NotificationSettings): Promise<ServiceStatus> {
    if (!this.supported)
      return {
        state: 'unsupported',
        components: [],
        message: 'Background reminders are available on Windows and Linux only.',
      };
    let plan: PlannedComponent[];
    try {
      plan = this.plan(s);
    } catch (e) {
      return {
        state: 'error',
        components: [],
        message: e instanceof Error ? e.message : 'Unsupported path.',
      };
    }
    const present = await this.presentComponents();
    if (!this.needsBackground(s))
      return present.length === 0
        ? { state: 'not_installed', components: [], message: 'No background components are installed.' }
        : {
            state: 'error',
            components: present.map((id) => ({
              id,
              present: true,
              ok: false,
              problem: 'Left over from an earlier mode',
            })),
            message: 'Some background components are still installed. Remove them.',
          };
    const comps: ComponentStatus[] = [];
    const exe = this.d.paths.exePath;
    let pathChanged = false;
    let disabled = false;
    for (const c of plan) {
      let isPresent = false;
      let ok = false;
      let problem: string | null = null;
      switch (c.id) {
        case 'win-task': {
          const q = await this.run('schtasks', schtasksQueryArgs()).catch(() => ({
            code: 1,
            stdout: '',
            stderr: '',
          }));
          isPresent = q.code === 0;
          if (isPresent) {
            const t = parseWindowsTaskXml(q.stdout);
            if (!t.enabled) {
              disabled = true;
              problem = 'The task was disabled in Windows.';
            } else if ((t.command ?? '').toLowerCase() !== exe.toLowerCase() || t.args !== CHECK_ARG) {
              pathChanged = true;
              problem = 'Points to an old copy of Maybe Pile.';
            } else if (t.intervalMinutes !== s.intervalMinutes)
              problem = 'Interval differs from your settings.';
            else ok = true;
          }
          break;
        }
        case 'win-login-item': {
          const li = this.d.loginItem?.get();
          isPresent = !!li?.openAtLogin;
          if (isPresent && li?.path && li.path.toLowerCase() !== exe.toLowerCase()) {
            pathChanged = true;
            problem = 'Points to an old copy of Maybe Pile.';
          } else ok = isPresent;
          break;
        }
        case 'win-aumid-shortcut':
        case 'win-protocol':
          isPresent = false;
          problem =
            c.id === 'win-aumid-shortcut' ? 'Missing Start Menu shortcut.' : 'Link handler not registered.';
          break;
        case 'linux-systemd-service': {
          isPresent = this.d.fs.exists(this.files.service);
          if (isPresent) {
            const expected = buildSystemdService({
              exePath: exe,
              helperPath: this.files.helper,
              dataDir: this.d.paths.userData,
              intervalMinutes: s.intervalMinutes,
            });
            ok = this.d.fs.read(this.files.service) === expected;
            if (!ok) {
              pathChanged = true;
              problem = 'Points to an old copy of Maybe Pile.';
            }
          }
          break;
        }
        case 'linux-systemd-timer': {
          isPresent = this.d.fs.exists(this.files.timer);
          if (isPresent) {
            ok = this.d.fs.read(this.files.timer) === buildSystemdTimer(s.intervalMinutes);
            if (!ok) problem = 'Interval differs from your settings.';
            const en = await this.run('systemctl', systemctl.isEnabled()).catch(() => ({
              code: 1,
              stdout: '',
              stderr: '',
            }));
            if (en.code !== 0) {
              ok = false;
              disabled = true;
              problem = 'The timer is disabled.';
            }
          }
          break;
        }
        case 'linux-helper-script': {
          isPresent = this.d.fs.exists(this.files.helper);
          if (isPresent) {
            try {
              ok = this.d.fs.read(this.files.helper) === this.d.fs.read(this.d.paths.helperSource);
            } catch {
              ok = false;
            }
            if (!ok) problem = 'From an older version of Maybe Pile.';
          }
          break;
        }
        case 'linux-autostart':
          isPresent = this.d.fs.exists(this.files.autostart);
          ok = isPresent && this.d.fs.read(this.files.autostart) === buildAutostartEntry(exe);
          if (isPresent && !ok) {
            pathChanged = true;
            problem = 'Points to an old copy of Maybe Pile.';
          }
          break;
        case 'linux-url-handler':
          isPresent = this.d.fs.exists(this.files.urlHandler);
          ok = isPresent && this.d.fs.read(this.files.urlHandler) === buildUrlHandlerEntry(exe);
          if (isPresent && !ok) {
            pathChanged = true;
            problem = 'Points to an old copy of Maybe Pile.';
          }
          break;
      }
      if (!isPresent && !problem) problem = 'Not installed.';
      comps.push({ id: c.id, present: isPresent, ok, problem });
    }
    const allOk = comps.every((c) => c.ok);
    const nonePresent = comps.every((c) => !c.present);
    const state: ServiceState = allOk
      ? 'healthy'
      : nonePresent
        ? 'not_installed'
        : disabled
          ? 'disabled_by_os'
          : pathChanged
            ? 'path_changed'
            : 'error';
    const message = {
      healthy: 'Installed and healthy.',
      not_installed: 'Not installed yet.',
      path_changed: 'Installed, but it points to an old copy of Maybe Pile. Repair to fix it.',
      disabled_by_os: 'Installed, but disabled by the system. Repair to turn it back on.',
      error: 'Partly installed. Repair to finish, or remove it.',
      unsupported: '',
    }[state];
    return { state, components: comps, message };
  }

  /** Re-creates everything the settings need (idempotent overwrite). */
  async repair(s: NotificationSettings) {
    return this.install(s);
  }

  async runNow(): Promise<boolean> {
    if (this.d.platform === 'win32') return (await this.run('schtasks', schtasksRunArgs())).code === 0;
    if (this.d.platform === 'linux') return (await this.run('systemctl', systemctl.runNow())).code === 0;
    return false;
  }
}

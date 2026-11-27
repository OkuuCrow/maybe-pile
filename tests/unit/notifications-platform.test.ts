import { describe, expect, it } from 'vitest';
import {
  buildGdbusNotifyArgs,
  buildNotifySendArgs,
  createLinuxNotifier,
  dbusEnv,
  gvariantString,
  markupEscape,
  parseCapabilities,
} from '../../src/notifications/adapters/linux';
import type { ExecFn } from '../../src/notifications/adapters/types';
import { buildToastXml, xmlEscape } from '../../src/notifications/adapters/windows-toast';
import type { PlannedNotification } from '../../src/notifications/engine/types';
import { parseHelperArgs } from '../../src/notifications/helper';
import { findProtocolArg, muteUrl, parseProtocolUrl, snoozeUrl } from '../../src/notifications/protocol';
import { Installer, type FsOps, type InstallerDeps } from '../../src/notifications/registration/installer';
import {
  buildAutostartEntry,
  buildSystemdService,
  buildSystemdTimer,
  buildUrlHandlerEntry,
  buildWindowsTaskXml,
  onCalendarFor,
  parseWindowsTaskXml,
  UnsafePathError,
  validatePosixPath,
  validateWindowsPath,
} from '../../src/notifications/registration/templates';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from '../../src/shared/notification-settings';
import { UUIDS } from '../helpers/notify';

const N = (over: Partial<PlannedNotification> = {}): PlannedNotification => ({
  key: 'k',
  category: 'keepGoing',
  kind: 'single',
  title: 'Pick up where you left off',
  body: 'Frieren — next: S1E12',
  itemId: UUIDS[0],
  urgency: 'low',
  scheduledFor: '2026-11-26T17:00:00.000Z',
  actions: [
    { id: 'open', label: 'Open', url: `maybepile://item/${UUIDS[0]}` },
    { id: 'snooze1h', label: 'Snooze 1 h', url: snoozeUrl({ scope: 'item', id: UUIDS[0] }, '1h') },
    { id: 'mute', label: 'Mute', url: muteUrl({ scope: 'item', id: UUIDS[0] }) },
  ],
  memberKeys: ['k'],
  members: [],
  openUrl: `maybepile://item/${UUIDS[0]}`,
  ...over,
});

describe('protocol allowlist', () => {
  it('accepts exactly the documented forms', () => {
    expect(parseProtocolUrl(`maybepile://item/${UUIDS[0]}`)).toEqual({ kind: 'item', id: UUIDS[0] });
    expect(parseProtocolUrl('maybepile://open')).toEqual({ kind: 'open' });
    expect(parseProtocolUrl(snoozeUrl({ scope: 'item', id: UUIDS[1] }, 'tomorrow'))).toEqual({
      kind: 'snooze',
      target: { scope: 'item', id: UUIDS[1] },
      duration: 'tomorrow',
    });
    expect(parseProtocolUrl(muteUrl({ scope: 'category', id: 'backup' }))).toEqual({
      kind: 'mute',
      target: { scope: 'category', id: 'backup' },
    });
    expect(parseProtocolUrl(`maybepile://action/snooze?target=reminder:${UUIDS[2]}&for=1h`)).toMatchObject({
      kind: 'snooze',
    });
  });
  it.each([
    'maybepile://action/delete?target=item:' + UUIDS[0],
    'maybepile://action/export',
    'maybepile://action/snooze?target=item:' + UUIDS[0] + '&for=999d',
    'maybepile://action/snooze?target=item:' + UUIDS[0] + '&for=1h&extra=1',
    'maybepile://action/snooze?target=item:' + UUIDS[0] + '&for=1h&for=tomorrow',
    'maybepile://action/mute?target=category:notACategory',
    'maybepile://action/mute?target=item:../../etc/passwd',
    'maybepile://item/../../secret',
    'maybepile://item/not-a-uuid',
    'maybepile://item/' + UUIDS[0] + '?x=1',
    'maybepile://item/' + UUIDS[0] + '#frag',
    'maybepile://user:pw@item/' + UUIDS[0],
    'maybepile://open/extra',
    'maybepile://settings/delete-all',
    'https://item/' + UUIDS[0],
    'javascript:alert(1)',
    'maybepile://item/' + UUIDS[0] + '\nmaybepile://action/mute',
    'maybepile://item/' + UUIDS[0] + ' ',
    'maybepile:\\\\item\\' + UUIDS[0],
    'x'.repeat(400),
    '',
  ])('rejects %s', (u) => {
    expect(parseProtocolUrl(u)).toBeNull();
  });
  it('rejects non-strings and finds the URL in argv', () => {
    expect(parseProtocolUrl(42)).toBeNull();
    expect(parseProtocolUrl(null)).toBeNull();
    expect(findProtocolArg(['app.exe', '--flag', 'MaybePile://open'])).toBe('MaybePile://open');
    expect(findProtocolArg(['app.exe'])).toBeNull();
  });
});

describe('Windows toast XML', () => {
  it('escapes all text and attributes and uses protocol activation', () => {
    const xml = buildToastXml(N({ title: 'A <b>&"x\'', body: '</text><script>' }), {
      sound: false,
      actions: true,
    });
    expect(xml).toContain('<text>A &lt;b&gt;&amp;&quot;x&apos;</text>');
    expect(xml).toContain('<text>&lt;/text&gt;&lt;script&gt;</text>');
    expect(xml).toContain(`launch="maybepile://item/${UUIDS[0]}" activationType="protocol"`);
    expect(xml).toContain(
      'arguments="maybepile://action/snooze?target=item%3A11111111-1111-4111-8111-111111111111&amp;for=1h"',
    );
    expect(xml).toContain('<audio silent="true"/>');
    expect(xml).not.toContain('content="Open"');
    expect(buildToastXml(N(), { sound: true, actions: false })).not.toContain('<actions>');
    expect(xmlEscape('a\u0001b')).toBe('ab');
  });
  it('matches the snapshot', () => {
    expect(buildToastXml(N(), { sound: true, actions: true })).toMatchSnapshot();
  });
});

describe('Linux D-Bus / notify-send', () => {
  it('builds GVariant-safe gdbus arguments (no shell, escaped quotes, markup when advertised)', () => {
    const args = buildGdbusNotifyArgs(N({ title: "It's <done>", body: 'A & B \\ C' }), {
      sound: true,
      bodyMarkup: true,
      icon: 'maybe-pile',
    });
    expect(args.slice(0, 2)).toEqual(['call', '--session']);
    expect(args).toContain("'It\\'s <done>'");
    expect(args).toContain("'A &amp; B \\\\ C'");
    expect(args).toContain('@as []');
    expect(args.find((a) => a.startsWith('{'))).toBe(
      "{'desktop-entry': <'maybe-pile'>, 'urgency': <byte 0>}",
    );
    const silent = buildGdbusNotifyArgs(N(), { sound: false, bodyMarkup: false, icon: 'x' });
    expect(silent.find((a) => a.startsWith('{'))).toContain("'suppress-sound': <true>");
    expect(gvariantString('a\u0007b')).toBe("'a\\u0007b'");
    expect(markupEscape('<&>')).toBe('&lt;&amp;&gt;');
  });
  it('notify-send fallback uses an argument array with -- before user text', () => {
    const args = buildNotifySendArgs(N({ title: '--help', body: '<i>x</i> & y' }), { icon: 'maybe-pile' });
    expect(args.indexOf('--')).toBe(args.length - 3);
    expect(args.at(-2)).toBe('--help');
    expect(args.at(-1)).toBe('‹i›x‹/i› ＆ y');
    expect(args).toContain('--hint=string:desktop-entry:maybe-pile');
  });
  it('parses capabilities and fills the bus address from XDG_RUNTIME_DIR', () => {
    expect(parseCapabilities("(['actions', 'body', 'body-markup', 'persistence', 'icon-static'],)")).toEqual({
      actions: true,
      bodyMarkup: true,
      persistent: true,
      icon: true,
    });
    expect(dbusEnv({ XDG_RUNTIME_DIR: '/run/user/1000' }, () => true)['DBUS_SESSION_BUS_ADDRESS']).toBe(
      'unix:path=/run/user/1000/bus',
    );
    expect(dbusEnv({ DBUS_SESSION_BUS_ADDRESS: 'x' }, () => true)['DBUS_SESSION_BUS_ADDRESS']).toBe('x');
    expect(dbusEnv({}, () => true)['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined();
  });
  it('detects "no notification daemon" and falls back to notify-send when gdbus is missing', async () => {
    const calls: string[][] = [];
    const noDaemon: ExecFn = async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes('org.freedesktop.DBus.NameHasOwner'))
        return { code: 0, stdout: '(false,)', stderr: '' };
      if (args.includes('org.freedesktop.DBus.ListActivatableNames'))
        return { code: 0, stdout: "(['org.gnome.Foo'],)", stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const n1 = createLinuxNotifier({ exec: noDaemon, env: {} });
    expect(await n1.probe()).toMatchObject({
      available: false,
      reason: expect.stringMatching(/No notification service/),
    });
    expect(await n1.show(N(), { sound: true })).toMatchObject({ status: 'unsupported' });
    expect(calls.some((c) => c.includes('org.freedesktop.Notifications.Notify'))).toBe(false);

    const sent: string[][] = [];
    const noGdbus: ExecFn = async (file, args) => {
      if (file === 'gdbus') throw new Error('ENOENT');
      sent.push([file, ...args]);
      return { code: 0, stdout: 'notify-send 0.8.3', stderr: '' };
    };
    const n2 = createLinuxNotifier({ exec: noGdbus, env: {} });
    expect(await n2.show(N(), { sound: true })).toEqual({ status: 'delivered' });
    expect(sent.at(-1)?.[0]).toBe('notify-send');
  });
  it('delivers through gdbus when a daemon is present (actions never offered headless)', async () => {
    const sent: string[][] = [];
    const ok: ExecFn = async (file, args) => {
      sent.push([file, ...args]);
      if (args.includes('org.freedesktop.DBus.NameHasOwner'))
        return { code: 0, stdout: '(true,)', stderr: '' };
      if (args.includes('org.freedesktop.Notifications.GetCapabilities'))
        return { code: 0, stdout: "(['actions', 'body'],)", stderr: '' };
      return { code: 0, stdout: '(uint32 7,)', stderr: '' };
    };
    const n = createLinuxNotifier({ exec: ok, env: {} });
    expect((await n.probe()).capabilities.actions).toBe(false);
    expect(await n.show(N(), { sound: true })).toEqual({ status: 'delivered' });
    expect(sent.at(-1)).toContain('org.freedesktop.Notifications.Notify');
  });
});

describe('helper arguments', () => {
  it('accepts only known flags and a safe absolute data dir', () => {
    expect(parseHelperArgs(['--reminder-check', '--data-dir', '/home/u/.config/MaybePile'])).toEqual({
      dataDir: '/home/u/.config/MaybePile',
      dryRun: false,
    });
    expect(parseHelperArgs(['--reminder-check', '--dry-run'])).toEqual({ dataDir: null, dryRun: true });
    expect(parseHelperArgs(['--data-dir', 'relative/path'])).toBeNull();
    expect(parseHelperArgs(['--data-dir', '/x\n/y'])).toBeNull();
    expect(parseHelperArgs(['--data-dir'])).toBeNull();
    expect(parseHelperArgs(['--evil'])).toBeNull();
  });
});

describe('registration templates', () => {
  const WIN_EXE = 'C:\\Users\\Ann\\AppData\\Local\\Programs\\Maybe Pile\\Maybe Pile.exe';
  it('Windows task XML (snapshot) round-trips through the parser', () => {
    const xml = buildWindowsTaskXml({
      exePath: WIN_EXE,
      intervalMinutes: 15,
      startBoundary: '2026-01-01T00:00:00',
      author: 'Maybe Pile',
    });
    expect(xml).toMatchSnapshot();
    expect(parseWindowsTaskXml(xml)).toEqual({
      command: WIN_EXE,
      args: '--reminder-check',
      intervalMinutes: 15,
      enabled: true,
    });
    expect(
      parseWindowsTaskXml(
        xml.replace('<Enabled>true</Enabled>\n    <Hidden>', '<Enabled>false</Enabled>\n    <Hidden>'),
      ).enabled,
    ).toBe(false);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<ExecutionTimeLimit>PT1M</ExecutionTimeLimit>');
  });
  it('systemd units, autostart and URL handler (snapshots)', () => {
    const spec = {
      exePath: '/opt/Maybe Pile/maybe-pile',
      helperPath: '/home/ann/.config/MaybePile/helper/reminder-check.cjs',
      dataDir: '/home/ann/.config/MaybePile',
      intervalMinutes: 15,
    };
    expect(buildSystemdService(spec)).toMatchSnapshot();
    expect(buildSystemdTimer(15)).toMatchSnapshot();
    expect(buildAutostartEntry('/opt/Maybe Pile/maybe-pile')).toMatchSnapshot();
    expect(buildUrlHandlerEntry('/home/ann/Apps/Maybe-Pile.AppImage')).toContain(
      'MimeType=x-scheme-handler/maybepile;',
    );
    expect(buildSystemdService(spec)).toContain('Environment=ELECTRON_RUN_AS_NODE=1');
    expect(onCalendarFor(60)).toBe('*-*-* *:00:00');
    expect(onCalendarFor(5)).toBe('*-*-* *:0/5:00');
  });
  it.each([
    '/opt/evil"; rm -rf ~;"/x',
    '/opt/a\nExecStart=/bin/sh',
    '/opt/$(whoami)',
    '/opt/`id`',
    '/opt/100%/x',
    '/opt/../../etc/x',
    'relative/maybe-pile',
    "/opt/it's",
  ])('refuses hostile Linux path %j', (p) => {
    expect(() => validatePosixPath(p, 'application')).toThrow(UnsafePathError);
  });
  it.each(['C:\\x"\\y.exe', 'C:\\a\r\nb.exe', 'relative\\x.exe', 'C:\\a|b.exe', 'C:\\a<b.exe'])(
    'refuses hostile Windows path %j',
    (p) => {
      expect(() => validateWindowsPath(p, 'application')).toThrow(UnsafePathError);
    },
  );
});

/* ------------------------------------------------------------------ installer with fakes */

function memFs(): FsOps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d) => void files.set(p, typeof d === 'string' ? d : Buffer.from(d).toString('latin1')),
    mkdir: () => undefined,
    remove: (p) => void files.delete(p),
    copy: (s, d) => void files.set(d, files.get(s) ?? ''),
  };
}

function linuxEnv(opts: { systemd?: boolean; appImage?: boolean; exe?: string } = {}) {
  const fs = memFs();
  fs.files.set('/opt/app/helper.cjs', 'HELPER v1');
  const calls: string[][] = [];
  let enabled = false;
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'systemctl') {
      if (args.includes('is-system-running'))
        return opts.systemd === false
          ? { code: 1, stdout: '', stderr: 'Failed to connect to bus' }
          : { code: 0, stdout: 'running', stderr: '' };
      if (args.includes('enable')) enabled = true;
      if (args.includes('disable')) enabled = false;
      if (args.includes('is-enabled'))
        return { code: enabled ? 0 : 1, stdout: enabled ? 'enabled' : 'disabled', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps: InstallerDeps = {
    platform: 'linux',
    exec,
    fs,
    paths: {
      userData: '/home/ann/.config/MaybePile',
      home: '/home/ann',
      exePath: opts.exe ?? '/opt/Maybe Pile/maybe-pile',
      isAppImage: !!opts.appImage,
      isPortable: false,
      helperSource: '/opt/app/helper.cjs',
      tempDir: '/tmp/mp',
      startMenuDir: '',
    },
    appUserModelId: 'app.maybepile.desktop',
    author: 'Maybe Pile',
  };
  return { deps, fs, calls, installer: new Installer(deps) };
}

const scheduled: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, mode: 'scheduled' };
const tray: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, mode: 'tray', startAtLogin: true };

describe('installer (fake OS)', () => {
  it('fresh settings plan nothing; enabling scheduled plans exactly the listed files', () => {
    const { installer } = linuxEnv();
    expect(installer.plan(DEFAULT_NOTIFICATION_SETTINGS)).toEqual([]);
    const plan = installer.plan(scheduled);
    expect(plan.map((c) => c.id)).toEqual([
      'linux-helper-script',
      'linux-systemd-service',
      'linux-systemd-timer',
    ]);
    expect(plan.map((c) => c.location)).toEqual([
      '/home/ann/.config/MaybePile/helper/reminder-check.cjs',
      '/home/ann/.config/systemd/user/maybe-pile-reminders.service',
      '/home/ann/.config/systemd/user/maybe-pile-reminders.timer',
    ]);
  });
  it('installs, reports healthy, detects path change and repairs, then removes with verification', async () => {
    const env = linuxEnv();
    const r = await env.installer.install(scheduled);
    expect(r).toEqual({
      ok: true,
      created: ['linux-helper-script', 'linux-systemd-service', 'linux-systemd-timer'],
      error: null,
    });
    // The files written are exactly the ones the confirmation dialog listed.
    for (const c of env.installer.plan(scheduled)) expect(env.fs.exists(c.location)).toBe(true);
    expect(env.calls).toContainEqual([
      'systemctl',
      '--user',
      'enable',
      '--now',
      'maybe-pile-reminders.timer',
    ]);
    expect((await env.installer.status(scheduled)).state).toBe('healthy');

    const moved = linuxEnv({ exe: '/opt/New Place/maybe-pile' });
    for (const [k, v] of env.fs.files) moved.fs.files.set(k, v);
    await moved.deps.exec('systemctl', ['--user', 'enable', '--now', 'maybe-pile-reminders.timer']);
    const st = await moved.installer.status(scheduled);
    expect(st.state).toBe('path_changed');
    await moved.installer.repair(scheduled);
    expect((await moved.installer.status(scheduled)).state).toBe('healthy');

    const rm = await moved.installer.removeAll();
    expect(rm.verified).toBe(true);
    expect(rm.remaining).toEqual([]);
    expect([...moved.fs.files.keys()]).toEqual(['/opt/app/helper.cjs']);
  });
  it('switching modes removes the old components', async () => {
    const env = linuxEnv();
    await env.installer.install(scheduled);
    await env.installer.install(tray);
    expect(env.fs.exists(env.installer.files.timer)).toBe(false);
    expect(env.fs.exists(env.installer.files.autostart)).toBe(true);
    expect(env.fs.read(env.installer.files.autostart)).toBe(
      buildAutostartEntry('/opt/Maybe Pile/maybe-pile'),
    );
  });
  it('rolls back on failure (no systemd user session) and leaves nothing half-installed', async () => {
    const env = linuxEnv({ systemd: false });
    const r = await env.installer.install(scheduled);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No systemd user session/);
    expect([...env.fs.files.keys()]).toEqual(['/opt/app/helper.cjs']);
  });
  it('AppImage adds a URL handler; hostile paths are refused before anything is written', async () => {
    const env = linuxEnv({ appImage: true, exe: '/home/ann/Apps/Maybe-Pile.AppImage' });
    expect(env.installer.plan(scheduled).map((c) => c.id)).toContain('linux-url-handler');
    const bad = linuxEnv({ exe: '/home/ann/$(evil)/maybe-pile' });
    expect(() => bad.installer.plan(scheduled)).toThrow(UnsafePathError);
    const r = await bad.installer.install(scheduled);
    expect(r.ok).toBe(false);
    expect([...bad.fs.files.keys()]).toEqual(['/opt/app/helper.cjs']);
  });
  it('a disabled timer reports "disabled by OS"; an outdated helper script is detected', async () => {
    const env = linuxEnv();
    await env.installer.install(scheduled);
    await env.deps.exec('systemctl', ['--user', 'disable', '--now', 'maybe-pile-reminders.timer']);
    expect((await env.installer.status(scheduled)).state).toBe('disabled_by_os');
    await env.installer.repair(scheduled);
    env.fs.files.set('/opt/app/helper.cjs', 'HELPER v2');
    const st = await env.installer.status(scheduled);
    expect(st.components.find((c) => c.id === 'linux-helper-script')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/older version/),
    });
  });

  it('Windows: task XML via schtasks, login item, AUMID shortcut; removal verified by re-query', async () => {
    const fs = memFs();
    const calls: string[][] = [];
    let task: string | null = null;
    let login = { openAtLogin: false, path: null as string | null, args: [] as string[] };
    let shortcut: { target: string; appUserModelId: string | null } | null = null;
    const exe = 'C:\\Program Files\\Maybe Pile\\Maybe Pile.exe';
    const exec: ExecFn = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === '/Create') {
        const raw = fs.files.get(args[4]!) ?? '';
        task = Buffer.from(raw, 'latin1').subarray(2).toString('utf16le');
        return { code: 0, stdout: 'SUCCESS', stderr: '' };
      }
      if (args[0] === '/Query')
        return task ? { code: 0, stdout: task, stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR' };
      if (args[0] === '/Delete') {
        task = null;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const installer = new Installer({
      platform: 'win32',
      exec,
      fs,
      paths: {
        userData: 'C:\\u',
        home: 'C:\\h',
        exePath: exe,
        isAppImage: false,
        isPortable: false,
        helperSource: '',
        tempDir: 'C:\\t',
        startMenuDir: 'C:\\sm',
      },
      loginItem: {
        get: () => login,
        set: (open, path, args) => void (login = { openAtLogin: open, path, args }),
      },
      shortcut: {
        read: () => shortcut,
        write: (_p, target) => ((shortcut = { target, appUserModelId: 'app.maybepile.desktop' }), true),
      },
      appUserModelId: 'app.maybepile.desktop',
      author: 'Maybe Pile',
    });
    const both: NotificationSettings = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      mode: 'tray',
      alsoScheduled: true,
      startAtLogin: true,
    };
    expect(installer.plan(both).map((c) => c.id)).toEqual([
      'win-task',
      'win-login-item',
      'win-aumid-shortcut',
    ]);
    expect((await installer.install(both)).ok).toBe(true);
    expect(calls.find((c) => c[1] === '/Create')?.slice(0, 4)).toEqual([
      'schtasks',
      '/Create',
      '/TN',
      'MaybePile\\ReminderCheck',
    ]);
    expect([...fs.files.keys()]).toEqual([]); // temp XML removed
    expect(login).toEqual({ openAtLogin: true, path: exe, args: ['--hidden'] });
    expect((await installer.status(both)).state).toBe('healthy');
    const rm = await installer.removeAll();
    expect(rm).toEqual({ removed: ['win-task', 'win-login-item'], verified: true, remaining: [] });
    expect(shortcut).not.toBeNull(); // the Start Menu shortcut is the user's normal entry — kept
  });

  it('macOS is reported unsupported (no launchd scheduler in this pack)', async () => {
    const env = linuxEnv();
    const mac = new Installer({ ...env.deps, platform: 'darwin' });
    expect(mac.plan(scheduled)).toEqual([]);
    expect((await mac.status(scheduled)).state).toBe('unsupported');
  });
});

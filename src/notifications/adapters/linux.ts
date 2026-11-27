/**
 * Display-free Linux delivery for the headless helper.
 *
 * Primary: `gdbus` (ships with GLib on practically every desktop) calling
 * org.freedesktop.Notifications.Notify on the session bus. Fallback:
 * `notify-send` (libnotify). Both are invoked with argument arrays, never a
 * shell. We deliberately did not add a JS D-Bus dependency (decision recorded
 * in docs/product-decisions.md).
 *
 * The helper exits right after sending, so it cannot receive ActionInvoked
 * signals: no action buttons are sent from this path. The `desktop-entry`
 * hint lets the shell attribute (and, on most shells, activate) Maybe Pile.
 */
import type { PlannedNotification } from '../engine/types';
import { NO_CAPABILITIES, type Capabilities, type DeliveryResult, type ExecFn, type Notifier } from './types';

export const DESKTOP_ENTRY_ID = 'maybe-pile';
export const APP_NAME = 'Maybe Pile';
const DEST = [
  '--session',
  '--dest',
  'org.freedesktop.Notifications',
  '--object-path',
  '/org/freedesktop/Notifications',
];

/** GVariant text-format string literal (single-quoted, backslash escapes). */
export function gvariantString(s: string): string {
  let out = "'";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}'`;
}

/** Escapes the three markup characters for servers that advertise `body-markup`. */
export function markupEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** When capabilities are unknown (notify-send), replace markup characters with look-alikes. */
export function markupNeutralize(s: string): string {
  return s.replace(/&/g, '＆').replace(/</g, '‹').replace(/>/g, '›');
}

export function buildGdbusNotifyArgs(
  n: PlannedNotification,
  opts: { sound: boolean; bodyMarkup: boolean; icon: string; expireMs?: number },
): string[] {
  const body = opts.bodyMarkup ? markupEscape(n.body) : n.body;
  const hints = [
    `'desktop-entry': <${gvariantString(DESKTOP_ENTRY_ID)}>`,
    `'urgency': <byte ${n.urgency === 'normal' ? 1 : 0}>`,
    ...(opts.sound ? [] : [`'suppress-sound': <true>`]),
  ];
  return [
    'call',
    ...DEST,
    '--method',
    'org.freedesktop.Notifications.Notify',
    gvariantString(APP_NAME),
    '0',
    gvariantString(opts.icon),
    gvariantString(n.title),
    gvariantString(body),
    '@as []',
    `{${hints.join(', ')}}`,
    String(opts.expireMs ?? -1),
  ];
}

export function buildNotifySendArgs(n: PlannedNotification, opts: { icon: string }): string[] {
  return [
    `--app-name=${APP_NAME}`,
    `--icon=${opts.icon}`,
    `--hint=string:desktop-entry:${DESKTOP_ENTRY_ID}`,
    `--urgency=${n.urgency === 'normal' ? 'normal' : 'low'}`,
    '--',
    markupNeutralize(n.title),
    markupNeutralize(n.body),
  ];
}

/** Parses `gdbus` output like `(['actions', 'body', 'body-markup'],)`. */
export function parseCapabilities(stdout: string): Capabilities {
  const caps = new Set([...stdout.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
  return {
    actions: caps.has('actions'),
    bodyMarkup: caps.has('body-markup'),
    persistent: caps.has('persistence'),
    icon: caps.has('icon-static') || caps.has('icon-multi'),
  };
}

/**
 * Environment for D-Bus from a systemd user service: if the bus address is
 * missing but XDG_RUNTIME_DIR is known, use the standard user bus socket.
 */
export function dbusEnv(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): NodeJS.ProcessEnv {
  if (env['DBUS_SESSION_BUS_ADDRESS']) return env;
  const rt = env['XDG_RUNTIME_DIR'];
  if (rt && /^\/[^\0\n]*$/.test(rt) && exists(`${rt}/bus`))
    return { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${rt}/bus` };
  return env;
}

export function createLinuxNotifier(deps: { exec: ExecFn; env: NodeJS.ProcessEnv; icon?: string }): Notifier {
  const icon = deps.icon ?? DESKTOP_ENTRY_ID;
  let probed: {
    available: boolean;
    reason: string | null;
    capabilities: Capabilities;
    via: 'gdbus' | 'notify-send' | null;
  } | null = null;
  const run = (file: string, args: string[]) => deps.exec(file, args, { timeoutMs: 5_000, env: deps.env });

  async function probe() {
    if (probed) return probed;
    try {
      const has = await run('gdbus', [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        "'org.freedesktop.Notifications'",
      ]);
      if (has.code === 0) {
        let available = /true/.test(has.stdout);
        if (!available) {
          const act = await run('gdbus', [
            'call',
            '--session',
            '--dest',
            'org.freedesktop.DBus',
            '--object-path',
            '/org/freedesktop/DBus',
            '--method',
            'org.freedesktop.DBus.ListActivatableNames',
          ]);
          available = act.code === 0 && act.stdout.includes("'org.freedesktop.Notifications'");
        }
        if (!available) {
          probed = {
            available: false,
            reason: 'No notification service is running on the session bus.',
            capabilities: NO_CAPABILITIES,
            via: null,
          };
          return probed;
        }
        const caps = await run('gdbus', [
          ...['call', ...DEST],
          '--method',
          'org.freedesktop.Notifications.GetCapabilities',
        ]);
        probed = {
          available: true,
          reason: null,
          capabilities:
            caps.code === 0 ? { ...parseCapabilities(caps.stdout), actions: false } : NO_CAPABILITIES,
          via: 'gdbus',
        };
        return probed;
      }
      if (/connect|bus|address/i.test(has.stderr)) {
        probed = {
          available: false,
          reason: 'No D-Bus session bus is available.',
          capabilities: NO_CAPABILITIES,
          via: null,
        };
        return probed;
      }
    } catch {
      /* gdbus missing → try notify-send */
    }
    try {
      const v = await run('notify-send', ['--version']);
      if (v.code === 0) {
        probed = { available: true, reason: null, capabilities: NO_CAPABILITIES, via: 'notify-send' };
        return probed;
      }
    } catch {
      /* fall through */
    }
    probed = {
      available: false,
      reason: 'Neither gdbus nor notify-send is available.',
      capabilities: NO_CAPABILITIES,
      via: null,
    };
    return probed;
  }

  return {
    id: 'linux-dbus',
    async probe() {
      const p = await probe();
      return { available: p.available, reason: p.reason, capabilities: p.capabilities };
    },
    async show(n, opts): Promise<DeliveryResult> {
      const p = await probe();
      if (!p.available || !p.via) return { status: 'unsupported', reason: p.reason ?? 'unavailable' };
      try {
        const r =
          p.via === 'gdbus'
            ? await run(
                'gdbus',
                buildGdbusNotifyArgs(n, { sound: opts.sound, bodyMarkup: p.capabilities.bodyMarkup, icon }),
              )
            : await run('notify-send', buildNotifySendArgs(n, { icon }));
        return r.code === 0
          ? { status: 'delivered' }
          : { status: 'failed', reason: `${p.via} exit ${r.code}` };
      } catch {
        return { status: 'failed', reason: `${p.via} could not run` };
      }
    },
  };
}

/** In-memory notifier for tests and dry runs. */
export function createRecordingNotifier(id = 'recording', result: DeliveryResult = { status: 'delivered' }) {
  const shown: PlannedNotification[] = [];
  const notifier: Notifier = {
    id,
    probe: async () => ({
      available: true,
      reason: null,
      capabilities: { actions: true, bodyMarkup: false, persistent: true, icon: true },
    }),
    show: async (n) => {
      if (result.status === 'delivered') shown.push(n);
      return result;
    },
  };
  return { notifier, shown };
}

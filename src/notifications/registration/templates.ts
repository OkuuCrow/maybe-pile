/**
 * Fixed templates for background components. Every path is validated, then
 * escaped for its target format. Paths with control characters, double
 * quotes or (Linux) unusual characters are refused rather than "fixed".
 * Nothing here runs anything; installer.ts executes with argument arrays.
 */
import { xmlEscape } from '../adapters/windows-toast';

export const WIN_TASK_NAME = 'MaybePile\\ReminderCheck';
export const SYSTEMD_UNIT = 'maybe-pile-reminders';
export const AUTOSTART_FILE = 'maybe-pile.desktop';
export const URL_HANDLER_FILE = 'maybe-pile-url-handler.desktop';
export const HELPER_SCRIPT = 'reminder-check.cjs';
export const HIDDEN_ARG = '--hidden';
export const CHECK_ARG = '--reminder-check';

export class UnsafePathError extends Error {
  constructor(what: string) {
    super(`The ${what} path contains characters Maybe Pile does not register background tasks for.`);
    this.name = 'UnsafePathError';
  }
}

/** Windows: absolute drive or UNC path, no control chars / quotes / wildcards / redirection characters. */
export function validateWindowsPath(p: string, what: string): string {
  // eslint-disable-next-line no-control-regex
  if (p.length === 0 || p.length > 400 || /[\u0000-\u001F"<>|*?]/.test(p)) throw new UnsafePathError(what);
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\)/.test(p)) throw new UnsafePathError(what);
  return p;
}

/** Linux: absolute, printable, no quotes/backslashes/backticks/$/% (keeps unit + desktop escaping trivial). */
export function validatePosixPath(p: string, what: string): string {
  // eslint-disable-next-line no-control-regex
  if (p.length === 0 || p.length > 400 || !p.startsWith('/') || /[\u0000-\u001F\u007F"'`$%\\]/.test(p))
    throw new UnsafePathError(what);
  if (p.split('/').some((seg) => seg === '..')) throw new UnsafePathError(what);
  return p;
}

/* ------------------------------------------------------------------ Windows */

export interface WinTaskSpec {
  exePath: string;
  intervalMinutes: number;
  /** Fixed start boundary (local time, no zone) so the XML is deterministic for a given install. */
  startBoundary: string;
  author: string;
}

/**
 * Per-user Task Scheduler task. TimeTrigger + indefinite repetition (a
 * LogonTrigger for "any user" would need admin rights). Interactive token =
 * "run only when the user is logged on"; hidden; IgnoreNew (never stacks);
 * runs on battery; starts when available after a missed run; 1-minute limit.
 */
export function buildWindowsTaskXml(spec: WinTaskSpec): string {
  const exe = validateWindowsPath(spec.exePath, 'application');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(spec.startBoundary))
    throw new Error('bad start boundary');
  const interval = Math.max(5, Math.min(60, Math.round(spec.intervalMinutes)));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xmlEscape(spec.author)}</Author>
    <Description>Maybe Pile reminder check (created at your request in Settings → Notifications; remove it there).</Description>
    <URI>\\${xmlEscape(WIN_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${interval}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${spec.startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(exe)}</Command>
      <Arguments>${CHECK_ARG}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Reads the fields we verify (command, arguments, interval, enabled) from `schtasks /Query /XML` output. */
export function parseWindowsTaskXml(xml: string): {
  command: string | null;
  args: string | null;
  intervalMinutes: number | null;
  enabled: boolean;
} {
  const tag = (name: string) => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
    return m?.[1] !== undefined
      ? m[1]
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
      : null;
  };
  const interval = /<Interval>PT(\d+)M<\/Interval>/.exec(xml);
  const settings = /<Settings>[\s\S]*?<\/Settings>/.exec(xml)?.[0] ?? '';
  return {
    command: tag('Command'),
    args: tag('Arguments'),
    intervalMinutes: interval ? Number(interval[1]) : null,
    enabled: !/<Enabled>false<\/Enabled>/.test(settings),
  };
}

export const schtasksCreateArgs = (xmlFile: string) => [
  '/Create',
  '/TN',
  WIN_TASK_NAME,
  '/XML',
  xmlFile,
  '/F',
];
export const schtasksDeleteArgs = () => ['/Delete', '/TN', WIN_TASK_NAME, '/F'];
export const schtasksQueryArgs = () => ['/Query', '/TN', WIN_TASK_NAME, '/XML'];
export const schtasksRunArgs = () => ['/Run', '/TN', WIN_TASK_NAME];

/* ------------------------------------------------------------------ Linux */

/** systemd ExecStart= word quoting (paths were validated to contain no quotes, %, $ or backslashes). */
const sq = (p: string) => `"${p}"`;

export interface LinuxHelperSpec {
  /** The Electron binary (deb/rpm) or the AppImage file ($APPIMAGE). */
  exePath: string;
  /** Copied helper script in the user-data folder. */
  helperPath: string;
  dataDir: string;
  intervalMinutes: number;
}

export function buildSystemdService(spec: LinuxHelperSpec): string {
  const exe = validatePosixPath(spec.exePath, 'application');
  const helper = validatePosixPath(spec.helperPath, 'helper script');
  const data = validatePosixPath(spec.dataDir, 'data folder');
  return `# Created by Maybe Pile (Settings → Notifications → Wake on schedule). Remove it there.
[Unit]
Description=Maybe Pile reminder check
After=graphical-session.target

[Service]
Type=oneshot
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=${sq(exe)} ${sq(helper)} ${CHECK_ARG} --data-dir ${sq(data)}
TimeoutStartSec=30
Nice=10
NoNewPrivileges=true
`;
}

export function onCalendarFor(intervalMinutes: number): string {
  const m = Math.max(5, Math.min(60, Math.round(intervalMinutes)));
  return m >= 60 ? '*-*-* *:00:00' : `*-*-* *:0/${m}:00`;
}

export function buildSystemdTimer(intervalMinutes: number): string {
  return `# Created by Maybe Pile (Settings → Notifications → Wake on schedule). Remove it there.
[Unit]
Description=Maybe Pile reminder check (every ${Math.round(intervalMinutes)} min)

[Timer]
OnCalendar=${onCalendarFor(intervalMinutes)}
Persistent=true
AccuracySec=1min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`;
}

/** Desktop Entry Exec= quoting: reserved characters inside double quotes; paths are pre-validated. */
const dq = (p: string) => `"${p}"`;

export function buildAutostartEntry(exePath: string): string {
  const exe = validatePosixPath(exePath, 'application');
  return `[Desktop Entry]
Type=Application
Name=Maybe Pile (background reminders)
Comment=Keeps Maybe Pile in the tray so reminders can arrive. Created at your request; remove it in Settings → Notifications.
Exec=${dq(exe)} ${HIDDEN_ARG}
Icon=maybe-pile
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

/** URL handler for AppImage builds (deb/rpm register x-scheme-handler/maybepile in their own .desktop file). */
export function buildUrlHandlerEntry(exePath: string): string {
  const exe = validatePosixPath(exePath, 'application');
  return `[Desktop Entry]
Type=Application
Name=Maybe Pile
Comment=Opens Maybe Pile from notification links
Exec=${dq(exe)} %U
Icon=maybe-pile
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/maybepile;
`;
}

export const systemctl = {
  reload: () => ['--user', 'daemon-reload'],
  enable: () => ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`],
  disable: () => ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`],
  isEnabled: () => ['--user', 'is-enabled', `${SYSTEMD_UNIT}.timer`],
  isActive: () => ['--user', 'is-active', `${SYSTEMD_UNIT}.timer`],
  probe: () => ['--user', 'is-system-running'],
  runNow: () => ['--user', 'start', `${SYSTEMD_UNIT}.service`],
};

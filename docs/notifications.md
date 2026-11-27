# Notifications and reminders (2.1)

Gentle, occasional reminders about what you are watching, playing and reading — plus a few other
useful notices (releases, leaving-soon dates, goal pace, digests, backups). **Everything is off by
default.** Nothing is installed, scheduled or started at login until you turn it on and confirm a
dialog that lists exactly what will be created.

Supported platforms: **Windows** and **Linux**. macOS: only “While the app is open” and the tray mode
exist (the code path is shared) and they are **untested/unsupported**; there is no launchd scheduler.

## Delivery modes — what runs when

| Mode | App window open | Window closed, app in tray | App fully quit | Installs |
| --- | --- | --- | --- | --- |
| **Off** (default) | nothing | — | nothing | nothing |
| **While the app is open** | in-app engine → OS notification | (closing the window quits) | nothing | nothing |
| **Keep running in the background (tray)** | in-app engine | main process keeps checking every 5 min (+ on resume, unlock, clock change) | nothing | optional login item (`--hidden`) |
| **Wake on schedule** | in-app engine | — | OS scheduler starts a short headless check every N min (5–60, default 15), which shows due reminders and exits | per-user scheduled task (Windows) / systemd user timer (Linux) |
| Tray **+** “also wake on schedule” | in-app | resident | scheduled helper | both |

All modes share one engine and one claim table, so running several at once never produces
duplicates (see *Exactly-once* below). Changing mode removes the components the old mode needed.

Recommendation shown in the app: tray (instant, click-to-open) or wake-on-schedule (works when the
app is closed, nothing runs in between, slightly fewer click actions).

## Categories and defaults

Every category is off until enabled; when enabled these defaults apply (all editable in
Settings → Notifications; times are local).

| Category | Trigger (default) | Quiet hours | Example (“Show titles”) |
| --- | --- | --- | --- |
| Custom reminders | your own once/repeating reminders | defer | “Start Disco Elysium” |
| Session still running | timer longer than 4 h | **drop** | “Still playing Elden Ring? Timer is at 4 h” |
| Releases | release day and 1 day before, 09:00; anime next episode at its airing time | defer | “Dune: Part Three releases tomorrow” |
| Leaving soon | 7 days and 1 day before `available_until` (subscription entries), 10:00 | defer | “Severance leaves Apple TV+ in 3 days” |
| Get it back (loans) | due date, 10:00; Sunday digest of overdue loans | defer | “Dune is due back today.” |
| Keep going | In Progress, no progress for ≥ 3 days; daily 18:00; same item at most every 3 days | defer | “Frieren — next: S1E12 · 2 more in progress” |
| Up Next digest | weekly Saturday 09:00 (or daily), top 3 | defer | “Hades II, Dune, Severance” |
| Daily time goal | daily 20:00 if a daily time goal is not met | defer | “Reading time: 12 of 30 minutes today…” |
| Goals pace | Sunday 17:00 if a goal is behind pace (neutral wording) | defer | “Reading goal: 9 of 24 items · slightly behind pace” |
| Backup reminder | Sunday 12:00 if the last backup is ≥ 30 days old (or the backup folder is on the same drive) | defer | “Your last Maybe Pile backup was 34 days ago.” |
| Pile health | Sunday 11:00 if items are stale | defer | “5 items haven't moved in 2 months.” |
| Weekly summary | Sunday 19:00 | defer | “This week: 2 finished · 3 in progress” |
| Library check-up | Sunday 13:00 if the last check-up is ≥ 30 days old | defer | “A quick check-up looks for problems…” |
| Offline queue finished | when queued lookups finish | **drop** | “3 items you added offline have details ready to review.” |
| Automatic changes | daily 19:00 if rules changed something | defer | “2 items changed by your automatic rules today…” |

Thresholds per category: Keep going = days without progress; Releases = lead days; Leaving soon =
first reminder days before; Backup / Check-up = days since the last one; Session = hours.

No category was skipped: every feature they depend on exists in this codebase.

### Simple Mode presets (“How often”)

| Preset | Categories on | Daily cap | Keep going after |
| --- | --- | --- | --- |
| Rarely | custom, releases, keep going, backup | 2 | 7 days |
| Sometimes (default when turned on) | + Up Next, leaving soon, goals pace, session running, loans | 4 | 3 days |
| Often | + pile health, weekly summary, daily time goal | 6 | 2 days |

Presets only switch categories on/off and set the cap; per-category times and privacy are kept.
If you customized categories in Advanced, switching a preset asks first (with “Don't ask again”).

## How the engine decides (`src/notifications/engine/`)

Pure and deterministic (clock + time zone injected), in this order:

1. mode off / global pause → nothing;
2. category enabled → its schedule and threshold produce *candidates* with a stable dedupe key
   (`category:scope:occurrence`, e.g. `keepGoing:2026-11-26`);
3. due, not expired, not already claimed;
4. per-item, per-category and per-reminder mutes and snoozes; per-item cooldowns;
5. quiet hours + allowed weekdays: deferrable candidates are **held** (not claimed) and delivered as
   one “While quiet hours were on” summary when quiet time ends; drop-policy categories are recorded
   as *skipped (quiet hours)*;
6. freshness: something due longer ago than ~2× the check interval (the computer was asleep/off) is
   *missed*: **Catch up** (default) shows at most one “While you were away” summary for items due in
   the last 24 h; **Skip missed** records them as skipped;
7. per-category daily cap, then the global daily cap (default 5); the overflow is coalesced into one
   “More from Maybe Pile” digest; with no room left, items are recorded as *skipped (daily limit)*;
8. text at the privacy level, plain text only, control/bidi characters stripped, length-capped.

## Privacy levels

Global setting with per-category override: **Show titles** (default), **Hide titles (generic
text)**, **Count only**. Default reasoning is in `product-decisions.md` (reminders are only useful if
they say what to pick up); Settings shows a lock-screen hint and a one-click “Hide titles instead”,
and every category card shows a live preview of the exact text.

Always: no notes, ratings or prices; adult-flagged items use generic text; Spoiler Shield wins
(next episode / next step hidden for shielded items; next step hidden when marked spoilery);
people's names (loans) only with “Show people's names”.

## Exactly-once delivery (`notify-state.sqlite`)

A small database in the user-data folder, owned by the notification subsystem and shared by the app
and the helper (WAL, busy timeout, tiny transactions). Before showing anything a runner claims every
dedupe key of the notification in one `BEGIN IMMEDIATE` transaction; if any key is taken (another
mode or an overlapping run), it shows nothing. A failed delivery is retried with backoff (5 min,
30 min, 2 h), at most 3 attempts. A lease row keeps scheduled checks from overlapping. Log retention
default 90 days. It also stores snoozes, mutes and the global pause (all modes and the helper respect
them). If it cannot be opened, notifications degrade to off with a visible status; the app keeps working.

Not included in backups or exports (runtime state).

## The helper (scheduled mode)

| | Windows | Linux |
| --- | --- | --- |
| Entry | the installed `Maybe Pile.exe --reminder-check` (Electron flag mode, needed for toasts with the AppUserModelID) | `ELECTRON_RUN_AS_NODE=1 <binary> <userData>/helper/reminder-check.cjs --reminder-check --data-dir <userData>` (Node mode — **no display server needed**) |
| Window / renderer | never created | not possible (no Electron APIs) |
| Delivery | Electron toast with protocol-activated buttons; waits for `show`/`failed` (≤ 4 s) | `gdbus` → `org.freedesktop.Notifications.Notify` (with `desktop-entry` hint), fallback `notify-send`; “no notification daemon” is detected and recorded |
| Why | toasts need the app identity | systemd user services usually have no display |

Common rules: library opened **read-only**; only runs if its schema version is exactly what the
build expects (otherwise exits quietly, never migrates); writes only `notify-state.sqlite`; **no
network**; one check at a time (lease); hard timeout (20 s, process force-exits at 22 s); redacted
logs (`helper.*` events, no titles). Exit codes: 0 done (incl. nothing to do / another check
running), 2 bad arguments, 3 schema mismatch, 4 state DB unavailable, 5 timeout, 1 unexpected.

On Linux the helper script is copied into the user-data folder at registration (so AppImage mounts
and package paths never matter) and re-copied by Repair when the app version changes.

Run a check by hand: Windows `"Maybe Pile.exe" --reminder-check`; Linux
`ELECTRON_RUN_AS_NODE=1 /opt/Maybe\ Pile/maybe-pile ~/.config/MaybePile/helper/reminder-check.cjs --reminder-check --data-dir ~/.config/MaybePile --dry-run`
(`--dry-run` plans and logs without showing or claiming).

## Clicks and actions (`maybepile://`)

Strict allowlist (`src/notifications/protocol.ts`): `maybepile://item/<uuid>`, `maybepile://open`,
`maybepile://action/snooze?target=<item|reminder|category>:<id>&for=1h|tomorrow`,
`maybepile://action/mute?target=…`. Anything else is ignored. Silent actions run in a short-lived
process with no window that only writes `notify-state.sqlite`. Item URLs only navigate.

| Action | Windows resident | Windows scheduled | Linux resident | Linux scheduled |
| --- | --- | --- | --- | --- |
| Click opens the item | toast protocol activation | same | Electron `click` event | depends on the shell (`desktop-entry` hint); no click handler in a process that already exited |
| Snooze 1 h / Tomorrow / Mute buttons | toast buttons (protocol) | toast buttons | not available (Electron supports actions on macOS only) | not offered |

Where buttons are unavailable, use the item's “Mute reminders for this item” or Settings.

## Quiet hours, caps, time

Quiet hours default 22:00–08:00 every day (configurable start/end and the weekdays they start);
“Days notifications may arrive” works like an all-day quiet period. Schedules are evaluated in the
current zone (follow the OS or set an IANA zone); instants are stored in UTC, so travelling
re-anchors to local time. DST: a nonexistent local time (spring forward) shifts forward by the gap; an
ambiguous one (fall back) uses the first occurrence. Repeating reminders advance from the scheduled
time, never from delivery time. Clock jumps are detected in resident mode and trigger a check.

Do Not Disturb / Focus Assist: the OS decides; Maybe Pile never tries to override or query it.

Power: the Windows task runs on battery, starts when available after a missed run, never stacks,
1-minute limit, hidden. The systemd timer uses `OnCalendar` with `Persistent=true` (catches up after
sleep, still at most one summary) and `RandomizedDelaySec=30`.

## Background components (exactly what is created)

Windows (per user, no admin): Task Scheduler `\MaybePile\ReminderCheck` (XML via `schtasks /Create /XML`);
`HKCU\…\Run` login item with `--hidden` (tray + start at login); a Start Menu shortcut carrying the
AppUserModelID `app.maybepile.desktop` if none exists (it is never removed — it is also your normal
Start Menu entry); portable builds also register `HKCU\Software\Classes\maybepile`.

Linux (per user, no root): `~/.config/systemd/user/maybe-pile-reminders.{service,timer}` +
`systemctl --user enable --now`; `<userData>/helper/reminder-check.cjs`; `~/.config/autostart/maybe-pile.desktop`
(tray + start at login); AppImage only: `~/.local/share/applications/maybe-pile-url-handler.desktop`
(`x-scheme-handler/maybepile`). No systemd user session → the mode is refused with an explanation.

Status panel: *Not installed / Installed & healthy / Installed but points to an old copy (repair) /
Disabled by the system / Error*, last and next check, buttons **Test notification**, **Run check now**,
**Repair**, **Remove background components** (re-queries to prove removal). On every launch the app
re-checks: a moved/updated executable is re-registered with a visible note; a task the user disabled is
not re-enabled silently; settings restored from another computer without registrations fall back to
“While the app is open” with a notice (registrations are never restored from backups).

## Tray (Linux realities)

Tray icons need a StatusNotifierItem host: KDE Plasma and Cinnamon (known to have one), XFCE with the
status-notifier plugin, GNOME only with the AppIndicator extension. The app checks for
`org.kde.StatusNotifierWatcher` on the session bus; X11 desktops other than GNOME are assumed to
support a legacy tray. Without a tray, closing the window **minimizes** instead of hiding it into
nothing, and Settings recommends “Wake on schedule”. None of these desktops were tested here.

## Verified here vs. not

Environment: Windows 11 (this machine), Electron 45.4.1, no Linux desktop, packaged builds cannot run
here (unsigned binaries are blocked by Windows Application Control).

| What | Status |
| --- | --- |
| Engine, state DB, snapshot, helper, adapters (generation), installer (fake OS), protocol parsing | unit/integration tests |
| Node-mode helper under the real Electron binary (`ELECTRON_RUN_AS_NODE`, `node:sqlite`, read-only open, dry run) | ✅ run here: ~126 ms per run, exit 0; bad args exit 2 |
| Windows flag mode `--reminder-check` with the dev Electron binary | ✅ run here: 1 toast, Electron reported `show`, exit 0 in ~2.1 s, no window; second run delivered 0 (exactly-once) |
| Silent `maybepile://action/mute` launch | ✅ run here: no window, state written, exit 0; hostile `action/delete` ignored |
| Real Task Scheduler create/query/delete with the generated XML (disabled test task) | ✅ run here via the opt-in test |
| Toast visually displayed / buttons clicked / Start Menu shortcut path | ⚠️ not observed (no screen access) |
| Linux D-Bus delivery, systemd timer, autostart, tray | ⚠️ not run (no Linux desktop here) |
| Installer protocol registration and uninstall cleanup | ⚠️ not run (packaged builds can't run here) |

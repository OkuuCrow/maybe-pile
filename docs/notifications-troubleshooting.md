# “I don't get notifications”

Start with **Settings → Notifications** (Full mode) or **Settings → Reminders** (Simple):

1. Is a delivery mode other than *Off* selected and at least one category on?
2. **Notification history** says what happened to each reminder: *Delivered*, *Skipped (quiet hours)*,
   *Skipped (daily limit reached)*, *Skipped (computer was off or asleep)*, *Failed — reason*,
   *Could not be shown here*.
3. **Test notification** — if nothing appears, it is an OS setting (below).
4. **Reminder service status** — *Installed but points to an old copy* → **Repair**.
5. Paused? The status panel shows “Paused until …” (tray menu → Resume, or Settings → Resume).

## Windows

- Settings → System → Notifications: notifications on, and **Maybe Pile** allowed.
- Focus Assist / Do not disturb hides toasts; they wait in the notification center (if enabled).
- Toasts need a Start Menu shortcut with the app ID. If you skipped Start Menu shortcuts in the
  installer, turning on a background mode offers to create one; **Repair** recreates it.
- Task: open Task Scheduler → *Task Scheduler Library › MaybePile › ReminderCheck*. If it is
  disabled, enable it or use **Repair**. Manual check: `schtasks /Query /TN "MaybePile\ReminderCheck" /V /FO LIST`.
- Portable copy moved? Open Maybe Pile once from the new place; it repairs the task.
- Run a check by hand: `"%LOCALAPPDATA%\Programs\Maybe Pile\Maybe Pile.exe" --reminder-check`.

## Linux

- A notification service must be running (GNOME/KDE/XFCE have one; minimal window managers may need
  `dunst` or similar). Check: `gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.freedesktop.Notifications`
- `notify-send` (libnotify) is used when `gdbus` is missing.
- Tray missing (stock GNOME): install the AppIndicator extension, or use *Wake on schedule*.
- Timer: `systemctl --user status maybe-pile-reminders.timer`, logs: `journalctl --user -u maybe-pile-reminders.service`.
- No systemd user session (some minimal setups): use the tray mode.
- AppImage moved? Run it once from the new place; it repairs the units.
- Run a check by hand (prints a summary, shows nothing):
  `ELECTRON_RUN_AS_NODE=1 <maybe-pile binary or AppImage> ~/.config/MaybePile/helper/reminder-check.cjs --reminder-check --data-dir ~/.config/MaybePile --dry-run`

## Logs

Settings → About (Full mode) → *Save diagnostic log*. Reminder events are `notify.*` (app) and
`helper.*` (scheduled helper); they never contain titles or notes. Log files live in the data
folder's `logs/`.

## Remove everything by hand

Use **Remove background components** first (it re-checks that everything is gone). Manually:

Windows

```
schtasks /Delete /TN "MaybePile\ReminderCheck" /F
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v app.maybepile.desktop /f
reg delete "HKCU\Software\Classes\maybepile" /f    (portable builds only)
```

The NSIS uninstaller removes the task, the login item and the link handler on a real uninstall.

Linux (packages cannot touch per-user files — run this before uninstalling):

```
systemctl --user disable --now maybe-pile-reminders.timer
rm ~/.config/systemd/user/maybe-pile-reminders.service ~/.config/systemd/user/maybe-pile-reminders.timer
systemctl --user daemon-reload
rm -f ~/.config/autostart/maybe-pile.desktop ~/.local/share/applications/maybe-pile-url-handler.desktop
rm -rf ~/.config/MaybePile/helper
```

`notify-state.sqlite` (history, snoozes) can be deleted safely while the app is closed.

# Small quality-of-life items (§16.11)

- **Dyslexia-friendly font option** (core): uses *OpenDyslexic* if installed on the computer, otherwise a
  clear fallback stack (Atkinson Hyperlegible, Verdana, Tahoma); plus line and letter spacing, live preview.
  Bundling OpenDyslexic (OFL-1.1, `@fontsource/opendyslexic`) was not done: adding the package was not
  permitted in this build environment.
- **Theme schedule** (Full): day/night themes at fixed local times; no location or network. A manual
  change lasts until the next switch.
- **Tray menu**: Open, Up Next (top 3), pause/resume the running timer, Quick Capture, Pick for Me,
  Pause notifications, Run reminder check now, Quit completely. Titles follow the privacy level.
- **Restore my place** (core): last screen and scroll position (setting “Restore my place”, on by
  default); window size/position/maximized state is restored only if it lands on a connected display.
- **Multiple libraries** (Full): Settings → Advanced → Libraries — separate libraries each with their own
  database, artwork and settings under `libraries/<id>/` (the first library stays where it was: nothing is
  moved). Switching restarts the app. Delete keeps a database copy in `backups/`. Backups/exports cover the
  open library. Each library has its own reminder settings; the helper checks only libraries whose
  reminders use the scheduler and labels notifications with the library name only when more than one is
  checked; `notify-state.sqlite` keys everything by library id.

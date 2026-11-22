# Troubleshooting

Data folder locations:

| | Location |
| --- | --- |
| Windows (installed) | `%APPDATA%\MaybePile` |
| Windows (portable) | `MaybePileData\` next to `Maybe-Pile-Portable-*.exe` (or `%APPDATA%\MaybePile-Portable` if that folder is read-only) |
| macOS | `~/Library/Application Support/MaybePile` |
| Linux | `~/.config/MaybePile` |

Settings → Data & Behavior → **Open data folder** opens it. The diagnostic log is in `logs/`. It contains event names and error codes, not titles, notes or keys. Export it from Settings → Data & Behavior.

## Installation

- **Windows "protected your PC" (SmartScreen):** the build isn't code-signed. Choose *More info → Run anyway*, or use a signed build.
- **Windows "An Application Control policy has blocked this file":** Smart App Control or WDAC blocks unsigned apps. Use a code-signed build, or ask your administrator. (This is exactly what happened to the unsigned builds in this project's own verification.)
- **macOS "can't be opened because it is from an unidentified developer" / "is damaged":** right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/Maybe Pile.app"`.
- **Linux AppImage won't start:** `chmod +x`. Install FUSE 2 (`libfuse2`), or run with `--appimage-extract-and-run`.
- **Linux "The SUID sandbox helper binary was found, but is not configured correctly":** in the extracted folder run `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`. Do not disable the sandbox.
- **Launching from a terminal does nothing / "Cannot read properties of undefined (reading 'isPackaged')":** your shell exports `ELECTRON_RUN_AS_NODE=1` (VS Code extension terminals can do this), which makes Electron behave like plain Node. Unset it, or use `npm start` / `npm run dev`, which strip it.

## Network and providers

- **"Couldn't reach …":** check your connection. Nothing in your library changed, and everything except online lookups works offline.
- **"… is limiting requests":** wait for the number of seconds shown. The app honours `Retry-After` and pauses further requests to that provider.
- **"… rejected the API credentials":** re-enter the key in Settings → Providers. For TMDB, either the API Key or the API Read Access Token works. For IGDB, both the Client ID and Client Secret are needed.
- **Covers missing offline:** TMDB and IGDB artwork is shown from the web only (provider terms). Use *Change image…* to set a local image, which is stored for offline use.
- **Behind a proxy:** network requests use Electron's `net` module, which follows system proxy settings.

## Permissions

- **"Maybe Pile doesn't have permission to write …":** choose a folder you own (Documents, Desktop). On macOS, grant access if prompted.
- **"There is not enough free disk space":** backups need roughly the size of your library plus artwork. Free space or pick another drive.
- **"… is in use by another program":** close the program that has the file open (antivirus scans can briefly lock files) and retry.

## Database

- **App won't start after an upgrade:** see [migrations.md → Recovering from a failed migration](migrations.md#recovering-from-a-failed-migration). A pre-upgrade copy is in `backups/pre-migration-*.sqlite`.
- **"This library was created by a newer version of Maybe Pile":** install the latest version, or open it read-only from the startup dialog. Nothing is changed in read-only mode.
- **Banner: "did not shut down cleanly and the library failed its integrity check":** go to Settings → Backup & Restore and restore the newest safety snapshot or your latest `.mpbackup`. Keep a copy of the current data folder before restoring.
- **Only one window opens:** this is intentional. A second launch focuses the running window so two processes never write the same database.

## Import and restore

- **"File is not valid JSON" / "not a Maybe Pile export":** use a file made by Export JSON. Other apps' exports need converting to the CSV columns documented in [backup-and-transfer.md](backup-and-transfer.md#csv-export).
- **CSV errors like `row 4, status`:** fix the listed cells. Status values are `planned`, `in_progress`, `completed`, `on_hold`, `dropped`; types are `movie`, `tv`, `game`, `book`; ratings are 0.5–5 in steps of 0.5. Nothing is imported until every row is valid.
- **Restore failed / "The backup file is damaged or truncated":** your current library was **not** changed. Re-copy the backup (an incomplete download or sync is the usual cause) and try again.
- **"Checksum mismatch":** the backup was modified or corrupted after it was created. Use another backup.
- **"This backup was made by a newer Maybe Pile":** update the app on this computer first.
- **Regret a restore:** Settings → Backup & Restore → *Automatic safety snapshots* → pick the `pre-restore-…` entry → *Restore this…*.
- **Artwork missing after a JSON import:** JSON exports don't contain image files. Use a full backup to move artwork.

## Portable data not found

- The portable build only uses `MaybePileData` next to the **exe you launched**. If you moved the exe, move the `MaybePileData` folder with it.
- If the folder next to the exe was read-only (for example, a protected USB stick or `Program Files`), data was written to `%APPDATA%\MaybePile-Portable`; the app shows a notice when that happens.
- The installed app (`%APPDATA%\MaybePile`) and the portable app never share data. To move between them, use a `.mpbackup` backup and restore.

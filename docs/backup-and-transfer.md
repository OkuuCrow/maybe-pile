# Backup, restore, export and moving between computers

## Formats at a glance

| | Full backup `.mpbackup` | JSON export `.json` | CSV export `.csv` |
| --- | --- | --- | --- |
| Use for | Moving computers/OSes, safety copies | Inspecting or merging data, scripting | Spreadsheets |
| Items + all type details | ✅ | ✅ | Summary columns only |
| Seasons/episodes with watched state | ✅ | ✅ | ❌ |
| Progress history, viewing history | ✅ | ✅ | ❌ (current progress text only) |
| Provenance, sources, audit log | ✅ | ✅ | ❌ |
| Custom fields | ✅ | ✅ (by field name) | ❌ |
| Series | ✅ | ✅ | ❌ |
| Themes, layouts, settings (non-secret) | ✅ | ✅ | ❌ |
| Up Next | ✅ | ✅ (`upNextPosition`) | ✅ (`up_next_position`) |
| Lists and memberships | ✅ | ✅ | Names only (`lists`) |
| Snoozes, goals, CSV mapping profiles | ✅ | ✅ | ❌ |
| Library sources (Steam/manual snapshots, ignore flags) | ✅ | ✅ | ❌ |
| Import batches (undo history) | ✅ | ✅ | ❌ |
| Pick for Me history, release-notification log | ✅ | ❌ (local convenience data) | ❌ |
| Artwork image files | ✅ | Reference only (hash or URL) | ❌ |
| API keys | ❌ never | ❌ never | ❌ never |
| Absolute paths, logs | ❌ | ❌ | ❌ |
| Restore/import mode | **Replace** | **Merge** | **Merge** |

### `.mpbackup` (format `maybepile-backup`, `formatVersion` 1)

The container format is unchanged in 1.2, so `formatVersion` stays 1 (bumping it would make 1.1 refuse backups for no container-level reason). The **database schema version** inside the manifest (now 4) tells an older app the backup is newer, and that app refuses it with "update the app". Restoring a v1–v3 backup migrates the staged copy to v4 first.

A ZIP container with relative POSIX paths only:

```
manifest.json         { format, formatVersion, appVersion, schemaVersion, createdAt, counts,
                        artworkCount, secretsIncluded: false, files: [{ path, sha256, bytes }] }
library.sqlite        consistent snapshot via SQLite VACUUM INTO (soft-deleted items removed)
artwork/<sha256>.jpg|png and <sha256>.thumb.jpg
```

### JSON export (format `maybepile-export`, `formatVersion` 2)

`{ format, formatVersion, exportedAt, appVersion, schemaVersion, counts, data: { items, customFieldDefs, series, themes, layouts, settings, lists, goals, snoozes, librarySources, importBatches, mappingProfiles } }`.

- **formatVersion 2** (app 1.2) adds the last six sections. They are optional, so **version-1 files still import** unchanged. Files with a **higher** version are refused: "This export uses format version N; this app supports up to 2. Update Maybe Pile to import it."
- Merging v2 data: lists merge **by name**; goals, library sources and import batches are added when their id is new; snoozes follow their (re-mapped) items; mapping profiles are added when the name is free. Nothing existing is overwritten.
- The Steam API key is **never** included (it isn't in the database). The schema is defined in `src/main/services/portable-format.ts`.

### CSV export

One row per item, UTF-8 (optional BOM for Excel, on by default) with RFC 4180 quoting and CRLF line endings. Columns: `id, type, title, alt_titles, status, rating_stars, date_added, date_started, date_completed, release_date, tags, genres, creators, imdb_id, tmdb_id, tvmaze_id, igdb_id, openlibrary_id, isbn13, isbn10, steam, xbox, playstation, runtime_minutes, network, show_status, page_count, publisher, book_format, platforms, game_progress_scheme, progress, progress_percent, notes, lists, up_next_position`. `lists` holds list names separated by `; ` (lists are created by name on import); `up_next_position` is 1-based. List cells use `; ` as the separator. Creators look like `Name (Role)`.

- **Formula-injection defence:** any cell starting with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'` so spreadsheet apps treat it as text. CSV import strips exactly that prefix again.
- **What CSV cannot represent:** episode lists and watched state, full progress history, viewing history, provenance, sources, audit log, custom fields, series, themes/layouts, artwork, **list order, list colours/icons/descriptions, snoozes, goals, library sources, import batches and mapping profiles**. Use JSON or a full backup for those. `progress` and `progress_percent` are export-only and ignored on import.
- CSV import requires the `type` and `title` columns. Unknown columns are ignored with a warning. Every row is validated, errors are reported as "row N, column", and any error blocks the import (all-or-nothing).

## Restore and import semantics

- **Preview first.** Nothing is applied until you confirm. The preview shows the file type and version, counts (your library vs the file, including lists, Up Next entries, snoozes, goals, library sources and their entries, import batches and mapping profiles), errors and warnings with row/path detail, and conflicts. Cancel at any point and nothing changes.
- **Merge (JSON/CSV):** new items are added. A conflict (same item ID, same provider ID, or same title + year + type) can be resolved globally or per item:
  - *Skip (keep mine)* (default).
  - *Keep both*: the imported copy gets a new ID.
  - *Update from file*: applied **only if the file's copy is newer** (`updatedAt`). If your copy is newer it is kept, and the preview says so.
  - Themes in the file are added (renamed if needed). Your current layout and settings are not changed by a merge.
  - The whole import runs in one transaction, so a failure leaves the library untouched (tested with failure injection).
- **Replace (backup restore):** the preview shows your current counts next to the backup's. You must type `RESTORE` to enable the button. Then:
  1. A **pre-restore snapshot** of the current library is written to `backups/pre-restore-<timestamp>.mpbackup` (last 5 kept). You can restore it from Settings → Backup & Restore.
  2. The backup was already validated in a staging folder: zip-bomb limits (2 GB archive, 4 GB expanded, 1 GB per entry, 200:1 ratio for large entries), entry-name allowlist (path traversal rejected), manifest schema, SHA-256 checksums, format/schema version (older is migrated on the staged copy; newer is refused), SQLite `integrity_check` and `foreign_key_check`.
  3. The live database is closed and the files are swapped by rename. On any failure the originals are renamed back and reopened. Tests inject a failure at every step.

## Moving your library to another computer (Windows ↔ macOS ↔ Linux)

1. On the old computer: **Settings → Backup & Restore → Create backup…**. Save the `.mpbackup` somewhere you can carry (USB drive, cloud folder, network share).
2. Install Maybe Pile on the new computer (see platform notes below) and start it once.
3. **Settings → Backup & Restore → Restore from backup…**, choose the file, review the preview, type `RESTORE`.
4. Re-enter API keys in Settings → Providers, including the Steam Web API key (Settings → Providers → Steam). Keys are never included in backups. Your Steam snapshot, ignore list and import history do come along.

The format is OS-independent: paths inside the archive are relative with `/` separators, artwork file names are lowercase hashes (no case-sensitivity issues), the database stores no absolute paths, and timestamps are UTC while personal dates are plain calendar dates (no time-zone shifts).

### Platform notes

- **Windows:** unsigned builds may trigger SmartScreen ("Windows protected your PC" → More info → Run anyway). Organisations using Application Control / Smart App Control may block unsigned executables entirely; use a signed build. Installed data lives in `%APPDATA%\MaybePile`. Deep folders are fine: the app's own paths are short.
- **macOS:** unsigned or un-notarized builds are blocked by Gatekeeper the first time. Right-click the app → Open, or run `xattr -dr com.apple.quarantine "/Applications/Maybe Pile.app"`. A `.mpbackup` downloaded from the internet may also carry quarantine, which doesn't affect restoring it. Data lives in `~/Library/Application Support/MaybePile`.
- **Linux:** make the AppImage executable (`chmod +x Maybe-Pile-*.AppImage`). AppImages need FUSE (`libfuse2`/`fuse2` on most distros) or `--appimage-extract-and-run`. If Chromium's sandbox helper complains in `.tar.gz` builds, run `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox` in the app folder. Data lives in `~/.config/MaybePile`. The `.deb`/`.rpm` register the `.mpbackup` MIME type (`application/x-maybepile-backup`). Note that opening a backup from the file manager launches Maybe Pile, but you still start the restore from Settings → Backup & Restore.

## Portable Windows build

- `Maybe-Pile-Portable-<version>.exe` runs without installation.
- Data is stored in a **`MaybePileData` folder next to the .exe**, detected through `PORTABLE_EXECUTABLE_DIR` (set by the portable launcher) or a `portable.flag` file next to the executable. It is never shared with an installed copy, which uses `%APPDATA%\MaybePile`.
- If the exe's folder is read-only, data goes to `%APPDATA%\MaybePile-Portable` and the app shows a notice.
- To back it up or move it, copy the whole `MaybePileData` folder with the app closed, or use a `.mpbackup`.
- To convert portable ↔ installed: create a `.mpbackup` in one and restore it in the other.

## Default export folder

Exports and backups open in your Documents folder by default. Change it in Settings → Backup & Restore → Default folder. The folder is chosen in a native dialog and stored by the main process; the UI only shows its name. The native save dialog asks before replacing an existing file. Writes go to a temporary file in the same folder, are `fsync`ed, and are renamed into place. A pre-check refuses to start if the disk is nearly full.

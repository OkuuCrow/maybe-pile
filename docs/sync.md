# Sync folder

Keep two or more computers in step through a folder you already sync with another tool, such as OneDrive, Dropbox, iCloud Drive, Syncthing or a USB stick. Maybe Pile has no server and no account; it only reads and writes files in the folder you choose.

## What is synced

Scope for 2.0:

- **Item existence**: new items are created on the other devices, and deletions are soft deletes there too.
- **Personal fields**: status, rating, notes, date started, date completed, and tags.

**Not synced:** metadata (refresh it on each computer), progress history and episode checkmarks, artwork, lists, goals, moods, purchases, sessions, settings and API keys. Use a JSON export/import or a `.mpbackup` restore to move those (see [backup-and-transfer.md](backup-and-transfer.md)).

## How to use it

1. **Settings → Data → Choose sync folder…** (native folder dialog), and give this computer a name.
2. **Check for changes (preview)** is a dry run that writes nothing. It shows how many items will be sent, how many changes will be received (with additions and removals), and the conflicts.
3. **Sync now** applies it.
4. Review any **conflicts** in the table: **Keep mine** or **Take theirs**.

## How it works

- **Files:** `<folder>/maybe-pile-sync/<deviceId>.jsonl`. Each computer appends only to **its own** file, so the file-sync tool never has to merge one file. Each line is a validated changeset `{v, deviceId, deviceName, seq, at, changes[]}`. We write a temporary file and rename it, so other computers never read a half-written file. A torn or invalid line in another computer's file is skipped with a warning and retried next time.
- **Identity:** items match by a **natural key**. That's the first external ID in a fixed priority (TMDB, IMDb, TVmaze, IGDB, Steam, ISBN-13, Open Library, MAL, AniList, Kitsu, Wikidata), or else type + normalized title + year. Database IDs differ between computers and are never used for matching.
- **Change detection** compares current values with a stored **baseline** (the values both sides last agreed on). No triggers are used.
- **Merge rule** for each incoming field, comparing the local value L, the baseline B and the remote value R:
  - L = R: nothing to do.
  - L = B (unchanged here): take R.
  - Otherwise both sides changed it: a **conflict**, which is never resolved automatically.
  - If several other computers changed the same field, the latest timestamp wins among them.
- **Safety on apply:**
  1. A `VACUUM INTO` snapshot is taken first (`backups/pre-sync-*.sqlite`, the last 5 are kept).
  2. Every incoming change, conflict record, baseline and read position is written in **one transaction**. Any error rolls it all back, so nothing changes.
  3. Only then is our outgoing changeset appended. If that step fails, the changes are simply sent again next time (applying a change twice is harmless).
- **Resolving conflicts:** *Take theirs* applies the other value and records it as agreed. *Keep mine* marks the other value as the baseline, so your value goes out at the next sync and the other computer, which hasn't changed it since, adopts it.
- **Restoring a backup** gives the restored library a **new device identity** and turns sync off. Otherwise two computers could share one device ID and write the same file.
- **Limits:** each log is read only if it's 50 MB or smaller. The folder path is chosen only through main's dialog; the renderer can't set it (`sync` isn't accepted by `settings:update`).

Tested with two simulated devices sharing a temporary folder (`tests/integration/sync.test.ts`). The tests cover:

- creates
- field merges
- that a preview writes nothing
- conflicts with both resolutions
- deletes
- a torn log line
- rollback when a database error happens mid-apply

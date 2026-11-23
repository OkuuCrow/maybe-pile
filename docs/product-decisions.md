# Product decisions

Decisions made where the specification left room for interpretation. Where a rule is enforced in code, the code location and its tests are listed.

## Ratings

Ratings are stored as an integer **1–10** and shown as **0.5–5 stars in half steps** (7 → "3.5 out of 5 stars"). There is no zero: "not rated" (NULL) and "worst" never get confused. Pickers are plain `<select>` elements, so they work with every screen reader. (`src/domain/rating.ts`)

## Dates

- Release, air and publication dates are **partial dates**: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, with real calendar days enforced (no 2023-02-29). They are displayed with `Intl` at the given precision.
- Personal dates (added/started/completed) are local calendar dates, never shifted between time zones. History timestamps are UTC instants, displayed in local time.

## Status ↔ progress rules (`src/domain/status-rules.ts`, tests in `tests/unit/domain.test.ts` and `tests/integration/progress.test.ts`)

1. **Progress never silently sets Completed.** Reaching 100%, the last known episode, or the final milestone produces a dismissible "Mark Completed?" prompt.
2. **First progress on a Planned item suggests In Progress**, with `date_started` = today if it's empty.
3. **"Automatically apply status suggestions"** (off by default) auto-applies only the *Start* and *Re-open* suggestions. Completion is always a prompt.
4. **Marking Completed** sets `date_completed` to today only if it's empty. The dialog offers (unticked) "fill remaining progress": log a viewing (movie), mark remaining regular episodes watched (TV), record full pages or 100% (book), set 100% or the final milestone (game).
5. **Completed → In Progress** asks two things: start a new pass (re-watch/re-read/replay, ticked by default) and clear the completed date (unticked by default). History is never erased. A new pass increments `items.pass`; current progress only considers entries from the current pass; for TV, episode checkmarks start fresh while earlier history stays.
6. **On Hold / Dropped** leave progress and dates untouched. Dropped items are excluded from the dashboard's Continue widget but stay searchable.
7. **Un-watching any episode of a Completed show** prompts to move back to In Progress.
8. **Bulk status changes** apply the date auto-fill (rule 4 without fill-remaining) but never start passes.
9. Editing the status in the edit form pre-fills dates by the same rules; you can still edit them before saving.

## Progress

- **History is the source of truth.** Every update creates a history entry recording the unit it was made in. Current progress is the **latest non-deleted entry** (by `occurred_at`, then `recorded_at`, then insertion order) of the kinds relevant to the current scheme and pass. Entries can be edited (time, value, note) or deleted (soft-delete), and current progress is recomputed.
- **Movies:** watched / not watched, plus any number of viewings, each with an optional date/time and note. "Mark watched" works without a date.
- **TV:**
  - Season 0 is **Specials**. Specials are tracked and shown but excluded from the completion percentage.
  - A season's total is the larger of its stated episode count and the episodes actually listed.
  - The overall total is **unknown** if there are no regular seasons, or any regular season has neither a stated count nor listed episodes. Then the label reads "12 watched · total unknown" and no percentage is shown, so there's never a divide by zero.
  - Shows marked *returning* read "12 of 30 episodes (so far)".
  - "Up to here" marks every unwatched regular episode up to that point, across seasons, in one history entry.
  - TV history is a log of toggles. Editing or deleting a TV history entry does not flip checkmarks; the episode rows are the state.
  - A metadata refresh **adds** new seasons/episodes and updates titles/dates of *provider-sourced* episodes. It never deletes episodes, never changes watched state, and never overwrites episodes you edited (editing converts them to user episodes).
- **Games:** per-game scheme of *percentage*, *hours played*, *ordered milestones* or *free text*. Switching schemes keeps all history; entries remember the scheme they were made under, and the current value comes from entries of the active scheme. Deleting a milestone keeps its title in history (snapshot) and clears the link.
- **Books:** record *pages*, *percent* or *audiobook minutes*, whichever you like.
  - **Unknown page count** never blocks tracking: use percent, or record pages ("120 pages · total unknown").
  - **Page count changed** (for example, a new edition): history keeps the original value and the page count at the time (`total_at_time`). The display recomputes against the *current* page count, capped at 100%. A percent entry shows "about page N" when a page count is known.

## Metadata provenance and refresh

- Each metadata field has an origin: `provider`, `user` (edited after creation) or `manual-entry` (typed when creating).
- A field counts as **user-edited** if its origin is `user`/`manual-entry`, or if it's `provider` but the current value differs from the provider value recorded at the last fetch. A non-empty value with no provenance record is also treated as user-edited, to protect it.
- The refresh dialog lists only fields that differ. User-edited fields default to **Keep mine**; untouched provider fields default to **Use new**. Empty provider values never blank out existing data. Personal fields (status, rating, notes, dates, tags, custom fields, progress) are never part of a refresh.
- Applying a refresh writes an audit entry (fields changed, old and new values), visible under the item's Source panel. Kept fields remember the provider's newest value, so the next refresh can tell whether it changed again.
- Refresh failures leave the item unchanged and show what happened.

## Duplicates

Likely duplicates are found when adding or importing: **same type**, plus either the same provider/ISBN/Steam ID, or the same normalized title (accent- and case-folded, punctuation removed, leading "The/A/An" dropped) with a compatible year (equal, or either unknown). You choose *Open existing*, *Add anyway* or *Cancel*.

## Up Next, Pick for me, This year (added in 1.1; superseded in part by 1.2 below)

- **Up Next** is a short queue you order yourself (positions 1..n). Add from an item's page, from the Library bulk bar, or from a pick. Reorder or remove from the dashboard widget with buttons; keyboard focus stays on the moved item. Items leave the queue automatically when marked **Completed** or **Dropped**; other status changes keep them. Bulk add skips completed, dropped and already-queued items. The queue is included in backups and JSON exports.
- **Pick something for me** chooses uniformly at random among **Planned** items that aren't already in Up Next, optionally limited to one media type. *Pick again* never repeats the previous pick immediately (when there is another option). Picking changes nothing until you choose *Add to Up Next* or open the item.
- **This year** counts, for the current calendar year (local time): items finished (by `date_completed`), items added, episodes watched (episode `watched_at`), movie viewings and progress entries. It is derived from real data only.

## Deletion and undo

Deleting soft-deletes: the item disappears everywhere immediately, and a toast offers **Undo** for 10 seconds. Soft-deleted items are **purged permanently at the next app start**, together with orphaned tags, genres, creators and artwork files. They are never included in exports or backups. Deleting more than one item requires typing `DELETE`.

## Tags

Free-form, trimmed, whitespace-collapsed. Uniqueness is case- and accent-insensitive ("Café Noir" = "cafe noir"), and the first spelling entered is kept. Filters support *any* or *all* of the selected tags.

## Notes

Plain text with line breaks preserved. Markdown is not rendered: plain text is simplest and has no HTML-injection risk.

## Library list

Default sort is date added, newest first. Sorting is stable (ties broken by title, then ID). Unrated items, unknown release dates and unknown progress sort last in both directions. Titles sort naturally ("Part 2" before "Part 10") and ignore leading articles. Filters, sort and view mode are remembered.

## Portable storage

See [backup-and-transfer.md](backup-and-transfer.md#portable-windows-build): `MaybePileData/` next to the portable exe, falling back to `%APPDATA%\MaybePile-Portable` with a notice. A portable copy never shares data with an installed one.

## Backup format and versioning

`.mpbackup` is a ZIP with a SHA-256 manifest and a `VACUUM INTO` snapshot. `formatVersion` (container) and `schemaVersion` (database) are versioned separately. Older backups are migrated on a staged copy; newer ones are refused with an "update the app" message. Secrets are never included. Optional passphrase-encrypted secret export was deliberately **not** implemented: re-entering keys on a new machine is safer than moving them around.

## Optional features not implemented

- **Scheduled automatic backups:** not implemented. Safety snapshots are taken automatically before restores and migrations only. Manual backups take one click.
- **Auto-update:** not implemented, because it requires a hosted release feed. To add one, configure electron-builder `publish` (for example GitHub Releases) and `electron-updater`, and sign builds; updates must be opt-in to keep the "no unexpected network calls" promise.
- **Opening `.mpbackup` by double-click:** the file association is registered, but the app doesn't auto-start a restore from the launch argument. Choose Restore in Settings. This was deliberate: a restore should always start from an explicit action inside the app.
- **Drag-and-drop layout editing:** the list editor with Move up/down buttons is the accessible primary method.

## Feature pack (1.2)

### Steam library import

- **Auth model:** the user's own Steam Web API key, entered in Settings and stored with `safeStorage` like other provider keys. No key is embedded or shipped (Valve's terms make keys personal). One key is shared by all Steam accounts you add.
- **Documented API only:** `ResolveVanityURL` + `GetOwnedGames`. No store `appdetails` (not documented by Valve), no icon URLs (format not documented), no scraping. See [providers.md](providers.md#library-sources-12).
- **"Unplayed"** = Steam reports `playtime_forever == 0`, the game isn't already in the pile (same Steam app id), and it isn't ignored. The UI explains that 0 minutes means "Steam recorded none", not "definitely never played".
- **Non-games** are recognized by name (soundtrack, dedicated server, SDK/tool, demo, playtest, benchmark…), because `GetOwnedGames` has no app type. They're hidden by default with a visible reason and a toggle.
- **Duplicates:** Steam app id is authoritative (skipped, never duplicated). The same normalized title is only a "Possible duplicate" warning.
- **Private profiles:** a `200` response with neither `games` nor `game_count` is treated as private game details. `game_count: 0` is an empty library.
- **Retries:** 429 waits for `Retry-After` up to 60 s (max 3 retries); 5xx/timeouts back off 2/4/8 s; anything longer stops with a message. Client limit: 10 requests / 10 s.
- **Import chunks:** 200 games per transaction. A failed chunk is rolled back completely and listed; earlier chunks stay and remain undoable.
- **Playtime as progress:** off by default. When on, games with playtime switch to the *hours* scheme and get one entry dated with Steam's last-played time.
- **Re-sync never changes the pile.** Playtime updates are opt-in per game and default to "Keep mine". Games that leave the Steam library are flagged "Not in Steam anymore" and never deleted.
- **Enrichment** (optional): exact normalized-title match only, fills empty fields only, at most 25 games per import, using IGDB if configured, else Wikidata.
- **Manual game list** as the second `LibrarySource`: plain lines or CSV/TSV with a `title` column and optional `platform`. It uses the same review/import/undo flow.

### Undo rules (all imports)

An import can be undone for **30 days** (configurable 1–365). Undo removes only items whose **content fingerprint** (metadata, personal fields, tags, genres, creators, ids, custom fields, game/book details, `updated_at`) and **history count** (progress entries + viewings) are unchanged since the import. Adding an item to a list or Up Next doesn't count as editing it. Removed items are soft-deleted (purged at next start, like any delete). Kept items are listed with the reason. After the retention period, the batch record is purged; items are never touched.

### Pick for Me

Weighted random, never zero weight, seedable (see [features/pick-for-me.md](features/pick-for-me.md)). Defaults: neutral, In Progress and On Hold excluded, "Not now" = 7 days. Time fit: movies runtime ≤ time + 20 min, TV episode runtime ≤ time, games/books only with session tags or `short`. Unknown runtimes don't fit.

### Pile Health

Stale = Planned ≥ 12 months, or In Progress with no activity for ≥ 60 days. "Keep" silences nudges for one threshold period but still lets Pick for Me pick the item; "Snooze" hides it from both. Nudges are in-app only (no OS notifications). It can be turned off entirely.

### Up Next

Max 10 by default (3–25). Starting an item *offers* removal; completing or dropping removes it. The queue moved to its own table with a UNIQUE position (migration v4).

### Lists

Unique names (case/accent-insensitive). Colour is optional and decorative; the icon and name always identify the list. Deleting a list never deletes items. JSON import merges lists by name.

### Stats & Year in Review

UTC instants are bucketed by the **local** calendar date (system time zone). Personal dates are used as stored. Missing data is counted and shown rather than imputed. Streaks are off by default.

### Release Radar

"Upcoming" = the latest possible day of a partial date is today or later. Only exact dates notify or go into `.ics`. Notifications are opt-in and only fire while the app runs (no background service or login item). Date refresh is on demand; refresh-on-start is opt-in and never applies changes.

### Tracker imports

Skip / Keep both only (no "update from file", so an import never replaces an existing item). Goodreads exclusive shelves map to statuses; unknown shelves → Planned plus a tag, with a warning. Letterboxd viewings are stored at 12:00 UTC so their calendar date is stable across time zones. Generic mapper defaults: guess columns from the header, 0–5 stars, Y-M-D dates, `;` tag separator. Limits: 25 MB, 50,000 rows.

### Goals

Pace: expected = target × elapsed/total days (inclusive), with a ±max(1, 10%) tolerance. Pages = page counts of books completed in the period; hours = hours logged within the period. There are no "Goals defaults" settings: every goal is configured in its own form, and goals never notify.

### Format versions

JSON export `formatVersion` 1 → **2** (new optional sections; v1 still imports; newer is refused). `.mpbackup` container `formatVersion` stays **1**, because the container didn't change; the schema version (4) inside protects older apps. Layout files `schemaVersion` 1 → **2** (v1 migrated on import). Theme files stay at `schemaVersion` 1, with the new tokens optional.

### Charts as images

"Save as image" captures the chart's rectangle from the window in the main process (`webContents.capturePage`) and writes a PNG through a save dialog. The renderer never handles file paths. If the page is zoomed, the captured rectangle can be slightly off; scroll the chart into view and retry.

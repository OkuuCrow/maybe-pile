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


## Expansion Pack 2 (2.0)

Decisions the brief left open, recorded as required.

### Sources and terms

- **Kitsu is the default anime source.** The maintainer first chose Jikan as the default. Jikan's own documentation then turned out to describe it as *scraping MyAnimeList*, and its terms page returns 404. Maybe Pile's rule is "no scraping", so Jikan is **off by default and flagged** (users may still turn it on), and Kitsu (official, keyless, documented) is the default. This deviates from the earlier instruction; we explain why in the final report.
- **AniList is off by default for all types**, including the TV/movie/book uses it had in 1.x. Its terms exclude "anime and manga list or tracker services", which plausibly covers a personal backlog tracker. Users who previously relied on AniList must re-enable it in Settings → Providers. The terms note there explains why.
- **No embedded fanart.tv project key.** Users supply a personal key and/or project key. Keys go in headers, never in URLs.
- **SteamGridDB image hosts** are allowlisted to `cdn2.steamgriddb.com` and `cdn.steamgriddb.com`. No published host list was found. Unknown hosts are dropped rather than trusted.
- **Remote-only** for every source whose terms don't clearly allow caching: Kitsu, MAL, Jikan, AniList, fanart.tv, SteamGridDB and TMDB.
- **Streaming links** are shown only from provider data and only for allowlisted official hosts.
- **TMDB anime IDs** are stored prefixed (`tv:123` / `movie:123`), because TMDB IDs are only unique within each kind.
- **fanart.tv TV art is not offered:** it needs TheTVDB IDs, which we don't store.

### Anime

- **Anime season from a start date:** quarters, but a premiere on or after the 25th of the quarter's last month belongs to the next season.
- **Default title language: romaji** (the usual community convention). It's applied when importing; switching the setting later affects new imports only.
- **Adult content:** hidden from search, preview and import unless "Show adult titles" is on. Adult artwork is blurred by default even when shown.
- **MAL score → rating:** 1–10 maps 1:1 onto half-stars. MAL "times watched" becomes extra runs.

### Artwork

- **Candidates are ephemeral** (30 minutes, in memory); only chosen images persist.
- **The first five slots are fixed:** cover, banner, logo, icon, background. SteamGridDB heroes double as backgrounds.
- **Ranking:** per-type source priority, then English or text-free images, then the source's score.
- **Image fetch redirects:** at most 3 hops, each to the same host or a declared host. Electron's `net.fetch` rejects manual redirects, so main uses `net.request` for image fetches (verified in the e2e suite).
- **Pixel caps:** 12,000 px per side and 40 MP, checked from the header before decoding. Banners and backgrounds are stored up to 2560 px wide; other images up to 1200 px.

### Features 1–12

- **Pile Time:** assumed pace 1.5 min/page; assumed episode length 45 min (TV) or 24 min (anime). The source and confidence are always shown, and unknown items are counted, not treated as zero.
- **Runs** are the existing `pass` made explicit. Episode states of a finishing run are snapshotted before they reset.
- **Sessions:** one running timer at a time. Sessions longer than 12 h are flagged for review. Hours default to *What I enter*, and sessions never overwrite them unless the item's hours source is *Sessions*.
- **Pile Value:** per-currency totals with no conversion. Cost per hour uses the latest recorded hours.
- **Leaving Soon:** a 14-day default window, notifications opt-in, once per entry and date, only while the app runs.
- **Recommendations:** need at least one taste signal from a 4★+ completion. "Not now" lasts 30 days.
- **Merge undo** is refused if the kept item changed after the merge.
- **Share card:** text only, with no provider art (avoids image rights).
- **Sync (13):** a folder of per-device append-only logs. It covers item existence and personal fields (not metadata). Natural keys; a three-way field merge against a baseline; conflicts are always reviewed by the user; snapshot plus one transaction per apply. A restored backup gets a new device ID with sync off. The `sync` setting is machine-specific: it isn't exported and it can't be set by the renderer. See `sync.md`.

### Format versions

JSON export `formatVersion` 2 → **3** (optional `pack2` section; older files still import). Schema version 4 → **6** (v5 Expansion Pack 2, v6 sync). The `.mpbackup` container stays at 1.

## 2.1 — Notifications Pack + Simple Mode

### Notifications

- **Everything off by default**; background components are created only after a confirmation dialog listing
  each file/task, its location, command line and undo. Per-user only, never admin/root.
- **Default privacy level: Show titles.** A reminder that says “something is waiting” is rarely useful; the
  user can see what will be shown (live previews), gets a lock-screen hint next to the setting and a one-click
  “Hide titles instead”. Adult items and Spoiler-Shield content are generic regardless.
- **Separate `notify-state.sqlite`** instead of tables in the library: the headless helper must never write the
  library (read-only guarantee), the state is runtime data that should not travel in backups, and resident +
  helper + in-app runs need one shared claim table across libraries.
- **Exactly-once by claiming dedupe keys** (`INSERT`-or-abort in one IMMEDIATE transaction) rather than
  “last run time” bookkeeping: overlapping processes stay safe without coordination; failures retry with
  backoff (3 attempts) instead of looping.
- **Helper entry per OS**: Windows uses the app executable with `--reminder-check` (toasts need the app's
  AppUserModelID and protocol-activated buttons). Linux uses Node mode (`ELECTRON_RUN_AS_NODE`) with a copied
  script, because a systemd user service usually has no display; tested empirically on this Windows machine
  under the real Electron binary (Node mode + flag mode).
- **No D-Bus dependency**: Linux headless delivery calls `gdbus` (part of GLib on virtually every desktop) with
  argument arrays and falls back to `notify-send`. A JS D-Bus library would add an unaudited native-free but
  large dependency; the CLI path is easy to test (argument generation) and to troubleshoot.
- **Custom reminders store an anchor + structured rule** (never cron strings). Occurrences are computed from
  the schedule, so the read-only helper can fire them without writing `next_fire_at` (kept as a display cache).
- **Pause, snooze and mute live in the state DB** so silent protocol actions and the tray work without opening
  the library.
- **Quiet-hours policy**: everything defers into one summary except “Session still running” and “Offline queue
  finished”, which are only useful in the moment and are skipped.
- **Catch-up**: at most one “While you were away” summary for the last 24 h; older items are recorded as missed.
- **Upgrade**: users who had the 1.x/2.0 while-open Release Radar / Leaving Soon notifications get mode “While
  the app is open” with the same categories; nothing new is installed.
- **Restores never re-create registrations**: a background mode with nothing installed on this computer falls
  back to “While the app is open” with a notice.
- **Dev builds** cannot register background components (they would point at a bare electron.exe); the UI says
  so. `MAYBEPILE_DEV_BACKGROUND=1` overrides for development.

### Simple Mode

- New installs → Simple; existing libraries → Full + a one-time offer (detected in migration v7: a library
  with items or stored settings is “existing”).
- Simple uses a fixed Home; Full keeps the saved dashboard layout. Themes apply in both.
- Recently deleted is core but not in the 4-item sidebar: reachable from Library (Full), Backup & restore
  and the omnibox.

### §14–§16

- **Trash retention 30 days** (was: soft-deleted items purged at the next start). Backups and exports now keep
  Recently deleted items with their deletion time.
- **Change log**: snapshot-diff of a fixed field list around each mutating command (not database triggers);
  notes recorded only as “notes edited”. Undo only when the field still has the logged value.
- **Undo for one-tap actions** uses inverse operations through the normal services plus an exact restore of the
  status dates — consistent runs/Up Next/history rather than raw row restores. Tokens live 10 minutes in memory.
- **Skipped episodes** count toward completion and “caught up”, never as watched or time.
- **Auto rules** run only in the app process and never delete; “stale” is a flag (`item_flags`).
- **“Waiting for details”** is a queue state + badge, not a new item status (a status change would need a table
  rebuild of `items` and would leak into every status filter).
- **Screenshot OCR not shipped** (bundle size/licensing not reviewed); text-list import only.
- **Dyslexia font**: the code prefers OpenDyslexic but the font is not bundled — installing a new npm
  dependency was not permitted in this build environment. Tracked as a follow-up.
- **Multiple libraries**: the first library stays in the user-data root (no move = no migration risk);
  others live in `libraries/<id>/`. Switching restarts the app so no service ever mixes libraries.
- **Share page**: provider artwork off by default; adult items off by default; CSP without any `script-src`.

### Key-free images (§15) — terms reviewed 2026-11-26

- Enabled: **TVmaze** (CC BY-SA, hotlinking and caching explicitly allowed, link-back credit) and **Wikimedia
  Commons** (per-file licenses from `extmetadata`; only PD/CC0/CC BY/CC BY-SA; descriptive User-Agent).
- Excluded: **Apple iTunes Search API** (artwork may only be used to promote store content, next to a store
  badge), **Internet Archive** (terms page could not be read; thumbnail service undocumented), **unofficial
  IMDb-keyed community image services** (rights unclear). No “unofficial sources” toggle is offered.

### Format versions

JSON export `formatVersion` 3 → **4** (optional `pack21` section; Recently-deleted items included). Schema
version 6 → **7**. The `.mpbackup` container stays at 1.

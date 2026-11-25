# Changelog

## 2.0.0 — Expansion Pack 2 (2026-11-25)

### New

- **Anime** media type on the TV progress model: romaji/English/native titles (choose which to show), format, airing status, season, source material, episode count and length, next airing episode, studios, adult flag (hidden by default, artwork blurred), and a sub/dub preference.
- **Anime sources:** Kitsu (default, keyless), official MyAnimeList API (your client ID), TMDB anime, and opt-in AniList and Jikan, plus **All anime sources** search, de-duplicated by cross IDs. Relations become franchise suggestions, and documented streaming links (allowlisted hosts) are shown with sub/dub languages.
- **MyAnimeList XML import** (`.xml`/`.xml.gz`) through the import preview, undoable.
- **Artwork Picker:** five slots (cover, banner, logo, icon, background), a parallel multi-source gallery (item source, TMDB, fanart.tv, SteamGridDB) with filters, preview and keyboard navigation. User choices are never replaced; "Revert to automatic" is available; per-type source priority; **bulk Auto-pick artwork**.
- **Pile Time** totals, What fits?, item estimates (yours, IGDB time-to-beat, or derived), with confidence.
- **Moods**, **Runs**, **Series & Next in series**, **Spoiler Shield**, **Pile Value**, **Sessions** (timer survives restarts), **Ownership & Leaving Soon**, **Recommendations** (offline, explained), **Share card** (local PNG), **Completion heatmap** (with table), **Duplicate merge** with exact undo, and a **Sync folder** (per-device append-only logs, preview, conflict review, snapshot and rollback).
- **Pick for Me:** Mood, Finish within (Pile Time) and "Only the next entry of ordered series" constraints.
- New **Pile** page; settings for anime, artwork, spoilers, currency, sessions, Leaving Soon, recommendations, moods and services.

### Changed

- **AniList is off by default** for every type, because its terms exclude list/tracker services. Re-enable it in Settings → Providers if you accept them. Jikan (unofficial, self-described scraper) is also off by default.
- Image downloads now follow redirects manually (at most 3 hops, same host or declared host only), check pixel dimensions from the header before decoding, and record dimensions and a SHA-256 hash. Proxied remote images get the same magic-byte and size checks.
- Settings → Providers shows each source's terms note and lists artwork-only sources.

### Fixed

- Wikidata type-matching regexes contained literal backspace characters instead of `\b` word boundaries (introduced in this development cycle, never released).

### Migration notes

- **Schema v4 → v6.** v6 adds the sync tables.
- **v5:** Some tables are rebuilt to widen CHECK lists; runs are back-filled from existing passes; existing artwork becomes each item's selected cover; nine moods are seeded. A `VACUUM INTO` backup is taken first, and the migration is tested with real v4 data.
- **JSON export `formatVersion` 2 → 3** (optional `pack2` section). Older files still import; newer ones are refused with a message. API keys and the reserved `sync` setting are never exported.
- **Not included:** per-field source choice *at import time* (per-field choice exists at refresh), and a preview step before bulk artwork auto-pick. Sync covers personal fields and item existence only (see `docs/sync.md`).

## 1.2.0 — Feature pack (2026-11-23)

### New

- **Steam library import.** Connect a Steam account with your own Web API key, load the games you own, review what you haven't played (Unplayed by default; non-games hidden), select with keyboard or mouse, and import as Planned with tags, a list and optional playtime-as-hours. Re-sync shows new, playtime-changed and removed games; nothing in the pile changes unless you choose. Games no longer in your Steam library are flagged, never deleted. Uses only the documented Steam Web API. See `docs/steam-import.md`.
- **Library sources.** A pluggable `LibrarySource` interface with Steam and a **paste/upload game list** source (for GOG, Xbox, PlayStation, Epic or physical shelves), sharing one review/import flow.
- **Import undo.** Every Steam, game-list and tracker import can be undone for 30 days (configurable). Only items you haven't touched are removed.
- **Pick for Me.** Constraint-aware weighted picker (type, list, tags, rating, time tonight, Up Next only, include In Progress/On Hold), "why it matched", Start it / Re-roll / Not now / Add to Up Next, history, and named empty-pool constraints with one-click loosening.
- **Up Next** is now a proper shelf: max size (default 10, 3–25), library filter, "remove from Up Next?" when starting, auto-removal on completion or drop.
- **Pile Health.** Stale Planned and idle In Progress items, with Keep / Snooze / On Hold / Drop triage, pile stats and trend, and an off switch. Never sends OS notifications.
- **Custom lists** with optional colour and icon, manual ordering, a library filter, bulk "Add to list…", and progress summaries.
- **Stats & Year in Review.** Accessible charts (text summaries, data tables, patterns) with CSV and PNG export, built from your real history.
- **Release Radar.** Upcoming releases with date precision and source, a provenance-respecting date refresh shown as a diff, `.ics` export, and opt-in local notifications (only while the app runs).
- **Tracker imports.** Goodreads CSV, Letterboxd export (.zip or CSVs) and a generic CSV column mapper with saved profiles, all through the import preview with row-level messages and conflict choices.
- **Command palette** (Ctrl/⌘+K) and **Quick Capture** (Ctrl/⌘+Shift+N, optional global shortcut).
- **Goals** with period boundaries, scope filters and plain-text pace with the math shown.
- **Settings → Features** for all new preferences; Steam settings in Settings → Providers.
- New dashboard components: Pile Health, Upcoming, Goals, Lists, Stats summary. Pick for Me and Up Next were upgraded.
- Optional theme tokens for state badges (snoozed, ignored, in pile, new).

### Changed

- Navigation: Lists, Stats and Import were added to the header, plus a **Search & commands** button.
- The dashboard "Pick something for me" widget is replaced by the full Pick for Me panel.
- The CSV parser accepts `;`, tab and `|` separated files (delimiter detection), including quoted fields.
- Log redaction also removes SteamID64 values.

### Fixed

- The CSV parser rejected a quoted field followed by a non-comma delimiter (found by the new tracker-import tests).
- Stats aggregation avoids rebuilding a date formatter per history row (10k items / 100k rows: ~9 s → ~0.9 s in `npm run bench`).

### Migration notes

- **Database schema v3 → v4** (automatic, transactional, with the usual pre-migration snapshot in `backups/`). The Up Next queue moves from `items.up_next_position` to the new `up_next` table **in the same order**, and the old column is dropped. New tables: `item_snoozes`, `pick_history`, `lists`, `list_items`, `library_sources`, `library_source_entries`, `import_batches`, `import_batch_items`, `goals`, `csv_mapping_profiles`, `release_notifications`.
- **JSON export `formatVersion` 2.** Adds lists, goals, snoozes, library sources, import batches and mapping profiles. Version-1 files still import. Maybe Pile 1.1 refuses version-2 files with an "update" message.
- **`.mpbackup` container `formatVersion` stays 1.** Backups made by 1.2 carry schema v4, which 1.1 refuses with an "update the app" message. 1.2 restores older backups by migrating the staged copy.
- **Layout files `schemaVersion` 2.** v1 files are migrated on import (new components appended with default visibility).
- **Theme files** are unchanged (`schemaVersion` 1). The four new colour tokens are optional.
- **Secrets:** the Steam Web API key is stored like other provider keys. It is never exported or backed up; re-enter it after moving computers.

## 1.1.0

- Keyless Wikidata and AniList providers, Up Next queue, "Pick something for me" and This-year stats.

## 1.0.0

- Initial release.

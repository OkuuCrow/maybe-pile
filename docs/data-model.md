# Data model

The schema is defined by `src/db/migrations/0001_core.ts`, `0002_search_and_audit.ts`, `0003_up_next_and_ids.ts` and `0004_feature_pack.ts`. Foreign keys are on (`PRAGMA foreign_keys = ON`), the journal is WAL, `synchronous = NORMAL`, and `busy_timeout` is 5 s. CHECK constraints mirror the enums in `src/shared/enums.ts` as a last line of defence; the services validate first.

## ER diagram

```
                          ┌──────────────┐
                          │   artwork    │◀───────────────┐ artwork_id (SET NULL)
                          └──────────────┘                │
┌─────────┐  ┌──────────────────┐   ┌───────────────────────┴─────────────────────────┐
│ genres  │◀─┤  item_genres     ├──▶│ items  (rid INTEGER PK, id TEXT UNIQUE)          │
└─────────┘  └──────────────────┘   │ type, title, sort_title, title_key, description,│
┌─────────┐  ┌──────────────────┐   │ release_date, release_year, status, rating,      │
│creators │◀─┤ item_creators(role)├─▶│ notes, date_added/started/completed, pass,       │
└─────────┘  └──────────────────┘   │ progress_pct, progress_label, created/updated_at,│
┌─────────┐  ┌──────────────────┐   │ deleted_at                                       │
│  tags   │◀─┤   item_tags      ├──▶└──┬──────┬───────┬────────┬───────┬───────┬──────┘
└─────────┘  └──────────────────┘      │      │       │        │       │       │
   item_alt_titles ◀───────────────────┤      │       │        │       │       │
   external_ids (kind,value) ◀─────────┤      │       │        │       │       │
   item_sources (provider,ref) ◀───────┤      │       │        │       │       │
   field_provenance (field,origin) ◀───┤      │       │        │       │       │
   custom_field_values ◀───────────────┤──▶ custom_field_defs ──▶ custom_field_options
   movie_details (1:1) ◀───────────────┘      │       │        │       │
   tv_details (1:1) ◀──────────────────────────┤       │        │       │
   seasons ◀───────────────────────────────────┘──▶ episodes   │       │
   game_details (1:1), game_platforms, game_milestones ◀────────┘       │
   book_details (1:1), series_members ──▶ book_series ◀─────────────────┘
   progress_events (→ game_milestones SET NULL, → episodes SET NULL)
   viewing_events
   audit_entries ──▶ audit_changes
   items_fts (FTS5, rowid = items.rid)

   up_next (position UNIQUE) · item_snoozes · pick_history · list_items ──▶ lists
   library_source_entries ──▶ library_sources ;  entries.item_id → items (SET NULL)
   import_batch_items ──▶ import_batches (──▶ library_sources SET NULL)
   goals (→ lists SET NULL) · release_notifications
   settings(key, value JSON) · themes(id, name, tokens JSON) · layout_components · csv_mapping_profiles · schema_migrations
```

All child tables reference `items(id)` with `ON DELETE CASCADE`. Lookup tables (`tags`, `genres`, `creators`) are pruned of orphans after deletes and bulk edits.

## Tables

| Table | Purpose / notes |
| --- | --- |
| `items` | One row per media item. (v3 added `up_next_position`; v4 moved the queue into the `up_next` table and dropped the column.) `rid` is an INTEGER PRIMARY KEY, which is stable across VACUUM and is the FTS rowid. `id` is a UUID used everywhere else. `sort_title` (articles dropped, numbers zero-padded) and `title_key` (folded) support sorting and duplicate detection. `rating` is 1–10 half-stars. `pass` counts re-watch/re-read runs. `progress_pct`/`progress_label` are a **cached derivation**, recomputed in the same transaction as every progress or metadata change, so lists can sort by progress. `deleted_at` holds soft-deleted items (undo); they are purged at next startup. |
| `item_alt_titles` | Ordered alternate titles. |
| `creators`, `item_creators` | Creator names (unique by folded name) and roles (director, writer, cast, creator, developer, publisher, author, translator, narrator, illustrator). |
| `genres`, `item_genres` | Genre lookups. |
| `tags`, `item_tags` | Tags are unique case- and accent-insensitively via `name_key`; the first spelling is kept. |
| `external_ids` | One row per kind: `tmdb, imdb, tvmaze, openlibrary, isbn10, isbn13, igdb, steam, xbox, playstation, wikidata, anilist, mal` (the last three added in v3, which rebuilt the table to widen its CHECK constraint). Store kinds hold an app ID (Steam) or an allowlisted URL. Indexed by `(kind, value)` for duplicate detection. |
| `item_sources` | Provider, provider ref, URL and `fetched_at` for attribution and refresh. |
| `field_provenance` | Per metadata field: `origin` (`provider` \| `user` \| `manual-entry`), `provider_id`, `provider_value` (canonical JSON of the provider's last value), `updated_at`. |
| `custom_field_defs`, `custom_field_options`, `custom_field_values` | User-defined fields of type text, number, date, boolean or select. Values use `text_value` *or* `number_value` (CHECK exactly one). Booleans are 0/1; dates are text `YYYY-MM-DD`. |
| `movie_details` | runtime, original language, age rating. |
| `tv_details`, `seasons`, `episodes` | Network, show status, episode runtime, last air date. Season 0 = specials. `episode_count_known` may be NULL (unknown). `episodes.watched`/`watched_at` hold the current state; `source` (`provider`/`user`) protects user-edited episodes from refresh overwrites. |
| `game_details`, `game_platforms`, `game_milestones` | Progress scheme (`percent`/`hours`/`milestones`/`text`), owned/played platforms, ordered milestones. |
| `book_details`, `book_series`, `series_members` | ISBNs, publisher, nullable page count, format, audiobook length. Series have an optional known total; members have an optional (fractional) position. |
| `progress_events` | Append-mostly history: kind, value/text, `total_at_time` (page count when a pages entry was recorded), milestone (with a title snapshot), episode label, watched flag, game `scheme` at the time, `pass`, `occurred_at` (editable), `recorded_at`, note, `deleted_at`. `seq` breaks ties. |
| `viewing_events` | Movie viewings (optional date, note, pass). |
| `audit_entries`, `audit_changes` | Metadata refresh/import log: which fields changed, old and new display values. |
| `artwork` | `source` = `cache` (provider image stored), `user` (local file) or `remote` (URL only, per provider terms). File names are content hashes. |
| `settings` | Key → JSON value (see exceptions below). |
| `themes` | Custom themes (built-ins live in code). |
| `layout_components` | `(surface, component_id) → position, visible, span`, fully normalized. |
| `items_fts` | FTS5 index over title, alt titles, creators, tags and notes, with `unicode61 remove_diacritics 2`. |
| `schema_migrations` | version, name, checksum, applied_at. |
| `up_next` (v4) | `item_id` PK → items CASCADE, `position` **UNIQUE** ≥ 0, `added_at`. Positions are compacted to 0..n-1; swaps use a free temporary slot. |
| `item_snoozes` (v4) | `item_id` PK → items CASCADE, `until` (local date, inclusive), `reason` (`manual` \| `pile-health` \| `keep`). |
| `pick_history` (v4) | Pick for Me picks: `item_id`, `picked_at`, `outcome` (`shown` \| `started` \| `skipped` \| `queued`), `skip_until`. Trimmed to 200 rows. |
| `lists`, `list_items` (v4) | Custom lists (`name_key` UNIQUE, optional `color`/`icon` enums, `position`) and ordered memberships; both CASCADE. Deleting a list deletes only memberships. |
| `library_sources` (v4) | `kind` (`steam` \| `manual`), label, `account_input` (as typed), `account_ref` (resolved SteamID64), last sync time/status. **No key column**: keys live in `secrets.json`. |
| `library_source_entries` (v4) | Per-source snapshot keyed by `(source_id, external_id)`: name, platform, `playtime_minutes`, `prev_playtime_minutes` (for re-sync diffs), `last_played_at`, `non_game_reason`, `first_seen_at`, `seen_at`, `removed_at` (no longer in the library, never deleted), `ignored`, `item_id` → items SET NULL. |
| `import_batches`, `import_batch_items` (v4) | Undoable import records: kind (`steam`, `manual-list`, `goodreads`, `letterboxd`, `csv-mapped`), label, `undone_at`. Items keep a baseline `"<updated_at>\|<content fingerprint>"` and history count; undo removes only items whose fingerprint and history are unchanged. Purged after the retention period (default 30 days). |
| `goals` (v4) | Target, metric (`items`/`pages`/`episodes`/`hours`), period (`year`/`month`/`custom`) with resolved `start_date`/`end_date` (CHECK end ≥ start), optional `media_type`, `list_id` (SET NULL), `tag`, `archived_at`. |
| `csv_mapping_profiles` (v4) | Saved CSV column mappings (`name_key` UNIQUE, `mapping` JSON). |
| `release_notifications` (v4) | `(item_id, release_date, kind)` → when the "today"/"tomorrow" notification was shown, so each fires once. |

## Deliberate JSON exceptions

| Column | Why JSON | Safeguard |
| --- | --- | --- |
| `settings.value` | Small, heterogeneous preferences (e.g. the saved library query). Never queried by content. | Each key is validated by its Zod schema on read; invalid values fall back to defaults and are logged. `CHECK (json_valid(value))`. |
| `themes.tokens` | An opaque token map applied as a whole; never queried by column. | Re-validated with `ThemeTokensSchema` on every read. A corrupt active theme falls back to Pile Light with a notice. `CHECK (json_valid(tokens))`. |
| `csv_mapping_profiles.mapping` | A small mapping object applied as a whole; never queried by content. | Validated with `CsvMappingSchema` on read and on save; invalid rows are skipped. `CHECK (json_valid(mapping))`. |
| `field_provenance.provider_value` | A snapshot of the provider's last value (scalar or list) used only for equality comparison during refresh. | Produced only by `canonicalValue()`; never parsed back into data. |

## Full-text search design

`items_fts` is a standalone FTS5 table whose `rowid = items.rid`. Service code calls `reindexItem(id)` inside the same transaction as every write that changes indexed text (create, update, tag changes, bulk tag edits, soft delete/undo, import). That's simpler to reason about and test than triggers across six tables. Queries are built by `ftsQuery()`: the input is split on non-letter/digit characters, and each token is quoted and prefix-matched (`"tok"*`) and ANDed, so user input can never inject FTS syntax. Migration v2 back-fills the index for existing libraries; `tests/integration/migrations.test.ts` checks this.

## Partial dates

Release, air and publication dates are `YYYY`, `YYYY-MM` or `YYYY-MM-DD` and are validated for real calendar days. `release_year` is stored separately for duplicate checks. Personal dates (added/started/completed) are always full local calendar dates with no time zone conversion. Timestamps are UTC ISO-8601.


## Schema v5 (Expansion Pack 2)

| Table / column | Purpose |
| --- | --- |
| `items.type` gains `anime`; `item_creators.role` gains `studio`; `external_ids.kind` gains `kitsu`; `goals.media_type` gains `anime`; `import_batches.kind` gains `mal-xml` | Tables rebuilt with foreign keys temporarily off (`rid` preserved, so FTS keeps working). |
| `anime_details` | Format, airing status, season/year, source, episode count/length, next episode, adult flag, romaji/English/native titles. |
| `item_prefs` | Spoiler mode, notes-are-spoilers, hours source, audio preference. |
| `time_estimates` (item, source manual\|provider) | Pile Time estimates. |
| `moods`, `item_moods` | Moods (9 built-ins seeded). |
| `item_runs`, `run_episode_states` | Runs and snapshots of finished runs' episode checkmarks. |
| `item_relations`, `relation_suggestions`, `franchises`, `franchise_items` | Links, provider suggestions, ordered series. |
| `purchases` | `amount_minor` integer + ISO 4217 `currency`. |
| `sessions` | Timer state (`accumulated_seconds`, `segment_started_at`), plus CHECKs tying state to its columns. |
| `services`, `availability_entries`, `availability_notifications` | Ownership, subscriptions, Leaving Soon. |
| `rec_feedback` | Not now / Not interested. |
| `merged_ids`, `duplicate_dismissals`, `merge_snapshots` | Duplicate merge, its history, and undo snapshots (JSON, deliberately). |
| `streaming_links` | Provider-documented where-to-watch links (allowlisted https only). |
| `artwork` + `item_id, slot, origin, source_asset_id, width, height, language, license_note, attribution_text, cache_state, sha256, selected, user_selected, is_auto, adult, fetched_at` | Multi-slot artwork. A unique partial index allows one selected image per (item, slot). `items.artwork_id` still mirrors the selected cover. |

Deliberate JSON columns: `merge_snapshots.snapshot` (an opaque restore blob) and `streaming_links.subs` / `dubs` (short language-code arrays, validated with `json_valid`).

## Schema v6 (sync)

`sync_state`, `sync_baseline` (`fields` is deliberately JSON: an opaque per-key snapshot), `sync_cursors` and `sync_conflicts` (local and remote values as JSON). See [sync.md](sync.md).

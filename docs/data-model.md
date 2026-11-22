# Data model

The schema is defined by `src/db/migrations/0001_core.ts` and `0002_search_and_audit.ts`. Foreign keys are on (`PRAGMA foreign_keys = ON`), the journal is WAL, `synchronous = NORMAL`, and `busy_timeout` is 5 s. CHECK constraints mirror the enums in `src/shared/enums.ts` as a last line of defence; the services validate first.

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

   settings(key, value JSON) · themes(id, name, tokens JSON) · layout_components · schema_migrations
```

All child tables reference `items(id)` with `ON DELETE CASCADE`. Lookup tables (`tags`, `genres`, `creators`) are pruned of orphans after deletes and bulk edits.

## Tables

| Table | Purpose / notes |
| --- | --- |
| `items` | One row per media item. `rid` is an INTEGER PRIMARY KEY, which is stable across VACUUM and is the FTS rowid. `id` is a UUID used everywhere else. `sort_title` (articles dropped, numbers zero-padded) and `title_key` (folded) support sorting and duplicate detection. `rating` is 1–10 half-stars. `pass` counts re-watch/re-read runs. `progress_pct`/`progress_label` are a **cached derivation**, recomputed in the same transaction as every progress or metadata change, so lists can sort by progress. `deleted_at` holds soft-deleted items (undo); they are purged at next startup. |
| `item_alt_titles` | Ordered alternate titles. |
| `creators`, `item_creators` | Creator names (unique by folded name) and roles (director, writer, cast, creator, developer, publisher, author, translator, narrator, illustrator). |
| `genres`, `item_genres` | Genre lookups. |
| `tags`, `item_tags` | Tags are unique case- and accent-insensitively via `name_key`; the first spelling is kept. |
| `external_ids` | One row per kind: `tmdb, imdb, tvmaze, openlibrary, isbn10, isbn13, igdb, steam, xbox, playstation`. Store kinds hold an app ID (Steam) or an allowlisted URL. Indexed by `(kind, value)` for duplicate detection. |
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

## Deliberate JSON exceptions

| Column | Why JSON | Safeguard |
| --- | --- | --- |
| `settings.value` | Small, heterogeneous preferences (e.g. the saved library query). Never queried by content. | Each key is validated by its Zod schema on read; invalid values fall back to defaults and are logged. `CHECK (json_valid(value))`. |
| `themes.tokens` | An opaque token map applied as a whole; never queried by column. | Re-validated with `ThemeTokensSchema` on every read. A corrupt active theme falls back to Pile Light with a notice. `CHECK (json_valid(tokens))`. |
| `field_provenance.provider_value` | A snapshot of the provider's last value (scalar or list) used only for equality comparison during refresh. | Produced only by `canonicalValue()`; never parsed back into data. |

## Full-text search design

`items_fts` is a standalone FTS5 table whose `rowid = items.rid`. Service code calls `reindexItem(id)` inside the same transaction as every write that changes indexed text (create, update, tag changes, bulk tag edits, soft delete/undo, import). That's simpler to reason about and test than triggers across six tables. Queries are built by `ftsQuery()`: the input is split on non-letter/digit characters, and each token is quoted and prefix-matched (`"tok"*`) and ANDed, so user input can never inject FTS syntax. Migration v2 back-fills the index for existing libraries; `tests/integration/migrations.test.ts` checks this.

## Partial dates

Release, air and publication dates are `YYYY`, `YYYY-MM` or `YYYY-MM-DD` and are validated for real calendar days. `release_year` is stored separately for duplicate checks. Personal dates (added/started/completed) are always full local calendar dates with no time zone conversion. Timestamps are UTC ISO-8601.

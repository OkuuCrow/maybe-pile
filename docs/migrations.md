# Database migrations

The runner is `src/db/migrate.ts`. Migrations live in `src/db/migrations/NNNN_name.ts` and are registered in `MIGRATIONS`.

## Guarantees

- **Ordered and contiguous:** versions must be 1..N with no gaps, or startup fails loudly.
- **Idempotent:** applied versions are recorded in `schema_migrations`, so re-running is a no-op.
- **Transactional:** each migration's SQL and its bookkeeping row commit together, because SQLite DDL is transactional. A failure rolls back to the previous version exactly.
- **Tamper-evident:** each applied migration's SHA-256 checksum is stored. If a released migration's SQL is edited, startup is refused.
- **Snapshotted:** before the first pending migration on an existing library, `DatabaseManager` writes `backups/pre-migration-v<from>-to-v<to>-<timestamp>.sqlite` via `VACUUM INTO`. The last 3 are kept.
- **Forward-only (up-only):** there are no down migrations. Recovery uses the pre-migration snapshot instead (see below).
- **Newer schema refused:** if the library's version is higher than the app knows, the app shows a dialog offering read-only mode or quit, and never downgrades.

After an upgrade the UI shows a one-time notice: "Your library was upgraded from schema vX to vY…".

## Adding a migration

1. Create `src/db/migrations/0003_short_name.ts`, exporting `{ version: 3, name: 'short_name', sql: \`…\` }`.
2. Append it to `MIGRATIONS` in `src/db/migrate.ts`. `LATEST_SCHEMA_VERSION` updates automatically.
3. Write SQL that works on existing data. Back-fill new columns and tables from existing rows in the same migration, as `0002` does for FTS. Avoid `DROP COLUMN` on large tables when a new table plus copy is clearer.
4. **Never edit a released migration.** Add another one.
5. If the change adds data to exports, bump `EXPORT_FORMAT_VERSION`/`BACKUP_FORMAT_VERSION` only when old app versions could no longer read the file, and keep import of older versions working.

### Testing checklist

- [ ] Fresh DB → latest (`tests/integration/migrations.test.ts › creates a fresh database`).
- [ ] Previous version with realistic rows → latest, asserting row contents, FK integrity (`foreign_key_check`) and any back-fill (FTS, defaults).
- [ ] Failure injection: `migrate(db, { failAtVersion: N })` must leave the DB at N-1 and a retry must succeed.
- [ ] Restoring an older-version backup migrates the **staged copy** (`backup-service`) and is covered by tests.
- [ ] `npm run bench` still meets the performance targets.

## Recovering from a failed migration

If a migration fails, its transaction is rolled back and the library stays at the previous version. The app shows "Maybe Pile could not open your library" and opens the data folder. To recover:

1. Quit Maybe Pile.
2. Open the data folder (Windows `%APPDATA%\MaybePile`, macOS `~/Library/Application Support/MaybePile`, Linux `~/.config/MaybePile`, portable `MaybePileData` next to the exe).
3. Rename `library.sqlite` to `library.sqlite.broken`, and delete `library.sqlite-wal` / `library.sqlite-shm` if present.
4. Copy the newest `backups/pre-migration-v*-to-v*-*.sqlite` to `library.sqlite`.
5. Start the **previous** version of Maybe Pile. That snapshot predates the upgrade, so the new version would try the same migration again.
6. Report the problem with the diagnostic log (Settings → Data & Behavior → Export diagnostic log, or `logs/maybepile.log`). The log contains event names and error codes, not titles or notes.

Alternatively, if you have a `.mpbackup`, install the previous version and restore it.

## Migration history

| Version | Name | Notes |
| --- | --- | --- |
| 1 | `core` | Base schema. |
| 2 | `search_and_audit` | FTS5 index (back-filled) and metadata audit log. |
| 3 | `up_next_and_ids` | `items.up_next_position`; `external_ids` rebuilt for Wikidata/AniList/MAL kinds. |
| 4 | `feature_pack` (app 1.2) | Creates `up_next` and **copies the existing queue in order** (positions renumbered 0..n-1), then drops `items.up_next_position` and its index. Adds `item_snoozes`, `pick_history`, `lists`, `list_items`, `library_sources`, `library_source_entries`, `import_batches`, `import_batch_items`, `goals`, `csv_mapping_profiles`, `release_notifications`. New settings keys need no migration: missing keys fall back to defaults. |

v4 is covered by `tests/integration/feature-pack.test.ts › migration v3 → v4`: realistic v3 rows → latest, queue order preserved, column dropped, every new table present, `foreign_key_check` and `integrity_check` clean, failure injection at v4 leaves v3 untouched, and opening an older library through `DatabaseManager` records the pre-migration snapshot.

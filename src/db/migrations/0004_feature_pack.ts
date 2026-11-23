/**
 * v4 — "feature pack": Up Next table, snoozes, pick history, custom lists,
 * library sources (Steam + manual lists), import batches (undo), goals,
 * CSV mapping profiles and release notifications.
 *
 * Up Next moves from `items.up_next_position` to its own table with a UNIQUE
 * position, so ordering is a real constraint rather than a convention. The
 * existing queue is copied in its current order before the column is dropped.
 * Everything runs in one transaction (see migrate.ts); a failure leaves v3.
 */
export const migration0004 = {
  version: 4,
  name: 'feature_pack',
  sql: `
CREATE TABLE up_next (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  added_at TEXT NOT NULL
);
INSERT INTO up_next (item_id, position, added_at)
SELECT id, (SELECT count(*) FROM items j
            WHERE j.up_next_position IS NOT NULL
              AND (j.up_next_position < i.up_next_position OR (j.up_next_position = i.up_next_position AND j.id < i.id))),
       updated_at
FROM items i WHERE i.up_next_position IS NOT NULL;
DROP INDEX idx_items_up_next;
ALTER TABLE items DROP COLUMN up_next_position;

CREATE TABLE item_snoozes (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  until TEXT NOT NULL CHECK (until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reason TEXT NOT NULL DEFAULT 'manual' CHECK (reason IN ('manual', 'pile-health', 'keep')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_item_snoozes_until ON item_snoozes(until);

CREATE TABLE pick_history (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  picked_at TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'shown' CHECK (outcome IN ('shown', 'started', 'skipped', 'queued')),
  skip_until TEXT CHECK (skip_until IS NULL OR skip_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500)
);
CREATE INDEX idx_pick_history_at ON pick_history(picked_at);
CREATE INDEX idx_pick_history_skip ON pick_history(item_id, skip_until);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL UNIQUE,
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  color TEXT CHECK (color IS NULL OR color IN ('slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink')),
  icon TEXT CHECK (icon IS NULL OR icon IN ('list', 'star', 'heart', 'ghost', 'users', 'plane', 'flame', 'leaf')),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE list_items (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  added_at TEXT NOT NULL,
  PRIMARY KEY (list_id, item_id)
);
CREATE INDEX idx_list_items_item ON list_items(item_id);
CREATE INDEX idx_list_items_order ON list_items(list_id, position);

CREATE TABLE library_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('steam', 'manual')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  account_ref TEXT CHECK (account_ref IS NULL OR account_ref GLOB '[0-9]*'),
  account_input TEXT CHECK (account_input IS NULL OR length(account_input) <= 200),
  last_synced_at TEXT,
  last_sync_status TEXT CHECK (last_sync_status IS NULL OR last_sync_status IN ('ok', 'private', 'error', 'cancelled', 'empty')),
  created_at TEXT NOT NULL
);

CREATE TABLE library_source_entries (
  source_id TEXT NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  name TEXT NOT NULL CHECK (length(name) <= 500),
  platform TEXT CHECK (platform IS NULL OR length(platform) <= 80),
  playtime_minutes INTEGER CHECK (playtime_minutes IS NULL OR playtime_minutes >= 0),
  prev_playtime_minutes INTEGER CHECK (prev_playtime_minutes IS NULL OR prev_playtime_minutes >= 0),
  last_played_at TEXT,
  non_game_reason TEXT CHECK (non_game_reason IS NULL OR length(non_game_reason) <= 80),
  first_seen_at TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  removed_at TEXT,
  ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  PRIMARY KEY (source_id, external_id)
);
CREATE INDEX idx_source_entries_item ON library_source_entries(item_id);
CREATE INDEX idx_source_entries_name ON library_source_entries(source_id, name);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('steam', 'manual-list', 'goodreads', 'letterboxd', 'csv-mapped')),
  source_id TEXT REFERENCES library_sources(id) ON DELETE SET NULL,
  label TEXT NOT NULL CHECK (length(label) <= 200),
  created_at TEXT NOT NULL,
  undone_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0)
);
CREATE INDEX idx_import_batches_created ON import_batches(created_at);
CREATE TABLE import_batch_items (
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= 500),
  baseline_updated_at TEXT NOT NULL,
  baseline_events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, item_id)
);
CREATE INDEX idx_import_batch_items_item ON import_batch_items(item_id);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('movie', 'tv', 'game', 'book')),
  metric TEXT NOT NULL CHECK (metric IN ('items', 'pages', 'episodes', 'hours')),
  period TEXT NOT NULL CHECK (period IN ('year', 'month', 'custom')),
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date TEXT NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  target INTEGER NOT NULL CHECK (target BETWEEN 1 AND 1000000),
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  tag TEXT CHECK (tag IS NULL OR length(tag) <= 64),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE TABLE csv_mapping_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL UNIQUE,
  mapping TEXT NOT NULL CHECK (json_valid(mapping)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE release_notifications (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  release_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tomorrow', 'today')),
  notified_at TEXT NOT NULL,
  PRIMARY KEY (item_id, release_date, kind)
);
`,
} as const;

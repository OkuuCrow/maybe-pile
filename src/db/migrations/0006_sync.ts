/**
 * v6 — Sync folder (Expansion Pack 2, feature 13).
 *
 * Sync is snapshot-diff based (no triggers): at each sync the current synced
 * fields of every item are compared with `sync_baseline` (the values both
 * sides last agreed on). Local differences become an outgoing changeset;
 * remote changes apply only where the local value still equals the baseline,
 * otherwise they become `sync_conflicts` for the user to review.
 */
export const migration0006 = {
  version: 6,
  name: 'sync',
  sql: `
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY CHECK (key IN ('device_id', 'last_seq')),
  value TEXT NOT NULL
);
CREATE TABLE sync_baseline (
  entity_key TEXT PRIMARY KEY CHECK (length(entity_key) BETWEEN 3 AND 700),
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  updated_at TEXT NOT NULL
);
CREATE TABLE sync_cursors (
  device_id TEXT PRIMARY KEY CHECK (length(device_id) = 36),
  last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
  read_at TEXT NOT NULL
);
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL CHECK (length(entity_key) <= 700),
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  item_title TEXT NOT NULL CHECK (length(item_title) <= 500),
  field TEXT NOT NULL CHECK (field IN ('status', 'rating', 'notes', 'dateStarted', 'dateCompleted', 'tags', 'deleted')),
  local_value TEXT NOT NULL CHECK (json_valid(local_value)),
  remote_value TEXT NOT NULL CHECK (json_valid(remote_value)),
  remote_device TEXT NOT NULL CHECK (length(remote_device) = 36),
  remote_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('mine', 'theirs'))
);
CREATE INDEX idx_sync_conflicts_open ON sync_conflicts(resolved_at) WHERE resolved_at IS NULL;
`,
} as const;

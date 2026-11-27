/**
 * v7 — Notifications Pack + Simple Mode (2.1.0). One consolidated migration.
 *
 * New tables only, plus three additive ALTERs (no table rebuilds, so foreign
 * keys stay ON):
 *  - reminders            custom reminders (structured repeat rules, never expressions)
 *  - app_events           last backup / last check-up / offline-queue completion instants
 *  - item_next_steps      §16.5 "Next step" line
 *  - checklists, checklist_items   §14.9
 *  - people, loans, item_recommenders   §14.10 / §16.9 (third-party names, local only)
 *  - saved_views          §14.4 (validated JSON query, a documented JSON exception)
 *  - item_templates       §14.5 (validated JSON body, a documented JSON exception)
 *  - journal_entries (+ journal_fts)   §16.10
 *  - change_log           §16.1 Recent changes (no notes text, ever)
 *  - lookup_queue         §16.6 offline add queue
 *  - time_goals           §14.1 time-based goals (time comes from `sessions`)
 *  - item_flags           §16.7 "stale" flag (never deletes)
 *  - artwork_palettes     §15 ambient backdrop palette cache (derived; regenerates)
 *  - episodes.skipped, run_episode_states.skipped   §16.8
 *  - item_prefs.backdrop_style                      §15.6 per-item override
 *
 * Upgrade behavior for Simple Mode: an existing library (any item or any
 * stored setting) gets `interface.level = 'full'` so upgrading users see no
 * surprise changes; new libraries keep the Simple default.
 */
const DATE = `GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;
const HHMM = `GLOB '[0-2][0-9]:[0-5][0-9]'`;

export const migration0007 = {
  version: 7,
  name: 'notifications_pack',
  sql: `
INSERT INTO settings (key, value)
SELECT 'interface', '{"level":"full","simpleOfferDismissed":false,"firstRunDone":true}'
WHERE (EXISTS (SELECT 1 FROM items) OR EXISTS (SELECT 1 FROM settings))
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'interface');

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 140),
  kind TEXT NOT NULL CHECK (kind IN ('once', 'repeat')),
  anchor_at TEXT NOT NULL,
  anchor_date TEXT NOT NULL CHECK (anchor_date ${DATE}),
  local_time TEXT NOT NULL CHECK (local_time ${HHMM}),
  repeat_freq TEXT CHECK (repeat_freq IS NULL OR repeat_freq IN ('daily', 'weekly', 'monthly', 'weekdays')),
  repeat_interval INTEGER NOT NULL DEFAULT 1 CHECK (repeat_interval BETWEEN 1 AND 30),
  repeat_weekdays INTEGER NOT NULL DEFAULT 0 CHECK (repeat_weekdays BETWEEN 0 AND 127),
  next_fire_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'once') = (repeat_freq IS NULL))
);
CREATE INDEX idx_reminders_item ON reminders(item_id);

CREATE TABLE app_events (
  key TEXT PRIMARY KEY CHECK (key IN ('last_backup', 'last_checkup', 'offline_queue_finished', 'last_backup_dir_check')),
  at TEXT NOT NULL,
  value TEXT CHECK (value IS NULL OR length(value) <= 2000)
);

CREATE TABLE item_next_steps (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 140),
  spoiler INTEGER NOT NULL DEFAULT 0 CHECK (spoiler IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE checklists (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  position INTEGER NOT NULL CHECK (position >= 0),
  checked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_checklist_items ON checklist_items(checklist_id, position);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL UNIQUE,
  forgotten INTEGER NOT NULL DEFAULT 0 CHECK (forgotten IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lent', 'borrowed')),
  loaned_on TEXT NOT NULL CHECK (loaned_on ${DATE}),
  due_on TEXT CHECK (due_on IS NULL OR due_on ${DATE}),
  returned_on TEXT CHECK (returned_on IS NULL OR returned_on ${DATE}),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_loans_item ON loans(item_id);
CREATE INDEX idx_loans_open ON loans(returned_on) WHERE returned_on IS NULL;
CREATE TABLE item_recommenders (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  recommended_on TEXT CHECK (recommended_on IS NULL OR recommended_on ${DATE}),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_item_recommenders_person ON item_recommenders(person_id);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL UNIQUE,
  query TEXT NOT NULL CHECK (json_valid(query) AND length(query) <= 20000),
  view_mode TEXT NOT NULL DEFAULT 'grid' CHECK (view_mode IN ('grid', 'list', 'wall')),
  position INTEGER NOT NULL CHECK (position >= 0),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE item_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL CHECK (json_valid(body) AND length(body) <= 20000),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE journal_entries (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES item_runs(id) ON DELETE SET NULL,
  entry_date TEXT NOT NULL CHECK (entry_date ${DATE}),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  progress_label TEXT CHECK (progress_label IS NULL OR length(progress_label) <= 40),
  spoiler INTEGER NOT NULL DEFAULT 0 CHECK (spoiler IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_journal_item ON journal_entries(item_id, entry_date);
CREATE VIRTUAL TABLE journal_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE change_log (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'bulk', 'rule', 'triage', 'restore', 'trash')),
  field TEXT NOT NULL CHECK (length(field) <= 40),
  old_value TEXT CHECK (old_value IS NULL OR length(old_value) <= 600),
  new_value TEXT CHECK (new_value IS NULL OR length(new_value) <= 600),
  undone_at TEXT
);
CREATE INDEX idx_change_log_at ON change_log(at);
CREATE INDEX idx_change_log_item ON change_log(item_id, field, at);
CREATE INDEX idx_change_log_batch ON change_log(batch_id);

CREATE TABLE lookup_queue (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  query TEXT NOT NULL CHECK (length(query) BETWEEN 1 AND 200),
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'game', 'book', 'anime')),
  year INTEGER CHECK (year IS NULL OR year BETWEEN 1800 AND 2200),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'found', 'no_match', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
  candidates TEXT CHECK (candidates IS NULL OR (json_valid(candidates) AND length(candidates) <= 20000)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE time_goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  target_minutes INTEGER NOT NULL CHECK (target_minutes BETWEEN 1 AND 10080),
  period TEXT NOT NULL CHECK (period IN ('day', 'week')),
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('movie', 'tv', 'game', 'book', 'anime')),
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  mood_id TEXT REFERENCES moods(id) ON DELETE SET NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE item_flags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  flag TEXT NOT NULL CHECK (flag IN ('stale')),
  set_at TEXT NOT NULL,
  PRIMARY KEY (item_id, flag)
);

CREATE TABLE artwork_palettes (
  artwork_id TEXT PRIMARY KEY REFERENCES artwork(id) ON DELETE CASCADE,
  colors TEXT NOT NULL CHECK (json_valid(colors) AND length(colors) <= 400),
  luminance REAL NOT NULL CHECK (luminance BETWEEN 0 AND 1),
  computed_at TEXT NOT NULL
);

ALTER TABLE episodes ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1));
ALTER TABLE run_episode_states ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1));
ALTER TABLE item_prefs ADD COLUMN backdrop_style TEXT NOT NULL DEFAULT 'default'
  CHECK (backdrop_style IN ('default', 'off', 'ambient', 'banner', 'blurred'));
`,
} as const;

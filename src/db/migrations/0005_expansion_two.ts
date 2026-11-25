/**
 * v5 — Expansion Pack 2: anime, multi-slot artwork, Pile Time estimates,
 * moods, runs, franchise links, purchases, sessions, ownership/services,
 * recommendation feedback, duplicate merges and per-item preferences.
 *
 * Table rebuilds (SQLite cannot alter a CHECK constraint): `items` (new type
 * `anime`), `item_creators` (role `studio`), `external_ids` (kind `kitsu`),
 * `goals` (media type `anime`) and `import_batches` (kind `mal-xml`).
 * `items` is referenced by ~30 tables with ON DELETE CASCADE, so this
 * migration runs with foreign keys OFF (`foreignKeysOff`, SQLite's 12-step
 * procedure); the runner refuses to commit unless `PRAGMA foreign_key_check`
 * is clean. `items.rid` is copied verbatim, so the FTS index (rowid = rid)
 * stays valid without a rebuild.
 *
 * Runs back-fill: every item gets runs 1..items.pass. The latest run mirrors
 * the item's status/dates/rating. Earlier runs are Completed (a new pass could
 * only start from Completed); the previous run inherits `date_completed` when
 * the item was re-opened without clearing it. Earlier runs' episode states are
 * reconstructed (best effort) from per-episode history events.
 */
const UUID = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`;
const DATE = `GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;

const MOODS: [string, string, string][] = [
  ['cozy', 'Cozy', 'sofa'],
  ['short', 'Short', 'clock'],
  ['brain-off', 'Brain-off', 'cloud'],
  ['intense', 'Intense', 'bolt'],
  ['emotional', 'Emotional', 'heart'],
  ['funny', 'Funny', 'laugh'],
  ['co-op', 'Co-op', 'users'],
  ['comfort-rewatch', 'Comfort rewatch', 'repeat'],
  ['challenging', 'Challenging', 'mountain'],
];

export const migration0005 = {
  version: 5,
  name: 'expansion_two',
  foreignKeysOff: true,
  sql: `
CREATE TABLE items_v5 (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('movie', 'tv', 'game', 'book', 'anime')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  sort_title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  description TEXT CHECK (description IS NULL OR length(description) <= 20000),
  release_date TEXT CHECK (release_date IS NULL OR release_date GLOB '[0-9][0-9][0-9][0-9]*'),
  release_year INTEGER,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'on_hold', 'dropped')),
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 100000),
  date_added TEXT NOT NULL CHECK (date_added ${DATE}),
  date_started TEXT CHECK (date_started IS NULL OR date_started ${DATE}),
  date_completed TEXT CHECK (date_completed IS NULL OR date_completed ${DATE}),
  pass INTEGER NOT NULL DEFAULT 1 CHECK (pass >= 1),
  artwork_id TEXT REFERENCES artwork(id) ON DELETE SET NULL,
  progress_pct REAL CHECK (progress_pct IS NULL OR progress_pct BETWEEN 0 AND 100),
  progress_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO items_v5 (rid, id, type, title, sort_title, title_key, description, release_date, release_year,
  status, rating, notes, date_added, date_started, date_completed, pass, artwork_id, progress_pct,
  progress_label, created_at, updated_at, deleted_at)
SELECT rid, id, type, title, sort_title, title_key, description, release_date, release_year,
  status, rating, notes, date_added, date_started, date_completed, pass, artwork_id, progress_pct,
  progress_label, created_at, updated_at, deleted_at
FROM items;
DROP TABLE items;
ALTER TABLE items_v5 RENAME TO items;
CREATE INDEX idx_items_type ON items(type);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_date_added ON items(date_added);
CREATE INDEX idx_items_updated_at ON items(updated_at);
CREATE INDEX idx_items_rating ON items(rating);
CREATE INDEX idx_items_sort_title ON items(sort_title);
CREATE INDEX idx_items_release_date ON items(release_date);
CREATE INDEX idx_items_progress ON items(progress_pct);
CREATE INDEX idx_items_dupe ON items(type, title_key, release_year);
CREATE INDEX idx_items_deleted ON items(deleted_at);
CREATE INDEX idx_items_completed ON items(date_completed);

CREATE TABLE item_creators_v5 (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('director','writer','cast','creator','developer','publisher','author','translator','narrator','illustrator','studio')),
  position INTEGER NOT NULL,
  PRIMARY KEY (item_id, creator_id, role)
);
INSERT INTO item_creators_v5 SELECT item_id, creator_id, role, position FROM item_creators;
DROP TABLE item_creators;
ALTER TABLE item_creators_v5 RENAME TO item_creators;
CREATE INDEX idx_item_creators_creator ON item_creators(creator_id);

CREATE TABLE external_ids_v5 (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tmdb','imdb','tvmaze','openlibrary','isbn10','isbn13','igdb','steam','xbox','playstation','wikidata','anilist','mal','kitsu')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 300),
  PRIMARY KEY (item_id, kind)
);
INSERT INTO external_ids_v5 SELECT item_id, kind, value FROM external_ids;
DROP TABLE external_ids;
ALTER TABLE external_ids_v5 RENAME TO external_ids;
CREATE INDEX idx_external_ids_lookup ON external_ids(kind, value);

CREATE TABLE goals_v5 (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('movie', 'tv', 'game', 'book', 'anime')),
  metric TEXT NOT NULL CHECK (metric IN ('items', 'pages', 'episodes', 'hours')),
  period TEXT NOT NULL CHECK (period IN ('year', 'month', 'custom')),
  start_date TEXT NOT NULL CHECK (start_date ${DATE}),
  end_date TEXT NOT NULL CHECK (end_date ${DATE}),
  target INTEGER NOT NULL CHECK (target BETWEEN 1 AND 1000000),
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  tag TEXT CHECK (tag IS NULL OR length(tag) <= 64),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (end_date >= start_date)
);
INSERT INTO goals_v5 SELECT id, title, media_type, metric, period, start_date, end_date, target, list_id, tag,
  archived_at, created_at FROM goals;
DROP TABLE goals;
ALTER TABLE goals_v5 RENAME TO goals;

CREATE TABLE import_batches_v5 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('steam', 'manual-list', 'goodreads', 'letterboxd', 'csv-mapped', 'mal-xml')),
  source_id TEXT REFERENCES library_sources(id) ON DELETE SET NULL,
  label TEXT NOT NULL CHECK (length(label) <= 200),
  created_at TEXT NOT NULL,
  undone_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0)
);
INSERT INTO import_batches_v5 SELECT id, kind, source_id, label, created_at, undone_at, item_count FROM import_batches;
DROP TABLE import_batches;
ALTER TABLE import_batches_v5 RENAME TO import_batches;
CREATE INDEX idx_import_batches_created ON import_batches(created_at);

/* ---------- A. anime ---------- */
CREATE TABLE anime_details (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  format TEXT CHECK (format IS NULL OR format IN ('tv', 'tv_short', 'movie', 'ova', 'ona', 'special', 'music')),
  airing_status TEXT CHECK (airing_status IS NULL OR airing_status IN ('not_yet_released', 'releasing', 'finished', 'cancelled', 'hiatus')),
  season TEXT CHECK (season IS NULL OR season IN ('winter', 'spring', 'summer', 'fall')),
  season_year INTEGER CHECK (season_year IS NULL OR season_year BETWEEN 1900 AND 2200),
  source_material TEXT CHECK (source_material IS NULL OR length(source_material) <= 40),
  episode_count INTEGER CHECK (episode_count IS NULL OR episode_count >= 0),
  episode_duration INTEGER CHECK (episode_duration IS NULL OR episode_duration >= 0),
  next_episode INTEGER CHECK (next_episode IS NULL OR next_episode >= 0),
  next_airing_at TEXT,
  is_adult INTEGER NOT NULL DEFAULT 0 CHECK (is_adult IN (0, 1)),
  title_romaji TEXT CHECK (title_romaji IS NULL OR length(title_romaji) <= 500),
  title_english TEXT CHECK (title_english IS NULL OR length(title_english) <= 500),
  title_native TEXT CHECK (title_native IS NULL OR length(title_native) <= 500)
);

/* Per-item preferences that are neither metadata nor progress. */
CREATE TABLE item_prefs (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  spoiler_mode TEXT NOT NULL DEFAULT 'default' CHECK (spoiler_mode IN ('default', 'shield', 'show')),
  notes_spoiler INTEGER NOT NULL DEFAULT 0 CHECK (notes_spoiler IN (0, 1)),
  hours_source TEXT NOT NULL DEFAULT 'manual' CHECK (hours_source IN ('manual', 'sessions', 'steam')),
  audio_pref TEXT CHECK (audio_pref IS NULL OR audio_pref IN ('sub', 'dub', 'both'))
);

/* ---------- B. artwork slots ---------- */
ALTER TABLE artwork ADD COLUMN item_id TEXT REFERENCES items(id) ON DELETE CASCADE;
ALTER TABLE artwork ADD COLUMN slot TEXT CHECK (slot IS NULL OR slot IN ('cover', 'banner', 'logo', 'icon', 'background'));
ALTER TABLE artwork ADD COLUMN origin TEXT CHECK (origin IS NULL OR length(origin) <= 40);
ALTER TABLE artwork ADD COLUMN source_asset_id TEXT CHECK (source_asset_id IS NULL OR length(source_asset_id) <= 200);
ALTER TABLE artwork ADD COLUMN width INTEGER CHECK (width IS NULL OR width > 0);
ALTER TABLE artwork ADD COLUMN height INTEGER CHECK (height IS NULL OR height > 0);
ALTER TABLE artwork ADD COLUMN language TEXT CHECK (language IS NULL OR length(language) <= 20);
ALTER TABLE artwork ADD COLUMN license_note TEXT CHECK (license_note IS NULL OR length(license_note) <= 500);
ALTER TABLE artwork ADD COLUMN attribution_text TEXT CHECK (attribution_text IS NULL OR length(attribution_text) <= 500);
ALTER TABLE artwork ADD COLUMN cache_state TEXT NOT NULL DEFAULT 'cached' CHECK (cache_state IN ('cached', 'remote-only', 'unavailable'));
ALTER TABLE artwork ADD COLUMN sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64);
ALTER TABLE artwork ADD COLUMN selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1));
ALTER TABLE artwork ADD COLUMN user_selected INTEGER NOT NULL DEFAULT 0 CHECK (user_selected IN (0, 1));
ALTER TABLE artwork ADD COLUMN is_auto INTEGER NOT NULL DEFAULT 0 CHECK (is_auto IN (0, 1));
ALTER TABLE artwork ADD COLUMN adult INTEGER NOT NULL DEFAULT 0 CHECK (adult IN (0, 1));
ALTER TABLE artwork ADD COLUMN fetched_at TEXT;
UPDATE artwork SET
  item_id = (SELECT i.id FROM items i WHERE i.artwork_id = artwork.id LIMIT 1),
  slot = 'cover',
  selected = 1,
  user_selected = CASE WHEN source = 'user' THEN 1 ELSE 0 END,
  is_auto = CASE WHEN source = 'user' THEN 0 ELSE 1 END,
  origin = COALESCE(provider_id, 'local'),
  cache_state = CASE WHEN source = 'remote' THEN 'remote-only' ELSE 'cached' END,
  sha256 = CASE WHEN file_name IS NOT NULL AND length(file_name) > 64 THEN substr(file_name, 1, 64) ELSE NULL END,
  fetched_at = created_at
WHERE id IN (SELECT artwork_id FROM items WHERE artwork_id IS NOT NULL);
CREATE UNIQUE INDEX idx_artwork_selected ON artwork(item_id, slot) WHERE selected = 1;
CREATE INDEX idx_artwork_item ON artwork(item_id, slot);

/* ---------- 1. Pile Time ---------- */
CREATE TABLE time_estimates (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'provider')),
  minutes INTEGER NOT NULL CHECK (minutes BETWEEN 1 AND 600000),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) <= 40),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  user_set INTEGER NOT NULL DEFAULT 0 CHECK (user_set IN (0, 1)),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (item_id, source)
);

/* ---------- 2. moods ---------- */
CREATE TABLE moods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  name_key TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL CHECK (icon IN ('sofa','clock','cloud','bolt','heart','laugh','users','repeat','mountain','star','leaf','moon','sun','music','ghost','flame')),
  color TEXT CHECK (color IS NULL OR color IN ('slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink')),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  position INTEGER NOT NULL CHECK (position >= 0),
  builtin_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE item_moods (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  mood_id TEXT NOT NULL REFERENCES moods(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, mood_id)
);
CREATE INDEX idx_item_moods_mood ON item_moods(mood_id);
${MOODS.map(
  ([key, name, icon], i) =>
    `INSERT INTO moods (id, name, name_key, icon, color, hidden, position, builtin_key, created_at) VALUES (${UUID}, '${name}', '${name.toLowerCase()}', '${icon}', NULL, 0, ${i}, '${key}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`,
).join('\n')}

/* ---------- 3. runs ---------- */
CREATE TABLE item_runs (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  run_number INTEGER NOT NULL CHECK (run_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'completed', 'on_hold', 'dropped')),
  date_started TEXT CHECK (date_started IS NULL OR date_started ${DATE}),
  date_completed TEXT CHECK (date_completed IS NULL OR date_completed ${DATE}),
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 20000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (item_id, run_number)
);
CREATE INDEX idx_item_runs_completed ON item_runs(date_completed);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < (SELECT COALESCE(max(pass), 1) FROM items))
INSERT INTO item_runs (id, item_id, run_number, status, date_started, date_completed, rating, notes, created_at, updated_at)
SELECT ${UUID}, it.id, n.i,
  CASE WHEN n.i = it.pass THEN it.status ELSE 'completed' END,
  CASE WHEN n.i = it.pass THEN it.date_started ELSE NULL END,
  CASE
    WHEN n.i = it.pass AND (it.pass = 1 OR it.status = 'completed') THEN it.date_completed
    WHEN n.i = it.pass - 1 AND it.status <> 'completed' THEN it.date_completed
    ELSE NULL
  END,
  CASE WHEN n.i = it.pass THEN it.rating ELSE NULL END,
  '', it.created_at, it.updated_at
FROM items it JOIN n ON n.i <= it.pass;

/* Episode checkmarks of finished runs (the current run's live in episodes.watched). */
CREATE TABLE run_episode_states (
  run_id TEXT NOT NULL REFERENCES item_runs(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  watched_at TEXT,
  PRIMARY KEY (run_id, episode_id)
);
INSERT OR IGNORE INTO run_episode_states (run_id, episode_id, watched_at)
SELECT r.id, pe.episode_id, COALESCE(pe.occurred_at, pe.recorded_at)
FROM progress_events pe
JOIN items it ON it.id = pe.item_id
JOIN item_runs r ON r.item_id = pe.item_id AND r.run_number = pe.pass
WHERE pe.kind = 'episode' AND pe.episode_id IS NOT NULL AND pe.deleted_at IS NULL AND pe.pass < it.pass
  AND pe.watched = 1
  AND pe.seq = (SELECT max(p2.seq) FROM progress_events p2
                WHERE p2.item_id = pe.item_id AND p2.episode_id = pe.episode_id AND p2.pass = pe.pass
                  AND p2.kind = 'episode' AND p2.deleted_at IS NULL);

/* ---------- 4. franchise & series links ---------- */
CREATE TABLE item_relations (
  id TEXT PRIMARY KEY,
  from_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  to_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sequel', 'spin_off', 'side_story', 'adaptation_of', 'remake_of', 'same_franchise')),
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'provider')),
  created_at TEXT NOT NULL,
  UNIQUE (from_item_id, to_item_id, type),
  CHECK (from_item_id <> to_item_id)
);
CREATE INDEX idx_item_relations_to ON item_relations(to_item_id);

CREATE TABLE relation_suggestions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK (length(provider_id) <= 40),
  target_ref TEXT NOT NULL CHECK (length(target_ref) <= 100),
  target_type TEXT NOT NULL CHECK (target_type IN ('movie', 'tv', 'game', 'book', 'anime')),
  target_title TEXT NOT NULL CHECK (length(target_title) BETWEEN 1 AND 500),
  target_year INTEGER,
  relation TEXT NOT NULL CHECK (relation IN ('prequel', 'sequel', 'spin_off', 'side_story', 'adaptation_of', 'adapted_as', 'remake_of', 'same_franchise')),
  target_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'dismissed')),
  created_at TEXT NOT NULL,
  UNIQUE (item_id, provider_id, target_ref, relation)
);
CREATE INDEX idx_relation_suggestions_state ON relation_suggestions(state, item_id);

CREATE TABLE franchises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_key TEXT NOT NULL UNIQUE,
  respect_order INTEGER NOT NULL DEFAULT 1 CHECK (respect_order IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE franchise_items (
  franchise_id TEXT NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL CHECK (position >= 0),
  mainline INTEGER NOT NULL DEFAULT 1 CHECK (mainline IN (0, 1)),
  PRIMARY KEY (franchise_id, item_id)
);
CREATE INDEX idx_franchise_items_item ON franchise_items(item_id);

/* ---------- 6. Pile Value ---------- */
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 100000000000),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  purchased_on TEXT CHECK (purchased_on IS NULL OR purchased_on ${DATE}),
  store TEXT CHECK (store IS NULL OR length(store) <= 120),
  edition TEXT CHECK (edition IS NULL OR length(edition) <= 200),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_purchases_item ON purchases(item_id);

/* ---------- 7. sessions ---------- */
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES item_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('play', 'watch', 'read')),
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'done')),
  source TEXT NOT NULL CHECK (source IN ('timer', 'manual')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  /* Running/paused timers: seconds banked from finished segments + start of the live segment. */
  accumulated_seconds INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_seconds >= 0),
  segment_started_at TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 2592000),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'done') = (ended_at IS NOT NULL AND duration_seconds IS NOT NULL)),
  CHECK ((state = 'running') = (segment_started_at IS NOT NULL))
);
CREATE INDEX idx_sessions_item ON sessions(item_id, started_at);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_open ON sessions(state) WHERE state <> 'done';

/* ---------- 8. ownership & subscriptions ---------- */
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'store', 'library', 'other')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TABLE availability_entries (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('owned_digital', 'owned_physical', 'subscription', 'library_loan', 'borrowed', 'wishlist')),
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  platform TEXT CHECK (platform IS NULL OR length(platform) <= 80),
  available_until TEXT CHECK (available_until IS NULL OR available_until ${DATE}),
  remind_days INTEGER CHECK (remind_days IS NULL OR remind_days BETWEEN 0 AND 365),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_availability_item ON availability_entries(item_id);
CREATE INDEX idx_availability_until ON availability_entries(available_until) WHERE available_until IS NOT NULL;
CREATE TABLE availability_notifications (
  entry_id TEXT NOT NULL REFERENCES availability_entries(id) ON DELETE CASCADE,
  until TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, until)
);

/* ---------- 9. recommendations ---------- */
CREATE TABLE rec_feedback (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('dismissed', 'not_interested')),
  until TEXT CHECK (until IS NULL OR until ${DATE}),
  created_at TEXT NOT NULL
);

/* ---------- 12. duplicate merge ---------- */
CREATE TABLE merged_ids (
  old_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  old_title TEXT NOT NULL CHECK (length(old_title) <= 500),
  merged_at TEXT NOT NULL
);
CREATE INDEX idx_merged_ids_item ON merged_ids(item_id);
CREATE TABLE duplicate_dismissals (
  a_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
/* Full pre-merge snapshot of both items (every row referencing them, two levels deep) for exact undo. */
CREATE TABLE merge_snapshots (
  id TEXT PRIMARY KEY,
  kept_item_id TEXT NOT NULL,
  removed_item_id TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  kept_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX idx_merge_snapshots_created ON merge_snapshots(created_at);

/* ---------- A. provider-documented where-to-watch links (never guessed) ---------- */
CREATE TABLE streaming_links (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK (length(provider_id) <= 40),
  service TEXT NOT NULL CHECK (length(service) BETWEEN 1 AND 60),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 9 AND 2000 AND url LIKE 'https://%'),
  subs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subs)),
  dubs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dubs)),
  fetched_at TEXT NOT NULL,
  UNIQUE (item_id, provider_id, url)
);
CREATE INDEX idx_streaming_links_item ON streaming_links(item_id);
`,
} as const;

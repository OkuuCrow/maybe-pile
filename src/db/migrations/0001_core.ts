/**
 * v1 — core library schema.
 *
 * Migration rules (see docs/migrations.md): never edit a released migration;
 * add a new one. Each migration runs in its own transaction and is recorded
 * with a checksum of its SQL.
 *
 * `items` uses an INTEGER PRIMARY KEY (`rid`) plus a TEXT UUID (`id`). The rid
 * is stable across VACUUM/VACUUM INTO and is the FTS rowid; every foreign key
 * references the UUID.
 */
export const migration0001 = {
  version: 1,
  name: 'core',
  sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);

CREATE TABLE artwork (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('cache', 'user', 'remote')),
  file_name TEXT CHECK (file_name IS NULL OR (length(file_name) <= 80 AND file_name NOT GLOB '*[^0-9a-z.]*')),
  thumb_name TEXT CHECK (thumb_name IS NULL OR (length(thumb_name) <= 80 AND thumb_name NOT GLOB '*[^0-9a-z.]*')),
  remote_url TEXT CHECK (remote_url IS NULL OR (remote_url LIKE 'https://%' AND length(remote_url) <= 2048)),
  provider_id TEXT,
  mime TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  created_at TEXT NOT NULL,
  CHECK ((source = 'remote' AND remote_url IS NOT NULL) OR (source <> 'remote' AND file_name IS NOT NULL))
);

CREATE TABLE items (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('movie', 'tv', 'game', 'book')),
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
  date_added TEXT NOT NULL CHECK (date_added GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  date_started TEXT CHECK (date_started IS NULL OR date_started GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  date_completed TEXT CHECK (date_completed IS NULL OR date_completed GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  pass INTEGER NOT NULL DEFAULT 1 CHECK (pass >= 1),
  artwork_id TEXT REFERENCES artwork(id) ON DELETE SET NULL,
  progress_pct REAL CHECK (progress_pct IS NULL OR progress_pct BETWEEN 0 AND 100),
  progress_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
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

CREATE TABLE item_alt_titles (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  PRIMARY KEY (item_id, position)
);

CREATE TABLE creators (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE
);
CREATE TABLE item_creators (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('director','writer','cast','creator','developer','publisher','author','translator','narrator','illustrator')),
  position INTEGER NOT NULL,
  PRIMARY KEY (item_id, creator_id, role)
);
CREATE INDEX idx_item_creators_creator ON item_creators(creator_id);

CREATE TABLE genres (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE
);
CREATE TABLE item_genres (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  PRIMARY KEY (item_id, genre_id)
);
CREATE INDEX idx_item_genres_genre ON item_genres(genre_id);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  name_key TEXT NOT NULL UNIQUE
);
CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX idx_item_tags_tag ON item_tags(tag_id);

CREATE TABLE external_ids (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tmdb','imdb','tvmaze','openlibrary','isbn10','isbn13','igdb','steam','xbox','playstation')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 300),
  PRIMARY KEY (item_id, kind)
);
CREATE INDEX idx_external_ids_lookup ON external_ids(kind, value);

CREATE TABLE item_sources (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  url TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (item_id, provider_id)
);
CREATE INDEX idx_item_sources_ref ON item_sources(provider_id, provider_ref);

CREATE TABLE field_provenance (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('provider', 'user', 'manual-entry')),
  provider_id TEXT,
  provider_value TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, field)
);

CREATE TABLE custom_field_defs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'boolean', 'select')),
  created_at TEXT NOT NULL
);
CREATE TABLE custom_field_options (
  def_id TEXT NOT NULL REFERENCES custom_field_defs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (def_id, position)
);
CREATE TABLE custom_field_values (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  def_id TEXT NOT NULL REFERENCES custom_field_defs(id) ON DELETE CASCADE,
  text_value TEXT,
  number_value REAL,
  PRIMARY KEY (item_id, def_id),
  CHECK ((text_value IS NULL) <> (number_value IS NULL))
);

CREATE TABLE movie_details (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  runtime_minutes INTEGER CHECK (runtime_minutes IS NULL OR runtime_minutes >= 0),
  original_language TEXT,
  age_rating TEXT
);

CREATE TABLE tv_details (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  network TEXT,
  show_status TEXT CHECK (show_status IS NULL OR show_status IN ('returning', 'ended', 'unknown')),
  episode_runtime INTEGER CHECK (episode_runtime IS NULL OR episode_runtime >= 0),
  last_air_date TEXT
);
CREATE TABLE seasons (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number >= 0),
  title TEXT,
  episode_count_known INTEGER CHECK (episode_count_known IS NULL OR episode_count_known >= 0),
  UNIQUE (item_id, season_number)
);
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  episode_number INTEGER NOT NULL CHECK (episode_number >= 0),
  title TEXT,
  air_date TEXT,
  runtime INTEGER CHECK (runtime IS NULL OR runtime >= 0),
  watched INTEGER NOT NULL DEFAULT 0 CHECK (watched IN (0, 1)),
  watched_at TEXT,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('provider', 'user')),
  UNIQUE (season_id, episode_number)
);
CREATE INDEX idx_episodes_item ON episodes(item_id, watched);

CREATE TABLE game_details (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  progress_scheme TEXT NOT NULL DEFAULT 'percent' CHECK (progress_scheme IN ('percent', 'hours', 'milestones', 'text'))
);
CREATE TABLE game_platforms (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  owned INTEGER NOT NULL CHECK (owned IN (0, 1)),
  played INTEGER NOT NULL CHECK (played IN (0, 1)),
  PRIMARY KEY (item_id, position)
);
CREATE TABLE game_milestones (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200)
);
CREATE INDEX idx_game_milestones_item ON game_milestones(item_id, position);

CREATE TABLE book_details (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  isbn10 TEXT,
  isbn13 TEXT,
  publisher TEXT,
  page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
  format TEXT NOT NULL DEFAULT 'print' CHECK (format IN ('print', 'ebook', 'audiobook')),
  audio_minutes INTEGER CHECK (audio_minutes IS NULL OR audio_minutes >= 0)
);
CREATE TABLE book_series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT,
  total_known INTEGER CHECK (total_known IS NULL OR total_known > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE series_members (
  series_id TEXT NOT NULL REFERENCES book_series(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL CHECK (position IS NULL OR position >= 0),
  PRIMARY KEY (series_id, item_id)
);
CREATE INDEX idx_series_members_item ON series_members(item_id);

CREATE TABLE progress_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('percent','hours','milestone','text','pages','audio','episode','season')),
  value REAL,
  text_value TEXT,
  total_at_time INTEGER,
  milestone_id TEXT REFERENCES game_milestones(id) ON DELETE SET NULL,
  milestone_title TEXT,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  episode_label TEXT,
  watched INTEGER CHECK (watched IS NULL OR watched IN (0, 1)),
  scheme TEXT CHECK (scheme IS NULL OR scheme IN ('percent', 'hours', 'milestones', 'text')),
  pass INTEGER NOT NULL DEFAULT 1 CHECK (pass >= 1),
  occurred_at TEXT,
  recorded_at TEXT NOT NULL,
  note TEXT,
  deleted_at TEXT,
  CHECK (kind NOT IN ('percent') OR (value BETWEEN 0 AND 100))
);
CREATE INDEX idx_progress_item ON progress_events(item_id, deleted_at);
CREATE INDEX idx_progress_recorded ON progress_events(recorded_at);

CREATE TABLE viewing_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  watched_at TEXT,
  note TEXT,
  pass INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_viewing_item ON viewing_events(item_id);

CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  schema_version INTEGER NOT NULL,
  tokens TEXT NOT NULL CHECK (json_valid(tokens)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE layout_components (
  surface TEXT NOT NULL CHECK (surface IN ('dashboard', 'library')),
  component_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  span INTEGER NOT NULL DEFAULT 1 CHECK (span IN (1, 2)),
  PRIMARY KEY (surface, component_id)
);
`,
} as const;

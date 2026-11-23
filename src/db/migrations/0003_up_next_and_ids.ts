/**
 * v3 — "Up Next" queue and new external-ID kinds (Wikidata, AniList, MyAnimeList).
 *
 * SQLite can't alter a CHECK constraint, so `external_ids` is rebuilt:
 * create the new table, copy every row, drop the old one, rename. Nothing
 * references `external_ids`, so the rebuild is safe with foreign keys on, and
 * the whole migration runs in one transaction.
 */
export const migration0003 = {
  version: 3,
  name: 'up_next_and_ids',
  sql: `
ALTER TABLE items ADD COLUMN up_next_position INTEGER
  CHECK (up_next_position IS NULL OR up_next_position >= 0);
CREATE INDEX idx_items_up_next ON items(up_next_position) WHERE up_next_position IS NOT NULL;

CREATE TABLE external_ids_v3 (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tmdb','imdb','tvmaze','openlibrary','isbn10','isbn13','igdb','steam','xbox','playstation','wikidata','anilist','mal')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 300),
  PRIMARY KEY (item_id, kind)
);
INSERT INTO external_ids_v3 (item_id, kind, value) SELECT item_id, kind, value FROM external_ids;
DROP TABLE external_ids;
ALTER TABLE external_ids_v3 RENAME TO external_ids;
CREATE INDEX idx_external_ids_lookup ON external_ids(kind, value);
`,
} as const;

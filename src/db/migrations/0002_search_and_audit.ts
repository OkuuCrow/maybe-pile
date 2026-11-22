/**
 * v2 — local full-text search and the metadata audit log.
 *
 * FTS design: `items_fts` is a standalone FTS5 table whose rowid equals
 * `items.rid`. It is kept in sync by service code (`reindexItem`) inside the
 * same transaction as every item write, which is simpler and easier to test
 * than triggers spanning six tables. This migration back-fills it for
 * libraries created under v1.
 */
export const migration0002 = {
  version: 2,
  name: 'search_and_audit',
  sql: `
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, alt_titles, creators, tags, notes,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO items_fts(rowid, title, alt_titles, creators, tags, notes)
SELECT i.rid,
       i.title,
       COALESCE((SELECT group_concat(a.title, ' ') FROM item_alt_titles a WHERE a.item_id = i.id), ''),
       COALESCE((SELECT group_concat(c.name, ' ') FROM item_creators ic JOIN creators c ON c.id = ic.creator_id WHERE ic.item_id = i.id), ''),
       COALESCE((SELECT group_concat(t.name, ' ') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), ''),
       i.notes
FROM items i;

CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('refresh', 'import', 'create')),
  provider_id TEXT
);
CREATE INDEX idx_audit_item ON audit_entries(item_id, at);

CREATE TABLE audit_changes (
  audit_id TEXT NOT NULL REFERENCES audit_entries(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  PRIMARY KEY (audit_id, field)
);
`,
} as const;

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../../src/db/connection';
import {
  checksum,
  currentSchemaVersion,
  LATEST_SCHEMA_VERSION,
  migrate,
  MIGRATIONS,
} from '../../src/db/migrate';
import { AppError } from '../../src/shared/result';
import { tempDir } from '../helpers/db';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function newDb(): Db {
  const t = tempDir();
  const db = new Db(join(t.dir, 'library.sqlite'));
  cleanups.push(() => {
    db.close();
    t.cleanup();
  });
  return db;
}

const tables = (db: Db) =>
  db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((r) => r.name);

describe('migrations', () => {
  it('creates a fresh database at the latest version', () => {
    const db = newDb();
    const r = migrate(db);
    expect(r).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION, applied: [1, 2] });
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    for (const t of [
      'items',
      'field_provenance',
      'progress_events',
      'episodes',
      'layout_components',
      'audit_entries',
      'items_fts',
    ]) {
      expect(tables(db)).toContain(t);
    }
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(db.integrityCheck()).toEqual([]);
  });

  it('is idempotent', () => {
    const db = newDb();
    migrate(db);
    expect(migrate(db)).toEqual({ from: 2, to: 2, applied: [] });
  });

  it('applies each migration in order and records checksums', () => {
    const db = newDb();
    migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    expect(currentSchemaVersion(db)).toBe(1);
    expect(tables(db)).not.toContain('items_fts');
    migrate(db);
    const rows = db.all<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1]?.checksum).toBe(checksum(MIGRATIONS[1]?.sql ?? ''));
  });

  it('upgrades v1 → latest preserving data, back-filling FTS and keeping FK integrity', () => {
    const db = newDb();
    migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    const now = '2024-01-02T03:04:05.000Z';
    const id = '11111111-1111-4111-8111-111111111111';
    db.run(
      `INSERT INTO items (id, type, title, sort_title, title_key, status, notes, date_added, created_at, updated_at)
       VALUES (?, 'book', 'Pokémon Adventures', 'pokemon adventures', 'pokemon adventures', 'planned', 'borrowed from Sam', '2024-01-02', ?, ?)`,
      [id, now, now],
    );
    db.run('INSERT INTO book_details (item_id, page_count) VALUES (?, 192)', [id]);
    db.run("INSERT INTO tags (name, name_key) VALUES ('Manga', 'manga')");
    db.run('INSERT INTO item_tags (item_id, tag_id) VALUES (?, 1)', [id]);
    db.run("INSERT INTO creators (name, name_key) VALUES ('Hidenori Kusaka', 'hidenori kusaka')");
    db.run("INSERT INTO item_creators (item_id, creator_id, role, position) VALUES (?, 1, 'author', 0)", [
      id,
    ]);

    const backups: [number, number][] = [];
    migrate(db, { beforeMigrate: (f, t) => backups.push([f, t]) });
    expect(backups).toEqual([[1, 2]]);
    expect(db.get('SELECT title, notes FROM items')).toEqual({
      title: 'Pokémon Adventures',
      notes: 'borrowed from Sam',
    });
    expect(db.get<{ page_count: number }>('SELECT page_count FROM book_details')?.page_count).toBe(192);
    for (const q of ['pokemon', 'kusaka', 'manga', 'sam']) {
      expect(db.all('SELECT rowid FROM items_fts WHERE items_fts MATCH ?', [q])).toHaveLength(1);
    }
    expect(db.foreignKeyViolations()).toBe(0);
    expect(db.integrityCheck()).toEqual([]);
  });

  it('rolls back a failed migration and leaves the previous version intact', () => {
    const db = newDb();
    migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    expect(() => migrate(db, { failAtVersion: 2 })).toThrow(/Injected/);
    expect(currentSchemaVersion(db)).toBe(1);
    expect(tables(db)).not.toContain('items_fts');
    expect(tables(db)).not.toContain('audit_entries');
    expect(migrate(db).applied).toEqual([2]);
  });

  it('refuses a database whose schema is newer than the app', () => {
    const db = newDb();
    migrate(db);
    db.run(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 'now')",
    );
    try {
      migrate(db);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).safe.code).toBe('UNSUPPORTED_VERSION');
    }
  });

  it('refuses an edited (checksum-mismatched) migration', () => {
    const db = newDb();
    migrate(db);
    db.run("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
    expect(() => migrate(db)).toThrow(AppError);
  });

  it('enforces CHECK and FOREIGN KEY constraints', () => {
    const db = newDb();
    migrate(db);
    const now = new Date().toISOString();
    const ins = (status: string, rating: number | null) =>
      db.run(
        `INSERT INTO items (id, type, title, sort_title, title_key, status, rating, date_added, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), 'movie', 't', 't', 't', ?, ?, '2024-01-01', ?, ?)`,
        [status, rating, now, now],
      );
    expect(() => ins('finished', null)).toThrow(/CHECK/);
    expect(() => ins('planned', 11)).toThrow(/CHECK/);
    expect(() => ins('planned', 0)).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO item_tags (item_id, tag_id) VALUES ('nope', 1)")).toThrow(/FOREIGN KEY/);
  });
});

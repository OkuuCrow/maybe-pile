/**
 * Versioned migration runner.
 *
 * - Ordered: migrations are sorted by version and must be contiguous from 1.
 * - Idempotent: applied versions are recorded in `schema_migrations`; re-running is a no-op.
 * - Transactional: each migration (DDL + bookkeeping row) commits atomically.
 *   SQLite DDL is transactional, so a failure rolls the database back to the
 *   previous version exactly.
 * - Safe: `beforeMigrate` lets the caller take a file snapshot first, and a
 *   database newer than the app is refused (never "downgraded").
 * - Tamper-evident: a stored checksum mismatch means a released migration was
 *   edited, which is refused.
 */
import { createHash } from 'node:crypto';
import { appError } from '../shared/result';
import type { Db } from './connection';
import { migration0001 } from './migrations/0001_core';
import { migration0002 } from './migrations/0002_search_and_audit';
import { migration0003 } from './migrations/0003_up_next_and_ids';
import { migration0004 } from './migrations/0004_feature_pack';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004];
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function currentSchemaVersion(db: Db): number {
  const exists = db.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (!exists || exists.n === 0) return 0;
  return db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations')?.v ?? 0;
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  /** Called once before the first pending migration with (fromVersion, toVersion). */
  beforeMigrate?: (from: number, to: number) => void;
  /** Test hook: throw inside the transaction of this version to prove rollback. */
  failAtVersion?: number;
  now?: () => string;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
}

export function migrate(db: Db, opts: MigrateOptions = {}): MigrateResult {
  const migrations = [...(opts.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`Migrations must be contiguous; expected v${i + 1}, found v${m.version}.`);
  });
  const latest = migrations.length;
  const now = opts.now ?? (() => new Date().toISOString());

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = db.all<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  const from = applied.length === 0 ? 0 : (applied[applied.length - 1]?.version ?? 0);

  if (from > latest) {
    throw appError(
      'UNSUPPORTED_VERSION',
      `This library was created by a newer version of Maybe Pile (schema v${from}; this app supports up to v${latest}).`,
      { recovery: 'Install the latest version of Maybe Pile, or open the library read-only.' },
    );
  }
  for (const row of applied) {
    const m = migrations[row.version - 1];
    if (m && checksum(m.sql) !== row.checksum) {
      throw appError(
        'CORRUPT',
        `Migration v${row.version} does not match the version that was applied to this library.`,
        {
          recovery: 'Restore the pre-migration backup from the backups folder. See docs/migrations.md.',
        },
      );
    }
  }

  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, applied: [] };

  opts.beforeMigrate?.(from, latest);

  const done: number[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      if (opts.failAtVersion === m.version) throw new Error(`Injected migration failure at v${m.version}`);
      db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [
        m.version,
        m.name,
        checksum(m.sql),
        now(),
      ]);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    done.push(m.version);
  }
  return { from, to: latest, applied: done };
}

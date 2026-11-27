/**
 * SQLite access via Node's built-in `node:sqlite` (bundled with Electron's Node).
 *
 * Why node:sqlite: it ships inside Electron, so there is no native module to
 * rebuild per platform/arch and nothing to unpack from ASAR. The same JS bundle
 * runs on Windows, macOS and Linux. See docs/architecture.md for trade-offs.
 *
 * Connection settings: WAL journal, synchronous=NORMAL (durable across app
 * crashes; an OS crash/power loss can lose at most the last committed
 * transaction(s) since the previous checkpoint), foreign keys ON, busy timeout.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export class Db {
  readonly raw: DatabaseSync;
  readonly file: string;
  readonly readOnly: boolean;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(file: string, opts: { readOnly?: boolean } = {}) {
    this.file = file;
    this.readOnly = opts.readOnly ?? false;
    this.raw = new DatabaseSync(file, {
      readOnly: this.readOnly,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    try {
      if (!this.readOnly && file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
      this.raw.exec('PRAGMA foreign_keys = ON');
      this.raw.exec('PRAGMA busy_timeout = 5000');
    } catch (e) {
      // Not a database / unreadable: release the file handle (Windows keeps it locked otherwise).
      this.raw.close();
      throw e;
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, params: Params = []): T[] {
    const s = this.stmt(sql);
    return (Array.isArray(params) ? s.all(...params) : s.all(params)) as T[];
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const s = this.stmt(sql);
    return (Array.isArray(params) ? s.get(...params) : s.get(params)) as T | undefined;
  }

  run(sql: string, params: Params = []): { changes: number } {
    const s = this.stmt(sql);
    const r = Array.isArray(params) ? s.run(...params) : s.run(params);
    return { changes: Number(r.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Runs `fn` atomically. Nested calls use SAVEPOINTs so a service can compose
   * repository calls that each open their own transaction.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      this.raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (e) {
      if (depth === 0) {
        this.raw.exec('ROLLBACK');
      } else {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
      }
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  /** Consistent snapshot of the live database (safe with WAL), written to `dest`. */
  snapshotTo(dest: string): void {
    this.raw.prepare('VACUUM INTO ?').run(dest);
  }

  checkpoint(): void {
    if (!this.readOnly) this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  integrityCheck(quick = false): string[] {
    const rows = this.all<Record<string, string>>(quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check');
    const msgs = rows.map((r) => Object.values(r)[0] ?? '');
    return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
  }

  foreignKeyViolations(): number {
    return this.all('PRAGMA foreign_key_check').length;
  }

  sqliteVersion(): string {
    return this.get<{ v: string }>('SELECT sqlite_version() AS v')?.v ?? 'unknown';
  }

  close(): void {
    this.cache.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

/** Converts JS booleans for SQLite (node:sqlite does not bind booleans). */
export const b2i = (v: boolean): number => (v ? 1 : 0);
export const i2b = (v: number | null | undefined): boolean => v === 1;

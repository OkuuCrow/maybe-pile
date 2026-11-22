/**
 * Owns the live database handle: opening (with pre-migration snapshot and
 * startup checks), closing, and atomically swapping in a restored database.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appError, AppError } from '../../shared/result';
import { Db } from '../../db/connection';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION, migrate, type MigrateOptions } from '../../db/migrate';
import type { AppPaths } from './context';
import type { Logger } from './logger';

export interface OpenReport {
  migratedFrom: number | null;
  migratedTo: number | null;
  preMigrationBackup: string | null;
  quickCheckProblems: string[];
  readOnly: boolean;
}

const KEEP_PRE_MIGRATION = 3;

export function timestampForFile(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Deletes all but the newest `keep` files matching prefix/suffix in dir. */
export function pruneFiles(dir: string, prefix: string, suffix: string, keep: number): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
}

export class DatabaseManager {
  private handle: Db | null = null;
  lastOpen: OpenReport | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get db(): Db {
    if (!this.handle)
      throw appError('DATABASE', 'The library is not open.', { recovery: 'Restart Maybe Pile.' });
    return this.handle;
  }

  get isOpen(): boolean {
    return this.handle !== null;
  }

  /**
   * Opens the library, taking a file snapshot before any migration. A newer
   * schema is refused unless `readOnlyIfNewer` is set, in which case the
   * library is opened read-only without migrating.
   */
  open(opts: { readOnlyIfNewer?: boolean; migrate?: MigrateOptions } = {}): OpenReport {
    mkdirSync(this.paths.userData, { recursive: true });
    mkdirSync(this.paths.backups, { recursive: true });
    let db = new Db(this.paths.database);
    const report: OpenReport = {
      migratedFrom: null,
      migratedTo: null,
      preMigrationBackup: null,
      quickCheckProblems: [],
      readOnly: false,
    };
    try {
      const existing = currentSchemaVersion(db);
      if (existing > LATEST_SCHEMA_VERSION) {
        if (!opts.readOnlyIfNewer) {
          throw appError(
            'UNSUPPORTED_VERSION',
            `This library was created by a newer version of Maybe Pile (schema v${existing}).`,
            {
              recovery: 'Install the latest Maybe Pile, or open the library read-only.',
            },
          );
        }
        db.close();
        db = new Db(this.paths.database, { readOnly: true });
        report.readOnly = true;
      } else {
        const r = migrate(db, {
          ...opts.migrate,
          beforeMigrate: (from, to) => {
            if (from === 0) return; // brand-new library: nothing to protect
            const name = `pre-migration-v${from}-to-v${to}-${timestampForFile(this.now())}.sqlite`;
            const dest = join(this.paths.backups, name);
            db.snapshotTo(dest);
            pruneFiles(this.paths.backups, 'pre-migration-', '.sqlite', KEEP_PRE_MIGRATION);
            report.preMigrationBackup = name;
            this.log.info('db.preMigrationBackup', { from, to });
          },
        });
        if (r.applied.length > 0 && r.from > 0) {
          report.migratedFrom = r.from;
          report.migratedTo = r.to;
          this.log.info('db.migrated', { from: r.from, to: r.to });
        }
      }
      report.quickCheckProblems = db.integrityCheck(true);
      if (report.quickCheckProblems.length > 0)
        this.log.error('db.quickCheckFailed', { problems: report.quickCheckProblems.length });
    } catch (e) {
      db.close();
      if (!(e instanceof AppError)) this.log.error('db.openFailed', { error: e });
      throw e;
    }
    this.handle = db;
    this.lastOpen = report;
    return report;
  }

  close(): void {
    if (!this.handle) return;
    try {
      this.handle.checkpoint();
    } catch (e) {
      this.log.warn('db.checkpointFailed', { error: e });
    }
    this.handle.close();
    this.handle = null;
  }

  /**
   * Atomically replaces the live database and artwork folder with staged
   * copies. On any failure the original files are put back and reopened.
   * `failAtStep` is a test hook for failure injection.
   */
  swapIn(stagedDb: string, stagedArtwork: string, opts: { failAtStep?: number } = {}): void {
    const p = this.paths;
    const suffix = `.restore-old-${timestampForFile(this.now())}`;
    const moved: [string, string][] = [];
    const placed: string[] = [];
    const step = (n: number) => {
      if (opts.failAtStep === n) throw new Error(`Injected restore failure at step ${n}`);
    };
    this.close();
    try {
      for (const f of [p.database, `${p.database}-wal`, `${p.database}-shm`, p.artwork]) {
        if (existsSync(f)) {
          renameSync(f, f + suffix);
          moved.push([f, f + suffix]);
        }
      }
      step(1);
      renameSync(stagedDb, p.database);
      placed.push(p.database);
      step(2);
      renameSync(stagedArtwork, p.artwork);
      placed.push(p.artwork);
      step(3);
      this.open();
      const fk = this.db.foreignKeyViolations();
      if (fk > 0) throw new Error('Restored library has foreign-key violations.');
      step(4);
    } catch (e) {
      this.log.error('restore.swapFailed', { error: e });
      if (this.handle) this.close();
      for (const f of placed.reverse()) rmSync(f, { recursive: true, force: true });
      for (const f of [`${p.database}-wal`, `${p.database}-shm`]) rmSync(f, { force: true });
      for (const [orig, tmp] of moved.reverse()) renameSync(tmp, orig);
      this.open();
      throw appError('IO', 'The restore could not be completed. Your library was left exactly as it was.', {
        recovery: 'Make sure no other program is using the Maybe Pile data folder, then try again.',
      });
    }
    for (const [, tmp] of moved) rmSync(tmp, { recursive: true, force: true });
    this.log.info('restore.swapped');
  }
}

/**
 * Full backups (.mpbackup) and restore.
 *
 * Container: a ZIP with POSIX relative paths only:
 *   manifest.json          format, versions, counts, SHA-256 per file
 *   library.sqlite         consistent snapshot via `VACUUM INTO` (never a raw copy of a live WAL db)
 *   artwork/<sha256>.*     cached and user-added images
 * Secrets are never included (they live outside the database).
 *
 * Restore validates everything in a staging folder before the live library is
 * touched: size limits / zip-bomb ratios, entry names (no traversal, no
 * unexpected files), manifest schema, checksums, format/schema versions
 * (older → migrated on the staged copy; newer → refused), SQLite
 * integrity_check and foreign_key_check. A pre-restore backup of the current
 * library is written first, then the swap is done by renames with rollback.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { appError, AppError } from '../../shared/result';
import type {
  CountsView,
  FileOpResult,
  ImportPreviewView,
  ImportResultView,
  ValidationMessage,
} from '../../shared/types';
import { Db } from '../../db/connection';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION, migrate } from '../../db/migrate';
import type { ArtworkService } from './artwork-service';
import { ARTWORK_FILE_RE } from './artwork-service';
import type { ServiceContext } from './context';
import type { DatabaseManager } from './db-manager';
import { pruneFiles, timestampForFile } from './db-manager';
import { emptyCounts, libraryCounts } from './export-service';
import { atomicWrite, ensureFreeSpace, mapFsError } from './fs-safe';

export const BACKUP_FORMAT = 'maybepile-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024; // compressed archive
export const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
export const MAX_ENTRIES = 200_000;
export const MAX_RATIO = 200;
export const CONFIRMATION_WORD = 'RESTORE';
const KEEP_PRE_RESTORE = 5;

const ENTRY_RE = /^(?:manifest\.json|library\.sqlite|artwork\/[a-f0-9]{64}(?:\.thumb)?\.(?:jpg|png))$/;

const ManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int(),
  appVersion: z.string().max(40),
  schemaVersion: z.number().int().min(1),
  createdAt: z.string().max(40),
  counts: z.record(z.string(), z.number()),
  artworkCount: z.number().int().min(0),
  secretsIncluded: z.literal(false),
  files: z
    .array(
      z.object({
        path: z.string().max(200),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().min(0),
      }),
    )
    .max(MAX_ENTRIES),
});
type Manifest = z.infer<typeof ManifestSchema>;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface StagedRestore {
  dir: string;
  dbPath: string;
  artworkDir: string;
  fileLabel: string;
  at: number;
}

export class BackupService {
  private readonly staged = new Map<string, StagedRestore>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly dbm: DatabaseManager,
    private readonly artwork: ArtworkService,
  ) {}

  /* ---------------------------------------------------------------- create */

  /** Builds the archive bytes for the current library. */
  buildArchive(): { bytes: Uint8Array; manifest: Manifest } {
    const db = this.ctx.db();
    const tmp = mkdtempSync(join(this.ctx.paths.backups, '.snap-'));
    try {
      const snap = join(tmp, 'library.sqlite');
      db.snapshotTo(snap);
      // Soft-deleted items are not part of backups.
      const s = new Db(snap);
      try {
        const deleted = s.all<{ rid: number }>('SELECT rid FROM items WHERE deleted_at IS NOT NULL');
        if (deleted.length > 0) {
          s.transaction(() => {
            for (const d of deleted) s.run('DELETE FROM items_fts WHERE rowid = ?', [d.rid]);
            s.run('DELETE FROM items WHERE deleted_at IS NOT NULL');
          });
        }
        s.exec('PRAGMA journal_mode = DELETE');
      } finally {
        s.close();
      }
      const dbBytes = readFileSync(snap);
      const files: Zippable = { 'library.sqlite': [dbBytes, { level: 6 }] };
      const list: Manifest['files'] = [
        { path: 'library.sqlite', sha256: sha256(dbBytes), bytes: dbBytes.byteLength },
      ];
      const art = this.artwork.referencedFiles();
      for (const f of art) {
        const p = this.artwork.resolveFile(f);
        if (!p) continue;
        const b = readFileSync(p);
        files[`artwork/${f}`] = [b, { level: 0 }];
        list.push({ path: `artwork/${f}`, sha256: sha256(b), bytes: b.byteLength });
      }
      const counts = libraryCounts(db);
      const manifest: Manifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        appVersion: this.ctx.appVersion,
        schemaVersion: LATEST_SCHEMA_VERSION,
        createdAt: this.ctx.clock.now().toISOString(),
        counts: {
          ...counts.items,
          episodes: counts.episodes,
          progressEntries: counts.progressEntries,
          viewings: counts.viewings,
          tags: counts.tags,
          themes: counts.themes,
        },
        artworkCount: art.length,
        secretsIncluded: false,
        files: list,
      };
      files['manifest.json'] = [new TextEncoder().encode(JSON.stringify(manifest, null, 2)), { level: 6 }];
      return { bytes: zipSync(files), manifest };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  createBackup(dest: string, opts: { overwrite: boolean }): FileOpResult {
    const { bytes } = this.buildArchive();
    atomicWrite(dest, bytes, opts);
    this.ctx.log.info('backup.created', { bytes: bytes.byteLength });
    return { fileLabel: basename(dest), bytes: bytes.byteLength };
  }

  /** Writes a snapshot of the current library into the app's backups folder. */
  createInternalSnapshot(prefix: string): string {
    const stamp = timestampForFile(this.ctx.clock.now());
    let name = `${prefix}-${stamp}.mpbackup`;
    for (let n = 2; existsSync(join(this.ctx.paths.backups, name)); n++)
      name = `${prefix}-${stamp}-${n}.mpbackup`;
    this.createBackup(join(this.ctx.paths.backups, name), { overwrite: false });
    pruneFiles(this.ctx.paths.backups, `${prefix}-`, '.mpbackup', KEEP_PRE_RESTORE);
    return name;
  }

  /* ---------------------------------------------------------------- restore preview */

  private discardStaged(token: string): void {
    const s = this.staged.get(token);
    if (s) rmSync(s.dir, { recursive: true, force: true });
    this.staged.delete(token);
  }

  previewRestore(file: string): ImportPreviewView {
    const fileLabel = basename(file);
    const messages: ValidationMessage[] = [];
    const current = libraryCounts(this.ctx.db());
    const fail = (
      message: string,
      path = 'archive',
      code: 'CORRUPT' | 'UNSUPPORTED_VERSION' | 'TOO_LARGE' = 'CORRUPT',
    ): ImportPreviewView => {
      this.ctx.log.warn('restore.previewRejected', { code });
      return {
        token: '',
        kind: 'backup',
        fileLabel,
        formatVersion: '—',
        mode: 'replace',
        incoming: emptyCounts(),
        current,
        messages: [...messages, { severity: 'error', path, message }],
        conflicts: [],
        canApply: false,
        summary: 'This backup cannot be restored. Your current library has not been changed.',
        confirmationWord: null,
      };
    };

    let size: number;
    try {
      size = statSync(file).size;
    } catch (e) {
      throw mapFsError(e, fileLabel);
    }
    if (size > MAX_BACKUP_BYTES)
      return fail('The backup is larger than the 2 GB limit.', 'archive', 'TOO_LARGE');
    const buf = readFileSync(file);

    // Pass 1: inspect the central directory without inflating anything.
    const problems: string[] = [];
    let declaredTotal = 0;
    let entries = 0;
    try {
      unzipSync(buf, {
        filter: (f) => {
          entries++;
          if (entries > MAX_ENTRIES) problems.push('Too many files in archive.');
          if (!ENTRY_RE.test(f.name)) {
            problems.push(
              f.name.includes('..') ||
                f.name.startsWith('/') ||
                f.name.includes('\\') ||
                /^[A-Za-z]:/.test(f.name)
                ? `Unsafe path in archive: "${f.name.slice(0, 80)}".`
                : `Unexpected file in archive: "${f.name.slice(0, 80)}".`,
            );
          }
          declaredTotal += f.originalSize;
          if (f.originalSize > MAX_ENTRY_BYTES) problems.push(`"${f.name.slice(0, 80)}" is too large.`);
          if (f.size > 0 && f.originalSize / f.size > MAX_RATIO && f.originalSize > 10 * 1024 * 1024) {
            problems.push(`"${f.name.slice(0, 80)}" has a suspicious compression ratio.`);
          }
          return false;
        },
      });
    } catch {
      return fail('The backup file is damaged or truncated (it is not a valid archive).');
    }
    if (problems.length > 0) return fail(problems.slice(0, 5).join(' '));
    if (declaredTotal > MAX_UNCOMPRESSED_BYTES)
      return fail('The backup expands to more than 4 GB.', 'archive', 'TOO_LARGE');
    ensureFreeSpace(this.ctx.paths.userData, declaredTotal * 2);

    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(buf, { filter: (f) => ENTRY_RE.test(f.name) });
    } catch {
      return fail('The backup file is damaged or truncated.');
    }
    const manifestBytes = files['manifest.json'];
    if (!manifestBytes) return fail('The backup has no manifest.json.');
    let manifest: Manifest;
    try {
      const raw: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
      const fmt = (raw as { formatVersion?: unknown } | null)?.formatVersion;
      if ((raw as { format?: unknown } | null)?.format !== BACKUP_FORMAT)
        return fail('This is not a Maybe Pile backup.', 'manifest.json');
      if (typeof fmt === 'number' && fmt > BACKUP_FORMAT_VERSION) {
        return fail(
          `This backup uses format version ${fmt}; this app supports up to ${BACKUP_FORMAT_VERSION}. Update Maybe Pile to restore it.`,
          'manifest.json',
          'UNSUPPORTED_VERSION',
        );
      }
      const m = ManifestSchema.safeParse(raw);
      if (!m.success) return fail('The backup manifest is invalid.', 'manifest.json');
      manifest = m.data;
    } catch {
      return fail('The backup manifest is not valid JSON.', 'manifest.json');
    }
    if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
      return fail(
        `This backup was made by a newer Maybe Pile (library schema v${manifest.schemaVersion}; this app supports v${LATEST_SCHEMA_VERSION}). Update the app to restore it.`,
        'manifest.json',
        'UNSUPPORTED_VERSION',
      );
    }
    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    for (const name of Object.keys(files)) {
      if (name === 'manifest.json') continue;
      const entry = listed.get(name);
      const data = files[name];
      if (!entry || !data) return fail(`"${name}" is not listed in the manifest.`);
      if (entry.bytes !== data.byteLength || entry.sha256 !== sha256(data))
        return fail(`Checksum mismatch for "${name}". The backup is damaged.`);
    }
    for (const path of listed.keys()) if (!files[path]) return fail(`"${path}" is missing from the backup.`);
    const dbBytes = files['library.sqlite'];
    if (!dbBytes) return fail('The backup contains no library database.');

    // Stage and verify the database on a copy.
    const dir = mkdtempSync(join(this.ctx.paths.userData, '.restore-staging-'));
    const token = randomBytes(16).toString('hex');
    try {
      const dbPath = join(dir, 'library.sqlite');
      writeFileSync(dbPath, dbBytes);
      const artworkDir = join(dir, 'artwork');
      mkdirSync(artworkDir);
      for (const [name, data] of Object.entries(files)) {
        if (!name.startsWith('artwork/')) continue;
        const fname = name.slice('artwork/'.length);
        if (!ARTWORK_FILE_RE.test(fname)) continue;
        writeFileSync(join(artworkDir, fname), data);
      }
      let incoming: CountsView;
      const staged = new Db(dbPath);
      try {
        const problemsDb = staged.integrityCheck();
        if (problemsDb.length > 0)
          throw appError('CORRUPT', 'The backup database failed its integrity check.');
        const v = currentSchemaVersion(staged);
        if (v > LATEST_SCHEMA_VERSION)
          throw appError('UNSUPPORTED_VERSION', 'The backup database is newer than this app.');
        if (v < LATEST_SCHEMA_VERSION) {
          migrate(staged);
          messages.push({
            severity: 'warning',
            path: 'library.sqlite',
            message: `The backup is from an older version (schema v${v}) and will be upgraded to v${LATEST_SCHEMA_VERSION}.`,
          });
        }
        if (staged.foreignKeyViolations() > 0)
          throw appError('CORRUPT', 'The backup database has broken references.');
        incoming = libraryCounts(staged);
        staged.checkpoint();
      } finally {
        staged.close();
      }
      if (manifest.appVersion !== this.ctx.appVersion) {
        messages.push({
          severity: 'warning',
          path: 'manifest.json',
          message: `Backup made with Maybe Pile ${manifest.appVersion}.`,
        });
      }
      this.staged.set(token, { dir, dbPath, artworkDir, fileLabel, at: Date.now() });
      return {
        token,
        kind: 'backup',
        fileLabel,
        formatVersion: `${BACKUP_FORMAT} v${manifest.formatVersion} · created ${manifest.createdAt.slice(0, 10)}`,
        mode: 'replace',
        incoming,
        current,
        messages,
        conflicts: [],
        canApply: true,
        summary:
          'Replace: your current library (items, history, themes, layouts, settings and artwork) will be replaced by this backup. A snapshot of your current library is saved first so you can undo this.',
        confirmationWord: CONFIRMATION_WORD,
      };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      if (e instanceof AppError)
        return fail(
          e.safe.message,
          'library.sqlite',
          e.safe.code === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : 'CORRUPT',
        );
      return fail('The backup database could not be opened. The backup may be damaged.', 'library.sqlite');
    }
  }

  cancelRestore(token: string): void {
    this.discardStaged(token);
  }

  /* ---------------------------------------------------------------- restore apply */

  applyRestore(token: string, confirmation: string, opts: { failAtStep?: number } = {}): ImportResultView {
    const s = this.staged.get(token);
    if (!s)
      throw appError('NOT_FOUND', 'This restore preview has expired.', {
        recovery: 'Choose the backup file again.',
      });
    if (confirmation !== CONFIRMATION_WORD) {
      throw appError('VALIDATION', `Type ${CONFIRMATION_WORD} to confirm replacing your library.`, {
        fieldErrors: { confirmation: `Type ${CONFIRMATION_WORD}` },
      });
    }
    if (!existsSync(s.dbPath))
      throw appError('NOT_FOUND', 'The staged restore is gone.', {
        recovery: 'Choose the backup file again.',
      });
    const snapshotLabel = this.createInternalSnapshot('pre-restore');
    try {
      this.dbm.swapIn(s.dbPath, s.artworkDir, opts);
    } finally {
      this.discardStaged(token);
    }
    const counts = libraryCounts(this.ctx.db());
    const total = Object.values(counts.items).reduce((a, b) => a + b, 0);
    this.ctx.log.info('restore.applied', { items: total });
    return { added: total, updated: 0, skipped: 0, duplicated: 0, snapshotLabel };
  }

  /** Lists snapshots in the app backups folder (labels only). */
  listInternal(): { label: string; bytes: number; kind: 'pre-restore' | 'pre-migration' | 'other' }[] {
    const dir = this.ctx.paths.backups;
    if (!existsSync(dir)) return [];
    return readdirSafe(dir)
      .filter((f) => f.endsWith('.mpbackup') || f.endsWith('.sqlite'))
      .sort()
      .reverse()
      .map((f) => ({
        label: f,
        bytes: statSync(join(dir, f)).size,
        kind: f.startsWith('pre-restore')
          ? ('pre-restore' as const)
          : f.startsWith('pre-migration')
            ? ('pre-migration' as const)
            : ('other' as const),
      }));
  }

  /** Removes stale staging folders from interrupted restores (called at startup). */
  cleanupStaging(): void {
    for (const f of readdirSafe(this.ctx.paths.userData)) {
      if (f.startsWith('.restore-staging-'))
        rmSync(join(this.ctx.paths.userData, f), { recursive: true, force: true });
    }
    for (const f of readdirSafe(this.ctx.paths.backups)) {
      if (f.startsWith('.snap-')) rmSync(join(this.ctx.paths.backups, f), { recursive: true, force: true });
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

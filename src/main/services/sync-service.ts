/**
 * Sync folder (feature 13). A folder the user chooses (e.g. inside Dropbox,
 * OneDrive, Syncthing or a USB stick) holds `maybe-pile-sync/<deviceId>.jsonl`:
 * one append-only changeset log per device. A device only ever writes its own
 * file, so the file-sync tool never has to merge files.
 *
 * Sync = preview (dry run, writes nothing) → apply:
 *  1. snapshot the database (VACUUM INTO backups/pre-sync-*.sqlite);
 *  2. in ONE transaction: apply incoming changes that don't conflict, record
 *     conflicts, update baselines and read cursors;
 *  3. append our outgoing changeset to our own file (temp file + rename).
 * Any failure in 2 rolls the transaction back (nothing changed). If 3 fails
 * after 2 committed, the changes are re-sent next time (idempotent).
 * Conflicts (both sides changed a field since the last sync) are never
 * resolved automatically: the user picks "keep mine" or "take theirs".
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  fstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { appError } from '../../shared/result';
import type { SyncConflictView, SyncPreviewView, SyncStatusView } from '../../shared/types';
import type { MediaType, Status } from '../../shared/enums';
import { readSettings, writeSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import * as runs from '../../db/repositories/runs-repo';
import { defaultPersonal, emptyMeta } from '../../domain/metadata';
import { externalIdError } from '../../domain/links';
import {
  ChangesetSchema,
  decide,
  localDiff,
  naturalKey,
  SYNC_FIELDS,
  type Change,
  type Changeset,
  type Decision,
  type RemoteChange,
  type SyncCreate,
  type SyncField,
  type SyncFields,
} from '../../domain/sync';
import { pruneFiles, timestampForFile } from './db-manager';
import type { ServiceContext } from './context';
import type { LibraryService } from './library-service';

export const SYNC_DIR = 'maybe-pile-sync';
export const MAX_LOG_BYTES = 50 * 1024 * 1024;
const FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

interface LocalItem {
  id: string;
  title: string;
  key: string;
  fields: SyncFields;
  create: SyncCreate;
}

const show = (v: unknown): string =>
  v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') || '—' : String(v);

export class SyncService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  /* ---------------------------------------------------------------- identity & settings */

  deviceId(): string {
    const row = this.db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'device_id'");
    if (row) return row.value;
    const id = randomUUID();
    this.db.run("INSERT INTO sync_state (key, value) VALUES ('device_id', ?)", [id]);
    return id;
  }

  private dir(): string {
    const { sync } = readSettings(this.db).settings;
    if (!sync.enabled || !sync.folder)
      throw appError('VALIDATION', 'Choose a sync folder first.', {
        recovery: 'Settings → Data → Sync folder.',
      });
    let st;
    try {
      st = statSync(sync.folder);
    } catch {
      throw appError('IO', "The sync folder can't be reached.", {
        recovery: 'Reconnect the drive or choose the folder again.',
      });
    }
    if (!st.isDirectory()) throw appError('VALIDATION', 'The sync location is not a folder.');
    const d = join(sync.folder, SYNC_DIR);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Called by main after the user picks a folder in the native dialog (the renderer never sends paths). */
  setFolder(folder: string | null, deviceName?: string): SyncStatusView {
    const { settings } = readSettings(this.db);
    if (folder !== null) {
      try {
        if (!statSync(folder).isDirectory()) throw new Error('not dir');
      } catch {
        throw appError('VALIDATION', 'Choose an existing folder.');
      }
    }
    writeSettings(this.db, {
      sync: { enabled: folder !== null, folder, deviceName: deviceName?.trim() || settings.sync.deviceName },
    });
    return this.status();
  }

  status(): SyncStatusView {
    const { sync } = readSettings(this.db).settings;
    const me = this.deviceId();
    const others: SyncStatusView['otherDevices'] = [];
    if (sync.enabled && sync.folder && existsSync(join(sync.folder, SYNC_DIR))) {
      for (const { deviceId, sets } of this.readLogs(join(sync.folder, SYNC_DIR), me, true)) {
        const last = sets[sets.length - 1];
        others.push({
          deviceId,
          deviceName: last?.deviceName ?? 'Unknown device',
          lastSeq: last?.seq ?? 0,
          readSeq: this.cursor(deviceId),
        });
      }
    }
    return {
      enabled: sync.enabled,
      folderLabel: sync.folder,
      deviceId: me,
      deviceName: sync.deviceName,
      otherDevices: others,
      openConflicts:
        this.db.get<{ n: number }>('SELECT count(*) AS n FROM sync_conflicts WHERE resolved_at IS NULL')?.n ??
        0,
    };
  }

  private cursor(deviceId: string): number {
    return (
      this.db.get<{ last_seq: number }>('SELECT last_seq FROM sync_cursors WHERE device_id = ?', [deviceId])
        ?.last_seq ?? 0
    );
  }

  /* ---------------------------------------------------------------- reading */

  /** Parses other devices' logs. Bad lines are skipped and reported. */
  private readLogs(
    dir: string,
    me: string,
    all = false,
  ): { deviceId: string; sets: Changeset[]; warnings: string[] }[] {
    const out: { deviceId: string; sets: Changeset[]; warnings: string[] }[] = [];
    for (const name of readdirSync(dir)) {
      const m = FILE_RE.exec(name);
      if (!m || m[1] === me) continue;
      const deviceId = m[1] ?? '';
      const warnings: string[] = [];
      const text = readCapped(join(dir, name), MAX_LOG_BYTES);
      if (text === null) {
        out.push({ deviceId, sets: [], warnings: [`${name} is larger than 50 MB and was skipped.`] });
        continue;
      }
      const since = all ? 0 : this.cursor(deviceId);
      const sets: Changeset[] = [];
      text.split('\n').forEach((line, i) => {
        if (!line.trim()) return;
        try {
          const p = ChangesetSchema.safeParse(JSON.parse(line));
          if (!p.success || p.data.deviceId !== deviceId)
            warnings.push(`${name} line ${i + 1} is invalid and was skipped.`);
          else if (p.data.seq > since) sets.push(p.data);
        } catch {
          // A partially written last line (the other device is mid-write) is expected; it's read next time.
          warnings.push(`${name} line ${i + 1} could not be read yet.`);
        }
      });
      out.push({ deviceId, sets: sets.sort((a, b) => a.seq - b.seq), warnings });
    }
    return out;
  }

  /* ---------------------------------------------------------------- local state */

  private localItems(): Map<string, LocalItem> {
    const rows = this.db.all<{
      id: string;
      type: MediaType;
      title: string;
      title_key: string;
      release_year: number | null;
      release_date: string | null;
      status: Status;
      rating: number | null;
      notes: string;
      date_started: string | null;
      date_completed: string | null;
      deleted_at: string | null;
    }>(
      'SELECT id, type, title, title_key, release_year, release_date, status, rating, notes, date_started, date_completed, deleted_at FROM items',
    );
    const ids = new Map<string, { kind: string; value: string }[]>();
    for (const e of this.db.all<{ item_id: string; kind: string; value: string }>(
      'SELECT item_id, kind, value FROM external_ids',
    )) {
      const a = ids.get(e.item_id);
      if (a) a.push({ kind: e.kind, value: e.value });
      else ids.set(e.item_id, [{ kind: e.kind, value: e.value }]);
    }
    const tags = new Map<string, string[]>();
    for (const t of this.db.all<{ item_id: string; name: string }>(
      'SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id ORDER BY t.name_key',
    )) {
      const a = tags.get(t.item_id);
      if (a) a.push(t.name);
      else tags.set(t.item_id, [t.name]);
    }
    const out = new Map<string, LocalItem>();
    for (const r of rows) {
      const ext = ids.get(r.id) ?? [];
      const key = naturalKey({ type: r.type, titleKey: r.title_key, year: r.release_year, externalIds: ext });
      const live = out.get(key);
      // Two local rows with one key (e.g. a deleted duplicate): the live one represents the key.
      if (live && !live.fields.deleted && r.deleted_at) continue;
      out.set(key, {
        id: r.id,
        title: r.title,
        key,
        fields: {
          status: r.status,
          rating: r.rating,
          notes: r.notes,
          dateStarted: r.date_started,
          dateCompleted: r.date_completed,
          tags: tags.get(r.id) ?? [],
          deleted: r.deleted_at !== null,
        },
        create: { type: r.type, title: r.title, releaseDate: r.release_date, externalIds: ext },
      });
    }
    return out;
  }

  private baselines(): Map<string, Partial<SyncFields>> {
    const m = new Map<string, Partial<SyncFields>>();
    for (const b of this.db.all<{ entity_key: string; fields: string }>(
      'SELECT entity_key, fields FROM sync_baseline',
    ))
      try {
        m.set(b.entity_key, JSON.parse(b.fields) as Partial<SyncFields>);
      } catch {
        /* corrupt baseline row: treated as no baseline */
      }
    return m;
  }

  /* ---------------------------------------------------------------- plan */

  private plan() {
    const dir = this.dir();
    const me = this.deviceId();
    const local = this.localItems();
    const base = this.baselines();
    const outgoing: Change[] = [];
    for (const it of local.values()) {
      const b = base.get(it.key) ?? null;
      if (!b && it.fields.deleted) continue; // never synced and deleted here: nothing to tell
      const diff = localDiff(it.fields, b);
      if (Object.keys(diff).length)
        outgoing.push({ key: it.key, fields: diff, create: b ? null : it.create });
    }
    const logs = this.readLogs(dir, me);
    const remote: RemoteChange[] = [];
    for (const l of logs)
      for (const set of l.sets)
        for (const c of set.changes)
          for (const f of SYNC_FIELDS)
            if (f in c.fields)
              remote.push({
                key: c.key,
                field: f,
                value: c.fields[f],
                deviceId: set.deviceId,
                at: set.at,
                create: c.create,
              });
    const decisions = decide(
      remote,
      (k) => local.get(k)?.fields ?? null,
      (k) => base.get(k) ?? null,
    );
    return { dir, me, local, base, outgoing, logs, decisions, warnings: logs.flatMap((l) => l.warnings) };
  }

  preview(): SyncPreviewView {
    const p = this.plan();
    const applies = p.decisions.filter((d) => d.kind === 'apply');
    const keysCreated = new Set(applies.filter((d) => !p.local.has(d.change.key)).map((d) => d.change.key));
    const names = new Map(
      p.logs.map((l) => [l.deviceId, l.sets[l.sets.length - 1]?.deviceName ?? 'another device']),
    );
    return {
      outgoing: p.outgoing.length,
      incoming: {
        apply: applies.filter((d) => p.local.has(d.change.key)).length,
        creates: keysCreated.size,
        deletes: applies.filter((d) => d.change.field === 'deleted' && d.change.value === true).length,
        noop: p.decisions.filter((d) => d.kind === 'noop').length,
      },
      conflicts: p.decisions
        .filter((d): d is Extract<Decision, { kind: 'conflict' }> => d.kind === 'conflict')
        .map((d) => ({
          key: d.change.key,
          title: p.local.get(d.change.key)?.title ?? d.change.key,
          field: d.change.field,
          local: show(d.local),
          remote: show(d.change.value),
          device: names.get(d.change.deviceId) ?? 'another device',
        })),
      warnings: p.warnings.slice(0, 50),
    };
  }

  /* ---------------------------------------------------------------- apply */

  apply(): { applied: number; created: number; conflicts: number; sent: number; snapshot: string } {
    const p = this.plan();
    const now = this.ctx.clock.now().toISOString();
    const snapshot = `pre-sync-${timestampForFile(this.ctx.clock.now())}-${randomUUID().slice(0, 8)}.sqlite`;
    mkdirSync(this.ctx.paths.backups, { recursive: true });
    this.db.snapshotTo(join(this.ctx.paths.backups, snapshot));
    pruneFiles(this.ctx.paths.backups, 'pre-sync-', '.sqlite', 5);
    let applied = 0;
    let created = 0;
    let conflicts = 0;
    const db = this.db;
    db.transaction(() => {
      // Group applied field changes per key so creates happen once.
      const byKey = new Map<string, RemoteChange[]>();
      for (const d of p.decisions) {
        if (d.kind === 'conflict') {
          const it = p.local.get(d.change.key);
          db.run(
            `INSERT INTO sync_conflicts (id, entity_key, item_id, item_title, field, local_value, remote_value, remote_device, remote_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              d.change.key,
              it?.id ?? null,
              (it?.title ?? d.change.key).slice(0, 500),
              d.change.field,
              JSON.stringify(d.local ?? null),
              JSON.stringify(d.change.value ?? null),
              d.change.deviceId,
              d.change.at,
              now,
            ],
          );
          conflicts++;
        } else if (d.kind === 'apply') {
          const a = byKey.get(d.change.key);
          if (a) a.push(d.change);
          else byKey.set(d.change.key, [d.change]);
        }
      }
      for (const [key, changes] of byKey) {
        let it = p.local.get(key);
        if (!it) {
          const create = changes.find((c) => c.create)?.create;
          if (!create) continue;
          const id = this.createFrom(create);
          created++;
          it = { id, title: create.title, key, fields: {} as SyncFields, create };
        }
        for (const c of changes) {
          this.applyField(it.id, c.field, c.value, now);
          applied++;
        }
        items.touch(db, it.id, now);
        items.reindexItem(db, it.id);
        items.recomputeProgress(db, it.id);
        runs.syncRuns(db, it.id, now);
      }
      // New baseline = our state after applying (both sides now agree, except open conflicts).
      const after = this.localItems();
      const conflictKeys = new Set(
        p.decisions.filter((d) => d.kind === 'conflict').map((d) => `${d.change.key}\u0000${d.change.field}`),
      );
      for (const it of after.values()) {
        const prev = p.base.get(it.key) ?? {};
        const next: Partial<SyncFields> = {};
        for (const f of SYNC_FIELDS)
          (next as Record<string, unknown>)[f] = conflictKeys.has(`${it.key}\u0000${f}`)
            ? prev[f]
            : it.fields[f];
        db.run(
          `INSERT INTO sync_baseline (entity_key, fields, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (entity_key) DO UPDATE SET fields = excluded.fields, updated_at = excluded.updated_at`,
          [it.key, JSON.stringify(next), now],
        );
      }
      for (const l of p.logs) {
        const last = l.sets[l.sets.length - 1];
        if (last)
          db.run(
            `INSERT INTO sync_cursors (device_id, last_seq, read_at) VALUES (?, ?, ?)
             ON CONFLICT (device_id) DO UPDATE SET last_seq = excluded.last_seq, read_at = excluded.read_at`,
            [l.deviceId, last.seq, now],
          );
      }
    });
    // Outgoing changes: computed before applying incoming ones, so remote values aren't echoed back.
    let sent = 0;
    if (p.outgoing.length) {
      sent = p.outgoing.length;
      this.appendChangeset(p.dir, p.me, p.outgoing, now);
    }
    this.ctx.log.info('sync.applied', { applied, created, conflicts, sent });
    return { applied, created, conflicts, sent, snapshot };
  }

  private appendChangeset(dir: string, me: string, changes: Change[], now: string): void {
    const seq =
      Number(
        this.db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'last_seq'")?.value ?? '0',
      ) + 1;
    const { sync } = readSettings(this.db).settings;
    const set: Changeset = { v: 1, deviceId: me, deviceName: sync.deviceName, seq, at: now, changes };
    const file = join(dir, `${me}.jsonl`);
    const prev = existsSync(file) ? (readCapped(file, MAX_LOG_BYTES) ?? '') : '';
    const tmp = `${file}.${process.pid}.tmp`;
    // Write-then-rename: other devices never see a half-written file from us.
    writeFileSync(tmp, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${JSON.stringify(set)}\n`, 'utf8');
    renameSync(tmp, file);
    this.db.run(
      "INSERT INTO sync_state (key, value) VALUES ('last_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [String(seq)],
    );
  }

  private createFrom(c: SyncCreate): string {
    const meta = {
      ...emptyMeta(c.title),
      releaseDate: c.releaseDate,
      externalIds: c.externalIds.filter((e) => externalIdError(e as never) === null) as never,
    };
    const r = this.library.create({
      type: c.type,
      meta,
      personal: defaultPersonal(c.type, this.library.today()),
      seasons: [],
      milestones: [],
      allowDuplicate: true,
    } as never);
    if (r.kind !== 'created') throw appError('INTERNAL', 'A synced item could not be created.');
    return r.item.id;
  }

  private applyField(id: string, field: SyncField, value: unknown, now: string): void {
    const db = this.db;
    switch (field) {
      case 'status':
        db.run('UPDATE items SET status = ? WHERE id = ?', [value as string, id]);
        if (value === 'completed' || value === 'dropped')
          db.run('DELETE FROM up_next WHERE item_id = ?', [id]);
        break;
      case 'rating':
        db.run('UPDATE items SET rating = ? WHERE id = ?', [value as number | null, id]);
        break;
      case 'notes':
        db.run('UPDATE items SET notes = ? WHERE id = ?', [String(value ?? ''), id]);
        break;
      case 'dateStarted':
        db.run('UPDATE items SET date_started = ? WHERE id = ?', [value as string | null, id]);
        break;
      case 'dateCompleted':
        db.run('UPDATE items SET date_completed = ? WHERE id = ?', [value as string | null, id]);
        break;
      case 'tags':
        items.writeTags(db, id, Array.isArray(value) ? (value as string[]) : []);
        items.pruneOrphans(db);
        break;
      case 'deleted':
        db.run('UPDATE items SET deleted_at = ? WHERE id = ?', [value === true ? now : null, id]);
        break;
    }
  }

  /* ---------------------------------------------------------------- conflicts */

  conflicts(): SyncConflictView[] {
    return this.db
      .all<{
        id: string;
        item_id: string | null;
        item_title: string;
        field: SyncField;
        local_value: string;
        remote_value: string;
        remote_device: string;
        remote_at: string;
      }>('SELECT * FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY created_at, item_title')
      .map((c) => ({
        id: c.id,
        itemId: c.item_id,
        itemTitle: c.item_title,
        field: c.field,
        local: show(JSON.parse(c.local_value)),
        remote: show(JSON.parse(c.remote_value)),
        remoteDevice: c.remote_device,
        remoteAt: c.remote_at,
      }));
  }

  /**
   * "theirs" applies the remote value; "mine" keeps the local one. Either way
   * the baseline is cleared for that field, so the winning value is sent at
   * the next sync and the other device adopts it (it's untouched there).
   */
  resolve(id: string, choice: 'mine' | 'theirs'): SyncConflictView[] {
    const db = this.db;
    const c = db.get<{
      entity_key: string;
      item_id: string | null;
      field: SyncField;
      remote_value: string;
      resolved_at: string | null;
    }>('SELECT entity_key, item_id, field, remote_value, resolved_at FROM sync_conflicts WHERE id = ?', [id]);
    if (!c || c.resolved_at) throw appError('NOT_FOUND', 'That conflict was already resolved.');
    const now = this.ctx.clock.now().toISOString();
    db.transaction(() => {
      if (choice === 'theirs' && c.item_id) {
        this.applyField(c.item_id, c.field, JSON.parse(c.remote_value), now);
        items.touch(db, c.item_id, now);
        items.reindexItem(db, c.item_id);
        // Remote and local now agree: record it as the baseline so it isn't sent back.
        const b = db.get<{ fields: string }>('SELECT fields FROM sync_baseline WHERE entity_key = ?', [
          c.entity_key,
        ]);
        const fields = {
          ...(b ? (JSON.parse(b.fields) as object) : {}),
          [c.field]: JSON.parse(c.remote_value),
        };
        db.run(
          `INSERT INTO sync_baseline (entity_key, fields, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (entity_key) DO UPDATE SET fields = excluded.fields, updated_at = excluded.updated_at`,
          [c.entity_key, JSON.stringify(fields), now],
        );
      } else if (choice === 'mine') {
        // Mark the baseline as the remote value so our (different) value counts as a local change and is sent.
        const b = db.get<{ fields: string }>('SELECT fields FROM sync_baseline WHERE entity_key = ?', [
          c.entity_key,
        ]);
        const fields = {
          ...(b ? (JSON.parse(b.fields) as object) : {}),
          [c.field]: JSON.parse(c.remote_value),
        };
        db.run(
          `INSERT INTO sync_baseline (entity_key, fields, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (entity_key) DO UPDATE SET fields = excluded.fields, updated_at = excluded.updated_at`,
          [c.entity_key, JSON.stringify(fields), now],
        );
      }
      db.run('UPDATE sync_conflicts SET resolved_at = ?, resolution = ? WHERE id = ?', [now, choice, id]);
    });
    return this.conflicts();
  }
}

/** Reads a UTF-8 file if it is at most `max` bytes; null when larger. */
function readCapped(path: string, max: number): string | null {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > max) return null;
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * §16.2 Library check-up · §16.4 bulk edit · §16.7 auto status rules ·
 * §16.3 triage · §14.7 backup destination check.
 *
 * Check-up runs read-only. Fixes show a preview first, take a database
 * snapshot, and run in one transaction (rolled back on failure).
 */
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join, sep, win32 } from 'node:path';
import type { z } from 'zod';
import { appError } from '../../shared/result';
import type { Status } from '../../shared/enums';
import { readSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import { LAST_ACTIVITY_SQL } from '../../db/repositories/items-repo';
import { checkExternalUrl } from '../../domain/links';
import { addMonths } from '../../domain/calendar';
import { addDays } from '../../domain/dates';
import type { BulkEditChangeSchema } from '../../shared/pack21-schemas';
import { DEFAULT_LIBRARY_QUERY, LibraryQuerySchema } from '../../shared/schemas';
import type { ItemSummary, StatusSuggestion } from '../../shared/types';
import { pruneFiles, timestampForFile } from './db-manager';
import type { ServiceContext } from './context';
import type { HistoryService } from './history-service';
import type { LibraryService } from './library-service';
import type { ArtworkService } from './artwork-service';
import type { PileHealthService } from './pile-health-service';
import type { MoodsService } from './moods-service';
import type { ListsService } from './lists-service';

/* ------------------------------------------------------------------ check-up */

export type FindingSeverity = 'error' | 'warning' | 'info';
export type FixId =
  | 'reindexFts'
  | 'clearMissingArtwork'
  | 'removeUnusedCache'
  | 'pruneOrphans'
  | 'recomputeDerived'
  | 'repairBackground';

export interface Finding {
  code: string;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  count: number;
  fix: { id: FixId; label: string; safe: boolean; preview: string } | null;
}

export interface CheckupReport {
  ranAt: string;
  findings: Finding[];
  ok: boolean;
}

/* ------------------------------------------------------------------ backup destination */

export interface BackupDirCheck {
  exists: boolean;
  sameVolume: boolean;
  cloudHint: string | null;
  removableHint: boolean;
  warnings: string[];
}

const CLOUD_RE =
  /(dropbox|onedrive|google ?drive|googledrive|icloud ?drive|icloud|syncthing|nextcloud|owncloud|pcloud|mega ?sync|box sync|seafile)/i;

/** Pure: inspects only the chosen path and its device/volume info (never scans the filesystem). */
export function checkBackupDir(
  dir: string,
  libraryDir: string,
  platform: NodeJS.Platform,
  stat: (p: string) => { dev: number } | null,
): BackupDirCheck {
  const s = stat(dir);
  const lib = stat(libraryDir);
  const warnings: string[] = [];
  if (!s)
    return {
      exists: false,
      sameVolume: false,
      cloudHint: null,
      removableHint: false,
      warnings: ['This folder is not available right now.'],
    };
  let sameVolume: boolean;
  if (platform === 'win32') {
    const root = (p: string) => win32.parse(p).root.toLowerCase(); // target-OS parsing, also correct in tests on Linux
    sameVolume = root(dir) === root(libraryDir) || (!!lib && lib.dev === s.dev && s.dev !== 0);
  } else sameVolume = !!lib && lib.dev === s.dev;
  if (sameVolume) warnings.push('A backup on the same drive as your library won’t help if that drive fails.');
  const cloud = CLOUD_RE.exec(dir)?.[1] ?? null;
  if (cloud)
    warnings.push(
      `This looks like a ${cloud} folder. Cloud sync helps, but keep another copy too — a sync can also copy a damaged file.`,
    );
  const removable = platform === 'linux' ? /^\/(media|run\/media|mnt)\//.test(dir) : false;
  if (removable)
    warnings.push(
      'This looks like a removable drive. Backups there are only available while it is plugged in.',
    );
  return { exists: true, sameVolume, cloudHint: cloud, removableHint: removable, warnings };
}

/* ------------------------------------------------------------------ bulk edit */

export interface BulkPreview {
  total: number;
  changes: { field: string; label: string; count: number }[];
  exceptions: { itemId: string; title: string; reason: string }[];
  unchanged: number;
}

/* ------------------------------------------------------------------ rules */

export interface RulePreview {
  rule: 'suggestCompleted' | 'onHoldAfterDays' | 'stalePlanned' | 'removeFromUpNextOnStart';
  label: string;
  items: { id: string; title: string }[];
}

export class MaintenanceService {
  private lastReport: CheckupReport | null = null;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: {
      library: LibraryService;
      history: HistoryService;
      artwork: ArtworkService;
      health: PileHealthService;
      moods: MoodsService;
      lists: ListsService;
      backgroundHealth?: () => Promise<{ ok: boolean; message: string }>;
      repairBackground?: () => Promise<void>;
    },
  ) {}

  private get db() {
    return this.ctx.db();
  }

  /* ---------------------------------------------------------------- check-up */

  async checkup(): Promise<CheckupReport> {
    const db = this.db;
    const f: Finding[] = [];
    const integrity = db.integrityCheck(false);
    if (integrity.length > 0)
      f.push({
        code: 'integrity',
        severity: 'error',
        title: 'The database failed its integrity check',
        explanation:
          'Restore your latest backup from Backup & restore. Nothing here can safely fix this automatically.',
        count: integrity.length,
        fix: null,
      });
    const fk = db.foreignKeyViolations();
    if (fk > 0)
      f.push({
        code: 'foreignKeys',
        severity: 'error',
        title: 'Broken references between records',
        explanation: 'Some records point to records that no longer exist.',
        count: fk,
        fix: {
          id: 'pruneOrphans',
          label: 'Remove broken references',
          safe: false,
          preview: `${fk} broken reference(s) will be removed.`,
        },
      });
    const live = db.get<{ n: number }>('SELECT count(*) AS n FROM items WHERE deleted_at IS NULL')?.n ?? 0;
    const fts = db.get<{ n: number }>('SELECT count(*) AS n FROM items_fts')?.n ?? 0;
    const missingFts =
      db.get<{ n: number }>(
        'SELECT count(*) AS n FROM items i WHERE i.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM items_fts f WHERE f.rowid = i.rid)',
      )?.n ?? 0;
    if (missingFts > 0 || fts !== live)
      f.push({
        code: 'fts',
        severity: 'warning',
        title: 'Search index out of date',
        explanation: 'Some items may not show up in search.',
        count: Math.max(missingFts, Math.abs(fts - live)),
        fix: {
          id: 'reindexFts',
          label: 'Rebuild the search index',
          safe: true,
          preview: `The search index will be rebuilt for ${live} item(s).`,
        },
      });
    const art = db.all<{ id: string; file_name: string | null }>(
      "SELECT id, file_name FROM artwork WHERE source IN ('cache', 'user') AND file_name IS NOT NULL",
    );
    const missingArt = art.filter((a) => !this.deps.artwork.resolveFile(a.file_name ?? ''));
    if (missingArt.length > 0)
      f.push({
        code: 'artworkMissing',
        severity: 'warning',
        title: 'Missing artwork files',
        explanation:
          'Some covers or backdrops point to files that are gone. The item shows a generated cover until you pick a new image.',
        count: missingArt.length,
        fix: {
          id: 'clearMissingArtwork',
          label: 'Use generated covers for these',
          safe: true,
          preview: `${missingArt.length} image reference(s) will be cleared (pick new art any time).`,
        },
      });
    const referenced = new Set(this.deps.artwork.referencedFiles());
    let unused = 0;
    try {
      for (const name of readdirSync(this.ctx.paths.artwork))
        if (/^[a-f0-9]{64}/.test(name) && !referenced.has(name)) unused++;
    } catch {
      /* no artwork folder yet */
    }
    if (unused > 0)
      f.push({
        code: 'artworkUnused',
        severity: 'info',
        title: 'Cached images nothing uses',
        explanation: 'Leftover image files take disk space.',
        count: unused,
        fix: {
          id: 'removeUnusedCache',
          label: 'Delete unused image files',
          safe: true,
          preview: `${unused} unused file(s) will be deleted.`,
        },
      });
    const orphans =
      (db.get<{ n: number }>('SELECT count(*) AS n FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags)')
        ?.n ?? 0) +
      (db.get<{ n: number }>(
        'SELECT count(*) AS n FROM creators WHERE id NOT IN (SELECT creator_id FROM item_creators)',
      )?.n ?? 0) +
      (db.get<{ n: number }>(
        'SELECT count(*) AS n FROM genres WHERE id NOT IN (SELECT genre_id FROM item_genres)',
      )?.n ?? 0);
    if (orphans > 0)
      f.push({
        code: 'orphans',
        severity: 'info',
        title: 'Unused tags, creators or genres',
        explanation: 'Names no item uses any more.',
        count: orphans,
        fix: {
          id: 'pruneOrphans',
          label: 'Remove unused names',
          safe: true,
          preview: `${orphans} unused name(s) will be removed.`,
        },
      });
    const impossible =
      db.get<{ n: number }>(
        `SELECT count(*) AS n FROM items WHERE deleted_at IS NULL AND (
           (date_completed IS NOT NULL AND date_started IS NOT NULL AND date_completed < date_started)
           OR (status = 'planned' AND date_completed IS NOT NULL))`,
      )?.n ?? 0;
    const stale = this.staleDerived();
    if (stale.length > 0)
      f.push({
        code: 'derived',
        severity: 'warning',
        title: 'Progress shown differently from what is recorded',
        explanation: 'The progress label or bar of some items does not match their history.',
        count: stale.length,
        fix: {
          id: 'recomputeDerived',
          label: 'Recalculate progress',
          safe: true,
          preview: `Progress will be recalculated for ${stale.length} item(s).`,
        },
      });
    if (impossible > 0)
      f.push({
        code: 'dates',
        severity: 'warning',
        title: 'Dates that do not fit the status',
        explanation: 'For example a Planned item with a completion date. Open the items to correct them.',
        count: impossible,
        fix: null,
      });
    const dupIds =
      db.get<{ n: number }>(
        'SELECT count(*) AS n FROM (SELECT kind, value FROM external_ids e JOIN items i ON i.id = e.item_id WHERE i.deleted_at IS NULL GROUP BY kind, value HAVING count(DISTINCT e.item_id) > 1)',
      )?.n ?? 0;
    if (dupIds > 0)
      f.push({
        code: 'duplicateIds',
        severity: 'info',
        title: 'Possible duplicates',
        explanation: 'Several items share the same online ID. Use “Merge duplicates” to review them.',
        count: dupIds,
        fix: null,
      });
    const badLinks = db
      .all<{ url: string }>('SELECT url FROM streaming_links')
      .filter((l) => !checkExternalUrl(l.url, null).ok).length;
    if (badLinks > 0)
      f.push({
        code: 'links',
        severity: 'info',
        title: 'Links that cannot be opened',
        explanation: 'Some saved links are not valid web addresses.',
        count: badLinks,
        fix: null,
      });
    if (this.deps.backgroundHealth) {
      const b = await this.deps.backgroundHealth();
      if (!b.ok)
        f.push({
          code: 'background',
          severity: 'warning',
          title: 'Background reminders need attention',
          explanation: b.message,
          count: 1,
          fix: this.deps.repairBackground
            ? {
                id: 'repairBackground',
                label: 'Repair background reminders',
                safe: true,
                preview: 'The scheduled task / timer will be re-registered for this copy of Maybe Pile.',
              }
            : null,
        });
    }
    const now = this.ctx.clock.now().toISOString();
    db.run(
      "INSERT INTO app_events (key, at) VALUES ('last_checkup', ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at",
      [now],
    );
    this.lastReport = { ranAt: now, findings: f, ok: f.every((x) => x.severity === 'info') };
    return this.lastReport;
  }

  private staleDerived(): string[] {
    const out: string[] = [];
    for (const r of this.db.all<{ id: string; progress_pct: number | null; progress_label: string }>(
      'SELECT id, progress_pct, progress_label FROM items WHERE deleted_at IS NULL LIMIT 50000',
    )) {
      const p = items.computeProgress(this.db, r.id);
      if (p.label !== r.progress_label || (p.percent ?? null) !== (r.progress_pct ?? null)) out.push(r.id);
    }
    return out;
  }

  /** Applies fixes after taking a snapshot; everything in one transaction. */
  async fix(ids: readonly FixId[]): Promise<{ snapshot: string; applied: FixId[] }> {
    const db = this.db;
    const snap = `pre-fix-${timestampForFile(this.ctx.clock.now())}.sqlite`;
    db.snapshotTo(join(this.ctx.paths.backups, snap));
    pruneFiles(this.ctx.paths.backups, 'pre-fix-', '.sqlite', 5);
    const applied: FixId[] = [];
    const deferred: FixId[] = [];
    db.transaction(() => {
      for (const id of ids) {
        switch (id) {
          case 'reindexFts': {
            db.run('DELETE FROM items_fts');
            for (const r of db.all<{ id: string }>('SELECT id FROM items')) items.reindexItem(db, r.id);
            break;
          }
          case 'clearMissingArtwork': {
            for (const a of db.all<{ id: string; file_name: string | null }>(
              "SELECT id, file_name FROM artwork WHERE source IN ('cache', 'user') AND file_name IS NOT NULL",
            ))
              if (!this.deps.artwork.resolveFile(a.file_name ?? '')) {
                db.run('UPDATE items SET artwork_id = NULL WHERE artwork_id = ?', [a.id]);
                db.run('UPDATE artwork SET selected = 0 WHERE id = ?', [a.id]);
              }
            break;
          }
          case 'pruneOrphans':
            items.pruneOrphans(db);
            break;
          case 'recomputeDerived':
            for (const id2 of this.staleDerived()) items.recomputeProgress(db, id2);
            break;
          case 'removeUnusedCache':
          case 'repairBackground':
            deferred.push(id); // file / OS operations happen after the DB transaction commits
            continue;
        }
        applied.push(id);
      }
    });
    for (const id of deferred) {
      if (id === 'removeUnusedCache') this.deps.artwork.gc();
      if (id === 'repairBackground') await this.deps.repairBackground?.();
      applied.push(id);
    }
    this.ctx.log.info('checkup.fixed', { fixes: applied.length });
    return { snapshot: snap, applied };
  }

  /** Redacted plain-text report (codes and counts only; no titles, notes or paths). */
  reportText(): string {
    const r = this.lastReport;
    if (!r) return 'No check-up has been run yet.\n';
    return [
      `Maybe Pile library check-up — ${r.ranAt}`,
      `App ${this.ctx.appVersion}`,
      ...r.findings.map((x) => `[${x.severity}] ${x.code}: ${x.count}`),
      r.findings.length === 0 ? 'No problems found.' : '',
    ].join('\n');
  }

  /* ---------------------------------------------------------------- bulk edit */

  private bulkPlan(ids: readonly string[], change: z.output<typeof BulkEditChangeSchema>): BulkPreview {
    const rows = this.db.all<{
      id: string;
      title: string;
      status: Status;
      rating: number | null;
      deleted_at: string | null;
      type: string;
    }>(
      `SELECT id, title, status, rating, deleted_at, type FROM items WHERE id IN (${ids.map(() => '?').join(',')})`,
      [...ids],
    );
    const exceptions: BulkPreview['exceptions'] = [];
    const counts = new Map<string, number>();
    const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    let unchanged = 0;
    for (const r of rows) {
      if (r.deleted_at) {
        exceptions.push({ itemId: r.id, title: r.title, reason: 'In Recently deleted.' });
        continue;
      }
      let any = false;
      if (change.status && change.status !== r.status) {
        bump('status');
        any = true;
      }
      if (change.rating !== null) {
        const next = change.rating === 'clear' ? null : change.rating;
        if (next !== r.rating) {
          bump('rating');
          any = true;
        }
      }
      if (change.tags) {
        bump('tags');
        any = true;
      }
      if (change.moods) {
        bump('moods');
        any = true;
      }
      if (change.list) {
        bump('list');
        any = true;
      }
      if (change.platform) {
        if (r.type !== 'game')
          exceptions.push({ itemId: r.id, title: r.title, reason: 'Platforms apply to games only.' });
        else {
          bump('platform');
          any = true;
        }
      }
      if (!any) unchanged++;
    }
    const LABELS: Record<string, string> = {
      status: 'Status',
      rating: 'Rating',
      tags: 'Tags',
      moods: 'Moods',
      list: 'List',
      platform: 'Platform',
    };
    return {
      total: rows.length,
      changes: [...counts].map(([field, count]) => ({ field, label: LABELS[field] ?? field, count })),
      exceptions,
      unchanged,
    };
  }

  bulkPreview(ids: readonly string[], change: z.output<typeof BulkEditChangeSchema>): BulkPreview {
    return this.bulkPlan(ids, change);
  }

  /** One transaction, one undoable batch in Recent changes. Domain rules apply per item (never bypassed). */
  bulkApply(
    ids: readonly string[],
    change: z.output<typeof BulkEditChangeSchema>,
  ): { batchId: string | null; changed: number; exceptions: BulkPreview['exceptions'] } {
    const plan = this.bulkPlan(ids, change);
    const skip = new Set(plan.exceptions.map((e) => e.itemId));
    const target = ids.filter((id) => !skip.has(id));
    const lib = this.deps.library;
    const before = this.deps.history.capture(target);
    this.db.transaction(() => {
      for (const id of target) {
        const row = this.db.get<{ status: Status; rating: number | null }>(
          'SELECT status, rating FROM items WHERE id = ?',
          [id],
        );
        if (!row) continue;
        if (change.status && change.status !== row.status)
          lib.setStatus({
            id,
            status: change.status,
            startNewPass: false,
            clearDateCompleted: change.status !== 'completed',
            fillRemaining: change.status === 'completed',
          });
        if (change.rating !== null) lib.setRating(id, change.rating === 'clear' ? null : change.rating);
        if (change.tags || change.platform) {
          const d = lib.get(id);
          const p = { ...d.personal };
          const tagChange = change.tags;
          if (tagChange) {
            if (tagChange.mode === 'replace') p.tags = [...tagChange.values];
            else if (tagChange.mode === 'add') p.tags = [...new Set([...p.tags, ...tagChange.values])];
            else
              p.tags = p.tags.filter(
                (t) => !tagChange.values.some((v) => v.toLowerCase() === t.toLowerCase()),
              );
          }
          const platform = change.platform;
          if (
            platform &&
            d.type === 'game' &&
            !p.platforms.some((x) => x.name.toLowerCase() === platform.toLowerCase())
          )
            p.platforms = [...p.platforms, { name: platform, owned: true, played: false }];
          lib.update({ id, personal: p });
        }
        const moodChange = change.moods;
        if (moodChange) {
          const cur = this.deps.moods.forItem(id);
          const next =
            moodChange.mode === 'add'
              ? [...new Set([...cur, ...moodChange.ids])]
              : cur.filter((m) => !moodChange.ids.includes(m));
          this.deps.moods.setForItem(id, next);
        }
        if (change.list) this.deps.lists.setMembership(change.list.listId, [id], change.list.mode === 'add');
      }
    });
    const batchId = this.deps.history.commit(before, 'bulk');
    return { batchId, changed: target.length, exceptions: plan.exceptions };
  }

  /* ---------------------------------------------------------------- auto status rules */

  rulePreview(): RulePreview[] {
    const rules = readSettings(this.db).settings.autoRules;
    const today = this.deps.library.today();
    const out: RulePreview[] = [];
    const pick = (sql: string, params: (string | number)[]) =>
      this.db.all<{ id: string; title: string }>(sql, params);
    if (rules.suggestCompleted) {
      const ids = this.db.all<{ id: string; title: string }>(
        "SELECT id, title FROM items WHERE deleted_at IS NULL AND status IN ('in_progress','on_hold')",
      );
      out.push({
        rule: 'suggestCompleted',
        label: 'Suggest Completed when everything is done',
        items: ids.filter((r) => items.computeProgress(this.db, r.id).isComplete),
      });
    }
    if (rules.onHoldAfterDays.enabled)
      out.push({
        rule: 'onHoldAfterDays',
        label: `Move In Progress to On Hold after ${rules.onHoldAfterDays.days} days without progress`,
        items: pick(
          `SELECT i.id, i.title FROM items i WHERE i.deleted_at IS NULL AND i.status = 'in_progress' AND ${LAST_ACTIVITY_SQL} < ?`,
          [addDays(today, -rules.onHoldAfterDays.days)],
        ),
      });
    if (rules.stalePlanned.enabled)
      out.push({
        rule: 'stalePlanned',
        label: `Flag Planned items as stale after ${rules.stalePlanned.months} months`,
        items: pick(
          `SELECT i.id, i.title FROM items i WHERE i.deleted_at IS NULL AND i.status = 'planned' AND i.date_added < ?
             AND NOT EXISTS (SELECT 1 FROM item_flags f WHERE f.item_id = i.id AND f.flag = 'stale')`,
          [addMonths(today, -rules.stalePlanned.months)],
        ),
      });
    if (rules.removeFromUpNextOnStart)
      out.push({
        rule: 'removeFromUpNextOnStart',
        label: 'Remove started items from Up Next',
        items: pick(
          "SELECT i.id, i.title FROM up_next u JOIN items i ON i.id = u.item_id WHERE i.deleted_at IS NULL AND i.status = 'in_progress'",
          [],
        ),
      });
    return out;
  }

  /**
   * Runs the opt-in rules (app start + daily, app process only — they write the library).
   * Suggestions are returned, never applied. Changes are one undoable batch. Nothing is ever deleted.
   */
  runRules(): {
    batchId: string | null;
    changed: number;
    suggestions: { id: string; title: string; suggestion: StatusSuggestion }[];
  } {
    const preview = this.rulePreview();
    const suggestions: { id: string; title: string; suggestion: StatusSuggestion }[] = [];
    const ids = new Set<string>();
    for (const p of preview) for (const i of p.items) ids.add(i.id);
    const before = this.deps.history.capture([...ids]);
    let changed = 0;
    const now = this.ctx.clock.now().toISOString();
    this.db.transaction(() => {
      for (const p of preview) {
        for (const it of p.items) {
          if (p.rule === 'suggestCompleted')
            suggestions.push({
              id: it.id,
              title: it.title,
              suggestion: {
                kind: 'complete',
                status: 'completed',
                message: 'Everything is done. Mark it Completed?',
                setDateStarted: null,
              },
            });
          else if (p.rule === 'onHoldAfterDays') {
            this.deps.library.setStatus({
              id: it.id,
              status: 'on_hold',
              startNewPass: false,
              clearDateCompleted: false,
              fillRemaining: false,
            });
            changed++;
          } else if (p.rule === 'stalePlanned') {
            changed += this.db.run(
              "INSERT OR IGNORE INTO item_flags (item_id, flag, set_at) VALUES (?, 'stale', ?)",
              [it.id, now],
            ).changes;
          } else if (p.rule === 'removeFromUpNextOnStart') {
            this.deps.library.setUpNext(it.id, false);
            changed++;
          }
        }
      }
    });
    const batchId = this.deps.history.commit(before, 'rule');
    if (changed > 0) this.ctx.log.info('rules.ran', { changed });
    return { batchId, changed, suggestions };
  }

  /* ---------------------------------------------------------------- triage */

  triageQueue(
    source: 'planned' | 'list' | 'view' | 'batch',
    id: string | null,
    views: { id: string; query: unknown }[],
  ): ItemSummary[] {
    const lib = this.deps.library;
    if (source === 'planned')
      return lib.query({
        ...DEFAULT_LIBRARY_QUERY,
        statuses: ['planned'],
        sort: 'dateAdded',
        direction: 'asc',
        limit: 500,
        offset: 0,
      }).items;
    if (source === 'list') {
      if (!id) throw appError('VALIDATION', 'Choose a list.');
      return lib.query({ ...DEFAULT_LIBRARY_QUERY, listId: id, limit: 500, offset: 0 }).items;
    }
    if (source === 'view') {
      const v = views.find((x) => x.id === id);
      const q = LibraryQuerySchema.safeParse(v?.query);
      if (!q.success) throw appError('NOT_FOUND', 'That view no longer exists.');
      return lib.query({ ...q.data, limit: 500, offset: 0 }).items;
    }
    if (!id) throw appError('VALIDATION', 'Choose an import.');
    const ids = this.db
      .all<{ item_id: string }>('SELECT item_id FROM import_batch_items WHERE batch_id = ?', [id])
      .map((r) => r.item_id);
    if (ids.length === 0) return [];
    return items.summariesWhere(
      this.db,
      `i.id IN (${ids
        .slice(0, 500)
        .map(() => '?')
        .join(',')})`,
      ids.slice(0, 500),
      '',
    );
  }

  triageAct(
    itemId: string,
    action: 'keep' | 'upNext' | 'snooze' | 'hold' | 'drop' | 'skip',
    snoozeDays: number | null,
  ): { undo: TriageUndo } {
    const lib = this.deps.library;
    switch (action) {
      case 'keep':
      case 'skip':
        return { undo: { kind: 'none', itemId } };
      case 'upNext': {
        const was = lib.get(itemId).upNextPosition !== null;
        if (!was) lib.setUpNext(itemId, true);
        return { undo: was ? { kind: 'none', itemId } : { kind: 'upNext', itemId } };
      }
      case 'snooze': {
        const prev = lib.get(itemId).snoozedUntil;
        this.deps.health.snooze([itemId], addDays(lib.today(), snoozeDays ?? 30), 'manual');
        return { undo: { kind: 'snooze', itemId, prevUntil: prev } };
      }
      case 'hold':
      case 'drop': {
        const batchId = this.deps.history.logged([itemId], 'triage', () => {
          lib.setStatus({
            id: itemId,
            status: action === 'hold' ? 'on_hold' : 'dropped',
            startNewPass: false,
            clearDateCompleted: false,
            fillRemaining: false,
          });
        });
        void batchId;
        const last = this.db.get<{ batch_id: string }>(
          "SELECT batch_id FROM change_log WHERE item_id = ? AND source = 'triage' ORDER BY id DESC LIMIT 1",
          [itemId],
        );
        return { undo: last ? { kind: 'batch', itemId, batchId: last.batch_id } : { kind: 'none', itemId } };
      }
    }
  }

  triageUndo(u: TriageUndo): void {
    const lib = this.deps.library;
    if (u.kind === 'upNext') lib.setUpNext(u.itemId, false);
    else if (u.kind === 'snooze') {
      if (u.prevUntil) this.deps.health.snooze([u.itemId], u.prevUntil, 'manual');
      else this.deps.health.unsnooze([u.itemId]);
    } else if (u.kind === 'batch') this.deps.history.undoBatch(u.batchId);
  }

  /* ---------------------------------------------------------------- backup destination */

  checkBackupDestination(dir: string): BackupDirCheck {
    const stat = (p: string) => {
      try {
        return existsSync(p) ? { dev: statSync(p).dev } : null;
      } catch {
        return null;
      }
    };
    const r = checkBackupDir(dir, this.ctx.paths.userData, process.platform, stat);
    this.db.run(
      "INSERT INTO app_events (key, at, value) VALUES ('last_backup_dir_check', ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, value = excluded.value",
      [this.ctx.clock.now().toISOString(), r.sameVolume ? 'same-volume' : 'ok'],
    );
    return r;
  }

  recordBackup(): void {
    this.db.run(
      "INSERT INTO app_events (key, at) VALUES ('last_backup', ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at",
      [this.ctx.clock.now().toISOString()],
    );
  }
}

export type TriageUndo =
  | { kind: 'none'; itemId: string }
  | { kind: 'upNext'; itemId: string }
  | { kind: 'snooze'; itemId: string; prevUntil: string | null }
  | { kind: 'batch'; itemId: string; batchId: string };

export const PATH_SEP = sep;

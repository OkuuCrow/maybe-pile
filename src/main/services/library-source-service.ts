/**
 * Library sources (Steam + manual lists): configuration, fetch jobs with
 * progress/cancel, snapshot reconciliation, the review list, ignore list,
 * batch import and re-sync diffs.
 *
 * Nothing in the pile changes because of a fetch. Items are only created by
 * `importSelected` after the user's explicit selection and confirmation, in
 * one transaction per chunk, each recorded in an import batch for undo.
 */
import { randomUUID } from 'node:crypto';
import type { Status } from '../../shared/enums';
import { appError, type UserSafeError } from '../../shared/result';
import type { SourceEntryFilter, SourceImportInput } from '../../shared/schemas';
import type {
  BatchImportResultView,
  FetchJobView,
  LibrarySourceView,
  SourceDiffView,
  SourceEntriesPage,
  SourceEntryView,
} from '../../shared/types';
import { localDate } from '../../domain/dates';
import { steamUrl } from '../../domain/links';
import { defaultPersonal, emptyMeta } from '../../domain/metadata';
import { foldText, titleKey } from '../../domain/normalize';
import { planStatusChange } from '../../domain/status-rules';
import {
  diffSnapshot,
  isUnplayed,
  nonGameReason,
  redactSteamId,
  type FetchedEntry,
} from '../../domain/steam';
import * as items from '../../db/repositories/items-repo';
import { insertProgressEvent } from '../../db/repositories/progress-repo';
import { b2i } from '../../db/connection';
import type { LibrarySource, FetchContext } from '../../library-sources/types';
import { manualSource, parseManualList } from '../../library-sources/manual';
import { privateError, type SteamConfig } from '../../library-sources/steam';
import type { ServiceContext } from './context';
import type { ImportBatchService } from './import-batch-service';
import type { LibraryService } from './library-service';
import type { ListsService } from './lists-service';
import type { SecretsService } from './secrets-service';

export const IMPORT_CHUNK = 200;
export const ENRICH_LIMIT = 25;

interface SourceRow {
  id: string;
  kind: 'steam' | 'manual';
  label: string;
  account_ref: string | null;
  account_input: string | null;
  last_synced_at: string | null;
  last_sync_status: LibrarySourceView['lastSyncStatus'];
}

interface EntryRow {
  external_id: string;
  name: string;
  platform: string | null;
  playtime_minutes: number | null;
  prev_playtime_minutes: number | null;
  last_played_at: string | null;
  non_game_reason: string | null;
  first_seen_at: string;
  removed_at: string | null;
  ignored: number;
  pile_id: string | null;
}

interface Job {
  view: FetchJobView;
  controller: AbortController;
}

export interface SourceDeps {
  steam: LibrarySource<SteamConfig>;
  manual?: LibrarySource<{ text: string }>;
  secrets: SecretsService;
  library: LibraryService;
  lists: ListsService;
  batches: ImportBatchService;
  /** Fills empty metadata from the configured provider (optional enrichment). */
  enrich?: (itemId: string) => Promise<{ ok: boolean; reason: string | null }>;
  sleep?: (ms: number) => Promise<void>;
}

export class LibrarySourceService {
  private readonly jobs = new Map<string, Job>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly d: SourceDeps,
  ) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get db() {
    return this.ctx.db();
  }
  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  private source(id: string): SourceRow {
    const r = this.db.get<SourceRow>('SELECT * FROM library_sources WHERE id = ?', [id]);
    if (!r) throw appError('NOT_FOUND', 'That library source no longer exists.');
    return r;
  }

  /* ---------------------------------------------------------------- configuration */

  list(): LibrarySourceView[] {
    const keySet = Boolean(this.d.secrets.keysFor('steam').apiKey);
    return this.db
      .all<SourceRow>('SELECT * FROM library_sources ORDER BY kind, label COLLATE NOCASE')
      .map((s) => {
        const rows = this.entryRows(s);
        const minFirst = rows.reduce<string | null>(
          (m, r) => (m === null || r.first_seen_at < m ? r.first_seen_at : m),
          null,
        );
        const impl = s.kind === 'steam' ? this.d.steam : (this.d.manual ?? manualSource);
        return {
          id: s.id,
          kind: s.kind,
          label: s.label,
          accountInput: s.account_input,
          accountHint: s.account_ref ? redactSteamId(s.account_ref) : null,
          keySet: s.kind === 'steam' ? keySet : false,
          lastSyncedAt: s.last_synced_at,
          lastSyncStatus: s.last_sync_status,
          counts: {
            total: rows.filter((r) => !r.removed_at).length,
            unplayed: rows.filter(
              (r) => !r.removed_at && !r.ignored && !r.pile_id && isUnplayed(r.playtime_minutes),
            ).length,
            inPile: rows.filter((r) => r.pile_id).length,
            ignored: rows.filter((r) => r.ignored).length,
            removed: rows.filter((r) => r.removed_at).length,
            newSinceSync: rows.filter((r) => !r.removed_at && minFirst !== null && r.first_seen_at > minFirst)
              .length,
          },
          attribution: impl.attribution,
          rateLimitText: impl.rateLimit.text,
        };
      });
  }

  saveSteam(input: {
    sourceId: string | null;
    label: string;
    account: string;
    apiKey: string;
  }): LibrarySourceView[] {
    const stored = this.d.secrets.keysFor('steam').apiKey ?? '';
    const key = input.apiKey !== '' ? input.apiKey : stored;
    const c = this.d.steam.configure({ apiKey: key, account: input.account });
    if (!c.ok) {
      const fe = { ...c.fieldErrors };
      throw appError('VALIDATION', 'Some Steam settings need attention.', { fieldErrors: fe });
    }
    if (input.apiKey !== '') this.d.secrets.set('steam', 'apiKey', input.apiKey);
    const acct = c.config.account;
    const ref = acct.kind === 'steamid' ? acct.steamId : null;
    if (input.sourceId) {
      const prev = this.source(input.sourceId);
      // Changing the account invalidates the resolved id (vanity names are resolved on next test/fetch).
      const changed = prev.account_input !== input.account;
      this.db.run('UPDATE library_sources SET label = ?, account_input = ?, account_ref = ? WHERE id = ?', [
        input.label,
        input.account,
        changed ? ref : (prev.account_ref ?? ref),
        input.sourceId,
      ]);
    } else {
      this.db.run(
        "INSERT INTO library_sources (id, kind, label, account_ref, account_input, created_at) VALUES (?, 'steam', ?, ?, ?, ?)",
        [randomUUID(), input.label, ref, input.account, this.now()],
      );
    }
    this.ctx.log.info('sources.steamSaved', { keyChanged: input.apiKey !== '' });
    return this.list();
  }

  clearSteamKey(): LibrarySourceView[] {
    this.d.secrets.set('steam', 'apiKey', '');
    return this.list();
  }

  remove(sourceId: string): LibrarySourceView[] {
    this.db.run('DELETE FROM library_sources WHERE id = ?', [sourceId]);
    return this.list();
  }

  private steamConfig(s: SourceRow): SteamConfig {
    const key = this.d.secrets.keysFor('steam').apiKey ?? '';
    const c = this.d.steam.configure({ apiKey: key, account: s.account_input ?? '' });
    if (!c.ok)
      throw appError('PROVIDER_NOT_CONFIGURED', 'Steam is not fully set up.', {
        recovery: 'Enter your Steam Web API key and account in the Steam settings.',
        fieldErrors: c.fieldErrors,
      });
    return c.config;
  }

  private fetchContext(
    signal: AbortSignal,
    onProgress: FetchContext['onProgress'] = () => undefined,
  ): FetchContext {
    return { signal, onProgress, sleep: this.sleep };
  }

  async testSteam(sourceId: string): Promise<{ message: string }> {
    const s = this.source(sourceId);
    const config = this.steamConfig(s);
    const r = await this.d.steam.testConnection(config, this.fetchContext(new AbortController().signal));
    if (!r.ok) throw appError(r.error.code, r.error.message, r.error);
    if (r.resolvedAccount)
      this.db.run('UPDATE library_sources SET account_ref = ? WHERE id = ?', [r.resolvedAccount, s.id]);
    return { message: r.message };
  }

  /* ---------------------------------------------------------------- fetching */

  startFetch(sourceId: string): FetchJobView {
    const s = this.source(sourceId);
    if (s.kind !== 'steam') throw appError('VALIDATION', 'Paste or choose a file to update a manual list.');
    for (const j of this.jobs.values())
      if (j.view.state === 'running' && j.view.jobId.startsWith(sourceId))
        throw appError('CONFLICT', 'A sync for this source is already running.');
    const config = this.steamConfig(s);
    const jobId = `${sourceId}:${randomUUID()}`;
    const controller = new AbortController();
    const job: Job = {
      controller,
      view: { jobId, state: 'running', phase: 'Starting…', progress: null, error: null, diff: null },
    };
    this.jobs.set(jobId, job);
    while (this.jobs.size > 20) {
      const k = this.jobs.keys().next().value;
      if (k === undefined) break;
      this.jobs.delete(k);
    }
    void this.runFetch(s, config, job).catch((e: unknown) => {
      this.ctx.log.error('sources.fetchCrashed', { error: e });
      job.view = {
        ...job.view,
        state: 'failed',
        error: {
          code: 'INTERNAL',
          message: 'The sync stopped unexpectedly. Your last snapshot is unchanged.',
        },
      };
    });
    return { ...job.view };
  }

  /** Exposed for tests: runs a fetch to completion. */
  async runFetch(s: SourceRow, config: SteamConfig, job: Job): Promise<void> {
    const ctx = this.fetchContext(job.controller.signal, (phase, progress) => {
      job.view = { ...job.view, phase, progress };
    });
    const r = await this.d.steam.fetchEntries(config, ctx);
    if (job.controller.signal.aborted) {
      this.db.run("UPDATE library_sources SET last_sync_status = 'cancelled' WHERE id = ?", [s.id]);
      job.view = { ...job.view, state: 'cancelled', phase: 'Cancelled. Your last snapshot is unchanged.' };
      return;
    }
    if (r.kind === 'error') {
      this.db.run("UPDATE library_sources SET last_sync_status = 'error' WHERE id = ?", [s.id]);
      job.view = {
        ...job.view,
        state: r.error.code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: r.error,
      };
      this.ctx.log.warn('sources.fetchFailed', { code: r.error.code });
      return;
    }
    if (r.kind === 'private') {
      this.db.run(
        "UPDATE library_sources SET last_sync_status = 'private', account_ref = COALESCE(?, account_ref) WHERE id = ?",
        [r.resolvedAccount, s.id],
      );
      job.view = { ...job.view, state: 'failed', error: privateError() };
      return;
    }
    const diff = this.reconcile(s.id, r.entries, r.entries.length === 0 ? 'empty' : 'ok', r.resolvedAccount);
    job.view = {
      ...job.view,
      state: 'done',
      phase: r.warnings.length ? r.warnings.join(' ') : 'Library loaded.',
      progress: 1,
      diff: {
        added: diff.added.length,
        playtimeChanged: diff.playtimeChanged.length,
        removed: diff.removed.length,
      },
    };
    this.ctx.log.info('sources.fetched', {
      count: r.entries.length,
      account: r.resolvedAccount ? redactSteamId(r.resolvedAccount) : null,
    });
  }

  fetchStatus(jobId: string): FetchJobView {
    const j = this.jobs.get(jobId);
    if (!j) throw appError('NOT_FOUND', 'That sync is no longer tracked.');
    return { ...j.view };
  }

  cancelFetch(jobId: string): FetchJobView {
    const j = this.jobs.get(jobId);
    if (!j) throw appError('NOT_FOUND', 'That sync is no longer tracked.');
    if (j.view.state === 'running') {
      j.controller.abort();
      j.view = { ...j.view, state: 'cancelled', phase: 'Cancelled. Your last snapshot is unchanged.' };
    }
    return { ...j.view };
  }

  /** Waits for a job (tests and the startup path). */
  async waitFor(jobId: string): Promise<FetchJobView> {
    for (let i = 0; i < 10_000; i++) {
      const v = this.fetchStatus(jobId);
      if (v.state !== 'running') return v;
      await new Promise((r) => setTimeout(r, 1));
    }
    return this.fetchStatus(jobId);
  }

  /** Creates/updates a manual list source from pasted text or a chosen file. */
  loadManual(input: { sourceId: string | null; label: string; text: string }): LibrarySourceView[] {
    const impl = this.d.manual ?? manualSource;
    const c = impl.configure({ text: input.text });
    if (!c.ok) throw appError('VALIDATION', 'Add at least one title.', { fieldErrors: c.fieldErrors });
    let id = input.sourceId;
    if (id) {
      if (this.source(id).kind !== 'manual')
        throw appError('VALIDATION', 'That source is not a manual list.');
      this.db.run('UPDATE library_sources SET label = ? WHERE id = ?', [input.label, id]);
    } else {
      id = randomUUID();
      this.db.run("INSERT INTO library_sources (id, kind, label, created_at) VALUES (?, 'manual', ?, ?)", [
        id,
        input.label,
        this.now(),
      ]);
    }
    const parsed = parseManualList(c.config.text);
    this.reconcile(id, parsed.entries, parsed.entries.length ? 'ok' : 'empty', null, {
      markMissingRemoved: false,
    });
    return this.list();
  }

  /**
   * Writes a fetched snapshot. New entries get `first_seen_at = now`; playtime
   * changes keep the previous value; entries missing from the fetch are marked
   * removed (never deleted). Returns the diff against the previous snapshot.
   */
  reconcile(
    sourceId: string,
    fetched: readonly FetchedEntry[],
    status: 'ok' | 'empty',
    resolvedAccount: string | null,
    opts: { markMissingRemoved?: boolean } = {},
  ) {
    const db = this.db;
    const now = this.now();
    const s = this.source(sourceId);
    const prev = db
      .all<{ external_id: string; name: string; playtime_minutes: number | null; removed_at: string | null }>(
        'SELECT external_id, name, playtime_minutes, removed_at FROM library_source_entries WHERE source_id = ?',
        [sourceId],
      )
      .map((p) => ({
        externalId: p.external_id,
        name: p.name,
        playtimeMinutes: p.playtime_minutes,
        removed: p.removed_at !== null,
      }));
    const diff = diffSnapshot(prev, fetched);
    db.transaction(() => {
      for (const e of fetched) {
        db.run(
          `INSERT INTO library_source_entries
             (source_id, external_id, name, platform, playtime_minutes, prev_playtime_minutes, last_played_at, non_game_reason, first_seen_at, seen_at, removed_at, ignored)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0)
           ON CONFLICT(source_id, external_id) DO UPDATE SET
             name = excluded.name,
             platform = excluded.platform,
             prev_playtime_minutes = library_source_entries.playtime_minutes,
             playtime_minutes = excluded.playtime_minutes,
             last_played_at = excluded.last_played_at,
             non_game_reason = excluded.non_game_reason,
             first_seen_at = CASE WHEN library_source_entries.removed_at IS NOT NULL THEN excluded.first_seen_at ELSE library_source_entries.first_seen_at END,
             seen_at = excluded.seen_at,
             removed_at = NULL`,
          [
            sourceId,
            e.externalId,
            e.name,
            e.platform,
            e.playtimeMinutes,
            e.lastPlayedAt,
            s.kind === 'steam' ? nonGameReason(e.name) : null,
            now,
            now,
          ],
        );
      }
      if (opts.markMissingRemoved !== false) {
        const seen = new Set(fetched.map((f) => f.externalId));
        for (const p of prev)
          if (!p.removed && !seen.has(p.externalId))
            db.run(
              'UPDATE library_source_entries SET removed_at = ? WHERE source_id = ? AND external_id = ?',
              [now, sourceId, p.externalId],
            );
      }
      // Link entries to existing pile items (Steam: by app id).
      if (s.kind === 'steam')
        db.run(
          `UPDATE library_source_entries SET item_id = (
             SELECT x.item_id FROM external_ids x JOIN items i ON i.id = x.item_id
             WHERE x.kind = 'steam' AND x.value = library_source_entries.external_id AND i.deleted_at IS NULL LIMIT 1)
           WHERE source_id = ? AND item_id IS NULL`,
          [sourceId],
        );
      db.run(
        'UPDATE library_sources SET last_synced_at = ?, last_sync_status = ?, account_ref = COALESCE(?, account_ref) WHERE id = ?',
        [now, status, resolvedAccount, sourceId],
      );
    });
    return diff;
  }

  /* ---------------------------------------------------------------- review list */

  private entryRows(s: SourceRow): EntryRow[] {
    return this.db.all<EntryRow>(
      `SELECT e.external_id, e.name, e.platform, e.playtime_minutes, e.prev_playtime_minutes, e.last_played_at,
              e.non_game_reason, e.first_seen_at, e.removed_at, e.ignored,
              COALESCE(
                (SELECT i.id FROM items i WHERE i.id = e.item_id AND i.deleted_at IS NULL),
                CASE WHEN ? = 'steam' THEN (SELECT x.item_id FROM external_ids x JOIN items i ON i.id = x.item_id
                   WHERE x.kind = 'steam' AND x.value = e.external_id AND i.deleted_at IS NULL LIMIT 1) END
              ) AS pile_id
       FROM library_source_entries e WHERE e.source_id = ?`,
      [s.kind, s.id],
    );
  }

  private toView(
    s: SourceRow,
    r: EntryRow,
    minFirst: string | null,
    dupes: Map<string, { id: string; title: string }>,
  ): SourceEntryView {
    return {
      externalId: r.external_id,
      name: r.name,
      platform: r.platform,
      playtimeMinutes: r.playtime_minutes,
      prevPlaytimeMinutes: r.prev_playtime_minutes,
      lastPlayedAt: r.last_played_at,
      nonGameReason: r.non_game_reason,
      ignored: r.ignored === 1,
      removed: r.removed_at !== null,
      isNew: minFirst !== null && r.first_seen_at > minFirst,
      itemId: r.pile_id,
      possibleDuplicateOf: r.pile_id ? null : (dupes.get(titleKey(r.name)) ?? null),
      storeUrl: s.kind === 'steam' ? steamUrl(r.external_id) : null,
    };
  }

  entries(f: SourceEntryFilter): SourceEntriesPage {
    const s = this.source(f.sourceId);
    const rows = this.entryRows(s);
    const minFirst = rows.reduce<string | null>(
      (m, r) => (m === null || r.first_seen_at < m ? r.first_seen_at : m),
      null,
    );
    const dupes = new Map<string, { id: string; title: string }>();
    for (const g of this.db.all<{ id: string; title: string; title_key: string }>(
      "SELECT id, title, title_key FROM items WHERE type = 'game' AND deleted_at IS NULL",
    ))
      if (!dupes.has(g.title_key)) dupes.set(g.title_key, { id: g.id, title: g.title });
    const q = foldText(f.search);
    const views = rows.map((r) => this.toView(s, r, minFirst, dupes));
    const keep = views.filter((v) => {
      if (q && !foldText(v.name).includes(q)) return false;
      if (!f.showNonGames && v.nonGameReason && f.view !== 'ignored' && f.view !== 'inPile') return false;
      switch (f.view) {
        case 'unplayed':
          return !v.ignored && !v.removed && !v.itemId && isUnplayed(v.playtimeMinutes);
        case 'played':
          return !v.ignored && !v.removed && (v.playtimeMinutes ?? 0) > 0;
        case 'all':
          return !v.ignored && !v.removed;
        case 'inPile':
          return v.itemId !== null;
        case 'ignored':
          return v.ignored;
        case 'new':
          return v.isNew && !v.removed;
        case 'removed':
          return v.removed;
      }
      return true;
    });
    const dir = f.direction === 'asc' ? 1 : -1;
    const cmpName = (a: SourceEntryView, b: SourceEntryView) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    keep.sort((a, b) => {
      let c = 0;
      if (f.sort === 'name') c = cmpName(a, b);
      else if (f.sort === 'playtime') c = (a.playtimeMinutes ?? 0) - (b.playtimeMinutes ?? 0);
      else if (f.sort === 'lastPlayed') c = (a.lastPlayedAt ?? '').localeCompare(b.lastPlayedAt ?? '');
      else
        c =
          (Number(a.externalId) || 0) - (Number(b.externalId) || 0) ||
          a.externalId.localeCompare(b.externalId);
      return c * dir || cmpName(a, b) || a.externalId.localeCompare(b.externalId);
    });
    return { total: keep.length, rows: keep };
  }

  setIgnored(sourceId: string, externalIds: readonly string[], ignored: boolean): number {
    this.source(sourceId);
    let n = 0;
    this.db.transaction(() => {
      for (const id of externalIds)
        n += this.db.run(
          'UPDATE library_source_entries SET ignored = ? WHERE source_id = ? AND external_id = ?',
          [b2i(ignored), sourceId, id],
        ).changes;
    });
    return n;
  }

  /* ---------------------------------------------------------------- import */

  async importSelected(
    input: SourceImportInput,
    opts: { failInChunk?: number } = {},
  ): Promise<BatchImportResultView> {
    const s = this.source(input.sourceId);
    const rows = new Map(this.entryRows(s).map((r) => [r.external_id, r]));
    if (input.listId && !this.db.get('SELECT 1 FROM lists WHERE id = ?', [input.listId]))
      throw appError('VALIDATION', 'That list no longer exists.', {
        fieldErrors: { listId: 'Choose another list.' },
      });
    const result: BatchImportResultView = {
      batchId: null,
      added: 0,
      skippedDuplicates: [],
      failed: [],
      enrichment: null,
    };
    const todo: EntryRow[] = [];
    for (const id of new Set(input.externalIds)) {
      const r = rows.get(id);
      if (!r) result.failed.push({ externalId: id, title: id, reason: 'Not in the current snapshot.' });
      else if (r.pile_id)
        result.skippedDuplicates.push({ externalId: id, title: r.name, existingId: r.pile_id });
      else if (r.removed_at)
        result.failed.push({ externalId: id, title: r.name, reason: 'No longer in this library.' });
      else todo.push(r);
    }
    if (todo.length === 0) return result;
    const today = localDate(this.ctx.clock.now());
    const label = `${s.kind === 'steam' ? 'Steam' : s.label}: ${todo.length} game(s)`;
    const batchId = this.d.batches.begin(s.kind === 'steam' ? 'steam' : 'manual-list', label, s.id);
    result.batchId = batchId;
    const added: string[] = [];
    for (let c = 0; c * IMPORT_CHUNK < todo.length; c++) {
      const chunk = todo.slice(c * IMPORT_CHUNK, (c + 1) * IMPORT_CHUNK);
      try {
        const ids = this.db.transaction(() => {
          const out: string[] = [];
          chunk.forEach((r, i) => {
            if (opts.failInChunk === c && i === Math.floor(chunk.length / 2))
              throw new Error('Injected import failure');
            out.push(this.createGame(s, r, input, today));
          });
          for (const id of out) {
            if (input.listId) this.d.lists.setMembership(input.listId, [id], true);
            this.d.batches.record(batchId, id);
          }
          return out;
        });
        added.push(...ids);
      } catch (e) {
        this.ctx.log.warn('sources.importChunkFailed', { chunk: c, error: e });
        const reason =
          e instanceof Error && 'safe' in e
            ? (e as { safe: UserSafeError }).safe.message
            : 'Could not be saved; nothing from this group was added.';
        for (const r of chunk) result.failed.push({ externalId: r.external_id, title: r.name, reason });
      }
    }
    result.added = added.length;
    if (added.length === 0) {
      this.d.batches.discardIfEmpty(batchId);
      result.batchId = null;
    }
    if (input.enrich && this.d.enrich && added.length > 0) {
      let enriched = 0;
      const subset = added.slice(0, ENRICH_LIMIT);
      for (const id of subset) {
        const r = await this.d.enrich(id).catch(() => ({ ok: false, reason: null }));
        if (r.ok) {
          enriched++;
          // Enrichment isn't a user edit: refresh the undo baseline.
          this.d.batches.record(batchId, id);
        }
      }
      result.enrichment = {
        attempted: subset.length,
        enriched,
        note:
          added.length > ENRICH_LIMIT
            ? `Only the first ${ENRICH_LIMIT} were looked up to respect provider rate limits. Use “Refresh details” on an item for the rest.`
            : null,
      };
    }
    this.ctx.log.info('sources.imported', {
      added: result.added,
      skipped: result.skippedDuplicates.length,
      failed: result.failed.length,
    });
    return result;
  }

  /** Creates one game item through the same validated service path as manual adds. */
  private createGame(s: SourceRow, r: EntryRow, input: SourceImportInput, today: string): string {
    const lib = this.d.library;
    const meta = {
      ...emptyMeta(r.name),
      externalIds: s.kind === 'steam' ? [{ kind: 'steam' as const, value: r.external_id }] : [],
    };
    const withPlaytime = input.importPlaytime && (r.playtime_minutes ?? 0) > 0;
    const plan = planStatusChange(
      { type: 'game', status: 'planned', dateStarted: null, dateCompleted: null, pass: 1 },
      { status: input.status as Status, startNewPass: false, clearDateCompleted: false },
      today,
    );
    const personal = lib.validatePersonal('game', {
      ...defaultPersonal('game', today),
      status: input.status,
      dateStarted: plan.dateStarted,
      dateCompleted: plan.dateCompleted,
      tags: input.tags,
      gameScheme: withPlaytime ? 'hours' : 'percent',
      platforms: r.platform ? [{ name: r.platform, owned: true, played: (r.playtime_minutes ?? 0) > 0 }] : [],
    });
    lib.validateMeta('game', meta);
    const id = items.newId();
    const now = this.now();
    lib.insertItem(
      id,
      'game',
      meta,
      personal,
      [],
      [],
      s.kind === 'steam'
        ? {
            kind: 'provider',
            providerId: 'steam',
            providerRef: r.external_id,
            providerUrl: steamUrl(r.external_id),
          }
        : { kind: 'manual' },
      now,
    );
    if (withPlaytime) {
      insertProgressEvent(this.db, {
        itemId: id,
        kind: 'hours',
        value: Math.round(((r.playtime_minutes ?? 0) / 60) * 10) / 10,
        text: null,
        totalAtTime: null,
        milestoneId: null,
        milestoneTitle: null,
        episodeId: null,
        episodeLabel: null,
        watched: null,
        scheme: 'hours',
        pass: 1,
        occurredAt: r.last_played_at ?? now,
        recordedAt: now,
        note: 'Imported from Steam playtime',
      });
      items.recomputeProgress(this.db, id);
    }
    this.db.run('UPDATE library_source_entries SET item_id = ? WHERE source_id = ? AND external_id = ?', [
      id,
      s.id,
      r.external_id,
    ]);
    return id;
  }

  /* ---------------------------------------------------------------- re-sync */

  diff(sourceId: string): SourceDiffView {
    const s = this.source(sourceId);
    const rows = this.entryRows(s);
    const minFirst = rows.reduce<string | null>(
      (m, r) => (m === null || r.first_seen_at < m ? r.first_seen_at : m),
      null,
    );
    const hours = (itemId: string | null): number | null => {
      if (!itemId) return null;
      return (
        this.db.get<{ v: number | null }>(
          `SELECT value AS v FROM progress_events WHERE item_id = ? AND kind = 'hours' AND deleted_at IS NULL
           ORDER BY COALESCE(occurred_at, recorded_at) DESC, seq DESC LIMIT 1`,
          [itemId],
        )?.v ?? null
      );
    };
    return {
      added: rows
        .filter((r) => !r.removed_at && minFirst !== null && r.first_seen_at > minFirst)
        .map((r) => ({ externalId: r.external_id, name: r.name })),
      playtimeChanged: rows
        .filter(
          (r) =>
            !r.removed_at &&
            r.prev_playtime_minutes !== null &&
            r.prev_playtime_minutes !== r.playtime_minutes,
        )
        .map((r) => ({
          externalId: r.external_id,
          name: r.name,
          before: r.prev_playtime_minutes,
          after: r.playtime_minutes,
          itemId: r.pile_id,
          pileHours: hours(r.pile_id),
        })),
      removed: rows
        .filter((r) => r.removed_at)
        .map((r) => ({ externalId: r.external_id, name: r.name, itemId: r.pile_id })),
    };
  }

  /**
   * Opt-in: records Steam playtime as a new hours entry for pile items. History
   * is never rewritten; switching a game to the hours scheme keeps old entries.
   */
  applyPlaytime(sourceId: string, externalIds: readonly string[]): number {
    const s = this.source(sourceId);
    const rows = new Map(this.entryRows(s).map((r) => [r.external_id, r]));
    const now = this.now();
    let n = 0;
    this.db.transaction(() => {
      for (const id of externalIds) {
        const r = rows.get(id);
        if (!r?.pile_id || r.playtime_minutes === null) continue;
        const row = items.getItemRow(this.db, r.pile_id);
        if (row?.type !== 'game') continue;
        this.db.run("UPDATE game_details SET progress_scheme = 'hours' WHERE item_id = ?", [r.pile_id]);
        insertProgressEvent(this.db, {
          itemId: r.pile_id,
          kind: 'hours',
          value: Math.round((r.playtime_minutes / 60) * 10) / 10,
          text: null,
          totalAtTime: null,
          milestoneId: null,
          milestoneTitle: null,
          episodeId: null,
          episodeLabel: null,
          watched: null,
          scheme: 'hours',
          pass: row.pass,
          occurredAt: r.last_played_at ?? now,
          recordedAt: now,
          note: 'Updated from Steam playtime',
        });
        items.touch(this.db, r.pile_id, now);
        items.recomputeProgress(this.db, r.pile_id);
        n++;
      }
    });
    return n;
  }
}

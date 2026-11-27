/**
 * Headless reminder helper core (scheduled mode). Electron-free.
 *
 * Contract (docs/notifications.md, "The helper"):
 * - never creates a window or renderer; no network of any kind;
 * - opens each library database READ-ONLY and only if its schema version is
 *   exactly the one this build understands (never migrates);
 * - writes only notify-state.sqlite (claims, history, lease);
 * - one check at a time (lease), hard timeout, quick exit.
 *
 * Exit codes: 0 done (including "nothing to do"), 2 bad arguments,
 * 3 nothing checked because of a schema mismatch, 4 state DB unavailable,
 * 5 timed out, 1 unexpected error.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Db } from '../db/connection';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/migrate';
import { readSettings } from '../db/repositories/config-repo';
import { listLibraries } from '../main/services/library-registry';
import type { Logger } from '../main/services/logger';
import type { Notifier } from './adapters/types';
import { plan } from './engine/engine';
import { resolveTimeZone } from './engine/time';
import { runCheck } from './runner';
import { buildSnapshot } from './snapshot';
import { NotifyState } from './state/notify-state';

export const EXIT = {
  ok: 0,
  unexpected: 1,
  badArgs: 2,
  schemaMismatch: 3,
  stateUnavailable: 4,
  timeout: 5,
} as const;
export const HELPER_TIMEOUT_MS = 20_000;
export const STATE_FILE = 'notify-state.sqlite';

export interface HelperOptions {
  dataDir: string;
  notifier: Notifier;
  log: Logger;
  now?: () => Date;
  timeoutMs?: number;
  osTimeZone?: string;
  /** Only act for libraries whose mode asks for the scheduled helper (default true). */
  requireScheduledMode?: boolean;
  /** Plan + report, but show nothing and claim nothing (`--dry-run`). */
  dryRun?: boolean;
}

export interface HelperResult {
  code: number;
  delivered: number;
  checkedLibraries: number;
  reason: string | null;
}

/** Strict argument parsing: only known flags, one absolute data dir without control characters. */
export function parseHelperArgs(argv: readonly string[]): { dataDir: string | null; dryRun: boolean } | null {
  let dataDir: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--reminder-check') continue;
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--data-dir') {
      const v = argv[++i];
      // eslint-disable-next-line no-control-regex
      if (!v || !isAbsolute(v) || /[\u0000-\u001F"]/.test(v) || v.length > 1000) return null;
      dataDir = v;
      continue;
    }
    return null;
  }
  return { dataDir, dryRun };
}

export async function runHelper(opts: HelperOptions): Promise<HelperResult> {
  const timeoutMs = opts.timeoutMs ?? HELPER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HelperResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ code: EXIT.timeout, delivered: 0, checkedLibraries: 0, reason: 'timeout' }),
      timeoutMs,
    );
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const r = await Promise.race([runHelperInner(opts), timeout]);
    if (r.code === EXIT.timeout) opts.log.warn('helper.timeout', { timeoutMs });
    return r;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runHelperInner(opts: HelperOptions): Promise<HelperResult> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const { dataDir, log } = opts;
  if (!isAbsolute(dataDir) || !existsSync(dataDir)) {
    log.warn('helper.badDataDir');
    return { code: EXIT.badArgs, delivered: 0, checkedLibraries: 0, reason: 'bad data dir' };
  }
  let state: NotifyState;
  try {
    state = NotifyState.open(join(dataDir, STATE_FILE));
  } catch (e) {
    log.error('helper.stateUnavailable', { error: e });
    return { code: EXIT.stateUnavailable, delivered: 0, checkedLibraries: 0, reason: 'state unavailable' };
  }
  const holder = `helper:${process.pid}:${started.getTime()}`;
  try {
    if (!opts.dryRun && !state.acquireLease(holder, 60_000, started)) {
      log.info('helper.busy');
      return { code: EXIT.ok, delivered: 0, checkedLibraries: 0, reason: 'another check is running' };
    }
    const libs = listLibraries(dataDir).filter((l) => existsSync(join(l.dir, 'library.sqlite')));
    const opened: { id: string; name: string; db: Db }[] = [];
    let mismatch = 0;
    for (const l of libs) {
      let db: Db | null = null;
      try {
        db = new Db(join(l.dir, 'library.sqlite'), { readOnly: true });
        const v = currentSchemaVersion(db);
        if (v !== LATEST_SCHEMA_VERSION) {
          log.info('helper.schemaMismatch', { library: l.id, found: v, expected: LATEST_SCHEMA_VERSION });
          mismatch++;
          db.close();
          continue;
        }
        const ns = readSettings(db).settings.notifications;
        const wantsHelper = ns.mode === 'scheduled' || (ns.mode === 'tray' && ns.alsoScheduled);
        if (opts.requireScheduledMode !== false && !wantsHelper) {
          db.close();
          continue;
        }
        opened.push({ id: l.id, name: l.name, db });
      } catch (e) {
        log.warn('helper.libraryOpenFailed', { library: l.id, error: e });
        db?.close();
      }
    }
    if (opened.length === 0) {
      return {
        code: mismatch > 0 ? EXIT.schemaMismatch : EXIT.ok,
        delivered: 0,
        checkedLibraries: 0,
        reason: mismatch > 0 ? 'schema mismatch' : 'no library uses scheduled reminders',
      };
    }
    let delivered = 0;
    try {
      for (const o of opened) {
        if (opts.dryRun) {
          const settings = readSettings(o.db).settings;
          const tz = resolveTimeZone(settings.notifications.timeZone, opts.osTimeZone);
          const p = plan({
            now: now(),
            timeZone: tz,
            settings: settings.notifications,
            snapshot: buildSnapshot(o.db, { now: now(), timeZone: tz, settings }),
            state: state.view(o.id, now()),
          });
          log.info('helper.dryRun', { library: o.id, wouldDeliver: p.deliver.length, deferred: p.deferred });
          continue;
        }
        const r = await runCheck({
          libraryDb: o.db,
          state,
          notifier: opts.notifier,
          now,
          mode: 'helper',
          libraryId: o.id,
          libraryLabel: opened.length > 1 ? o.name : null,
          log,
          ...(opts.osTimeZone ? { osTimeZone: opts.osTimeZone } : {}),
        });
        delivered += r.delivered;
      }
      const firstDb = opened[0]?.db;
      if (firstDb) state.prune(now(), readSettings(firstDb).settings.notifications.historyDays);
    } finally {
      for (const o of opened) o.db.close();
    }
    log.info('helper.done', { libraries: opened.length, delivered, ms: now().getTime() - started.getTime() });
    return { code: EXIT.ok, delivered, checkedLibraries: opened.length, reason: null };
  } catch (e) {
    log.error('helper.unexpected', { error: e });
    return { code: EXIT.unexpected, delivered: 0, checkedLibraries: 0, reason: 'unexpected' };
  } finally {
    if (!opts.dryRun) state.releaseLease(holder);
    state.close();
  }
}

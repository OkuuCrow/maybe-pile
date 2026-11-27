/**
 * One reminder check: snapshot → plan → claim → deliver → record.
 * Shared by every mode (in-app, resident tray, scheduled helper), so all of
 * them obey the same rules and the same exactly-once claims.
 */
import type { Db } from '../db/connection';
import { readSettings } from '../db/repositories/config-repo';
import type { AppSettings } from '../shared/schemas';
import type { Logger } from '../main/services/logger';
import type { Notifier } from './adapters/types';
import { plan } from './engine/engine';
import { resolveTimeZone } from './engine/time';
import type { EnginePlan, PlannedNotification } from './engine/types';
import { buildSnapshot } from './snapshot';
import type { NotifyState } from './state/notify-state';

export type RunMode = 'open' | 'resident' | 'helper' | 'test';

export interface RunDeps {
  libraryDb: Db;
  state: NotifyState;
  notifier: Notifier;
  /** Used when the primary notifier reports unsupported/failed (in-app banner while the app is open). */
  fallback?: Notifier | null;
  now: () => Date;
  mode: RunMode;
  libraryId: string;
  libraryLabel?: string | null;
  log: Logger;
  settings?: AppSettings;
  osTimeZone?: string;
}

export interface RunReport {
  skipped: 'off' | 'paused' | null;
  delivered: number;
  failed: number;
  lostRace: number;
  recorded: number;
  deferred: number;
  adapters: string[];
  plan: EnginePlan | null;
}

export function lastCheckKey(libraryId: string): string {
  return `last_check:${libraryId}`;
}

export async function runCheck(d: RunDeps): Promise<RunReport> {
  const now = d.now();
  const settings = d.settings ?? readSettings(d.libraryDb).settings;
  const ns = settings.notifications;
  const report: RunReport = {
    skipped: null,
    delivered: 0,
    failed: 0,
    lostRace: 0,
    recorded: 0,
    deferred: 0,
    adapters: [],
    plan: null,
  };
  if (ns.mode === 'off') return { ...report, skipped: 'off' };
  const tz = resolveTimeZone(ns.timeZone, d.osTimeZone);
  const snapshot = buildSnapshot(d.libraryDb, {
    now,
    timeZone: tz,
    libraryLabel: d.libraryLabel ?? null,
    settings,
  });
  const p = plan({ now, timeZone: tz, settings: ns, snapshot, state: d.state.view(d.libraryId, now) });
  report.plan = p;
  report.deferred = p.deferred;
  if (p.paused) return { ...report, skipped: 'paused' };
  report.recorded = d.state.recordSuppressed(d.libraryId, p.record, { mode: d.mode, now });
  for (const n of p.deliver) {
    if (!d.state.claim(d.libraryId, n, { mode: d.mode, now })) {
      report.lostRace++;
      continue;
    }
    const used = await deliver(d, n, ns.sound);
    if (used) {
      d.state.markDelivered(d.libraryId, n.key, used, d.now());
      report.delivered++;
      report.adapters.push(used);
    } else {
      report.failed++;
    }
  }
  d.state.setMeta(lastCheckKey(d.libraryId), now.toISOString());
  d.log.info('notify.check', {
    mode: d.mode,
    delivered: report.delivered,
    failed: report.failed,
    lostRace: report.lostRace,
    recorded: report.recorded,
    deferred: report.deferred,
  });
  return report;
}

async function deliver(d: RunDeps, n: PlannedNotification, sound: boolean): Promise<string | null> {
  const r = await d.notifier.show(n, { sound });
  if (r.status === 'delivered') return d.notifier.id;
  if (d.fallback) {
    const f = await d.fallback.show(n, { sound });
    if (f.status === 'delivered') return d.fallback.id;
  }
  d.state.markFailed(d.libraryId, n.key, r.reason, d.notifier.id, d.now(), r.status === 'unsupported');
  d.log.warn('notify.deliveryFailed', {
    adapter: d.notifier.id,
    status: r.status,
    reason: r.reason,
    category: n.category,
  });
  return null;
}

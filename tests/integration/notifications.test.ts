import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/db/connection';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../../src/db/migrate';
import { readSettings, writeSettings } from '../../src/db/repositories/config-repo';
import { createRecordingNotifier } from '../../src/notifications/adapters/linux';
import type { Notifier } from '../../src/notifications/adapters/types';
import { plan } from '../../src/notifications/engine/engine';
import type { PlannedNotification } from '../../src/notifications/engine/types';
import { EXIT, runHelper } from '../../src/notifications/helper';
import { runCheck } from '../../src/notifications/runner';
import { buildSnapshot } from '../../src/notifications/snapshot';
import { MAX_ATTEMPTS, NotifyState } from '../../src/notifications/state/notify-state';
import { MemoryLogger } from '../../src/main/services/logger';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from '../../src/shared/notification-settings';
import { tempDir } from '../helpers/db';
import { addItem, makeEnv, type TestEnv } from '../helpers/services';
import { settingsWith, UUIDS } from '../helpers/notify';

const TZ = 'Europe/Berlin';

function single(key: string, over: Partial<PlannedNotification> = {}): PlannedNotification {
  return {
    key,
    category: 'custom',
    kind: 'single',
    title: 't',
    body: 'b',
    itemId: null,
    urgency: 'low',
    scheduledFor: '2026-11-26T17:00:00.000Z',
    actions: [],
    memberKeys: [key],
    members: [{ key, category: 'custom', itemId: null, scheduledFor: '2026-11-26T17:00:00.000Z' }],
    openUrl: 'maybepile://open',
    ...over,
  };
}

describe('migration v7', () => {
  it('upgrades a v6 library with data: new tables, Full interface for existing users, FK clean', () => {
    const t = tempDir();
    const db = new Db(join(t.dir, 'library.sqlite'));
    try {
      migrate(db, { migrations: MIGRATIONS.slice(0, 6) });
      const now = '2026-01-02T03:04:05.000Z';
      db.run(
        `INSERT INTO items (id, type, title, sort_title, title_key, status, date_added, created_at, updated_at)
         VALUES (?, 'tv', 'Severance', 'severance', 'severance', 'in_progress', '2026-01-02', ?, ?)`,
        [UUIDS[0], now, now],
      );
      db.run("INSERT INTO seasons (id, item_id, season_number) VALUES ('s1', ?, 1)", [UUIDS[0]]);
      db.run(
        "INSERT INTO episodes (id, season_id, item_id, episode_number, watched) VALUES ('e1', 's1', ?, 1, 1)",
        [UUIDS[0]],
      );
      db.run("INSERT INTO item_prefs (item_id, spoiler_mode) VALUES (?, 'shield')", [UUIDS[0]]);
      const r = migrate(db);
      expect(r).toMatchObject({ from: 6, to: LATEST_SCHEMA_VERSION, applied: [7] });
      for (const tbl of [
        'reminders',
        'loans',
        'people',
        'checklists',
        'checklist_items',
        'saved_views',
        'item_templates',
        'journal_entries',
        'change_log',
        'lookup_queue',
        'time_goals',
        'item_flags',
        'artwork_palettes',
        'app_events',
        'item_next_steps',
        'item_recommenders',
      ])
        expect(db.get('SELECT 1 AS x FROM sqlite_master WHERE name = ?', [tbl]), tbl).toBeDefined();
      expect(db.get<{ skipped: number }>('SELECT skipped FROM episodes')?.skipped).toBe(0);
      expect(
        db.get<{ backdrop_style: string }>('SELECT backdrop_style FROM item_prefs')?.backdrop_style,
      ).toBe('default');
      expect(readSettings(db).settings.interface.level).toBe('full');
      expect(readSettings(db).settings.interface.simpleOfferDismissed).toBe(false);
      expect(readSettings(db).settings.notifications.mode).toBe('off');
      expect(db.foreignKeyViolations()).toBe(0);
      expect(db.integrityCheck()).toEqual([]);
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it('a brand-new library starts in Simple Mode with everything off', () => {
    const t = tempDir();
    const db = new Db(join(t.dir, 'library.sqlite'));
    try {
      migrate(db);
      const s = readSettings(db).settings;
      expect(s.interface.level).toBe('simple');
      expect(s.interface.firstRunDone).toBe(false);
      expect(s.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
      expect(Object.values(s.notifications.categories).every((c) => !c.enabled)).toBe(true);
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it('rolls back an injected v7 failure, leaving v6 intact', () => {
    const t = tempDir();
    const db = new Db(join(t.dir, 'library.sqlite'));
    try {
      migrate(db, { migrations: MIGRATIONS.slice(0, 6) });
      expect(() => migrate(db, { failAtVersion: 7 })).toThrow(/Injected/);
      expect(currentSchemaVersion(db)).toBe(6);
      expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'reminders'")).toBeUndefined();
      expect(db.get("SELECT 1 AS x FROM settings WHERE key = 'interface'")).toBeUndefined();
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it('settings added later merge over defaults instead of resetting the user choice', () => {
    const t = tempDir();
    const db = new Db(join(t.dir, 'library.sqlite'));
    try {
      migrate(db);
      db.run('INSERT INTO settings (key, value) VALUES (\'backdrops\', \'{"style":"off"}\')');
      expect(readSettings(db).settings.backdrops).toMatchObject({ style: 'off', intensity: 60 });
      db.run('UPDATE settings SET value = \'{"style":"nonsense"}\' WHERE key = \'backdrops\'');
      const r = readSettings(db);
      expect(r.invalidKeys).toContain('backdrops');
      expect(r.settings.backdrops.style).toBe('ambient');
    } finally {
      db.close();
      t.cleanup();
    }
  });
});

describe('notify-state.sqlite', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => (t = tempDir()));
  afterEach(() => t.cleanup());

  it('exactly-once: three handles (in-app, resident, helper) racing for the same keys', () => {
    const file = join(t.dir, 'notify-state.sqlite');
    const handles = [NotifyState.open(file), NotifyState.open(file), NotifyState.open(file)];
    try {
      const now = new Date('2026-11-26T17:00:00Z');
      const n = single('custom:a');
      const wins = handles.map((h, i) =>
        h.claim('default', n, { mode: ['open', 'resident', 'helper'][i]!, now }),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      // A digest overlapping an already-claimed member is abandoned entirely (claims nothing).
      const digest = {
        ...single('digest:x'),
        kind: 'digest' as const,
        memberKeys: ['digest:x', 'custom:a', 'custom:b'],
      };
      expect(handles[1]!.claim('default', digest, { mode: 'resident', now })).toBe(false);
      expect(handles[2]!.isClaimed('default', 'custom:b', now)).toBe(false);
      // Libraries are isolated.
      expect(handles[0]!.claim('family', n, { mode: 'helper', now })).toBe(true);
    } finally {
      for (const h of handles) h.close();
    }
  });

  it('failed deliveries retry with backoff, at most MAX_ATTEMPTS', () => {
    const s = NotifyState.open(join(t.dir, 's.sqlite'));
    try {
      let now = new Date('2026-11-26T17:00:00Z');
      const n = single('custom:r');
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        expect(s.claim('default', n, { mode: 'helper', now })).toBe(true);
        s.markFailed('default', n.key, 'daemon missing', 'linux-dbus', now);
        // Held until the backoff expires; afterwards retryable unless attempts are exhausted.
        expect(s.isClaimed('default', n.key, now)).toBe(true);
        now = new Date(now.getTime() + 3 * 3_600_000);
        expect(s.isClaimed('default', n.key, now)).toBe(attempt >= MAX_ATTEMPTS);
      }
      expect(s.claim('default', n, { mode: 'helper', now })).toBe(false);
      const h = s.history('default', 30, now);
      expect(h[0]).toMatchObject({ outcome: 'failed', reason: 'daemon missing' });
    } finally {
      s.close();
    }
  });

  it('records suppressions once, prunes by retention, pauses globally, leases one check at a time', () => {
    const s = NotifyState.open(join(t.dir, 's.sqlite'));
    try {
      const now = new Date('2026-11-26T17:00:00Z');
      const rec = {
        key: 'k1',
        category: 'releases' as const,
        itemId: null,
        scheduledFor: now.toISOString(),
        reason: 'capped' as const,
      };
      expect(s.recordSuppressed('default', [rec, rec], { mode: 'open', now })).toBe(1);
      expect(s.prune(new Date('2027-06-01T00:00:00Z'), 90)).toBe(1);
      s.pause(new Date('2026-11-26T18:00:00Z'));
      expect(s.view('default', now).snoozedUntil('global', '*')?.toISOString()).toBe(
        '2026-11-26T18:00:00.000Z',
      );
      expect(s.pausedUntil(new Date('2026-11-26T19:00:00Z'))).toBeNull();
      expect(s.acquireLease('a', 60_000, now)).toBe(true);
      expect(s.acquireLease('b', 60_000, now)).toBe(false);
      expect(s.acquireLease('b', 60_000, new Date(now.getTime() + 61_000))).toBe(true);
      s.releaseLease('b');
      expect(s.acquireLease('c', 60_000, now)).toBe(true);
    } finally {
      s.close();
    }
  });

  it('a corrupt state file fails to open (callers degrade to "off") and migrations are versioned', () => {
    const bad = join(t.dir, 'bad.sqlite');
    writeFileSync(bad, 'this is not a database'.repeat(100));
    expect(() => NotifyState.open(bad)).toThrow();
    const ok = NotifyState.open(join(t.dir, 'ok.sqlite'));
    expect(ok.db.get<{ v: number }>('SELECT max(version) AS v FROM state_migrations')?.v).toBe(1);
    ok.close();
    const again = NotifyState.open(join(t.dir, 'ok.sqlite'));
    expect(again.db.all('SELECT * FROM state_migrations')).toHaveLength(1);
    again.close();
  });
});

/* ------------------------------------------------------------------ snapshot + runner + helper over a real library */

function enableScheduled(env: TestEnv, over: Partial<NotificationSettings> = {}) {
  const s = settingsWith(['keepGoing', 'custom', 'upNext'], { mode: 'scheduled', timeZone: TZ, ...over });
  s.categories.keepGoing = { ...s.categories.keepGoing, time: '18:00' };
  s.categories.upNext = { ...s.categories.upNext, frequency: 'daily', time: '18:00' };
  writeSettings(env.db, { notifications: s });
  return s;
}

describe('snapshot, runner and helper on a real library', () => {
  let env: TestEnv;
  const NOW = new Date('2026-11-26T17:10:00Z');
  beforeEach(() => {
    env = makeEnv();
    env.clock.current = new Date('2026-10-01T10:00:00Z');
  });
  afterEach(() => env.cleanup());

  function seed() {
    const frieren = addItem(env, 'tv', 'Frieren', { personal: { status: 'in_progress' } });
    const gone = addItem(env, 'tv', 'Deleted Show', { personal: { status: 'in_progress' } });
    env.library.softDelete([gone.id]);
    const dune = addItem(env, 'book', 'Dune');
    env.library.setUpNext(dune.id, true);
    return { frieren, dune };
  }

  it('builds a read-only snapshot that excludes Recently deleted items', () => {
    seed();
    const ro = new Db(env.ctx.paths.database, { readOnly: true });
    try {
      const snap = buildSnapshot(ro, { now: NOW, timeZone: TZ });
      expect(snap.inProgress.map((i) => i.title)).toEqual(['Frieren']);
      expect(snap.upNext.map((i) => i.title)).toEqual(['Dune']);
      expect(() => ro.run("UPDATE items SET title = 'x'")).toThrow(/readonly|read-only/i);
    } finally {
      ro.close();
    }
  });

  it('runner: delivers once; resident + helper running together never duplicate', async () => {
    seed();
    enableScheduled(env);
    const state = NotifyState.open(join(env.dir, 'notify-state.sqlite'));
    const state2 = NotifyState.open(join(env.dir, 'notify-state.sqlite'));
    try {
      const a = createRecordingNotifier('resident');
      const b = createRecordingNotifier('helper');
      const log = new MemoryLogger();
      const common = { libraryDb: env.db, now: () => NOW, libraryId: 'default', log, osTimeZone: TZ };
      const [r1, r2] = await Promise.all([
        runCheck({ ...common, state, notifier: a.notifier, mode: 'resident' }),
        runCheck({ ...common, state: state2, notifier: b.notifier, mode: 'helper' }),
      ]);
      const shown = [...a.shown, ...b.shown].map((n) => n.key).sort();
      expect(shown).toEqual(['keepGoing:2026-11-26', 'upNext:2026-11-26']);
      expect(r1.delivered + r2.delivered).toBe(2);
      const again = await runCheck({ ...common, state, notifier: a.notifier, mode: 'resident' });
      expect(again.delivered).toBe(0);
      const hist = state.history('default', 30, NOW);
      expect(hist.filter((h) => h.outcome === 'delivered')).toHaveLength(2);
      // Logs never contain titles.
      expect(log.text()).not.toMatch(/Frieren|Dune/);
    } finally {
      state.close();
      state2.close();
    }
  });

  it('falls back to the in-app adapter, and records failures when nothing can show it', async () => {
    seed();
    enableScheduled(env);
    const state = NotifyState.open(join(env.dir, 'notify-state.sqlite'));
    try {
      const broken: Notifier = {
        id: 'electron',
        probe: async () => ({
          available: false,
          reason: 'x',
          capabilities: { actions: false, bodyMarkup: false, persistent: false, icon: false },
        }),
        show: async () => ({ status: 'unsupported', reason: 'notifications unsupported' }),
      };
      const inApp = createRecordingNotifier('in-app');
      const r = await runCheck({
        libraryDb: env.db,
        state,
        notifier: broken,
        fallback: inApp.notifier,
        now: () => NOW,
        mode: 'open',
        libraryId: 'default',
        log: new MemoryLogger(),
        osTimeZone: TZ,
      });
      expect(r.adapters).toEqual(['in-app', 'in-app']);
      const s2 = NotifyState.open(join(env.dir, 'other.sqlite'));
      const r2 = await runCheck({
        libraryDb: env.db,
        state: s2,
        notifier: broken,
        now: () => NOW,
        mode: 'helper',
        libraryId: 'default',
        log: new MemoryLogger(),
        osTimeZone: TZ,
      });
      expect(r2.failed).toBe(2);
      expect(s2.history('default', 30, NOW).every((h) => h.outcome === 'unsupported')).toBe(true);
      s2.close();
    } finally {
      state.close();
    }
  });

  it('helper: read-only, only in scheduled mode, no network, redacted logs, exits 0', async () => {
    const { frieren } = seed();
    enableScheduled(env);
    const before = env.db.get<{ n: number }>('SELECT total_changes() AS n');
    const titleBefore = env.db.get<{ title: string; updated_at: string }>(
      'SELECT title, updated_at FROM items WHERE id = ?',
      [frieren.id],
    );
    const fetchSpy = vi.fn(() => {
      throw new Error('network is forbidden in the helper');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const rec = createRecordingNotifier('helper');
    const log = new MemoryLogger();
    try {
      const r = await runHelper({
        dataDir: env.dir,
        notifier: rec.notifier,
        log,
        now: () => NOW,
        osTimeZone: TZ,
      });
      expect(r).toMatchObject({ code: EXIT.ok, delivered: 2, checkedLibraries: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(env.db.get('SELECT title, updated_at FROM items WHERE id = ?', [frieren.id])).toEqual(titleBefore);
    expect(env.db.get<{ n: number }>('SELECT total_changes() AS n')).toEqual(before);
    expect(log.text()).not.toMatch(/Frieren|Dune/);
    expect(log.lines.map((l) => l.event)).toContain('helper.done');

    // Not in scheduled mode → nothing happens.
    writeSettings(env.db, {
      notifications: { ...readSettings(env.db).settings.notifications, mode: 'whileOpen' },
    });
    const r2 = await runHelper({
      dataDir: env.dir,
      notifier: rec.notifier,
      log,
      now: () => new Date(NOW.getTime() + 86_400_000),
      osTimeZone: TZ,
    });
    expect(r2).toMatchObject({ code: EXIT.ok, delivered: 0, reason: 'no library uses scheduled reminders' });
  });

  it('helper: schema mismatch exits quietly without migrating; busy lease; bad dir; timeout', async () => {
    seed();
    enableScheduled(env);
    // An older library (v6) next to a newer app: the helper must not migrate it.
    const old = tempDir();
    try {
      const db6 = new Db(join(old.dir, 'library.sqlite'));
      migrate(db6, { migrations: MIGRATIONS.slice(0, 6) });
      db6.close();
      const r = await runHelper({
        dataDir: old.dir,
        notifier: createRecordingNotifier().notifier,
        log: new MemoryLogger(),
        now: () => NOW,
      });
      expect(r.code).toBe(EXIT.schemaMismatch);
      const check = new Db(join(old.dir, 'library.sqlite'), { readOnly: true });
      expect(currentSchemaVersion(check)).toBe(6);
      check.close();
    } finally {
      old.cleanup();
    }
    const holder = NotifyState.open(join(env.dir, 'notify-state.sqlite'));
    holder.acquireLease('resident-check', 60_000, NOW);
    const busy = await runHelper({
      dataDir: env.dir,
      notifier: createRecordingNotifier().notifier,
      log: new MemoryLogger(),
      now: () => NOW,
    });
    expect(busy).toMatchObject({ code: EXIT.ok, reason: 'another check is running' });
    holder.releaseLease('resident-check');
    holder.close();

    expect(
      (
        await runHelper({
          dataDir: 'relative',
          notifier: createRecordingNotifier().notifier,
          log: new MemoryLogger(),
        })
      ).code,
    ).toBe(EXIT.badArgs);

    const hang: Notifier = {
      id: 'hang',
      probe: async () => ({
        available: true,
        reason: null,
        capabilities: { actions: false, bodyMarkup: false, persistent: false, icon: false },
      }),
      // Hangs past the helper's timeout, then gives up (the real entry point exits the process on timeout).
      show: () =>
        new Promise((resolve) => setTimeout(() => resolve({ status: 'failed', reason: 'late' }), 500)),
    };
    const timedOut = await runHelper({
      dataDir: env.dir,
      notifier: hang,
      log: new MemoryLogger(),
      now: () => NOW,
      timeoutMs: 200,
      osTimeZone: TZ,
    });
    expect(timedOut.code).toBe(EXIT.timeout);
    await new Promise((r) => setTimeout(r, 1_400)); // let the abandoned run release its handles
  });

  it('helper: tolerates the main app holding a write transaction (busy DB)', async () => {
    seed();
    enableScheduled(env);
    const writer = new Db(env.ctx.paths.database);
    writer.exec('BEGIN IMMEDIATE');
    writer.run("UPDATE items SET notes = 'x' WHERE 0");
    try {
      const r = await runHelper({
        dataDir: env.dir,
        notifier: createRecordingNotifier().notifier,
        log: new MemoryLogger(),
        now: () => NOW,
        osTimeZone: TZ,
      });
      expect(r.code).toBe(EXIT.ok);
      expect(r.delivered).toBe(2);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('helper iterates only libraries with scheduled reminders, labels them when several are enabled', async () => {
    seed();
    enableScheduled(env);
    // A second library under libraries/<id>/ (copy of the first, with its own settings).
    const lib2 = join(env.dir, 'libraries', 'family01');
    mkdirSync(lib2, { recursive: true });
    env.db.checkpoint();
    copyFileSync(env.ctx.paths.database, join(lib2, 'library.sqlite'));
    writeFileSync(
      join(env.dir, 'libraries.json'),
      JSON.stringify({
        version: 1,
        active: 'default',
        libraries: [
          { id: 'default', name: 'Mine', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'family01', name: 'Family', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    );
    const rec = createRecordingNotifier();
    const r = await runHelper({
      dataDir: env.dir,
      notifier: rec.notifier,
      log: new MemoryLogger(),
      now: () => NOW,
      osTimeZone: TZ,
    });
    expect(r.checkedLibraries).toBe(2);
    expect(rec.shown.map((n) => n.title.split(' · ')[0]).sort()).toEqual([
      'Family',
      'Family',
      'Mine',
      'Mine',
    ]);
    // Turn reminders off in the second library: it is skipped and labels disappear.
    const db2 = new Db(join(lib2, 'library.sqlite'));
    writeSettings(db2, { notifications: { ...readSettings(db2).settings.notifications, mode: 'off' } });
    db2.close();
    const rec2 = createRecordingNotifier();
    const later = new Date(NOW.getTime() + 86_400_000);
    const r2 = await runHelper({
      dataDir: env.dir,
      notifier: rec2.notifier,
      log: new MemoryLogger(),
      now: () => later,
      osTimeZone: TZ,
    });
    expect(r2.checkedLibraries).toBe(1);
    expect(rec2.shown.every((n) => !n.title.includes('Mine ·'))).toBe(true);
  });

  it('engine output from the real snapshot is stable for a fixed clock (determinism)', () => {
    seed();
    const s = enableScheduled(env);
    const state = NotifyState.open(join(env.dir, 'notify-state.sqlite'));
    try {
      const a = plan({
        now: NOW,
        timeZone: TZ,
        settings: s,
        snapshot: buildSnapshot(env.db, { now: NOW, timeZone: TZ }),
        state: state.view('default', NOW),
      });
      const b = plan({
        now: NOW,
        timeZone: TZ,
        settings: s,
        snapshot: buildSnapshot(env.db, { now: NOW, timeZone: TZ }),
        state: state.view('default', NOW),
      });
      expect(a).toEqual(b);
    } finally {
      state.close();
    }
  });
});

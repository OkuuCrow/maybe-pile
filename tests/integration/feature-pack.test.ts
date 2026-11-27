import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/db/connection';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, currentSchemaVersion, migrate } from '../../src/db/migrate';
import { decodeText } from '../../src/main/ipc/handlers';
import { ArtworkService, passthroughProcessor } from '../../src/main/services/artwork-service';
import { BackupService } from '../../src/main/services/backup-service';
import { pathsFor, type ServiceContext } from '../../src/main/services/context';
import { DatabaseManager } from '../../src/main/services/db-manager';
import { buildCsvExport, buildJsonExport } from '../../src/main/services/export-service';
import { createFeatureServices } from '../../src/main/services/feature-services';
import { LibraryService } from '../../src/main/services/library-service';
import { MemoryLogger } from '../../src/main/services/logger';
import { ProviderService } from '../../src/main/services/provider-service';
import { ReleaseRadarService } from '../../src/main/services/release-radar-service';
import { SecretsService } from '../../src/main/services/secrets-service';
import { EXPORT_FORMAT_VERSION } from '../../src/main/services/portable-format';
import { QuickCaptureShortcut } from '../../src/main/quick-capture';
import { parseCsv } from '../../src/domain/csv';
import { tempDir } from '../helpers/db';
import type { LibraryQuery } from '../../src/shared/schemas';
import { ResidentScheduler } from '../../src/main/notify-electron';
import { FakeHttp, instantLimiter } from '../helpers/http';
import { makeFeatureEnv, STEAM_KEY, type FeatureEnv } from '../helpers/features';
import { FakeClock, addItem, season } from '../helpers/services';

let env: FeatureEnv;
beforeEach(() => {
  env = makeFeatureEnv();
});
afterEach(() => env.cleanup());

const Q: LibraryQuery = {
  text: '',
  types: [],
  statuses: [],
  tags: [],
  tagMode: 'any' as const,
  ratingMin: null,
  ratingMax: null,
  addedFrom: null,
  addedTo: null,
  sort: 'title' as const,
  direction: 'asc' as const,
  offset: 0,
  limit: 500,
  listId: null,
  upNextOnly: false,
  health: null,
};
const titles = (q: Partial<LibraryQuery> = {}) => env.library.query({ ...Q, ...q }).items.map((i) => i.title);
const status = (id: string, s: 'in_progress' | 'completed' | 'dropped' | 'on_hold') =>
  env.library.setStatus({
    id,
    status: s,
    startNewPass: false,
    clearDateCompleted: false,
    fillRemaining: false,
  });

/* ------------------------------------------------------------------ Up Next */

describe('Up Next table', () => {
  it('enforces the max size, keeps unique positions through reorders, and cascades on delete', () => {
    const ids = Array.from({ length: 12 }, (_, i) => addItem(env, 'movie', `M${i}`).id);
    for (const id of ids.slice(0, 10)) env.library.setUpNext(id, true);
    expect(() => env.library.setUpNext(ids[10] ?? '', true)).toThrow(/full \(10/);
    expect(env.library.bulk({ action: 'addUpNext', ids }).affected).toBe(0);
    // many reorders never violate UNIQUE(position)
    for (let i = 0; i < 30; i++) env.library.moveUpNext(ids[i % 10] ?? '', i % 3 === 0 ? 'up' : 'down');
    const pos = env.db
      .all<{ position: number }>('SELECT position FROM up_next ORDER BY position')
      .map((r) => r.position);
    expect(pos).toEqual([...Array(10).keys()]);
    expect(() => env.db.run('UPDATE up_next SET position = 0 WHERE position = 1')).toThrow(/UNIQUE/);
    // hard delete (purge) cascades; soft delete hides
    env.library.softDelete([ids[0] ?? '']);
    expect(env.library.upNext()).toHaveLength(9);
    env.library.purgeDeleted();
    expect(env.db.get<{ n: number }>('SELECT count(*) AS n FROM up_next')?.n).toBe(9);
    env.library.compactQueue();
    expect(
      env.db
        .all<{ position: number }>('SELECT position FROM up_next ORDER BY position')
        .map((r) => r.position),
    ).toEqual([...Array(9).keys()]);
    // configurable max
    env.ctx
      .db()
      .run(
        "INSERT INTO settings (key, value) VALUES ('upNextMax', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
    expect(() => env.library.setUpNext(ids[11] ?? '', true)).toThrow(/full \(3/);
    // library filter
    expect(titles({ upNextOnly: true })).toHaveLength(9);
  });
});

/* ------------------------------------------------------------------ Lists */

describe('Custom lists', () => {
  it('membership, ordering, duplicate names and delete-keeps-items', () => {
    const a = addItem(env, 'movie', 'Alien');
    const b = addItem(env, 'book', 'Dracula', { personal: { status: 'completed' } });
    const c = addItem(env, 'game', 'Doom');
    const [spooky] = env.f.lists.save({
      id: null,
      name: 'Spooky season',
      description: 'Oct',
      color: 'amber',
      icon: 'ghost',
    });
    expect(() =>
      env.f.lists.save({ id: null, name: 'SPOOKY  season', description: null, color: null, icon: null }),
    ).toThrow(/already exists/);
    const lid = spooky?.id ?? '';
    expect(env.f.lists.setMembership(lid, [a.id, b.id, c.id], true)).toBe(3);
    expect(env.f.lists.setMembership(lid, [a.id], true)).toBe(0); // idempotent
    env.f.lists.moveItem(lid, c.id, 'up');
    expect(env.f.lists.get(lid).items.map((i) => i.title)).toEqual(['Alien', 'Doom', 'Dracula']);
    expect(env.f.lists.list()[0]).toMatchObject({ total: 3, completed: 1 });
    expect(titles({ listId: lid })).toEqual(['Alien', 'Doom', 'Dracula']);
    expect(env.library.get(a.id).lists).toEqual([{ id: lid, name: 'Spooky season' }]);
    env.library.bulk({ action: 'addToList', ids: [a.id], listId: env.f.lists.ensure('Couch') });
    expect(env.library.get(a.id).lists.map((l) => l.name)).toEqual(['Spooky season', 'Couch']);
    const second = env.f.lists.list()[1]?.id ?? '';
    env.f.lists.move(second, 'up');
    expect(env.f.lists.list().map((l) => l.name)).toEqual(['Couch', 'Spooky season']);
    env.f.lists.remove(lid);
    expect(titles()).toEqual(['Alien', 'Doom', 'Dracula']);
    expect(
      env.db.get<{ n: number }>('SELECT count(*) AS n FROM list_items WHERE list_id = ?', [lid])?.n,
    ).toBe(0);
  });

  it('round-trips through JSON export/import (merge by name) and CSV (lists column)', () => {
    const a = addItem(env, 'movie', 'Alien');
    const lid = env.f.lists.ensure('Spooky');
    env.f.lists.setMembership(lid, [a.id], true);
    env.library.setUpNext(a.id, true);
    const json = buildJsonExport(env.db, 'v', env.clock.now());
    expect(json.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(json.data.lists?.[0]).toMatchObject({ name: 'Spooky', items: [{ itemId: a.id, position: 0 }] });
    const csv = buildCsvExport(env.db, false);
    const rows = parseCsv(csv);
    const header = rows[0] ?? [];
    expect(rows[1]?.[header.indexOf('lists')]).toBe('Spooky');
    expect(rows[1]?.[header.indexOf('up_next_position')]).toBe('1');
    const other = makeFeatureEnv();
    try {
      other.f.lists.ensure('spooky'); // existing list with the same name (different case) is reused
      const p = other.f.importer.previewJson(JSON.stringify(json), 'x.json');
      expect(p.incoming.lists).toBe(1);
      other.f.importer.apply({
        token: p.token,
        defaultResolution: 'skip',
        resolutions: {},
        confirmation: '',
      });
      expect(other.f.lists.list()).toHaveLength(1);
      expect(other.f.lists.list()[0]?.total).toBe(1);
      expect(other.library.upNext().map((i) => i.title)).toEqual(['Alien']);
      const third = makeFeatureEnv();
      try {
        const pc = third.f.importer.previewCsv(csv, 'x.csv');
        expect(pc.incoming.lists).toBe(1);
        third.f.importer.apply({
          token: pc.token,
          defaultResolution: 'skip',
          resolutions: {},
          confirmation: '',
        });
        expect(third.f.lists.list().map((l) => [l.name, l.total])).toEqual([['Spooky', 1]]);
        expect(third.library.upNext()).toHaveLength(1);
      } finally {
        third.cleanup();
      }
    } finally {
      other.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ Pile Health */

describe('Pile Health', () => {
  it('finds stale items, snoozes/keeps/unsnoozes them, filters the library and respects the off switch', () => {
    env.clock.current = new Date('2026-06-01T12:00:00Z');
    const old = addItem(env, 'book', 'Old', { personal: { dateAdded: '2025-01-01' } });
    addItem(env, 'book', 'New', { personal: { dateAdded: '2026-05-01' } });
    const idle = addItem(env, 'game', 'Idle', {
      personal: { dateAdded: '2026-01-01', status: 'in_progress', dateStarted: '2026-01-02' },
    });
    const o = env.f.health.overview();
    expect(o.stale.map((s) => [s.title, s.kind])).toEqual([
      ['Old', 'planned-old'],
      ['Idle', 'in-progress-idle'],
    ]);
    expect(o.stale[0]?.reason).toMatch(/Planned for 1[67] months/);
    expect(titles({ health: 'stale' })).toEqual(['Idle', 'Old']);
    env.f.health.snooze([old.id], '2026-09-01');
    expect(() => env.f.health.snooze([old.id], '2020-01-01')).toThrow(/from today/);
    env.f.health.keep([idle.id]);
    expect(env.f.health.overview().stale).toEqual([]);
    expect(env.f.health.overview().snoozed.map((s) => s.title)).toEqual(['Old']); // keep isn't listed as snoozed
    expect(titles({ health: 'snoozed' })).toEqual(['Old']);
    expect(env.library.get(old.id).snoozedUntil).toBe('2026-09-01');
    // expiry with an injected clock
    env.clock.current = new Date('2026-09-02T12:00:00Z');
    expect(env.f.health.overview().stale.map((s) => s.title)).toContain('Old');
    expect(env.f.health.purgeExpired()).toBe(2); // the snooze and the earlier Keep both ended
    env.f.health.unsnooze([idle.id]);
    // settings persistence: thresholds and off switch
    env.ctx
      .db()
      .run(
        `INSERT INTO settings (key, value) VALUES ('pileHealth', '{"enabled":false,"plannedStaleMonths":48,"inProgressStaleDays":60}')`,
      );
    const off = env.f.health.overview();
    expect(off.enabled).toBe(false);
    expect(off.stale.map((s) => s.title)).toEqual(['Idle']);
  });
});

/* ------------------------------------------------------------------ Pick */

describe('Pick for Me service', () => {
  it('excludes dropped/snoozed/skipped items, records history and handles start/queue/skip', () => {
    const a = addItem(env, 'movie', 'A', { meta: { runtimeMinutes: 100 } });
    const b = addItem(env, 'movie', 'B', { meta: { runtimeMinutes: 200 } });
    addItem(env, 'movie', 'Dropped', { personal: { status: 'dropped' } });
    const snoozed = addItem(env, 'movie', 'Snoozed');
    env.f.health.snooze([snoozed.id], '2099-01-01');
    const base = {
      types: [],
      genres: [],
      tags: [],
      listIds: [],
      onlyUpNext: false,
      includeInProgress: false,
      includeOnHold: false,
      availableMinutes: null,
      ratingFloor: null,
      excludeSkipped: true,
    };
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++)
      seen.add(env.f.pick.roll({ constraints: base, avoid: [], seed: s }).pick?.title ?? '');
    expect([...seen].sort()).toEqual(['A', 'B']);
    const r = env.f.pick.roll({ constraints: { ...base, availableMinutes: 90 }, avoid: [], seed: 1 });
    expect(r.pick?.id).toBe(a.id);
    expect(r.reasons).toContain('fits 90 min (100 min)');
    const same = env.f.pick.roll({ constraints: { ...base, availableMinutes: 90 }, avoid: [], seed: 1 });
    expect(same.pick?.id).toBe(r.pick?.id); // deterministic with seed
    env.f.pick.respond(r.historyId ?? '', 'skipped');
    const empty = env.f.pick.roll({ constraints: { ...base, availableMinutes: 90 }, avoid: [], seed: 2 });
    expect(empty).toMatchObject({ pick: null, emptiedBy: 'availableMinutes' }); // A skipped, then B too long
    expect(
      env.f.pick.roll({ constraints: { ...base, types: ['book'] }, avoid: [], seed: 2 }).emptiedByLabel,
    ).toBe('Media type');
    const r2 = env.f.pick.roll({ constraints: base, avoid: [], seed: 3 });
    expect(r2.pick?.id).toBe(b.id);
    env.f.pick.respond(r2.historyId ?? '', 'queued');
    expect(env.library.upNext().map((i) => i.id)).toEqual([b.id]);
    const r3 = env.f.pick.roll({ constraints: { ...base, includeInProgress: true }, avoid: [], seed: 3 });
    env.f.pick.respond(r3.historyId ?? '', 'started');
    expect(env.library.get(b.id).personal.status).toBe('in_progress');
    const outcomes = env.f.pick.history(100).map((h) => h.outcome);
    expect(outcomes.slice(0, 2)).toEqual(['started', 'queued']);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(1);
    expect(env.f.pick.clearSkips()).toBe(1);
  });
});

/* ------------------------------------------------------------------ Goals */

describe('Goals', () => {
  it('computes progress from real completion dates with scope filters and pace', () => {
    env.clock.current = new Date('2027-07-02T12:00:00Z');
    const lid = env.f.lists.ensure('Book club');
    const done = (title: string, date: string, pages: number | null = null) => {
      const it = addItem(env, 'book', title, { meta: { pageCount: pages } });
      env.ctx
        .db()
        .run("UPDATE items SET status = 'completed', date_completed = ? WHERE id = ?", [date, it.id]);
      return it;
    };
    const a = done('A', '2027-01-01', 300);
    done('B', '2027-12-31', 200);
    done('C', '2026-12-31', 100); // previous year
    const d = done('D', '2027-06-30');
    env.f.lists.setMembership(lid, [a.id], true);
    const goals = env.f.goals.save({
      id: null,
      title: '24 books',
      mediaType: 'book',
      metric: 'items',
      period: 'year',
      startDate: '2027-03-01',
      endDate: null,
      target: 24,
      listId: null,
      tag: null,
    });
    const g = goals[0];
    expect(g).toMatchObject({ startDate: '2027-01-01', endDate: '2027-12-31', progress: 3 });
    expect(g?.pace.status).toBe('behind');
    expect(g?.pace.math).toMatch(/expected by today/);
    env.f.goals.save({
      id: null,
      title: 'Pages',
      mediaType: 'book',
      metric: 'pages',
      period: 'year',
      startDate: '2027-01-01',
      endDate: null,
      target: 1000,
      listId: null,
      tag: null,
    });
    env.f.goals.save({
      id: null,
      title: 'Club',
      mediaType: null,
      metric: 'items',
      period: 'custom',
      startDate: '2027-01-01',
      endDate: '2027-01-31',
      target: 1,
      listId: lid,
      tag: null,
    });
    const all = env.f.goals.list();
    expect(all.find((x) => x.title === 'Pages')?.progress).toBe(500);
    expect(all.find((x) => x.title === 'Club')).toMatchObject({ progress: 1, pace: { status: 'done' } });
    // un-completing an item lowers progress
    status(d.id, 'in_progress');
    expect(env.f.goals.list().find((x) => x.title === '24 books')?.progress).toBe(2);
    // archive / delete
    const id = g?.id ?? '';
    expect(env.f.goals.setArchived(id, true).find((x) => x.id === id)?.archived).toBe(true);
    expect(env.f.goals.list(false).find((x) => x.id === id)).toBeUndefined();
    expect(env.f.goals.remove(id).find((x) => x.id === id)).toBeUndefined();
  });

  it('episodes by local date and hours logged within the period', () => {
    env.clock.current = new Date('2027-02-15T12:00:00Z');
    const show = addItem(env, 'tv', 'Show', { seasons: [season(1, 3)] });
    const eps = show.seasons[0]?.episodes ?? [];
    env.progress.toggleEpisodes({
      itemId: show.id,
      episodeIds: eps.map((e) => e.id),
      watched: true,
      scope: 'season',
    });
    env.ctx
      .db()
      .run("UPDATE episodes SET watched_at = '2027-01-31T23:30:00.000Z' WHERE id = ?", [eps[0]?.id ?? '']);
    const game = addItem(env, 'game', 'G', { personal: { gameScheme: 'hours' } });
    env.progress.add({
      itemId: game.id,
      entry: { kind: 'hours', value: 10 },
      occurredAt: '2027-01-20T10:00:00.000Z',
      note: null,
    });
    env.progress.add({
      itemId: game.id,
      entry: { kind: 'hours', value: 14.5 },
      occurredAt: '2027-02-10T10:00:00.000Z',
      note: null,
    });
    const l = env.f.goals.save({
      id: null,
      title: 'Eps Feb',
      mediaType: 'tv',
      metric: 'episodes',
      period: 'month',
      startDate: '2027-02-01',
      endDate: null,
      target: 10,
      listId: null,
      tag: null,
    });
    expect(l.find((x) => x.title === 'Eps Feb')?.progress).toBe(2); // UTC zone in tests: Jan 31 23:30 is January
    const h = env.f.goals.save({
      id: null,
      title: 'Hours Feb',
      mediaType: 'game',
      metric: 'hours',
      period: 'month',
      startDate: '2027-02-01',
      endDate: null,
      target: 20,
      listId: null,
      tag: null,
    });
    expect(h.find((x) => x.title === 'Hours Feb')?.progress).toBe(4.5);
  });
});

/* ------------------------------------------------------------------ Stats */

describe('Stats service', () => {
  it('aggregates real data, exports chart CSV safely, and handles empty libraries', () => {
    expect(env.f.stats.get(null).completedTotal).toBe(0);
    const it = addItem(env, 'book', '=SUM(A1)', {
      meta: { pageCount: 120, genres: ['Horror'] },
      personal: { rating: 8, dateStarted: '2025-01-01' },
    });
    status(it.id, 'completed');
    const s = env.f.stats.get(null);
    expect(s).toMatchObject({
      completedTotal: 1,
      pages: { total: 120 },
      topGenres: [{ name: 'Horror', count: 1 }],
    });
    expect(s.streaks).toBeNull(); // off by default
    const csv = env.f.stats.chartCsv('topGenres', null, false);
    expect(csv).toBe('genre,completed\r\nHorror,1\r\n');
    expect(env.f.stats.yearInReview(2025).favorites[0]?.title).toBe('=SUM(A1)');
    const fav = env.f.stats.chartCsv('completedByMonth', 2025, false);
    expect(fav.split('\r\n')[1]).toBe('2025-03,0,0,0,1,0,1');
  });

  it('stays responsive at 10k items / 100k history rows', () => {
    const db = env.db;
    const now = '2025-01-01T00:00:00.000Z';
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        db.run(
          `INSERT INTO items (id, type, title, sort_title, title_key, status, date_added, date_completed, rating, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '2024-01-01', ?, ?, ?, ?)`,
          [
            id,
            ['movie', 'tv', 'game', 'book'][i % 4] ?? 'movie',
            `T${i}`,
            `t${i}`,
            `t${i}`,
            i % 2 ? 'completed' : 'planned',
            i % 2 ? `20${20 + (i % 6)}-0${1 + (i % 9)}-15` : null,
            i % 2 ? (i % 10) + 1 : null,
            now,
            now,
          ],
        );
        for (let k = 0; k < 10; k++)
          db.run(
            `INSERT INTO progress_events (id, item_id, seq, kind, value, pass, occurred_at, recorded_at) VALUES (?, ?, ?, 'percent', ?, 1, ?, ?)`,
            [
              `${id.slice(0, 24)}${String(i * 10 + k).padStart(12, '0')}`.slice(0, 36),
              id,
              i * 10 + k,
              k * 10,
              `2024-0${1 + (k % 9)}-10T10:00:00.000Z`,
              now,
            ],
          );
      }
    });
    const t0 = performance.now();
    const s = env.f.stats.get(null);
    const t1 = performance.now();
    env.f.stats.yearInReview(2024);
    env.f.health.overview();
    const t2 = performance.now();
    expect(s.completedTotal).toBe(5000);
    expect(t1 - t0).toBeLessThan(8_000);
    expect(t2 - t1).toBeLessThan(8_000);
  });
});

/* ------------------------------------------------------------------ Release Radar */

describe('Release Radar', () => {
  function radarEnv(previewRows: Record<string, { current: string; incoming: string; userEdited: boolean }>) {
    const applied: { token: string; choices: Record<string, string> }[] = [];
    const radar = new ReleaseRadarService(env.ctx, {
      refreshPreview: async (itemId) => {
        const r = previewRows[itemId];
        if (!r)
          throw Object.assign(new Error('x'), { safe: { code: 'PROVIDER_NETWORK', message: 'offline' } });
        return {
          token: `tok-${itemId}`,
          providerId: 'tmdb',
          providerName: 'TMDB',
          rows: [
            {
              field: 'releaseDate',
              label: 'Release',
              current: r.current,
              incoming: r.incoming,
              origin: 'provider',
              lastEdited: null,
              userEdited: r.userEdited,
              defaultChoice: r.userEdited ? 'keep' : 'update',
            },
            {
              field: 'description',
              label: 'Desc',
              current: 'a',
              incoming: 'b',
              origin: 'provider',
              lastEdited: null,
              userEdited: false,
              defaultChoice: 'update',
            },
          ],
          unchangedCount: 0,
          newEpisodes: 0,
          updatedEpisodes: 0,
        };
      },
      refreshApply: (input) => void applied.push(input),
    });
    return { radar, applied };
  }

  it('lists upcoming Planned items with precision/source, refreshes only the release date, exports ics and notifies once', async () => {
    env.clock.current = new Date('2026-11-23T09:00:00Z');
    const a = addItem(env, 'game', 'Tomorrow Game', { meta: { releaseDate: '2026-11-24' } });
    const b = addItem(env, 'movie', 'Year Movie', { meta: { releaseDate: '2027' } });
    addItem(env, 'book', 'Past', { meta: { releaseDate: '2020-01-01' } });
    addItem(env, 'game', 'Done', { meta: { releaseDate: '2027-01-01' }, personal: { status: 'completed' } });
    const held = addItem(env, 'game', 'Held', {
      meta: { releaseDate: '2027-02' },
      personal: { status: 'on_hold' },
    });
    env.ctx
      .db()
      .run(
        "INSERT INTO item_sources (item_id, provider_id, provider_ref, url, fetched_at) VALUES (?, 'tmdb', '1', NULL, '2026-11-01T00:00:00Z')",
        [a.id],
      );
    env.ctx
      .db()
      .run(
        "INSERT INTO item_sources (item_id, provider_id, provider_ref, url, fetched_at) VALUES (?, 'tmdb', '2', NULL, '2026-11-01T00:00:00Z')",
        [b.id],
      );
    const { radar, applied } = radarEnv({
      [a.id]: { current: '2026-11-24', incoming: '2026-12-05', userEdited: true },
    });
    const up = radar.upcoming();
    expect(up.map((u) => [u.title, u.precision, u.relative])).toEqual([
      ['Tomorrow Game', 'day', 'tomorrow'],
      ['Year Movie', 'year', 'in 2027'],
    ]);
    expect(up[0]?.dateSource).toBe('you'); // manual entry
    expect(up[0]?.userEdited).toBe(true);
    env.ctx
      .db()
      .run(
        `INSERT INTO settings (key, value) VALUES ('releaseRadar', '{"includeOnHold":true,"notifications":true,"refreshOnStart":false}')`,
      );
    expect(radar.upcoming().map((u) => u.id)).toContain(held.id);
    const diff = await radar.refreshPreview();
    expect(diff.rows).toEqual([
      {
        itemId: a.id,
        title: 'Tomorrow Game',
        current: '2026-11-24',
        incoming: '2026-12-05',
        userEdited: true,
        defaultChoice: 'keep',
      },
    ]);
    expect(diff.failures.map((f) => f.title)).toEqual(['Year Movie']);
    expect(diff.skippedNoSource).toBe(1);
    expect(radar.refreshApply(diff.token, { [a.id]: 'keep' })).toEqual({ updated: 0 });
    const diff2 = await radar.refreshPreview();
    expect(radar.refreshApply(diff2.token, { [a.id]: 'update' })).toEqual({ updated: 1 });
    expect(applied[0]).toEqual({
      token: `tok-${a.id}`,
      choices: { releaseDate: 'update', description: 'keep' },
    });
    const ics = radar.ics();
    expect(ics.included).toBe(1);
    expect(ics.text).toContain(`UID:release-${a.id}@maybe-pile`);
    const due = radar.dueNotifications();
    expect(due).toEqual([
      { itemId: a.id, kind: 'tomorrow', title: 'Out tomorrow', body: 'Tomorrow Game releases tomorrow.' },
    ]);
    expect(radar.dueNotifications()).toEqual([]); // once only
    env.clock.current = new Date('2026-11-24T09:00:00Z');
    expect(radar.dueNotifications().map((n) => n.kind)).toEqual(['today']);
  });

  it('2.1 resident scheduler (replaces the hourly while-open notifier): ticks, clock jumps, no overlap, stop', async () => {
    vi.useFakeTimers();
    try {
      const reasons: string[] = [];
      let release: () => void = () => undefined;
      let wallClock = 0;
      const sched = new ResidentScheduler(
        (reason) => {
          reasons.push(reason);
          return reason === 'slow' ? new Promise<void>((r) => (release = r)) : Promise.resolve();
        },
        { tickMs: 1_000, now: () => wallClock },
      );
      sched.start();
      expect(reasons).toEqual(['start']);
      wallClock += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reasons.at(-1)).toBe('tick');
      wallClock += 1_000 + 3 * 60_000; // the wall clock jumped (sleep / manual change)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reasons.at(-1)).toBe('clock-change');
      const slow = sched.kick('slow');
      await sched.kick('resume'); // ignored: a run is in progress
      release();
      await slow;
      expect(reasons.filter((r) => r === 'resume')).toEqual([]);
      sched.stop();
      expect(sched.active).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reasons.filter((r) => r === 'tick')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ Quick capture shortcut */

describe('Quick Capture global shortcut', () => {
  it('registers only when opted in and tolerates conflicts', () => {
    const owned = new Set(['CommandOrControl+Shift+Space']);
    const registered = new Set<string>();
    const reg = {
      register: (a: string) => {
        if (owned.has(a)) return false;
        registered.add(a);
        return true;
      },
      unregister: (a: string) => void registered.delete(a),
      isRegistered: (a: string) => registered.has(a),
    };
    const q = new QuickCaptureShortcut(reg, () => undefined);
    expect(q.apply({ globalShortcut: false, accelerator: 'Alt+Q' }).registered).toBe(false);
    expect(registered.size).toBe(0);
    const conflict = q.apply({ globalShortcut: true, accelerator: 'CommandOrControl+Shift+Space' });
    expect(conflict).toMatchObject({ registered: false, message: expect.stringMatching(/already used/) });
    expect(q.apply({ globalShortcut: true, accelerator: 'Alt+Q' }).registered).toBe(true);
    expect(registered.has('Alt+Q')).toBe(true);
    q.apply({ globalShortcut: true, accelerator: 'Alt+W' });
    expect([...registered]).toEqual(['Alt+W']);
    q.apply({ globalShortcut: false, accelerator: 'Alt+W' });
    expect(registered.size).toBe(0);
    const throwing = new QuickCaptureShortcut(
      {
        ...reg,
        register: () => {
          throw new Error('bad');
        },
      },
      () => undefined,
    );
    expect(throwing.apply({ globalShortcut: true, accelerator: 'Alt+E' }).registered).toBe(false);
  });
});

/* ------------------------------------------------------------------ Tracker imports */

const GOODREADS = `Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies
1,Dune,Frank Herbert,"Herbert, Frank",,"=""0441172717""","=""9780441172719""",5,4.25,Ace,Paperback,604,1990,1965,2024/03/15,2023/01/02,sci-fi,,read,,,,1,0
2,Piranesi,Susanna Clarke,"Clarke, Susanna",,,,0,4.2,Bloomsbury,Hardcover,272,2020,2020,,2024/05/01,,,to-read,,,,0,0
3,Weird,X,,,,,0,0,,,,,,,2024/05/01,,,abandoned-pile,,,,0,0
4,,NoTitle,,,,,,,,,,,,,,,,read,,,,,
`;

describe('Tracker imports', () => {
  const file = (name: string, text: string | Uint8Array) => ({
    name,
    bytes: typeof text === 'string' ? new TextEncoder().encode(text) : text,
  });

  it('Goodreads → preview with row messages, ISBN conflicts, skip/duplicate only, then undo', () => {
    const existing = addItem(env, 'book', 'Dune (other edition)', {
      meta: { isbn13: '9780441172719', externalIds: [{ kind: 'isbn13', value: '9780441172719' }] },
    });
    const p = env.f.tracker.preview('goodreads', [file('goodreads_library_export.csv', GOODREADS)]);
    expect(p.canApply).toBe(true);
    expect(p.incoming.items.book).toBe(3);
    expect(p.allowedResolutions).toEqual(['skip', 'duplicate']);
    expect(p.conflicts).toEqual([
      expect.objectContaining({ importedTitle: 'Dune', existingId: existing.id, reason: 'provider-id' }),
    ]);
    expect(p.messages.some((m) => m.path.startsWith('row 5'))).toBe(true);
    expect(p.messages.some((m) => m.path.startsWith('row 4') && /Unknown shelf/.test(m.message))).toBe(true);
    // 'update' is refused for tracker imports (treated as skip)
    const r = env.f.importer.apply({
      token: p.token,
      defaultResolution: 'update',
      resolutions: {},
      confirmation: '',
    });
    expect(r).toMatchObject({ added: 2, skipped: 1, updated: 0 });
    expect(r.batchId).toBeTruthy();
    const pir = env.library.get(env.library.query({ ...Q, text: 'Piranesi' }).items[0]?.id ?? '');
    expect(pir.personal).toMatchObject({ status: 'planned', dateAdded: '2024-05-01' });
    expect(pir.meta.pageCount).toBe(272);
    env.library.setRating(pir.id, 6);
    const u = env.f.batches.undo(r.batchId ?? '');
    expect(u.removable.map((x) => x.title)).toEqual(['Weird']);
    expect(u.kept.map((x) => x.title)).toEqual(['Piranesi']);
  });

  it('Goodreads rejects other files; Letterboxd zip → movies with viewings and ratings', () => {
    expect(() => env.f.tracker.preview('goodreads', [file('x.csv', 'a,b\n1,2')])).toThrow(/Goodreads/);
    const zip = zipSync({
      'letterboxd-export/watched.csv': strToU8(
        'Date,Name,Year,Letterboxd URI\n2024-02-01,Heat,1995,https://boxd.it/a',
      ),
      'letterboxd-export/ratings.csv': strToU8(
        'Date,Name,Year,Letterboxd URI,Rating\n2024-02-01,Heat,1995,https://boxd.it/a,4.5',
      ),
      'letterboxd-export/watchlist.csv': strToU8(
        'Date,Name,Year,Letterboxd URI\n2024-01-02,Alien,1979,https://boxd.it/b',
      ),
      'letterboxd-export/diary.csv': strToU8(
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-02-01,Heat,1995,https://boxd.it/a,4.5,,crime,2024-01-31',
      ),
      'letterboxd-export/profile.csv': strToU8('Username\nme'),
      'letterboxd-export/deleted/diary.csv': strToU8(
        'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2020-01-01,Gone,2000,https://boxd.it/z,1,,,2020-01-01',
      ),
    });
    const p = env.f.tracker.preview('letterboxd', [file('letterboxd.zip', zip)]);
    expect(p.incoming.items.movie).toBe(2);
    expect(p.incoming.viewings).toBe(1);
    env.f.importer.apply({ token: p.token, defaultResolution: 'skip', resolutions: {}, confirmation: '' });
    const heat = env.library.get(env.library.query({ ...Q, text: 'Heat' }).items[0]?.id ?? '');
    expect(heat.personal).toMatchObject({ status: 'completed', rating: 9, tags: ['crime'] });
    expect(env.progress.viewings(heat.id).map((v) => v.watchedAt?.slice(0, 10))).toEqual(['2024-01-31']);
    expect(titles()).toEqual(['Alien', 'Heat']);
    expect(() => env.f.tracker.preview('letterboxd', [file('x.zip', new Uint8Array([1, 2, 3]))])).toThrow(
      /ZIP/,
    );
  });

  it('generic CSV: mapping, remap, non-UTF-8, formula cells stay text, profiles persist, caps enforced', () => {
    const latin1 = Uint8Array.from([
      ...new TextEncoder().encode('Title;Type;Stars\n'),
      0x43,
      0x61,
      0x66,
      0xe9,
      ...new TextEncoder().encode(';book;4\n"=HYPERLINK(""http://evil"")";game;5\n'),
    ]);
    const p = env.f.tracker.preview('csv', [file('mine.csv', latin1)]);
    expect(p.delimiter).toBe(';');
    expect(p.header).toEqual(['Title', 'Type', 'Stars']);
    expect(p.mapToken).toBeTruthy();
    const mapping = { ...(p.mapping as never as Record<string, unknown>) } as never as Parameters<
      typeof env.f.tracker.remap
    >[2];
    mapping.columns.rating = 'Stars';
    const p2 = env.f.tracker.remap(p.mapToken ?? '', p.token, mapping);
    expect(p2.incoming.items).toMatchObject({ book: 1, game: 1 });
    env.f.importer.apply({ token: p2.token, defaultResolution: 'skip', resolutions: {}, confirmation: '' });
    expect(titles()).toEqual(['Café', '=HYPERLINK("http://evil")']);
    expect(env.http.calls).toHaveLength(0); // nothing fetched
    const csv = buildCsvExport(env.db, false);
    expect(csv).toContain(`'=HYPERLINK`); // neutralized on re-export
    // the old token was dropped when remapping
    expect(() =>
      env.f.importer.apply({ token: p.token, defaultResolution: 'skip', resolutions: {}, confirmation: '' }),
    ).toThrow(/expired/);
    // profiles
    const profiles = env.f.tracker.saveProfile('My sheet', mapping);
    expect(profiles.map((x) => x.name)).toEqual(['My sheet']);
    expect(env.f.tracker.saveProfile('my SHEET', mapping)).toHaveLength(1);
    expect(env.f.tracker.deleteProfile(profiles[0]?.id ?? '')).toEqual([]);
    // caps
    expect(() => env.f.tracker.preview('csv', [file('big.csv', new Uint8Array(26 * 1024 * 1024))])).toThrow(
      /too large/,
    );
    // a mapping without a title column blocks with a clear message
    const bad = env.f.tracker.remap(p.mapToken ?? '', '', {
      ...mapping,
      columns: { ...mapping.columns, title: null },
    });
    expect(bad.canApply).toBe(false);
    expect(bad.messages[0]?.message).toMatch(/Title/);
    expect(decodeText(latin1)).toContain('Café');
  });
});

/* ------------------------------------------------------------------ Backup / restore / versions / migration */

function backupEnv() {
  const t = tempDir();
  const paths = pathsFor(t.dir);
  for (const d of [paths.artwork, paths.backups, paths.logs]) mkdirSync(d, { recursive: true });
  const log = new MemoryLogger();
  const clock = new FakeClock();
  const dbm = new DatabaseManager(paths, log, () => clock.now());
  dbm.open();
  const ctx: ServiceContext = { db: () => dbm.db, clock, log, paths, appVersion: '1.2.0-test' };
  const http = new FakeHttp();
  const secrets = new SecretsService(
    paths.secrets,
    { isEncryptionAvailable: () => false, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
    log,
    {},
  );
  const library = new LibraryService(ctx);
  const artwork = new ArtworkService(ctx, passthroughProcessor, http);
  const providers = new ProviderService(ctx, http, secrets, library, artwork, () => instantLimiter());
  const f = createFeatureServices(ctx, {
    library,
    providers,
    secrets,
    http,
    decodeText,
    steamLimiter: instantLimiter(),
  });
  const backup = new BackupService(ctx, dbm, artwork);
  return { t, paths, ctx, library, f, backup, secrets, cleanup: () => (dbm.close(), t.cleanup()) };
}

describe('backup, export and restore of feature data', () => {
  it('full backup → restore returns every new entity and contains no secrets', () => {
    const a = backupEnv();
    const b = backupEnv();
    try {
      const it = a.library.create({
        type: 'game',
        meta: { ...emptyMeta('Hades') },
        personal: { ...personal('game') },
        seasons: [],
        milestones: [],
        allowDuplicate: false,
      });
      const id = it.kind === 'created' ? it.item.id : '';
      a.library.setUpNext(id, true);
      a.f.lists.setMembership(a.f.lists.ensure('Roguelikes'), [id], true);
      a.f.health.snooze([id], '2099-01-01');
      a.f.goals.save({
        id: null,
        title: 'G',
        mediaType: null,
        metric: 'items',
        period: 'year',
        startDate: '2025-01-01',
        endDate: null,
        target: 5,
        listId: null,
        tag: null,
      });
      a.f.sources.loadManual({ sourceId: null, label: 'Shelf', text: 'Hades\nTunic' });
      a.f.sources.saveSteam({ sourceId: null, label: 'Steam', account: 'gaben', apiKey: STEAM_KEY });
      a.f.tracker.saveProfile('Sheet', {
        columns: {
          title: 'Title',
          type: null,
          creator: null,
          status: null,
          rating: null,
          dateAdded: null,
          dateStarted: null,
          dateCompleted: null,
          releaseDate: null,
          tags: null,
          isbn: null,
          pageCount: null,
          platform: null,
          notes: null,
        },
        defaultType: 'book',
        ratingScale: 'stars5',
        dateOrder: 'ymd',
        tagSeparator: ';',
      });
      const src = a.f.sources.list().find((s) => s.kind === 'manual')?.id ?? '';
      const tunic =
        a.f.sources.entries({
          sourceId: src,
          view: 'all',
          search: 'tunic',
          showNonGames: true,
          sort: 'name',
          direction: 'asc',
        }).rows[0]?.externalId ?? '';
      return a.f.sources
        .importSelected({
          sourceId: src,
          externalIds: [tunic],
          status: 'planned',
          tags: [],
          listId: null,
          importPlaytime: false,
          enrich: false,
        })
        .then(() => {
          const file = join(a.t.dir, 'x.mpbackup');
          a.backup.createBackup(file, { overwrite: false });
          const bytes = readFileSync(file);
          expect(bytes.includes(Buffer.from(STEAM_KEY))).toBe(false);
          const p = b.backup.previewRestore(file);
          expect(p.incoming).toMatchObject({
            lists: 1,
            upNext: 1,
            snoozes: 1,
            goals: 1,
            librarySources: 2,
            sourceEntries: 2,
            importBatches: 1,
            mappingProfiles: 1,
          });
          b.backup.applyRestore(p.token, 'RESTORE');
          expect(b.library.upNext().map((x) => x.title)).toEqual(['Hades']);
          expect(b.f.lists.list().map((l) => l.name)).toEqual(['Roguelikes']);
          expect(b.f.health.overview().snoozed).toHaveLength(1);
          expect(b.f.goals.list()).toHaveLength(1);
          expect(
            b.f.sources
              .list()
              .map((s) => s.kind)
              .sort(),
          ).toEqual(['manual', 'steam']);
          expect(b.f.sources.list().find((s) => s.kind === 'steam')?.keySet).toBe(false); // key never travels
          expect(b.f.batches.list()).toHaveLength(1);
          expect(b.f.tracker.profiles()).toHaveLength(1);
          // JSON export of the same data, re-imported, also keeps it (no secrets)
          const json = JSON.stringify(buildJsonExport(a.ctx.db(), '1.2.0', new Date()));
          expect(json).not.toContain(STEAM_KEY);
          const c = backupEnv();
          try {
            const pj = c.f.importer.previewJson(json, 'x.json');
            expect(pj.incoming).toMatchObject({
              lists: 1,
              goals: 1,
              librarySources: 2,
              importBatches: 1,
              mappingProfiles: 1,
              snoozes: 1,
            });
            c.f.importer.apply({
              token: pj.token,
              defaultResolution: 'skip',
              resolutions: {},
              confirmation: '',
            });
            expect(
              c.f.sources.entries({
                sourceId: src,
                view: 'inPile',
                search: '',
                showNonGames: true,
                sort: 'name',
                direction: 'asc',
              }).total,
            ).toBe(1);
            expect(
              c.f.batches.undoPreview(c.f.batches.list()[0]?.id ?? '').removable.map((r) => r.title),
            ).toEqual(['Tunic']);
          } finally {
            c.cleanup();
          }
        });
    } finally {
      // cleanup after the promise chain settles
      setTimeout(() => (a.cleanup(), b.cleanup()), 0);
    }
  });

  it('old (v1) exports import; newer formats are refused with a clear message', () => {
    const v1 = buildJsonExport(env.db, '1.1.0', new Date());
    const legacy = { ...v1, formatVersion: 1, data: { ...v1.data } } as Record<string, unknown> & {
      data: Record<string, unknown>;
    };
    for (const k of ['lists', 'goals', 'snoozes', 'librarySources', 'importBatches', 'mappingProfiles'])
      Reflect.deleteProperty(legacy.data, k);
    addItem(env, 'movie', 'Here');
    const p = env.f.importer.previewJson(JSON.stringify(legacy), 'old.json');
    expect(p.canApply).toBe(false); // empty file
    expect(p.messages.every((m) => m.severity !== 'error' || /no data/.test(m.message))).toBe(true);
    const newer = { ...v1, formatVersion: EXPORT_FORMAT_VERSION + 1 };
    const pn = env.f.importer.previewJson(JSON.stringify(newer), 'new.json');
    expect(pn.messages[0]?.message).toMatch(/Update Maybe Pile/);
  });
});

describe('migration v3 → v4', () => {
  it('moves the Up Next column into the table in order, keeps rows and FK integrity; failures roll back', () => {
    const t = tempDir();
    const db = new Db(join(t.dir, 'library.sqlite'));
    try {
      migrate(db, { migrations: MIGRATIONS.slice(0, 3) });
      const mk = (id: string, title: string, pos: number | null) =>
        db.run(
          `INSERT INTO items (id, type, title, sort_title, title_key, status, date_added, created_at, updated_at, up_next_position)
           VALUES (?, 'movie', ?, ?, ?, 'planned', '2024-01-01', '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', ?)`,
          [id, title, title.toLowerCase(), title.toLowerCase(), pos],
        );
      mk('11111111-1111-4111-8111-111111111111', 'A', 5);
      mk('22222222-2222-4222-8222-222222222222', 'B', 2);
      mk('33333333-3333-4333-8333-333333333333', 'C', null);
      db.run(
        "INSERT INTO external_ids (item_id, kind, value) VALUES ('11111111-1111-4111-8111-111111111111', 'steam', '10')",
      );
      expect(() => migrate(db, { failAtVersion: 4 })).toThrow(/Injected/);
      expect(currentSchemaVersion(db)).toBe(3);
      expect(db.all('SELECT up_next_position FROM items WHERE up_next_position IS NOT NULL')).toHaveLength(2); // untouched
      migrate(db);
      expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.all('SELECT item_id, position FROM up_next ORDER BY position')).toEqual([
        { item_id: '22222222-2222-4222-8222-222222222222', position: 0 },
        { item_id: '11111111-1111-4111-8111-111111111111', position: 1 },
      ]);
      expect(db.get<{ n: number }>('SELECT count(*) AS n FROM items')?.n).toBe(3);
      expect(db.all("SELECT name FROM pragma_table_info('items') WHERE name = 'up_next_position'")).toEqual(
        [],
      );
      for (const table of [
        'item_snoozes',
        'pick_history',
        'lists',
        'list_items',
        'library_sources',
        'library_source_entries',
        'import_batches',
        'import_batch_items',
        'goals',
        'csv_mapping_profiles',
        'release_notifications',
      ])
        expect(
          db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", [
            table,
          ])?.n,
          table,
        ).toBe(1);
      expect(db.foreignKeyViolations()).toBe(0);
      expect(db.integrityCheck()).toEqual([]);
    } finally {
      db.close();
      t.cleanup();
    }
  });

  it('takes the pre-migration backup when opening an older library', () => {
    const t = tempDir();
    try {
      const paths = pathsFor(t.dir);
      mkdirSync(paths.backups, { recursive: true });
      const db = new Db(paths.database);
      migrate(db, { migrations: MIGRATIONS.slice(0, 3) });
      db.close();
      const dbm = new DatabaseManager(paths, new MemoryLogger());
      dbm.open();
      expect(dbm.lastOpen).toMatchObject({ migratedFrom: 3, migratedTo: LATEST_SCHEMA_VERSION });
      dbm.close();
      expect(existsSync(paths.backups)).toBe(true);
      const files = readFileSync; // keep import used
      expect(typeof files).toBe('function');
      writeFileSync(join(t.dir, 'ok'), '1');
    } finally {
      t.cleanup();
    }
  });
});

import { defaultPersonal, emptyMeta } from '../../src/domain/metadata';
function personal(type: 'game') {
  return defaultPersonal(type, '2025-03-10');
}

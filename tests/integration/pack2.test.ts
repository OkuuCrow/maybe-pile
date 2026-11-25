/**
 * Expansion Pack 2 integration tests: isolated temp databases, fake HTTP, fake clock.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../../src/db/connection';
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../../src/db/migrate';
import { buildJsonExport } from '../../src/main/services/export-service';
import { ExportEnvelopeSchema } from '../../src/main/services/portable-format';
import { tempDir } from '../helpers/db';
import { image, json, PNG_1PX } from '../helpers/http';
import { makeFeatureEnv, type FeatureEnv } from '../helpers/features';
import { SessionsService } from '../../src/main/services/sessions-service';
import { gzipSync } from 'fflate';
import { defaultPersonal, emptyMeta } from '../../src/domain/metadata';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function env(): FeatureEnv {
  const e = makeFeatureEnv();
  cleanups.push(() => e.cleanup());
  return e;
}

function addItem(
  e: FeatureEnv,
  type: 'movie' | 'tv' | 'game' | 'book' | 'anime',
  title: string,
  extra: Record<string, unknown> = {},
) {
  const r = e.library.create({
    type,
    meta: { ...emptyMetaFor(title), ...extra },
    personal: { ...defaultPersonalFor(type, e) },
    seasons: [],
    milestones: [],
    allowDuplicate: true,
  } as never);
  if (r.kind !== 'created') throw new Error('not created');
  return r.item;
}
const emptyMetaFor = (t: string) => emptyMeta(t);
const defaultPersonalFor = (type: never | string, e: FeatureEnv) =>
  defaultPersonal(type as never, e.library.today());

/* ---------------------------------------------------------------- migration */

describe('migration v4 → v5', () => {
  it('upgrades with data: runs back-filled from passes, artwork back-filled as selected cover, FK integrity kept', () => {
    const t = tempDir();
    const db = new Db(join(t.dir, 'library.sqlite'));
    cleanups.push(() => (db.close(), t.cleanup()));
    migrate(db, { migrations: MIGRATIONS.slice(0, 4) });
    const now = '2024-05-01T00:00:00.000Z';
    const id = '33333333-3333-4333-8333-333333333333';
    db.run(
      "INSERT INTO artwork (id, source, remote_url, provider_id, created_at) VALUES ('a1', 'remote', 'https://image.tmdb.org/t/p/w500/x.jpg', 'tmdb', ?)",
      [now],
    );
    db.run(
      `INSERT INTO items (id, type, title, sort_title, title_key, status, rating, date_added, date_completed, pass, artwork_id, created_at, updated_at)
       VALUES (?, 'tv', 'Twin Peaks', 'twin peaks', 'twin peaks', 'in_progress', 8, '2024-01-01', '2024-03-01', 2, 'a1', ?, ?)`,
      [id, now, now],
    );
    db.run('INSERT INTO tv_details (item_id) VALUES (?)', [id]);
    db.run("INSERT INTO external_ids (item_id, kind, value) VALUES (?, 'tmdb', '1920')", [id]);
    // FTS rows are keyed by items.rid; index the row at v4 to prove rid survives the v5 rebuild.
    db.run(
      "INSERT INTO items_fts(rowid, title, alt_titles, creators, tags, notes) SELECT rid, title, '', '', '', '' FROM items",
    );
    const ridBefore = db.get<{ rid: number }>('SELECT rid FROM items')?.rid;
    migrate(db);
    expect(db.get<{ rid: number }>('SELECT rid FROM items')?.rid).toBe(ridBefore);
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(LATEST_SCHEMA_VERSION);
    const runs = db.all<{ run_number: number; status: string; date_completed: string | null }>(
      'SELECT run_number, status, date_completed FROM item_runs ORDER BY run_number',
    );
    expect(runs).toEqual([
      { run_number: 1, status: 'completed', date_completed: '2024-03-01' },
      { run_number: 2, status: 'in_progress', date_completed: null },
    ]);
    expect(db.get('SELECT item_id, slot, selected, user_selected, cache_state FROM artwork')).toEqual({
      item_id: id,
      slot: 'cover',
      selected: 1,
      user_selected: 0,
      cache_state: 'remote-only',
    });
    expect(db.all('SELECT name FROM moods WHERE builtin_key IS NOT NULL')).toHaveLength(9);
    // New kinds/types are accepted after the rebuild; old CHECKs still enforced.
    db.run("INSERT INTO external_ids (item_id, kind, value) VALUES (?, 'kitsu', '1')", [id]);
    expect(() => db.run("UPDATE items SET type = 'manga' WHERE id = ?", [id])).toThrow(/CHECK/);
    db.run("UPDATE items SET type = 'anime' WHERE id = ?", [id]);
    expect(db.foreignKeyViolations()).toBe(0);
    expect(db.integrityCheck()).toEqual([]);
    // FTS still works for the rebuilt items table.
    expect(db.all('SELECT rowid FROM items_fts WHERE items_fts MATCH ?', ['twin'])).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- artwork picker */

describe('Artwork Picker', () => {
  it('gathers candidates, applies the user choice, and never lets automatic picks replace it', async () => {
    const e = env();
    e.secrets.set('tmdb', 'apiKey', 'k'.repeat(32));
    const item = addItem(e, 'movie', 'Inception', { externalIds: [{ kind: 'tmdb', value: '27205' }] });
    e.http.on('/movie/27205/images', () =>
      json({
        posters: [
          { file_path: '/p1aaaa.jpg', width: 500, height: 750, iso_639_1: 'en', vote_average: 9 },
          { file_path: '/p2aaaa.jpg', width: 500, height: 750, iso_639_1: 'en', vote_average: 1 },
        ],
        backdrops: [{ file_path: '/b1aaaa.jpg', width: 1920, height: 1080, iso_639_1: null }],
        logos: [],
      }),
    );
    const g = await e.f.artworkPicker.gallery(item.id);
    expect(g.sources.find((s) => s.sourceId === 'tmdb')?.state).toBe('ok');
    expect(g.sources.find((s) => s.sourceId === 'fanart')?.state).toBe('not-configured');
    expect(g.candidates.every((c) => c.thumbUrl.startsWith('maybepile-art://preview/'))).toBe(true);
    const second = g.candidates.find(
      (c) => c.slot === 'cover' && c.width === 500 && g.candidates.indexOf(c) === 1,
    )!;
    const chosen = await e.f.artworkPicker.choose(item.id, second.token);
    const cover = chosen.slots.find((s) => s.slot === 'cover')!;
    expect(cover).toMatchObject({ userSelected: true, cacheState: 'remote-only' });
    // Auto-pick would prefer the higher-scored poster, but must keep the user's choice.
    const auto = await e.f.artworkPicker.autoPick(item.id, ['cover', 'background']);
    expect(auto.kept).toEqual(['cover']);
    expect(auto.updated).toEqual(['background']);
    const slots = e.f.artworkPicker.slots(item.id);
    expect(slots.find((s) => s.slot === 'cover')?.artworkId).toBe(cover.artworkId);
    // GC keeps selected non-cover slot art.
    e.providers.artwork.gc();
    expect(e.f.artworkPicker.slots(item.id).find((s) => s.slot === 'background')?.artworkId).not.toBeNull();
    // Revert: user flag cleared, auto pick takes the best-ranked poster.
    const reverted = await e.f.artworkPicker.revert(item.id, 'cover');
    expect(reverted.find((s) => s.slot === 'cover')).toMatchObject({ userSelected: false });
    expect(
      e.db.get<{ remote_url: string }>(
        "SELECT remote_url FROM artwork WHERE item_id = ? AND slot = 'cover' AND selected = 1",
        [item.id],
      )?.remote_url,
    ).toContain('/p1aaaa.jpg');
    // Expired/foreign tokens are rejected.
    await expect(e.f.artworkPicker.choose(item.id, 'f'.repeat(32))).rejects.toMatchObject({
      safe: { code: 'NOT_FOUND' },
    });
  });

  it('caches cache-allowed images only after safety checks, with SHA-256 file names', async () => {
    const e = env();
    const item = addItem(e, 'book', 'Dune');
    e.http.on('covers.openlibrary.org', () => image(PNG_1PX));
    const r = await e.providers.artwork.adopt(
      item.id,
      'cover',
      {
        url: 'https://covers.openlibrary.org/b/id/1-L.jpg',
        sourceId: 'openlibrary',
        policy: 'cache-allowed',
        hosts: ['covers.openlibrary.org'],
        attribution: null,
        licenseNote: null,
        assetId: null,
        width: null,
        height: null,
        language: null,
        adult: false,
      },
      true,
    );
    const row = e.db.get<{ file_name: string; sha256: string; width: number }>(
      'SELECT file_name, sha256, width FROM artwork WHERE id = ?',
      [r.artworkId],
    )!;
    expect(row.file_name).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(row.sha256).toBe(row.file_name.slice(0, 64));
    expect(row.width).toBe(1);
    // An SVG served as image/* is never stored (magic bytes decide) → falls back to a remote reference.
    e.http.on('covers.openlibrary.org/b/id/2', () =>
      image(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'),
    );
    const r2 = await e.providers.artwork.adopt(
      item.id,
      'banner',
      {
        url: 'https://covers.openlibrary.org/b/id/2-L.jpg',
        sourceId: 'openlibrary',
        policy: 'cache-allowed',
        hosts: ['covers.openlibrary.org'],
        attribution: null,
        licenseNote: null,
        assetId: null,
        width: null,
        height: null,
        language: null,
        adult: false,
      },
      true,
    );
    expect(r2.warning).toMatch(/could not be downloaded/);
    expect(
      e.db.get<{ source: string }>('SELECT source FROM artwork WHERE id = ?', [r2.artworkId])?.source,
    ).toBe('remote');
  });
});

/* ---------------------------------------------------------------- anime import */

describe('anime import via Kitsu', () => {
  it('imports with title preference, studios, relation suggestions and allowlisted streaming links', async () => {
    const e = env();
    // Pre-existing sequel in the library, matched by Kitsu id.
    const sequel = addItem(e, 'anime', 'Frieren Season 2', {
      externalIds: [{ kind: 'kitsu', value: '50000' }],
    });
    e.http
      .on('/anime/41370?include', () =>
        json({
          data: {
            id: '41370',
            type: 'anime',
            attributes: {
              canonicalTitle: 'Sousou no Frieren',
              titles: {
                en: 'Frieren: Beyond Journey’s End',
                en_jp: 'Sousou no Frieren',
                ja_jp: '葬送のフリーレン',
              },
              startDate: '2023-09-29',
              subtype: 'TV',
              status: 'finished',
              episodeCount: 2,
              episodeLength: 24,
              nsfw: false,
            },
            relationships: {
              mediaRelationships: { data: [{ id: 'r1', type: 'mediaRelationships' }] },
              streamingLinks: {
                data: [
                  { id: 's1', type: 'streamingLinks' },
                  { id: 's2', type: 'streamingLinks' },
                ],
              },
            },
          },
          included: [
            {
              id: 'r1',
              type: 'mediaRelationships',
              attributes: { role: 'sequel' },
              relationships: { destination: { data: { id: '50000', type: 'anime' } } },
            },
            {
              id: '50000',
              type: 'anime',
              attributes: { canonicalTitle: 'Frieren Season 2', titles: {}, nsfw: false },
            },
            {
              id: 's1',
              type: 'streamingLinks',
              attributes: { url: 'https://www.crunchyroll.com/series/frieren', subs: ['en'], dubs: ['en'] },
              relationships: { streamer: { data: { id: 'st', type: 'streamers' } } },
            },
            {
              id: 's2',
              type: 'streamingLinks',
              attributes: { url: 'https://phish.example.com/x', subs: [], dubs: [] },
              relationships: { streamer: { data: { id: 'st', type: 'streamers' } } },
            },
            { id: 'st', type: 'streamers', attributes: { siteName: 'Crunchyroll' } },
          ],
        }),
      )
      .on('/anime/41370/episodes', () => json({ data: [], links: {} }));
    const p = await e.providers.preview({ providerId: 'kitsu', id: '41370', type: 'anime' });
    expect(p.meta.title).toBe('Sousou no Frieren'); // default title language: romaji
    const r = await e.providers.importPreviewed({
      previewToken: p.token,
      status: 'planned',
      tags: [],
      allowDuplicate: true,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const sug = e.f.extras.suggestions(r.item.id);
    expect(sug).toHaveLength(1);
    expect(sug[0]).toMatchObject({ relation: 'sequel', targetItemId: sequel.id });
    e.f.extras.resolveSuggestion(r.item.id, sug[0]!.id, true);
    expect(e.f.extras.relations(r.item.id)[0]).toMatchObject({ relation: 'sequel', otherItemId: sequel.id });
    expect(e.f.extras.relations(sequel.id)[0]).toMatchObject({ relation: 'prequel', otherItemId: r.item.id });
    expect(e.f.extras.streaming(r.item.id).map((l) => l.url)).toEqual([
      'https://www.crunchyroll.com/series/frieren',
    ]);
  });

  it('hides adult titles unless enabled', async () => {
    const e = env();
    e.http.on('/anime/7?include', () =>
      json({
        data: { id: '7', type: 'anime', attributes: { canonicalTitle: 'X', nsfw: true } },
        included: [],
      }),
    );
    await expect(e.providers.preview({ providerId: 'kitsu', id: '7', type: 'anime' })).rejects.toMatchObject({
      safe: { code: 'PROVIDER_NOT_FOUND' },
    });
  });
});

/* ---------------------------------------------------------------- sessions & hours */

describe('sessions', () => {
  it('survive a restart, keep one timer running, and only touch hours when the source is sessions', () => {
    const e = env();
    const game = addItem(e, 'game', 'Hades');
    const other = addItem(e, 'game', 'Celeste');
    const s = e.f.sessions.start(game.id);
    e.clock.advance(30 * 60_000);
    // "Restart": a brand-new service instance reads the same DB state.
    const fresh = new SessionsService(e.ctx);
    expect(fresh.open()[0]?.seconds).toBe(1800);
    // Starting another timer pauses the first.
    fresh.start(other.id);
    expect(
      fresh
        .open()
        .map((x) => x.state)
        .sort(),
    ).toEqual(['paused', 'running']);
    e.clock.advance(60 * 60_000);
    expect(fresh.stop(s.id, null, null).seconds).toBe(1800);
    // Manual hours source (default): no progress entry created.
    expect(
      e.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM progress_events WHERE item_id = ? AND kind = 'hours'",
        [game.id],
      )?.n,
    ).toBe(0);
    e.f.extras.setPrefs(game.id, { hoursSource: 'sessions' });
    fresh.logManual(game.id, '2025-03-01T10:00:00.000Z', 5400, null);
    const hours = e.db.get<{ value: number }>(
      "SELECT value FROM progress_events WHERE item_id = ? AND kind = 'hours' ORDER BY seq DESC LIMIT 1",
      [game.id],
    );
    expect(hours?.value).toBe(2); // 30 min + 90 min
    expect(() => fresh.logManual(game.id, '2030-01-01T00:00:00.000Z', 600, null)).toThrow(/future/);
  });
});

/* ---------------------------------------------------------------- moods, pile time, value, availability, recs */

describe('pile features', () => {
  it('moods filter What fits; pile value per currency; leaving soon window; recommendations explain', () => {
    const e = env();
    const movie = addItem(e, 'movie', 'Paprika', {
      runtimeMinutes: 90,
      genres: ['Animation'],
      creators: [{ name: 'Satoshi Kon', role: 'director' }],
    });
    const long = addItem(e, 'movie', 'Long', { runtimeMinutes: 400 });
    const fav = addItem(e, 'movie', 'Perfect Blue', {
      runtimeMinutes: 81,
      genres: ['Animation'],
      creators: [{ name: 'Satoshi Kon', role: 'director' }],
    });
    e.library.setStatus({
      id: fav.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    e.library.setRating(fav.id, 9);
    const cozy = e.f.moods.list().find((m) => m.name === 'Cozy') ?? e.f.moods.list()[0]!;
    e.f.moods.setForItem(movie.id, [cozy.id]);
    expect(e.f.pileTime.fits(120, null).map((r) => r.id)).toEqual([movie.id]);
    expect(e.f.moods.itemsWithMoods([cozy.id]).has(movie.id)).toBe(true);
    expect(e.f.pileTime.totals().remainingMinutes).toBe(490);

    e.f.value.add(movie.id, {
      amountMinor: 1499,
      currency: 'USD',
      purchasedOn: null,
      store: 'Shop',
      edition: null,
      notes: null,
    });
    e.f.value.add(long.id, {
      amountMinor: 1000,
      currency: 'EUR',
      purchasedOn: null,
      store: null,
      edition: null,
      notes: null,
    });
    expect(e.f.value.summary().map((s) => [s.currency, s.spentMinor])).toEqual([
      ['USD', 1499],
      ['EUR', 1000],
    ]);

    e.f.availability.addService('Crunchyroll', 'subscription');
    const svc = e.f.availability.services()[0]!;
    e.f.availability.add(movie.id, {
      kind: 'subscription',
      serviceId: svc.id,
      platform: null,
      availableUntil: '2025-03-20',
      remindDays: null,
      notes: null,
    });
    e.f.availability.add(long.id, {
      kind: 'subscription',
      serviceId: svc.id,
      platform: null,
      availableUntil: '2025-06-01',
      remindDays: null,
      notes: null,
    });
    expect(e.f.availability.leavingSoon().map((x) => [x.itemId, x.daysLeft])).toEqual([[movie.id, 10]]);
    expect(e.f.availability.accessibleItemIds().has(movie.id)).toBe(true);
    e.f.availability.updateService(svc.id, { active: false });
    expect(e.f.availability.accessibleItemIds().has(movie.id)).toBe(false);

    const recs = e.f.recommendations.list(5);
    expect(recs[0]?.itemId).toBe(movie.id);
    expect(recs[0]?.reasons.some((r) => r.text.includes('Satoshi Kon'))).toBe(true);
    e.f.recommendations.feedback(movie.id, 'dismissed');
    expect(e.f.recommendations.list(5).some((r) => r.itemId === movie.id)).toBe(false);
    e.clock.advance(31 * 86_400_000);
    expect(e.f.recommendations.list(5).some((r) => r.itemId === movie.id)).toBe(true);
  });

  it('franchise next-in-series and runs history', () => {
    const e = env();
    const a = addItem(e, 'anime', 'Part 1');
    const b = addItem(e, 'anime', 'Part 2');
    const f = e.f.extras.createFranchise('Saga', [a.id, b.id]);
    expect(f.nextItemId).toBe(a.id);
    e.library.setStatus({
      id: a.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    expect(e.f.extras.franchise(f.id).nextItemId).toBe(b.id);
    // Rewatch: back to in progress with a new run; run 1 keeps its completion.
    e.library.setStatus({
      id: a.id,
      status: 'in_progress',
      startNewPass: true,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    const runs = e.f.extras.runs(a.id);
    expect(runs.map((r) => [r.runNumber, r.status, r.current])).toEqual([
      [1, 'completed', false],
      [2, 'in_progress', true],
    ]);
    expect(e.f.stats.heatmap(2025).total).toBe(1);
  });
});

/* ---------------------------------------------------------------- merge */

describe('duplicate merge', () => {
  it('finds, merges and undoes exactly', () => {
    const e = env();
    const a = addItem(e, 'anime', 'Cowboy Bebop', { externalIds: [{ kind: 'mal', value: '1' }] });
    const b = addItem(e, 'anime', 'Cowboy Bebop', {
      description: 'Space bounty hunters.',
      externalIds: [{ kind: 'kitsu', value: '1' }],
    });
    e.f.value.add(b.id, {
      amountMinor: 999,
      currency: 'USD',
      purchasedOn: null,
      store: null,
      edition: null,
      notes: null,
    });
    const before = JSON.stringify(e.db.all('SELECT * FROM items ORDER BY id'));
    const pairs = e.f.merge.findPairs();
    expect(pairs).toHaveLength(1);
    const prev = e.f.merge.preview(a.id, b.id);
    expect(prev.rows.map((r) => r.field)).toContain('description');
    const { snapshotId } = e.f.merge.merge(a.id, b.id, { fields: { description: 'b' } });
    const kept = e.library.get(a.id);
    expect(kept.meta.description).toBe('Space bounty hunters.');
    expect(kept.meta.externalIds.map((x) => x.kind).sort()).toEqual(['kitsu', 'mal']);
    expect(e.f.value.list(a.id)).toHaveLength(1);
    expect(e.db.get('SELECT deleted_at FROM items WHERE id = ?', [b.id])).not.toEqual({ deleted_at: null });
    expect(e.f.merge.resolveId(b.id)).toBe(a.id);
    e.f.merge.undo(snapshotId);
    expect(JSON.stringify(e.db.all('SELECT * FROM items ORDER BY id'))).toBe(before);
    expect(e.f.value.list(b.id)).toHaveLength(1);
    expect(e.f.value.list(a.id)).toHaveLength(0);
    expect(e.db.foreignKeyViolations()).toBe(0);
    expect(() => e.f.merge.undo(snapshotId)).toThrow();
  });

  it('refuses undo when the kept item changed afterwards', () => {
    const e = env();
    const a = addItem(e, 'movie', 'Heat');
    const b = addItem(e, 'movie', 'Heat');
    const { snapshotId } = e.f.merge.merge(a.id, b.id, { fields: {} });
    e.clock.advance(1000);
    e.library.setRating(a.id, 6);
    expect(() => e.f.merge.undo(snapshotId)).toThrow(/changed after the merge/);
  });
});

/* ---------------------------------------------------------------- export / import */

describe('portability (formatVersion 3)', () => {
  it('exports the pack2 section without secrets and round-trips it into a fresh library', async () => {
    const e = env();
    e.secrets.set('fanart', 'clientId', 'SECRET-KEY-VALUE-123456');
    const it1 = addItem(e, 'anime', 'Mushishi', {
      titleRomaji: 'Mushishi',
      animeFormat: 'tv',
      episodeCount: 26,
    });
    e.f.value.add(it1.id, {
      amountMinor: 2500,
      currency: 'JPY',
      purchasedOn: '2025-01-01',
      store: null,
      edition: null,
      notes: null,
    });
    e.f.moods.setForItem(it1.id, [e.f.moods.list()[0]!.id]);
    e.f.pileTime.setManual(it1.id, 600);
    e.f.extras.setPrefs(it1.id, { spoilerMode: 'shield' });
    const env1 = buildJsonExport(e.db, '2.0.0', new Date('2025-03-10T00:00:00Z'));
    const text = JSON.stringify(env1);
    expect(text).not.toContain('SECRET-KEY-VALUE');
    expect(env1.formatVersion).toBe(3);
    expect(ExportEnvelopeSchema.safeParse(env1).success).toBe(true);
    expect((env1.data.settings as Record<string, unknown>)['sync']).toBeUndefined();

    const e2 = env();
    const p = e2.f.importer.storePreview('json', 'x.json', env1.data.items as never, env1 as never, [], {
      allowed: ['skip', 'duplicate'],
      formatLabel: 'JSON',
    } as never);
    await e2.f.importer.apply({ token: p.token, mode: 'merge', conflict: 'skip' } as never);
    const imported = e2.db.get<{ id: string }>("SELECT id FROM items WHERE title = 'Mushishi'")!;
    expect(e2.f.value.list(imported.id)[0]).toMatchObject({ amountMinor: 2500, currency: 'JPY' });
    expect(e2.f.moods.forItem(imported.id)).toHaveLength(1);
    expect(e2.f.pileTime.forItem(imported.id).manualMinutes).toBe(600);
    expect(e2.f.extras.prefs(imported.id).spoilerMode).toBe('shield');
    expect(e2.library.get(imported.id).meta).toMatchObject({ animeFormat: 'tv', episodeCount: 26 });
  });
});

/* ---------------------------------------------------------------- MAL XML import */

describe('MyAnimeList XML import', () => {
  const XML = `<?xml version="1.0"?><myanimelist>
<anime><series_animedb_id>1</series_animedb_id><series_title><![CDATA[Cowboy Bebop]]></series_title><series_type>TV</series_type><series_episodes>3</series_episodes><my_watched_episodes>2</my_watched_episodes><my_score>9</my_score><my_status>Watching</my_status><my_times_watched>0</my_times_watched></anime>
<anime><series_animedb_id>5</series_animedb_id><series_title>Mononoke</series_title><series_episodes>12</series_episodes><my_watched_episodes>12</my_watched_episodes><my_status>Completed</my_status><my_finish_date>2024-05-02</my_finish_date><my_times_watched>1</my_times_watched></anime>
</myanimelist>`;

  it('previews (gz too), imports watched episodes and rewatch runs, and undoes the batch', async () => {
    const e = env();
    const prev = e.f.tracker.preview('mal', [
      { name: 'animelist.xml.gz', bytes: gzipSync(new TextEncoder().encode(XML)) },
    ]);
    expect(prev.tracker).toBe('mal');
    const r = await e.f.importer.apply({ token: prev.token, mode: 'merge', conflict: 'skip' } as never);
    expect(r).toBeTruthy();
    const bebop = e.db.get<{ id: string; status: string; rating: number }>(
      "SELECT id, status, rating FROM items WHERE title = 'Cowboy Bebop'",
    )!;
    expect(bebop).toMatchObject({ status: 'in_progress', rating: 9 });
    expect(
      e.db.get<{ n: number }>('SELECT count(*) AS n FROM episodes WHERE item_id = ? AND watched = 1', [
        bebop.id,
      ])?.n,
    ).toBe(2);
    const mono = e.db.get<{ id: string; pass: number }>(
      "SELECT id, pass FROM items WHERE title = 'Mononoke'",
    )!;
    expect(mono.pass).toBe(2);
    const batch = e.f.batches.list()[0]!;
    expect(batch.kind).toBe('mal-xml');
    e.f.batches.undo(batch.id);
    expect(e.db.get<{ n: number }>('SELECT count(*) AS n FROM items WHERE deleted_at IS NULL')?.n).toBe(0);
  });

  it('rejects XXE payloads', () => {
    const e = env();
    expect(() =>
      e.f.tracker.preview('mal', [
        {
          name: 'x.xml',
          bytes: new TextEncoder().encode(
            '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///c:/windows/win.ini">]><myanimelist>&x;</myanimelist>',
          ),
        },
      ]),
    ).toThrow(/DOCTYPE/);
  });
});

/* ---------------------------------------------------------------- performance */

describe('performance at 10k items', () => {
  it('pile time, what fits, recommendations, duplicate pairs, value and heatmap stay fast', () => {
    const e = env();
    const db = e.db;
    const now = '2025-01-01T00:00:00.000Z';
    const types = ['movie', 'tv', 'game', 'book', 'anime'] as const;
    db.transaction(() => {
      db.run("INSERT INTO genres (name, name_key) VALUES ('Drama', 'drama'), ('Comedy', 'comedy')");
      for (let i = 0; i < 10_000; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const type = types[i % 5]!;
        const done = i % 3 === 0;
        db.run(
          `INSERT INTO items (id, type, title, sort_title, title_key, status, rating, date_added, date_completed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '2024-01-01', ?, ?, ?)`,
          [
            id,
            type,
            `Title ${i % 9000}`,
            `title ${i}`,
            `title ${i % 9000}`,
            done ? 'completed' : 'planned',
            done ? (i % 10) + 1 : null,
            done ? `2025-0${1 + (i % 9)}-1${i % 9}` : null,
            now,
            now,
          ],
        );
        if (type === 'movie')
          db.run('INSERT INTO movie_details (item_id, runtime_minutes) VALUES (?, ?)', [id, 80 + (i % 60)]);
        if (type === 'tv' || type === 'anime')
          db.run('INSERT INTO tv_details (item_id, episode_runtime) VALUES (?, 24)', [id]);
        if (type === 'book')
          db.run('INSERT INTO book_details (item_id, page_count) VALUES (?, ?)', [id, 200 + (i % 300)]);
        db.run('INSERT INTO item_genres (item_id, genre_id, position) VALUES (?, ?, 0)', [id, 1 + (i % 2)]);
        if (i % 7 === 0)
          db.run(
            `INSERT INTO purchases (id, item_id, amount_minor, currency, created_at, updated_at) VALUES (?, ?, 1999, 'USD', ?, ?)`,
            [`10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, id, now, now],
          );
      }
    });
    const timed = <T>(fn: () => T): [T, number] => {
      const t = performance.now();
      const r = fn();
      return [r, performance.now() - t];
    };
    const [totals, t1] = timed(() => e.f.pileTime.totals());
    const [, t2] = timed(() => e.f.pileTime.fits(120, null));
    const [, t3] = timed(() => e.f.recommendations.list(12));
    const [pairs, t4] = timed(() => e.f.merge.findPairs());
    const [, t5] = timed(() => e.f.value.summary());
    const [hm, t6] = timed(() => e.f.stats.heatmap(2025));
    expect(totals.itemsWithEstimate + totals.itemsWithout).toBe(6666);
    expect(pairs.length).toBeGreaterThan(0);
    expect(hm.total).toBeGreaterThan(0);
    // Generous ceilings for slow CI machines; locally these run far faster.
    for (const t of [t1, t2, t3, t4, t5, t6]) expect(t).toBeLessThan(8_000);
    console.info(
      `[perf 10k] pileTime ${t1.toFixed(0)}ms fits ${t2.toFixed(0)}ms recs ${t3.toFixed(0)}ms pairs ${t4.toFixed(0)}ms value ${t5.toFixed(0)}ms heatmap ${t6.toFixed(0)}ms`,
    );
  }, 60_000);
});

describe('Pick for Me with Expansion Pack 2 constraints', () => {
  it('filters by mood, finish-within (Pile Time) and series order, naming the constraint when empty', () => {
    const e = env();
    const a = addItem(e, 'movie', 'Part One', { runtimeMinutes: 100 });
    const b = addItem(e, 'movie', 'Part Two', { runtimeMinutes: 100 });
    const long = addItem(e, 'movie', 'Epic', { runtimeMinutes: 500 });
    e.f.extras.createFranchise('Duology', [a.id, b.id]);
    const mood = e.f.moods.list()[0]!;
    e.f.moods.setForItem(b.id, [mood.id]);
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
      excludeSkipped: false,
    };
    const roll = (extra: Record<string, unknown>) =>
      e.f.pick.roll({ constraints: { ...base, ...extra }, avoid: [], seed: 1 });
    expect(roll({ respectSeriesOrder: true, finishWithinMinutes: 120 }).pick?.id).toBe(a.id);
    expect(roll({ finishWithinMinutes: 120, moodIds: [mood.id] }).pick?.id).toBe(b.id);
    expect(roll({ finishWithinMinutes: 600 }).eligibleCount).toBe(3);
    const empty = roll({ respectSeriesOrder: true, moodIds: [mood.id] });
    expect(empty.pick).toBeNull();
    expect(empty.emptiedBy).toBe('seriesOrder');
    void long;
  });
});

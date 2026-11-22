import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtworkService, passthroughProcessor } from '../../src/main/services/artwork-service';
import { ProviderService } from '../../src/main/services/provider-service';
import { SecretsService, type SecretCipher } from '../../src/main/services/secrets-service';
import { CatalogService } from '../../src/main/services/catalog-service';
import { buildJsonExport, buildCsvExport } from '../../src/main/services/export-service';
import { BackupService } from '../../src/main/services/backup-service';
import { DatabaseManager } from '../../src/main/services/db-manager';
import { writeSettings } from '../../src/db/repositories/config-repo';
import { defaultPersonal, emptyMeta } from '../../src/domain/metadata';
import { clearIgdbTokenCache } from '../../src/providers/igdb';
import { FakeHttp, image, instantLimiter, json, PNG_1PX } from '../helpers/http';
import { makeEnv, type TestEnv } from '../helpers/services';

const TMDB_KEY = '0123456789abcdef0123456789abcdef';

/** Reversible fake "OS encryption". */
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
};

let env: TestEnv;
let http: FakeHttp;
let secrets: SecretsService;
let artwork: ArtworkService;
let svc: ProviderService;

function movieDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 603,
    title: 'The Matrix',
    overview: 'A hacker learns the truth.',
    release_date: '1999-03-30',
    runtime: 136,
    imdb_id: 'tt0133093',
    genres: [{ name: 'Action' }],
    poster_path: '/m.jpg',
    credits: { crew: [{ name: 'Lana Wachowski', job: 'Director' }], cast: [] },
    ...overrides,
  };
}

beforeEach(() => {
  env = makeEnv();
  http = new FakeHttp()
    .on('/search/movie', () =>
      json({
        results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-30', poster_path: '/m.jpg' }],
      }),
    )
    .on('/movie/603/watch/providers', () =>
      json({
        results: {
          US: {
            link: 'https://www.themoviedb.org/movie/603/watch?locale=US',
            flatrate: [{ provider_name: 'Max' }],
          },
        },
      }),
    )
    .on('/movie/603?', () => json(movieDetail()))
    .on('image.tmdb.org', () => image())
    .on('/search/shows', () => json([{ show: { id: 1, name: 'Show', premiered: '2020-01-01' } }]))
    .on('/shows/1', () =>
      json({
        id: 1,
        name: 'Show',
        premiered: '2020-01-01',
        status: 'Running',
        image: { original: 'https://static.tvmaze.com/s.jpg' },
        _embedded: {
          seasons: [{ number: 1, episodeOrder: 2 }],
          episodes: [
            { season: 1, number: 1, name: 'One' },
            { season: 1, number: 2, name: 'Two' },
          ],
        },
      }),
    )
    .on('static.tvmaze.com', () => image());
  secrets = new SecretsService(join(env.dir, 'secrets.json'), cipher, env.log, {});
  artwork = new ArtworkService(env.ctx, passthroughProcessor, http);
  svc = new ProviderService(env.ctx, http, secrets, env.library, artwork, () => instantLimiter());
});
afterEach(() => env.cleanup());

describe('provider search → preview → import', () => {
  it('requires configuration for keyed providers and lists provider info without secrets', async () => {
    await expect(
      svc.search({ providerId: 'tmdb', type: 'movie', query: 'matrix', year: null }),
    ).rejects.toMatchObject({ safe: { code: 'PROVIDER_NOT_CONFIGURED' } });
    secrets.set('tmdb', 'apiKey', TMDB_KEY);
    const info = svc.list().find((p) => p.id === 'tmdb');
    expect(info).toMatchObject({ configured: true, keysSet: { apiKey: true }, cachingPolicy: 'remote-only' });
    expect(JSON.stringify(svc.list())).not.toContain(TMDB_KEY);
    // stored encrypted on disk
    expect(readFileSync(join(env.dir, 'secrets.json'), 'utf8')).not.toContain(TMDB_KEY);
  });

  it('imports a movie with provenance, attribution source and remote-only artwork', async () => {
    secrets.set('tmdb', 'apiKey', TMDB_KEY);
    const hits = await svc.search({ providerId: 'tmdb', type: 'movie', query: 'matrix', year: null });
    expect(hits[0]?.thumbUrl).toMatch(/^maybepile-art:\/\/preview\/[a-f0-9]{32}$/);
    const preview = await svc.preview(hits[0]?.ref ?? (undefined as never));
    expect(preview).toMatchObject({ providerName: 'TMDB', artworkPolicy: 'remote-only', duplicates: [] });
    expect(preview.attribution).toMatch(/not endorsed or certified by TMDB/);
    expect(preview.links.map((l) => l.kind)).toEqual(['imdb', 'tmdb']);
    const r = await svc.importPreviewed({
      previewToken: preview.token,
      status: 'completed',
      tags: ['classic'],
      allowDuplicate: false,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.item.provenance.title).toMatchObject({ origin: 'provider', providerId: 'tmdb' });
    expect(r.item.sources[0]).toMatchObject({ providerId: 'tmdb', providerRef: '603' });
    expect(r.item.artwork?.source).toBe('remote');
    expect(r.item.personal).toMatchObject({
      status: 'completed',
      dateCompleted: '2025-03-10',
      tags: ['classic'],
    });
    expect(http.calls.some((c) => c.url.includes('image.tmdb.org'))).toBe(false); // not downloaded (remote-only)
    // importing the same title again is flagged as a duplicate
    const again = await svc.preview(hits[0]?.ref ?? (undefined as never));
    expect(again.duplicates[0]?.reason).toBe('provider-id');
    const dup = await svc.importPreviewed({
      previewToken: again.token,
      status: 'planned',
      tags: [],
      allowDuplicate: false,
    });
    expect(dup.kind).toBe('duplicates');
    // expired/used tokens are rejected
    await expect(
      svc.importPreviewed({ previewToken: preview.token, status: 'planned', tags: [], allowDuplicate: true }),
    ).rejects.toMatchObject({ safe: { code: 'NOT_FOUND' } });
  });

  it('caches artwork for cache-allowed providers and keeps a reference if download fails', async () => {
    const hits = await svc.search({ providerId: 'tvmaze', type: 'tv', query: 'show', year: null });
    const p = await svc.preview(hits[0]?.ref ?? (undefined as never));
    expect(p.seasons).toEqual([{ number: 1, title: null, episodeCount: 2 }]);
    const r = await svc.importPreviewed({
      previewToken: p.token,
      status: 'planned',
      tags: [],
      allowDuplicate: false,
    });
    expect(r.kind === 'created' && r.item.artwork?.source).toBe('cache');
    expect(r.kind === 'created' && r.item.seasons[0]?.episodes).toHaveLength(2);

    http.on('static.tvmaze.com', () => ({
      status: 503,
      headers: { 'content-type': 'text/plain' },
      body: new Uint8Array(),
    }));
    env.library.softDelete(r.kind === 'created' ? [r.item.id] : []);
    const p2 = await svc.preview(hits[0]?.ref ?? (undefined as never));
    const r2 = await svc.importPreviewed({
      previewToken: p2.token,
      status: 'planned',
      tags: [],
      allowDuplicate: true,
    });
    expect(r2.kind === 'created' && r2.item.artwork?.source).toBe('remote');
    expect(r2.warnings[0]).toMatch(/could not be downloaded/);
    // retry later succeeds
    http.on('static.tvmaze.com', () => image());
    if (r2.kind === 'created') {
      await artwork.retry(r2.item.id, ['static.tvmaze.com']);
      expect(env.library.get(r2.item.id).artwork?.source).toBe('cache');
    }
  });

  it('provider outage leaves the library unchanged and explains what happened', async () => {
    secrets.set('tmdb', 'apiKey', TMDB_KEY);
    http.on('/search/movie', () => json({}, 429, { 'retry-after': '12' }));
    await expect(
      svc.search({ providerId: 'tmdb', type: 'movie', query: 'x', year: null }),
    ).rejects.toMatchObject({
      safe: { code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: 12 },
    });
    expect(env.library.dashboard().total).toBe(0);
  });

  it('disabled providers cannot be used', async () => {
    writeSettings(env.db, { providerEnabled: { tvmaze: false } });
    await expect(
      svc.search({ providerId: 'tvmaze', type: 'tv', query: 'x', year: null }),
    ).rejects.toMatchObject({ safe: { code: 'PROVIDER_UNAVAILABLE' } });
  });
});

describe('metadata refresh', () => {
  async function imported() {
    secrets.set('tmdb', 'apiKey', TMDB_KEY);
    const hits = await svc.search({ providerId: 'tmdb', type: 'movie', query: 'matrix', year: null });
    const p = await svc.preview(hits[0]?.ref ?? (undefined as never));
    const r = await svc.importPreviewed({
      previewToken: p.token,
      status: 'in_progress',
      tags: ['x'],
      allowDuplicate: false,
    });
    if (r.kind !== 'created') throw new Error('x');
    return r.item;
  }

  it('shows per-field comparison, defaults to keeping user edits and never touches personal data', async () => {
    const item = await imported();
    // user edits the title and adds notes/rating
    const edited = env.library.update({
      id: item.id,
      meta: { ...item.meta, title: 'Matrix (my cut)' },
      personal: { ...item.personal, notes: 'mine', rating: 10 },
    });
    expect(edited.provenance.title?.origin).toBe('user');
    http.on('/movie/603?', () =>
      json(movieDetail({ title: 'The Matrix (Remastered)', overview: 'New synopsis.', runtime: 138 })),
    );
    const prev = await svc.refreshPreview(item.id);
    const byField = Object.fromEntries(prev.rows.map((r) => [r.field, r]));
    expect(byField['title']).toMatchObject({
      current: 'Matrix (my cut)',
      incoming: 'The Matrix (Remastered)',
      userEdited: true,
      defaultChoice: 'keep',
      origin: 'user',
    });
    expect(byField['description']).toMatchObject({ userEdited: false, defaultChoice: 'update' });
    expect(byField['runtimeMinutes']).toMatchObject({ defaultChoice: 'update' });
    expect(prev.rows.map((r) => r.field)).not.toContain('genres'); // unchanged
    const after = svc.refreshApply({ token: prev.token, choices: { runtimeMinutes: 'keep' } });
    expect(after.meta.title).toBe('Matrix (my cut)');
    expect(after.meta.description).toBe('New synopsis.');
    expect(after.meta.runtimeMinutes).toBe(136);
    expect(after.personal).toMatchObject({ notes: 'mine', rating: 10, status: 'in_progress', tags: ['x'] });
    expect(after.provenance.title?.origin).toBe('user');
    expect(after.provenance.description?.origin).toBe('provider');
    const audit = new CatalogService(env.ctx).audit(item.id);
    expect(audit[0]).toMatchObject({ action: 'refresh', providerId: 'tmdb' });
    expect(audit[0]?.changes.map((c) => c.field)).toEqual(['description']);
    // a second refresh with the same provider data: the kept runtime is now user-diverged → keep by default
    const prev2 = await svc.refreshPreview(item.id);
    expect(prev2.rows.find((r) => r.field === 'runtimeMinutes')?.defaultChoice).toBe('keep');
  });

  it('refresh failures leave the item unchanged', async () => {
    const item = await imported();
    for (const fail of [() => json({}, 500), () => json({ nonsense: true }), () => json({}, 404)]) {
      http.on('/movie/603?', fail);
      await expect(svc.refreshPreview(item.id)).rejects.toMatchObject({
        safe: { code: expect.stringMatching(/^PROVIDER_/) },
      });
    }
    expect(env.library.get(item.id).meta).toEqual(item.meta);
  });

  it('TV refresh adds new episodes without touching watched state', async () => {
    const hits = await svc.search({ providerId: 'tvmaze', type: 'tv', query: 'show', year: null });
    const p = await svc.preview(hits[0]?.ref ?? (undefined as never));
    const r = await svc.importPreviewed({
      previewToken: p.token,
      status: 'planned',
      tags: [],
      allowDuplicate: false,
    });
    if (r.kind !== 'created') throw new Error('x');
    const e1 = r.item.seasons[0]?.episodes[0]?.id ?? '';
    env.progress.toggleEpisodes({ itemId: r.item.id, episodeIds: [e1], watched: true, scope: 'episode' });
    http.on('/shows/1', () =>
      json({
        id: 1,
        name: 'Show',
        status: 'Running',
        _embedded: {
          seasons: [
            { number: 1, episodeOrder: 3 },
            { number: 2, episodeOrder: null },
          ],
          episodes: [
            { season: 1, number: 1, name: 'One' },
            { season: 1, number: 2, name: 'Two (renamed)' },
            { season: 1, number: 3, name: 'Three' },
            { season: 2, number: 1, name: 'S2' },
          ],
        },
      }),
    );
    const prev = await svc.refreshPreview(r.item.id);
    expect(prev).toMatchObject({ newEpisodes: 2, updatedEpisodes: 1 });
    const after = svc.refreshApply({ token: prev.token, choices: {} });
    expect(after.seasons.map((s) => s.episodes.length)).toEqual([3, 1]);
    expect(after.seasons[0]?.episodes.find((e) => e.id === e1)?.watched).toBe(true);
    expect(after.progress.label).toBe('1 of 4 episodes (so far)');
  });
});

describe('where to watch', () => {
  it('shows only provider-supplied links; region changes; missing data → unavailable', async () => {
    const m = env.library.create({
      type: 'movie',
      meta: { ...emptyMeta('M'), externalIds: [{ kind: 'tmdb', value: '603' }] },
      personal: defaultPersonal('movie', '2025-01-01'),
      seasons: [],
      milestones: [],
      allowDuplicate: true,
    });
    if (m.kind !== 'created') throw new Error('x');
    expect((await svc.watchAvailability(m.item.id, 'US')).status).toBe('not-configured');
    secrets.set('tmdb', 'apiKey', TMDB_KEY);
    const us = await svc.watchAvailability(m.item.id, 'US');
    expect(us).toMatchObject({
      status: 'available',
      link: { kind: 'watch', url: 'https://www.themoviedb.org/movie/603/watch?locale=US' },
      providers: [{ name: 'Max', kind: 'stream' }],
    });
    expect(us.attribution).toMatch(/JustWatch/);
    const gb = await svc.watchAvailability(m.item.id, 'GB');
    expect(gb).toMatchObject({ status: 'unavailable', link: null });
    const book = env.library.create({
      type: 'book',
      meta: emptyMeta('B'),
      personal: defaultPersonal('book', '2025-01-01'),
      seasons: [],
      milestones: [],
      allowDuplicate: true,
    });
    if (book.kind === 'created')
      expect((await svc.watchAvailability(book.item.id, 'US')).status).toBe('not-applicable');
  });
});

describe('secrets never leak', () => {
  it('API keys are absent from logs, JSON/CSV exports and backups; env vars override', async () => {
    clearIgdbTokenCache();
    secrets.set('tmdb', 'apiKey', TMDB_KEY);
    await svc.search({ providerId: 'tmdb', type: 'movie', query: 'matrix', year: null });
    expect(env.log.text()).not.toContain(TMDB_KEY);
    expect(JSON.stringify(buildJsonExport(env.db, 'v', new Date()))).not.toContain(TMDB_KEY);
    expect(buildCsvExport(env.db, false)).not.toContain(TMDB_KEY);
    const dbm = new DatabaseManager(env.ctx.paths, env.log);
    const backup = new BackupService(env.ctx, dbm, artwork);
    const file = join(env.dir, 'b.mpbackup');
    backup.createBackup(file, { overwrite: false });
    expect(readFileSync(file).includes(Buffer.from(TMDB_KEY))).toBe(false);
    const envSecrets = new SecretsService(join(env.dir, 's2.json'), cipher, env.log, {
      MAYBEPILE_TMDB_API_KEY: 'fromenv',
    });
    expect(envSecrets.keysFor('tmdb').apiKey).toBe('fromenv');
    expect(envSecrets.isSet('tmdb', ['apiKey'])).toEqual({ apiKey: true });
  });

  it('falls back to plaintext storage with a reported warning when OS encryption is unavailable', () => {
    const s = new SecretsService(
      join(env.dir, 's3.json'),
      { ...cipher, isEncryptionAvailable: () => false },
      env.log,
      {},
    );
    expect(s.storage).toBe('plaintext-fallback');
    s.set('tmdb', 'apiKey', 'k'.repeat(20));
    expect(s.keysFor('tmdb').apiKey).toBe('k'.repeat(20));
    s.set('tmdb', 'apiKey', '');
    expect(s.keysFor('tmdb').apiKey).toBeUndefined();
  });

  it('loads a developer config file', () => {
    const cfgPath = join(env.dir, 'dev-keys.json');
    writeFileSync(cfgPath, JSON.stringify({ igdb: { clientId: 'cid', clientSecret: 'sec' } }));
    const s = new SecretsService(join(env.dir, 's4.json'), cipher, env.log, {
      MAYBEPILE_PROVIDER_CONFIG: cfgPath,
    });
    expect(s.keysFor('igdb')).toEqual({ clientId: 'cid', clientSecret: 'sec' });
    expect(existsSync(join(env.dir, 's4.json'))).toBe(false);
  });
});

describe('artwork', () => {
  it('validates local images, stores content-addressed files and garbage-collects', () => {
    const m = env.library.create({
      type: 'movie',
      meta: emptyMeta('M'),
      personal: defaultPersonal('movie', '2025-01-01'),
      seasons: [],
      milestones: [],
      allowDuplicate: true,
    });
    if (m.kind !== 'created') throw new Error('x');
    const p = join(env.dir, 'cover.png');
    writeFileSync(p, PNG_1PX);
    artwork.setLocalImage(m.item.id, p);
    const art = env.library.get(m.item.id).artwork;
    expect(art?.fullUrl).toMatch(/^maybepile-art:\/\/file\/[a-f0-9]{64}\.png$/);
    const txt = join(env.dir, 'evil.png');
    writeFileSync(txt, '<script>alert(1)</script> not an image');
    expect(() => artwork.setLocalImage(m.item.id, txt)).toThrow(/not a supported image/);
    expect(artwork.resolveFile('../library.sqlite')).toBeNull();
    expect(artwork.resolveFile('..%2F..%2Fx')).toBeNull();
    artwork.setItemArtwork(m.item.id, null);
    expect(artwork.gc().rows).toBe(0); // already collected by setItemArtwork
    expect(artwork.referencedFiles()).toEqual([]);
  });
});

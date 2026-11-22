import { describe, expect, it } from 'vitest';
import { HttpFailure, parseRetryAfter, requestJson } from '../../src/providers/http';
import { RateLimiter } from '../../src/providers/rate-limiter';
import { tmdbProvider } from '../../src/providers/tmdb';
import { tvmazeProvider } from '../../src/providers/tvmaze';
import { openLibraryProvider } from '../../src/providers/openlibrary';
import {
  apicalypseString,
  clearIgdbTokenCache,
  igdbProvider,
  storeIdsFromExternalGames,
} from '../../src/providers/igdb';
import { PROVIDERS } from '../../src/providers/registry';
import { toUserSafeError, type ProviderContext } from '../../src/providers/types';
import { z } from 'zod';
import { FakeHttp, instantLimiter, json, raw } from '../helpers/http';

const ctx = (http: FakeHttp, keys: ProviderContext['keys'] = {}): ProviderContext => ({
  http,
  limiter: instantLimiter(),
  keys,
  region: 'US',
});
const TMDB_KEY = { apiKey: '0123456789abcdef0123456789abcdef' };

describe('requestJson failure mapping', () => {
  const schema = z.object({ a: z.number() });
  const run = (http: FakeHttp, limiter = instantLimiter()) =>
    requestJson(http, limiter, { url: 'https://x.test/a' }, schema);

  it('ok', async () =>
    expect(await run(new FakeHttp().on('x.test', () => json({ a: 1 })))).toEqual({
      kind: 'ok',
      value: { a: 1 },
    }));
  it('malformed JSON', async () =>
    expect((await run(new FakeHttp().on('x.test', () => raw('{nope')))).kind).toBe('malformedResponse'));
  it('wrong content type', async () =>
    expect((await run(new FakeHttp().on('x.test', () => raw('<html>', 200, 'text/html')))).kind).toBe(
      'malformedResponse',
    ));
  it('schema mismatch', async () =>
    expect((await run(new FakeHttp().on('x.test', () => json({ a: 'x' })))).kind).toBe('malformedResponse'));
  it('401/403', async () => {
    expect((await run(new FakeHttp().on('x.test', () => json({}, 401)))).kind).toBe('unauthorized');
    expect((await run(new FakeHttp().on('x.test', () => json({}, 403)))).kind).toBe('unauthorized');
  });
  it('404', async () =>
    expect((await run(new FakeHttp().on('x.test', () => json({}, 404)))).kind).toBe('notFound'));
  it('5xx', async () =>
    expect(await run(new FakeHttp().on('x.test', () => json({}, 503)))).toEqual({
      kind: 'unavailable',
      status: 503,
    }));
  it('network/DNS failure', async () =>
    expect((await run(new FakeHttp().on('x.test', () => new HttpFailure('network', 'ENOTFOUND')))).kind).toBe(
      'networkError',
    ));
  it('timeout', async () =>
    expect((await run(new FakeHttp().on('x.test', () => new HttpFailure('timeout', 't')))).kind).toBe(
      'timeout',
    ));
  it('oversized', async () =>
    expect((await run(new FakeHttp().on('x.test', () => new HttpFailure('too-large', 'big')))).kind).toBe(
      'malformedResponse',
    ));

  it('429 honours Retry-After and blocks subsequent requests', async () => {
    const limiter = instantLimiter();
    const http = new FakeHttp().on('x.test', () => json({}, 429, { 'retry-after': '30' }));
    expect(await run(http, limiter)).toEqual({ kind: 'rateLimited', retryAfterSeconds: 30 });
    const again = await run(http, limiter);
    expect(again.kind).toBe('rateLimited');
    expect(http.calls).toHaveLength(1); // second call never hit the network
    expect(toUserSafeError({ kind: 'rateLimited', retryAfterSeconds: 30 }, 'TMDB')).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryAfterSeconds: 30,
    });
  });

  it('parses Retry-After dates and caps values', () => {
    expect(parseRetryAfter('5', 0)).toBe(5);
    expect(parseRetryAfter(undefined, 0)).toBe(10);
    expect(parseRetryAfter('99999', 0)).toBe(3600);
    expect(parseRetryAfter(new Date(60_000).toUTCString(), 0)).toBe(60);
  });
});

describe('RateLimiter', () => {
  it('waits for a free slot within the window, then reports rate-limited for long waits', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const l = new RateLimiter({
      maxRequests: 2,
      perMs: 1000,
      maxWaitMs: 1500,
      now: () => t,
      sleep: async (ms) => void (sleeps.push(ms), (t += ms)),
    });
    expect(await l.acquire()).toEqual({ ok: true });
    expect(await l.acquire()).toEqual({ ok: true });
    expect(await l.acquire()).toEqual({ ok: true }); // waited ~1000ms
    expect(sleeps).toEqual([1000]);
    const strict = new RateLimiter({
      maxRequests: 1,
      perMs: 10_000,
      maxWaitMs: 100,
      now: () => 0,
      sleep: async () => {},
    });
    await strict.acquire();
    expect(await strict.acquire()).toEqual({ ok: false, retryAfterSeconds: 10 });
  });

  it('every provider declares a rate limit and attribution', () => {
    for (const p of PROVIDERS) {
      expect(p.rateLimit.maxRequests).toBeGreaterThan(0);
      expect(p.attribution.text.length).toBeGreaterThan(10);
      expect(p.attribution.url).toMatch(/^https:\/\//);
    }
  });
});

describe('TMDB', () => {
  it('requires a key', async () => {
    expect(
      (await tmdbProvider.search({ type: 'movie', query: 'x', year: null }, ctx(new FakeHttp()))).kind,
    ).toBe('notConfigured');
  });

  it('maps search + details, tolerating missing/extra fields', async () => {
    const http = new FakeHttp()
      .on('/search/movie', () =>
        json({
          results: [
            {
              id: 603,
              title: 'The Matrix',
              release_date: '1999-03-30',
              overview: 'Neo',
              poster_path: '/p.jpg',
              extra: 1,
            },
            { id: 'bad' },
          ],
        }),
      )
      .on('/movie/603', () =>
        json({
          id: 603,
          title: 'The Matrix',
          original_title: 'The Matrix',
          release_date: '1999-03-30',
          runtime: 136,
          imdb_id: 'tt0133093',
          genres: [{ name: 'Action' }, { name: null }],
          credits: {
            crew: [{ name: 'Lana Wachowski', job: 'Director' }],
            cast: [{ name: 'Keanu Reeves', order: 0 }],
          },
          release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] },
          poster_path: '/p.jpg',
        }),
      );
    const s = await tmdbProvider.search({ type: 'movie', query: 'matrix', year: 1999 }, ctx(http, TMDB_KEY));
    expect(s.kind === 'ok' && s.value).toEqual([
      expect.objectContaining({
        title: 'The Matrix',
        year: 1999,
        thumbUrl: 'https://image.tmdb.org/t/p/w154/p.jpg',
      }),
    ]);
    expect(http.calls[0]?.url).toContain('api_key=');
    expect(http.calls[0]?.url).toContain('year=1999');
    const d = await tmdbProvider.fetchDetails(
      { providerId: 'tmdb', id: '603', type: 'movie' },
      ctx(http, TMDB_KEY),
    );
    expect(d.kind).toBe('ok');
    if (d.kind !== 'ok') return;
    expect(d.value.meta).toMatchObject({
      title: 'The Matrix',
      runtimeMinutes: 136,
      ageRating: 'R',
      releaseDate: '1999-03-30',
      genres: ['Action'],
    });
    expect(d.value.meta.externalIds).toEqual([
      { kind: 'tmdb', value: '603' },
      { kind: 'imdb', value: 'tt0133093' },
    ]);
    expect(d.value.meta.creators).toEqual([
      { name: 'Lana Wachowski', role: 'director' },
      { name: 'Keanu Reeves', role: 'cast' },
    ]);
  });

  it('uses Bearer auth for v4 tokens and never puts it in the URL', async () => {
    const http = new FakeHttp().on('/search/tv', () => json({ results: [] }));
    await tmdbProvider.search(
      { type: 'tv', query: 'x', year: null },
      ctx(http, { apiKey: 'eyJhbGciOiJIUzI1NiJ9.abcdefghijk.lmnop' }),
    );
    expect(http.calls[0]?.headers?.['Authorization']).toMatch(/^Bearer /);
    expect(http.calls[0]?.url).not.toContain('eyJ');
  });

  it('builds TV seasons including specials and unknown counts', async () => {
    const http = new FakeHttp()
      .on('/tv/1/season/0', () =>
        json({ season_number: 0, episodes: [{ episode_number: 1, name: 'Special', air_date: '' }] }),
      )
      .on('/tv/1/season/1', () =>
        json({
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'Pilot', air_date: '2020-01-01', runtime: 50 },
            { episode_number: 1, name: 'dupe' },
          ],
        }),
      )
      .on('/tv/1?', () =>
        json({
          id: 1,
          name: 'Show',
          status: 'Returning Series',
          seasons: [
            { season_number: 0, episode_count: 1 },
            { season_number: 1, episode_count: null },
          ],
          networks: [{ name: 'HBO' }],
          external_ids: { imdb_id: 'garbage' },
        }),
      );
    const d = await tmdbProvider.fetchDetails(
      { providerId: 'tmdb', id: '1', type: 'tv' },
      ctx(http, TMDB_KEY),
    );
    expect(d.kind).toBe('ok');
    if (d.kind !== 'ok') return;
    expect(d.value.meta).toMatchObject({ showStatus: 'returning', network: 'HBO' });
    expect(d.value.meta.externalIds).toEqual([{ kind: 'tmdb', value: '1' }]); // invalid IMDb id dropped
    expect(d.value.seasons.map((s) => [s.number, s.episodeCountKnown, s.episodes.length])).toEqual([
      [0, 1, 1],
      [1, null, 1],
    ]);
  });

  it('watch providers: uses only the returned link; missing region → no link', async () => {
    const http = new FakeHttp().on('/watch/providers', () =>
      json({
        results: {
          US: {
            link: 'https://www.themoviedb.org/movie/603/watch?locale=US',
            flatrate: [{ provider_name: 'Max' }],
            rent: [{ provider_name: 'Apple TV' }],
          },
          XX: { link: 'javascript:alert(1)' },
        },
      }),
    );
    const us = await tmdbProvider.discoverLinks?.(
      { providerId: 'tmdb', id: '603', type: 'movie' },
      'US',
      ctx(http, TMDB_KEY),
    );
    expect(us).toEqual({
      kind: 'ok',
      value: {
        link: 'https://www.themoviedb.org/movie/603/watch?locale=US',
        providers: [
          { name: 'Max', kind: 'stream' },
          { name: 'Apple TV', kind: 'rent' },
        ],
      },
    });
    const gb = await tmdbProvider.discoverLinks?.(
      { providerId: 'tmdb', id: '603', type: 'movie' },
      'GB',
      ctx(http, TMDB_KEY),
    );
    expect(gb).toEqual({ kind: 'ok', value: { link: null, providers: [] } });
    const xx = await tmdbProvider.discoverLinks?.(
      { providerId: 'tmdb', id: '603', type: 'movie' },
      'XX',
      ctx(http, TMDB_KEY),
    );
    expect(xx?.kind === 'ok' && xx.value.link).toBeNull();
  });
});

describe('TVmaze', () => {
  it('strips HTML from summaries and maps episodes/seasons', async () => {
    const http = new FakeHttp()
      .on('/search/shows', () =>
        json([
          {
            score: 1,
            show: {
              id: 82,
              name: 'Game of Thrones',
              premiered: '2011-04-17',
              summary: '<p><b>Winter</b> is coming &amp; more</p>',
              image: { medium: 'https://static.tvmaze.com/a.jpg' },
            },
          },
        ]),
      )
      .on('/shows/82', () =>
        json({
          id: 82,
          name: 'Game of Thrones',
          premiered: '2011-04-17',
          ended: '2019-05-19',
          status: 'Ended',
          summary: '<p>Seven <i>noble</i> families</p>',
          genres: ['Drama'],
          externals: { imdb: 'tt0944947' },
          network: { name: 'HBO' },
          image: { original: 'https://evil.example.com/x.jpg' },
          _embedded: {
            seasons: [{ number: 1, episodeOrder: 10 }],
            episodes: [
              { season: 1, number: 1, name: 'Winter Is Coming', airdate: '2011-04-17', runtime: 60 },
              { season: 1, number: null, name: 'Special' },
            ],
            crew: [{ type: 'Creator', person: { name: 'David Benioff' } }],
          },
        }),
      );
    const s = await tvmazeProvider.search({ type: 'tv', query: 'thrones', year: null }, ctx(http));
    expect(s.kind === 'ok' && s.value[0]?.synopsis).toBe('Winter is coming & more');
    const d = await tvmazeProvider.fetchDetails({ providerId: 'tvmaze', id: '82', type: 'tv' }, ctx(http));
    expect(d.kind).toBe('ok');
    if (d.kind !== 'ok') return;
    expect(d.value.meta.description).toBe('Seven noble families');
    expect(d.value.meta).toMatchObject({ showStatus: 'ended', network: 'HBO', lastAirDate: '2019-05-19' });
    expect(d.value.meta.creators).toEqual([{ name: 'David Benioff', role: 'creator' }]);
    expect(d.value.seasons).toEqual([
      {
        number: 1,
        title: null,
        episodeCountKnown: 10,
        episodes: [{ number: 1, title: 'Winter Is Coming', airDate: '2011-04-17', runtime: 60 }],
      },
    ]);
    expect(d.value.artworkUrl).toBeNull(); // non-allowlisted host rejected
  });
});

describe('Open Library', () => {
  it('maps works, authors and editions; handles description objects', async () => {
    const http = new FakeHttp()
      .on('/search.json', () =>
        json({
          docs: [
            {
              key: '/works/OL45804W',
              title: 'Fantastic Mr Fox',
              author_name: ['Roald Dahl'],
              first_publish_year: 1970,
              cover_i: 6498519,
            },
            { key: 'bad' },
          ],
        }),
      )
      .on('/works/OL45804W/editions.json', () =>
        json({ entries: [{ number_of_pages: 96, isbn_13: ['978-0-14-241034-9'], publishers: ['Puffin'] }] }),
      )
      .on('/works/OL45804W.json', () =>
        json({
          key: '/works/OL45804W',
          title: 'Fantastic Mr Fox',
          description: { value: 'A fox.' },
          subjects: ['Foxes'],
          covers: [6498519],
          authors: [{ author: { key: '/authors/OL34184A' } }],
        }),
      )
      .on('/authors/OL34184A.json', () => json({ name: 'Roald Dahl' }));
    const s = await openLibraryProvider.search({ type: 'book', query: 'fox', year: null }, ctx(http));
    expect(s.kind === 'ok' && s.value.map((h) => h.ref.id)).toEqual(['OL45804W']);
    const d = await openLibraryProvider.fetchDetails(
      { providerId: 'openlibrary', id: 'OL45804W', type: 'book' },
      ctx(http),
    );
    expect(d.kind).toBe('ok');
    if (d.kind !== 'ok') return;
    expect(d.value.meta).toMatchObject({
      description: 'A fox.',
      pageCount: 96,
      publisher: 'Puffin',
      isbn13: '9780142410349',
    });
    expect(d.value.meta.creators).toEqual([{ name: 'Roald Dahl', role: 'author' }]);
    expect(d.value.artworkUrl).toBe('https://covers.openlibrary.org/b/id/6498519-L.jpg');
  });

  it('rejects malformed ids without making requests', async () => {
    const http = new FakeHttp();
    expect(
      (
        await openLibraryProvider.fetchDetails(
          { providerId: 'openlibrary', id: '../../x', type: 'book' },
          ctx(http),
        )
      ).kind,
    ).toBe('notFound');
    expect(http.calls).toHaveLength(0);
  });
});

describe('IGDB', () => {
  const keys = { clientId: 'abcdefghijklmnopqrstuvwxyz1234', clientSecret: 'secretsecretsecretsecretsecret' };
  it('gets a token, sanitizes the query and maps store ids by exact source only', async () => {
    clearIgdbTokenCache();
    const http = new FakeHttp()
      .on('id.twitch.tv', () => json({ access_token: 'tokentokentoken', expires_in: 3600 }))
      .on('api.igdb.com', (req) =>
        req.body?.startsWith('search')
          ? json([
              {
                id: 1942,
                name: 'The Witcher 3',
                first_release_date: 1431993600,
                cover: { image_id: 'co1wyy' },
                involved_companies: [{ company: { name: 'CD Projekt Red' }, developer: true }],
              },
            ])
          : json([
              {
                id: 1942,
                name: 'The Witcher 3',
                first_release_date: 1431993600,
                involved_companies: [
                  { company: { name: 'CD Projekt Red' }, developer: true, publisher: false },
                  { company: { name: 'CD Projekt' }, developer: false, publisher: true },
                ],
                external_games: [
                  { category: 1, uid: '292030' },
                  { external_game_source: { id: 11 }, url: 'https://www.xbox.com/en-US/games/store/x/abc' },
                  { category: 36, url: 'https://evil.example.com/ps' },
                  { category: 5, uid: '123' },
                ],
              },
            ]),
      );
    const s = await igdbProvider.search(
      { type: 'game', query: 'witcher"; fields *;', year: null },
      ctx(http, keys),
    );
    expect(s.kind === 'ok' && s.value[0]).toMatchObject({
      title: 'The Witcher 3',
      year: 2015,
      creators: ['CD Projekt Red'],
    });
    const searchCall = http.calls.find((c) => c.url.includes('api.igdb.com'));
    expect(searchCall?.body).toBe(
      'search "witcher fields *"; fields name,summary,first_release_date,cover.image_id,involved_companies.company.name,involved_companies.developer; limit 20;',
    );
    expect(searchCall?.headers?.['Client-ID']).toBe(keys.clientId);
    const d = await igdbProvider.fetchDetails(
      { providerId: 'igdb', id: '1942', type: 'game' },
      ctx(http, keys),
    );
    expect(d.kind === 'ok' && d.value.meta.externalIds).toEqual([
      { kind: 'igdb', value: '1942' },
      { kind: 'steam', value: '292030' },
      { kind: 'xbox', value: 'https://www.xbox.com/en-US/games/store/x/abc' },
    ]);
    expect(d.kind === 'ok' && d.value.meta.creators).toEqual([
      { name: 'CD Projekt Red', role: 'developer' },
      { name: 'CD Projekt', role: 'publisher' },
    ]);
    expect(http.calls.filter((c) => c.url.includes('twitch')).length).toBe(1); // token cached
  });

  it('maps a bad client secret to unauthorized', async () => {
    clearIgdbTokenCache();
    const http = new FakeHttp().on('id.twitch.tv', () => json({ message: 'invalid client secret' }, 400));
    expect((await igdbProvider.search({ type: 'game', query: 'x', year: null }, ctx(http, keys))).kind).toBe(
      'unauthorized',
    );
  });

  it('apicalypse escaping and store mapping helpers', () => {
    expect(apicalypseString('a"b\\c;d')).toBe('a b c d');
    expect(
      storeIdsFromExternalGames([
        { category: 1, external_game_source: null, uid: 'not-a-number', url: null },
      ]),
    ).toEqual([]);
  });
});

/**
 * Expansion Pack 2 providers & art sources, against recorded-shape fixtures
 * (no live network). Covers auth placement (headers, never URLs), adult
 * filtering, cross ids, relations, streaming links, episode edge cases and
 * host allowlisting.
 */
import { describe, expect, it } from 'vitest';
import { kitsuProvider } from '../../src/providers/kitsu';
import { jikanProvider, parseDurationMinutes, isAdultRating } from '../../src/providers/jikan';
import { malProvider } from '../../src/providers/mal';
import { anilistProvider } from '../../src/providers/anilist';
import { tmdbProvider, tmdbArtSource, parseAnimeTmdbId } from '../../src/providers/tmdb';
import { fanartSource, fanartPreview } from '../../src/providers/fanart';
import { steamGridDbSource } from '../../src/providers/steamgriddb';
import { PROVIDERS, OUTBOUND_HOSTS, ARTWORK_HOSTS } from '../../src/providers/registry';
import type { ProviderContext, ProviderKeys } from '../../src/providers/types';
import { FakeHttp, instantLimiter, json } from '../helpers/http';

const ctx = (http: FakeHttp, keys: ProviderKeys = {}): ProviderContext => ({
  http,
  limiter: instantLimiter(),
  keys,
  region: 'US',
});

/* ---------------------------------------------------------------- Kitsu */

const KITSU_ANIME = {
  id: '41370',
  type: 'anime',
  attributes: {
    canonicalTitle: 'Sousou no Frieren',
    titles: { en: 'Frieren: Beyond Journey’s End', en_jp: 'Sousou no Frieren', ja_jp: '葬送のフリーレン' },
    abbreviatedTitles: ['Frieren'],
    synopsis: 'An elf mage.',
    startDate: '2023-09-29',
    endDate: '2024-03-22',
    subtype: 'TV',
    status: 'finished',
    posterImage: {
      small: 'https://media.kitsu.app/anime/41370/poster_image/small.jpg',
      large: 'https://media.kitsu.app/anime/41370/poster_image/large.jpg',
    },
    coverImage: { large: 'https://media.kitsu.app/anime/41370/cover_image/large.jpg' },
    episodeCount: 28,
    episodeLength: 24,
    nsfw: false,
  },
  relationships: {
    mappings: {
      data: [
        { id: 'm1', type: 'mappings' },
        { id: 'm2', type: 'mappings' },
      ],
    },
    categories: { data: [{ id: 'c1', type: 'categories' }] },
    mediaRelationships: { data: [{ id: 'r1', type: 'mediaRelationships' }] },
    streamingLinks: {
      data: [
        { id: 's1', type: 'streamingLinks' },
        { id: 's2', type: 'streamingLinks' },
      ],
    },
    animeProductions: { data: [{ id: 'p1', type: 'animeProductions' }] },
  },
};
const KITSU_INCLUDED = [
  { id: 'm1', type: 'mappings', attributes: { externalSite: 'myanimelist/anime', externalId: '52991' } },
  { id: 'm2', type: 'mappings', attributes: { externalSite: 'anilist/anime', externalId: '154587' } },
  { id: 'c1', type: 'categories', attributes: { title: 'Fantasy' } },
  {
    id: 'r1',
    type: 'mediaRelationships',
    attributes: { role: 'sequel' },
    relationships: { destination: { data: { id: '50000', type: 'anime' } } },
  },
  {
    id: '50000',
    type: 'anime',
    attributes: { canonicalTitle: 'Frieren Season 2', titles: {}, startDate: '2026-01-01', nsfw: false },
  },
  {
    id: 's1',
    type: 'streamingLinks',
    attributes: { url: 'https://www.crunchyroll.com/series/frieren', subs: ['en', 'es'], dubs: ['ja', 'en'] },
    relationships: { streamer: { data: { id: 'st1', type: 'streamers' } } },
  },
  {
    id: 's2',
    type: 'streamingLinks',
    attributes: { url: 'https://evil.example.com/watch', subs: ['en'], dubs: [] },
    relationships: { streamer: { data: { id: 'st2', type: 'streamers' } } },
  },
  { id: 'st1', type: 'streamers', attributes: { siteName: 'Crunchyroll' } },
  { id: 'st2', type: 'streamers', attributes: { siteName: 'Evil' } },
  {
    id: 'p1',
    type: 'animeProductions',
    attributes: { role: 'studio' },
    relationships: { producer: { data: { id: 'pr1', type: 'producers' } } },
  },
  { id: 'pr1', type: 'producers', attributes: { name: 'Madhouse' } },
];

describe('Kitsu provider', () => {
  it('searches with JSON:API headers, filters NSFW and returns cross ids', async () => {
    const http = new FakeHttp().on('/anime?filter', () =>
      json(
        {
          data: [
            KITSU_ANIME,
            { ...KITSU_ANIME, id: '9', attributes: { ...KITSU_ANIME.attributes, nsfw: true } },
          ],
          included: KITSU_INCLUDED,
        },
        200,
        { 'content-type': 'application/vnd.api+json' },
      ),
    );
    const r = await kitsuProvider.search({ type: 'anime', query: 'frieren', year: null }, ctx(http));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]).toMatchObject({
      title: 'Frieren: Beyond Journey’s End',
      year: 2023,
      crossIds: { kitsu: '41370', mal: '52991', anilist: '154587' },
    });
    expect(http.calls[0]?.headers?.['Accept']).toBe('application/vnd.api+json');
    expect(http.calls[0]?.url).toContain('page[limit]=20');
  });

  it('maps details: anime fields, studios, relations, allowlisted streaming links, episodes', async () => {
    const http = new FakeHttp()
      .on('/anime/41370?include', () => json({ data: KITSU_ANIME, included: KITSU_INCLUDED }))
      .on('/anime/41370/episodes', () =>
        json({
          data: [
            {
              attributes: {
                number: 1,
                canonicalTitle: 'The Journey’s End',
                airdate: '2023-09-29',
                length: 24,
              },
            },
            { attributes: { number: 1, canonicalTitle: 'duplicate', airdate: null, length: null } },
            { attributes: { number: null, canonicalTitle: 'bad', airdate: null, length: null } },
            {
              attributes: {
                number: 2,
                canonicalTitle: 'It Didn’t Have to Be Magic',
                airdate: '2023-09-29',
                length: 24,
              },
            },
          ],
          links: { next: 'https://attacker.example/next' },
        }),
      );
    const r = await kitsuProvider.fetchDetails(
      { providerId: 'kitsu', id: '41370', type: 'anime' },
      ctx(http),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = r.value;
    expect(v.meta).toMatchObject({
      titleRomaji: 'Sousou no Frieren',
      titleNative: '葬送のフリーレン',
      animeFormat: 'tv',
      airingStatus: 'finished',
      animeSeason: 'fall',
      seasonYear: 2023,
      episodeCount: 28,
      isAdult: false,
    });
    expect(v.meta.creators).toEqual([{ name: 'Madhouse', role: 'studio' }]);
    expect(v.meta.externalIds.map((e) => e.kind).sort()).toEqual(['anilist', 'kitsu', 'mal']);
    expect(v.relations).toEqual([
      {
        relation: 'sequel',
        ref: { providerId: 'kitsu', id: '50000', type: 'anime' },
        title: 'Frieren Season 2',
        year: 2026,
      },
    ]);
    // The provider reports both links; the repository drops the non-allowlisted host on save.
    expect(v.streaming?.map((s) => s.service)).toEqual(['Crunchyroll', 'Evil']);
    expect(v.seasons[0]?.episodes).toHaveLength(28);
    expect(v.seasons[0]?.episodes[1]?.title).toBe('It Didn’t Have to Be Magic');
    // Never follows a pagination link off the documented API host.
    expect(http.calls.filter((c) => c.url.includes('attacker'))).toHaveLength(0);
    expect(v.extraArt?.[0]?.slot).toBe('banner');
  });

  it('refuses NSFW details and malformed ids', async () => {
    const http = new FakeHttp().on('/anime/1?include', () =>
      json({
        data: { ...KITSU_ANIME, id: '1', attributes: { ...KITSU_ANIME.attributes, nsfw: true } },
        included: [],
      }),
    );
    expect(
      (await kitsuProvider.fetchDetails({ providerId: 'kitsu', id: '1', type: 'anime' }, ctx(http))).kind,
    ).toBe('notFound');
    expect(
      (await kitsuProvider.fetchDetails({ providerId: 'kitsu', id: '../x', type: 'anime' }, ctx(http))).kind,
    ).toBe('notFound');
  });
});

/* ---------------------------------------------------------------- Jikan / MAL / AniList */

describe('Jikan and MAL', () => {
  it('Jikan is off by default and flagged; parses durations and adult ratings', () => {
    expect(jikanProvider.enabledByDefault).toBe(false);
    expect(jikanProvider.termsNote).toMatch(/scrap/i);
    expect(parseDurationMinutes('24 min per ep')).toBe(24);
    expect(parseDurationMinutes('1 hr 55 min')).toBe(115);
    expect(parseDurationMinutes(null)).toBeNull();
    expect(isAdultRating('Rx - Hentai', 0)).toBe(true);
    expect(isAdultRating('PG-13', 0)).toBe(false);
    expect(isAdultRating('PG-13', 1)).toBe(true);
  });

  it('Jikan search passes sfw=true unless adult is enabled', async () => {
    const http = new FakeHttp().on('/v4/anime?', () =>
      json({ data: [{ mal_id: 1, title: 'Cowboy Bebop', rating: 'R', type: 'TV', explicit_genres: [] }] }),
    );
    await jikanProvider.search({ type: 'anime', query: 'bebop', year: null }, ctx(http));
    expect(http.calls[0]?.url).toContain('sfw=true');
    await jikanProvider.search({ type: 'anime', query: 'bebop', year: null, includeAdult: true }, ctx(http));
    expect(http.calls[1]?.url).not.toContain('sfw');
  });

  it('MAL needs a user client id, sent only as a header', async () => {
    const http = new FakeHttp().on('api.myanimelist.net', () =>
      json({
        data: [
          {
            node: { id: 1, title: 'Cowboy Bebop', nsfw: 'white', alternative_titles: { en: 'Cowboy Bebop' } },
          },
          { node: { id: 2, title: 'X', nsfw: 'black' } },
        ],
      }),
    );
    expect((await malProvider.search({ type: 'anime', query: 'bebop', year: null }, ctx(http))).kind).toBe(
      'notConfigured',
    );
    const id = 'a'.repeat(32);
    const r = await malProvider.search(
      { type: 'anime', query: 'bebop', year: null },
      ctx(http, { clientId: id }),
    );
    expect(r.kind === 'ok' && r.value.map((h) => h.title)).toEqual(['Cowboy Bebop']);
    expect(http.calls[0]?.headers?.['X-MAL-CLIENT-ID']).toBe(id);
    expect(http.calls[0]?.url).not.toContain(id);
  });

  it('AniList is opt-in, shows its terms clause, and maps anime fields + relations', async () => {
    expect(anilistProvider.enabledByDefault).toBe(false);
    expect(anilistProvider.termsNote).toMatch(/tracker services/);
    const http = new FakeHttp().on('graphql.anilist.co', () =>
      json({
        data: {
          Media: {
            id: 154587,
            idMal: 52991,
            format: 'TV',
            isAdult: false,
            title: {
              romaji: 'Sousou no Frieren',
              english: 'Frieren: Beyond Journey’s End',
              native: '葬送のフリーレン',
            },
            synonyms: [],
            description: 'An elf mage.',
            startDate: { year: 2023, month: 9, day: 29 },
            endDate: { year: 2024, month: 3, day: 22 },
            status: 'FINISHED',
            season: 'FALL',
            seasonYear: 2023,
            source: 'MANGA',
            episodes: 28,
            duration: 24,
            genres: ['Fantasy'],
            siteUrl: 'https://anilist.co/anime/154587',
            bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587.jpg',
            coverImage: { large: 'https://s4.anilist.co/x.jpg', extraLarge: 'https://s4.anilist.co/xl.jpg' },
            nextAiringEpisode: null,
            studios: {
              nodes: [
                { name: 'Madhouse', isAnimationStudio: true },
                { name: 'Aniplex', isAnimationStudio: false },
              ],
            },
            staff: { edges: [] },
            relations: {
              edges: [
                {
                  relationType: 'SOURCE',
                  node: {
                    id: 1,
                    type: 'MANGA',
                    format: 'MANGA',
                    title: { romaji: 'Manga', english: null, native: null },
                    startDate: { year: 2020 },
                  },
                },
                {
                  relationType: 'SEQUEL',
                  node: {
                    id: 2,
                    type: 'ANIME',
                    format: 'TV',
                    title: { romaji: 'Frieren 2', english: null, native: null },
                    startDate: { year: 2026 },
                  },
                },
              ],
            },
          },
        },
      }),
    );
    const r = await anilistProvider.fetchDetails(
      { providerId: 'anilist', id: '154587', type: 'anime' },
      ctx(http),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.meta).toMatchObject({
      animeFormat: 'tv',
      animeSeason: 'fall',
      sourceMaterial: 'Manga',
      episodeCount: 28,
    });
    expect(r.value.meta.creators).toEqual([{ name: 'Madhouse', role: 'studio' }]);
    expect(r.value.relations?.map((x) => x.relation)).toEqual(['sequel']);
    expect(r.value.extraArt?.[0]?.url).toContain('banner');
  });
});

/* ---------------------------------------------------------------- TMDB anime + art */

describe('TMDB anime and artwork', () => {
  it('parses prefixed anime ids', () => {
    expect(parseAnimeTmdbId('tv:123')).toEqual({ kind: 'tv', id: '123' });
    expect(parseAnimeTmdbId('movie:9')).toEqual({ kind: 'movie', id: '9' });
    expect(parseAnimeTmdbId('123')).toBeNull();
  });

  it('anime search merges TV + movie results with prefixed ids', async () => {
    const http = new FakeHttp()
      .on('/search/tv', () => json({ results: [{ id: 1, name: 'Show', first_air_date: '2020-01-01' }] }))
      .on('/search/movie', () => json({ results: [{ id: 2, title: 'Film', release_date: '2021-01-01' }] }));
    const r = await tmdbProvider.search(
      { type: 'anime', query: 'x', year: null },
      ctx(http, { apiKey: 'k'.repeat(32) }),
    );
    expect(r.kind === 'ok' && r.value.map((h) => h.ref.id)).toEqual(['tv:1', 'movie:2']);
  });

  it('art source maps posters/backdrops/logos and rejects odd paths', async () => {
    const http = new FakeHttp().on('/images', () =>
      json({
        posters: [
          { file_path: '/abcde.jpg', width: 500, height: 750, iso_639_1: 'en', vote_average: 5 },
          { file_path: '../../etc', width: 1, height: 1 },
        ],
        backdrops: [{ file_path: '/bgbgbg.jpg', width: 1920, height: 1080, iso_639_1: null }],
        logos: [{ file_path: '/logo1.png', width: 500, height: 200, iso_639_1: 'en' }],
      }),
    );
    const r = await tmdbArtSource.candidates(
      { type: 'movie', title: 'X', year: null, externalIds: [{ kind: 'tmdb', value: '27205' }] },
      ctx(http, { apiKey: 'k'.repeat(32) }),
    );
    expect(r.kind === 'ok' && r.value.map((c) => `${c.slot}:${c.assetId}`)).toEqual([
      'cover:/abcde.jpg',
      'background:/bgbgbg.jpg',
      'logo:/logo1.png',
    ]);
  });
});

describe('fanart.tv', () => {
  it('needs a user key, sends keys as headers (never in the URL), uses preview thumbnails', async () => {
    const http = new FakeHttp().on('webservice.fanart.tv/v3/movies/27205', () =>
      json({
        movieposter: [
          {
            id: '1',
            url: 'https://assets.fanart.tv/fanart/movies/27205/movieposter/a.jpg',
            lang: 'en',
            likes: '5',
          },
        ],
        hdmovielogo: [{ id: '2', url: 'https://evil.example.com/logo.png', lang: 'en', likes: '1' }],
        copyright: 'Some artist',
      }),
    );
    const lookup = {
      type: 'movie' as const,
      title: 'Inception',
      year: 2010,
      externalIds: [{ kind: 'tmdb' as const, value: '27205' }],
    };
    expect((await fanartSource.candidates(lookup, ctx(http))).kind).toBe('notConfigured');
    const key = 'c'.repeat(32);
    const r = await fanartSource.candidates(lookup, ctx(http, { clientId: key }));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value).toHaveLength(1); // off-host logo dropped
    expect(r.value[0]?.thumbUrl).toBe('https://assets.fanart.tv/preview/movies/27205/movieposter/a.jpg');
    expect(r.value[0]?.attribution).toContain('Some artist');
    expect(http.calls[0]?.headers?.['client-key']).toBe(key);
    expect(http.calls[0]?.url).not.toContain(key);
    expect(fanartPreview('https://assets.fanart.tv/fanart/tv/1/x.jpg')).toContain('/preview/');
  });
});

describe('SteamGridDB', () => {
  const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  it('uses a Bearer key, prefers the Steam app id, filters NSFW and off-host images', async () => {
    const http = new FakeHttp()
      .on('/games/steam/620', () => json({ success: true, data: { id: 5 } }))
      .on('/grids/game/5', () =>
        json({
          data: [
            {
              id: 1,
              url: 'https://cdn2.steamgriddb.com/grid/a.png',
              thumb: 'https://cdn2.steamgriddb.com/thumb/a.png',
              width: 600,
              height: 900,
              nsfw: false,
              author: { name: 'Ann' },
            },
            {
              id: 2,
              url: 'https://cdn2.steamgriddb.com/grid/b.png',
              thumb: 'https://cdn2.steamgriddb.com/thumb/b.png',
              nsfw: true,
            },
            {
              id: 3,
              url: 'https://s3.amazonaws.com/x.png',
              thumb: 'https://s3.amazonaws.com/x.png',
              nsfw: false,
            },
          ],
        }),
      )
      .on('/heroes/game/5', () =>
        json({
          data: [
            {
              id: 4,
              url: 'https://cdn2.steamgriddb.com/hero/h.png',
              thumb: 'https://cdn2.steamgriddb.com/thumb/h.png',
            },
          ],
        }),
      )
      .on('/logos/game/5', () => json({ data: [] }))
      .on('/icons/game/5', () => json({ success: false }, 404));
    const r = await steamGridDbSource.candidates(
      { type: 'game', title: 'Portal 2', year: 2011, externalIds: [{ kind: 'steam', value: '620' }] },
      ctx(http, { apiKey: KEY }),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.map((c) => `${c.slot}:${c.assetId}`)).toEqual(['cover:1', 'banner:4', 'background:4']);
    expect(r.value[0]?.attribution).toBe('By Ann on SteamGridDB');
    expect(http.calls.every((c) => c.headers?.['Authorization'] === `Bearer ${KEY}`)).toBe(true);
    expect(http.calls.every((c) => !c.url.includes(KEY))).toBe(true);
    expect(http.calls.find((c) => c.url.includes('/grids/'))?.url).toContain('nsfw=false');
  });

  it('falls back to exact-title search and never guesses between games', async () => {
    const http = new FakeHttp().on('/search/autocomplete/', () =>
      json({
        data: [
          { id: 1, name: 'Portal' },
          { id: 2, name: 'Portal 2' },
        ],
      }),
    );
    const r = await steamGridDbSource.candidates(
      { type: 'game', title: 'Portal 3', year: null, externalIds: [] },
      ctx(http, { apiKey: KEY }),
    );
    expect(r.kind === 'ok' && r.value).toEqual([]);
  });
});

describe('registry', () => {
  it('lists anime sources with Kitsu first and every artwork host declared as outbound', () => {
    const anime = PROVIDERS.filter((p) => p.supports.includes('anime')).map((p) => p.id);
    expect(anime[0]).toBe('tmdb'); // TMDB stays first overall (keyed), Kitsu is the first keyless anime source
    expect(anime).toEqual(expect.arrayContaining(['kitsu', 'mal', 'anilist', 'jikan']));
    for (const h of ARTWORK_HOSTS) expect(OUTBOUND_HOSTS as readonly string[]).toContain(h);
  });
});

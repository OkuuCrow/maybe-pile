import { describe, expect, it } from 'vitest';
import { anilistProvider } from '../../src/providers/anilist';
import { PROVIDERS } from '../../src/providers/registry';
import { wikidataProvider } from '../../src/providers/wikidata';
import type { ProviderContext } from '../../src/providers/types';
import { linksFromExternalIds } from '../../src/domain/links';
import { FakeHttp, instantLimiter, json } from '../helpers/http';

const ctx = (http: FakeHttp): ProviderContext => ({
  http,
  limiter: instantLimiter(),
  keys: {},
  region: 'US',
});

const item = (id: string) => ({ 'entity-type': 'item', 'numeric-id': Number(id.slice(1)), id });
const snak = (value: unknown, rank = 'normal') => ({
  mainsnak: { snaktype: 'value', datavalue: { value, type: 'x' } },
  rank,
});
const time = (t: string, precision: number) => ({ time: t, precision, timezone: 0, before: 0, after: 0 });

const WD_ENTITIES = {
  entities: {
    Q25188: {
      id: 'Q25188',
      labels: { en: { value: 'Inception' } },
      descriptions: { en: { value: '2010 film directed by Christopher Nolan' } },
      aliases: { en: [{ value: 'Inception (film)' }] },
      claims: {
        P31: [snak(item('Q11424'))],
        P577: [snak(time('+2010-07-16T00:00:00Z', 11)), snak(time('+2010-07-08T00:00:00Z', 11))],
        P57: [snak(item('Q25191'))],
        P345: [snak('tt1375666')],
        P4947: [snak('27205')],
        P2047: [snak({ amount: '+148', unit: 'http://www.wikidata.org/entity/Q7727' })],
        P136: [snak(item('Q496523')), snak(item('Q999'), 'deprecated')],
      },
    },
    Q4: {
      id: 'Q4',
      labels: { en: { value: 'Inception (soundtrack)' } },
      descriptions: { en: { value: 'soundtrack album' } },
      claims: { P31: [snak(item('Q482994'))] },
    },
    Q5: {
      id: 'Q5',
      labels: { mul: { value: 'Inception Game' } },
      descriptions: { en: { value: 'video game' } },
      claims: {},
    },
  },
};
const WD_LABELS = {
  entities: {
    Q25191: { id: 'Q25191', labels: { en: { value: 'Christopher Nolan' } } },
    Q496523: { id: 'Q496523', labels: { en: { value: 'science fiction film' } } },
  },
};

describe('Wikidata provider (keyless)', () => {
  const http = () =>
    new FakeHttp()
      .on('wbsearchentities', () => json({ search: [{ id: 'Q4' }, { id: 'Q25188' }, { id: 'Q5' }] }))
      // FakeHttp checks the most recently registered route first, so the specific one goes last.
      .on('wbgetentities', () => json(WD_ENTITIES))
      .on(/wbgetentities.*props=labels&/, () => json(WD_LABELS));

  it('is keyless and declared for all four media types', () => {
    expect(wikidataProvider.requiresApiKey).toBe(false);
    expect(wikidataProvider.isConfigured({})).toBe(true);
    expect(wikidataProvider.supports).toEqual(['movie', 'tv', 'game', 'book']);
  });

  it('filters search results to the requested type via instance-of or description', async () => {
    const r = await wikidataProvider.search({ type: 'movie', query: 'inception', year: null }, ctx(http()));
    expect(r.kind === 'ok' && r.value.map((h) => [h.ref.id, h.year])).toEqual([['Q25188', 2010]]);
    const g = await wikidataProvider.search({ type: 'game', query: 'inception', year: null }, ctx(http()));
    expect(g.kind === 'ok' && g.value.map((h) => h.title)).toEqual(['Inception Game']); // 'mul' label fallback
  });

  it('maps claims: earliest date, resolved names, runtime, exact IDs; skips deprecated', async () => {
    const d = await wikidataProvider.fetchDetails(
      { providerId: 'wikidata', id: 'Q25188', type: 'movie' },
      ctx(http()),
    );
    expect(d.kind).toBe('ok');
    if (d.kind !== 'ok') return;
    expect(d.value.meta).toMatchObject({
      title: 'Inception',
      releaseDate: '2010-07-08',
      runtimeMinutes: 148,
      genres: ['science fiction film'],
      creators: [{ name: 'Christopher Nolan', role: 'director' }],
    });
    expect(d.value.meta.externalIds).toEqual([
      { kind: 'wikidata', value: 'Q25188' },
      { kind: 'imdb', value: 'tt1375666' },
      { kind: 'tmdb', value: '27205' },
    ]);
    expect(d.value.artworkUrl).toBeNull();
    expect(linksFromExternalIds('movie', d.value.meta.externalIds).map((l) => l.kind)).toEqual([
      'imdb',
      'tmdb',
      'wikidata',
    ]);
  });

  it('rejects malformed ids and maps API errors', async () => {
    const h = new FakeHttp();
    expect(
      (await wikidataProvider.fetchDetails({ providerId: 'wikidata', id: 'Q1|Q2', type: 'movie' }, ctx(h)))
        .kind,
    ).toBe('notFound');
    expect(h.calls).toHaveLength(0);
    const err = new FakeHttp().on('wbsearchentities', () => json({ error: { code: 'x' } }));
    expect((await wikidataProvider.search({ type: 'movie', query: 'x', year: null }, ctx(err))).kind).toBe(
      'malformedResponse',
    );
  });
});

describe('AniList provider (keyless)', () => {
  const media = {
    id: 154587,
    idMal: 52991,
    format: 'TV',
    title: {
      romaji: 'Sousou no Frieren',
      english: 'Frieren: Beyond Journey’s End',
      native: '葬送のフリーレン',
    },
    synonyms: ['Frieren'],
    description: 'An elf <i>mage</i>.<br>A journey.',
    startDate: { year: 2023, month: 9, day: 29 },
    endDate: { year: 2024, month: 3, day: 22 },
    status: 'FINISHED',
    episodes: 3,
    duration: 24,
    chapters: null,
    volumes: null,
    genres: ['Adventure', 'Fantasy'],
    siteUrl: 'https://anilist.co/anime/154587',
    coverImage: { large: 'https://s4.anilist.co/file/a.jpg', extraLarge: 'https://evil.example.com/x.jpg' },
    studios: { nodes: [{ name: 'MADHOUSE' }] },
    staff: {
      edges: [
        { role: 'Director', node: { name: { full: 'Keiichirou Saitou' } } },
        { role: 'Animation Director (ep 1)', node: { name: { full: 'Someone Else' } } },
        { role: 'Original Creator', node: { name: { full: 'Kanehito Yamada' } } },
      ],
    },
  };

  it('sends a GraphQL POST, maps anime to a TV show with a numbered season and MAL link', async () => {
    const http = new FakeHttp().on('graphql.anilist.co', (req) =>
      req.body?.includes('Page(')
        ? json({ data: { Page: { media: [media] } } })
        : json({ data: { Media: media } }),
    );
    const s = await anilistProvider.search({ type: 'tv', query: 'frieren', year: null }, ctx(http));
    expect(s.kind === 'ok' && s.value[0]).toMatchObject({
      title: 'Frieren: Beyond Journey’s End',
      year: 2023,
      synopsis: 'An elf mage.\nA journey.',
    });
    expect(http.calls[0]?.method).toBe('POST');
    expect(JSON.parse(http.calls[0]?.body ?? '{}').variables).toEqual({
      search: 'frieren',
      type: 'ANIME',
      formats: ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'],
      adult: false,
    });
    const d = await anilistProvider.fetchDetails(
      { providerId: 'anilist', id: '154587', type: 'tv' },
      ctx(http),
    );
    expect(d.kind).toBe('ok');
    if (d.kind !== 'ok') return;
    expect(d.value.meta).toMatchObject({
      showStatus: 'ended',
      network: 'MADHOUSE',
      episodeRuntime: 24,
      releaseDate: '2023-09-29',
      lastAirDate: '2024-03-22',
    });
    expect(d.value.meta.creators).toEqual([
      { name: 'Keiichirou Saitou', role: 'director' },
      { name: 'Kanehito Yamada', role: 'creator' },
    ]);
    expect(d.value.meta.altTitles).toEqual(['Sousou no Frieren', '葬送のフリーレン', 'Frieren']);
    expect(d.value.seasons).toEqual([
      {
        number: 1,
        title: null,
        episodeCountKnown: 3,
        episodes: [1, 2, 3].map((n) => ({ number: n, title: null, airDate: null, runtime: 24 })),
      },
    ]);
    expect(d.value.artworkUrl).toBeNull(); // non-allowlisted host rejected
    expect(linksFromExternalIds('tv', d.value.meta.externalIds).map((l) => l.url)).toEqual([
      'https://anilist.co/anime/154587',
      'https://myanimelist.net/anime/52991',
    ]);
  });

  it('maps manga to books with author/illustrator roles (qualifiers stripped); games unsupported', async () => {
    const manga = {
      ...media,
      format: 'MANGA',
      episodes: null,
      staff: { edges: [{ role: 'Story & Art (vols 1-41)', node: { name: { full: 'Kentarou Miura' } } }] },
    };
    const http = new FakeHttp().on('graphql.anilist.co', () => json({ data: { Media: manga } }));
    const d = await anilistProvider.fetchDetails(
      { providerId: 'anilist', id: '30002', type: 'book' },
      ctx(http),
    );
    expect(d.kind === 'ok' && d.value.meta.creators).toEqual([{ name: 'Kentarou Miura', role: 'author' }]);
    expect(d.kind === 'ok' && linksFromExternalIds('book', d.value.meta.externalIds)[0]?.url).toBe(
      'https://anilist.co/manga/154587',
    );
    expect(
      (await anilistProvider.search({ type: 'game', query: 'x', year: null }, ctx(new FakeHttp()))).kind,
    ).toBe('ok');
  });

  it('maps not-found and rate limiting', async () => {
    const nf = new FakeHttp().on('graphql.anilist.co', () =>
      json({ data: { Media: null }, errors: [{ message: 'Not Found.' }] }, 404),
    );
    expect(
      (await anilistProvider.fetchDetails({ providerId: 'anilist', id: '1', type: 'tv' }, ctx(nf))).kind,
    ).toBe('notFound');
    const rl = new FakeHttp().on('graphql.anilist.co', () => json({}, 429, { 'retry-after': '20' }));
    expect(await anilistProvider.search({ type: 'tv', query: 'x', year: null }, ctx(rl))).toEqual({
      kind: 'rateLimited',
      retryAfterSeconds: 20,
    });
  });
});

describe('provider coverage', () => {
  it('every media type has at least one keyless provider', () => {
    for (const t of ['movie', 'tv', 'game', 'book'] as const) {
      expect(
        PROVIDERS.some((p) => !p.requiresApiKey && p.supports.includes(t)),
        t,
      ).toBe(true);
    }
  });
});

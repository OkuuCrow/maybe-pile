/**
 * Kitsu — default anime source. Official JSON:API at https://kitsu.io/api/edge
 * (docs: https://kitsu.docs.apiary.io/, read 2026-11-24 from the copy the user supplied).
 *
 * - Public GETs need no authentication. Unauthenticated requests never return
 *   NSFW titles, which matches "adult hidden by default"; we additionally drop
 *   anything flagged `nsfw`.
 * - Pagination: page[limit] max 20.
 * - Mappings give MyAnimeList/AniList ids (cross-provider de-dup); media
 *   relationships become franchise *suggestions*; streaming links (with
 *   subtitle/dub language arrays) are documented where-to-watch data.
 * - The docs publish no rate limits, terms, attribution or caching rules. We
 *   therefore use a conservative client-side limit and keep artwork
 *   remote-only (never cached). See docs/providers.md.
 */
import { z } from 'zod';
import type { SeasonInput } from '../shared/schemas';
import {
  buildAnimeSeasons,
  normalizeAiringStatus,
  normalizeAnimeFormat,
  seasonOfDate,
} from '../domain/anime';
import type { ExternalIdKind } from '../shared/enums';
import { requestJson } from './http';
import {
  cleanText,
  finalizeMeta,
  looseArray,
  looseNumber,
  looseString,
  safeUrl,
  yearFromDate,
} from './common';
import type {
  MetadataProvider,
  ProviderContext,
  ProviderRelation,
  ProviderStreamingLink,
  SearchHit,
} from './types';

const API = 'https://kitsu.io/api/edge';
const IMG_HOSTS = ['media.kitsu.io', 'media.kitsu.app'];
const MAX_EPISODE_PAGES = 10; // 10 × 20 = 200 episode rows; longer shows get generated numbers.

const Images = z
  .object({
    tiny: looseString,
    small: looseString,
    medium: looseString,
    large: looseString,
    original: looseString,
  })
  .nullish();

const AnimeAttrs = z.object({
  canonicalTitle: looseString,
  titles: z.record(z.string(), z.string().nullable()).nullish(),
  abbreviatedTitles: looseArray(z.string()),
  synopsis: looseString,
  startDate: looseString,
  endDate: looseString,
  subtype: looseString,
  status: looseString,
  posterImage: Images,
  coverImage: Images,
  episodeCount: looseNumber,
  episodeLength: looseNumber,
  nsfw: z.boolean().nullish(),
  nextRelease: looseString,
  ageRating: looseString,
});

const Resource = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  type: z.string(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
  relationships: z.record(z.string(), z.unknown()).nullish(),
});

const AnimeResource = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  type: z.literal('anime'),
  attributes: AnimeAttrs,
  relationships: z.record(z.string(), z.unknown()).nullish(),
});

const SearchSchema = z.object({ data: looseArray(AnimeResource), included: looseArray(Resource) });
const DetailSchema = z.object({ data: AnimeResource.nullable(), included: looseArray(Resource) });
const EpisodeSchema = z.object({
  data: looseArray(
    z.object({
      attributes: z.object({
        number: looseNumber,
        canonicalTitle: looseString,
        airdate: looseString,
        length: looseNumber,
      }),
    }),
  ),
  links: z.object({ next: looseString }).nullish(),
});

const RelLink = z.object({
  data: z.object({ id: z.union([z.string(), z.number()]).transform(String), type: z.string() }).nullish(),
});
const RelMany = z.object({
  data: looseArray(z.object({ id: z.union([z.string(), z.number()]).transform(String), type: z.string() })),
});

const ROLE_MAP: Record<string, ProviderRelation['relation']> = {
  prequel: 'prequel',
  sequel: 'sequel',
  spinoff: 'spin_off',
  side_story: 'side_story',
  adaptation: 'adapted_as',
  alternative_setting: 'remake_of',
  alternative_version: 'remake_of',
  parent_story: 'same_franchise',
  full_story: 'same_franchise',
  summary: 'same_franchise',
  other: 'same_franchise',
};

function get(ctx: ProviderContext, url: string) {
  return {
    url,
    headers: { Accept: 'application/vnd.api+json' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

const posInt = (n: number | null) => (n !== null && Number.isInteger(n) && n > 0 ? n : null);

/** Title variants: Kitsu keys titles by locale (en, en_jp = romaji, ja_jp = native). */
function titlesOf(a: z.infer<typeof AnimeAttrs>) {
  const t = a.titles ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = t[k]?.trim();
      if (v) return v;
    }
    return null;
  };
  return {
    english: pick('en', 'en_us'),
    romaji: pick('en_jp'),
    native: pick('ja_jp'),
    canonical: a.canonicalTitle,
  };
}

function index(included: z.infer<typeof Resource>[]) {
  const m = new Map<string, z.infer<typeof Resource>>();
  for (const r of included) m.set(`${r.type}:${r.id}`, r);
  return m;
}

/** Maps a Kitsu mapping `externalSite` to our id kind. */
function mappingKind(site: string): ExternalIdKind | null {
  if (site === 'myanimelist/anime') return 'mal';
  if (site === 'anilist/anime' || site === 'anilist') return 'anilist';
  return null;
}

function idsFromMappings(
  rel: unknown,
  inc: Map<string, z.infer<typeof Resource>>,
): Partial<Record<ExternalIdKind, string>> {
  const out: Partial<Record<ExternalIdKind, string>> = {};
  const many = RelMany.safeParse(rel);
  if (!many.success) return out;
  for (const ref of many.data.data) {
    const r = inc.get(`${ref.type}:${ref.id}`);
    const site = typeof r?.attributes?.['externalSite'] === 'string' ? r.attributes['externalSite'] : '';
    const raw = r?.attributes?.['externalId'];
    const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    const kind = mappingKind(site);
    // AniList mapping ids are sometimes "anime/123"; keep only plain numeric ids.
    const id = value.replace(/^anime\//, '');
    if (kind && /^\d{1,10}$/.test(id) && !out[kind]) out[kind] = id;
  }
  return out;
}

export const kitsuProvider: MetadataProvider = {
  id: 'kitsu',
  displayName: 'Kitsu',
  supports: ['anime'],
  attribution: {
    text: 'Anime data from Kitsu (kitsu.app).',
    url: 'https://kitsu.app/',
    required: false,
  },
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  termsNote:
    'Kitsu publishes no rate limits, attribution or caching rules. Maybe Pile limits itself to 30 requests a minute and never stores Kitsu artwork locally.',
  rateLimit: { maxRequests: 30, perMs: 60_000 },
  cachingPolicy: 'remote-only',
  artworkHosts: IMG_HOSTS,
  isConfigured: () => true,

  async search(q, ctx) {
    if (q.type !== 'anime') return { kind: 'ok', value: [] };
    const url = `${API}/anime?filter[text]=${encodeURIComponent(q.query)}&page[limit]=20&include=mappings`;
    const r = await requestJson(ctx.http, ctx.limiter, get(ctx, url), SearchSchema);
    if (r.kind !== 'ok') return r;
    const inc = index(r.value.included);
    let hits = r.value.data
      .filter((d) => d.attributes.nsfw !== true)
      .map<SearchHit>((d) => {
        const t = titlesOf(d.attributes);
        const ids = idsFromMappings(d.relationships?.['mappings'], inc);
        return {
          ref: { providerId: 'kitsu', id: d.id, type: 'anime' },
          title: t.english ?? t.canonical ?? t.romaji ?? '(untitled)',
          year: yearFromDate(d.attributes.startDate),
          type: 'anime',
          creators: [d.attributes.subtype ?? ''].filter(Boolean).map((x) => x.toUpperCase()),
          synopsis: cleanText(d.attributes.synopsis, 280),
          thumbUrl: safeUrl(
            d.attributes.posterImage?.small ?? d.attributes.posterImage?.medium ?? null,
            IMG_HOSTS,
          ),
          crossIds: { kitsu: d.id, ...ids },
          adult: false,
        };
      });
    if (q.year) hits = [...hits.filter((h) => h.year === q.year), ...hits.filter((h) => h.year !== q.year)];
    return { kind: 'ok', value: hits };
  },

  async fetchDetails(ref, ctx) {
    if (ref.type !== 'anime' || !/^\d{1,10}$/.test(ref.id)) return { kind: 'notFound' };
    const include = [
      'mappings',
      'categories',
      'mediaRelationships.destination',
      'streamingLinks.streamer',
      'animeProductions.producer',
    ].join(',');
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      get(ctx, `${API}/anime/${ref.id}?include=${include}`),
      DetailSchema,
    );
    if (r.kind !== 'ok') return r;
    const d = r.value.data;
    if (!d) return { kind: 'notFound' };
    // Kitsu never serves NSFW titles unauthenticated; refuse any that slip through.
    if (d.attributes.nsfw === true) return { kind: 'notFound' };
    const a = d.attributes;
    const inc = index(r.value.included);
    const t = titlesOf(a);
    const title = t.english ?? t.canonical ?? t.romaji ?? '';
    const ids = idsFromMappings(d.relationships?.['mappings'], inc);

    const genres: string[] = [];
    const cats = RelMany.safeParse(d.relationships?.['categories']);
    if (cats.success)
      for (const c of cats.data.data) {
        const g = inc.get(`${c.type}:${c.id}`)?.attributes?.['title'];
        if (typeof g === 'string') genres.push(g);
      }

    const studios: string[] = [];
    const prods = RelMany.safeParse(d.relationships?.['animeProductions']);
    if (prods.success)
      for (const p of prods.data.data) {
        const row = inc.get(`${p.type}:${p.id}`);
        if (row?.attributes?.['role'] !== 'studio') continue;
        const pr = RelLink.safeParse(row.relationships?.['producer']);
        const name =
          pr.success && pr.data.data
            ? inc.get(`${pr.data.data.type}:${pr.data.data.id}`)?.attributes?.['name']
            : null;
        if (typeof name === 'string') studios.push(name);
      }

    const relations: ProviderRelation[] = [];
    const rels = RelMany.safeParse(d.relationships?.['mediaRelationships']);
    if (rels.success)
      for (const m of rels.data.data) {
        const row = inc.get(`${m.type}:${m.id}`);
        const role = typeof row?.attributes?.['role'] === 'string' ? row.attributes['role'] : '';
        const rel = ROLE_MAP[role];
        const dest = RelLink.safeParse(row?.relationships?.['destination']);
        if (!rel || !dest.success || !dest.data.data || dest.data.data.type !== 'anime') continue;
        const target = AnimeResource.safeParse(inc.get(`anime:${dest.data.data.id}`));
        if (!target.success || target.data.attributes.nsfw === true) continue;
        const tt = titlesOf(target.data.attributes);
        const name = tt.english ?? tt.canonical ?? tt.romaji;
        if (!name) continue;
        relations.push({
          relation: rel,
          ref: { providerId: 'kitsu', id: target.data.id, type: 'anime' },
          title: name,
          year: yearFromDate(target.data.attributes.startDate),
        });
      }

    const streaming: ProviderStreamingLink[] = [];
    const links = RelMany.safeParse(d.relationships?.['streamingLinks']);
    if (links.success)
      for (const l of links.data.data) {
        const row = inc.get(`${l.type}:${l.id}`);
        const url = typeof row?.attributes?.['url'] === 'string' ? row.attributes['url'] : null;
        const st = RelLink.safeParse(row?.relationships?.['streamer']);
        const service =
          st.success && st.data.data
            ? inc.get(`${st.data.data.type}:${st.data.data.id}`)?.attributes?.['siteName']
            : null;
        const langs = (k: string) => {
          const v = row?.attributes?.[k];
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 30) : [];
        };
        // URL safety is enforced again by the service against the streaming allowlist.
        if (url && typeof service === 'string')
          streaming.push({ service: service.slice(0, 60), url, subs: langs('subs'), dubs: langs('dubs') });
      }

    const format = normalizeAnimeFormat(a.subtype);
    const airing = normalizeAiringStatus(a.status);
    const season = seasonOfDate(a.startDate);
    const nextAt =
      a.nextRelease && !Number.isNaN(Date.parse(a.nextRelease))
        ? new Date(a.nextRelease).toISOString()
        : null;
    const showStatus =
      airing === 'finished' || airing === 'cancelled'
        ? 'ended'
        : airing === 'releasing' || airing === 'not_yet_released'
          ? 'returning'
          : 'unknown';
    const meta = finalizeMeta('anime', {
      title,
      altTitles: [t.romaji, t.native, t.canonical, ...a.abbreviatedTitles].filter((x): x is string =>
        Boolean(x),
      ),
      description: cleanText(a.synopsis, 20_000),
      releaseDate: a.startDate,
      lastAirDate: a.endDate,
      genres,
      creators: studios.map((name) => ({ name, role: 'studio' as const })),
      externalIds: [
        { kind: 'kitsu', value: d.id },
        ...Object.entries(ids).map(([kind, value]) => ({ kind: kind as ExternalIdKind, value })),
      ],
      showStatus,
      episodeRuntime: a.episodeLength,
      titleRomaji: t.romaji,
      titleEnglish: t.english,
      titleNative: t.native,
      animeFormat: format,
      airingStatus: airing,
      animeSeason: season?.season ?? null,
      seasonYear: season?.year ?? null,
      episodeCount: posInt(a.episodeCount),
      nextAiringAt: nextAt,
      isAdult: false,
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };

    // Episode rows (titles/air dates). Failures here are non-fatal: fall back to numbered episodes.
    const rows: {
      number: number | null;
      title: string | null;
      airDate: string | null;
      runtime: number | null;
    }[] = [];
    let next: string | null = `${API}/anime/${d.id}/episodes?page[limit]=20&sort=number`;
    for (let page = 0; next && page < MAX_EPISODE_PAGES; page++) {
      if (!next.startsWith(`${API}/`)) break; // never follow a link off the documented API host
      const er: Awaited<ReturnType<typeof requestJson<typeof EpisodeSchema>>> = await requestJson(
        ctx.http,
        ctx.limiter,
        get(ctx, next),
        EpisodeSchema,
      );
      if (er.kind !== 'ok') break;
      for (const e of er.value.data)
        rows.push({
          number: e.attributes.number,
          title: e.attributes.canonicalTitle,
          airDate: e.attributes.airdate,
          runtime: e.attributes.length,
        });
      next = er.value.links?.next ?? null;
      if (format === 'movie') break;
    }
    const seasons: SeasonInput[] = buildAnimeSeasons({
      total: a.episodeCount,
      runtime: a.episodeLength,
      episodes: rows,
    });
    const banner = safeUrl(a.coverImage?.large ?? a.coverImage?.original ?? null, IMG_HOSTS);
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons,
        artworkUrl: safeUrl(
          a.posterImage?.large ?? a.posterImage?.original ?? a.posterImage?.medium ?? null,
          IMG_HOSTS,
        ),
        sourceUrl: `https://kitsu.app/anime/${d.id}`,
        relations: relations.slice(0, 40),
        streaming: streaming.slice(0, 20),
        extraArt: banner ? [{ slot: 'banner', url: banner }] : [],
      },
    };
  },
};

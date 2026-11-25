/**
 * Jikan v4 — unofficial MyAnimeList data API (https://docs.api.jikan.moe/, read 2026-11-24
 * from the copy the user supplied). No authentication; read-only.
 * Documented limits: 60 requests/minute and 3 requests/second; responses are
 * cached server-side for 24h. jikan.moe/terms returned 404 (no terms page).
 *
 * TERMS CONCERN: Jikan describes itself as scraping MyAnimeList, and is "not
 * affiliated with MyAnimeList.net". Maybe Pile's rule is "no scraping", so
 * Jikan is OFF by default and flagged in Settings; Kitsu is the default anime
 * source and the official MAL API (user client id) is available instead.
 * Artwork (MyAnimeList CDN) is remote-only.
 */
import { z } from 'zod';
import type { SeasonInput } from '../shared/schemas';
import {
  buildAnimeSeasons,
  normalizeAiringStatus,
  normalizeAnimeFormat,
  normalizeAnimeSeason,
  normalizeSource,
} from '../domain/anime';
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

const API = 'https://api.jikan.moe/v4';
export const MAL_IMG_HOSTS = ['cdn.myanimelist.net', 'api-cdn.myanimelist.net'];
const MAX_EPISODE_PAGES = 5; // 100 rows per page

const Named = z.object({ name: looseString });
const Images = z
  .object({ jpg: z.object({ image_url: looseString, large_image_url: looseString }).nullish() })
  .nullish();

const AnimeCore = z.object({
  mal_id: z.number().int(),
  url: looseString,
  images: Images,
  title: looseString,
  title_english: looseString,
  title_japanese: looseString,
  titles: looseArray(z.object({ type: looseString, title: looseString })),
  type: looseString,
  source: looseString,
  episodes: looseNumber,
  status: looseString,
  aired: z.object({ from: looseString, to: looseString }).nullish(),
  duration: looseString,
  rating: looseString,
  synopsis: looseString,
  season: looseString,
  year: looseNumber,
  studios: looseArray(Named),
  genres: looseArray(Named),
  explicit_genres: looseArray(Named),
});

const SearchSchema = z.object({ data: looseArray(AnimeCore) });
const DetailSchema = z.object({
  data: AnimeCore.extend({
    relations: looseArray(
      z.object({
        relation: looseString,
        entry: looseArray(z.object({ mal_id: z.number().int(), type: looseString, name: looseString })),
      }),
    ),
    streaming: looseArray(z.object({ name: looseString, url: looseString })),
  }).nullable(),
});
const EpisodesSchema = z.object({
  data: looseArray(z.object({ mal_id: looseNumber, title: looseString, aired: looseString })),
  pagination: z.object({ has_next_page: z.boolean().nullish() }).nullish(),
});

/** MAL relation labels → our relation kinds. Shared with the MAL v2 provider. */
export const MAL_RELATIONS: Record<string, ProviderRelation['relation']> = {
  prequel: 'prequel',
  sequel: 'sequel',
  'spin-off': 'spin_off',
  spin_off: 'spin_off',
  'side story': 'side_story',
  side_story: 'side_story',
  adaptation: 'adaptation_of',
  'alternative version': 'remake_of',
  alternative_version: 'remake_of',
  'alternative setting': 'remake_of',
  alternative_setting: 'remake_of',
  'parent story': 'same_franchise',
  parent_story: 'same_franchise',
  'full story': 'same_franchise',
  full_story: 'same_franchise',
  summary: 'same_franchise',
  other: 'same_franchise',
};

/** "24 min per ep", "1 hr 55 min" → minutes. */
export function parseDurationMinutes(s: string | null): number | null {
  if (!s) return null;
  const h = /(\d+)\s*hr/.exec(s);
  const m = /(\d+)\s*min/.exec(s);
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return total > 0 ? total : null;
}

/** MAL "Rx - Hentai" rating or explicit genres mean adult. */
export function isAdultRating(rating: string | null, explicitGenres: number): boolean {
  return explicitGenres > 0 || /^rx\b/i.test(rating ?? '');
}

function get(ctx: ProviderContext, url: string) {
  return { url, ...(ctx.signal ? { signal: ctx.signal } : {}) };
}

const posInt = (n: number | null) => (n !== null && Number.isInteger(n) && n > 0 ? n : null);

export const jikanProvider: MetadataProvider = {
  id: 'jikan',
  displayName: 'Jikan (MyAnimeList, unofficial)',
  supports: ['anime'],
  attribution: {
    text: 'Anime data from MyAnimeList via the unofficial Jikan API (jikan.moe).',
    url: 'https://jikan.moe/',
    required: false,
  },
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  enabledByDefault: false,
  termsNote:
    'Jikan is an unofficial API that describes itself as scraping MyAnimeList, and it has no published terms. Maybe Pile avoids scraping, so this source is off by default. The official MyAnimeList API (with your own client ID) or Kitsu are alternatives.',
  // Documented: 60/min and 3/s. Stay under both.
  rateLimit: { maxRequests: 50, perMs: 60_000 },
  cachingPolicy: 'remote-only',
  artworkHosts: MAL_IMG_HOSTS,
  isConfigured: () => true,

  async search(q, ctx) {
    if (q.type !== 'anime') return { kind: 'ok', value: [] };
    const sfw = q.includeAdult ? '' : '&sfw=true';
    const url = `${API}/anime?q=${encodeURIComponent(q.query)}&limit=20${sfw}`;
    const r = await requestJson(ctx.http, ctx.limiter, get(ctx, url), SearchSchema);
    if (r.kind !== 'ok') return r;
    let hits = r.value.data
      .map((d) => ({ d, adult: isAdultRating(d.rating, d.explicit_genres.length) }))
      .filter((x) => q.includeAdult || !x.adult)
      .map<SearchHit>(({ d, adult }) => ({
        ref: { providerId: 'jikan', id: String(d.mal_id), type: 'anime' },
        title: d.title_english ?? d.title ?? '(untitled)',
        year: posInt(d.year) ?? yearFromDate(d.aired?.from),
        type: 'anime',
        creators: [d.type ?? ''].filter(Boolean),
        synopsis: cleanText(d.synopsis, 280),
        thumbUrl: safeUrl(d.images?.jpg?.image_url ?? null, MAL_IMG_HOSTS),
        crossIds: { mal: String(d.mal_id) },
        adult,
      }));
    if (q.year) hits = [...hits.filter((h) => h.year === q.year), ...hits.filter((h) => h.year !== q.year)];
    return { kind: 'ok', value: hits };
  },

  async fetchDetails(ref, ctx) {
    if (ref.type !== 'anime' || !/^\d{1,10}$/.test(ref.id)) return { kind: 'notFound' };
    const r = await requestJson(ctx.http, ctx.limiter, get(ctx, `${API}/anime/${ref.id}/full`), DetailSchema);
    if (r.kind !== 'ok') return r;
    const d = r.value.data;
    if (!d) return { kind: 'notFound' };
    const romaji = d.title;
    const english = d.title_english;
    const title = english ?? romaji ?? '';
    const airing = normalizeAiringStatus(d.status);
    const showStatus =
      airing === 'finished' || airing === 'cancelled'
        ? 'ended'
        : airing === 'releasing' || airing === 'not_yet_released'
          ? 'returning'
          : 'unknown';
    const runtime = parseDurationMinutes(d.duration);
    const meta = finalizeMeta('anime', {
      title,
      altTitles: [romaji, d.title_japanese, ...d.titles.map((t) => t.title)].filter((x): x is string =>
        Boolean(x),
      ),
      description: cleanText(d.synopsis, 20_000),
      releaseDate: d.aired?.from ?? null,
      lastAirDate: d.aired?.to ?? null,
      genres: d.genres.map((g) => g.name).filter((x): x is string => Boolean(x)),
      creators: d.studios
        .map((s) => s.name)
        .filter((x): x is string => Boolean(x))
        .map((name) => ({ name, role: 'studio' as const })),
      externalIds: [{ kind: 'mal', value: String(d.mal_id) }],
      showStatus,
      episodeRuntime: runtime,
      titleRomaji: romaji,
      titleEnglish: english,
      titleNative: d.title_japanese,
      animeFormat: normalizeAnimeFormat(d.type),
      airingStatus: airing,
      animeSeason: normalizeAnimeSeason(d.season),
      seasonYear: posInt(d.year),
      sourceMaterial: normalizeSource(d.source),
      episodeCount: posInt(d.episodes),
      isAdult: isAdultRating(d.rating, d.explicit_genres.length),
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };

    const rows: {
      number: number | null;
      title: string | null;
      airDate: string | null;
      runtime: number | null;
    }[] = [];
    for (let page = 1; page <= MAX_EPISODE_PAGES; page++) {
      const er = await requestJson(
        ctx.http,
        ctx.limiter,
        get(ctx, `${API}/anime/${ref.id}/episodes?page=${page}`),
        EpisodesSchema,
      );
      if (er.kind !== 'ok') break;
      for (const e of er.value.data)
        rows.push({ number: e.mal_id, title: e.title, airDate: e.aired, runtime: null });
      if (!er.value.pagination?.has_next_page) break;
    }
    const seasons: SeasonInput[] = buildAnimeSeasons({ total: d.episodes, runtime, episodes: rows });

    const relations: ProviderRelation[] = [];
    for (const group of d.relations) {
      const rel = MAL_RELATIONS[(group.relation ?? '').toLowerCase()];
      if (!rel) continue;
      for (const e of group.entry) {
        if (e.type !== 'anime' || !e.name) continue;
        relations.push({
          relation: rel,
          ref: { providerId: 'jikan', id: String(e.mal_id), type: 'anime' },
          title: e.name,
          year: null,
        });
      }
    }
    const streaming: ProviderStreamingLink[] = d.streaming
      .filter((s): s is { name: string; url: string } => Boolean(s.name && s.url))
      .map((s) => ({ service: s.name.slice(0, 60), url: s.url, subs: [], dubs: [] }));
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons,
        artworkUrl: safeUrl(
          d.images?.jpg?.large_image_url ?? d.images?.jpg?.image_url ?? null,
          MAL_IMG_HOSTS,
        ),
        sourceUrl: safeUrl(d.url, ['myanimelist.net']),
        relations: relations.slice(0, 40),
        streaming: streaming.slice(0, 20),
      },
    };
  },
};

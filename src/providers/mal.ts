/**
 * MyAnimeList API v2 (official) — optional; needs the user's OWN client id.
 * Docs: https://myanimelist.net/apiconfig/references/api/v2 . The MAL API
 * License and Developer Agreement (2019) forbids sharing a client id, so none
 * is bundled: the user registers an app and pastes their client id (stored
 * with safeStorage, sent only as the X-MAL-CLIENT-ID header, never logged or
 * exported). No published per-minute limit; we stay conservative.
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
import { MAL_IMG_HOSTS, MAL_RELATIONS } from './jikan';
import type { MetadataProvider, ProviderContext, ProviderRelation, SearchHit } from './types';

const API = 'https://api.myanimelist.net/v2';
const FIELDS = [
  'id',
  'title',
  'main_picture',
  'alternative_titles',
  'start_date',
  'end_date',
  'synopsis',
  'media_type',
  'status',
  'genres',
  'num_episodes',
  'start_season',
  'source',
  'average_episode_duration',
  'studios',
  'nsfw',
  'related_anime',
].join(',');

const Picture = z.object({ medium: looseString, large: looseString }).nullish();
const Node = z.object({
  id: z.number().int(),
  title: looseString,
  main_picture: Picture,
  alternative_titles: z
    .object({ synonyms: looseArray(z.string()), en: looseString, ja: looseString })
    .nullish(),
  start_date: looseString,
  end_date: looseString,
  synopsis: looseString,
  media_type: looseString,
  status: looseString,
  genres: looseArray(z.object({ name: looseString })),
  num_episodes: looseNumber,
  start_season: z.object({ year: looseNumber, season: looseString }).nullish(),
  source: looseString,
  average_episode_duration: looseNumber,
  studios: looseArray(z.object({ name: looseString })),
  nsfw: looseString,
  related_anime: looseArray(
    z.object({
      node: z.object({ id: z.number().int(), title: looseString }),
      relation_type: looseString,
    }),
  ),
});
const SearchSchema = z.object({ data: looseArray(z.object({ node: Node })) });

/** MAL `nsfw`: white = safe, gray = may be NSFW, black = NSFW. Gray/black count as adult. */
const adultOf = (nsfw: string | null) => nsfw === 'gray' || nsfw === 'black';
const posInt = (n: number | null) => (n !== null && Number.isInteger(n) && n > 0 ? n : null);

function get(ctx: ProviderContext, url: string) {
  return {
    url,
    headers: { 'X-MAL-CLIENT-ID': ctx.keys.clientId ?? '' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

export const malProvider: MetadataProvider = {
  id: 'mal',
  displayName: 'MyAnimeList (official API)',
  supports: ['anime'],
  attribution: {
    text: 'Anime data from MyAnimeList (myanimelist.net).',
    url: 'https://myanimelist.net/',
    required: false,
  },
  requiresApiKey: true,
  keyFields: ['clientId'],
  signupUrl: 'https://myanimelist.net/apiconfig',
  termsNote:
    "Uses your own MyAnimeList client ID (the MAL API agreement doesn't allow apps to share one). Create one at myanimelist.net/apiconfig.",
  rateLimit: { maxRequests: 30, perMs: 60_000 },
  cachingPolicy: 'remote-only',
  artworkHosts: MAL_IMG_HOSTS,
  isConfigured: (k) => Boolean(k.clientId && /^[0-9a-f]{16,64}$/i.test(k.clientId)),

  async search(q, ctx) {
    if (q.type !== 'anime') return { kind: 'ok', value: [] };
    if (!malProvider.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    // MAL rejects queries shorter than 3 characters.
    if (q.query.trim().length < 3) return { kind: 'ok', value: [] };
    const nsfw = q.includeAdult ? '&nsfw=true' : '';
    const url = `${API}/anime?q=${encodeURIComponent(q.query.slice(0, 64))}&limit=20&fields=${FIELDS}${nsfw}`;
    const r = await requestJson(ctx.http, ctx.limiter, get(ctx, url), SearchSchema);
    if (r.kind !== 'ok') return r;
    let hits = r.value.data
      .map((x) => x.node)
      .filter((n) => q.includeAdult || !adultOf(n.nsfw))
      .map<SearchHit>((n) => ({
        ref: { providerId: 'mal', id: String(n.id), type: 'anime' },
        title: n.alternative_titles?.en ?? n.title ?? '(untitled)',
        year: yearFromDate(n.start_date),
        type: 'anime',
        creators: [n.media_type ?? ''].filter(Boolean).map((x) => x.toUpperCase()),
        synopsis: cleanText(n.synopsis, 280),
        thumbUrl: safeUrl(n.main_picture?.medium ?? null, MAL_IMG_HOSTS),
        crossIds: { mal: String(n.id) },
        adult: adultOf(n.nsfw),
      }));
    if (q.year) hits = [...hits.filter((h) => h.year === q.year), ...hits.filter((h) => h.year !== q.year)];
    return { kind: 'ok', value: hits };
  },

  async fetchDetails(ref, ctx) {
    if (ref.type !== 'anime' || !/^\d{1,10}$/.test(ref.id)) return { kind: 'notFound' };
    if (!malProvider.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      get(ctx, `${API}/anime/${ref.id}?fields=${FIELDS}`),
      Node,
    );
    if (r.kind !== 'ok') return r;
    const n = r.value;
    const english = n.alternative_titles?.en ?? null;
    const romaji = n.title;
    const runtime = n.average_episode_duration ? Math.round(n.average_episode_duration / 60) : null;
    const airing = normalizeAiringStatus(n.status);
    const showStatus =
      airing === 'finished' || airing === 'cancelled'
        ? 'ended'
        : airing === 'releasing' || airing === 'not_yet_released'
          ? 'returning'
          : 'unknown';
    const meta = finalizeMeta('anime', {
      title: english ?? romaji ?? '',
      altTitles: [romaji, n.alternative_titles?.ja, ...(n.alternative_titles?.synonyms ?? [])].filter(
        (x): x is string => Boolean(x),
      ),
      description: cleanText(n.synopsis, 20_000),
      releaseDate: n.start_date,
      lastAirDate: n.end_date,
      genres: n.genres.map((g) => g.name).filter((x): x is string => Boolean(x)),
      creators: n.studios
        .map((s) => s.name)
        .filter((x): x is string => Boolean(x))
        .map((name) => ({ name, role: 'studio' as const })),
      externalIds: [{ kind: 'mal', value: String(n.id) }],
      showStatus,
      episodeRuntime: runtime,
      titleRomaji: romaji,
      titleEnglish: english,
      titleNative: n.alternative_titles?.ja ?? null,
      animeFormat: normalizeAnimeFormat(n.media_type),
      airingStatus: airing,
      animeSeason: normalizeAnimeSeason(n.start_season?.season),
      seasonYear: posInt(n.start_season?.year ?? null),
      sourceMaterial: normalizeSource(n.source),
      episodeCount: posInt(n.num_episodes),
      isAdult: adultOf(n.nsfw),
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    const seasons: SeasonInput[] = buildAnimeSeasons({ total: n.num_episodes, runtime });
    const relations: ProviderRelation[] = [];
    for (const rel of n.related_anime) {
      const kind = MAL_RELATIONS[(rel.relation_type ?? '').toLowerCase()];
      if (kind && rel.node.title)
        relations.push({
          relation: kind,
          ref: { providerId: 'mal', id: String(rel.node.id), type: 'anime' },
          title: rel.node.title,
          year: null,
        });
    }
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons,
        artworkUrl: safeUrl(n.main_picture?.large ?? n.main_picture?.medium ?? null, MAL_IMG_HOSTS),
        sourceUrl: `https://myanimelist.net/anime/${n.id}`,
        relations: relations.slice(0, 40),
      },
    };
  },
};

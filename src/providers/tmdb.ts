/**
 * TMDB (The Movie Database) — movies and TV. Documented API v3:
 * https://developer.themoviedb.org/reference
 *
 * Auth: either a v3 API key (sent as `api_key` query param) or a v4 "API Read
 * Access Token" (sent as a Bearer header). Free for non-commercial use with
 * attribution. Watch-provider data is supplied to TMDB by JustWatch and must be
 * attributed to JustWatch.
 *
 * Caching policy: remote-only for artwork. TMDB's terms are not explicit about
 * local image caching for desktop apps, so we store only the image reference
 * and proxy it on demand; users can always set a local image instead.
 */
import { z } from 'zod';
import type { ProviderRef, SeasonInput } from '../shared/schemas';
import type { ShowStatus } from '../shared/enums';
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
  ProviderKeys,
  ProviderResult,
  SearchHit,
  WatchProviders,
} from './types';
import { IMDB_ID_RE } from '../domain/links';
import { toPartialDate } from '../domain/dates';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

const SearchSchema = z.object({
  results: looseArray(
    z.object({
      id: z.number().int(),
      title: looseString,
      name: looseString,
      release_date: looseString,
      first_air_date: looseString,
      overview: looseString,
      poster_path: looseString,
    }),
  ),
});

const named = z.object({ name: looseString });

const CreditsSchema = z
  .object({
    cast: looseArray(z.object({ name: looseString, order: looseNumber })),
    crew: looseArray(z.object({ name: looseString, job: looseString })),
  })
  .nullish();

const MovieSchema = z.object({
  id: z.number().int(),
  title: looseString,
  original_title: looseString,
  overview: looseString,
  release_date: looseString,
  runtime: looseNumber,
  original_language: looseString,
  imdb_id: looseString,
  poster_path: looseString,
  genres: looseArray(named),
  credits: CreditsSchema,
  release_dates: z
    .object({
      results: looseArray(
        z.object({
          iso_3166_1: looseString,
          release_dates: looseArray(z.object({ certification: looseString })),
        }),
      ),
    })
    .nullish(),
});

const TvSchema = z.object({
  id: z.number().int(),
  name: looseString,
  original_name: looseString,
  overview: looseString,
  first_air_date: looseString,
  last_air_date: looseString,
  status: looseString,
  episode_run_time: looseArray(z.number()),
  poster_path: looseString,
  genres: looseArray(named),
  networks: looseArray(named),
  created_by: looseArray(named),
  credits: CreditsSchema,
  external_ids: z.object({ imdb_id: looseString }).nullish(),
  seasons: looseArray(
    z.object({ season_number: z.number().int().min(0), name: looseString, episode_count: looseNumber }),
  ),
});

const SeasonSchema = z.object({
  season_number: z.number().int(),
  episodes: looseArray(
    z.object({
      episode_number: z.number().int().min(0),
      name: looseString,
      air_date: looseString,
      runtime: looseNumber,
    }),
  ),
});

const offer = looseArray(z.object({ provider_name: looseString }));
const WatchSchema = z.object({
  results: z.record(
    z.string(),
    z
      .object({ link: looseString, flatrate: offer, rent: offer, buy: offer, free: offer, ads: offer })
      .partial(),
  ),
});

function auth(keys: ProviderKeys, url: string): { url: string; headers: Record<string, string> } {
  const key = keys.apiKey ?? '';
  if (key.startsWith('eyJ')) return { url, headers: { Authorization: `Bearer ${key}` } };
  const sep = url.includes('?') ? '&' : '?';
  return { url: `${url}${sep}api_key=${encodeURIComponent(key)}`, headers: {} };
}

function showStatus(s: string | null): ShowStatus {
  if (!s) return 'unknown';
  if (/returning|production|planned|pilot/i.test(s)) return 'returning';
  if (/ended|cancel/i.test(s)) return 'ended';
  return 'unknown';
}

const MAX_SEASON_FETCHES = 40;

export const tmdbProvider: MetadataProvider = {
  id: 'tmdb',
  displayName: 'TMDB',
  supports: ['movie', 'tv'],
  attribution: {
    text: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    url: 'https://www.themoviedb.org/',
    required: true,
  },
  requiresApiKey: true,
  keyFields: ['apiKey'],
  signupUrl: 'https://www.themoviedb.org/settings/api',
  rateLimit: { maxRequests: 35, perMs: 10_000 },
  cachingPolicy: 'remote-only',
  artworkHosts: ['image.tmdb.org'],

  isConfigured: (keys) => Boolean(keys.apiKey && keys.apiKey.length >= 16),

  async search(q, ctx): Promise<ProviderResult<SearchHit[]>> {
    if (!this.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    const kind = q.type === 'tv' ? 'tv' : 'movie';
    const params = new URLSearchParams({ query: q.query, include_adult: 'false' });
    if (q.year) params.set(kind === 'tv' ? 'first_air_date_year' : 'year', String(q.year));
    const a = auth(ctx.keys, `${API}/search/${kind}?${params.toString()}`);
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: a.url, headers: a.headers, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      SearchSchema,
    );
    if (r.kind !== 'ok') return r;
    return {
      kind: 'ok',
      value: r.value.results.slice(0, 20).map((h) => ({
        ref: { providerId: 'tmdb', id: String(h.id), type: q.type },
        title: h.title ?? h.name ?? '(untitled)',
        year: yearFromDate(h.release_date ?? h.first_air_date),
        type: q.type,
        creators: [],
        synopsis: cleanText(h.overview, 280),
        thumbUrl: h.poster_path ? `${IMG}/w154${h.poster_path}` : null,
      })),
    };
  },

  async fetchDetails(ref: ProviderRef, ctx: ProviderContext) {
    if (!this.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    if (!/^\d+$/.test(ref.id)) return { kind: 'notFound' };
    const signal = ctx.signal ? { signal: ctx.signal } : {};
    if (ref.type === 'movie') {
      const a = auth(ctx.keys, `${API}/movie/${ref.id}?append_to_response=credits,release_dates`);
      const r = await requestJson(
        ctx.http,
        ctx.limiter,
        { url: a.url, headers: a.headers, ...signal },
        MovieSchema,
      );
      if (r.kind !== 'ok') return r;
      const m = r.value;
      const cert =
        m.release_dates?.results
          .find((x) => x.iso_3166_1 === ctx.region)
          ?.release_dates.find((d) => d.certification)?.certification ?? null;
      const meta = finalizeMeta('movie', {
        title: m.title ?? m.original_title ?? '',
        altTitles: m.original_title && m.original_title !== m.title ? [m.original_title] : [],
        description: cleanText(m.overview, 20_000),
        releaseDate: m.release_date,
        genres: m.genres.map((g) => g.name ?? ''),
        creators: [
          ...(m.credits?.crew ?? [])
            .filter((c) => c.job === 'Director')
            .map((c) => ({ name: c.name ?? '', role: 'director' as const })),
          ...(m.credits?.crew ?? [])
            .filter((c) => c.job === 'Screenplay' || c.job === 'Writer')
            .map((c) => ({ name: c.name ?? '', role: 'writer' as const })),
          ...(m.credits?.cast ?? []).slice(0, 6).map((c) => ({ name: c.name ?? '', role: 'cast' as const })),
        ],
        externalIds: [
          { kind: 'tmdb', value: String(m.id) },
          ...(m.imdb_id && IMDB_ID_RE.test(m.imdb_id) ? [{ kind: 'imdb' as const, value: m.imdb_id }] : []),
        ],
        runtimeMinutes: m.runtime,
        originalLanguage: m.original_language,
        ageRating: cert,
      });
      if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
      return {
        kind: 'ok',
        value: {
          ref,
          meta,
          seasons: [],
          artworkUrl: m.poster_path ? `${IMG}/w500${m.poster_path}` : null,
          sourceUrl: safeUrl(`https://www.themoviedb.org/movie/${m.id}`, ['www.themoviedb.org']),
        },
      };
    }
    const a = auth(ctx.keys, `${API}/tv/${ref.id}?append_to_response=credits,external_ids`);
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: a.url, headers: a.headers, ...signal },
      TvSchema,
    );
    if (r.kind !== 'ok') return r;
    const t = r.value;
    const seasons: SeasonInput[] = [];
    for (const s of t.seasons.slice(0, MAX_SEASON_FETCHES)) {
      const sa = auth(ctx.keys, `${API}/tv/${t.id}/season/${s.season_number}`);
      const sr = await requestJson(
        ctx.http,
        ctx.limiter,
        { url: sa.url, headers: sa.headers, ...signal },
        SeasonSchema,
      );
      const episodes =
        sr.kind === 'ok'
          ? sr.value.episodes.map((e) => ({
              number: e.episode_number,
              title: cleanText(e.name, 500),
              airDate: yearFromDate(e.air_date) ? (e.air_date ?? null) : null,
              runtime: e.runtime !== null && Number.isInteger(e.runtime) && e.runtime >= 0 ? e.runtime : null,
            }))
          : [];
      if (sr.kind === 'rateLimited' || sr.kind === 'unauthorized') return sr;
      seasons.push({
        number: s.season_number,
        title: cleanText(s.name, 500),
        episodeCountKnown:
          s.episode_count !== null && s.episode_count >= 0 ? Math.round(s.episode_count) : null,
        episodes,
      });
    }
    const imdb = t.external_ids?.imdb_id;
    const meta = finalizeMeta('tv', {
      title: t.name ?? t.original_name ?? '',
      altTitles: t.original_name && t.original_name !== t.name ? [t.original_name] : [],
      description: cleanText(t.overview, 20_000),
      releaseDate: t.first_air_date,
      lastAirDate: t.last_air_date,
      genres: t.genres.map((g) => g.name ?? ''),
      creators: [
        ...t.created_by.map((c) => ({ name: c.name ?? '', role: 'creator' as const })),
        ...(t.credits?.cast ?? []).slice(0, 6).map((c) => ({ name: c.name ?? '', role: 'cast' as const })),
      ],
      externalIds: [
        { kind: 'tmdb', value: String(t.id) },
        ...(imdb && IMDB_ID_RE.test(imdb) ? [{ kind: 'imdb' as const, value: imdb }] : []),
      ],
      network: t.networks[0]?.name ?? null,
      showStatus: showStatus(t.status),
      episodeRuntime: t.episode_run_time[0] ?? null,
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons: sanitizeSeasons(seasons),
        artworkUrl: t.poster_path ? `${IMG}/w500${t.poster_path}` : null,
        sourceUrl: `https://www.themoviedb.org/tv/${t.id}`,
      },
    };
  },

  async discoverLinks(ref, region, ctx): Promise<ProviderResult<WatchProviders>> {
    if (!this.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    if (!/^\d+$/.test(ref.id) || (ref.type !== 'movie' && ref.type !== 'tv')) return { kind: 'notFound' };
    const a = auth(ctx.keys, `${API}/${ref.type === 'tv' ? 'tv' : 'movie'}/${ref.id}/watch/providers`);
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: a.url, headers: a.headers, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      WatchSchema,
    );
    if (r.kind !== 'ok') return r;
    const entry = r.value.results[region];
    if (!entry) return { kind: 'ok', value: { link: null, providers: [] } };
    const providers: WatchProviders['providers'] = [];
    const add = (
      list: { provider_name: string | null }[] | undefined,
      kind: WatchProviders['providers'][number]['kind'],
    ) => {
      for (const p of list ?? [])
        if (p.provider_name) providers.push({ name: p.provider_name.slice(0, 80), kind });
    };
    add(entry.flatrate, 'stream');
    add(entry.free, 'free');
    add(entry.ads, 'ads');
    add(entry.rent, 'rent');
    add(entry.buy, 'buy');
    // Only the link TMDB returns for this exact title+region is used; nothing is constructed.
    const link = safeUrl(entry.link ?? null, ['www.themoviedb.org', 'www.justwatch.com']);
    return { kind: 'ok', value: { link, providers: providers.slice(0, 40) } };
  },
};

export function sanitizeSeasons(seasons: SeasonInput[]): SeasonInput[] {
  const seen = new Set<number>();
  return seasons
    .filter((s) => (seen.has(s.number) ? false : (seen.add(s.number), true)))
    .slice(0, 200)
    .map((s) => {
      const epSeen = new Set<number>();
      return {
        ...s,
        episodes: s.episodes
          .filter((e) => (epSeen.has(e.number) ? false : (epSeen.add(e.number), true)))
          .slice(0, 2000)
          .map((e) => ({ ...e, airDate: toPartialDate(e.airDate) })),
      };
    });
}

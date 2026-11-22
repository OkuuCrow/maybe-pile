/**
 * TVmaze — TV shows, no API key. https://www.tvmaze.com/api
 * Data licensed CC BY-SA 4.0; attribution to TVmaze with a link is required.
 * Rate limit: at least 20 calls / 10 s per IP (HTTP 429 when exceeded).
 * Caching policy: cache-allowed (CC BY-SA; images are served from static.tvmaze.com).
 */
import { z } from 'zod';
import type { SeasonInput } from '../shared/schemas';
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
import { sanitizeSeasons } from './tmdb';
import type { MetadataProvider, SearchHit } from './types';
import { IMDB_ID_RE } from '../domain/links';

const API = 'https://api.tvmaze.com';

const ShowCore = z.object({
  id: z.number().int(),
  name: looseString,
  premiered: looseString,
  ended: looseString,
  summary: looseString,
  status: looseString,
  runtime: looseNumber,
  averageRuntime: looseNumber,
  language: looseString,
  genres: looseArray(z.string()),
  url: looseString,
  image: z.object({ medium: looseString, original: looseString }).nullish(),
  network: z.object({ name: looseString }).nullish(),
  webChannel: z.object({ name: looseString }).nullish(),
  externals: z.object({ imdb: looseString }).nullish(),
});

const SearchSchema = looseArray(z.object({ show: ShowCore }));

const DetailSchema = ShowCore.extend({
  _embedded: z
    .object({
      episodes: looseArray(
        z.object({
          season: z.number().int().min(0),
          number: looseNumber,
          name: looseString,
          airdate: looseString,
          runtime: looseNumber,
        }),
      ),
      seasons: looseArray(
        z.object({ number: z.number().int().min(0), name: looseString, episodeOrder: looseNumber }),
      ),
      crew: looseArray(z.object({ type: looseString, person: z.object({ name: looseString }) })),
    })
    .partial()
    .nullish(),
});

function status(s: string | null): ShowStatus {
  if (s === 'Running' || s === 'In Development' || s === 'To Be Determined') return 'returning';
  if (s === 'Ended') return 'ended';
  return 'unknown';
}

export const tvmazeProvider: MetadataProvider = {
  id: 'tvmaze',
  displayName: 'TVmaze',
  supports: ['tv'],
  attribution: {
    text: 'TV data provided by TVmaze.com (CC BY-SA 4.0).',
    url: 'https://www.tvmaze.com/',
    required: true,
  },
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  rateLimit: { maxRequests: 18, perMs: 10_000 },
  cachingPolicy: 'cache-allowed',
  artworkHosts: ['static.tvmaze.com'],
  isConfigured: () => true,

  async search(q, ctx) {
    const url = `${API}/search/shows?q=${encodeURIComponent(q.query)}`;
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      SearchSchema,
    );
    if (r.kind !== 'ok') return r;
    let hits: SearchHit[] = r.value.map(({ show }) => ({
      ref: { providerId: 'tvmaze', id: String(show.id), type: 'tv' as const },
      title: show.name ?? '(untitled)',
      year: yearFromDate(show.premiered),
      type: 'tv' as const,
      creators: [show.network?.name ?? show.webChannel?.name ?? ''].filter(Boolean),
      synopsis: cleanText(show.summary, 280, true),
      thumbUrl: safeUrl(show.image?.medium ?? null, this.artworkHosts),
    }));
    if (q.year) hits = [...hits.filter((h) => h.year === q.year), ...hits.filter((h) => h.year !== q.year)];
    return { kind: 'ok', value: hits.slice(0, 20) };
  },

  async fetchDetails(ref, ctx) {
    if (!/^\d+$/.test(ref.id)) return { kind: 'notFound' };
    const url = `${API}/shows/${ref.id}?embed[]=episodes&embed[]=seasons&embed[]=crew`;
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      DetailSchema,
    );
    if (r.kind !== 'ok') return r;
    const s = r.value;
    const emb = s._embedded ?? {};
    const bySeason = new Map<number, SeasonInput>();
    for (const se of emb.seasons ?? []) {
      bySeason.set(se.number, {
        number: se.number,
        title: cleanText(se.name, 500),
        episodeCountKnown:
          se.episodeOrder !== null && se.episodeOrder >= 0 ? Math.round(se.episodeOrder) : null,
        episodes: [],
      });
    }
    for (const e of emb.episodes ?? []) {
      if (e.number === null || !Number.isInteger(e.number) || e.number < 0) continue; // specials without numbers are skipped
      const season = bySeason.get(e.season) ?? {
        number: e.season,
        title: null,
        episodeCountKnown: null,
        episodes: [],
      };
      season.episodes.push({
        number: e.number,
        title: cleanText(e.name, 500),
        airDate: e.airdate && yearFromDate(e.airdate) ? e.airdate : null,
        runtime: e.runtime !== null && Number.isInteger(e.runtime) ? e.runtime : null,
      });
      bySeason.set(e.season, season);
    }
    const imdb = s.externals?.imdb ?? null;
    const meta = finalizeMeta('tv', {
      title: s.name ?? '',
      description: cleanText(s.summary, 20_000, true),
      releaseDate: s.premiered,
      lastAirDate: s.ended,
      genres: s.genres,
      creators: (emb.crew ?? [])
        .filter((c) => c.type === 'Creator')
        .map((c) => ({ name: c.person.name ?? '', role: 'creator' as const })),
      externalIds: [
        { kind: 'tvmaze', value: String(s.id) },
        ...(imdb && IMDB_ID_RE.test(imdb) ? [{ kind: 'imdb' as const, value: imdb }] : []),
      ],
      network: s.network?.name ?? s.webChannel?.name ?? null,
      showStatus: status(s.status),
      episodeRuntime: s.averageRuntime ?? s.runtime,
      originalLanguage: null,
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons: sanitizeSeasons([...bySeason.values()].sort((a, b) => a.number - b.number)),
        artworkUrl: safeUrl(s.image?.original ?? s.image?.medium ?? null, this.artworkHosts),
        sourceUrl: safeUrl(s.url, ['www.tvmaze.com']),
      },
    };
  },
};

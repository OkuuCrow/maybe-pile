/**
 * AniList — anime (as TV shows or movies) and manga/light novels (as books).
 * Public GraphQL API, no key needed for read-only queries: https://docs.anilist.co/
 * Rate limit: documented 90 req/min (temporarily reduced to 30/min at times);
 * 429 responses include Retry-After, which the shared client honours.
 * Free for non-commercial use. Artwork is remote-only (shown from AniList's CDN).
 */
import { z } from 'zod';
import type { MediaType } from '../shared/enums';
import type { SeasonInput } from '../shared/schemas';
import { requestJson } from './http';
import { cleanText, finalizeMeta, looseArray, looseNumber, looseString, safeUrl } from './common';
import type { MetadataProvider, ProviderContext, SearchHit } from './types';

const API = 'https://graphql.anilist.co';
const IMG_HOSTS = ['s4.anilist.co'];

const FORMATS: Record<MediaType, { type: 'ANIME' | 'MANGA'; formats: string[] } | null> = {
  tv: { type: 'ANIME', formats: ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'] },
  movie: { type: 'ANIME', formats: ['MOVIE'] },
  book: { type: 'MANGA', formats: ['MANGA', 'NOVEL', 'ONE_SHOT'] },
  game: null,
};

const FuzzyDate = z.object({ year: looseNumber, month: looseNumber, day: looseNumber }).nullish();

const MediaCore = z.object({
  id: z.number().int(),
  idMal: looseNumber,
  format: looseString,
  title: z.object({ romaji: looseString, english: looseString, native: looseString }),
  startDate: FuzzyDate,
  coverImage: z.object({ large: looseString, extraLarge: looseString }).nullish(),
  description: looseString,
});

const SearchSchema = z.object({
  data: z.object({ Page: z.object({ media: looseArray(MediaCore) }) }),
});

const DetailSchema = z.object({
  data: z.object({
    Media: MediaCore.extend({
      synonyms: looseArray(z.string()),
      endDate: FuzzyDate,
      status: looseString,
      episodes: looseNumber,
      duration: looseNumber,
      chapters: looseNumber,
      volumes: looseNumber,
      genres: looseArray(z.string()),
      siteUrl: looseString,
      studios: z.object({ nodes: looseArray(z.object({ name: looseString })) }).nullish(),
      staff: z
        .object({
          edges: looseArray(
            z.object({ role: looseString, node: z.object({ name: z.object({ full: looseString }) }) }),
          ),
        })
        .nullish(),
    }).nullable(),
  }),
});

const SEARCH_QUERY = `query ($search: String, $type: MediaType, $formats: [MediaFormat]) {
  Page(perPage: 20) {
    media(search: $search, type: $type, format_in: $formats, isAdult: false, sort: SEARCH_MATCH) {
      id idMal format title { romaji english native } startDate { year month day }
      coverImage { large extraLarge } description(asHtml: false)
    }
  }
}`;

const DETAIL_QUERY = `query ($id: Int) {
  Media(id: $id) {
    id idMal format title { romaji english native } synonyms description(asHtml: false)
    startDate { year month day } endDate { year month day } status episodes duration chapters volumes
    genres siteUrl coverImage { large extraLarge }
    studios(isMain: true) { nodes { name } }
    staff(perPage: 8, sort: RELEVANCE) { edges { role node { name { full } } } }
  }
}`;

function fuzzyToPartial(d: z.infer<typeof FuzzyDate>): string | null {
  if (!d?.year) return null;
  const y = String(Math.round(d.year));
  if (!d.month) return y;
  const m = String(Math.round(d.month)).padStart(2, '0');
  if (!d.day) return `${y}-${m}`;
  return `${y}-${m}-${String(Math.round(d.day)).padStart(2, '0')}`;
}

function post(ctx: ProviderContext, query: string, variables: Record<string, unknown>) {
  return {
    url: API,
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

/** English title when available, otherwise romanized. */
const titleOf = (t: { romaji: string | null; english: string | null; native: string | null }) =>
  t.english ?? t.romaji ?? t.native ?? '';

export const anilistProvider: MetadataProvider = {
  id: 'anilist',
  displayName: 'AniList',
  supports: ['tv', 'movie', 'book'],
  attribution: {
    text: 'Anime and manga data from AniList (anilist.co).',
    url: 'https://anilist.co/',
    required: false,
  },
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  rateLimit: { maxRequests: 25, perMs: 60_000 },
  cachingPolicy: 'remote-only',
  artworkHosts: IMG_HOSTS,
  isConfigured: () => true,

  async search(q, ctx) {
    const f = FORMATS[q.type];
    if (!f) return { kind: 'ok', value: [] };
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      post(ctx, SEARCH_QUERY, { search: q.query, type: f.type, formats: f.formats }),
      SearchSchema,
    );
    if (r.kind !== 'ok') return r;
    let hits = r.value.data.Page.media.map<SearchHit>((m) => ({
      ref: { providerId: 'anilist', id: String(m.id), type: q.type },
      title: titleOf(m.title) || '(untitled)',
      year: m.startDate?.year ? Math.round(m.startDate.year) : null,
      type: q.type,
      creators: [m.format ?? ''].filter(Boolean).map((x) => x.replace(/_/g, ' ')),
      synopsis: cleanText(m.description, 280, true),
      thumbUrl: safeUrl(m.coverImage?.large ?? null, IMG_HOSTS),
    }));
    if (q.year) hits = [...hits.filter((h) => h.year === q.year), ...hits.filter((h) => h.year !== q.year)];
    return { kind: 'ok', value: hits };
  },

  async fetchDetails(ref, ctx) {
    if (!/^\d{1,10}$/.test(ref.id) || !FORMATS[ref.type]) return { kind: 'notFound' };
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      post(ctx, DETAIL_QUERY, { id: Number(ref.id) }),
      DetailSchema,
    );
    if (r.kind !== 'ok') return r;
    const m = r.value.data.Media;
    if (!m) return { kind: 'notFound' };
    const title = titleOf(m.title);
    const alt = [m.title.romaji, m.title.native, m.title.english, ...m.synonyms].filter(
      (t): t is string => Boolean(t) && t !== title,
    );
    // Roles may carry qualifiers, e.g. "Story & Art (vols 1-41)"; compare the base role only.
    const staff = (m.staff?.edges ?? []).map((e) => ({
      role: (e.role ?? '')
        .toLowerCase()
        .replace(/\s*\(.*\)\s*$/, '')
        .trim(),
      name: e.node.name.full ?? '',
    }));
    // Only main credits: AniList staff roles include many assistants ("Animation Director", "Art (assistant)").
    const creators =
      ref.type === 'book'
        ? [
            ...staff
              .filter((s) => /^(story( & art)?|original (story|creator))$/.test(s.role))
              .map((s) => ({ name: s.name, role: 'author' as const })),
            ...staff
              .filter((s) => s.role === 'art')
              .map((s) => ({ name: s.name, role: 'illustrator' as const })),
          ]
        : [
            ...staff
              .filter((s) => s.role === 'director')
              .map((s) => ({ name: s.name, role: 'director' as const })),
            ...staff
              .filter((s) => /^original (creator|story)$/.test(s.role))
              .map((s) => ({ name: s.name, role: 'creator' as const })),
          ];
    const status =
      m.status === 'FINISHED' || m.status === 'CANCELLED'
        ? 'ended'
        : m.status === 'RELEASING' || m.status === 'NOT_YET_RELEASED'
          ? 'returning'
          : 'unknown';
    const meta = finalizeMeta(ref.type, {
      title,
      altTitles: alt.slice(0, 8),
      description: cleanText(m.description, 20_000, true),
      releaseDate: fuzzyToPartial(m.startDate),
      lastAirDate: ref.type === 'tv' ? fuzzyToPartial(m.endDate) : null,
      genres: m.genres,
      creators,
      externalIds: [
        { kind: 'anilist', value: String(m.id) },
        ...(m.idMal && Number.isInteger(m.idMal) && m.idMal > 0
          ? [{ kind: 'mal' as const, value: String(m.idMal) }]
          : []),
      ],
      network: ref.type === 'tv' ? (m.studios?.nodes[0]?.name ?? null) : null,
      showStatus: ref.type === 'tv' ? status : null,
      episodeRuntime: ref.type === 'tv' ? m.duration : null,
      runtimeMinutes: ref.type === 'movie' ? m.duration : null,
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    // Anime: a single season with numbered episodes when the count is known.
    const seasons: SeasonInput[] = [];
    if (ref.type === 'tv') {
      const count =
        m.episodes !== null && Number.isInteger(m.episodes) && m.episodes > 0 && m.episodes <= 2000
          ? m.episodes
          : null;
      seasons.push({
        number: 1,
        title: null,
        episodeCountKnown: count,
        episodes: Array.from({ length: count ?? 0 }, (_, i) => ({
          number: i + 1,
          title: null,
          airDate: null,
          runtime: m.duration !== null && Number.isInteger(m.duration) ? m.duration : null,
        })),
      });
    }
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons,
        artworkUrl: safeUrl(m.coverImage?.extraLarge ?? m.coverImage?.large ?? null, IMG_HOSTS),
        sourceUrl: safeUrl(m.siteUrl, ['anilist.co']),
      },
    };
  },
};

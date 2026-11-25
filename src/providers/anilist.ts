/**
 * AniList — anime, plus anime-as-TV/movie and manga/light novels as books.
 * Public GraphQL API, no key needed for read-only queries: https://docs.anilist.co/
 * Rate limit: documented 90 req/min (degraded to 30/min at times, checked
 * 2026-11-24); 429 responses include Retry-After, which the shared client honours.
 *
 * TERMS (see docs/providers.md): free for non-commercial use, but the terms
 * prohibit use "within competing, non-complementary services of the same
 * nature … This includes … anime and manga list or tracker services", and
 * prohibit backup/data-storage use. Maybe Pile is a personal backlog tracker,
 * so AniList is OFF by default and the clause is shown in Settings; the user
 * decides. Artwork is remote-only (shown from AniList's CDN, never cached).
 */
import { z } from 'zod';
import type { MediaType } from '../shared/enums';
import type { SeasonInput } from '../shared/schemas';
import {
  buildAnimeSeasons,
  normalizeAiringStatus,
  normalizeAnimeFormat,
  normalizeAnimeSeason,
  normalizeSource,
} from '../domain/anime';
import { requestJson } from './http';
import { cleanText, finalizeMeta, looseArray, looseNumber, looseString, safeUrl } from './common';
import type { MetadataProvider, ProviderContext, ProviderRelation, SearchHit } from './types';

const API = 'https://graphql.anilist.co';
const IMG_HOSTS = ['s4.anilist.co'];

const FORMATS: Record<MediaType, { type: 'ANIME' | 'MANGA'; formats: string[] } | null> = {
  tv: { type: 'ANIME', formats: ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'] },
  movie: { type: 'ANIME', formats: ['MOVIE'] },
  book: { type: 'MANGA', formats: ['MANGA', 'NOVEL', 'ONE_SHOT'] },
  anime: { type: 'ANIME', formats: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'] },
  game: null,
};

const RELATION_MAP: Record<string, ProviderRelation['relation']> = {
  PREQUEL: 'prequel',
  SEQUEL: 'sequel',
  SPIN_OFF: 'spin_off',
  SIDE_STORY: 'side_story',
  SOURCE: 'adaptation_of',
  ADAPTATION: 'adapted_as',
  ALTERNATIVE: 'remake_of',
  PARENT: 'same_franchise',
  SUMMARY: 'same_franchise',
  COMPILATION: 'same_franchise',
  CONTAINS: 'same_franchise',
  OTHER: 'same_franchise',
};

const FuzzyDate = z.object({ year: looseNumber, month: looseNumber, day: looseNumber }).nullish();

const MediaCore = z.object({
  id: z.number().int(),
  idMal: looseNumber,
  format: looseString,
  isAdult: z.boolean().nullish(),
  title: z.object({ romaji: looseString, english: looseString, native: looseString }),
  startDate: FuzzyDate,
  coverImage: z.object({ large: looseString, extraLarge: looseString }).nullish(),
  description: looseString,
});

const SearchSchema = z.object({
  data: z.object({ Page: z.object({ media: looseArray(MediaCore) }) }),
});

const RelationEdge = z.object({
  relationType: looseString,
  node: z.object({
    id: z.number().int(),
    type: looseString,
    format: looseString,
    title: z.object({ romaji: looseString, english: looseString, native: looseString }),
    startDate: FuzzyDate,
  }),
});

const DetailSchema = z.object({
  data: z.object({
    Media: MediaCore.extend({
      synonyms: looseArray(z.string()),
      endDate: FuzzyDate,
      status: looseString,
      season: looseString,
      seasonYear: looseNumber,
      source: looseString,
      episodes: looseNumber,
      duration: looseNumber,
      chapters: looseNumber,
      volumes: looseNumber,
      genres: looseArray(z.string()),
      siteUrl: looseString,
      bannerImage: looseString,
      nextAiringEpisode: z.object({ airingAt: looseNumber, episode: looseNumber }).nullish(),
      studios: z
        .object({
          nodes: looseArray(z.object({ name: looseString, isAnimationStudio: z.boolean().nullish() })),
        })
        .nullish(),
      staff: z
        .object({
          edges: looseArray(
            z.object({ role: looseString, node: z.object({ name: z.object({ full: looseString }) }) }),
          ),
        })
        .nullish(),
      relations: z.object({ edges: looseArray(RelationEdge) }).nullish(),
    }).nullable(),
  }),
});

const SEARCH_QUERY = `query ($search: String, $type: MediaType, $formats: [MediaFormat], $adult: Boolean) {
  Page(perPage: 20) {
    media(search: $search, type: $type, format_in: $formats, isAdult: $adult, sort: SEARCH_MATCH) {
      id idMal format isAdult title { romaji english native } startDate { year month day }
      coverImage { large extraLarge } description(asHtml: false)
    }
  }
}`;

const DETAIL_QUERY = `query ($id: Int) {
  Media(id: $id) {
    id idMal format isAdult title { romaji english native } synonyms description(asHtml: false)
    startDate { year month day } endDate { year month day } status season seasonYear source
    episodes duration chapters volumes genres siteUrl bannerImage coverImage { large extraLarge }
    nextAiringEpisode { airingAt episode }
    studios(isMain: true) { nodes { name isAnimationStudio } }
    staff(perPage: 8, sort: RELEVANCE) { edges { role node { name { full } } } }
    relations { edges { relationType node { id type format title { romaji english native } startDate { year } } } }
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

const posInt = (n: number | null) => (n !== null && Number.isInteger(n) && n > 0 ? n : null);

export const ANILIST_TERMS_NOTE =
  'AniList\'s API terms prohibit use in "anime and manga list or tracker services" and as a backup or data-storage service. Maybe Pile is a personal backlog tracker, so this source is off by default. Turn it on only if you\'ve read the terms (docs.anilist.co) and are comfortable with them.';

export const anilistProvider: MetadataProvider = {
  id: 'anilist',
  displayName: 'AniList',
  supports: ['anime', 'tv', 'movie', 'book'],
  attribution: {
    text: 'Anime and manga data from AniList (anilist.co).',
    url: 'https://anilist.co/',
    required: false,
  },
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  enabledByDefault: false,
  termsNote: ANILIST_TERMS_NOTE,
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
      post(ctx, SEARCH_QUERY, {
        search: q.query,
        type: f.type,
        formats: f.formats,
        // `isAdult: false` excludes adult titles; omitting the filter (null) includes both.
        adult: q.includeAdult ? null : false,
      }),
      SearchSchema,
    );
    if (r.kind !== 'ok') return r;
    let hits = r.value.data.Page.media
      .filter((m) => q.includeAdult || m.isAdult !== true)
      .map<SearchHit>((m) => ({
        ref: { providerId: 'anilist', id: String(m.id), type: q.type },
        title: titleOf(m.title) || '(untitled)',
        year: m.startDate?.year ? Math.round(m.startDate.year) : null,
        type: q.type,
        creators: [m.format ?? ''].filter(Boolean).map((x) => x.replace(/_/g, ' ')),
        synopsis: cleanText(m.description, 280, true),
        thumbUrl: safeUrl(m.coverImage?.large ?? null, IMG_HOSTS),
        crossIds: {
          anilist: String(m.id),
          ...(posInt(m.idMal) ? { mal: String(m.idMal) } : {}),
        },
        adult: m.isAdult === true,
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
    const studios = (m.studios?.nodes ?? [])
      .filter((s) => s.isAnimationStudio !== false)
      .map((s) => s.name)
      .filter((n): n is string => Boolean(n));
    // Only main credits: AniList staff roles include many assistants ("Animation Director", "Art (assistant)").
    const directors = staff
      .filter((s) => s.role === 'director')
      .map((s) => ({ name: s.name, role: 'director' as const }));
    const originals = staff
      .filter((s) => /^original (creator|story)$/.test(s.role))
      .map((s) => ({ name: s.name, role: 'creator' as const }));
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
        : ref.type === 'anime'
          ? [...studios.map((name) => ({ name, role: 'studio' as const })), ...directors, ...originals]
          : [...directors, ...originals];
    const airing = normalizeAiringStatus(m.status);
    const showStatus =
      airing === 'finished' || airing === 'cancelled'
        ? 'ended'
        : airing === 'releasing' || airing === 'not_yet_released'
          ? 'returning'
          : 'unknown';
    const episodic = ref.type === 'tv' || ref.type === 'anime';
    const next = m.nextAiringEpisode;
    const nextAt =
      next?.airingAt && Number.isFinite(next.airingAt) ? new Date(next.airingAt * 1000).toISOString() : null;
    const isAnime = ref.type === 'anime';
    const meta = finalizeMeta(ref.type, {
      title,
      altTitles: alt.slice(0, 8),
      description: cleanText(m.description, 20_000, true),
      releaseDate: fuzzyToPartial(m.startDate),
      lastAirDate: episodic ? fuzzyToPartial(m.endDate) : null,
      genres: m.genres,
      creators,
      externalIds: [
        { kind: 'anilist', value: String(m.id) },
        ...(posInt(m.idMal) ? [{ kind: 'mal' as const, value: String(m.idMal) }] : []),
      ],
      network: ref.type === 'tv' ? (studios[0] ?? null) : null,
      showStatus: episodic ? showStatus : null,
      episodeRuntime: episodic ? m.duration : null,
      runtimeMinutes: ref.type === 'movie' ? m.duration : null,
      ...(isAnime
        ? {
            titleRomaji: m.title.romaji,
            titleEnglish: m.title.english,
            titleNative: m.title.native,
            animeFormat: normalizeAnimeFormat(m.format),
            airingStatus: airing,
            animeSeason: normalizeAnimeSeason(m.season),
            seasonYear: posInt(m.seasonYear),
            sourceMaterial: normalizeSource(m.source),
            episodeCount: posInt(m.episodes),
            nextEpisode: posInt(next?.episode ?? null),
            nextAiringAt: nextAt,
            isAdult: m.isAdult === true,
          }
        : {}),
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    const seasons: SeasonInput[] = episodic
      ? buildAnimeSeasons({
          total: m.episodes,
          // Ongoing: the next airing episode number minus one have aired.
          aired: next?.episode ? next.episode - 1 : null,
          runtime: m.duration,
        })
      : [];
    const relations: ProviderRelation[] = [];
    if (isAnime) {
      for (const e of m.relations?.edges ?? []) {
        const rel = e.relationType ? RELATION_MAP[e.relationType] : undefined;
        if (!rel || e.node.type !== 'ANIME') continue;
        const t = titleOf(e.node.title);
        if (!t) continue;
        relations.push({
          relation: rel,
          ref: { providerId: 'anilist', id: String(e.node.id), type: 'anime' },
          title: t,
          year: posInt(e.node.startDate?.year ?? null),
        });
      }
    }
    const banner = safeUrl(m.bannerImage, IMG_HOSTS);
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons,
        artworkUrl: safeUrl(m.coverImage?.extraLarge ?? m.coverImage?.large ?? null, IMG_HOSTS),
        sourceUrl: safeUrl(m.siteUrl, ['anilist.co']),
        relations: relations.slice(0, 40),
        extraArt: banner ? [{ slot: 'banner', url: banner }] : [],
      },
    };
  },
};

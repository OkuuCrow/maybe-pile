/**
 * Wikidata — movies, TV, games and books. No API key. Data is CC0 (public domain).
 * Documented MediaWiki Action API: https://www.wikidata.org/w/api.php
 *   wbsearchentities  → candidate items for a title
 *   wbgetentities     → claims (structured statements) and labels
 *
 * Wikidata is especially useful as a keyless source of *exact* identifiers:
 * IMDb (P345), TMDB (P4947/P4983), Steam app ID (P1733), ISBN (P212/P957),
 * AniList/MyAnimeList IDs (P8729/P4086, P4087), which power links and duplicate detection.
 *
 * Artwork: none. Wikidata images (P18) are usually photos, not covers, so we
 * don't guess. Users can add their own image.
 */
import { z } from 'zod';
import type { MediaType } from '../shared/enums';
import type { Creator, ExternalId, MetadataFields } from '../shared/schemas';
import { requestJson } from './http';
import { cleanText, finalizeMeta, yearFromDate } from './common';
import type { MetadataProvider, ProviderContext, ProviderResult, SearchHit } from './types';
import { IMDB_ID_RE, STEAM_APP_ID_RE } from '../domain/links';
import { normalizeIsbn } from '../domain/normalize';

const API = 'https://www.wikidata.org/w/api.php';

/** Instance-of (P31) classes accepted for each media type, plus a description fallback. */
const TYPE_CLASSES: Record<MediaType, { ids: ReadonlySet<string>; describe: RegExp }> = {
  // Not offered for anime searches (see `supports`); present so the map stays total.
  anime: { ids: new Set(['Q1107', 'Q63952888', 'Q20650540', 'Q220898']), describe: /\banime\b/i },
  movie: {
    ids: new Set(['Q11424', 'Q24869', 'Q202866', 'Q506240', 'Q229390', 'Q93204', 'Q20650540', 'Q24862']),
    describe: /\b(film|movie)\b/i,
  },
  tv: {
    ids: new Set([
      'Q5398426',
      'Q581714',
      'Q1259759',
      'Q63952888',
      'Q117467246',
      'Q15416',
      'Q526877',
      'Q21191270',
    ]),
    describe:
      /\b(television|tv series|tv programme|tv program|miniseries|sitcom|web series|anime (television )?series|soap opera)\b/i,
  },
  game: {
    ids: new Set(['Q7889', 'Q4393107', 'Q865493', 'Q64170203']),
    describe: /\bvideo game\b/i,
  },
  book: {
    ids: new Set(['Q7725634', 'Q8261', 'Q571', 'Q47461344', 'Q149537', 'Q1004', 'Q14406742', 'Q21198342']),
    describe: /\b(novel|novella|book|memoir|short story collection|manga|graphic novel|comic)\b/i,
  },
};

const SearchSchema = z.object({
  search: z
    .array(
      z.object({
        id: z.string().regex(/^Q\d+$/),
        label: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .max(50),
});

const Snak = z.object({
  mainsnak: z.object({
    snaktype: z.string(),
    datavalue: z.object({ value: z.unknown(), type: z.string() }).optional(),
  }),
  rank: z.string().optional(),
});

const EntitySchema = z.object({
  id: z.string(),
  labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
  descriptions: z.record(z.string(), z.object({ value: z.string() })).optional(),
  aliases: z.record(z.string(), z.array(z.object({ value: z.string() }))).optional(),
  claims: z.record(z.string(), z.array(Snak)).optional(),
  missing: z.string().optional(),
});
type Entity = z.infer<typeof EntitySchema>;

const EntitiesSchema = z.object({ entities: z.record(z.string(), EntitySchema) });

const label = (e: Entity | undefined): string | null =>
  e?.labels?.['en']?.value ?? e?.labels?.['mul']?.value ?? null;
const description = (e: Entity | undefined): string | null => e?.descriptions?.['en']?.value ?? null;

/** Claims for a property, skipping deprecated statements. */
function values(e: Entity, prop: string): unknown[] {
  return (e.claims?.[prop] ?? [])
    .filter((c) => c.rank !== 'deprecated' && c.mainsnak.snaktype === 'value')
    .map((c) => c.mainsnak.datavalue?.value);
}
function strings(e: Entity, prop: string): string[] {
  return values(e, prop).filter((v): v is string => typeof v === 'string');
}
function itemIds(e: Entity, prop: string): string[] {
  return values(e, prop)
    .map((v) => (typeof v === 'object' && v !== null && 'id' in v ? String((v as { id: unknown }).id) : null))
    .filter((v): v is string => v !== null && /^Q\d+$/.test(v));
}
function quantity(e: Entity, prop: string): number | null {
  for (const v of values(e, prop)) {
    if (typeof v === 'object' && v !== null && 'amount' in v) {
      const n = Number((v as { amount: unknown }).amount);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** Wikidata time → partial date by precision (11 day, 10 month, 9 year). Earliest value wins. */
export function wikidataDate(e: Entity, prop: string): string | null {
  const out: string[] = [];
  for (const v of values(e, prop)) {
    if (typeof v !== 'object' || v === null) continue;
    const { time, precision } = v as { time?: unknown; precision?: unknown };
    if (typeof time !== 'string') continue;
    const m = /^\+(\d{4})-(\d{2})-(\d{2})/.exec(time);
    if (!m) continue;
    const p = typeof precision === 'number' ? precision : 9;
    if (p >= 11 && m[3] !== '00') out.push(`${m[1]}-${m[2]}-${m[3]}`);
    else if (p >= 10 && m[2] !== '00') out.push(`${m[1]}-${m[2]}`);
    else if (p >= 9) out.push(m[1] ?? '');
  }
  return out.filter(Boolean).sort()[0] ?? null;
}

function matchesType(e: Entity, type: MediaType): boolean {
  const cls = TYPE_CLASSES[type];
  if (itemIds(e, 'P31').some((id) => cls.ids.has(id))) return true;
  const d = description(e);
  return (
    d !== null && cls.describe.test(d) && !/\b(series of|franchise|character|soundtrack|episode)\b/i.test(d)
  );
}

async function getEntities(
  ctx: ProviderContext,
  ids: string[],
  props: string,
): Promise<ProviderResult<Record<string, Entity>>> {
  if (ids.length === 0) return { kind: 'ok', value: {} };
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.slice(0, 50).join('|'),
    props,
    languages: 'en|mul',
    format: 'json',
  });
  const r = await requestJson(
    ctx.http,
    ctx.limiter,
    { url: `${API}?${params.toString()}`, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    EntitiesSchema,
  );
  return r.kind === 'ok' ? { kind: 'ok', value: r.value.entities } : r;
}

export const wikidataProvider: MetadataProvider = {
  id: 'wikidata',
  displayName: 'Wikidata',
  supports: ['movie', 'tv', 'game', 'book'],
  attribution: {
    text: 'Data from Wikidata, available under CC0 (public domain).',
    url: 'https://www.wikidata.org/',
    required: false,
  },
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  // Wikimedia asks API clients to be polite and identify themselves; stay well under any limit.
  rateLimit: { maxRequests: 10, perMs: 2_000 },
  cachingPolicy: 'remote-only',
  artworkHosts: [],
  isConfigured: () => true,

  async search(q, ctx) {
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: q.query,
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: '30',
      format: 'json',
    });
    const s = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: `${API}?${params.toString()}`, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      SearchSchema,
    );
    if (s.kind !== 'ok') return s;
    const ids = s.value.search.map((h) => h.id);
    const ents = await getEntities(ctx, ids, 'labels|descriptions|claims');
    if (ents.kind !== 'ok') return ents;
    let hits: SearchHit[] = [];
    for (const id of ids) {
      const e = ents.value[id];
      if (!e || !matchesType(e, q.type)) continue;
      const date = wikidataDate(e, 'P577') ?? wikidataDate(e, 'P580');
      hits.push({
        ref: { providerId: 'wikidata', id, type: q.type },
        title: label(e) ?? s.value.search.find((x) => x.id === id)?.label ?? id,
        year: yearFromDate(date),
        type: q.type,
        creators: [],
        synopsis: cleanText(description(e), 280),
        thumbUrl: null,
      });
    }
    if (q.year) hits = [...hits.filter((h) => h.year === q.year), ...hits.filter((h) => h.year !== q.year)];
    return { kind: 'ok', value: hits.slice(0, 20) };
  },

  async fetchDetails(ref, ctx) {
    if (!/^Q\d{1,12}$/.test(ref.id)) return { kind: 'notFound' };
    const r = await getEntities(ctx, [ref.id], 'labels|descriptions|claims|aliases');
    if (r.kind !== 'ok') return r;
    const e = r.value[ref.id];
    if (!e || e.missing !== undefined) return { kind: 'notFound' };

    const roleProps: [string, Creator['role']][] =
      ref.type === 'movie'
        ? [
            ['P57', 'director'],
            ['P58', 'writer'],
            ['P161', 'cast'],
          ]
        : ref.type === 'tv'
          ? [
              ['P170', 'creator'],
              ['P161', 'cast'],
            ] // per-episode directors are omitted
          : ref.type === 'game'
            ? [
                ['P178', 'developer'],
                ['P123', 'publisher'],
              ]
            : [
                ['P50', 'author'],
                ['P655', 'translator'],
                ['P110', 'illustrator'],
              ];
    const refIds = new Set<string>();
    for (const [p] of roleProps)
      itemIds(e, p)
        .slice(0, p === 'P161' ? 6 : 10)
        .forEach((id) => refIds.add(id));
    itemIds(e, 'P136')
      .slice(0, 8)
      .forEach((id) => refIds.add(id));
    itemIds(e, 'P449')
      .slice(0, 2)
      .forEach((id) => refIds.add(id));
    if (ref.type === 'book')
      itemIds(e, 'P123')
        .slice(0, 2)
        .forEach((id) => refIds.add(id));
    const names = await getEntities(ctx, [...refIds], 'labels');
    if (names.kind === 'rateLimited') return names;
    const nameOf = (id: string) => (names.kind === 'ok' ? label(names.value[id]) : null);

    const creators: Creator[] = [];
    for (const [p, role] of roleProps) {
      for (const id of itemIds(e, p).slice(0, p === 'P161' ? 6 : 10)) {
        const n = nameOf(id);
        if (n) creators.push({ name: n, role });
      }
    }
    const ids: ExternalId[] = [{ kind: 'wikidata', value: ref.id }];
    const imdb = strings(e, 'P345').find((v) => IMDB_ID_RE.test(v));
    if (imdb && (ref.type === 'movie' || ref.type === 'tv')) ids.push({ kind: 'imdb', value: imdb });
    const tmdb = strings(e, ref.type === 'tv' ? 'P4983' : 'P4947').find((v) => /^\d+$/.test(v));
    if (tmdb && (ref.type === 'movie' || ref.type === 'tv')) ids.push({ kind: 'tmdb', value: tmdb });
    const steam = strings(e, 'P1733').find((v) => STEAM_APP_ID_RE.test(v));
    if (steam && ref.type === 'game') ids.push({ kind: 'steam', value: steam });
    const anilist = strings(e, ref.type === 'book' ? 'P8731' : 'P8729').find((v) => /^\d+$/.test(v));
    if (anilist && ref.type !== 'game') ids.push({ kind: 'anilist', value: anilist });
    const mal = strings(e, ref.type === 'book' ? 'P4087' : 'P4086').find((v) => /^\d+$/.test(v));
    if (mal && ref.type !== 'game') ids.push({ kind: 'mal', value: mal });
    const isbn13 =
      strings(e, 'P212')
        .map((v) => normalizeIsbn(v).isbn13)
        .find(Boolean) ?? null;
    const isbn10 =
      strings(e, 'P957')
        .map((v) => normalizeIsbn(v).isbn10)
        .find(Boolean) ?? null;
    if (ref.type === 'book') {
      if (isbn13) ids.push({ kind: 'isbn13', value: isbn13 });
      if (isbn10) ids.push({ kind: 'isbn10', value: isbn10 });
    }

    const runtime = quantity(e, 'P2047');
    const ended = wikidataDate(e, 'P582');
    const partial: Partial<MetadataFields> & { title: string } = {
      title: label(e) ?? '',
      altTitles: (e.aliases?.['en'] ?? []).map((a) => a.value).slice(0, 5),
      description: cleanText(description(e), 2_000),
      releaseDate: wikidataDate(e, 'P577') ?? wikidataDate(e, 'P580'),
      genres: itemIds(e, 'P136')
        .slice(0, 8)
        .map(nameOf)
        .filter((g): g is string => Boolean(g)),
      creators,
      externalIds: ids,
      runtimeMinutes: runtime !== null ? Math.round(runtime) : null,
      network: itemIds(e, 'P449').map(nameOf).find(Boolean) ?? null,
      showStatus: ref.type === 'tv' ? (ended ? 'ended' : 'unknown') : null,
      lastAirDate: ended,
      pageCount: quantity(e, 'P1104'),
      publisher: ref.type === 'book' ? (itemIds(e, 'P123').map(nameOf).find(Boolean) ?? null) : null,
      isbn13,
      isbn10,
    };
    const meta = finalizeMeta(ref.type, partial);
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons: [],
        artworkUrl: null,
        sourceUrl: `https://www.wikidata.org/wiki/${ref.id}`,
      },
    };
  },
};

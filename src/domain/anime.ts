/**
 * Anime helpers shared by providers, services and the UI. Pure functions only.
 */
import type {
  AiringStatus,
  AnimeFormat,
  AnimeSeason,
  AudioPref,
  ExternalIdKind,
  TitleLanguage,
} from '../shared/enums';
import type { MetadataFields, SeasonInput } from '../shared/schemas';

/** Upper bound for generated episode lists; long-running shows beyond it get "count unknown". */
export const MAX_GENERATED_EPISODES = 2000;

/** Normalizes the many provider spellings ("TV_SHORT", "tv short", "Movie", "OVA") to our enum. */
export function normalizeAnimeFormat(raw: string | null | undefined): AnimeFormat | null {
  if (!raw) return null;
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  switch (k) {
    case 'tv':
      return 'tv';
    case 'tv_short':
      return 'tv_short';
    case 'movie':
      return 'movie';
    case 'ova':
      return 'ova';
    case 'ona':
      return 'ona';
    case 'special':
    case 'tv_special':
      return 'special';
    case 'music':
    case 'pv':
    case 'cm':
      return 'music';
    default:
      return null;
  }
}

export function normalizeAiringStatus(raw: string | null | undefined): AiringStatus | null {
  if (!raw) return null;
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  switch (k) {
    case 'finished':
    case 'finished_airing':
    case 'finished_publishing':
      return 'finished';
    case 'releasing':
    case 'current':
    case 'currently_airing':
      return 'releasing';
    case 'not_yet_released':
    case 'not_yet_aired':
    case 'upcoming':
    case 'unreleased':
    case 'tba':
      return 'not_yet_released';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'hiatus':
      return 'hiatus';
    default:
      return null;
  }
}

export function normalizeAnimeSeason(raw: string | null | undefined): AnimeSeason | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  if (k === 'autumn') return 'fall';
  return k === 'winter' || k === 'spring' || k === 'summer' || k === 'fall' ? k : null;
}

/**
 * Season of a start date: Jan–Mar winter, Apr–Jun spring, Jul–Sep summer,
 * Oct–Dec fall. Shows premiering in the last week of a quarter (day ≥ 25 of
 * Mar/Jun/Sep/Dec) belong to the next season, matching how anime seasons are
 * usually listed (e.g. a 29 Sep premiere is a Fall show). Month-only dates use
 * the month alone.
 */
export function seasonOfDate(date: string | null): { season: AnimeSeason; year: number } | null {
  const m = date ? /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(date) : null;
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]);
  const day = m[3] ? Number(m[3]) : 1;
  if (month % 3 === 0 && day >= 25) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  const season: AnimeSeason = month <= 3 ? 'winter' : month <= 6 ? 'spring' : month <= 9 ? 'summer' : 'fall';
  return { season, year };
}

/** Normalizes a source-material string ("LIGHT_NOVEL" → "Light novel"). */
export function normalizeSource(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/_/g, ' ').toLowerCase();
  if (!t || t === 'unknown' || t === 'other') return null;
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 40);
}

export interface EpisodeListInput {
  /** Total announced episodes (null = unknown / ongoing). */
  total: number | null;
  /** Episodes that have aired so far (for ongoing shows). */
  aired?: number | null;
  runtime: number | null;
  /** Provider episode rows, when available. `number` is the absolute episode number. */
  episodes?: {
    number: number | null;
    title: string | null;
    airDate: string | null;
    runtime: number | null;
  }[];
}

/**
 * Builds a single-season episode list (anime numbering is absolute). Edge cases:
 * - unknown total and no rows → empty season with unknown count (user can add episodes);
 * - ongoing shows → only aired episodes are listed, count stays unknown;
 * - rows with missing/duplicate/out-of-range numbers are skipped;
 * - movies/one-shots (total 1) → a single episode;
 * - absurd totals (> MAX_GENERATED_EPISODES) → count unknown, nothing generated.
 */
export function buildAnimeSeasons(input: EpisodeListInput): SeasonInput[] {
  const okInt = (n: number | null | undefined, max = MAX_GENERATED_EPISODES) =>
    n !== null && n !== undefined && Number.isInteger(n) && n > 0 && n <= max ? n : null;
  const total = okInt(input.total);
  const aired = okInt(input.aired ?? null);
  const runtime = okInt(input.runtime, 10_000);
  const byNumber = new Map<
    number,
    { title: string | null; airDate: string | null; runtime: number | null }
  >();
  for (const e of input.episodes ?? []) {
    const n = okInt(e.number);
    if (n === null || byNumber.has(n)) continue;
    if (total !== null && n > total) continue;
    byNumber.set(n, {
      title: e.title?.trim() || null,
      airDate: e.airDate,
      runtime: okInt(e.runtime, 10_000),
    });
  }
  const listed = total ?? aired ?? (byNumber.size > 0 ? Math.max(...byNumber.keys()) : 0);
  const episodes = Array.from({ length: listed }, (_, i) => {
    const row = byNumber.get(i + 1);
    return {
      number: i + 1,
      title: row?.title ?? null,
      airDate: row?.airDate ?? null,
      runtime: row?.runtime ?? runtime,
    };
  });
  return [{ number: 1, title: null, episodeCountKnown: total, episodes }];
}

/** Picks the display title for a language preference, falling back sensibly. */
export function preferredTitle(
  t: { titleRomaji: string | null; titleEnglish: string | null; titleNative: string | null },
  lang: TitleLanguage,
  fallback: string,
): string {
  const order: (string | null)[] =
    lang === 'english'
      ? [t.titleEnglish, t.titleRomaji, t.titleNative]
      : lang === 'native'
        ? [t.titleNative, t.titleRomaji, t.titleEnglish]
        : [t.titleRomaji, t.titleEnglish, t.titleNative];
  return order.find((x): x is string => Boolean(x && x.trim())) ?? fallback;
}

/**
 * Applies the title-language preference to imported anime metadata: the chosen
 * title becomes `title`; the others move to alt titles. Idempotent.
 */
export function applyTitlePreference(meta: MetadataFields, lang: TitleLanguage): MetadataFields {
  const title = preferredTitle(meta, lang, meta.title);
  if (title === meta.title) return meta;
  const alt = [meta.title, ...meta.altTitles].filter((x) => x !== title);
  return { ...meta, title, altTitles: [...new Set(alt)].slice(0, 20) };
}

/** Whether a streaming link matches the audio preference (sub/dub arrays use language codes). */
export function matchesAudio(
  link: { subs: string[]; dubs: string[] },
  pref: AudioPref,
  lang = 'en',
): boolean {
  if (pref === 'both') return true;
  const has = (arr: string[]) => arr.some((c) => c.toLowerCase().startsWith(lang));
  return pref === 'sub' ? has(link.subs) || link.subs.length === 0 : has(link.dubs);
}

/** Cross-provider identity keys used to de-duplicate "All sources" anime search results. */
export const ANIME_ID_KINDS: readonly ExternalIdKind[] = ['anilist', 'mal', 'kitsu'];

export interface CrossIdHit {
  providerId: string;
  ids: Partial<Record<ExternalIdKind, string>>;
}

/**
 * Groups hits that share any cross id (anilist/mal/kitsu). Union-find over ids;
 * returns groups preserving the input order of each group's first member.
 */
export function groupByCrossIds<T extends CrossIdHit>(hits: T[]): T[][] {
  const parent = hits.map((_, i) => i);
  const find = (start: number): number => {
    let i = start;
    for (let p = parent[i] ?? i; p !== i; p = parent[i] ?? i) {
      const grand = parent[p] ?? p;
      parent[i] = grand; // path halving
      i = grand;
    }
    return i;
  };
  const seen = new Map<string, number>();
  hits.forEach((h, i) => {
    for (const k of ANIME_ID_KINDS) {
      const v = h.ids[k];
      if (!v) continue;
      const key = `${k}:${v}`;
      const j = seen.get(key);
      if (j === undefined) seen.set(key, i);
      else {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const groups = new Map<number, T[]>();
  hits.forEach((h, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(h);
    else groups.set(r, [h]);
  });
  return [...groups.values()];
}

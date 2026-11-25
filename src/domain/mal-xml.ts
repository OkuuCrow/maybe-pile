/**
 * MyAnimeList list export (XML, often .xml.gz) → mapped anime rows.
 *
 * This is a file the user exported from their own MAL account (Profile →
 * Export lists). It is parsed without an XML library, defensively:
 *  - DOCTYPE / ENTITY declarations are rejected outright (no entity
 *    expansion, no external entities — XXE-safe by construction);
 *  - only the five predefined entities and numeric character references are
 *    decoded; CDATA is supported;
 *  - size and row limits are enforced by the caller and here.
 * Manga entries are reported and skipped (track manga as Books).
 */
import type { Status } from '../shared/enums';
import { buildAnimeSeasons, normalizeAnimeFormat } from './anime';
import type { SeasonInput } from '../shared/schemas';

export const MAL_MAX_ROWS = 20_000;

export interface MalRow {
  row: number;
  malId: string;
  title: string;
  format: ReturnType<typeof normalizeAnimeFormat>;
  totalEpisodes: number | null;
  watchedEpisodes: number;
  status: Status;
  /** Half-star rating 1–10 (MAL's 1–10 score maps 1:1), or null for 0/unscored. */
  rating: number | null;
  dateStarted: string | null;
  dateCompleted: string | null;
  timesWatched: number;
  tags: string[];
  notes: string;
}

export interface MalOutcome {
  rows: MalRow[];
  messages: { row: number; column: string; message: string; severity: 'warning' | 'error' }[];
  mangaSkipped: number;
}

export class MalXmlError extends Error {}

export function decodeXmlText(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1] ?? '';
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeChar(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return '';
  return String.fromCodePoint(cp);
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeXmlText(m[1] ?? '').trim() : null;
}

const STATUS: Record<string, Status> = {
  watching: 'in_progress',
  '1': 'in_progress',
  completed: 'completed',
  '2': 'completed',
  'on-hold': 'on_hold',
  onhold: 'on_hold',
  '3': 'on_hold',
  dropped: 'dropped',
  '4': 'dropped',
  'plan to watch': 'planned',
  plantowatch: 'planned',
  '6': 'planned',
};

/** MAL dates are YYYY-MM-DD with 00 for unknown parts; 0000-00-00 means none. */
function malDate(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || m[1] === '0000') return null;
  if (m[2] === '00') return null; // year-only dates aren't useful as start/finish days
  if (m[3] === '00') return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? null : d;
}

const int = (s: string | null): number | null => {
  if (s === null || !/^\d{1,9}$/.test(s)) return null;
  return Number(s);
};

export function parseMalXml(text: string): MalOutcome {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new MalXmlError('The file contains a DOCTYPE or ENTITY declaration, which is not allowed.');
  if (!/<myanimelist[\s>]/.test(text)) throw new MalXmlError('This does not look like a MyAnimeList export.');
  const out: MalOutcome = { rows: [], messages: [], mangaSkipped: 0 };
  out.mangaSkipped = (text.match(/<manga>/g) ?? []).length;
  const blocks = text.match(/<anime>[\s\S]*?<\/anime>/g) ?? [];
  if (blocks.length > MAL_MAX_ROWS)
    throw new MalXmlError(`The file has more than ${MAL_MAX_ROWS.toLocaleString()} anime.`);
  blocks.forEach((b, i) => {
    const row = i + 1;
    const malId = tag(b, 'series_animedb_id');
    const title = tag(b, 'series_title');
    if (!malId || !/^\d{1,10}$/.test(malId) || !title) {
      out.messages.push({
        row,
        column: 'series_title',
        message: 'Missing title or MAL id.',
        severity: 'error',
      });
      return;
    }
    const rawStatus = (tag(b, 'my_status') ?? '').toLowerCase();
    const status = STATUS[rawStatus];
    if (!status) {
      out.messages.push({
        row,
        column: 'my_status',
        message: `Unknown status “${rawStatus}”; imported as Planned.`,
        severity: 'warning',
      });
    }
    const total = int(tag(b, 'series_episodes'));
    const watched = Math.max(0, int(tag(b, 'my_watched_episodes')) ?? 0);
    const score = int(tag(b, 'my_score'));
    const tags = (tag(b, 'my_tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 50);
    out.rows.push({
      row,
      malId,
      title: title.slice(0, 500),
      format: normalizeAnimeFormat(tag(b, 'series_type')),
      totalEpisodes: total && total > 0 ? total : null,
      watchedEpisodes: total && total > 0 ? Math.min(watched, total) : watched,
      status: status ?? 'planned',
      rating: score && score >= 1 && score <= 10 ? score : null,
      dateStarted: malDate(tag(b, 'my_start_date')),
      dateCompleted: malDate(tag(b, 'my_finish_date')),
      timesWatched: Math.max(0, int(tag(b, 'my_times_watched')) ?? 0),
      tags,
      notes: (tag(b, 'my_comments') ?? '').slice(0, 100_000),
    });
  });
  return out;
}

/**
 * Episode list for an imported row: the known total (or the watched count when
 * the total is unknown), with the first `watchedEpisodes` marked watched.
 */
export function malSeasons(r: MalRow): (SeasonInput & { watchedUpTo: number })[] {
  const total = r.totalEpisodes ?? (r.watchedEpisodes > 0 ? r.watchedEpisodes : null);
  const [season] = buildAnimeSeasons({
    total: r.totalEpisodes,
    aired: r.totalEpisodes ? null : total,
    runtime: null,
  });
  return season
    ? [{ ...season, watchedUpTo: r.status === 'completed' ? season.episodes.length : r.watchedEpisodes }]
    : [];
}

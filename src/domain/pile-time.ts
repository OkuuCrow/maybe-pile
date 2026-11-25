/**
 * Pile Time: how long the backlog would take, from data the app already has.
 * No HowLongToBeat (no API; scraping is not allowed). Estimate sources, best first:
 *   1. manual estimate the user entered                       → high confidence
 *   2. provider estimate (IGDB time-to-beat, when available)  → medium
 *   3. derived from metadata (runtime, episodes × runtime, pages × pace) → high/medium/low
 * Remaining time subtracts recorded progress. Every number carries its source
 * and confidence so the UI can explain it.
 */
import type { MediaType } from '../shared/enums';

export type Confidence = 'high' | 'medium' | 'low';
export type EstimateSource = 'manual' | 'provider' | 'runtime' | 'episodes' | 'pages' | 'audio' | 'none';

export interface PileTimeInput {
  type: MediaType;
  status: string;
  runtimeMinutes: number | null;
  episodeRuntime: number | null;
  episodesTotal: number;
  episodesWatched: number;
  pageCount: number | null;
  pagesRead: number | null;
  audioMinutes: number | null;
  bookFormat: string | null;
  hoursPlayed: number | null;
  progressPct: number | null;
  manualMinutes: number | null;
  providerMinutes: number | null;
}

export interface PileTimeEstimate {
  totalMinutes: number | null;
  remainingMinutes: number | null;
  source: EstimateSource;
  confidence: Confidence | null;
  explanation: string;
}

/** Default reading pace (minutes per page) — a documented assumption, not user data. */
export const MINUTES_PER_PAGE = 1.5;
/** Fallback when an episodic item has episodes but no runtime. */
export const DEFAULT_EPISODE_MINUTES = { tv: 45, anime: 24 } as const;

const pos = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

function fmt(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  return h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h)} h`;
}

export function estimatePileTime(i: PileTimeInput): PileTimeEstimate {
  const fraction = (pct: number | null) => (pct !== null && pct > 0 ? Math.min(1, pct / 100) : 0);
  // Generic "remaining" for whole-item estimates (manual/provider/runtime).
  const remainingOf = (total: number, label: string): number => {
    if (i.status === 'completed') return 0;
    if (i.type === 'game' && pos(i.hoursPlayed)) return Math.max(0, total - i.hoursPlayed * 60);
    if ((i.type === 'tv' || i.type === 'anime') && i.episodesTotal > 0)
      return Math.max(0, total * (1 - i.episodesWatched / i.episodesTotal));
    void label;
    return Math.max(0, total * (1 - fraction(i.progressPct)));
  };

  if (pos(i.manualMinutes)) {
    const rem = remainingOf(i.manualMinutes, 'manual');
    return {
      totalMinutes: i.manualMinutes,
      remainingMinutes: rem,
      source: 'manual',
      confidence: 'high',
      explanation: `Your estimate: ${fmt(i.manualMinutes)}.`,
    };
  }
  if (pos(i.providerMinutes)) {
    const rem = remainingOf(i.providerMinutes, 'provider');
    return {
      totalMinutes: i.providerMinutes,
      remainingMinutes: rem,
      source: 'provider',
      confidence: 'medium',
      explanation: `Typical time from IGDB: ${fmt(i.providerMinutes)}${pos(i.hoursPlayed) ? `, minus ${fmt(i.hoursPlayed * 60)} played` : ''}.`,
    };
  }
  switch (i.type) {
    case 'movie':
      if (pos(i.runtimeMinutes))
        return {
          totalMinutes: i.runtimeMinutes,
          remainingMinutes: i.status === 'completed' ? 0 : i.runtimeMinutes,
          source: 'runtime',
          confidence: 'high',
          explanation: `Runtime ${fmt(i.runtimeMinutes)}.`,
        };
      break;
    case 'tv':
    case 'anime': {
      if (i.episodesTotal > 0) {
        const per = pos(i.episodeRuntime) ? i.episodeRuntime : DEFAULT_EPISODE_MINUTES[i.type];
        const left = Math.max(0, i.episodesTotal - i.episodesWatched);
        return {
          totalMinutes: per * i.episodesTotal,
          remainingMinutes: i.status === 'completed' ? 0 : per * left,
          source: 'episodes',
          confidence: pos(i.episodeRuntime) ? 'medium' : 'low',
          explanation: `${left} of ${i.episodesTotal} episode(s) left × ${per} min${pos(i.episodeRuntime) ? '' : ' (assumed)'}.`,
        };
      }
      break;
    }
    case 'book': {
      if (i.bookFormat === 'audiobook' && pos(i.audioMinutes)) {
        return {
          totalMinutes: i.audioMinutes,
          remainingMinutes: i.status === 'completed' ? 0 : i.audioMinutes * (1 - fraction(i.progressPct)),
          source: 'audio',
          confidence: 'high',
          explanation: `Audiobook length ${fmt(i.audioMinutes)}.`,
        };
      }
      if (pos(i.pageCount)) {
        const total = i.pageCount * MINUTES_PER_PAGE;
        const read = pos(i.pagesRead)
          ? Math.min(i.pagesRead, i.pageCount)
          : i.pageCount * fraction(i.progressPct);
        return {
          totalMinutes: total,
          remainingMinutes: i.status === 'completed' ? 0 : (i.pageCount - read) * MINUTES_PER_PAGE,
          source: 'pages',
          confidence: 'low',
          explanation: `${Math.round(i.pageCount - read)} page(s) left × ${MINUTES_PER_PAGE} min/page (assumed pace).`,
        };
      }
      break;
    }
    case 'game':
      break;
  }
  return {
    totalMinutes: null,
    remainingMinutes: null,
    source: 'none',
    confidence: null,
    explanation:
      i.type === 'game'
        ? 'No estimate yet. Add your own, or fetch a typical time from IGDB.'
        : 'Not enough information to estimate. Add your own estimate.',
  };
}

export interface PileTimeTotals {
  remainingMinutes: number;
  itemsWithEstimate: number;
  itemsWithout: number;
  byType: Record<MediaType, { minutes: number; items: number; missing: number }>;
  byConfidence: Record<Confidence, number>;
}

export function sumPileTime(rows: { type: MediaType; est: PileTimeEstimate }[]): PileTimeTotals {
  const empty = () => ({ minutes: 0, items: 0, missing: 0 });
  const out: PileTimeTotals = {
    remainingMinutes: 0,
    itemsWithEstimate: 0,
    itemsWithout: 0,
    byType: { movie: empty(), tv: empty(), game: empty(), book: empty(), anime: empty() },
    byConfidence: { high: 0, medium: 0, low: 0 },
  };
  for (const r of rows) {
    const t = out.byType[r.type];
    if (r.est.remainingMinutes === null || r.est.confidence === null) {
      out.itemsWithout++;
      t.missing++;
      continue;
    }
    out.itemsWithEstimate++;
    out.remainingMinutes += r.est.remainingMinutes;
    t.minutes += r.est.remainingMinutes;
    t.items++;
    out.byConfidence[r.est.confidence] += r.est.remainingMinutes;
  }
  out.remainingMinutes = Math.round(out.remainingMinutes);
  for (const k of Object.keys(out.byType) as MediaType[])
    out.byType[k].minutes = Math.round(out.byType[k].minutes);
  return out;
}

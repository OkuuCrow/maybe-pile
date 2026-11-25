/**
 * Offline, explainable recommendations ("From your pile"). Only the user's
 * own library is used — nothing is sent anywhere. Candidates are unfinished
 * items; each gets points from concrete, nameable signals, and every
 * recommendation lists the reasons that produced its score.
 */
import type { MediaType } from '../shared/enums';

export interface RecItem {
  id: string;
  title: string;
  type: MediaType;
  status: string;
  rating: number | null;
  genres: string[];
  creators: string[];
  moods: string[];
  franchiseIds: string[];
  isNextInSeries: boolean;
  remainingMinutes: number | null;
  dateAdded: string;
}

export interface RecReason {
  kind: 'genre' | 'creator' | 'franchise' | 'mood' | 'next' | 'short' | 'old';
  text: string;
  points: number;
}

export interface Recommendation {
  itemId: string;
  title: string;
  type: MediaType;
  score: number;
  reasons: RecReason[];
}

const LIKED = 8; // rating ≥ 4 stars (8 half-stars)

export function recommend(
  all: RecItem[],
  opts: { excluded: Set<string>; limit: number; today: string },
): Recommendation[] {
  const liked = all.filter((i) => i.status === 'completed' && (i.rating ?? 0) >= LIKED);
  const genreSrc = new Map<string, RecItem>();
  const creatorSrc = new Map<string, RecItem>();
  const franchiseSrc = new Map<string, RecItem>();
  const moodCount = new Map<string, number>();
  for (const l of liked) {
    for (const g of l.genres) if (!genreSrc.has(g.toLowerCase())) genreSrc.set(g.toLowerCase(), l);
    for (const c of l.creators) if (!creatorSrc.has(c.toLowerCase())) creatorSrc.set(c.toLowerCase(), l);
    for (const f of l.franchiseIds) if (!franchiseSrc.has(f)) franchiseSrc.set(f, l);
    for (const m of l.moods) moodCount.set(m, (moodCount.get(m) ?? 0) + 1);
  }
  const stars = (r: number | null) => (r === null ? '' : ` (${(r / 2).toFixed(r % 2 ? 1 : 0)}★)`);
  const out: Recommendation[] = [];
  for (const i of all) {
    if (i.status !== 'planned' && i.status !== 'on_hold') continue;
    if (opts.excluded.has(i.id)) continue;
    const reasons: RecReason[] = [];
    const creator = i.creators.find((c) => creatorSrc.has(c.toLowerCase()));
    const creatorFrom = creator ? creatorSrc.get(creator.toLowerCase()) : undefined;
    if (creator && creatorFrom) {
      const src = creatorFrom;
      reasons.push({
        kind: 'creator',
        text: `Same creator as ${src.title}${stars(src.rating)}: ${creator}`,
        points: 3,
      });
    }
    const fr = i.franchiseIds.find((f) => franchiseSrc.has(f));
    const frFrom = fr ? franchiseSrc.get(fr) : undefined;
    if (frFrom) {
      const src = frFrom;
      reasons.push({ kind: 'franchise', text: `Same series as ${src.title}${stars(src.rating)}`, points: 3 });
    }
    if (i.isNextInSeries)
      reasons.push({ kind: 'next', text: 'Next in a series you are following', points: 4 });
    const genres = i.genres.filter((g) => genreSrc.has(g.toLowerCase())).slice(0, 2);
    const genreFrom = genres[0] ? genreSrc.get(genres[0].toLowerCase()) : undefined;
    if (genreFrom) {
      const src = genreFrom;
      reasons.push({
        kind: 'genre',
        text: `${genres.join(' & ')}, like ${src.title}${stars(src.rating)}`,
        points: genres.length,
      });
    }
    const mood = i.moods.find((m) => (moodCount.get(m) ?? 0) >= 2);
    if (mood) reasons.push({ kind: 'mood', text: `Tagged “${mood}”, a mood you often finish`, points: 1 });
    if (i.remainingMinutes !== null && i.remainingMinutes > 0 && i.remainingMinutes <= 120)
      reasons.push({ kind: 'short', text: 'Can be finished in about two hours', points: 1 });
    const ageDays = (Date.parse(opts.today) - Date.parse(i.dateAdded.slice(0, 10))) / 86_400_000;
    if (ageDays > 365) reasons.push({ kind: 'old', text: 'On your pile for over a year', points: 1 });
    const score = reasons.reduce((n, r) => n + r.points, 0);
    // Require at least one taste signal: "short" or "old" alone isn't a recommendation.
    if (!reasons.some((r) => r.kind !== 'short' && r.kind !== 'old')) continue;
    out.push({
      itemId: i.id,
      title: i.title,
      type: i.type,
      score,
      reasons: reasons.sort((a, b) => b.points - a.points),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, opts.limit);
}

/** Offline recommendations from the user's own pile (see src/domain/recommendations.ts). */
import { appError } from '../../shared/result';
import type { MediaType } from '../../shared/enums';
import { readSettings } from '../../db/repositories/config-repo';
import { addDays } from '../../domain/dates';
import { recommend, type RecItem, type Recommendation } from '../../domain/recommendations';
import type { ServiceContext } from './context';
import type { ItemExtrasService } from './item-extras-service';
import type { PileTimeService } from './pile-time-service';

export class RecommendationsService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly extras: ItemExtrasService,
    private readonly pileTime: PileTimeService,
    private readonly today: () => string,
  ) {}

  list(limit = 12, types: MediaType[] | null = null): Recommendation[] {
    const db = this.ctx.db();
    if (!readSettings(db).settings.recommendations.enabled) return [];
    const base = db.all<{
      id: string;
      title: string;
      type: MediaType;
      status: string;
      rating: number | null;
      date_added: string;
    }>('SELECT id, title, type, status, rating, date_added FROM items WHERE deleted_at IS NULL');
    const group = (sql: string) => {
      const m = new Map<string, string[]>();
      for (const r of db.all<{ item_id: string; v: string }>(sql)) {
        const a = m.get(r.item_id);
        if (a) a.push(r.v);
        else m.set(r.item_id, [r.v]);
      }
      return m;
    };
    const genres = group(
      'SELECT ig.item_id, g.name AS v FROM item_genres ig JOIN genres g ON g.id = ig.genre_id',
    );
    const creators = group(
      'SELECT ic.item_id, c.name AS v FROM item_creators ic JOIN creators c ON c.id = ic.creator_id',
    );
    const moods = group(
      'SELECT im.item_id, m.name AS v FROM item_moods im JOIN moods m ON m.id = im.mood_id WHERE m.hidden = 0',
    );
    const fr = group('SELECT item_id, franchise_id AS v FROM franchise_items');
    const next = this.extras.nextInSeriesIds();
    const remaining = new Map(this.pileTime.backlog().map((r) => [r.id, r.estimate.remainingMinutes]));
    const today = this.today();
    const excluded = new Set(
      db
        .all<{ item_id: string }>('SELECT item_id FROM rec_feedback WHERE until IS NULL OR until >= ?', [
          today,
        ])
        .map((r) => r.item_id),
    );
    const all: RecItem[] = base.map((b) => ({
      id: b.id,
      title: b.title,
      type: b.type,
      status: b.status,
      rating: b.rating,
      genres: genres.get(b.id) ?? [],
      creators: creators.get(b.id) ?? [],
      moods: moods.get(b.id) ?? [],
      franchiseIds: fr.get(b.id) ?? [],
      isNextInSeries: next.has(b.id),
      remainingMinutes: remaining.get(b.id) ?? null,
      dateAdded: b.date_added,
    }));
    const recs = recommend(all, { excluded, limit: types ? 200 : limit, today });
    return (types ? recs.filter((r) => types.includes(r.type)) : recs).slice(0, limit);
  }

  /** "Not now" hides for 30 days; "Not interested" hides until cleared. */
  feedback(itemId: string, kind: 'dismissed' | 'not_interested'): void {
    const db = this.ctx.db();
    if (!db.get('SELECT 1 FROM items WHERE id = ? AND deleted_at IS NULL', [itemId]))
      throw appError('NOT_FOUND', 'That item no longer exists.');
    const until = kind === 'dismissed' ? addDays(this.today(), 30) : null;
    db.run(
      `INSERT INTO rec_feedback (item_id, kind, until, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET kind = excluded.kind, until = excluded.until, created_at = excluded.created_at`,
      [itemId, kind, until, this.ctx.clock.now().toISOString()],
    );
  }

  clearFeedback(): number {
    return this.ctx.db().run('DELETE FROM rec_feedback').changes;
  }
}

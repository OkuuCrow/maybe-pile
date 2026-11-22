/**
 * Dev-only benchmark: builds a library of 10,000 items with 100,000 TV episode
 * rows in a temp directory and times typical queries. Usage: npm run bench
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db/connection';
import { migrate } from '../src/db/migrate';
import { pathsFor, systemClock } from '../src/main/services/context';
import { LibraryService } from '../src/main/services/library-service';
import { ProgressService } from '../src/main/services/progress-service';
import { MemoryLogger } from '../src/main/services/logger';
import { defaultPersonal, emptyMeta } from '../src/domain/metadata';
import { DEFAULT_LIBRARY_QUERY } from '../src/shared/schemas';
import { MEDIA_TYPES, STATUSES } from '../src/shared/enums';

const dir = mkdtempSync(join(tmpdir(), 'mp-bench-'));
const paths = pathsFor(dir);
const db = new Db(paths.database);
migrate(db);
const ctx = { db: () => db, clock: systemClock, log: new MemoryLogger(), paths, appVersion: 'bench' };
const lib = new LibraryService(ctx);
const prog = new ProgressService(ctx, lib);

const time = <T>(label: string, fn: () => T): T => {
  const t = performance.now();
  const r = fn();
  console.log(`${label.padEnd(48)} ${(performance.now() - t).toFixed(1).padStart(9)} ms`);
  return r;
};

const words = [
  'Shadow',
  'River',
  'Garden',
  'Empire',
  'Signal',
  'Winter',
  'Glass',
  'Atlas',
  'Echo',
  'Harbor',
  'Pokémon',
  'Café',
];
time('insert 10,000 items (incl. 2,000 TV × 50 eps)', () => {
  db.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
      const type = MEDIA_TYPES[i % 4] ?? 'movie';
      const meta = {
        ...emptyMeta(`${words[i % words.length]} ${words[(i * 7) % words.length]} ${i}`),
        releaseDate: String(1950 + (i % 75)),
      };
      const personal = {
        ...defaultPersonal(type, '2025-01-01'),
        status: STATUSES[i % 5] ?? 'planned',
        rating: (i % 10) + 1,
        tags: [`tag${i % 40}`],
        notes: i % 3 === 0 ? 'rainy day pick' : '',
      };
      const seasons =
        type === 'tv' && Math.floor(i / 4) % 5 !== 0
          ? Array.from({ length: 5 }, (_, s) => ({
              number: s + 1,
              title: null,
              episodeCountKnown: 10,
              episodes: Array.from({ length: 10 }, (_, e) => ({
                number: e + 1,
                title: null,
                airDate: null,
                runtime: null,
              })),
            }))
          : [];
      lib.create({ type, meta, personal, seasons, milestones: [], allowDuplicate: true });
    }
  });
});
console.log('episode rows:', db.get<{ n: number }>('SELECT count(*) AS n FROM episodes')?.n);
const q = (patch: Partial<typeof DEFAULT_LIBRARY_QUERY>) => lib.query({ ...DEFAULT_LIBRARY_QUERY, ...patch });
time('library page (default sort, 200 rows)', () => q({}));
time('full-text search "riv"', () => q({ text: 'riv' }));
time('search "pokemon" (diacritics)', () => q({ text: 'pokemon' }));
time('filter type+status+tag+rating, sort by title', () =>
  q({
    types: ['book', 'game'],
    statuses: ['planned', 'in_progress'],
    tags: ['tag3'],
    ratingMin: 4,
    sort: 'title',
    direction: 'asc',
  }),
);
time('sort by progress, offset 9,000', () => q({ sort: 'progress', offset: 9000 }));
time('dashboard', () => lib.dashboard());
const tv = q({ types: ['tv'], limit: 1 }).items[0];
if (tv) {
  const item = time('load TV detail (50 episodes)', () => lib.get(tv.id));
  const ids = item.seasons.flatMap((s) => s.episodes.map((e) => e.id));
  if (ids.length > 0)
    time('mark 50 episodes watched', () =>
      prog.toggleEpisodes({ itemId: tv.id, episodeIds: ids, watched: true, scope: 'season' }),
    );
}
db.close();
rmSync(dir, { recursive: true, force: true });

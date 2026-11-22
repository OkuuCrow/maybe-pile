import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIBRARY_QUERY, type LibraryQuery } from '../../src/shared/schemas';
import { AppError } from '../../src/shared/result';
import { addItem, createInput, makeEnv, type TestEnv } from '../helpers/services';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const q = (patch: Partial<LibraryQuery>) => env.library.query({ ...DEFAULT_LIBRARY_QUERY, ...patch });
const titles = (patch: Partial<LibraryQuery>) => q(patch).items.map((i) => i.title);

describe('library CRUD', () => {
  it('adds one item of each media type with type-specific details', () => {
    const m = addItem(env, 'movie', 'Arrival', { meta: { runtimeMinutes: 116, releaseDate: '2016-11-11' } });
    const t = addItem(env, 'tv', 'Severance', { meta: { network: 'Apple TV+', showStatus: 'returning' } });
    const g = addItem(env, 'game', 'Hades', {
      personal: { gameScheme: 'hours', platforms: [{ name: 'PC', owned: true, played: true }] },
    });
    const b = addItem(env, 'book', 'Piranesi', {
      meta: { pageCount: 272, isbn13: '9781635575637' },
      personal: { bookFormat: 'ebook' },
    });
    expect(m.meta.runtimeMinutes).toBe(116);
    expect(t.meta.network).toBe('Apple TV+');
    expect(g.personal.gameScheme).toBe('hours');
    expect(g.personal.platforms).toEqual([{ name: 'PC', owned: true, played: true }]);
    expect(b.meta.pageCount).toBe(272);
    expect(b.personal.bookFormat).toBe('ebook');
    expect(q({}).total).toBe(4);
    // fields irrelevant to the type are pruned
    const pruned = addItem(env, 'game', 'Celeste', { meta: { pageCount: 99, network: 'X' } });
    expect(pruned.meta.pageCount).toBeNull();
    expect(pruned.meta.network).toBeNull();
  });

  it('marks manual metadata as manual-entry and later edits as user', () => {
    const m = addItem(env, 'movie', 'Heat', { meta: { releaseDate: '1995' } });
    expect(m.provenance.title?.origin).toBe('manual-entry');
    expect(m.provenance.description).toBeUndefined();
    const updated = env.library.update({ id: m.id, meta: { ...m.meta, title: 'Heat (1995)' } });
    expect(updated.provenance.title?.origin).toBe('user');
    expect(updated.provenance.releaseDate?.origin).toBe('manual-entry');
  });

  it('detects duplicates and allows "add anyway"', () => {
    addItem(env, 'movie', 'The Thing', {
      meta: { releaseDate: '1982', externalIds: [{ kind: 'imdb', value: 'tt0084787' }] },
    });
    const dup = env.library.create(createInput('movie', 'Thing', { meta: { releaseDate: '1982-06-25' } }));
    expect(dup.kind).toBe('duplicates');
    const byId = env.library.create(
      createInput('movie', 'Completely Different', {
        meta: { externalIds: [{ kind: 'imdb', value: 'tt0084787' }] },
      }),
    );
    expect(byId.kind === 'duplicates' && byId.matches[0]?.reason).toBe('provider-id');
    // different year → not a duplicate
    expect(
      env.library.create(createInput('movie', 'The Thing', { meta: { releaseDate: '2011' } })).kind,
    ).toBe('created');
    // different type → not a duplicate
    expect(env.library.create(createInput('book', 'The Thing')).kind).toBe('created');
    const anyway = env.library.create({
      ...createInput('movie', 'The Thing', { meta: { releaseDate: '1982' } }),
      allowDuplicate: true,
    });
    expect(anyway.kind).toBe('created');
  });

  it('rejects invalid external ids and custom field values with field errors', () => {
    try {
      env.library.create(
        createInput('movie', 'X', { meta: { externalIds: [{ kind: 'imdb', value: 'nm123' }] } }),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).safe.code).toBe('VALIDATION');
      expect((e as AppError).safe.fieldErrors?.['meta.externalIds.0.value']).toMatch(/tt/);
    }
    expect(q({}).total).toBe(0); // nothing half-created
  });

  it('normalizes tags case- and accent-insensitively', () => {
    const a = addItem(env, 'book', 'A', { personal: { tags: ['Sci-Fi', 'sci-fi', ' Café  noir '] } });
    expect(a.personal.tags.sort()).toEqual(['Café noir', 'Sci-Fi']);
    addItem(env, 'book', 'B', { personal: { tags: ['cafe NOIR'] } });
    expect(titles({ tags: ['CAFÉ NOIR'] }).sort()).toEqual(['A', 'B']);
  });

  it('soft-deletes with undo, then purges', () => {
    const a = addItem(env, 'movie', 'Alien', { personal: { tags: ['scary'] } });
    expect(env.library.softDelete([a.id])).toBe(1);
    expect(q({}).total).toBe(0);
    expect(q({ text: 'alien' }).total).toBe(0);
    expect(() => env.library.get(a.id)).toThrow(AppError);
    env.library.undoDelete([a.id]);
    expect(titles({ text: 'alien' })).toEqual(['Alien']);
    env.library.softDelete([a.id]);
    expect(env.library.purgeDeleted().purged).toBe(1);
    expect(env.db.get<{ n: number }>('SELECT count(*) AS n FROM tags')?.n).toBe(0);
    expect(env.db.foreignKeyViolations()).toBe(0);
  });

  it('persists across a database re-open', () => {
    const a = addItem(env, 'book', 'Dune', { personal: { notes: 'spice', rating: 9 } });
    env.reopen();
    const b = env.library.get(a.id);
    expect(b.personal.notes).toBe('spice');
    expect(b.personal.rating).toBe(9);
  });
});

describe('search, filter, sort', () => {
  beforeEach(() => {
    addItem(env, 'movie', 'Amélie', {
      meta: { releaseDate: '2001', creators: [{ name: 'Jean-Pierre Jeunet', role: 'director' }] },
      personal: { rating: 9, dateAdded: '2025-01-05', tags: ['french', 'comfort'] },
    });
    addItem(env, 'tv', 'The Bear', {
      meta: { releaseDate: '2022' },
      personal: { status: 'in_progress', rating: 8, dateAdded: '2025-02-01', tags: ['comfort'] },
    });
    addItem(env, 'game', 'Outer Wilds', {
      meta: { releaseDate: '2019' },
      personal: { status: 'completed', rating: 10, dateAdded: '2024-12-01', tags: ['space'] },
    });
    addItem(env, 'book', 'Project Hail Mary', {
      meta: { releaseDate: '2021' },
      personal: {
        status: 'dropped',
        dateAdded: '2025-03-01',
        notes: 'Rocky is great',
        tags: ['space', 'comfort'],
      },
    });
    addItem(env, 'book', 'Part 10', { personal: { dateAdded: '2025-03-02' } });
    addItem(env, 'book', 'Part 2', { personal: { dateAdded: '2025-03-02' } });
  });

  it('full-text search is diacritic-insensitive, prefix-based and covers creators/notes/tags', () => {
    expect(titles({ text: 'amelie' })).toEqual(['Amélie']);
    expect(titles({ text: 'jeun' })).toEqual(['Amélie']);
    expect(titles({ text: 'rocky' })).toEqual(['Project Hail Mary']);
    expect(titles({ text: 'space', sort: 'title', direction: 'asc' })).toEqual([
      'Outer Wilds',
      'Project Hail Mary',
    ]);
    expect(titles({ text: '"); DROP TABLE items; --' })).toEqual([]);
    expect(titles({ text: '  ' })).toHaveLength(6);
    expect(titles({ text: 'x'.repeat(200) })).toEqual([]);
  });

  it('filters combine (type, status, tags any/all, rating, date added)', () => {
    expect(titles({ types: ['book'], sort: 'title', direction: 'asc' })).toEqual([
      'Part 2',
      'Part 10',
      'Project Hail Mary',
    ]);
    expect(titles({ statuses: ['in_progress', 'completed'], sort: 'title', direction: 'asc' })).toEqual([
      'The Bear',
      'Outer Wilds',
    ]); // articles ignored
    expect(titles({ tags: ['space', 'comfort'], tagMode: 'all' })).toEqual(['Project Hail Mary']);
    expect(titles({ tags: ['space', 'french'], tagMode: 'any', sort: 'title', direction: 'asc' })).toEqual([
      'Amélie',
      'Outer Wilds',
      'Project Hail Mary',
    ]);
    expect(titles({ ratingMin: 9, sort: 'rating', direction: 'desc' })).toEqual(['Outer Wilds', 'Amélie']);
    expect(
      titles({ addedFrom: '2025-02-01', addedTo: '2025-03-01', sort: 'dateAdded', direction: 'asc' }),
    ).toEqual(['The Bear', 'Project Hail Mary']);
    expect(titles({ types: ['movie'], statuses: ['dropped'] })).toEqual([]);
  });

  it('sorts with natural numbers, nulls last and stable tie-breaking', () => {
    expect(titles({ sort: 'title', direction: 'asc' })).toEqual([
      'Amélie',
      'The Bear',
      'Outer Wilds',
      'Part 2',
      'Part 10',
      'Project Hail Mary',
    ]);
    const byRating = titles({ sort: 'rating', direction: 'asc' });
    expect(byRating.slice(0, 3)).toEqual(['The Bear', 'Amélie', 'Outer Wilds']);
    expect(byRating.slice(3)).toEqual(['Part 2', 'Part 10', 'Project Hail Mary']); // unrated last, by title
    expect(titles({ sort: 'status', direction: 'asc' })[0]).toBe('Amélie');
    expect(titles({ sort: 'releaseDate', direction: 'desc' }).slice(0, 2)).toEqual([
      'The Bear',
      'Project Hail Mary',
    ]);
    expect(q({ limit: 2, offset: 4, sort: 'title', direction: 'asc' }).items.map((i) => i.title)).toEqual([
      'Part 10',
      'Project Hail Mary',
    ]);
  });

  it('handles very long text and unicode titles', () => {
    const long = 'Ω'.repeat(500);
    const item = addItem(env, 'book', long, { personal: { notes: 'n'.repeat(100_000) } });
    expect(item.meta.title).toBe(long);
    expect(titles({ text: 'ω' })).toContain(long);
  });

  it('bulk actions: status with date auto-fill, tags, delete', () => {
    const ids = q({ types: ['book'] }).items.map((i) => i.id);
    expect(env.library.bulk({ action: 'setStatus', ids, status: 'completed' }).affected).toBe(3);
    for (const id of ids) expect(env.library.get(id).personal.dateCompleted).toBe('2025-03-10');
    env.library.bulk({ action: 'addTag', ids, tag: 'Shelf' });
    expect(titles({ tags: ['shelf'] })).toHaveLength(3);
    env.library.bulk({ action: 'removeTag', ids, tag: 'SHELF' });
    expect(titles({ tags: ['shelf'] })).toHaveLength(0);
    env.library.bulk({ action: 'delete', ids });
    expect(q({}).total).toBe(3);
  });

  it('dashboard counts and recents come from real data only', () => {
    const d = env.library.dashboard();
    expect(d.total).toBe(6);
    expect(d.countsByType).toEqual({ movie: 1, tv: 1, game: 1, book: 3 });
    expect(d.countsByStatus.dropped).toBe(1);
    expect(d.continueItems.map((c) => c.title)).toEqual(['The Bear']);
    expect(d.activityByWeek).toHaveLength(12);
    expect(d.activityByWeek.every((w) => w.entries === 0)).toBe(true);
    expect(d.tagCounts[0]).toEqual({ tag: 'comfort', count: 3 });
  });
});

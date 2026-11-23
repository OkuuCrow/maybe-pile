import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildJsonExport } from '../../src/main/services/export-service';
import { ImportService } from '../../src/main/services/import-service';
import { addItem, makeEnv, type TestEnv } from '../helpers/services';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const queueTitles = () => env.library.upNext().map((i) => i.title);

describe('Up Next queue', () => {
  it('adds, orders, reorders and removes with compact positions', () => {
    const a = addItem(env, 'movie', 'A');
    const b = addItem(env, 'book', 'B');
    const c = addItem(env, 'game', 'C');
    expect(env.library.setUpNext(a.id, true).upNextPosition).toBe(0);
    env.library.setUpNext(b.id, true);
    env.library.setUpNext(c.id, true);
    env.library.setUpNext(c.id, true); // idempotent
    expect(queueTitles()).toEqual(['A', 'B', 'C']);
    expect(env.library.moveUpNext(c.id, 'up').map((i) => i.title)).toEqual(['A', 'C', 'B']);
    expect(env.library.moveUpNext(a.id, 'up').map((i) => i.title)).toEqual(['A', 'C', 'B']); // already first
    env.library.setUpNext(a.id, false);
    expect(env.library.upNext().map((i) => [i.title, env.library.get(i.id).upNextPosition])).toEqual([
      ['C', 0],
      ['B', 1],
    ]);
    expect(env.library.dashboard().upNext.map((i) => i.title)).toEqual(['C', 'B']);
  });

  it('completing or dropping an item takes it out of the queue; other statuses keep it', () => {
    const a = addItem(env, 'book', 'A', { meta: { pageCount: 10 } });
    const b = addItem(env, 'movie', 'B');
    const c = addItem(env, 'movie', 'C');
    [a, b, c].forEach((i) => env.library.setUpNext(i.id, true));
    env.library.setStatus({
      id: a.id,
      status: 'in_progress',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    expect(queueTitles()).toEqual(['A', 'B', 'C']);
    env.library.setStatus({
      id: a.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    env.library.bulk({ action: 'setStatus', ids: [b.id], status: 'dropped' });
    expect(queueTitles()).toEqual(['C']);
    expect(env.library.get(c.id).upNextPosition).toBe(0);
    // accepting a completion suggestion also removes it
    const r = env.progress.addViewing({ itemId: c.id, watchedAt: null, note: null });
    const complete = r.suggestions.find((s) => s.kind === 'complete');
    env.library.acceptSuggestion(c.id, complete ?? (undefined as never));
    expect(queueTitles()).toEqual([]);
  });

  it('bulk add skips completed/dropped/already-queued items', () => {
    const a = addItem(env, 'movie', 'A');
    const b = addItem(env, 'movie', 'B', { personal: { status: 'completed' } });
    const c = addItem(env, 'movie', 'C');
    env.library.setUpNext(c.id, true);
    expect(env.library.bulk({ action: 'addUpNext', ids: [a.id, b.id, c.id] }).affected).toBe(1);
    expect(queueTitles()).toEqual(['C', 'A']);
  });

  it('round-trips through JSON export/import and is excluded once purged', () => {
    const a = addItem(env, 'movie', 'Queued');
    env.library.setUpNext(a.id, true);
    const text = JSON.stringify(buildJsonExport(env.db, 'v', new Date()));
    const other = makeEnv();
    try {
      const importer = new ImportService(other.ctx, other.library);
      const p = importer.previewJson(text, 'x.json');
      importer.apply({ token: p.token, defaultResolution: 'skip', resolutions: {}, confirmation: '' });
      expect(other.library.upNext().map((i) => i.title)).toEqual(['Queued']);
    } finally {
      other.cleanup();
    }
    env.library.softDelete([a.id]);
    expect(queueTitles()).toEqual([]);
  });
});

describe('Pick something for me', () => {
  it('only picks Planned items of the requested types and can exclude the last pick', () => {
    expect(env.library.pickRandom([], null)).toBeNull();
    const m = addItem(env, 'movie', 'Movie');
    addItem(env, 'book', 'Done', { personal: { status: 'completed' } });
    addItem(env, 'game', 'Playing', { personal: { status: 'in_progress' } });
    for (let i = 0; i < 5; i++) expect(env.library.pickRandom([], null)?.title).toBe('Movie');
    expect(env.library.pickRandom(['book', 'game'], null)).toBeNull();
    expect(env.library.pickRandom(['movie'], m.id)).toBeNull();
    addItem(env, 'movie', 'Other');
    expect(env.library.pickRandom(['movie'], m.id)?.title).toBe('Other');
    env.library.setUpNext(m.id, true);
    for (let i = 0; i < 5; i++) expect(env.library.pickRandom(['movie'], null)?.title).toBe('Other'); // queued items skipped
  });
});

describe('This year stats', () => {
  it('counts only this calendar year from real data', () => {
    const y = env.clock.now().getFullYear();
    addItem(env, 'book', 'Old', {
      personal: { dateAdded: `${y - 1}-06-01`, status: 'completed', dateCompleted: `${y - 1}-07-01` },
    });
    const b = addItem(env, 'book', 'New', { meta: { pageCount: 100 } });
    env.library.setStatus({
      id: b.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: true,
    });
    const t = addItem(env, 'tv', 'Show', {
      seasons: [
        {
          number: 1,
          title: null,
          episodeCountKnown: 2,
          episodes: [1, 2].map((n) => ({ number: n, title: null, airDate: null, runtime: null })),
        },
      ],
    });
    env.progress.toggleEpisodes({
      itemId: t.id,
      episodeIds: t.seasons[0]?.episodes.map((e) => e.id) ?? [],
      watched: true,
      scope: 'season',
    });
    const m = addItem(env, 'movie', 'Film');
    env.progress.addViewing({ itemId: m.id, watchedAt: null, note: null });
    const s = env.library.yearStats();
    expect(s).toMatchObject({
      year: y,
      completedTotal: 1,
      completedByType: { book: 1, movie: 0, tv: 0, game: 0 },
      added: 3,
      episodesWatched: 2,
      viewings: 1,
    });
    expect(s.progressEntries).toBe(2); // book fill + TV season toggle
  });
});

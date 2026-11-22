import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/result';
import { writeSettings } from '../../src/db/repositories/config-repo';
import { addItem, makeEnv, season, type TestEnv } from '../helpers/services';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const allEpisodeIds = (item: { seasons: { episodes: { id: string }[] }[] }) =>
  item.seasons.flatMap((s) => s.episodes.map((e) => e.id));

describe('movies', () => {
  it('tracks multiple viewings, with and without dates, editable and deletable', () => {
    const m = addItem(env, 'movie', 'Paddington 2');
    expect(m.progress.label).toBe('Not watched');
    const r1 = env.progress.addViewing({ itemId: m.id, watchedAt: null, note: null });
    expect(r1.item.progress.isComplete).toBe(true);
    expect(r1.suggestions.map((s) => s.kind).sort()).toEqual(['complete', 'start']);
    const r2 = env.progress.addViewing({
      itemId: m.id,
      watchedAt: '2024-12-25T20:00:00.000Z',
      note: 'with family',
    });
    expect(r2.item.progress.label).toBe('Watched · 2 viewings');
    const vs = env.progress.viewings(m.id);
    expect(vs).toHaveLength(2);
    const dated = vs.find((v) => v.note === 'with family');
    env.progress.editViewing({
      viewingId: dated?.id ?? '',
      watchedAt: '2024-12-24T20:00:00.000Z',
      note: 'Christmas Eve',
    });
    expect(env.progress.viewings(m.id).find((v) => v.id === dated?.id)?.note).toBe('Christmas Eve');
    env.progress.removeViewing(dated?.id ?? '');
    expect(env.progress.viewings(m.id)).toHaveLength(1);
  });
});

describe('tv', () => {
  it('tracks episodes, seasons, "up to here", specials and next episode', () => {
    const t = addItem(env, 'tv', 'Show', { seasons: [season(0, 2), season(1, 3), season(2, 2)] });
    expect(t.progress.label).toBe('0 of 5 episodes');
    const s1 = t.seasons.find((s) => s.number === 1);
    const s2 = t.seasons.find((s) => s.number === 2);
    const special = t.seasons.find((s) => s.number === 0)?.episodes[0];
    let r = env.progress.toggleEpisodes({
      itemId: t.id,
      episodeIds: [special?.id ?? ''],
      watched: true,
      scope: 'episode',
    });
    expect(r.item.progress.percent).toBe(0); // specials excluded from completion
    expect(r.item.progress.hasAnyProgress).toBe(true);
    r = env.progress.toggleEpisodes({
      itemId: t.id,
      episodeIds: (s1?.episodes ?? []).map((e) => e.id),
      watched: true,
      scope: 'season',
    });
    expect(r.item.progress.label).toBe('3 of 5 episodes');
    expect(r.item.progress.nextAction).toBe('Next: S2E1 · Episode 1');
    expect(r.item.seasons.find((s) => s.number === 1)?.watchedCount).toBe(3);
    r = env.progress.toggleEpisodes({
      itemId: t.id,
      episodeIds: (s2?.episodes ?? []).map((e) => e.id),
      watched: true,
      scope: 'upTo',
    });
    expect(r.item.progress.isComplete).toBe(true);
    expect(r.suggestions.some((s) => s.kind === 'complete')).toBe(true);
    expect(r.item.personal.status).toBe('planned'); // never forced
    const hist = env.progress.history(t.id);
    expect(hist.map((h) => h.kind)).toEqual(['season', 'season', 'episode']);
  });

  it('never divides by zero with unknown totals and handles shows with no data', () => {
    const empty = addItem(env, 'tv', 'Unknown Show');
    expect(empty.progress).toMatchObject({ percent: null, isComplete: false });
    expect(empty.progress.label).toMatch(/total unknown/);
    const r = env.progress.upsertSeason({
      itemId: empty.id,
      seasonId: null,
      number: 1,
      title: null,
      episodeCountKnown: null,
    });
    const sid = r.item.seasons[0]?.id ?? '';
    const withEp = env.progress.upsertEpisode({
      itemId: empty.id,
      seasonId: sid,
      episodeId: null,
      number: 1,
      title: 'Pilot',
      airDate: null,
      runtime: 30,
    });
    const ep = withEp.item.seasons[0]?.episodes[0]?.id ?? '';
    const w = env.progress.toggleEpisodes({
      itemId: empty.id,
      episodeIds: [ep],
      watched: true,
      scope: 'episode',
    });
    // season with episodes listed but unknown stated total: total = listed (1), known
    expect(w.item.progress.label).toBe('1 of 1 episodes');
    // stated total larger than listed episodes
    env.progress.upsertSeason({
      itemId: empty.id,
      seasonId: sid,
      number: 1,
      title: null,
      episodeCountKnown: 10,
    });
    expect(env.library.get(empty.id).progress.label).toBe('1 of 10 episodes');
    // a season with no episodes and unknown count makes the total unknown
    env.progress.upsertSeason({
      itemId: empty.id,
      seasonId: null,
      number: 2,
      title: null,
      episodeCountKnown: null,
    });
    expect(env.library.get(empty.id).progress).toMatchObject({
      percent: null,
      label: '1 watched · total unknown',
    });
  });

  it('un-watching in a Completed show suggests re-opening', () => {
    const t = addItem(env, 'tv', 'Done Show', { seasons: [season(1, 2)] });
    env.progress.toggleEpisodes({
      itemId: t.id,
      episodeIds: allEpisodeIds(t),
      watched: true,
      scope: 'season',
    });
    env.library.setStatus({
      id: t.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    const r = env.progress.toggleEpisodes({
      itemId: t.id,
      episodeIds: [allEpisodeIds(t)[1] ?? ''],
      watched: false,
      scope: 'episode',
    });
    expect(r.suggestions.map((s) => s.kind)).toEqual(['reopen']);
    expect(r.item.personal.status).toBe('completed');
  });

  it('rejects episodes from another show and duplicate numbers', () => {
    const a = addItem(env, 'tv', 'A', { seasons: [season(1, 1)] });
    const b = addItem(env, 'tv', 'B', { seasons: [season(1, 1)] });
    expect(() =>
      env.progress.toggleEpisodes({
        itemId: a.id,
        episodeIds: allEpisodeIds(b),
        watched: true,
        scope: 'episode',
      }),
    ).toThrow(AppError);
    expect(() =>
      env.progress.upsertEpisode({
        itemId: a.id,
        seasonId: a.seasons[0]?.id ?? '',
        episodeId: null,
        number: 1,
        title: null,
        airDate: null,
        runtime: null,
      }),
    ).toThrow(/already exists/);
  });

  it('starting a new pass resets checkmarks but keeps history', () => {
    const t = addItem(env, 'tv', 'Rewatch', { seasons: [season(1, 2)] });
    env.progress.toggleEpisodes({
      itemId: t.id,
      episodeIds: allEpisodeIds(t),
      watched: true,
      scope: 'season',
    });
    env.library.setStatus({
      id: t.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    const r = env.library.setStatus({
      id: t.id,
      status: 'in_progress',
      startNewPass: true,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    expect(r.item.pass).toBe(2);
    expect(r.item.progress.label).toBe('0 of 2 episodes');
    expect(r.item.personal.dateCompleted).toBe('2025-03-10'); // not erased without confirmation
    expect(env.progress.history(t.id)).toHaveLength(1);
  });
});

describe('games', () => {
  it('supports each scheme and switching without losing history', () => {
    const g = addItem(env, 'game', 'Elden Ring', { milestones: ['Limgrave', 'Liurnia', 'Leyndell'] });
    let r = env.progress.add({
      itemId: g.id,
      entry: { kind: 'percent', value: 40 },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress.label).toBe('40% complete');
    expect(() =>
      env.progress.add({ itemId: g.id, entry: { kind: 'hours', value: 3 }, occurredAt: null, note: null }),
    ).toThrow(/can't be recorded/);
    r = env.progress.setScheme(g.id, 'hours');
    expect(r.item.progress.label).toBe('No progress yet');
    r = env.progress.add({
      itemId: g.id,
      entry: { kind: 'hours', value: 12.5 },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress.label).toBe('12.5 h played');
    env.progress.setScheme(g.id, 'milestones');
    const ms = env.library.get(g.id).milestones;
    r = env.progress.add({
      itemId: g.id,
      entry: { kind: 'milestone', milestoneId: ms[1]?.id ?? '' },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress.label).toBe('2 of 3 milestones · Liurnia');
    expect(r.item.progress.nextAction).toBe('Next: Leyndell');
    env.progress.setScheme(g.id, 'text');
    r = env.progress.add({
      itemId: g.id,
      entry: { kind: 'text', text: 'Beat Malenia' },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress.label).toBe('Beat Malenia');
    env.progress.setScheme(g.id, 'percent');
    expect(env.library.get(g.id).progress.label).toBe('40% complete'); // history intact
    expect(env.progress.history(g.id).map((h) => h.scheme)).toEqual([
      'text',
      'milestones',
      'hours',
      'percent',
    ]);
  });

  it('milestone deletion keeps history titles', () => {
    const g = addItem(env, 'game', 'G', { personal: { gameScheme: 'milestones' }, milestones: ['A', 'B'] });
    env.progress.add({
      itemId: g.id,
      entry: { kind: 'milestone', milestoneId: g.milestones[0]?.id ?? '' },
      occurredAt: null,
      note: null,
    });
    env.progress.setMilestones({
      itemId: g.id,
      milestones: [{ id: g.milestones[1]?.id ?? null, title: 'B' }],
    });
    expect(env.progress.history(g.id)[0]?.milestoneTitle).toBe('A');
    expect(env.library.get(g.id).progress.label).toBe('0 of 1 milestones');
  });
});

describe('books', () => {
  it('tracks pages, percent and audio with known/unknown/changed page counts', () => {
    const b = addItem(env, 'book', 'Unknown Length');
    let r = env.progress.add({
      itemId: b.id,
      entry: { kind: 'pages', value: 120 },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress).toMatchObject({ percent: null, label: '120 pages · total unknown' });
    r = env.progress.add({
      itemId: b.id,
      entry: { kind: 'percent', value: 50 },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress.label).toBe('50% read');
    // page count set later: percent entry now shows an approximate page
    const withCount = env.library.update({ id: b.id, meta: { ...r.item.meta, pageCount: 300 } });
    expect(withCount.progress.label).toBe('50% read · about page 150');
    r = env.progress.add({
      itemId: b.id,
      entry: { kind: 'pages', value: 280 },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress.label).toBe('280 of 300 pages');
    expect(env.progress.history(b.id)[0]?.totalAtTime).toBe(300);
    // new edition with fewer pages: history unchanged, display capped at 100%
    const shorter = env.library.update({ id: b.id, meta: { ...r.item.meta, pageCount: 250 } });
    expect(shorter.progress).toMatchObject({ percent: 100, label: '250 of 250 pages', isComplete: true });
    expect(env.progress.history(b.id)[0]?.value).toBe(280);
  });

  it('edits and deletes history; current derives from latest non-deleted entry', () => {
    const b = addItem(env, 'book', 'B', { meta: { pageCount: 100 } });
    env.clock.advance(1000);
    env.progress.add({ itemId: b.id, entry: { kind: 'pages', value: 10 }, occurredAt: null, note: null });
    env.clock.advance(1000);
    env.progress.add({ itemId: b.id, entry: { kind: 'pages', value: 40 }, occurredAt: null, note: null });
    const [latest, earlier] = env.progress.history(b.id);
    expect(env.library.get(b.id).progress.label).toBe('40 of 100 pages');
    env.progress.remove(latest?.id ?? '');
    expect(env.library.get(b.id).progress.label).toBe('10 of 100 pages');
    env.progress.edit({
      eventId: earlier?.id ?? '',
      occurredAt: null,
      note: 'fixed typo',
      value: 15,
      text: null,
    });
    expect(env.library.get(b.id).progress.label).toBe('15 of 100 pages');
    expect(env.progress.history(b.id)[0]?.note).toBe('fixed typo');
  });

  it('audiobook minutes', () => {
    const b = addItem(env, 'book', 'Audio', {
      meta: { audioMinutes: 600 },
      personal: { bookFormat: 'audiobook' },
    });
    const r = env.progress.add({
      itemId: b.id,
      entry: { kind: 'audio', value: 200 },
      occurredAt: null,
      note: null,
    });
    expect(r.item.progress.label).toBe('3 h 20 min of 10 h');
  });
});

describe('status rules in services', () => {
  it('suggests In Progress on first progress and auto-applies only when enabled', () => {
    const b = addItem(env, 'book', 'S', { meta: { pageCount: 10 } });
    const r = env.progress.add({
      itemId: b.id,
      entry: { kind: 'pages', value: 1 },
      occurredAt: null,
      note: null,
    });
    expect(r.suggestions[0]).toMatchObject({
      kind: 'start',
      status: 'in_progress',
      setDateStarted: '2025-03-10',
    });
    expect(r.item.personal.status).toBe('planned');
    const accepted = env.library.acceptSuggestion(b.id, r.suggestions[0] ?? (undefined as never));
    expect(accepted.item.personal).toMatchObject({ status: 'in_progress', dateStarted: '2025-03-10' });

    writeSettings(env.db, { autoApplySuggestions: true });
    const b2 = addItem(env, 'book', 'S2', { meta: { pageCount: 10 } });
    const r2 = env.progress.add({
      itemId: b2.id,
      entry: { kind: 'pages', value: 10 },
      occurredAt: null,
      note: null,
    });
    expect(r2.applied.map((s) => s.kind)).toEqual(['start']);
    expect(r2.suggestions.map((s) => s.kind)).toEqual(['complete']); // completion is never auto-applied
    expect(r2.item.personal.status).toBe('in_progress');
  });

  it('completing fills dates only when empty and fills remaining progress only when asked', () => {
    const b = addItem(env, 'book', 'C', {
      meta: { pageCount: 200 },
      personal: { dateCompleted: '2020-01-01' },
    });
    const r = env.library.setStatus({
      id: b.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    expect(r.item.personal.dateCompleted).toBe('2020-01-01');
    expect(r.item.progress.hasAnyProgress).toBe(false);
    const g = addItem(env, 'game', 'G', {});
    const rg = env.library.setStatus({
      id: g.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: true,
    });
    expect(rg.item.personal.dateCompleted).toBe('2025-03-10');
    expect(rg.item.progress.label).toBe('100% complete');
  });

  it('on hold and dropped preserve progress; dropped excluded from Continue', () => {
    const b = addItem(env, 'book', 'D', { meta: { pageCount: 100 }, personal: { status: 'in_progress' } });
    env.progress.add({ itemId: b.id, entry: { kind: 'pages', value: 30 }, occurredAt: null, note: null });
    expect(env.library.dashboard().continueItems[0]?.nextAction).toBe('Continue from page 31');
    const r = env.library.setStatus({
      id: b.id,
      status: 'dropped',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    expect(r.item.progress.label).toBe('30 of 100 pages');
    expect(env.library.dashboard().continueItems).toHaveLength(0);
  });
});

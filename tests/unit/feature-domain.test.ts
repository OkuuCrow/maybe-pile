import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysBetween, instantToLocalDate, median } from '../../src/domain/calendar';
import {
  DEFAULT_CONSTRAINTS,
  filterCandidates,
  fitsTime,
  mulberry32,
  pickReasons,
  pickWeighted,
  sessionMinutes,
  weightOf,
  type PickCandidate,
} from '../../src/domain/pick';
import { isSnoozed, pileStats, staleness, type HealthRow } from '../../src/domain/pile-health';
import { computeStats, streaks, yearInReview, type CompletedRow } from '../../src/domain/stats';
import { neededPerWeek, pace, periodRange } from '../../src/domain/goals';
import { buildIcs, escapeText, foldLine } from '../../src/domain/ics';
import {
  dateSpan,
  isUpcoming,
  notificationKind,
  precisionOf,
  relativeLabel,
} from '../../src/domain/release-radar';
import { diffSnapshot, nonGameReason, parseSteamAccount, steamKeyError } from '../../src/domain/steam';
import { fuzzyRank, fuzzyScore } from '../../src/domain/fuzzy';
import {
  convertRating,
  detectFormat,
  mapGeneric,
  mapGoodreads,
  mapLetterboxd,
  normalizeStatus,
  parseFlexibleDate,
  suggestMapping,
} from '../../src/domain/tracker-csv';
import { detectDelimiter, parseCsv } from '../../src/domain/csv';
import { DEFAULT_LAYOUTS, parseLayoutFile } from '../../src/domain/layouts';
import {
  PILE_DARK,
  PILE_LIGHT,
  ThemeTokensSchema,
  colorOf,
  contrastWarnings,
  themeToCssVars,
} from '../../src/domain/themes';
import { redactString } from '../../src/main/services/logger';

/* ------------------------------------------------------------------ calendar */

describe('calendar helpers', () => {
  it('adds days/months across boundaries and leap years', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-03-15', -12)).toBe('2024-03-15');
    expect(daysBetween('2025-01-01', '2025-03-01')).toBe(59);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('converts UTC instants to local calendar dates per time zone (year boundary)', () => {
    const iso = '2025-01-01T03:30:00.000Z';
    expect(instantToLocalDate(iso, 'UTC')).toBe('2025-01-01');
    expect(instantToLocalDate(iso, 'America/New_York')).toBe('2024-12-31');
    expect(instantToLocalDate('2024-12-31T20:00:00.000Z', 'Asia/Tokyo')).toBe('2025-01-01');
    expect(instantToLocalDate('not a date')).toBeNull();
  });
});

/* ------------------------------------------------------------------ pick */

const cand = (over: Partial<PickCandidate>): PickCandidate => ({
  id: over.id ?? 'a',
  title: 'T',
  type: 'movie',
  status: 'planned',
  dateAdded: '2025-01-01',
  rating: null,
  progressPercent: null,
  runtimeMinutes: 100,
  episodeRuntime: null,
  tags: [],
  genres: [],
  listIds: [],
  inUpNext: false,
  excluded: null,
  ...over,
});

describe('Pick for Me', () => {
  const today = '2026-01-01';
  it('weights are never zero and follow the documented formula', () => {
    const old = cand({ id: 'old', dateAdded: '2020-01-01' });
    const fresh = cand({ id: 'new', dateAdded: '2025-12-31' });
    expect(weightOf(old, { favor: 'neutral', favorInProgress: false }, today)).toBe(1);
    expect(weightOf(old, { favor: 'older', favorInProgress: false }, today)).toBe(6); // capped at 5 years
    expect(weightOf(fresh, { favor: 'older', favorInProgress: false }, today)).toBeCloseTo(1 + 1 / 365, 5);
    expect(weightOf(fresh, { favor: 'newer', favorInProgress: false }, today)).toBeCloseTo(6 - 1 / 365, 5);
    expect(weightOf(old, { favor: 'newer', favorInProgress: false }, today)).toBe(1);
    const partway = cand({ status: 'in_progress', progressPercent: 30 });
    expect(weightOf(partway, { favor: 'neutral', favorInProgress: true }, today)).toBe(2);
    for (const c of [old, fresh, partway])
      for (const favor of ['neutral', 'older', 'newer'] as const)
        expect(weightOf(c, { favor, favorInProgress: true }, today)).toBeGreaterThan(0);
  });

  it('is deterministic for a seed and roughly follows the weights', () => {
    const pool = [cand({ id: 'a', dateAdded: '2021-01-01' }), cand({ id: 'b', dateAdded: '2025-12-01' })];
    const prefs = { favor: 'older' as const, favorInProgress: false };
    const r1 = pickWeighted(pool, prefs, today, mulberry32(42));
    const r2 = pickWeighted([...pool].reverse(), prefs, today, mulberry32(42));
    expect(r1?.id).toBe(r2?.id); // input order does not matter
    const rng = mulberry32(7);
    let a = 0;
    for (let i = 0; i < 2000; i++) if (pickWeighted(pool, prefs, today, rng)?.id === 'a') a++;
    // weight a ≈ 6, b ≈ 1.08 → share ≈ 0.85
    expect(a / 2000).toBeGreaterThan(0.78);
    expect(a / 2000).toBeLessThan(0.91);
  });

  it('never repeats the previous pick when there is another option', () => {
    const pool = [cand({ id: 'a' }), cand({ id: 'b' })];
    const rng = mulberry32(1);
    for (let i = 0; i < 50; i++)
      expect(pickWeighted(pool, { favor: 'neutral', favorInProgress: false }, today, rng, ['a'])?.id).toBe(
        'b',
      );
    expect(
      pickWeighted([cand({ id: 'a' })], { favor: 'neutral', favorInProgress: false }, today, rng, ['a'])?.id,
    ).toBe('a');
    expect(pickWeighted([], { favor: 'neutral', favorInProgress: false }, today, rng)).toBeNull();
  });

  it('filters by every constraint and names the one that emptied the pool', () => {
    const all = [
      cand({ id: 'm', type: 'movie', runtimeMinutes: 105, tags: ['cozy'], genres: ['Drama'], rating: 8 }),
      cand({ id: 't', type: 'tv', episodeRuntime: 45, listIds: ['L'] }),
      cand({ id: 'g', type: 'game', tags: ['session-60'], inUpNext: true }),
      cand({ id: 'b', type: 'book', status: 'on_hold', tags: ['short'] }),
      cand({ id: 'z', type: 'movie', excluded: 'snoozed' }),
      cand({ id: 's', type: 'movie', excluded: 'skipped' }),
      cand({ id: 'd', status: 'dropped' }),
    ];
    const ids = (c: Partial<typeof DEFAULT_CONSTRAINTS>) =>
      filterCandidates(all, { ...DEFAULT_CONSTRAINTS, ...c })
        .eligible.map((x) => x.id)
        .sort();
    expect(ids({})).toEqual(['g', 'm', 't']);
    expect(ids({ includeOnHold: true })).toEqual(['b', 'g', 'm', 't']);
    expect(ids({ excludeSkipped: false })).toEqual(['g', 'm', 's', 't']);
    expect(ids({ types: ['tv'] })).toEqual(['t']);
    expect(ids({ tags: ['COZY'] })).toEqual(['m']);
    expect(ids({ genres: ['drama'] })).toEqual(['m']);
    expect(ids({ listIds: ['L'] })).toEqual(['t']);
    expect(ids({ onlyUpNext: true })).toEqual(['g']);
    expect(ids({ availableMinutes: 90 })).toEqual(['g', 'm', 't']); // 105 ≤ 90+20; 45-min eps; 60-min sessions
    expect(ids({ availableMinutes: 50 })).toEqual(['t']);
    expect(ids({ ratingFloor: 8 })).toEqual(['m']);
    const empty = filterCandidates(all, { ...DEFAULT_CONSTRAINTS, types: ['book'] });
    expect(empty.eligible).toEqual([]);
    expect(empty.emptiedBy).toBe('types');
    expect(
      filterCandidates(all, { ...DEFAULT_CONSTRAINTS, types: ['movie'], ratingFloor: 10 }).emptiedBy,
    ).toBe('ratingFloor');
    expect(filterCandidates([], DEFAULT_CONSTRAINTS).emptiedBy).toBe('status');
  });

  it('time fit rules and session tags', () => {
    expect(sessionMinutes(['Session-30'])).toBe(30);
    expect(sessionMinutes(['45min'])).toBe(45);
    expect(sessionMinutes(['short'])).toBe('short');
    expect(sessionMinutes(['cozy'])).toBeNull();
    expect(fitsTime(cand({ type: 'movie', runtimeMinutes: null }), 120)).toBe(false); // unknown runtime never fits
    expect(fitsTime(cand({ type: 'book', tags: [] }), 120)).toBe(false);
    expect(fitsTime(cand({ type: 'book', tags: ['short'] }), 30)).toBe(true);
  });

  it('explains why a pick matched', () => {
    const c = cand({ dateAdded: '2024-10-30', tags: ['cozy'], runtimeMinutes: 95 });
    expect(pickReasons(c, { ...DEFAULT_CONSTRAINTS, availableMinutes: 90, tags: ['cozy'] }, today)).toEqual([
      'Planned 14 months',
      'fits 90 min (95 min)',
      'tag: cozy',
    ]);
  });
});

/* ------------------------------------------------------------------ pile health */

const hrow = (over: Partial<HealthRow>): HealthRow => ({
  id: 'x',
  type: 'book',
  status: 'planned',
  dateAdded: '2025-01-01',
  dateStarted: null,
  dateCompleted: null,
  lastActivity: null,
  snoozedUntil: null,
  ...over,
});

describe('Pile Health', () => {
  const t = { plannedStaleMonths: 12, inProgressStaleDays: 60 };
  it('detects stale Planned and idle In Progress items at the thresholds', () => {
    expect(staleness(hrow({ dateAdded: '2025-03-10' }), t, '2026-03-10')?.kind).toBe('planned-old');
    expect(staleness(hrow({ dateAdded: '2025-03-11' }), t, '2026-03-10')).toBeNull();
    const ip = hrow({ status: 'in_progress', dateStarted: '2026-01-01', lastActivity: '2026-01-09' });
    expect(staleness(ip, t, '2026-03-09')).toBeNull(); // 59 days
    expect(staleness(ip, t, '2026-03-10')).toMatchObject({ kind: 'in-progress-idle', days: 60 });
    expect(staleness(hrow({ status: 'completed', dateAdded: '2000-01-01' }), t, '2026-01-01')).toBeNull();
  });
  it('snoozes hide through their date and expire the day after (injected clock)', () => {
    const r = hrow({ dateAdded: '2020-01-01', snoozedUntil: '2026-03-10' });
    expect(isSnoozed(r.snoozedUntil, '2026-03-10')).toBe(true);
    expect(staleness(r, t, '2026-03-10')).toBeNull();
    expect(staleness(r, t, '2026-03-11')?.kind).toBe('planned-old');
  });
  it('pile stats from real rows; tiny samples are flagged', () => {
    const rows = [
      hrow({ id: '1', dateAdded: '2025-12-02' }),
      hrow({ id: '2', dateAdded: '2025-06-01', type: 'game' }),
      hrow({ id: '3', status: 'completed', dateAdded: '2025-01-01', dateCompleted: '2026-02-20' }),
      hrow({ id: '4', status: 'dropped', dateAdded: '2025-01-01' }),
    ];
    const s = pileStats(rows, '2026-03-01');
    expect(s.total).toBe(2);
    expect(s.sizeByType).toMatchObject({ book: 1, game: 1 });
    expect(s.medianPlannedAgeDays).toBe(Math.round((89 + 273) / 2));
    expect(s.windows).toEqual([
      { days: 30, added: 0, completed: 1 },
      { days: 90, added: 1, completed: 1 },
    ]);
    expect(s.trend).toHaveLength(12);
    expect(s.trend.at(-1)).toEqual({ month: '2026-03', size: 2 });
    expect(s.trend.find((m) => m.month === '2026-01')?.size).toBe(3); // completed item still on the pile in Jan
    expect(s.smallSample).toBe(true);
    expect(pileStats([], '2026-01-01').medianPlannedAgeDays).toBeNull();
  });
});

/* ------------------------------------------------------------------ stats */

const done = (over: Partial<CompletedRow>): CompletedRow => ({
  id: over.id ?? 'c',
  type: 'book',
  title: 'B',
  rating: null,
  dateStarted: null,
  dateCompleted: '2025-05-05',
  pageCount: null,
  genres: [],
  creators: [],
  tags: [],
  hours: null,
  episodes: null,
  ...over,
});

describe('Stats & Year in Review', () => {
  const rows = [
    done({
      id: '1',
      dateCompleted: '2024-12-31',
      rating: 10,
      genres: ['Fantasy'],
      pageCount: 500,
      dateStarted: '2024-12-01',
    }),
    done({
      id: '2',
      dateCompleted: '2025-01-01',
      rating: 6,
      genres: ['fantasy', 'Horror'],
      pageCount: 200,
      dateStarted: '2025-01-01',
    }),
    done({
      id: '3',
      type: 'game',
      dateCompleted: '2025-01-20',
      hours: 42.5,
      creators: ['Supergiant'],
      title: 'Hades',
    }),
    done({ id: '4', type: 'tv', dateCompleted: '2025-03-02', episodes: 18, rating: 8, tags: ['cozy'] }),
  ];
  it('aggregates by month/year/type with correct year boundaries', () => {
    const s = computeStats(rows, [], '2025-06-01');
    expect(s.completedByYear.map((y) => [y.year, y.total])).toEqual([
      [2024, 1],
      [2025, 3],
    ]);
    expect(s.completedByMonth.map((m) => m.month)).toEqual(['2024-12', '2025-01', '2025-03']);
    expect(s.topGenres[0]).toEqual({ name: 'Fantasy', count: 2 }); // case-insensitive grouping
    expect(s.avgRatingByType.find((r) => r.type === 'book')).toEqual({
      type: 'book',
      average: 8,
      rated: 2,
      completed: 2,
    });
    expect(s.pages).toEqual({ total: 700, booksWithPages: 2, booksWithoutPages: 0 });
    expect(s.gameHours).toEqual({ total: 42.5, gamesTracked: 1 });
    expect(s.timeToComplete.find((b) => b.bucket === 'Under a week')?.count).toBe(1);
    expect(s.timeToComplete.find((b) => b.bucket === '1–4 weeks')?.count).toBe(1);
    expect(s.timeToCompleteUnknown).toBe(2);
    const y2025 = computeStats(rows, [], '2025-06-01', { year: 2025 });
    expect(y2025.completedByMonth.reduce((n, m) => n + m.total, 0)).toBe(3);
  });
  it('counts episodes by local month and computes streaks', () => {
    const s = computeStats(
      [],
      [
        { date: '2025-01-31', kind: 'episode' },
        { date: '2025-02-01', kind: 'episode' },
        { date: '2025-02-02', kind: 'progress' },
      ],
      '2025-02-03',
    );
    expect(s.episodesByMonth).toEqual([
      { month: '2025-01', count: 1 },
      { month: '2025-02', count: 1 },
    ]);
    expect(streaks(['2025-01-06', '2025-01-13', '2025-01-27'], '2025-01-28')).toEqual({
      current: 1,
      longest: 2,
    });
    expect(streaks([], '2025-01-01')).toEqual({ current: 0, longest: 0 });
  });
  it('year in review with honest missing-data counts', () => {
    const y = yearInReview(rows, 2025);
    expect(y.finished).toBe(3);
    expect(y.favorites.map((f) => f.id)).toEqual(['4', '2']);
    expect(y.longestGame).toEqual({ id: '3', title: 'Hades', hours: 42.5 });
    expect(y.longestShow?.episodes).toBe(18);
    expect(y.busiestMonth).toEqual({ month: '2025-01', count: 2 });
    expect(y.missing).toEqual({ unrated: 1, noStartDate: 2, booksWithoutPages: 0 });
    expect(yearInReview(rows, 2030).finished).toBe(0);
  });
});

/* ------------------------------------------------------------------ goals */

describe('Goals', () => {
  it('period boundaries', () => {
    expect(periodRange('year', '2027-06-15')).toEqual({ start: '2027-01-01', end: '2027-12-31' });
    expect(periodRange('month', '2024-02-10')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(periodRange('custom', '2025-01-01', { start: '2025-01-05', end: '2025-02-05' })).toEqual({
      start: '2025-01-05',
      end: '2025-02-05',
    });
  });
  it('pace: on pace / ahead / behind / done / not started / ended, with the math', () => {
    // 24 books in a 365-day year; on 2027-07-02 (day 183) expected ≈ 12.03
    const mid = '2027-07-02';
    expect(pace(12, 24, '2027-01-01', '2027-12-31', mid).status).toBe('on-pace');
    expect(pace(15, 24, '2027-01-01', '2027-12-31', mid).status).toBe('ahead');
    expect(pace(9, 24, '2027-01-01', '2027-12-31', mid).status).toBe('behind');
    expect(pace(24, 24, '2027-01-01', '2027-12-31', mid).status).toBe('done');
    expect(pace(0, 24, '2027-01-01', '2027-12-31', '2026-12-31').status).toBe('not-started');
    expect(pace(3, 24, '2027-01-01', '2027-12-31', '2028-01-02').status).toBe('ended-short');
    expect(pace(12, 24, '2027-01-01', '2027-12-31', mid).math).toMatch(/24 × 183\/365 days = 12/);
    expect(neededPerWeek(12, 24, '2027-12-31', mid)).toBeCloseTo(0.5, 1);
    expect(neededPerWeek(24, 24, '2027-12-31', mid)).toBeNull();
  });
});

/* ------------------------------------------------------------------ ics */

describe('.ics export', () => {
  it('escapes text, folds long lines by octets and keeps UIDs stable', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const long = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(long);
    for (const line of folded.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    const ics = buildIcs(
      [
        { itemId: 'abc', date: '2027-03-14', summary: 'Game, the sequel; part 2', description: 'x' },
        { itemId: 'no', date: '2027-03', summary: 'skipped' },
      ],
      new Date('2026-11-23T10:00:00Z'),
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain('UID:release-abc@maybe-pile');
    expect(ics).toContain('DTSTART;VALUE=DATE:20270314');
    expect(ics).toContain('DTEND;VALUE=DATE:20270315');
    expect(ics).toContain('SUMMARY:Game\\, the sequel\\; part 2');
    expect(ics).toContain('DTSTAMP:20261123T100000Z');
    expect(ics).not.toContain('skipped');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});

/* ------------------------------------------------------------------ release radar */

describe('Release Radar', () => {
  it('precision, spans and upcoming rules', () => {
    expect(precisionOf('2027')).toBe('year');
    expect(precisionOf('2027-03')).toBe('month');
    expect(precisionOf('2027-03-14')).toBe('day');
    expect(dateSpan('2024-02')).toEqual({ first: '2024-02-01', last: '2024-02-29' });
    expect(isUpcoming('2026-11', '2026-11-23')).toBe(true); // could still be this month
    expect(isUpcoming('2026-11-22', '2026-11-23')).toBe(false);
    expect(isUpcoming(null, '2026-11-23')).toBe(false);
    expect(relativeLabel('2026-11-24', '2026-11-23')).toBe('tomorrow');
    expect(relativeLabel('2026', '2026-11-23')).toBe('sometime this year');
    expect(relativeLabel('2027', '2026-11-23')).toBe('in 2027');
  });
  it('notifications fire only for exact dates today/tomorrow (injected clock)', () => {
    expect(notificationKind('2026-11-23', '2026-11-23')).toBe('today');
    expect(notificationKind('2026-11-24', '2026-11-23')).toBe('tomorrow');
    expect(notificationKind('2026-12-31', '2026-12-30')).toBe('tomorrow');
    expect(notificationKind('2027-01-01', '2026-12-31')).toBe('tomorrow'); // year boundary
    expect(notificationKind('2026-11', '2026-11-23')).toBeNull();
    expect(notificationKind('2026-11-25', '2026-11-23')).toBeNull();
  });
});

/* ------------------------------------------------------------------ steam */

describe('Steam input validation', () => {
  it('accepts SteamID64, vanity names and steamcommunity.com profile URLs only', () => {
    expect(parseSteamAccount('76561197960287930')).toEqual({
      ok: true,
      kind: 'steamid',
      steamId: '76561197960287930',
    });
    expect(parseSteamAccount('https://steamcommunity.com/profiles/76561197960287930/')).toMatchObject({
      kind: 'steamid',
    });
    expect(parseSteamAccount('steamcommunity.com/id/gabe_n')).toEqual({
      ok: true,
      kind: 'vanity',
      vanity: 'gabe_n',
    });
    expect(parseSteamAccount('gaben')).toEqual({ ok: true, kind: 'vanity', vanity: 'gaben' });
    for (const bad of [
      '',
      '12345',
      '7656119796028793',
      'https://evil.example/id/gaben',
      'https://steamcommunity.com.evil.example/id/x',
      'https://user:pw@steamcommunity.com/id/x',
      'https://steamcommunity.com:8443/id/x',
      'https://steamcommunity.com/id/bad name',
      'javascript:alert(1)',
      'https://steamcommunity.com/groups/x',
      'a',
      'name<script>',
    ])
      expect(parseSteamAccount(bad).ok, bad).toBe(false);
    expect(steamKeyError('0123456789ABCDEF0123456789ABCDEF')).toBeNull();
    expect(steamKeyError('short')).toMatch(/32/);
    expect(steamKeyError('')).toBeNull();
  });
  it('recognizes obvious non-games by name and diffs snapshots', () => {
    expect(nonGameReason('Counter-Strike 2 Dedicated Server')).toBe('Dedicated server');
    expect(nonGameReason('Celeste Original Soundtrack')).toBe('Soundtrack');
    expect(nonGameReason('Half-Life 2')).toBeNull();
    const d = diffSnapshot(
      [
        { externalId: '1', name: 'A', playtimeMinutes: 0, removed: false },
        { externalId: '2', name: 'B', playtimeMinutes: 10, removed: false },
        { externalId: '3', name: 'C', playtimeMinutes: 0, removed: false },
      ],
      [
        { externalId: '1', name: 'A', playtimeMinutes: 0, lastPlayedAt: null, platform: null },
        { externalId: '2', name: 'B', playtimeMinutes: 25, lastPlayedAt: null, platform: null },
        { externalId: '4', name: 'D', playtimeMinutes: 0, lastPlayedAt: null, platform: null },
      ],
    );
    expect(d.added.map((x) => x.externalId)).toEqual(['4']);
    expect(d.playtimeChanged.map((x) => [x.entry.externalId, x.before])).toEqual([['2', 10]]);
    expect(d.removed.map((x) => x.externalId)).toEqual(['3']);
  });
  it('log redaction removes Steam keys and SteamIDs', () => {
    const out = redactString(
      'GET https://api.steampowered.com/x?key=0123456789ABCDEF0123456789ABCDEF&steamid=76561197960287930',
    );
    expect(out).not.toContain('0123456789ABCDEF');
    expect(out).not.toContain('76561197960287930');
  });
});

/* ------------------------------------------------------------------ fuzzy */

describe('fuzzy ranking', () => {
  it('is deterministic, accent-insensitive and prefers prefixes/word starts', () => {
    const items = [
      { id: '3', label: 'Go to Library' },
      { id: '1', label: 'Pokémon Legends' },
      { id: '2', label: 'Pick for Me' },
      { id: '4', label: 'Persona 5' },
    ];
    expect(fuzzyRank('pok', items).map((i) => i.id)[0]).toBe('1');
    expect(fuzzyRank('pkfm', items).map((i) => i.id)).toEqual(['2']);
    expect(fuzzyRank('lib', items)[0]?.id).toBe('3');
    expect(fuzzyScore('zzz', 'Pick')).toBeNull();
    const a = fuzzyRank('p', items).map((i) => i.id);
    const b = fuzzyRank('p', [...items].reverse()).map((i) => i.id);
    expect(a).toEqual(b);
  });
});

/* ------------------------------------------------------------------ tracker CSV */

const GOODREADS = [
  'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies',
  '1,Dune,Frank Herbert,"Herbert, Frank",,"=""0441172717""","=""9780441172719""",5,4.25,Ace,Paperback,604,1990,1965,2024/03/15,2023/01/02,"sci-fi, favorites",,read,"So good, really.",,,1,0',
  '2,Piranesi,Susanna Clarke,"Clarke, Susanna",,"=""""","=""""",0,4.2,Bloomsbury,Hardcover,,2020,2020,,2024/05/01,,,to-read,,,,0,0',
  '3,"Book, with comma",A,B,,,,3,3,,,,,,,2024/06/01,,,did-not-finish-pile,,,,0,0',
  '4,,NoTitle,,,,,,,,,,,,,,,,read,,,,,',
].join('\n');

describe('tracker imports (pure mapping)', () => {
  it('Goodreads: ISBN cells, ratings, shelves → status/tags, missing dates, unknown shelves', () => {
    const rows = parseCsv(GOODREADS);
    expect(detectFormat(rows[0] ?? [])).toBe('goodreads');
    const out = mapGoodreads(rows);
    expect(out.rows.map((r) => r.title)).toEqual(['Dune', 'Piranesi', 'Book, with comma']);
    const dune = out.rows[0];
    expect(dune).toMatchObject({
      isbn10: '0441172717',
      isbn13: '9780441172719',
      rating: 10,
      status: 'completed',
      dateCompleted: '2024-03-15',
      dateAdded: '2023-01-02',
      pageCount: 604,
      releaseDate: '1965',
      creator: 'Frank Herbert',
    });
    expect(dune?.tags).toEqual(['sci-fi', 'favorites']);
    expect(out.rows[1]).toMatchObject({ status: 'planned', rating: null, isbn13: null, pageCount: null });
    expect(out.rows[2]?.status).toBe('planned'); // unknown shelf → Planned, kept as a tag
    expect(out.rows[2]?.tags).toContain('did-not-finish-pile');
    expect(out.messages.some((m) => m.row === 5 && m.severity === 'error')).toBe(true); // no title
    expect(out.messages.some((m) => m.row === 4 && /Unknown shelf/.test(m.message))).toBe(true);
  });

  it('Letterboxd: merges watchlist/watched/ratings/diary by URI', () => {
    const out = mapLetterboxd([
      {
        name: 'watchlist.csv',
        rows: parseCsv(
          'Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,https://boxd.it/a\n2024-01-02,Alien,1979,https://boxd.it/b',
        ),
      },
      {
        name: 'watched.csv',
        rows: parseCsv('Date,Name,Year,Letterboxd URI\n2024-02-01,Heat,1995,https://boxd.it/a'),
      },
      {
        name: 'ratings.csv',
        rows: parseCsv('Date,Name,Year,Letterboxd URI,Rating\n2024-02-01,Heat,1995,https://boxd.it/a,4.5'),
      },
      {
        name: 'diary.csv',
        rows: parseCsv(
          'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-02-01,Heat,1995,https://boxd.it/x1,4.5,,"crime, rewatch",2024-01-31\n2024-06-01,Heat,1995,https://boxd.it/x2,5,Yes,,2024-05-30',
        ),
      },
      { name: 'notes.csv', rows: parseCsv('foo,bar\n1,2') },
    ]);
    const heat = out.rows.find((r) => r.title === 'Heat' && r.status === 'completed');
    expect(heat).toMatchObject({ rating: 9, releaseDate: '1995', dateCompleted: '2024-02-01' });
    expect(out.rows.find((r) => r.title === 'Alien')).toMatchObject({
      status: 'planned',
      dateAdded: '2024-01-02',
    });
    expect(out.messages.some((m) => /not a Letterboxd/.test(m.message))).toBe(true);
    // Diary rows have their own URIs per entry; viewings are attached to the diary film record
    const diaryFilms = out.rows.filter((r) => r.viewings.length > 0);
    expect(diaryFilms.flatMap((f) => f.viewings).sort()).toEqual(['2024-01-31', '2024-05-30']);
  });

  it('generic mapper: suggestions, scales, dates, delimiters, quoted newlines, BOM', () => {
    const text =
      '﻿Name;Kind;Score;Finished;Labels\n"Multi\nline";film;8;15.03.2024;a|b\nHollow;game;;2024-13-01;\n;book;5;;';
    const delim = detectDelimiter(text);
    expect(delim).toBe(';');
    const rows = parseCsv(text, 1000, delim);
    const m = {
      ...suggestMapping(rows[0] ?? []),
      ratingScale: 'ten' as const,
      dateOrder: 'dmy' as const,
      tagSeparator: '|' as const,
    };
    m.columns.status = null;
    m.columns.tags = 'Labels';
    m.columns.dateCompleted = 'Finished';
    m.columns.rating = 'Score';
    expect(m.columns.title).toBe('Name');
    expect(m.columns.type).toBe('Kind');
    const out = mapGeneric(rows, m);
    expect(out.rows[0]).toMatchObject({
      title: 'Multi\nline',
      type: 'movie',
      rating: 8,
      dateCompleted: '2024-03-15',
      tags: ['a', 'b'],
    });
    expect(out.rows[1]).toMatchObject({ title: 'Hollow', type: 'game', dateCompleted: null });
    expect(out.messages.some((x) => x.row === 3 && /Could not read the date/.test(x.message))).toBe(true);
    expect(out.messages.some((x) => x.row === 4 && x.severity === 'error')).toBe(true);
    expect(mapGeneric(rows, { ...m, columns: { ...m.columns, title: null } }).messages[0]?.message).toMatch(
      /Title/,
    );
  });

  it('rating conversion, date parsing and status words', () => {
    expect(convertRating('4.5', 'stars5half')).toBe(9);
    expect(convertRating('0', 'stars5')).toBeNull();
    expect(convertRating('', 'ten')).toBeNull();
    expect(convertRating('85', 'hundred')).toBe(9);
    expect(convertRating('6', 'stars5')).toBe('invalid');
    expect(convertRating('-1', 'ten')).toBe('invalid');
    expect(convertRating('3,5', 'stars5half')).toBe(7);
    expect(parseFlexibleDate('2024/02/29')).toBe('2024-02-29');
    expect(parseFlexibleDate('2023/02/29')).toBeNull();
    expect(parseFlexibleDate('03/15/2024', 'mdy')).toBe('2024-03-15');
    expect(parseFlexibleDate('2024-03-15T10:00:00Z')).toBe('2024-03-15');
    expect(normalizeStatus('Currently-Reading')).toBe('in_progress');
    expect(normalizeStatus('want to read')).toBe('planned');
    expect(normalizeStatus('DNF')).toBe('dropped');
    expect(normalizeStatus('weird')).toBeNull();
  });
});

/* ------------------------------------------------------------------ layouts & themes */

describe('layout schema v2 and theme state tokens', () => {
  it('migrates v1 layout files by appending the new components', () => {
    const v1 = JSON.stringify({
      format: 'maybepile-layout',
      schemaVersion: 1,
      dashboard: [{ id: 'counts', visible: true, span: 2 }],
      library: [{ id: 'search', visible: true }],
    });
    const r = parseLayoutFile(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(2);
    expect(r.value.dashboard.map((d) => d.id)).toEqual([
      'counts',
      'goals',
      'upcoming',
      'pileHealth',
      'statsSummary',
      'lists',
    ]);
    expect(parseLayoutFile(JSON.stringify({ ...JSON.parse(v1), schemaVersion: 3 })).ok).toBe(false);
    expect(
      parseLayoutFile(JSON.stringify({ ...JSON.parse(v1), dashboard: [{ id: 'evilWidget', visible: true }] }))
        .ok,
    ).toBe(false);
    expect(DEFAULT_LAYOUTS.dashboard.map((d) => d.id)).toEqual(
      expect.arrayContaining(['upNext', 'pick', 'pileHealth', 'upcoming', 'goals', 'lists', 'statsSummary']),
    );
  });
  it('older themes without state tokens stay valid and get AA defaults', () => {
    const old = { ...PILE_LIGHT, colors: { ...PILE_LIGHT.colors } } as Record<string, unknown> &
      typeof PILE_LIGHT;
    for (const k of ['snoozed', 'ignored', 'inPile', 'newItem'] as const)
      Reflect.deleteProperty(old.colors, k);
    expect(ThemeTokensSchema.safeParse(old).success).toBe(true);
    expect(colorOf(old, 'snoozed')).toBe('#5B4B8A');
    expect(themeToCssVars(old)).toContainEqual(['--mp-state-in-pile', '#276B2B']);
    expect(contrastWarnings(PILE_LIGHT)).toEqual([]);
    expect(contrastWarnings(PILE_DARK)).toEqual([]);
    expect(
      ThemeTokensSchema.safeParse({ ...PILE_LIGHT, colors: { ...PILE_LIGHT.colors, snoozed: 'red' } })
        .success,
    ).toBe(false);
  });
});

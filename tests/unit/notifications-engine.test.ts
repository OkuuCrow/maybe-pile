import { describe, expect, it } from 'vitest';
import { plan } from '../../src/notifications/engine/engine';
import { cleanText } from '../../src/notifications/engine/render';
import {
  matchesRule,
  nextOccurrence,
  occurrencesBetween,
  validateRule,
} from '../../src/notifications/engine/repeat';
import {
  lastOccurrence,
  localDateString,
  offsetMinutes,
  quietUntil,
  resolveTimeZone,
  zonedToUtc,
} from '../../src/notifications/engine/time';
import {
  applyPreset,
  DEFAULT_NOTIFICATION_SETTINGS,
  presetDiverged,
} from '../../src/shared/notification-settings';
import { emptySnapshot, fakeState, item, settingsWith, UUIDS } from '../helpers/notify';

const BERLIN = 'Europe/Berlin';
const NY = 'America/New_York';
const iso = (s: string) => new Date(s);

describe('time: zones and DST', () => {
  it('converts local wall time to UTC in summer and winter', () => {
    expect(zonedToUtc('2026-07-01', '18:00', BERLIN).toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(zonedToUtc('2026-01-15', '18:00', BERLIN).toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(zonedToUtc('2026-07-01', '09:00', NY).toISOString()).toBe('2026-07-01T13:00:00.000Z');
  });
  it('shifts nonexistent spring-forward times forward by the gap', () => {
    // 2026-03-29 02:30 does not exist in Berlin → 03:30 CEST = 01:30Z
    expect(zonedToUtc('2026-03-29', '02:30', BERLIN).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // New York 2026-03-08 02:15 → 03:15 EDT = 07:15Z
    expect(zonedToUtc('2026-03-08', '02:15', NY).toISOString()).toBe('2026-03-08T07:15:00.000Z');
  });
  it('resolves ambiguous fall-back times to the first occurrence', () => {
    // 2026-10-25 02:30 happens twice in Berlin; first is CEST (+2) → 00:30Z
    expect(zonedToUtc('2026-10-25', '02:30', BERLIN).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(zonedToUtc('2026-11-01', '01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
  it('reports offsets and local dates', () => {
    expect(offsetMinutes(iso('2026-07-01T12:00:00Z'), BERLIN)).toBe(120);
    expect(offsetMinutes(iso('2026-01-01T12:00:00Z'), BERLIN)).toBe(60);
    expect(localDateString(iso('2026-07-01T23:30:00Z'), BERLIN)).toBe('2026-07-02');
  });
  it('falls back to a valid zone', () => {
    expect(resolveTimeZone('Not/AZone', 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimeZone(null, 'Bad/Zone')).toBe('UTC');
    expect(resolveTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });
  it('finds the latest daily and weekly occurrence', () => {
    const now = iso('2026-11-26T20:00:00Z'); // Thu 21:00 Berlin
    expect(lastOccurrence(now, BERLIN, '18:00', 'daily', 0)?.date).toBe('2026-11-26');
    expect(lastOccurrence(iso('2026-11-26T16:00:00Z'), BERLIN, '18:00', 'daily', 0)?.date).toBe('2026-11-25');
    expect(lastOccurrence(now, BERLIN, '10:00', 'weekly', 0)?.date).toBe('2026-11-22'); // Sunday
  });
  it('quiet hours span midnight, respect start days and chain into disallowed days', () => {
    const q = { enabled: true, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] };
    expect(quietUntil(iso('2026-11-26T22:30:00Z'), q, [0, 1, 2, 3, 4, 5, 6], BERLIN)?.toISOString()).toBe(
      '2026-11-27T07:00:00.000Z',
    );
    expect(quietUntil(iso('2026-11-26T03:00:00Z'), q, [0, 1, 2, 3, 4, 5, 6], BERLIN)?.toISOString()).toBe(
      '2026-11-26T07:00:00.000Z',
    );
    expect(quietUntil(iso('2026-11-26T12:00:00Z'), q, [0, 1, 2, 3, 4, 5, 6], BERLIN)).toBeNull();
    // Only Fridays start quiet hours: Thursday night is not quiet.
    expect(
      quietUntil(iso('2026-11-26T22:30:00Z'), { ...q, days: [5] }, [0, 1, 2, 3, 4, 5, 6], BERLIN),
    ).toBeNull();
    // Saturday not allowed: Friday-night quiet hours end 08:00 Sat → Saturday (disallowed) → Sunday 00:00,
    // which is inside Saturday-night quiet hours → Sunday 08:00 local.
    const until = quietUntil(iso('2026-11-27T23:00:00Z'), q, [0, 1, 2, 3, 4, 5], BERLIN);
    expect(until?.toISOString()).toBe('2026-11-29T07:00:00.000Z');
    expect(
      quietUntil(iso('2026-11-26T12:00:00Z'), { ...q, enabled: false }, [0, 1, 2, 3, 4, 5, 6], BERLIN),
    ).toBeNull();
  });
});

describe('repeat rules', () => {
  it('validates structured rules and rejects unsafe ones', () => {
    expect(validateRule({ freq: 'daily', interval: 2, weekdays: [] })).toBeNull();
    expect(validateRule({ freq: 'daily', interval: 0, weekdays: [] })).not.toBeNull();
    expect(validateRule({ freq: 'monthly', interval: 13, weekdays: [] })).not.toBeNull();
    expect(validateRule({ freq: 'weekdays', interval: 1, weekdays: [] })).not.toBeNull();
    expect(validateRule({ freq: 'weekdays', interval: 1, weekdays: [1, 1] })).not.toBeNull();
    expect(validateRule({ freq: 'weekly', interval: 1, weekdays: [2] })).not.toBeNull();
    expect(validateRule({ freq: 'cron' as never, interval: 1, weekdays: [] })).not.toBeNull();
  });
  it('matches daily / weekly / weekdays / monthly (with short-month clamp)', () => {
    expect(matchesRule({ freq: 'daily', interval: 3, weekdays: [] }, '2026-11-01', '2026-11-07')).toBe(true);
    expect(matchesRule({ freq: 'daily', interval: 3, weekdays: [] }, '2026-11-01', '2026-11-08')).toBe(false);
    expect(matchesRule({ freq: 'weekly', interval: 2, weekdays: [] }, '2026-11-01', '2026-11-15')).toBe(true);
    expect(matchesRule({ freq: 'weekly', interval: 2, weekdays: [] }, '2026-11-01', '2026-11-08')).toBe(
      false,
    );
    expect(matchesRule({ freq: 'weekdays', interval: 1, weekdays: [1, 3] }, '2026-11-01', '2026-11-25')).toBe(
      true,
    ); // Wed
    expect(matchesRule({ freq: 'monthly', interval: 1, weekdays: [] }, '2026-01-31', '2026-02-28')).toBe(
      true,
    );
    expect(matchesRule({ freq: 'monthly', interval: 1, weekdays: [] }, '2026-01-31', '2026-03-31')).toBe(
      true,
    );
    expect(matchesRule({ freq: 'daily', interval: 1, weekdays: [] }, '2026-11-10', '2026-11-09')).toBe(false);
  });
  it('advances from the scheduled time, DST-safe', () => {
    const rule = { freq: 'daily' as const, interval: 1, weekdays: [] };
    const occ = occurrencesBetween(
      rule,
      '2026-10-20',
      '09:00',
      iso('2026-10-24T00:00:00Z'),
      iso('2026-10-26T12:00:00Z'),
      BERLIN,
    );
    expect(occ.map((d) => d.toISOString())).toEqual([
      '2026-10-24T07:00:00.000Z',
      '2026-10-25T08:00:00.000Z', // after fall-back, 09:00 local = 08:00Z
      '2026-10-26T08:00:00.000Z',
    ]);
    expect(
      nextOccurrence(rule, '2026-10-20', '09:00', iso('2026-10-26T08:00:00Z'), BERLIN)?.toISOString(),
    ).toBe('2026-10-27T08:00:00.000Z');
  });
});

describe('engine', () => {
  const NOW = iso('2026-11-26T17:05:00Z'); // Thu 18:05 Berlin
  const base = { now: NOW, timeZone: BERLIN };

  it('does nothing when off or paused', () => {
    const s = settingsWith(['keepGoing'], { mode: 'off' });
    const snap = emptySnapshot({
      inProgress: [
        {
          ...item(UUIDS[0], 'Frieren'),
          lastActivityAt: null,
          nextEpisode: null,
          nextStep: null,
          nextStepSpoiler: false,
        },
      ],
    });
    expect(plan({ ...base, settings: s, snapshot: snap, state: fakeState() }).deliver).toEqual([]);
    const st = fakeState();
    st.snoozes.set('global:*', iso('2026-11-26T20:00:00Z'));
    const p = plan({ ...base, settings: { ...s, mode: 'whileOpen' }, snapshot: snap, state: st });
    expect(p.paused).toBe(true);
    expect(p.deliver).toEqual([]);
  });

  it('keep going: one nudge with next episode, privacy levels, adult and Spoiler Shield', () => {
    const ip = (over = {}) => ({
      ...item(UUIDS[0], 'Frieren', { type: 'anime' }),
      lastActivityAt: '2026-11-20T10:00:00.000Z',
      nextEpisode: 'S1E12',
      nextStep: null,
      nextStepSpoiler: false,
      ...over,
    });
    const other = { ...ip(), id: UUIDS[1], title: 'Dune', lastActivityAt: '2026-11-25T10:00:00.000Z' };
    const snap = emptySnapshot({ inProgress: [ip(), other] });
    const titles = plan({
      ...base,
      settings: settingsWith(['keepGoing']),
      snapshot: snap,
      state: fakeState(),
    });
    expect(titles.deliver).toHaveLength(1);
    expect(titles.deliver[0]).toMatchObject({
      category: 'keepGoing',
      key: 'keepGoing:2026-11-26',
      body: 'Frieren — next: S1E12 · 1 more in progress',
    });
    expect(titles.deliver[0]?.actions.map((a) => a.id)).toEqual([
      'open',
      'snooze1h',
      'snoozeTomorrow',
      'mute',
    ]);

    const generic = plan({
      ...base,
      settings: settingsWith(['keepGoing'], { privacy: 'generic' }),
      snapshot: snap,
      state: fakeState(),
    });
    expect(generic.deliver[0]?.body).not.toContain('Frieren');
    const count = plan({
      ...base,
      settings: settingsWith(['keepGoing'], { privacy: 'count' }),
      snapshot: snap,
      state: fakeState(),
    });
    expect(count.deliver[0]?.body).toMatch(/^1 thing in progress/);

    const adult = plan({
      ...base,
      settings: settingsWith(['keepGoing']),
      snapshot: emptySnapshot({ inProgress: [ip({ adult: true })] }),
      state: fakeState(),
    });
    expect(adult.deliver[0]?.body).not.toContain('Frieren');
    const shielded = plan({
      ...base,
      settings: settingsWith(['keepGoing']),
      snapshot: emptySnapshot({ inProgress: [ip({ shielded: true })] }),
      state: fakeState(),
    });
    expect(shielded.deliver[0]?.body).toBe('Frieren');
    const noEp = plan({
      ...base,
      settings: settingsWith(['keepGoing'], { showNextEpisode: false }),
      snapshot: emptySnapshot({ inProgress: [ip()] }),
      state: fakeState(),
    });
    expect(noEp.deliver[0]?.body).toBe('Frieren');
    const step = plan({
      ...base,
      settings: settingsWith(['keepGoing']),
      snapshot: emptySnapshot({ inProgress: [ip({ nextStep: 'finish chapter 3' })] }),
      state: fakeState(),
    });
    expect(step.deliver[0]?.body).toBe('Frieren — next: finish chapter 3');
    const spoilStep = plan({
      ...base,
      settings: settingsWith(['keepGoing']),
      snapshot: emptySnapshot({ inProgress: [ip({ nextStep: 'boss dies', nextStepSpoiler: true })] }),
      state: fakeState(),
    });
    expect(spoilStep.deliver[0]?.body).toBe('Frieren — next: S1E12');
  });

  it('keep going respects threshold, cooldown, mute and item snooze', () => {
    const fresh = {
      ...item(UUIDS[0], 'Frieren'),
      lastActivityAt: '2026-11-25T10:00:00.000Z',
      nextEpisode: null,
      nextStep: null,
      nextStepSpoiler: false,
    };
    const s = settingsWith(['keepGoing']);
    expect(
      plan({ ...base, settings: s, snapshot: emptySnapshot({ inProgress: [fresh] }), state: fakeState() })
        .deliver,
    ).toEqual([]);
    const stale = { ...fresh, lastActivityAt: '2026-11-01T10:00:00.000Z' };
    const st = fakeState();
    st.delivered.push({ category: 'keepGoing', itemId: UUIDS[0], at: iso('2026-11-25T17:00:00Z') });
    expect(
      plan({ ...base, settings: s, snapshot: emptySnapshot({ inProgress: [stale] }), state: st }).deliver,
    ).toEqual([]);
    const muted = fakeState();
    muted.mutes.add(`item:${UUIDS[0]}`);
    expect(
      plan({ ...base, settings: s, snapshot: emptySnapshot({ inProgress: [stale] }), state: muted }).deliver,
    ).toEqual([]);
    const snoozed = fakeState();
    snoozed.snoozes.set(`item:${UUIDS[0]}`, iso('2026-11-27T00:00:00Z'));
    expect(
      plan({ ...base, settings: s, snapshot: emptySnapshot({ inProgress: [stale] }), state: snoozed })
        .deliver,
    ).toEqual([]);
  });

  it('skips already-claimed keys (exactly-once at the engine level)', () => {
    const snap = emptySnapshot({
      upNext: [item(UUIDS[0], 'Hades II'), item(UUIDS[1], 'Dune'), item(UUIDS[2], 'Severance')],
    });
    const s = settingsWith(['upNext'], {
      categories: {
        ...DEFAULT_NOTIFICATION_SETTINGS.categories,
        upNext: {
          ...DEFAULT_NOTIFICATION_SETTINGS.categories.upNext,
          enabled: true,
          frequency: 'daily',
          time: '18:00',
        },
      },
    });
    const first = plan({ ...base, settings: s, snapshot: snap, state: fakeState() });
    expect(first.deliver[0]?.body).toBe('Hades II, Dune, Severance');
    const st = fakeState();
    st.claimed.add(first.deliver[0]!.key);
    expect(plan({ ...base, settings: s, snapshot: snap, state: st }).deliver).toEqual([]);
  });

  it('releases: lead day and release day; anime airing respects Spoiler Shield', () => {
    const s = settingsWith(['releases'], {
      categories: {
        ...DEFAULT_NOTIFICATION_SETTINGS.categories,
        releases: { ...DEFAULT_NOTIFICATION_SETTINGS.categories.releases, enabled: true, time: '18:00' },
      },
    });
    const snap = emptySnapshot({
      releases: [{ ...item(UUIDS[0], 'Dune: Part Three', { type: 'movie' }), releaseDate: '2026-11-27' }],
      airing: [
        {
          ...item(UUIDS[1], 'Frieren', { type: 'anime', shielded: true }),
          episode: 12,
          airingAt: '2026-11-26T16:30:00.000Z',
        },
      ],
    });
    const p = plan({ ...base, settings: s, snapshot: snap, state: fakeState() });
    const bodies = p.deliver.map((d) => d.body);
    expect(bodies).toContain('Dune: Part Three releases tomorrow');
    expect(bodies).toContain('Frieren has a new episode');
  });

  it('leaving soon uses N days then 1 day', () => {
    const s = settingsWith(['leavingSoon'], {
      categories: {
        ...DEFAULT_NOTIFICATION_SETTINGS.categories,
        leavingSoon: {
          ...DEFAULT_NOTIFICATION_SETTINGS.categories.leavingSoon,
          enabled: true,
          time: '18:00',
          threshold: 3,
        },
      },
    });
    const e = {
      ...item(UUIDS[0], 'Severance'),
      entryId: UUIDS[3],
      serviceName: 'Apple TV+',
      availableUntil: '2026-11-29',
    };
    const p = plan({ ...base, settings: s, snapshot: emptySnapshot({ leaving: [e] }), state: fakeState() });
    expect(p.deliver[0]?.body).toBe('Severance leaves Apple TV+ in 3 days');
  });

  it('custom reminders fire once per occurrence, re-fire after snooze, honor mute', () => {
    const s = settingsWith(['custom']);
    const r = {
      id: UUIDS[0],
      itemId: null,
      item: null,
      message: 'Start Disco Elysium',
      kind: 'repeat' as const,
      anchorAt: '2026-11-01T17:00:00.000Z',
      anchorDate: '2026-11-01',
      localTime: '18:00',
      rule: { freq: 'daily' as const, interval: 1, weekdays: [] },
    };
    const p = plan({ ...base, settings: s, snapshot: emptySnapshot({ reminders: [r] }), state: fakeState() });
    expect(p.deliver).toHaveLength(1);
    expect(p.deliver[0]).toMatchObject({
      key: `custom:${UUIDS[0]}:2026-11-26T17:00:00.000Z`,
      body: 'Start Disco Elysium',
    });
    const st = fakeState();
    st.claimed.add(p.deliver[0]!.key);
    st.snoozes.set(`reminder:${UUIDS[0]}`, iso('2026-11-26T17:04:00Z'));
    const again = plan({ ...base, settings: s, snapshot: emptySnapshot({ reminders: [r] }), state: st });
    expect(again.deliver.map((d) => d.key)).toEqual([`custom:${UUIDS[0]}:snooze:2026-11-26T17:04:00.000Z`]);
    const muted = fakeState();
    muted.mutes.add(`reminder:${UUIDS[0]}`);
    expect(
      plan({ ...base, settings: s, snapshot: emptySnapshot({ reminders: [r] }), state: muted }).deliver,
    ).toEqual([]);
    const once = { ...r, kind: 'once' as const, rule: null, anchorAt: '2026-11-26T17:00:00.000Z' };
    expect(
      plan({ ...base, settings: s, snapshot: emptySnapshot({ reminders: [once] }), state: fakeState() })
        .deliver,
    ).toHaveLength(1);
  });

  it('quiet hours defer (held), then one digest after; session-running is dropped', () => {
    const s = settingsWith(['custom', 'sessionRunning'], {
      quietHours: { enabled: true, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] },
    });
    const reminder = (id: string, at: string) => ({
      id,
      itemId: null,
      item: null,
      message: `R ${id.slice(0, 2)}`,
      kind: 'once' as const,
      anchorAt: at,
      anchorDate: at.slice(0, 10),
      localTime: '00:00',
      rule: null,
    });
    const snap = emptySnapshot({
      reminders: [
        reminder(UUIDS[0], '2026-11-26T22:00:00.000Z'),
        reminder(UUIDS[1], '2026-11-26T23:00:00.000Z'),
      ],
      sessions: [
        { ...item(UUIDS[2], 'Elden Ring', { type: 'game' }), sessionId: UUIDS[3], elapsedSeconds: 5 * 3600 },
      ],
    });
    const night = plan({
      now: iso('2026-11-26T23:30:00Z'),
      timeZone: BERLIN,
      settings: s,
      snapshot: snap,
      state: fakeState(),
    });
    expect(night.deliver).toEqual([]);
    expect(night.deferred).toBe(2);
    expect(night.record.map((r) => r.reason)).toEqual(['quiet_dropped']);
    const morning = plan({
      now: iso('2026-11-27T07:10:00Z'),
      timeZone: BERLIN,
      settings: s,
      snapshot: snap,
      state: fakeState(),
    });
    expect(morning.deliver).toHaveLength(1);
    expect(morning.deliver[0]).toMatchObject({ kind: 'digest', title: 'While quiet hours were on' });
    expect(morning.deliver[0]?.memberKeys).toHaveLength(3);
  });

  it('catch-up: at most one "while you were away" digest; skip records missed', () => {
    const s = settingsWith(['custom']);
    const r = (id: string, at: string) => ({
      id,
      itemId: null,
      item: null,
      message: 'x',
      kind: 'once' as const,
      anchorAt: at,
      anchorDate: at.slice(0, 10),
      localTime: '00:00',
      rule: null,
    });
    const snap = emptySnapshot({
      reminders: [r(UUIDS[0], '2026-11-26T08:00:00.000Z'), r(UUIDS[1], '2026-11-26T09:00:00.000Z')],
    });
    const p = plan({ ...base, settings: s, snapshot: snap, state: fakeState() });
    expect(p.deliver).toHaveLength(1);
    expect(p.deliver[0]?.title).toBe('While you were away');
    const skip = plan({ ...base, settings: { ...s, catchUp: 'skip' }, snapshot: snap, state: fakeState() });
    expect(skip.deliver).toEqual([]);
    expect(skip.record.map((x) => x.reason)).toEqual(['missed', 'missed']);
  });

  it('global daily cap coalesces overflow into one digest; zero remaining records capped', () => {
    const s = settingsWith(['custom'], { dailyCap: 2 });
    s.categories.custom = { ...s.categories.custom, cap: 10 };
    const rem = UUIDS.slice(0, 4).map((id, i) => ({
      id,
      itemId: null,
      item: null,
      message: `Reminder ${i}`,
      kind: 'once' as const,
      anchorAt: `2026-11-26T17:0${i}:00.000Z`,
      anchorDate: '2026-11-26',
      localTime: '18:00',
      rule: null,
    }));
    const p = plan({ ...base, settings: s, snapshot: emptySnapshot({ reminders: rem }), state: fakeState() });
    expect(p.deliver).toHaveLength(2);
    expect(p.deliver[1]).toMatchObject({ kind: 'digest', title: 'More from Maybe Pile' });
    expect(p.deliver[1]?.memberKeys.length).toBe(4); // digest key + 3 members
    const full = fakeState();
    full.delivered.push(
      { category: 'custom', itemId: null, at: iso('2026-11-26T08:00:00Z') },
      { category: 'upNext', itemId: null, at: iso('2026-11-26T09:00:00Z') },
    );
    const capped = plan({ ...base, settings: s, snapshot: emptySnapshot({ reminders: rem }), state: full });
    expect(capped.deliver).toEqual([]);
    expect(capped.record.every((r) => r.reason === 'capped')).toBe(true);
  });

  it('per-category cap coalesces into a category digest', () => {
    const s = settingsWith(['releases']);
    s.categories.releases = { ...s.categories.releases, time: '18:00', cap: 2 };
    const rel = UUIDS.slice(0, 4).map((id, i) => ({
      ...item(id, `Movie ${i}`, { type: 'movie' }),
      releaseDate: '2026-11-26',
    }));
    const p = plan({ ...base, settings: s, snapshot: emptySnapshot({ releases: rel }), state: fakeState() });
    expect(p.deliver).toHaveLength(2);
    expect(p.deliver.filter((d) => d.kind === 'digest')).toHaveLength(1);
  });

  it('weekly, goals, pile health, backup, loans, check-up, offline queue, auto rules render neutrally', () => {
    const SUNDAY = iso('2026-11-29T19:30:00Z'); // Sun 20:30 Berlin
    const all = settingsWith([
      'weeklySummary',
      'goalsPace',
      'pileHealth',
      'backup',
      'getItBack',
      'checkup',
      'offlineQueue',
      'autoRules',
      'dailyTimeGoal',
    ]);
    const snap = emptySnapshot({
      week: { completed: 2, inProgress: 3, nextUp: item(UUIDS[0], 'Dune', { type: 'book' }) },
      goals: [
        {
          id: 'g',
          title: 'Reading goal',
          metric: 'items',
          target: 24,
          progress: 9,
          start: '2026-01-01',
          end: '2026-12-31',
        },
      ],
      stale: { count: 5, months: 2 },
      lastBackupAt: '2026-10-20T10:00:00.000Z',
      backupSameDrive: true,
      loans: [
        {
          ...item(UUIDS[1], 'Dune', { type: 'book' }),
          loanId: UUIDS[2],
          direction: 'lent',
          person: 'Sam',
          dueDate: '2026-11-29',
        },
      ],
      offlineQueue: { finishedAt: '2026-11-29T19:00:00.000Z', count: 3 },
      autoRuleChanges: 2,
      timeGoals: [{ id: 't', title: 'Reading time', targetMinutes: 30, minutesInPeriod: 12, period: 'day' }],
    });
    const p = plan({
      now: SUNDAY,
      timeZone: BERLIN,
      settings: all,
      snapshot: snap,
      state: fakeState(),
      freshMinutes: 24 * 60,
    });
    const by = (c: string) => p.deliver.find((d) => d.category === c)?.body;
    expect(by('weeklySummary')).toBe('This week: 2 finished · 3 in progress · next up: Dune');
    expect(by('goalsPace')).toMatch(/^Reading goal: 9 of 24 items · slightly behind pace/);
    expect(by('pileHealth')).toBe("5 items haven't moved in 2 months.");
    expect(by('backup')).toBe(
      'Your last Maybe Pile backup was 40 days ago. Your backups are on the same drive as your library.',
    );
    expect(by('getItBack')).toBe('Dune is due back today.'); // names hidden unless allowed
    expect(by('checkup')).toMatch(/only reads/);
    expect(by('offlineQueue')).toMatch(/^3 items you added offline/);
    expect(by('autoRules')).toMatch(/^2 items changed/);
    expect(by('dailyTimeGoal')).toMatch(/12 of 30 minutes/);
    for (const d of p.deliver) expect(d.body).not.toMatch(/guilt|fail|lazy|should have/i);
    const names = plan({
      now: SUNDAY,
      timeZone: BERLIN,
      settings: { ...all, showPeopleNames: true },
      snapshot: snap,
      state: fakeState(),
      freshMinutes: 24 * 60,
    });
    expect(names.deliver.find((d) => d.category === 'getItBack')?.body).toBe(
      'Dune (lent to Sam) is due back today.',
    );
  });

  it('is deterministic and labels multiple libraries', () => {
    const snap = emptySnapshot({ libraryLabel: 'Family', upNext: [item(UUIDS[0], 'Bluey')] });
    const s = settingsWith(['upNext']);
    s.categories.upNext = { ...s.categories.upNext, frequency: 'daily', time: '18:00' };
    const a = plan({ ...base, settings: s, snapshot: snap, state: fakeState() });
    const b = plan({ ...base, settings: s, snapshot: snap, state: fakeState() });
    expect(a).toEqual(b);
    expect(a.deliver[0]?.title).toBe('Family · Up Next');
  });

  it('strips control and bidi characters and caps lengths', () => {
    expect(cleanText('Evil‮title\u0007\nnext', 100)).toBe('Evil title next');
    expect(cleanText('x'.repeat(300), 10)).toHaveLength(10);
  });
});

describe('presets', () => {
  it('maps presets to documented category sets and detects divergence', () => {
    const r = applyPreset(DEFAULT_NOTIFICATION_SETTINGS, 'rarely');
    expect(
      Object.entries(r.categories)
        .filter(([, c]) => c.enabled)
        .map(([k]) => k)
        .sort(),
    ).toEqual(['backup', 'custom', 'keepGoing', 'releases']);
    expect(r.dailyCap).toBe(2);
    expect(presetDiverged(r)).toBe(false);
    const custom = {
      ...r,
      categories: { ...r.categories, upNext: { ...r.categories.upNext, enabled: true } },
    };
    expect(presetDiverged(custom)).toBe(true);
    // Applying a preset keeps per-category times/privacy the user set.
    const tuned = {
      ...r,
      categories: {
        ...r.categories,
        releases: { ...r.categories.releases, time: '07:30', privacy: 'generic' as const },
      },
    };
    const often = applyPreset(tuned, 'often');
    expect(often.categories.releases).toMatchObject({ enabled: true, time: '07:30', privacy: 'generic' });
  });
});

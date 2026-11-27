/**
 * Per-category candidate generators. Each returns due candidates with stable
 * dedupe keys; the engine applies quiet hours, caps, digests and claims.
 *
 * Key format: `<category>:<scope…>:<occurrence>` — the occurrence makes a key
 * unique per scheduled firing, so a daily nudge has one key per local day.
 */
import { pace } from '../../domain/goals';
import type {
  CategoryConfig,
  NotificationCategory,
  NotificationSettings,
  PrivacyLevel,
} from '../../shared/notification-settings';
import type { ActionTarget } from '../protocol';
import { finish, itemName, plural, typeNoun } from './render';
import { occurrencesBetween } from './repeat';
import { addDays, daysBetween, lastOccurrence, localDateString, zonedToUtc } from './time';
import type { Candidate, LibrarySnapshot, StateView } from './types';

export interface GenContext {
  now: Date;
  tz: string;
  settings: NotificationSettings;
  snapshot: LibrarySnapshot;
  state: StateView;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function privacyFor(settings: NotificationSettings, category: NotificationCategory): PrivacyLevel {
  const p = settings.categories[category].privacy;
  return p === 'inherit' ? settings.privacy : p;
}

function mk(
  g: GenContext,
  category: NotificationCategory,
  key: string,
  dueAt: Date,
  expiresAt: Date,
  itemId: string | null,
  target: ActionTarget | null,
  text: { title: string; body: string; line: string },
): Candidate {
  const done = finish(text.title, text.body, g.snapshot.libraryLabel);
  return {
    key,
    category,
    dueAt,
    expiresAt,
    itemId,
    target,
    title: done.title,
    body: done.body,
    line: text.line,
    privacy: privacyFor(g.settings, category),
  };
}

/** Occurrence of a daily/weekly category schedule at or before now. */
function occurrence(g: GenContext, c: CategoryConfig) {
  return lastOccurrence(g.now, g.tz, c.time, c.frequency, c.weekday);
}

const endOfLocalDay = (date: string, tz: string) => zonedToUtc(addDays(date, 1), '00:00', tz);

/* ------------------------------------------------------------------ 1. keep going */

function keepGoing(g: GenContext): Candidate[] {
  const c = g.settings.categories.keepGoing;
  const occ = occurrence(g, c);
  if (!occ) return [];
  const p = privacyFor(g.settings, 'keepGoing');
  const thresholdMs = Math.max(1, c.threshold) * DAY;
  const cooldownMs = 3 * DAY;
  const stale = g.snapshot.inProgress.filter((i) => {
    const last = i.lastActivityAt ? Date.parse(i.lastActivityAt) : NaN;
    if (Number.isFinite(last) && occ.at.getTime() - last < thresholdMs) return false;
    if (g.state.isMuted('item', i.id)) return false;
    const snoozed = g.state.snoozedUntil('item', i.id);
    if (snoozed && snoozed.getTime() > g.now.getTime()) return false;
    const lastSent = g.state.lastDeliveredFor('keepGoing', i.id);
    return !(lastSent && g.now.getTime() - lastSent.getTime() < cooldownMs);
  });
  if (stale.length === 0) return [];
  // Feature the most recently active stale item (the one most likely to be "picked back up").
  const featured = [...stale].sort((a, b) =>
    (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''),
  )[0];
  if (!featured) return [];
  const others = g.snapshot.inProgress.length - 1;
  const name = itemName(featured, p);
  let title: string;
  let body: string;
  if (p === 'count') {
    title = 'Pick up where you left off';
    body = `${plural(stale.length, 'thing')} in progress ${stale.length === 1 ? "hasn't" : "haven't"} moved in a while.`;
  } else if (!name) {
    title = 'Pick up where you left off';
    body = `A ${typeNoun(featured.type)} you started is waiting for you${others > 0 ? ` · ${others} more in progress` : ''}.`;
  } else {
    const showEp = g.settings.showNextEpisode && !featured.shielded && featured.nextEpisode;
    const showStep = featured.nextStep && !featured.nextStepSpoiler && !featured.shielded;
    const next = showStep
      ? ` — next: ${featured.nextStep}`
      : showEp
        ? ` — next: ${featured.nextEpisode}`
        : '';
    title = 'Pick up where you left off';
    body = `${name}${next}${others > 0 ? ` · ${others} more in progress` : ''}`;
  }
  return [
    mk(
      g,
      'keepGoing',
      `keepGoing:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + 12 * HOUR),
      featured.id,
      { scope: 'item', id: featured.id },
      { title, body, line: name ? `Keep going: ${name}` : 'Something in progress is waiting' },
    ),
  ];
}

/* ------------------------------------------------------------------ 2. up next */

function upNext(g: GenContext): Candidate[] {
  const c = g.settings.categories.upNext;
  const occ = occurrence(g, c);
  if (!occ || g.snapshot.upNext.length === 0) return [];
  const p = privacyFor(g.settings, 'upNext');
  const top = g.snapshot.upNext.slice(0, 3);
  const names = top.map((i) => itemName(i, p)).filter((n): n is string => n !== null);
  const body =
    p === 'titles' && names.length > 0
      ? `${names.join(', ')}${g.snapshot.upNext.length > names.length ? ` · ${g.snapshot.upNext.length - names.length} more` : ''}`
      : `${plural(g.snapshot.upNext.length, 'thing')} on your Up Next shelf.`;
  return [
    mk(
      g,
      'upNext',
      `upNext:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + 12 * HOUR),
      top[0]?.id ?? null,
      null,
      {
        title: 'Up Next',
        body,
        line: `Up Next: ${plural(g.snapshot.upNext.length, 'item')}`,
      },
    ),
  ];
}

/* ------------------------------------------------------------------ 3. releases + anime airing */

function releases(g: GenContext): Candidate[] {
  const c = g.settings.categories.releases;
  const p = privacyFor(g.settings, 'releases');
  const out: Candidate[] = [];
  const today = localDateString(g.now, g.tz);
  const leads = [...new Set([Math.min(30, c.threshold), 0])];
  for (const r of g.snapshot.releases) {
    if (g.state.isMuted('item', r.id)) continue;
    for (const lead of leads) {
      const date = addDays(r.releaseDate, -lead);
      if (date > today || daysBetween(date, today) > 1) continue;
      const dueAt = zonedToUtc(date, c.time, g.tz);
      const name = itemName(r, p);
      const when = lead === 0 ? 'today' : lead === 1 ? 'tomorrow' : `in ${lead} days`;
      const body =
        p === 'count'
          ? `Something on your list releases ${when}.`
          : name
            ? `${name} releases ${when}`
            : `A ${typeNoun(r.type)} you're waiting for releases ${when}.`;
      out.push(
        mk(
          g,
          'releases',
          `releases:${r.id}:${r.releaseDate}:${lead}`,
          dueAt,
          endOfLocalDay(date, g.tz),
          r.id,
          { scope: 'item', id: r.id },
          { title: 'Release', body, line: name ? `${name} (${when})` : `A release ${when}` },
        ),
      );
    }
  }
  for (const a of g.snapshot.airing) {
    if (g.state.isMuted('item', a.id)) continue;
    const at = new Date(a.airingAt);
    if (!Number.isFinite(at.getTime())) continue;
    const name = itemName(a, p);
    const showEp = g.settings.showNextEpisode && !a.shielded;
    const body =
      p === 'count'
        ? 'A new episode of something you follow is out.'
        : name
          ? `${name}${showEp ? ` episode ${a.episode}` : ' has a new episode'}${showEp ? ' is out' : ''}`
          : 'A new episode of an anime you follow is out.';
    out.push(
      mk(
        g,
        'releases',
        `releases:airing:${a.id}:${a.episode}`,
        at,
        new Date(at.getTime() + DAY),
        a.id,
        { scope: 'item', id: a.id },
        { title: 'New episode', body, line: name ? `${name}: new episode` : 'A new episode' },
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ 4. leaving soon */

function leavingSoon(g: GenContext): Candidate[] {
  const c = g.settings.categories.leavingSoon;
  const p = privacyFor(g.settings, 'leavingSoon');
  const today = localDateString(g.now, g.tz);
  const out: Candidate[] = [];
  const leads = [...new Set([Math.max(1, c.threshold), 1])];
  for (const e of g.snapshot.leaving) {
    if (g.state.isMuted('item', e.id)) continue;
    for (const lead of leads) {
      const date = addDays(e.availableUntil, -lead);
      if (date > today || daysBetween(date, today) > 1) continue;
      const dueAt = zonedToUtc(date, c.time, g.tz);
      const name = itemName(e, p);
      const service = p === 'titles' && e.serviceName ? e.serviceName : null;
      const when = lead === 1 ? 'tomorrow' : `in ${lead} days`;
      const body =
        p === 'count'
          ? `Something you can watch leaves its service ${when}.`
          : name
            ? `${name} leaves ${service ?? 'its service'} ${when}`
            : `A ${typeNoun(e.type)} leaves its service ${when}.`;
      out.push(
        mk(
          g,
          'leavingSoon',
          `leavingSoon:${e.entryId}:${e.availableUntil}:${lead}`,
          dueAt,
          endOfLocalDay(date, g.tz),
          e.id,
          { scope: 'item', id: e.id },
          { title: 'Leaving soon', body, line: name ? `${name} leaves ${when}` : `Leaving ${when}` },
        ),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 5. custom reminders */

function custom(g: GenContext): Candidate[] {
  const p = privacyFor(g.settings, 'custom');
  const out: Candidate[] = [];
  const lookback = new Date(g.now.getTime() - DAY);
  for (const r of g.snapshot.reminders) {
    if (g.state.isMuted('reminder', r.id)) continue;
    if (r.itemId && g.state.isMuted('item', r.itemId)) continue;
    const occs: Date[] = [];
    if (r.kind === 'once') {
      const at = new Date(r.anchorAt);
      if (
        Number.isFinite(at.getTime()) &&
        at.getTime() > lookback.getTime() &&
        at.getTime() <= g.now.getTime()
      )
        occs.push(at);
    } else if (r.rule) {
      occs.push(...occurrencesBetween(r.rule, r.anchorDate, r.localTime, lookback, g.now, g.tz));
    }
    const name = itemName(r.item, p);
    const msg = p === 'titles' && !(r.item?.adult ?? false) ? r.message : null;
    const body =
      p === 'count'
        ? 'You have a reminder.'
        : msg
          ? msg
          : name
            ? `About ${name}`
            : 'You asked to be reminded about something.';
    const target: ActionTarget = { scope: 'reminder', id: r.id };
    for (const at of occs) {
      out.push(
        mk(
          g,
          'custom',
          `custom:${r.id}:${at.toISOString()}`,
          at,
          new Date(at.getTime() + DAY),
          r.itemId,
          target,
          {
            title: 'Reminder',
            body,
            line: msg ?? (name ? `Reminder: ${name}` : 'A reminder'),
          },
        ),
      );
    }
  }
  // "Remind me again" snoozes re-fire once when they end.
  for (const s of g.state.reminderSnoozes()) {
    const r = g.snapshot.reminders.find((x) => `reminder:${x.id}` === s.target || x.id === s.target);
    if (!r || g.state.isMuted('reminder', r.id)) continue;
    if (s.until.getTime() > g.now.getTime() || g.now.getTime() - s.until.getTime() > DAY) continue;
    const name = itemName(r.item, p);
    const msg = p === 'titles' && !(r.item?.adult ?? false) ? r.message : null;
    out.push(
      mk(
        g,
        'custom',
        `custom:${r.id}:snooze:${s.until.toISOString()}`,
        s.until,
        new Date(s.until.getTime() + DAY),
        r.itemId,
        { scope: 'reminder', id: r.id },
        {
          title: 'Reminder',
          body:
            p === 'count'
              ? 'You have a reminder.'
              : (msg ?? (name ? `About ${name}` : 'You asked to be reminded about something.')),
          line: msg ?? 'A snoozed reminder',
        },
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ 6. goals pace */

function goalsPace(g: GenContext): Candidate[] {
  const c = g.settings.categories.goalsPace;
  const occ = occurrence(g, c);
  if (!occ) return [];
  const p = privacyFor(g.settings, 'goalsPace');
  const behind = g.snapshot.goals.filter(
    (x) => pace(x.progress, x.target, x.start, x.end, occ.date).status === 'behind',
  );
  if (behind.length === 0) return [];
  const first = behind[0];
  if (!first) return [];
  const unit: Record<string, string> = {
    items: 'items',
    pages: 'pages',
    episodes: 'episodes',
    hours: 'hours',
  };
  const body =
    p === 'titles'
      ? `${first.title}: ${Math.round(first.progress)} of ${first.target} ${unit[first.metric]} · slightly behind pace${behind.length > 1 ? ` · ${behind.length - 1} more` : ''}`
      : `${plural(behind.length, 'goal')} slightly behind pace. No rush — just a heads-up.`;
  return [
    mk(
      g,
      'goalsPace',
      `goalsPace:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + 12 * HOUR),
      null,
      { scope: 'category', id: 'goalsPace' },
      { title: 'Goal check-in', body, line: `${plural(behind.length, 'goal')} behind pace` },
    ),
  ];
}

/* ------------------------------------------------------------------ 7. pile health */

function pileHealth(g: GenContext): Candidate[] {
  const c = g.settings.categories.pileHealth;
  const occ = occurrence(g, c);
  if (!occ || g.snapshot.stale.count === 0) return [];
  const n = g.snapshot.stale.count;
  const m = g.snapshot.stale.months;
  return [
    mk(
      g,
      'pileHealth',
      `pileHealth:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + 12 * HOUR),
      null,
      { scope: 'category', id: 'pileHealth' },
      {
        title: 'Not touched in a while',
        body: `${plural(n, 'item')} ${n === 1 ? "hasn't" : "haven't"} moved in ${m >= 2 ? `${m} months` : 'a while'}.`,
        line: `${plural(n, 'item')} not touched in a while`,
      },
    ),
  ];
}

/* ------------------------------------------------------------------ 8. backup */

function backup(g: GenContext): Candidate[] {
  const c = g.settings.categories.backup;
  const occ = occurrence(g, c);
  if (!occ) return [];
  const last = g.snapshot.lastBackupAt ? Date.parse(g.snapshot.lastBackupAt) : NaN;
  const days = Number.isFinite(last) ? Math.floor((occ.at.getTime() - last) / DAY) : null;
  const threshold = Math.max(1, c.threshold);
  const stale = days === null || days >= threshold;
  if (!stale && !g.snapshot.backupSameDrive) return [];
  const parts: string[] = [];
  if (stale)
    parts.push(
      days === null
        ? "You haven't made a Maybe Pile backup yet."
        : `Your last Maybe Pile backup was ${days} days ago.`,
    );
  if (g.snapshot.backupSameDrive) parts.push('Your backups are on the same drive as your library.');
  return [
    mk(
      g,
      'backup',
      `backup:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + DAY),
      null,
      { scope: 'category', id: 'backup' },
      {
        title: 'Back up your library',
        body: parts.join(' '),
        line: 'Backup reminder',
      },
    ),
  ];
}

/* ------------------------------------------------------------------ 9. session still running */

function sessionRunning(g: GenContext): Candidate[] {
  const c = g.settings.categories.sessionRunning;
  const p = privacyFor(g.settings, 'sessionRunning');
  const hours = Math.max(1, c.threshold);
  const out: Candidate[] = [];
  for (const s of g.snapshot.sessions) {
    if (s.elapsedSeconds < hours * 3600) continue;
    const dueAt = new Date(g.now.getTime() - (s.elapsedSeconds - hours * 3600) * 1000);
    const name = itemName(s, p);
    const verb = s.type === 'book' ? 'reading' : s.type === 'game' ? 'playing' : 'watching';
    const body =
      p === 'count'
        ? `A timer has been running for ${hours} h.`
        : name
          ? `Still ${verb} ${name}? Timer is at ${Math.floor(s.elapsedSeconds / 3600)} h`
          : `A timer has been running for ${Math.floor(s.elapsedSeconds / 3600)} h.`;
    out.push(
      mk(
        g,
        'sessionRunning',
        `sessionRunning:${s.sessionId}:${hours}`,
        dueAt,
        new Date(dueAt.getTime() + DAY),
        s.id,
        { scope: 'item', id: s.id },
        { title: 'Timer still running', body, line: 'A timer is still running' },
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ 10. weekly summary */

function weeklySummary(g: GenContext): Candidate[] {
  const c = g.settings.categories.weeklySummary;
  const occ = occurrence(g, c);
  if (!occ) return [];
  const p = privacyFor(g.settings, 'weeklySummary');
  const w = g.snapshot.week;
  const next = itemName(w.nextUp, p);
  const body = `This week: ${w.completed} finished · ${w.inProgress} in progress${next ? ` · next up: ${next}` : ''}`;
  return [
    mk(
      g,
      'weeklySummary',
      `weeklySummary:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + 12 * HOUR),
      null,
      { scope: 'category', id: 'weeklySummary' },
      { title: 'Your week', body, line: `${w.completed} finished this week` },
    ),
  ];
}

/* ------------------------------------------------------------------ 14.1 daily time goal */

function dailyTimeGoal(g: GenContext): Candidate[] {
  const c = g.settings.categories.dailyTimeGoal;
  const occ = occurrence(g, c);
  if (!occ) return [];
  const p = privacyFor(g.settings, 'dailyTimeGoal');
  const short = g.snapshot.timeGoals.filter((t) => t.period === 'day' && t.minutesInPeriod < t.targetMinutes);
  if (short.length === 0) return [];
  const first = short[0];
  if (!first) return [];
  const body =
    p === 'titles'
      ? `${first.title}: ${first.minutesInPeriod} of ${first.targetMinutes} minutes today. A few minutes still counts.`
      : 'Your daily time goal is still open today. A few minutes still counts.';
  return [
    mk(
      g,
      'dailyTimeGoal',
      `dailyTimeGoal:${occ.date}`,
      occ.at,
      endOfLocalDay(occ.date, g.tz),
      null,
      { scope: 'category', id: 'dailyTimeGoal' },
      { title: 'Daily time goal', body, line: 'Daily time goal still open' },
    ),
  ];
}

/* ------------------------------------------------------------------ 14.10 get it back */

function getItBack(g: GenContext): Candidate[] {
  const c = g.settings.categories.getItBack;
  const p = privacyFor(g.settings, 'getItBack');
  const today = localDateString(g.now, g.tz);
  const out: Candidate[] = [];
  const person = (n: string) => (p === 'titles' && g.settings.showPeopleNames ? n : null);
  for (const l of g.snapshot.loans) {
    if (l.dueDate !== today && l.dueDate !== addDays(today, -1)) continue;
    if (g.state.isMuted('item', l.id)) continue;
    const dueAt = zonedToUtc(l.dueDate, c.time, g.tz);
    const name = itemName(l, p);
    const who = person(l.person);
    const body =
      p === 'count'
        ? 'A loan is due today.'
        : l.direction === 'lent'
          ? `${name ?? `A ${typeNoun(l.type)} you lent`}${who ? ` (lent to ${who})` : ''} is due back today.`
          : `${name ?? `A ${typeNoun(l.type)} you borrowed`}${who ? ` (from ${who})` : ''} is due back today.`;
    out.push(
      mk(
        g,
        'getItBack',
        `getItBack:${l.loanId}:${l.dueDate}`,
        dueAt,
        endOfLocalDay(l.dueDate, g.tz),
        l.id,
        { scope: 'item', id: l.id },
        { title: 'Get it back', body, line: 'A loan is due' },
      ),
    );
  }
  // Weekly overdue digest (Sundays at the category time).
  const occ = lastOccurrence(g.now, g.tz, c.time, 'weekly', 0);
  const overdue = g.snapshot.loans.filter((l) => l.dueDate < today);
  if (occ && overdue.length > 0) {
    out.push(
      mk(
        g,
        'getItBack',
        `getItBack:overdue:${occ.date}`,
        occ.at,
        new Date(occ.at.getTime() + 12 * HOUR),
        null,
        { scope: 'category', id: 'getItBack' },
        {
          title: 'Overdue loans',
          body: `${plural(overdue.length, 'loan')} ${overdue.length === 1 ? 'is' : 'are'} overdue.`,
          line: `${plural(overdue.length, 'overdue loan')}`,
        },
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ 16 check-up / offline queue / auto rules */

function checkup(g: GenContext): Candidate[] {
  const c = g.settings.categories.checkup;
  const occ = occurrence(g, c);
  if (!occ) return [];
  const last = g.snapshot.lastCheckupAt ? Date.parse(g.snapshot.lastCheckupAt) : NaN;
  if (Number.isFinite(last) && occ.at.getTime() - last < Math.max(1, c.threshold) * DAY) return [];
  return [
    mk(
      g,
      'checkup',
      `checkup:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + DAY),
      null,
      { scope: 'category', id: 'checkup' },
      {
        title: 'Check my library',
        body: 'A quick check-up looks for problems in your library. It only reads — nothing changes unless you choose a fix.',
        line: 'Library check-up',
      },
    ),
  ];
}

function offlineQueue(g: GenContext): Candidate[] {
  const q = g.snapshot.offlineQueue;
  if (!q.finishedAt || q.count === 0) return [];
  const at = new Date(q.finishedAt);
  if (!Number.isFinite(at.getTime())) return [];
  return [
    mk(
      g,
      'offlineQueue',
      `offlineQueue:${q.finishedAt}`,
      at,
      new Date(at.getTime() + 6 * HOUR),
      null,
      { scope: 'category', id: 'offlineQueue' },
      {
        title: 'Details found',
        body: `${plural(q.count, 'item')} you added offline ${q.count === 1 ? 'has' : 'have'} details ready to review.`,
        line: `${plural(q.count, 'item')} ready to review`,
      },
    ),
  ];
}

function autoRules(g: GenContext): Candidate[] {
  const c = g.settings.categories.autoRules;
  const occ = occurrence(g, c);
  if (!occ || g.snapshot.autoRuleChanges === 0) return [];
  const n = g.snapshot.autoRuleChanges;
  return [
    mk(
      g,
      'autoRules',
      `autoRules:${occ.date}`,
      occ.at,
      new Date(occ.at.getTime() + 12 * HOUR),
      null,
      { scope: 'category', id: 'autoRules' },
      {
        title: 'Automatic changes',
        body: `${plural(n, 'item')} changed by your automatic rules today. Open Recent changes to review or undo.`,
        line: `${plural(n, 'automatic change')}`,
      },
    ),
  ];
}

export const GENERATORS: Record<NotificationCategory, (g: GenContext) => Candidate[]> = {
  custom,
  sessionRunning,
  releases,
  leavingSoon,
  getItBack,
  keepGoing,
  upNext,
  dailyTimeGoal,
  goalsPace,
  backup,
  pileHealth,
  weeklySummary,
  checkup,
  offlineQueue,
  autoRules,
};

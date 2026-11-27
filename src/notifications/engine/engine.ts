/**
 * The reminder engine: pure and deterministic (clock + zone injected).
 *
 * Pipeline, in order (docs/notifications.md, "How the engine decides"):
 *  1. mode off / global pause                          → nothing
 *  2. category enabled → category schedule/threshold   (generators)
 *  3. due + not expired + not yet claimed
 *  4. per-item / per-category / per-reminder mute and snooze
 *  5. quiet hours + allowed days: defer (held, not claimed) or drop (recorded)
 *  6. freshness: due long ago → "missed" (catch-up digest, ≤ 1, or recorded as missed)
 *  7. per-category daily cap, then global daily cap → overflow coalesced into one digest
 *  8. privacy-level text (already rendered by generators) + dedupe keys
 *
 * Claiming (exactly-once) happens in the runner against notify-state.sqlite.
 */
import {
  CATEGORY_LABELS,
  DROP_IN_QUIET,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '../../shared/notification-settings';
import { itemUrl, muteUrl, OPEN_URL, snoozeUrl } from '../protocol';
import { GENERATORS, type GenContext } from './categories';
import { cleanText, finish, MAX_BODY, plural } from './render';
import { quietUntil, startOfLocalDay } from './time';
import type {
  Candidate,
  EngineInput,
  EnginePlan,
  NotificationAction,
  PlannedNotification,
  RecordedSuppression,
} from './types';

const MIN = 60_000;
const PRIORITY = new Map<NotificationCategory, number>(NOTIFICATION_CATEGORIES.map((c, i) => [c, i]));

export const CATCH_UP_WINDOW_MS = 24 * 60 * MIN;

function byPriority(a: Candidate, b: Candidate): number {
  return (
    (PRIORITY.get(a.category) ?? 99) - (PRIORITY.get(b.category) ?? 99) ||
    a.dueAt.getTime() - b.dueAt.getTime() ||
    a.key.localeCompare(b.key)
  );
}

/** Short stable hash (FNV-1a) for digest keys. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function actionsFor(c: Candidate): NotificationAction[] {
  const out: NotificationAction[] = [
    { id: 'open', label: 'Open', url: c.itemId ? itemUrl(c.itemId) : OPEN_URL },
  ];
  if (c.target) {
    out.push({ id: 'snooze1h', label: 'Snooze 1 h', url: snoozeUrl(c.target, '1h') });
    out.push({ id: 'snoozeTomorrow', label: 'Tomorrow', url: snoozeUrl(c.target, 'tomorrow') });
    out.push({
      id: 'mute',
      label: c.target.scope === 'category' ? 'Turn off' : 'Mute',
      url: muteUrl(c.target),
    });
  }
  return out;
}

function single(c: Candidate): PlannedNotification {
  return {
    key: c.key,
    category: c.category,
    kind: 'single',
    title: c.title,
    body: c.body,
    itemId: c.itemId,
    urgency: c.category === 'custom' ? 'normal' : 'low',
    scheduledFor: c.dueAt.toISOString(),
    actions: actionsFor(c),
    memberKeys: [c.key],
    members: [{ key: c.key, category: c.category, itemId: c.itemId, scheduledFor: c.dueAt.toISOString() }],
    openUrl: c.itemId ? itemUrl(c.itemId) : OPEN_URL,
  };
}

function digest(
  kind: string,
  heading: string,
  members: Candidate[],
  date: string,
  label: string | null,
): PlannedNotification {
  const sorted = [...members].sort(byPriority);
  const keys = sorted.map((m) => m.key);
  const key = `digest:${kind}:${date}:${shortHash(keys.join('|'))}`;
  // Count-only members contribute no detail lines.
  const lines = sorted
    .map((m) => (m.privacy === 'count' ? null : m.line))
    .filter((l): l is string => l !== null);
  const shown: string[] = [];
  let len = 0;
  for (const l of lines) {
    const t = cleanText(l, 60);
    if (len + t.length + 3 > MAX_BODY - 20) break;
    shown.push(t);
    len += t.length + 3;
  }
  const rest = sorted.length - shown.length;
  const body =
    shown.length > 0
      ? `${shown.join(' · ')}${rest > 0 ? ` · ${rest} more` : ''}`
      : `${plural(sorted.length, 'reminder')} waiting.`;
  const text = finish(heading, body, label);
  const first = sorted[0];
  return {
    key,
    category: first?.category ?? 'custom',
    kind: 'digest',
    title: text.title,
    body: text.body,
    itemId: null,
    urgency: 'low',
    scheduledFor: (first?.dueAt ?? new Date(0)).toISOString(),
    actions: [{ id: 'open', label: 'Open', url: OPEN_URL }],
    memberKeys: [key, ...keys],
    members: sorted.map((m) => ({
      key: m.key,
      category: m.category,
      itemId: m.itemId,
      scheduledFor: m.dueAt.toISOString(),
    })),
    openUrl: OPEN_URL,
  };
}

function record(c: Candidate, reason: RecordedSuppression['reason']): RecordedSuppression {
  return { key: c.key, category: c.category, itemId: c.itemId, scheduledFor: c.dueAt.toISOString(), reason };
}

export function plan(input: EngineInput): EnginePlan {
  const { now, settings, state } = input;
  const tz = input.timeZone;
  const empty: EnginePlan = { deliver: [], record: [], deferred: 0, paused: false };
  if (settings.mode === 'off') return empty;
  const pause = state.snoozedUntil('global', '*');
  if (pause && pause.getTime() > now.getTime()) return { ...empty, paused: true };

  const g: GenContext = { now, tz, settings, snapshot: input.snapshot, state };
  const freshMs = Math.max(20, input.freshMinutes ?? Math.max(30, settings.intervalMinutes * 2 + 5)) * MIN;

  // 2–4: generate, then filter.
  const candidates: Candidate[] = [];
  for (const cat of NOTIFICATION_CATEGORIES) {
    if (!settings.categories[cat].enabled) continue;
    if (state.isMuted('category', cat)) continue;
    const snoozed = state.snoozedUntil('category', cat);
    if (snoozed && snoozed.getTime() > now.getTime()) continue;
    for (const c of GENERATORS[cat](g)) {
      if (c.dueAt.getTime() > now.getTime() || c.expiresAt.getTime() <= now.getTime()) continue;
      if (state.isClaimed(c.key)) continue;
      if (c.itemId && c.category !== 'custom') {
        if (state.isMuted('item', c.itemId)) continue;
        const s = state.snoozedUntil('item', c.itemId);
        if (s && s.getTime() > now.getTime()) continue;
      }
      candidates.push(c);
    }
  }
  candidates.sort(byPriority);

  // 5–6: quiet time and freshness.
  const recorded: RecordedSuppression[] = [];
  const quietNow = quietUntil(now, settings.quietHours, settings.allowedDays, tz);
  let deferred = 0;
  const fresh: Candidate[] = [];
  const afterQuiet: Candidate[] = [];
  const away: Candidate[] = [];
  for (const c of candidates) {
    if (quietNow) {
      if (DROP_IN_QUIET.has(c.category)) recorded.push(record(c, 'quiet_dropped'));
      else deferred++;
      continue;
    }
    const age = now.getTime() - c.dueAt.getTime();
    if (age <= freshMs) {
      fresh.push(c);
      continue;
    }
    const quietEnd = quietUntil(c.dueAt, settings.quietHours, settings.allowedDays, tz);
    if (quietEnd && quietEnd.getTime() <= now.getTime()) {
      if (DROP_IN_QUIET.has(c.category)) recorded.push(record(c, 'quiet_dropped'));
      else afterQuiet.push(c);
      continue;
    }
    if (settings.catchUp === 'catchUp' && age <= CATCH_UP_WINDOW_MS && !DROP_IN_QUIET.has(c.category))
      away.push(c);
    else recorded.push(record(c, 'missed'));
  }

  const label = input.snapshot.libraryLabel;
  const today = startOfLocalDay(now, tz);
  const dateKey = today.toISOString().slice(0, 10);
  const sent = state.deliveredSince(today);

  // 7a: per-category daily caps over the fresh set.
  const planned: { n: PlannedNotification; rank: number }[] = [];
  const byCat = new Map<NotificationCategory, Candidate[]>();
  for (const c of fresh) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
  for (const [cat, list] of byCat) {
    const remaining = settings.categories[cat].cap - (sent.byCategory[cat] ?? 0);
    if (remaining <= 0) {
      for (const c of list) recorded.push(record(c, 'capped'));
      continue;
    }
    if (list.length <= remaining) {
      for (const c of list) planned.push({ n: single(c), rank: PRIORITY.get(cat) ?? 99 });
    } else {
      const keep = list.slice(0, remaining - 1);
      for (const c of keep) planned.push({ n: single(c), rank: PRIORITY.get(cat) ?? 99 });
      planned.push({
        n: digest(cat, CATEGORY_LABELS[cat], list.slice(remaining - 1), dateKey, label),
        rank: PRIORITY.get(cat) ?? 99,
      });
    }
  }
  if (afterQuiet.length === 1 && afterQuiet[0]) planned.push({ n: single(afterQuiet[0]), rank: 50 });
  else if (afterQuiet.length > 1)
    planned.push({ n: digest('quiet', 'While quiet hours were on', afterQuiet, dateKey, label), rank: 50 });
  if (away.length === 1 && away[0]) planned.push({ n: single(away[0]), rank: 60 });
  else if (away.length > 1)
    planned.push({ n: digest('away', 'While you were away', away, dateKey, label), rank: 60 });
  planned.sort((a, b) => a.rank - b.rank || a.n.key.localeCompare(b.n.key));

  // 7b: global daily cap; the overflow becomes one digest.
  const remaining = settings.dailyCap - sent.total;
  let deliver = planned.map((p) => p.n);
  if (remaining <= 0) {
    for (const p of deliver) for (const m of p.members) recorded.push({ ...m, reason: 'capped' });
    deliver = [];
  } else if (deliver.length > remaining) {
    const keep = deliver.slice(0, remaining - 1);
    const overflow = deliver.slice(remaining - 1);
    const members: Candidate[] = overflow.flatMap((p) =>
      p.members.map((m) => ({
        key: m.key,
        category: m.category,
        dueAt: new Date(m.scheduledFor),
        expiresAt: new Date(m.scheduledFor),
        itemId: m.itemId,
        target: null,
        title: p.title,
        body: p.body,
        line: p.kind === 'digest' ? p.title : cleanText(p.body, 60),
        privacy: settings.privacy,
      })),
    );
    // Digest keys of coalesced digests are dropped; their members are re-coalesced.
    const flat = members.filter((m) => !m.key.startsWith('digest:'));
    deliver = [...keep, digest('more', 'More from Maybe Pile', flat, dateKey, label)];
  }
  return { deliver, record: recorded, deferred, paused: false };
}

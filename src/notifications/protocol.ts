/**
 * `maybepile://` URL protocol — strict allowlist (docs/security.md, "Protocol").
 *
 * Accepted forms (everything else is ignored):
 *   maybepile://item/<uuid>                         → open/focus the app at an item (navigation only)
 *   maybepile://open                                → open/focus the app
 *   maybepile://action/snooze?target=<t>&for=<d>    → silent: snooze in notify-state.sqlite
 *   maybepile://action/mute?target=<t>              → silent: mute in notify-state.sqlite
 *
 *   <t> = item:<uuid> | reminder:<uuid> | category:<known category>
 *   <d> = 1h | tomorrow
 *
 * Threat model: any web page or file can launch a registered protocol URL. The
 * worst a hostile URL can do is snooze or mute a reminder (only in the
 * notification state DB) or focus the app on an item. It can never delete,
 * export, reveal or change library data. Unknown parts are rejected, not
 * "best-effort" parsed.
 */
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../shared/notification-settings';

export const PROTOCOL_SCHEME = 'maybepile';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL = 300;

export type ActionTarget =
  | { scope: 'item'; id: string }
  | { scope: 'reminder'; id: string }
  | { scope: 'category'; id: NotificationCategory };

export type SnoozeDuration = '1h' | 'tomorrow';

export type ProtocolCommand =
  | { kind: 'open' }
  | { kind: 'item'; id: string }
  | { kind: 'snooze'; target: ActionTarget; duration: SnoozeDuration }
  | { kind: 'mute'; target: ActionTarget };

export function targetToString(t: ActionTarget): string {
  return `${t.scope}:${t.id}`;
}

export function parseTarget(s: string | null): ActionTarget | null {
  if (!s || s.length > 80) return null;
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  const scope = s.slice(0, idx);
  const id = s.slice(idx + 1);
  if ((scope === 'item' || scope === 'reminder') && UUID.test(id)) return { scope, id: id.toLowerCase() };
  if (scope === 'category' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(id))
    return { scope: 'category', id: id as NotificationCategory };
  return null;
}

/** Parses a protocol URL; returns null for anything not on the allowlist. Never throws. */
export function parseProtocolUrl(raw: unknown): ProtocolCommand | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s\\]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${PROTOCOL_SCHEME}:`) return null;
  if (u.username || u.password || u.port || u.hash) return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  const params = [...u.searchParams.keys()];
  const onlyParams = (allowed: string[]) =>
    params.every((k) => allowed.includes(k)) && new Set(params).size === params.length;

  if (host === 'open' && (path === '' || path === '/') && params.length === 0) return { kind: 'open' };
  if (host === 'item' && params.length === 0) {
    const id = path.replace(/^\//, '');
    return UUID.test(id) ? { kind: 'item', id: id.toLowerCase() } : null;
  }
  if (host === 'action') {
    if (path === '/snooze' && onlyParams(['target', 'for'])) {
      const target = parseTarget(u.searchParams.get('target'));
      const d = u.searchParams.get('for');
      if (!target || (d !== '1h' && d !== 'tomorrow')) return null;
      return { kind: 'snooze', target, duration: d };
    }
    if (path === '/mute' && onlyParams(['target'])) {
      const target = parseTarget(u.searchParams.get('target'));
      return target ? { kind: 'mute', target } : null;
    }
  }
  return null;
}

/** Finds the first protocol URL in a process argv (Windows/Linux pass it as an argument). */
export function findProtocolArg(argv: readonly string[]): string | null {
  for (const a of argv)
    if (typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL_SCHEME}://`)) return a;
  return null;
}

export const itemUrl = (id: string) => `${PROTOCOL_SCHEME}://item/${id}`;
export const snoozeUrl = (t: ActionTarget, d: SnoozeDuration) =>
  `${PROTOCOL_SCHEME}://action/snooze?target=${encodeURIComponent(targetToString(t))}&for=${d}`;
export const muteUrl = (t: ActionTarget) =>
  `${PROTOCOL_SCHEME}://action/mute?target=${encodeURIComponent(targetToString(t))}`;
export const OPEN_URL = `${PROTOCOL_SCHEME}://open`;

/**
 * Notification text rendering. Plain text only, length-capped, control
 * characters stripped. Channel-specific escaping (toast XML, GVariant) happens
 * in the adapters; this module guarantees the inputs are already sane.
 *
 * Rules: never notes, ratings, prices; adult-flagged titles always generic;
 * Spoiler Shield decides whether "next episode"/"next step" can appear.
 */
import type { PrivacyLevel } from '../../shared/notification-settings';
import type { SnapshotItem } from './types';

export const MAX_TITLE = 64;
export const MAX_BODY = 200;
export const MAX_ITEM_TITLE = 48;

/** Strips control chars + bidi overrides, collapses whitespace, caps length (with ellipsis). */
export function cleanText(s: string, max: number): string {
  const cleaned = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The item's title if this privacy level may show it, else null. */
export function itemName(item: SnapshotItem | null, privacy: PrivacyLevel): string | null {
  if (!item || privacy !== 'titles' || item.adult) return null;
  return cleanText(item.title, MAX_ITEM_TITLE);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function finish(title: string, body: string, label: string | null): { title: string; body: string } {
  const t = label ? `${label} · ${title}` : title;
  return { title: cleanText(t, MAX_TITLE), body: cleanText(body, MAX_BODY) };
}

const TYPE_NOUN: Record<string, string> = {
  movie: 'movie',
  tv: 'show',
  anime: 'anime',
  game: 'game',
  book: 'book',
};
export const typeNoun = (t: string) => TYPE_NOUN[t] ?? 'item';

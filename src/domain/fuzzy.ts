/**
 * Deterministic fuzzy matching for the command palette. Case- and
 * accent-insensitive subsequence match with bonuses for prefixes, word starts
 * and consecutive characters. Ties are broken by label, then id, so results
 * never jitter between keystrokes.
 */
import { foldText } from './normalize';

export function fuzzyScore(query: string, text: string): number | null {
  const q = foldText(query).replace(/\s+/g, ' ').trim();
  if (q === '') return 0;
  const t = foldText(text);
  if (t === q) return 10_000;
  if (t.startsWith(q)) return 5_000 - t.length;
  const idx = t.indexOf(q);
  if (idx !== -1) return 3_000 - idx * 10 - t.length + (idx === 0 || t[idx - 1] === ' ' ? 500 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 10;
    if (found === prev + 1) score += 15;
    if (found === 0 || t[found - 1] === ' ') score += 20;
    score -= Math.min(10, found - ti);
    prev = found;
    ti = found + 1;
  }
  return score - t.length * 0.1;
}

export interface Rankable {
  id: string;
  label: string;
  keywords?: string;
}

export function fuzzyRank<T extends Rankable>(query: string, items: readonly T[], limit = 50): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const a = fuzzyScore(query, item.label);
    const b = item.keywords ? fuzzyScore(query, item.keywords) : null;
    const s = a === null ? (b === null ? null : b - 50) : b === null ? a : Math.max(a, b - 50);
    if (s !== null) scored.push({ item, score: s });
  }
  scored.sort(
    (x, y) =>
      y.score - x.score || x.item.label.localeCompare(y.item.label) || (x.item.id < y.item.id ? -1 : 1),
  );
  return scored.slice(0, limit).map((s) => s.item);
}

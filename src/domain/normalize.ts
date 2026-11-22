/**
 * Normalization rules used for uniqueness, duplicate detection and sorting.
 * They are deliberately locale-independent so results are identical on every OS.
 */

/** Removes diacritics and case: "Pokémon" → "pokemon". */
export function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Tag normalization: trimmed, inner whitespace collapsed; uniqueness is case- and accent-insensitive. */
export function normalizeTagDisplay(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ');
}

export function tagKey(tag: string): string {
  return foldText(normalizeTagDisplay(tag));
}

/** De-duplicates tags by key, keeping the first spelling the user typed. */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const display = normalizeTagDisplay(raw);
    const key = tagKey(display);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out;
}

/**
 * Title key for duplicate detection: folded, leading English articles removed,
 * punctuation and whitespace collapsed. "The Witcher 3: Wild Hunt" → "witcher 3 wild hunt".
 */
export function titleKey(title: string): string {
  return foldText(title)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/** Sort key: like the title key but keeps digits padded so "Part 2" sorts before "Part 10". */
export function sortTitle(title: string): string {
  return titleKey(title).replace(/\d+/g, (d) => d.padStart(8, '0'));
}

/** Strips HTML tags/entities from provider text (e.g. TVmaze summaries) into plain text. */
export function htmlToPlainText(input: string): string {
  const withBreaks = input.replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  const decoded = stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
  return decoded
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Normalizes an ISBN by removing hyphens/spaces; returns null if invalid. */
export function normalizeIsbn(raw: string | null | undefined): {
  isbn10: string | null;
  isbn13: string | null;
} {
  const s = (raw ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s) && isbn10Valid(s)) return { isbn10: s, isbn13: null };
  if (/^\d{13}$/.test(s) && isbn13Valid(s)) return { isbn10: null, isbn13: s };
  return { isbn10: null, isbn13: null };
}

export function isbn10Valid(s: string): boolean {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i] ?? '0';
    sum += (c === 'X' ? 10 : Number(c)) * (10 - i);
  }
  return sum % 11 === 0;
}

export function isbn13Valid(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

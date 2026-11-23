/**
 * Manual "paste or upload a game list" source. Gives GOG / Xbox / PlayStation /
 * Epic / physical-collection users a legitimate path into the same review flow
 * without scraping or unofficial APIs.
 *
 * Accepted input:
 * - Plain text: one title per line (blank lines and lines starting with # are ignored).
 * - CSV/TSV with a header row containing a "title" (or "name") column and
 *   optionally a "platform" column.
 */
import { detectDelimiter, parseCsv, restoreFormula } from '../domain/csv';
import { titleKey } from '../domain/normalize';
import type { FetchedEntry } from '../domain/steam';
import type { LibrarySource } from './types';

export const MANUAL_MAX_LINES = 20_000;

export interface ManualConfig {
  text: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const clean = (s: string) => s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();

/** Stable id for a manual entry: normalized title + platform. */
export function manualEntryId(title: string, platform: string | null): string {
  return `m:${titleKey(title)}|${(platform ?? '').trim().toLowerCase()}`.slice(0, 200);
}

export function parseManualList(text: string): { entries: FetchedEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = (src.split(/\r?\n/, 1)[0] ?? '').toLowerCase();
  const delim = detectDelimiter(src);
  const looksTabular =
    /\b(title|name)\b/.test(firstLine) && firstLine.includes(delim === '\t' ? '\t' : delim);
  const out = new Map<string, FetchedEntry>();
  const add = (titleRaw: string, platformRaw: string | null) => {
    const title = clean(restoreFormula(titleRaw)).slice(0, 500);
    if (!title || title.startsWith('#')) return;
    const platform = platformRaw ? clean(restoreFormula(platformRaw)).slice(0, 80) || null : null;
    const id = manualEntryId(title, platform);
    if (out.has(id)) return;
    if (out.size >= MANUAL_MAX_LINES) return;
    out.set(id, { externalId: id, name: title, playtimeMinutes: null, lastPlayedAt: null, platform });
  };
  if (looksTabular) {
    let rows: string[][];
    try {
      rows = parseCsv(src, MANUAL_MAX_LINES + 1, delim);
    } catch (e) {
      warnings.push(`Could not read the table: ${e instanceof Error ? e.message : 'invalid CSV'}`);
      return { entries: [], warnings };
    }
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const ti = header.findIndex((h) => h === 'title' || h === 'name');
    const pi = header.findIndex((h) => h === 'platform' || h === 'system' || h === 'store');
    rows.slice(1).forEach((r) => add(r[ti] ?? '', pi === -1 ? null : (r[pi] ?? null)));
    if (rows.length - 1 > MANUAL_MAX_LINES)
      warnings.push(`Only the first ${MANUAL_MAX_LINES} rows were read.`);
  } else {
    const lines = src.split(/\r?\n/);
    if (lines.length > MANUAL_MAX_LINES) warnings.push(`Only the first ${MANUAL_MAX_LINES} lines were read.`);
    for (const line of lines.slice(0, MANUAL_MAX_LINES)) add(line, null);
  }
  return { entries: [...out.values()], warnings };
}

export const manualSource: LibrarySource<ManualConfig> = {
  id: 'manual',
  displayName: 'Pasted or uploaded game list',
  attribution: 'From a list you pasted or a file you chose. Nothing is fetched from the internet.',
  rateLimit: { text: 'No network access.' },
  configure(raw) {
    const text = raw['text'] ?? '';
    if (text.trim() === '')
      return { ok: false, fieldErrors: { text: 'Paste at least one title, or choose a file.' } };
    return { ok: true, config: { text } };
  },
  async testConnection(config) {
    const r = parseManualList(config.text);
    return { ok: true, message: `${r.entries.length} title(s) found.`, resolvedAccount: null };
  },
  async fetchEntries(config, ctx) {
    ctx.onProgress('Reading your list…', null);
    const r = parseManualList(config.text);
    ctx.onProgress('Done', 1);
    return { kind: 'ok', entries: r.entries, warnings: r.warnings, resolvedAccount: null };
  },
};

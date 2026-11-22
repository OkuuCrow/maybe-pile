/** Helpers shared by provider adapters: sanitizing untrusted provider data. */
import { z } from 'zod';
import type { MediaType } from '../shared/enums';
import {
  LIMITS,
  MetadataFieldsSchema,
  type Creator,
  type ExternalId,
  type MetadataFields,
} from '../shared/schemas';
import { checkExternalUrl } from '../domain/links';
import { emptyMeta, pruneMetaForType } from '../domain/metadata';
import { htmlToPlainText, truncate } from '../domain/normalize';
import { toPartialDate } from '../domain/dates';
import { externalIdError } from '../domain/links';

/** Loose string: tolerates null/missing/number and yields a trimmed string or null. */
export const looseString = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? null : String(v).trim() || null));

export const looseNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

/** Array that tolerates null/missing and drops elements failing `item`. */
export function looseArray<T extends z.ZodType>(item: T) {
  return z
    .union([z.array(z.unknown()), z.null()])
    .optional()
    .transform((arr) => {
      const out: z.infer<T>[] = [];
      for (const v of arr ?? []) {
        const r = item.safeParse(v);
        if (r.success) out.push(r.data);
      }
      return out;
    });
}

export function cleanText(s: string | null | undefined, max: number, html = false): string | null {
  if (!s) return null;
  const t = html ? htmlToPlainText(s) : s.trim();
  return t === '' ? null : truncate(t, max);
}

export function uniqueStrings(values: (string | null | undefined)[], max: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(truncate(t, maxLen));
    if (out.length >= max) break;
  }
  return out;
}

export function uniqueCreators(creators: Creator[], max = 30): Creator[] {
  const seen = new Set<string>();
  const out: Creator[] = [];
  for (const c of creators) {
    const name = c.name.trim();
    if (!name) continue;
    const k = `${c.role}:${name.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name: truncate(name, LIMITS.creatorName), role: c.role });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Builds validated metadata from partial provider data. Invalid fields are
 * dropped (set to empty) rather than failing the whole import; the result is
 * guaranteed to satisfy MetadataFieldsSchema or null is returned.
 */
export function finalizeMeta(
  type: MediaType,
  partial: Partial<MetadataFields> & { title: string },
): MetadataFields | null {
  const base = { ...emptyMeta(), ...partial };
  base.title = truncate(base.title.trim(), LIMITS.title);
  if (!base.title) return null;
  base.releaseDate = toPartialDate(base.releaseDate);
  base.lastAirDate = toPartialDate(base.lastAirDate);
  base.externalIds = base.externalIds.filter((e: ExternalId) => externalIdError(e) === null);
  base.altTitles = uniqueStrings(
    base.altTitles.filter((t) => t !== base.title),
    LIMITS.altTitles,
    LIMITS.title,
  );
  base.genres = uniqueStrings(base.genres, 20, LIMITS.genre);
  base.creators = uniqueCreators(base.creators);
  const intOrNull = (n: number | null, min: number, max: number) =>
    n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null;
  base.runtimeMinutes = intOrNull(base.runtimeMinutes, 1, 10_000);
  base.episodeRuntime = intOrNull(base.episodeRuntime, 1, 10_000);
  base.pageCount = intOrNull(base.pageCount, 1, 100_000);
  base.audioMinutes = intOrNull(base.audioMinutes, 1, 100_000);
  const pruned = pruneMetaForType(type, base);
  const r = MetadataFieldsSchema.safeParse(pruned);
  return r.success ? r.data : null;
}

/** Returns the URL only if it is https and its host is allowlisted. */
export function safeUrl(url: string | null | undefined, hosts: readonly string[]): string | null {
  if (!url) return null;
  const r = checkExternalUrl(url, hosts);
  return r.ok ? r.url : null;
}

export function yearFromDate(s: string | null | undefined): number | null {
  const p = toPartialDate(s ?? null);
  return p ? Number(p.slice(0, 4)) : null;
}

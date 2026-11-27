/**
 * Wikimedia Commons artwork via Wikidata (key-free). Read 2026-11-26:
 * - Extension:CommonsMetadata — each file's license comes from imageinfo
 *   `extmetadata` (LicenseShortName, LicenseUrl, Artist, Credit,
 *   AttributionRequired, Copyrighted); multi-licensed values can be unreliable.
 * - Wikimedia API usage guidelines: follow each file's content license when
 *   republishing/caching; no published numeric rate limit → we stay well
 *   under one request per second, sequentially.
 * - User-Agent policy: a descriptive UA with contact information is required
 *   (sent by the shared HTTP client from the main process).
 *
 * Only files hosted on Commons whose license is public domain / CC0 / CC BY /
 * CC BY-SA are offered; anything else (including missing license data) is
 * skipped. Wikipedia article images (mostly non-free fair use) are never used.
 * Attribution (author + license) is recorded with the image and shown.
 */
import { z } from 'zod';
import type { ArtworkSlot } from '../shared/enums';
import { requestJson } from './http';
import { cleanText, safeUrl } from './common';
import { idOf, type ArtCandidate, type ArtSource } from './art-types';

const WD = 'https://www.wikidata.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const HOSTS = ['upload.wikimedia.org'];

/** Wikidata property → artwork slot. */
const PROPS: [string, ArtworkSlot][] = [
  ['P3383', 'cover'], // film poster
  ['P154', 'logo'], // logo image
  ['P18', 'background'], // image (often a still or photo)
];

const ClaimsSchema = z.object({
  entities: z.record(
    z.string(),
    z.object({
      claims: z
        .record(
          z.string(),
          z.array(
            z.object({ mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).nullish() }) }),
          ),
        )
        .nullish(),
    }),
  ),
});

const Meta = z.object({ value: z.unknown() }).nullish();
const ImageInfoSchema = z.object({
  query: z
    .object({
      pages: z.record(
        z.string(),
        z.object({
          title: z.string().nullish(),
          imageinfo: z
            .array(
              z.object({
                url: z.string().nullish(),
                thumburl: z.string().nullish(),
                width: z.number().nullish(),
                height: z.number().nullish(),
                extmetadata: z.record(z.string(), Meta).nullish(),
              }),
            )
            .nullish(),
        }),
      ),
    })
    .nullish(),
});

const FREE = /^(public domain|pd(-|\s|$)|cc0|cc[- ]by(-sa)?[- ]\d(\.\d)?|cc[- ]by(-sa)?$)/i;

/** Pure: is this Commons license acceptable for display/caching with attribution? */
export function commonsLicenseOk(shortName: string | null): boolean {
  if (!shortName) return false;
  const s = shortName.trim();
  if (/fair use|non-free|nc|nd/i.test(s)) return false;
  return FREE.test(s);
}

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

export const commonsArtSource: ArtSource = {
  id: 'commons',
  displayName: 'Wikimedia Commons',
  supports: ['movie', 'tv', 'anime', 'game', 'book'],
  slots: ['cover', 'logo', 'background'],
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  termsNote:
    'No key needed. Only freely licensed files (public domain, CC0, CC BY, CC BY-SA) are offered, with author and license shown. Coverage is mostly older or openly licensed works.',
  attribution: {
    text: 'Images from Wikimedia Commons (see each image’s license).',
    url: 'https://commons.wikimedia.org/',
    required: true,
  },
  rateLimit: { maxRequests: 5, perMs: 10_000 },
  cachingPolicy: 'cache-allowed',
  hosts: HOSTS,
  isConfigured: () => true,

  async candidates(lookup, ctx) {
    const qid = idOf(lookup, 'wikidata');
    if (!qid || !/^Q\d{1,12}$/.test(qid)) return { kind: 'ok', value: [] };
    const sig = ctx.signal ? { signal: ctx.signal } : {};
    const claims = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: `${WD}?action=wbgetentities&ids=${qid}&props=claims&format=json`, ...sig },
      ClaimsSchema,
    );
    if (claims.kind === 'notFound') return { kind: 'ok', value: [] };
    if (claims.kind !== 'ok') return claims;
    const c = claims.value.entities[qid]?.claims ?? {};
    const files: { name: string; slot: ArtworkSlot }[] = [];
    for (const [prop, slot] of PROPS)
      for (const cl of (c[prop] ?? []).slice(0, 3)) {
        const name = str(cl.mainsnak.datavalue?.value);
        if (name && name.length <= 240 && !/[|#<>[\]{}]/.test(name)) files.push({ name, slot });
      }
    if (files.length === 0) return { kind: 'ok', value: [] };
    const titles = files.map((f) => `File:${f.name}`).join('|');
    const info = await requestJson(
      ctx.http,
      ctx.limiter,
      {
        url: `${COMMONS}?action=query&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=320&format=json&titles=${encodeURIComponent(titles)}`,
        ...sig,
      },
      ImageInfoSchema,
    );
    if (info.kind !== 'ok') return info.kind === 'notFound' ? { kind: 'ok', value: [] } : info;
    const out: ArtCandidate[] = [];
    for (const page of Object.values(info.value.query?.pages ?? {})) {
      const ii = page.imageinfo?.[0];
      const name = page.title?.replace(/^File:/, '') ?? '';
      const slot = files.find((f) => f.name.replace(/_/g, ' ') === name.replace(/_/g, ' '))?.slot;
      if (!ii || !slot) continue;
      const m = ii.extmetadata ?? {};
      const license = cleanText(str(m['LicenseShortName']?.value), 80, true);
      if (!commonsLicenseOk(license)) continue;
      const url = safeUrl(ii.url ?? null, HOSTS);
      if (!url || /\.svg$/i.test(url)) continue; // SVG is never accepted
      const artist = cleanText(str(m['Artist']?.value), 160, true);
      out.push({
        sourceId: 'commons',
        slot,
        url,
        thumbUrl: safeUrl(ii.thumburl ?? null, HOSTS) ?? url,
        width: ii.width ?? null,
        height: ii.height ?? null,
        language: null,
        attribution: `${artist ?? 'Unknown author'} · ${license} · Wikimedia Commons`,
        licenseNote: license,
        assetId: name.slice(0, 200),
        adult: false,
        score: slot === 'cover' ? 1 : 0,
      });
    }
    return { kind: 'ok', value: out };
  },
};

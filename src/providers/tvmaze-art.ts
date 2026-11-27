/**
 * TVmaze artwork (key-free). Terms read 2026-11-26 at https://www.tvmaze.com/api:
 * - no API key; "at least 20 calls every 10 seconds per IP" (429 → retry later);
 * - "Use of the TVmaze API is licensed by CC BY-SA"; attribution by linking
 *   back to TVmaze; hotlinking allowed and "Images can safely be cached
 *   indefinitely" → cache-allowed.
 * Matching is conservative: only a stored TVmaze id or an IMDb id lookup —
 * never a guessed title match.
 */
import { z } from 'zod';
import type { ArtworkSlot } from '../shared/enums';
import { requestJson } from './http';
import { looseArray, looseNumber, looseString, safeUrl } from './common';
import { idOf, type ArtCandidate, type ArtSource } from './art-types';

const API = 'https://api.tvmaze.com';
const HOSTS = ['static.tvmaze.com'];

const Res = z.object({ url: looseString, width: looseNumber, height: looseNumber }).nullish();
const ImagesSchema = looseArray(
  z.object({
    id: looseNumber,
    type: looseString,
    main: z.boolean().nullish(),
    resolutions: z.object({ original: Res, medium: Res }).nullish(),
  }),
);
const LookupSchema = z.object({ id: z.number().int() });

const SLOT: Record<string, ArtworkSlot> = {
  poster: 'cover',
  background: 'background',
  banner: 'banner',
  typography: 'logo',
};

export const tvmazeArtSource: ArtSource = {
  id: 'tvmaze-art',
  displayName: 'TVmaze',
  supports: ['tv'],
  slots: ['cover', 'background', 'banner', 'logo'],
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  termsNote: 'No key needed. TVmaze data is CC BY-SA; images may be cached. Credit: TVmaze.',
  attribution: { text: 'Artwork from TVmaze (CC BY-SA).', url: 'https://www.tvmaze.com/', required: true },
  rateLimit: { maxRequests: 18, perMs: 10_000 },
  cachingPolicy: 'cache-allowed',
  hosts: HOSTS,
  isConfigured: () => true,

  async candidates(lookup, ctx) {
    if (lookup.type !== 'tv') return { kind: 'ok', value: [] };
    const sig = ctx.signal ? { signal: ctx.signal } : {};
    let id = idOf(lookup, 'tvmaze');
    if (!id || !/^\d{1,9}$/.test(id)) {
      const imdb = idOf(lookup, 'imdb');
      if (!imdb || !/^tt\d{5,10}$/.test(imdb)) return { kind: 'ok', value: [] };
      const r = await requestJson(
        ctx.http,
        ctx.limiter,
        { url: `${API}/lookup/shows?imdb=${imdb}`, ...sig },
        LookupSchema,
      );
      if (r.kind === 'notFound') return { kind: 'ok', value: [] };
      if (r.kind !== 'ok') return r;
      id = String(r.value.id);
    }
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: `${API}/shows/${id}/images`, ...sig },
      ImagesSchema,
    );
    if (r.kind === 'notFound') return { kind: 'ok', value: [] };
    if (r.kind !== 'ok') return r;
    const out: ArtCandidate[] = [];
    for (const img of (r.value ?? []).slice(0, 60)) {
      const slot = SLOT[img.type ?? ''];
      const full = safeUrl(img.resolutions?.original?.url ?? null, HOSTS);
      if (!slot || !full) continue;
      out.push({
        sourceId: 'tvmaze-art',
        slot,
        url: full,
        thumbUrl: safeUrl(img.resolutions?.medium?.url ?? null, HOSTS) ?? full,
        width: img.resolutions?.original?.width ?? null,
        height: img.resolutions?.original?.height ?? null,
        language: null,
        attribution: 'TVmaze (CC BY-SA)',
        licenseNote: 'CC BY-SA via TVmaze',
        assetId: img.id === null || img.id === undefined ? null : String(img.id),
        adult: false,
        score: img.main ? 1 : 0,
      });
    }
    return { kind: 'ok', value: out };
  },
};

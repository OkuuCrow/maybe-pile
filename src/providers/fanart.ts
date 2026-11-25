/**
 * fanart.tv artwork (API v3). Docs read 2026-11-24 from the copy the user supplied.
 *
 * - Keys: a personal `client_key` and/or a project `api_key`, both supplied by
 *   the user (Maybe Pile does not ship an embedded project key). Keys are sent
 *   as `client-key` / `api-key` request headers, never in the URL, so they
 *   can't leak into logs or history.
 * - 429 → Retry-After is honoured by the shared client.
 * - Each image may carry a copyright credit, shown with the image.
 * - Gallery thumbnails use the documented `/preview/` URLs.
 * - Caching is not addressed and images carry third-party copyright, so
 *   fanart.tv artwork is remote-only (shown live, never stored).
 *
 * Coverage: movies by TMDB or IMDb id. TV endpoints need TheTVDB ids, which
 * Maybe Pile does not store, so TV/anime series are not offered (documented
 * limitation); anime *movies* with a TMDB `movie:` id are.
 */
import { z } from 'zod';
import type { ArtworkSlot } from '../shared/enums';
import { requestJson } from './http';
import { looseArray, looseNumber, looseString, safeUrl } from './common';
import { idOf, type ArtCandidate, type ArtSource } from './art-types';

const API = 'https://webservice.fanart.tv/v3';
const HOSTS = ['assets.fanart.tv'];

const Img = z.object({ id: looseString, url: looseString, lang: looseString, likes: looseNumber });
const MovieSchema = z.object({
  movieposter: looseArray(Img),
  moviebackground: looseArray(Img),
  hdmovielogo: looseArray(Img),
  moviebanner: looseArray(Img),
  copyright: looseString,
  copyright_link: looseString,
});

const SLOT_KEYS: [keyof z.infer<typeof MovieSchema>, ArtworkSlot][] = [
  ['movieposter', 'cover'],
  ['moviebackground', 'background'],
  ['hdmovielogo', 'logo'],
  ['moviebanner', 'banner'],
];

/** Documented preview path: /fanart/… → /preview/… on the same host. */
export function fanartPreview(url: string): string {
  return url.replace('://assets.fanart.tv/fanart/', '://assets.fanart.tv/preview/');
}

export const fanartSource: ArtSource = {
  id: 'fanart',
  displayName: 'fanart.tv',
  supports: ['movie', 'anime'],
  slots: ['cover', 'background', 'logo', 'banner'],
  requiresApiKey: true,
  keyFields: ['clientId', 'apiKey'],
  keyLabels: { clientId: 'Personal API key (client key)', apiKey: 'Project API key (optional)' },
  signupUrl: 'https://fanart.tv/get-an-api-key/',
  termsNote:
    'Uses your own fanart.tv personal key (client key) and/or project API key. Images are shown live from fanart.tv and never stored, because caching is not addressed in their docs.',
  attribution: { text: 'Artwork from fanart.tv.', url: 'https://fanart.tv/', required: true },
  rateLimit: { maxRequests: 20, perMs: 60_000 },
  cachingPolicy: 'remote-only',
  hosts: HOSTS,
  isConfigured: (k) =>
    Boolean((k.clientId && k.clientId.length >= 16) || (k.apiKey && k.apiKey.length >= 16)),

  async candidates(lookup, ctx) {
    if (!fanartSource.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    let id: string | null = null;
    if (lookup.type === 'movie') id = idOf(lookup, 'tmdb') ?? idOf(lookup, 'imdb');
    if (lookup.type === 'anime') {
      const m = /^movie:(\d+)$/.exec(idOf(lookup, 'tmdb') ?? '');
      id = m?.[1] ?? null;
    }
    if (!id || !/^(?:\d{1,12}|tt\d{5,10})$/.test(id)) return { kind: 'ok', value: [] };
    const headers: Record<string, string> = {};
    if (ctx.keys.apiKey) headers['api-key'] = ctx.keys.apiKey;
    if (ctx.keys.clientId) headers['client-key'] = ctx.keys.clientId;
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: `${API}/movies/${id}`, headers, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      MovieSchema,
    );
    if (r.kind === 'notFound') return { kind: 'ok', value: [] };
    if (r.kind !== 'ok') return r;
    const credit = r.value.copyright ? `© ${r.value.copyright.slice(0, 200)} via fanart.tv` : 'fanart.tv';
    const out: ArtCandidate[] = [];
    for (const [key, slot] of SLOT_KEYS) {
      const list = r.value[key];
      if (!Array.isArray(list)) continue;
      for (const img of list.slice(0, 30)) {
        const url = safeUrl(img.url, HOSTS);
        if (!url) continue;
        out.push({
          sourceId: 'fanart',
          slot,
          url,
          thumbUrl: safeUrl(fanartPreview(url), HOSTS) ?? url,
          width: null,
          height: null,
          language: img.lang && img.lang !== '00' ? img.lang.slice(0, 20) : null,
          attribution: credit,
          licenseNote: 'Remote only; copyright remains with the artist.',
          assetId: img.id,
          adult: false,
          score: img.likes,
        });
      }
    }
    return { kind: 'ok', value: out };
  },
};

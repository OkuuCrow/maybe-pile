/**
 * SteamGridDB artwork for games (API v2, OpenAPI spec v2.10.0 downloaded
 * 2026-11-24 from https://www.steamgriddb.com/static/openapi.yml).
 *
 * - Auth: `Authorization: Bearer <key>` using the user's own key (generated at
 *   steamgriddb.com/profile/preferences). Stored with safeStorage, never logged.
 * - Endpoints: /games/steam/{appId}, /search/autocomplete/{term},
 *   /grids|heroes|logos|icons/game/{gameId}.
 * - `nsfw`, `humor` and `epilepsy` filters default to excluding such images;
 *   we pass nsfw=false explicitly.
 * - Each image has an author, shown as attribution.
 * - The spec publishes no rate limits and the terms page is JS-only (could not
 *   be read), so: conservative client-side limit, remote-only images, and the
 *   image CDN allowlist is limited to steamgriddb.com hosts (anything else is
 *   rejected rather than assumed safe). See docs/providers.md.
 */
import { z } from 'zod';
import type { ArtworkSlot } from '../shared/enums';
import { titleKey } from '../domain/normalize';
import { requestJson } from './http';
import { looseArray, looseNumber, looseString, safeUrl } from './common';
import { idOf, type ArtCandidate, type ArtSource } from './art-types';
import type { ProviderContext } from './types';

const API = 'https://www.steamgriddb.com/api/v2';
const HOSTS = ['cdn2.steamgriddb.com', 'cdn.steamgriddb.com'];

const GameSchema = z.object({
  success: z.boolean().nullish(),
  data: z.object({ id: z.number().int() }).nullish(),
});
const SearchSchema = z.object({
  data: looseArray(
    z.object({
      id: z.number().int(),
      name: looseString,
      verified: z.boolean().nullish(),
      release_date: looseNumber,
    }),
  ),
});
const ImagesSchema = z.object({
  data: looseArray(
    z.object({
      id: z.number().int(),
      score: looseNumber,
      style: looseString,
      width: looseNumber,
      height: looseNumber,
      nsfw: z.boolean().nullish(),
      language: looseString,
      url: looseString,
      thumb: looseString,
      author: z.object({ name: looseString }).nullish(),
    }),
  ),
});

const KINDS: [string, ArtworkSlot][] = [
  ['grids', 'cover'],
  ['heroes', 'banner'],
  ['logos', 'logo'],
  ['icons', 'icon'],
];

function req(ctx: ProviderContext, url: string) {
  return {
    url,
    headers: { Authorization: `Bearer ${ctx.keys.apiKey ?? ''}` },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

export const steamGridDbSource: ArtSource = {
  id: 'steamgriddb',
  displayName: 'SteamGridDB',
  supports: ['game'],
  slots: ['cover', 'banner', 'logo', 'icon', 'background'],
  requiresApiKey: true,
  keyFields: ['apiKey'],
  signupUrl: 'https://www.steamgriddb.com/profile/preferences/api',
  termsNote:
    'Uses your own SteamGridDB API key. SteamGridDB publishes no rate limits we could read, so Maybe Pile keeps requests low and shows images live without storing them.',
  attribution: {
    text: 'Artwork from SteamGridDB (community uploads; authors credited).',
    url: 'https://www.steamgriddb.com/',
    required: true,
  },
  rateLimit: { maxRequests: 20, perMs: 60_000 },
  cachingPolicy: 'remote-only',
  hosts: HOSTS,
  isConfigured: (k) => Boolean(k.apiKey && /^[A-Za-z0-9]{16,64}$/.test(k.apiKey)),

  async candidates(lookup, ctx) {
    if (lookup.type !== 'game') return { kind: 'ok', value: [] };
    if (!steamGridDbSource.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    let gameId: number | null = null;
    const steam = idOf(lookup, 'steam');
    if (steam && /^\d{1,10}$/.test(steam)) {
      const g = await requestJson(ctx.http, ctx.limiter, req(ctx, `${API}/games/steam/${steam}`), GameSchema);
      if (g.kind === 'ok') gameId = g.value.data?.id ?? null;
      else if (g.kind !== 'notFound') return g;
    }
    if (gameId === null) {
      const s = await requestJson(
        ctx.http,
        ctx.limiter,
        req(ctx, `${API}/search/autocomplete/${encodeURIComponent(lookup.title.slice(0, 100))}`),
        SearchSchema,
      );
      if (s.kind === 'notFound') return { kind: 'ok', value: [] };
      if (s.kind !== 'ok') return s;
      // Exact (normalized) title only; never guess between several games.
      const key = titleKey(lookup.title);
      const exact = s.value.data.filter((g) => g.name && titleKey(g.name) === key);
      const pick =
        exact.length === 1
          ? exact[0]
          : lookup.year
            ? exact.find(
                (g) => g.release_date && new Date(g.release_date * 1000).getUTCFullYear() === lookup.year,
              )
            : undefined;
      if (!pick) return { kind: 'ok', value: [] };
      gameId = pick.id;
    }
    const out: ArtCandidate[] = [];
    for (const [kind, slot] of KINDS) {
      const r = await requestJson(
        ctx.http,
        ctx.limiter,
        req(ctx, `${API}/${kind}/game/${gameId}?nsfw=false`),
        ImagesSchema,
      );
      if (r.kind === 'notFound') continue;
      if (r.kind !== 'ok') return r;
      for (const img of r.value.data.slice(0, 40)) {
        if (img.nsfw === true) continue;
        const url = safeUrl(img.url, HOSTS);
        if (!url) continue;
        const candidate: ArtCandidate = {
          sourceId: 'steamgriddb',
          slot,
          url,
          thumbUrl: safeUrl(img.thumb, HOSTS) ?? url,
          width: img.width,
          height: img.height,
          language: img.language?.slice(0, 20) ?? null,
          attribution: img.author?.name
            ? `By ${img.author.name.slice(0, 100)} on SteamGridDB`
            : 'SteamGridDB',
          licenseNote: 'Community artwork; shown live, not stored.',
          assetId: String(img.id),
          adult: false,
          score: img.score,
        };
        out.push(candidate);
        // Heroes double as background art.
        if (slot === 'banner') out.push({ ...candidate, slot: 'background' });
      }
    }
    return { kind: 'ok', value: out };
  },
};

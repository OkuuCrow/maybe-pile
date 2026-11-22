/**
 * IGDB — video games, via Twitch client-credentials OAuth.
 * https://api-docs.igdb.com/  Rate limit: 4 requests/second per client.
 *
 * Store links come only from IGDB `external_games` records:
 *   source/category 1  = Steam  → uid is the Steam app id → https://store.steampowered.com/app/{uid}/
 *   source/category 11 = Microsoft (Xbox) → provider-supplied URL, host-allowlisted
 *   source/category 36 = PlayStation Store → provider-supplied URL, host-allowlisted
 * Nothing is inferred from titles. (`category` is the older field name;
 * `external_game_source` replaced it — both are accepted.)
 *
 * Caching policy: remote-only (artwork reference stored, proxied on demand).
 */
import { z } from 'zod';
import type { ExternalId } from '../shared/schemas';
import { requestJson } from './http';
import { cleanText, finalizeMeta, looseArray, looseNumber, looseString, safeUrl } from './common';
import type { MetadataProvider, ProviderContext, ProviderKeys, ProviderResult, SearchHit } from './types';
import { LINK_HOSTS, STEAM_APP_ID_RE } from '../domain/links';

const API = 'https://api.igdb.com/v4';
const IMG = 'https://images.igdb.com/igdb/image/upload';

const TokenSchema = z.object({ access_token: z.string().min(10), expires_in: z.number() });

const sourceId = z
  .union([z.number(), z.object({ id: z.number() })])
  .transform((v) => (typeof v === 'number' ? v : v.id));

const GameSchema = z.object({
  id: z.number().int(),
  name: looseString,
  summary: looseString,
  first_release_date: looseNumber,
  url: looseString,
  cover: z.object({ image_id: looseString }).nullish(),
  genres: looseArray(z.object({ name: looseString })),
  platforms: looseArray(z.object({ name: looseString })),
  alternative_names: looseArray(z.object({ name: looseString })),
  involved_companies: looseArray(
    z.object({
      company: z.object({ name: looseString }),
      developer: z.boolean().nullish(),
      publisher: z.boolean().nullish(),
    }),
  ),
  external_games: looseArray(
    z.object({
      category: sourceId.nullish(),
      external_game_source: sourceId.nullish(),
      uid: looseString,
      url: looseString,
    }),
  ),
});
const GamesSchema = looseArray(GameSchema);

/** Strips characters that could break out of an Apicalypse string literal. */
export function apicalypseString(s: string): string {
  return s
    .replace(/["\\;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

export function clearIgdbTokenCache(): void {
  tokens.clear();
}

async function getToken(ctx: ProviderContext): Promise<ProviderResult<string>> {
  const id = ctx.keys.clientId ?? '';
  const cached = tokens.get(id);
  if (cached && cached.expiresAt > ctx.limiter.now() + 60_000) return { kind: 'ok', value: cached.token };
  const params = new URLSearchParams({
    client_id: id,
    client_secret: ctx.keys.clientSecret ?? '',
    grant_type: 'client_credentials',
  });
  const r = await requestJson(
    ctx.http,
    ctx.limiter,
    {
      url: `https://id.twitch.tv/oauth2/token?${params.toString()}`,
      method: 'POST',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    TokenSchema,
  );
  if (r.kind !== 'ok') return r.kind === 'unavailable' && r.status === 400 ? { kind: 'unauthorized' } : r;
  tokens.set(id, { token: r.value.access_token, expiresAt: ctx.limiter.now() + r.value.expires_in * 1000 });
  return { kind: 'ok', value: r.value.access_token };
}

async function query(
  ctx: ProviderContext,
  body: string,
): Promise<ProviderResult<z.infer<typeof GamesSchema>>> {
  const t = await getToken(ctx);
  if (t.kind !== 'ok') return t;
  const r = await requestJson(
    ctx.http,
    ctx.limiter,
    {
      url: `${API}/games`,
      method: 'POST',
      headers: {
        'Client-ID': ctx.keys.clientId ?? '',
        Authorization: `Bearer ${t.value}`,
        'Content-Type': 'text/plain',
      },
      body,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    GamesSchema,
  );
  if (r.kind === 'unauthorized') tokens.delete(ctx.keys.clientId ?? '');
  return r;
}

const yearFromUnix = (s: number | null): number | null =>
  s !== null && s > 0 ? new Date(s * 1000).getUTCFullYear() : null;
const dateFromUnix = (s: number | null): string | null =>
  s !== null && s > 0 ? new Date(s * 1000).toISOString().slice(0, 10) : null;

export function storeIdsFromExternalGames(list: z.infer<typeof GameSchema>['external_games']): ExternalId[] {
  const out: ExternalId[] = [];
  for (const e of list) {
    const src = e.external_game_source ?? e.category ?? null;
    if (src === 1 && e.uid && STEAM_APP_ID_RE.test(e.uid) && !out.some((x) => x.kind === 'steam')) {
      out.push({ kind: 'steam', value: e.uid });
    } else if (src === 11 && !out.some((x) => x.kind === 'xbox')) {
      const url = safeUrl(e.url, LINK_HOSTS.xbox);
      if (url) out.push({ kind: 'xbox', value: url });
    } else if (src === 36 && !out.some((x) => x.kind === 'playstation')) {
      const url = safeUrl(e.url, LINK_HOSTS.playstation);
      if (url) out.push({ kind: 'playstation', value: url });
    }
  }
  return out;
}

export const igdbProvider: MetadataProvider = {
  id: 'igdb',
  displayName: 'IGDB',
  supports: ['game'],
  attribution: { text: 'Game data provided by IGDB.com.', url: 'https://www.igdb.com/', required: true },
  requiresApiKey: true,
  keyFields: ['clientId', 'clientSecret'],
  signupUrl: 'https://api-docs.igdb.com/#account-creation',
  rateLimit: { maxRequests: 4, perMs: 1_000 },
  cachingPolicy: 'remote-only',
  artworkHosts: ['images.igdb.com'],
  isConfigured: (keys: ProviderKeys) => Boolean(keys.clientId && keys.clientSecret),

  async search(q, ctx) {
    if (!this.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    const s = apicalypseString(q.query);
    if (!s) return { kind: 'ok', value: [] };
    const body = `search "${s}"; fields name,summary,first_release_date,cover.image_id,involved_companies.company.name,involved_companies.developer; limit 20;`;
    const r = await query(ctx, body);
    if (r.kind !== 'ok') return r;
    let hits = r.value.map<SearchHit>((g) => ({
      ref: { providerId: 'igdb', id: String(g.id), type: 'game' },
      title: g.name ?? '(untitled)',
      year: yearFromUnix(g.first_release_date),
      type: 'game',
      creators: g.involved_companies
        .filter((c) => c.developer)
        .map((c) => c.company.name ?? '')
        .filter(Boolean)
        .slice(0, 2),
      synopsis: cleanText(g.summary, 280),
      thumbUrl:
        g.cover?.image_id && /^[a-z0-9]+$/.test(g.cover.image_id)
          ? `${IMG}/t_cover_small/${g.cover.image_id}.jpg`
          : null,
    }));
    if (q.year) hits = [...hits.filter((h) => h.year === q.year), ...hits.filter((h) => h.year !== q.year)];
    return { kind: 'ok', value: hits };
  },

  async fetchDetails(ref, ctx) {
    if (!this.isConfigured(ctx.keys)) return { kind: 'notConfigured' };
    if (!/^\d+$/.test(ref.id)) return { kind: 'notFound' };
    const body = `fields name,summary,first_release_date,url,cover.image_id,genres.name,platforms.name,alternative_names.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,external_games.category,external_games.external_game_source,external_games.uid,external_games.url; where id = ${ref.id};`;
    const r = await query(ctx, body);
    if (r.kind !== 'ok') return r;
    const g = r.value[0];
    if (!g) return { kind: 'notFound' };
    const meta = finalizeMeta('game', {
      title: g.name ?? '',
      altTitles: g.alternative_names.map((a) => a.name ?? '').slice(0, 10),
      description: cleanText(g.summary, 20_000),
      releaseDate: dateFromUnix(g.first_release_date),
      genres: g.genres.map((x) => x.name ?? ''),
      creators: [
        ...g.involved_companies
          .filter((c) => c.developer)
          .map((c) => ({ name: c.company.name ?? '', role: 'developer' as const })),
        ...g.involved_companies
          .filter((c) => c.publisher)
          .map((c) => ({ name: c.company.name ?? '', role: 'publisher' as const })),
      ],
      externalIds: [{ kind: 'igdb', value: String(g.id) }, ...storeIdsFromExternalGames(g.external_games)],
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons: [],
        artworkUrl:
          g.cover?.image_id && /^[a-z0-9]+$/.test(g.cover.image_id)
            ? `${IMG}/t_cover_big/${g.cover.image_id}.jpg`
            : null,
        sourceUrl: safeUrl(g.url, ['www.igdb.com']),
      },
    };
  },
};

/** Platforms reported by IGDB, offered to the user as suggestions (they choose owned/played). */
export function igdbPlatforms(g: { platforms: { name: string | null }[] }): string[] {
  return g.platforms.map((p) => p.name ?? '').filter(Boolean);
}

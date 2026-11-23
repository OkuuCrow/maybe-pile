/**
 * Steam library source — documented Steam Web API only:
 *   ISteamUser/ResolveVanityURL/v1   (custom profile name → SteamID64)
 *   IPlayerService/GetOwnedGames/v1  (include_appinfo, include_played_free_games)
 *
 * The user's own key is passed as the documented `key` query parameter. It is
 * never logged (requests are not logged; the logger also redacts 32-hex keys),
 * never returned to the renderer and never exported.
 *
 * No store pages, no `appdetails`, no undocumented endpoints, no icon URLs
 * (the icon URL format is not documented by Valve). See docs/providers.md.
 */
import { z } from 'zod';
import type { UserSafeError } from '../shared/result';
import type { HttpClient } from '../providers/http';
import { requestJson } from '../providers/http';
import type { RateLimiter } from '../providers/rate-limiter';
import type { ProviderResult } from '../providers/types';
import { parseSteamAccount, STEAM_KEY_RE, type FetchedEntry } from '../domain/steam';
import type { FetchContext, LibrarySource, SourceFetchResult } from './types';

export const STEAM_API_HOST = 'api.steampowered.com';
const BASE = `https://${STEAM_API_HOST}`;

export interface SteamConfig {
  key: string;
  account: { kind: 'steamid'; steamId: string } | { kind: 'vanity'; vanity: string };
}

const VanitySchema = z.object({
  response: z.object({
    success: z.number(),
    steamid: z.string().optional(),
    message: z.string().optional(),
  }),
});

const OwnedSchema = z.object({
  response: z
    .object({
      game_count: z.number().optional(),
      games: z.array(z.unknown()).optional(),
    })
    .passthrough(),
});

const GameSchema = z.object({
  appid: z.number().int().positive().max(4_294_967_295),
  name: z.string().optional(),
  playtime_forever: z.number().min(0).optional(),
  rtime_last_played: z.number().min(0).optional(),
});

/** Retries for 429/5xx/timeouts: honours Retry-After up to this many seconds, then gives up. */
const MAX_RETRY_WAIT_S = 60;
const MAX_ATTEMPTS = 4;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const clean = (s: string) => s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

function errorFor(r: Exclude<ProviderResult<unknown>, { kind: 'ok' }>): UserSafeError {
  switch (r.kind) {
    case 'unauthorized':
      return {
        code: 'PROVIDER_UNAUTHORIZED',
        message: 'Steam rejected the API key.',
        recovery:
          'Check the key at steamcommunity.com/dev/apikey (it may have been revoked) and enter it again.',
        fieldErrors: { apiKey: 'Steam did not accept this key.' },
      };
    case 'rateLimited':
      return {
        code: 'PROVIDER_RATE_LIMITED',
        message: 'Steam is limiting requests right now.',
        recovery: `Wait about ${r.retryAfterSeconds} second(s) and try again. Your last snapshot is still available.`,
        retryAfterSeconds: r.retryAfterSeconds,
      };
    case 'timeout':
      return {
        code: 'PROVIDER_TIMEOUT',
        message: 'Steam did not answer in time.',
        recovery: 'Try again in a moment.',
      };
    case 'networkError':
      return r.detail === 'Cancelled.'
        ? { code: 'CANCELLED', message: 'Cancelled.' }
        : {
            code: 'PROVIDER_NETWORK',
            message: 'Could not reach Steam.',
            recovery: 'Check your internet connection and try again.',
          };
    case 'malformedResponse':
      return {
        code: 'PROVIDER_MALFORMED',
        message: 'Steam sent a response Maybe Pile could not read.',
        recovery: 'Try again later.',
      };
    case 'notFound':
      return { code: 'PROVIDER_NOT_FOUND', message: 'Steam could not find that account.' };
    case 'unavailable':
      return {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Steam is temporarily unavailable.',
        recovery: 'Try again later.',
      };
    default:
      return { code: 'INTERNAL', message: 'Steam request failed.' };
  }
}

export function createSteamSource(http: HttpClient, limiter: RateLimiter): LibrarySource<SteamConfig> {
  async function call<S extends z.ZodType>(url: string, schema: S, ctx: FetchContext, what: string) {
    let last: Exclude<ProviderResult<unknown>, { kind: 'ok' }> | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (ctx.signal.aborted) return { kind: 'networkError', detail: 'Cancelled.' } as const;
      const r = await requestJson(
        http,
        limiter,
        { url, signal: ctx.signal, timeoutMs: 20_000, maxBytes: 30 * 1024 * 1024 },
        schema,
      );
      if (r.kind === 'ok') return r;
      last = r;
      let waitS: number | null = null;
      if (r.kind === 'rateLimited' && r.retryAfterSeconds <= MAX_RETRY_WAIT_S) waitS = r.retryAfterSeconds;
      else if ((r.kind === 'unavailable' && (r.status ?? 0) >= 500) || r.kind === 'timeout')
        waitS = 2 ** attempt;
      if (waitS === null || attempt === MAX_ATTEMPTS) return r;
      ctx.onProgress(
        `${what}: Steam asked us to wait — retrying in ${waitS}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})…`,
        null,
      );
      await ctx.sleep(waitS * 1000);
    }
    return last ?? ({ kind: 'unavailable', status: 0 } as const);
  }

  async function resolve(
    config: SteamConfig,
    ctx: FetchContext,
  ): Promise<{ ok: true; steamId: string } | { ok: false; error: UserSafeError }> {
    if (config.account.kind === 'steamid') return { ok: true, steamId: config.account.steamId };
    ctx.onProgress('Resolving your custom profile name…', null);
    const url = `${BASE}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(config.key)}&vanityurl=${encodeURIComponent(config.account.vanity)}&url_type=1`;
    const r = await call(url, VanitySchema, ctx, 'Resolving profile');
    if (r.kind !== 'ok') return { ok: false, error: errorFor(r) };
    const id = r.value.response.steamid;
    if (r.value.response.success !== 1 || !id || !/^7656119\d{10}$/.test(id)) {
      return {
        ok: false,
        error: {
          code: 'PROVIDER_NOT_FOUND',
          message: `Steam has no profile with the custom name “${config.account.vanity}”.`,
          recovery:
            'Check the name in your profile URL (steamcommunity.com/id/<name>), or paste your SteamID64 instead.',
          fieldErrors: { account: 'No Steam profile has this custom name.' },
        },
      };
    }
    return { ok: true, steamId: id };
  }

  function ownedUrl(key: string, steamId: string): string {
    return `${BASE}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;
  }

  async function fetchOwned(config: SteamConfig, ctx: FetchContext): Promise<SourceFetchResult> {
    const who = await resolve(config, ctx);
    if (!who.ok) return { kind: 'error', error: who.error };
    ctx.onProgress('Loading your Steam library…', null);
    const r = await call(ownedUrl(config.key, who.steamId), OwnedSchema, ctx, 'Loading library');
    if (r.kind !== 'ok') return { kind: 'error', error: errorFor(r) };
    const resp = r.value.response;
    // Private profiles / private game details: Steam answers 200 with an empty `response`.
    if (resp.game_count === undefined && resp.games === undefined)
      return { kind: 'private', resolvedAccount: who.steamId };
    const raw = resp.games ?? [];
    const warnings: string[] = [];
    const byId = new Map<string, FetchedEntry>();
    let skipped = 0;
    let dupes = 0;
    raw.forEach((g, i) => {
      if (i % 500 === 0) ctx.onProgress(`Reading ${raw.length} games…`, raw.length ? i / raw.length : null);
      const p = GameSchema.safeParse(g);
      if (!p.success) {
        skipped++;
        return;
      }
      const id = String(p.data.appid);
      const name = clean(p.data.name ?? '') || `Steam app ${id}`;
      const entry: FetchedEntry = {
        externalId: id,
        name,
        playtimeMinutes: Math.round(p.data.playtime_forever ?? 0),
        lastPlayedAt:
          p.data.rtime_last_played && p.data.rtime_last_played > 0
            ? new Date(p.data.rtime_last_played * 1000).toISOString()
            : null,
        platform: 'PC (Steam)',
      };
      const prev = byId.get(id);
      if (prev) {
        dupes++;
        if ((entry.playtimeMinutes ?? 0) > (prev.playtimeMinutes ?? 0)) byId.set(id, entry);
      } else byId.set(id, entry);
    });
    if (skipped > 0)
      warnings.push(`${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} unreadable and skipped.`);
    if (dupes > 0) warnings.push(`${dupes} duplicate app id(s) were merged.`);
    ctx.onProgress('Done', 1);
    return { kind: 'ok', entries: [...byId.values()], warnings, resolvedAccount: who.steamId };
  }

  return {
    id: 'steam',
    displayName: 'Steam',
    attribution:
      'Data from the Steam Web API using your own key. Maybe Pile is not affiliated with or endorsed by Valve or Steam.',
    rateLimit: { text: 'Steam allows 100,000 Web API calls per day per key; a sync uses 1–2 calls.' },
    configure(raw) {
      const fieldErrors: Record<string, string> = {};
      const key = (raw['apiKey'] ?? '').trim();
      if (!STEAM_KEY_RE.test(key))
        fieldErrors['apiKey'] = key
          ? 'A Steam Web API key is 32 letters and digits (0–9, A–F).'
          : 'Enter your Steam Web API key.';
      const acct = parseSteamAccount(raw['account'] ?? '');
      if (!acct.ok) fieldErrors['account'] = acct.message;
      if (Object.keys(fieldErrors).length > 0 || !acct.ok) return { ok: false, fieldErrors };
      return {
        ok: true,
        config: {
          key,
          account:
            acct.kind === 'steamid'
              ? { kind: 'steamid', steamId: acct.steamId }
              : { kind: 'vanity', vanity: acct.vanity },
        },
      };
    },
    async testConnection(config, ctx) {
      // One lightweight call: resolving a vanity name proves the key; for a SteamID we load the library
      // (there is no cheaper documented call that also proves game details are visible).
      const r = await fetchOwned(config, ctx);
      if (r.kind === 'error') return { ok: false, error: r.error };
      if (r.kind === 'private') return { ok: false, error: privateError() };
      return {
        ok: true,
        message: `Connected. Steam lists ${r.entries.length} game(s) for this account.`,
        resolvedAccount: r.resolvedAccount,
      };
    },
    fetchEntries: fetchOwned,
  };
}

export function privateError(): UserSafeError {
  return {
    code: 'FORBIDDEN',
    message: 'Steam returned no games because this profile’s game details are private.',
    recovery:
      'On Steam open Profile → Edit Profile → Privacy Settings and set “Game details” to Public (your profile must be Public too). Try again a few minutes later — you can set it back to Private after importing.',
  };
}

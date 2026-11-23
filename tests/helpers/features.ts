import { decodeText } from '../../src/main/ipc/handlers';
import { ArtworkService, passthroughProcessor } from '../../src/main/services/artwork-service';
import { createFeatureServices, type FeatureServices } from '../../src/main/services/feature-services';
import { ProviderService } from '../../src/main/services/provider-service';
import { SecretsService } from '../../src/main/services/secrets-service';
import { RateLimiter } from '../../src/providers/rate-limiter';
import { FakeHttp, instantLimiter, json } from './http';
import { makeEnv, type TestEnv } from './services';

export const STEAM_KEY = '0123456789ABCDEF0123456789ABCDEF';
export const STEAM_ID = '76561197960287930';

export interface FeatureEnv extends TestEnv {
  http: FakeHttp;
  secrets: SecretsService;
  providers: ProviderService;
  f: FeatureServices;
  sleeps: number[];
}

export function makeFeatureEnv(): FeatureEnv {
  const env = makeEnv();
  const http = new FakeHttp();
  const secrets = new SecretsService(
    env.ctx.paths.secrets,
    {
      isEncryptionAvailable: () => true,
      encrypt: (s) => Buffer.from(`enc:${s}`),
      decrypt: (b) => b.toString().slice(4),
    },
    env.log,
    {},
  );
  const artwork = new ArtworkService(env.ctx, passthroughProcessor, http);
  const providers = new ProviderService(env.ctx, http, secrets, env.library, artwork, () => instantLimiter());
  const sleeps: number[] = [];
  // One fake clock shared by the Steam limiter and the retry sleep, so Retry-After waits "pass".
  let t = 1_000_000;
  const steamLimiter = new RateLimiter({
    maxRequests: 1000,
    perMs: 1000,
    now: () => t,
    sleep: async (ms) => void (t += ms),
  });
  const f = createFeatureServices(env.ctx, {
    library: env.library,
    providers,
    secrets,
    http,
    decodeText,
    steamLimiter,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    timeZone: 'UTC',
  });
  return Object.assign(env, { http, secrets, providers, f, sleeps });
}

export interface SteamGame {
  appid: number;
  name?: string;
  playtime_forever?: number;
  rtime_last_played?: number;
}

export function steamRoutes(
  http: FakeHttp,
  games: SteamGame[] | 'private',
  vanity: Record<string, string> = { gaben: STEAM_ID },
) {
  http.on('ResolveVanityURL', (req) => {
    const name = new URL(req.url).searchParams.get('vanityurl') ?? '';
    const id = vanity[name];
    return json({ response: id ? { success: 1, steamid: id } : { success: 42, message: 'No match' } });
  });
  http.on('GetOwnedGames', () =>
    json({ response: games === 'private' ? {} : { game_count: games.length, games } }),
  );
}

/** Configures a Steam source (key + account) and returns its id. */
export function addSteamSource(env: FeatureEnv, account = STEAM_ID): string {
  const list = env.f.sources.saveSteam({ sourceId: null, label: 'Steam', account, apiKey: STEAM_KEY });
  const s = list.find((x) => x.kind === 'steam');
  if (!s) throw new Error('no steam source');
  return s.id;
}

export async function syncSteam(env: FeatureEnv, sourceId: string) {
  const job = env.f.sources.startFetch(sourceId);
  return env.f.sources.waitFor(job.jobId);
}

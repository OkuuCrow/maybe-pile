/**
 * Metadata provider contract. Providers are pure adapters: they turn a
 * documented API's JSON into validated `MetadataFields`. They never touch the
 * database, filesystem or UI, so they can be added, replaced or disabled
 * without changing anything else (see docs/providers.md, "How to add a provider").
 */
import type { ExternalIdKind, MediaType, RelationInput } from '../shared/enums';
import type { MetadataFields, ProviderRef, SeasonInput } from '../shared/schemas';
import type { UserSafeError } from '../shared/result';
import type { HttpClient } from './http';
import type { RateLimiter } from './rate-limiter';

export type ProviderResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'rateLimited'; retryAfterSeconds: number }
  | { kind: 'unauthorized' }
  | { kind: 'notFound' }
  | { kind: 'networkError'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'malformedResponse'; detail: string }
  | { kind: 'unavailable'; status?: number }
  | { kind: 'notConfigured' };

export interface ProviderKeys {
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface ProviderContext {
  http: HttpClient;
  limiter: RateLimiter;
  keys: ProviderKeys;
  region: string;
  signal?: AbortSignal;
}

export interface SearchQuery {
  type: MediaType;
  query: string;
  year: number | null;
  /** Adult titles are excluded unless the user opted in (Settings → Content). */
  includeAdult?: boolean;
}

export interface SearchHit {
  ref: ProviderRef;
  title: string;
  year: number | null;
  type: MediaType;
  creators: string[];
  synopsis: string | null;
  thumbUrl: string | null;
  /** Cross-provider ids (anime): used to de-duplicate "All sources" results. */
  crossIds?: Partial<Record<ExternalIdKind, string>>;
  adult?: boolean;
}

/** A related title reported by the provider (becomes a franchise *suggestion*, never auto-applied). */
export interface ProviderRelation {
  relation: RelationInput | 'adapted_as';
  ref: ProviderRef;
  title: string;
  year: number | null;
}

/** A where-to-watch link the provider documents (never a guessed URL). */
export interface ProviderStreamingLink {
  service: string;
  url: string;
  subs: string[];
  dubs: string[];
}

export interface ProviderItem {
  ref: ProviderRef;
  meta: MetadataFields;
  seasons: SeasonInput[];
  artworkUrl: string | null;
  sourceUrl: string | null;
  /** Optional extras (anime providers). */
  relations?: ProviderRelation[];
  streaming?: ProviderStreamingLink[];
  /** Extra provider artwork, e.g. AniList/Kitsu banners. */
  extraArt?: { slot: 'banner' | 'background'; url: string }[];
}

export interface WatchProviders {
  link: string | null;
  providers: { name: string; kind: 'stream' | 'rent' | 'buy' | 'free' | 'ads' }[];
}

export interface MetadataProvider {
  id: string;
  displayName: string;
  supports: MediaType[];
  attribution: { text: string; url: string; required: boolean };
  requiresApiKey: boolean;
  keyFields: ('apiKey' | 'clientId' | 'clientSecret')[];
  signupUrl: string | null;
  /** Off until the user turns it on (e.g. terms concerns). Defaults to true. */
  enabledByDefault?: boolean;
  /** Plain-language terms caveat shown in Settings → Providers. */
  termsNote?: string | null;
  rateLimit: { maxRequests: number; perMs: number; maxWaitMs?: number };
  /** Whether artwork may be stored locally (per provider terms; see docs/providers.md). */
  cachingPolicy: 'cache-allowed' | 'remote-only';
  /** Hosts artwork URLs may come from (checked before download/proxy). */
  artworkHosts: string[];
  isConfigured(keys: ProviderKeys): boolean;
  search(query: SearchQuery, ctx: ProviderContext): Promise<ProviderResult<SearchHit[]>>;
  fetchDetails(ref: ProviderRef, ctx: ProviderContext): Promise<ProviderResult<ProviderItem>>;
  discoverLinks?(
    ref: ProviderRef,
    region: string,
    ctx: ProviderContext,
  ): Promise<ProviderResult<WatchProviders>>;
}

export function toUserSafeError(
  r: Exclude<ProviderResult<unknown>, { kind: 'ok' }>,
  providerName: string,
): UserSafeError {
  switch (r.kind) {
    case 'rateLimited':
      return {
        code: 'PROVIDER_RATE_LIMITED',
        message: `${providerName} is limiting requests right now.`,
        recovery: `Try again in about ${r.retryAfterSeconds} second(s).`,
        retryAfterSeconds: r.retryAfterSeconds,
      };
    case 'unauthorized':
      return {
        code: 'PROVIDER_UNAUTHORIZED',
        message: `${providerName} rejected the API credentials.`,
        recovery: 'Check the key in Settings → Providers.',
      };
    case 'notFound':
      return {
        code: 'PROVIDER_NOT_FOUND',
        message: `${providerName} has no record for that title any more.`,
        recovery: 'Search again or enter details manually.',
      };
    case 'networkError':
      return {
        code: 'PROVIDER_NETWORK',
        message: `Couldn't reach ${providerName}.`,
        recovery: 'Check your internet connection. Your library is unaffected and works offline.',
      };
    case 'timeout':
      return {
        code: 'PROVIDER_TIMEOUT',
        message: `${providerName} took too long to respond.`,
        recovery: 'Try again in a moment.',
      };
    case 'malformedResponse':
      return {
        code: 'PROVIDER_MALFORMED',
        message: `${providerName} sent a response Maybe Pile couldn't understand.`,
        recovery: 'Try again later or enter details manually.',
      };
    case 'unavailable':
      return {
        code: 'PROVIDER_UNAVAILABLE',
        message: `${providerName} is unavailable right now.`,
        recovery: 'Try again later or enter details manually.',
      };
    case 'notConfigured':
      return {
        code: 'PROVIDER_NOT_CONFIGURED',
        message: `${providerName} needs an API key before it can be used.`,
        recovery: 'Add a key in Settings → Providers, or add the item manually.',
      };
  }
}

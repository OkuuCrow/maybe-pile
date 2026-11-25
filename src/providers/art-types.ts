/**
 * Artwork source contract (Artwork Picker). Like metadata providers, art
 * sources are pure adapters over documented APIs: they return candidate image
 * URLs (validated against `hosts`) and never download, store or render.
 * Downloads happen only in main (ArtworkService) with the image-safety rules
 * in docs/security.md.
 */
import type { ArtworkSlot, MediaType } from '../shared/enums';
import type { ExternalId } from '../shared/schemas';
import type { ProviderContext, ProviderKeys, ProviderResult } from './types';

export interface ArtLookup {
  type: MediaType;
  title: string;
  year: number | null;
  externalIds: ExternalId[];
}

export interface ArtCandidate {
  sourceId: string;
  slot: ArtworkSlot;
  /** Full-size image (https, allowlisted host). */
  url: string;
  /** Small preview used in the gallery (documented preview size where available). */
  thumbUrl: string;
  width: number | null;
  height: number | null;
  language: string | null;
  /** Per-image credit (e.g. SteamGridDB author, fanart.tv copyright), shown with the image. */
  attribution: string | null;
  licenseNote: string | null;
  /** Provider's own asset id, for de-duplication and provenance. */
  assetId: string | null;
  adult: boolean;
  /** Community score/likes when the source provides one (used to rank). */
  score: number | null;
}

export interface ArtSource {
  id: string;
  displayName: string;
  supports: MediaType[];
  slots: ArtworkSlot[];
  requiresApiKey: boolean;
  keyFields: ('apiKey' | 'clientId')[];
  keyLabels?: Partial<Record<'apiKey' | 'clientId', string>>;
  signupUrl: string | null;
  termsNote: string | null;
  attribution: { text: string; url: string; required: boolean };
  rateLimit: { maxRequests: number; perMs: number };
  cachingPolicy: 'cache-allowed' | 'remote-only';
  hosts: string[];
  isConfigured(keys: ProviderKeys): boolean;
  candidates(lookup: ArtLookup, ctx: ProviderContext): Promise<ProviderResult<ArtCandidate[]>>;
}

export const idOf = (l: ArtLookup, kind: ExternalId['kind']): string | null =>
  l.externalIds.find((e) => e.kind === kind)?.value ?? null;

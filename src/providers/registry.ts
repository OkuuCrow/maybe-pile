/** The list of available metadata providers, in display order. */
import { igdbProvider } from './igdb';
import { openLibraryProvider } from './openlibrary';
import { tmdbProvider } from './tmdb';
import { tvmazeProvider } from './tvmaze';
import type { MetadataProvider } from './types';

export const PROVIDERS: readonly MetadataProvider[] = [
  tmdbProvider,
  tvmazeProvider,
  igdbProvider,
  openLibraryProvider,
];

export function getProvider(id: string): MetadataProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Every host the app may contact for provider artwork. */
export const ARTWORK_HOSTS: ReadonlySet<string> = new Set(PROVIDERS.flatMap((p) => p.artworkHosts));

/** Every outbound host (documented in docs/security.md "Network"). */
export const OUTBOUND_HOSTS = [
  'api.themoviedb.org',
  'image.tmdb.org',
  'api.tvmaze.com',
  'static.tvmaze.com',
  'openlibrary.org',
  'covers.openlibrary.org',
  'id.twitch.tv',
  'api.igdb.com',
  'images.igdb.com',
] as const;

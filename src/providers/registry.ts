/** The list of available metadata providers, in display order. */
import { anilistProvider } from './anilist';
import { igdbProvider } from './igdb';
import { openLibraryProvider } from './openlibrary';
import { tmdbProvider } from './tmdb';
import { tvmazeProvider } from './tvmaze';
import type { MetadataProvider } from './types';
import { wikidataProvider } from './wikidata';

export const PROVIDERS: readonly MetadataProvider[] = [
  // Order matters: the Add dialog defaults to the first ready (keyless or configured) source per type.
  tmdbProvider,
  tvmazeProvider,
  openLibraryProvider,
  wikidataProvider,
  anilistProvider,
  igdbProvider,
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
  'www.wikidata.org',
  'graphql.anilist.co',
  's4.anilist.co',
] as const;

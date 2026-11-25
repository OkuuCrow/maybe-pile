/** The list of available metadata providers, in display order. */
import { anilistProvider } from './anilist';
import { igdbProvider } from './igdb';
import { jikanProvider } from './jikan';
import { kitsuProvider } from './kitsu';
import { malProvider } from './mal';
import { openLibraryProvider } from './openlibrary';
import { tmdbProvider } from './tmdb';
import { tvmazeProvider } from './tvmaze';
import type { MetadataProvider } from './types';
import { ART_SOURCE_HOSTS } from './art-registry';
import { wikidataProvider } from './wikidata';

export const PROVIDERS: readonly MetadataProvider[] = [
  // Order matters: the Add dialog defaults to the first ready (keyless or configured) source per type.
  tmdbProvider,
  tvmazeProvider,
  openLibraryProvider,
  wikidataProvider,
  // Anime: Kitsu (official, keyless) is the default; MAL needs the user's client id;
  // AniList and Jikan are opt-in because of terms concerns (docs/providers.md).
  kitsuProvider,
  malProvider,
  anilistProvider,
  jikanProvider,
  igdbProvider,
];

export function getProvider(id: string): MetadataProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Every host the app may contact for provider artwork. */
export const ARTWORK_HOSTS: ReadonlySet<string> = new Set([
  ...PROVIDERS.flatMap((p) => p.artworkHosts),
  ...ART_SOURCE_HOSTS,
]);

/**
 * Hosts an image fetch may be redirected to (besides the same host). Open
 * Library covers redirect to archive.org storage by design (verified
 * 2026-11-24: covers.openlibrary.org → archive.org → iaNNNN.us.archive.org).
 * No other cross-host redirect is followed.
 */
export const ARTWORK_REDIRECT_HOSTS: readonly string[] = ['archive.org', '*.us.archive.org'];

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
  // Library sources (1.2): Steam Web API, called only with the user's own key.
  'api.steampowered.com',
  // Expansion Pack 2: anime sources.
  'kitsu.io',
  'media.kitsu.io',
  'media.kitsu.app',
  'api.myanimelist.net',
  'api.jikan.moe',
  'cdn.myanimelist.net',
  'api-cdn.myanimelist.net',
  // Expansion Pack 2: artwork sources (user keys only).
  'webservice.fanart.tv',
  'assets.fanart.tv',
  'www.steamgriddb.com',
  'cdn2.steamgriddb.com',
  'cdn.steamgriddb.com',
  // Open Library cover redirects (see ARTWORK_REDIRECT_HOSTS).
  'archive.org',
  '*.us.archive.org',
] as const;

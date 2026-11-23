/** Enumerations shared by every layer. Database CHECK constraints mirror these lists. */

export const MEDIA_TYPES = ['movie', 'tv', 'game', 'book'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const STATUSES = ['planned', 'in_progress', 'completed', 'on_hold', 'dropped'] as const;
export type Status = (typeof STATUSES)[number];

export const CREATOR_ROLES = [
  'director',
  'writer',
  'cast',
  'creator',
  'developer',
  'publisher',
  'author',
  'translator',
  'narrator',
  'illustrator',
] as const;
export type CreatorRole = (typeof CREATOR_ROLES)[number];

/** Roles offered by default in the editor for each type (all roles remain valid). */
export const ROLES_BY_TYPE: Record<MediaType, readonly CreatorRole[]> = {
  movie: ['director', 'writer', 'cast'],
  tv: ['creator', 'writer', 'director', 'cast'],
  game: ['developer', 'publisher'],
  book: ['author', 'translator', 'narrator', 'illustrator'],
};

export const GAME_SCHEMES = ['percent', 'hours', 'milestones', 'text'] as const;
export type GameScheme = (typeof GAME_SCHEMES)[number];

export const BOOK_FORMATS = ['print', 'ebook', 'audiobook'] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

export const SHOW_STATUSES = ['returning', 'ended', 'unknown'] as const;
export type ShowStatus = (typeof SHOW_STATUSES)[number];

export const PROVENANCE_ORIGINS = ['provider', 'user', 'manual-entry'] as const;
export type ProvenanceOrigin = (typeof PROVENANCE_ORIGINS)[number];

export const EXTERNAL_ID_KINDS = [
  'tmdb',
  'imdb',
  'tvmaze',
  'openlibrary',
  'isbn10',
  'isbn13',
  'igdb',
  'steam',
  'xbox',
  'playstation',
  'wikidata',
  'anilist',
  'mal',
] as const;
export type ExternalIdKind = (typeof EXTERNAL_ID_KINDS)[number];

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/**
 * Progress event kinds. Each history row records the unit it was made in, so
 * switching a game's scheme or changing a book's page count never rewrites history.
 */
export const PROGRESS_KINDS = [
  'percent', // game percent or book percent
  'hours', // game hours played
  'milestone', // game milestone reached
  'text', // game free-form progress
  'pages', // book pages read
  'audio', // audiobook minutes listened
  'episode', // tv episode watched/unwatched
  'season', // tv bulk season / "up to here" action
] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];

export const SORT_FIELDS = [
  'title',
  'dateAdded',
  'updatedAt',
  'rating',
  'status',
  'releaseDate',
  'progress',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const ARTWORK_SOURCES = ['cache', 'user', 'remote'] as const;
export type ArtworkSource = (typeof ARTWORK_SOURCES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  completed: 'Completed',
  on_hold: 'On Hold',
  dropped: 'Dropped',
};

export const TYPE_LABELS: Record<MediaType, string> = {
  movie: 'Movie',
  tv: 'TV show',
  game: 'Game',
  book: 'Book',
};

export const TYPE_LABELS_PLURAL: Record<MediaType, string> = {
  movie: 'Movies',
  tv: 'TV shows',
  game: 'Games',
  book: 'Books',
};

export const ROLE_LABELS: Record<CreatorRole, string> = {
  director: 'Director',
  writer: 'Writer',
  cast: 'Cast',
  creator: 'Creator',
  developer: 'Developer',
  publisher: 'Publisher',
  author: 'Author',
  translator: 'Translator',
  narrator: 'Narrator',
  illustrator: 'Illustrator',
};

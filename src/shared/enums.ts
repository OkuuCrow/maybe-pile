/** Enumerations shared by every layer. Database CHECK constraints mirror these lists. */

export const MEDIA_TYPES = ['movie', 'tv', 'game', 'book', 'anime'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** Types tracked as seasons → episodes (anime reuses the TV model; docs/anime.md). */
export const EPISODIC_TYPES = ['tv', 'anime'] as const satisfies readonly MediaType[];
export function isEpisodic(type: MediaType): type is 'tv' | 'anime' {
  return type === 'tv' || type === 'anime';
}

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
  'studio',
] as const;
export type CreatorRole = (typeof CREATOR_ROLES)[number];

/** Roles offered by default in the editor for each type (all roles remain valid). */
export const ROLES_BY_TYPE: Record<MediaType, readonly CreatorRole[]> = {
  movie: ['director', 'writer', 'cast'],
  tv: ['creator', 'writer', 'director', 'cast'],
  game: ['developer', 'publisher'],
  book: ['author', 'translator', 'narrator', 'illustrator'],
  anime: ['studio', 'director', 'creator', 'writer'],
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
  'kitsu',
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
  anime: 'Anime',
};

export const TYPE_LABELS_PLURAL: Record<MediaType, string> = {
  movie: 'Movies',
  tv: 'TV shows',
  game: 'Games',
  book: 'Books',
  anime: 'Anime',
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
  studio: 'Studio',
};

/* ---------- Expansion Pack 2 ---------- */

export const ANIME_FORMATS = ['tv', 'tv_short', 'movie', 'ova', 'ona', 'special', 'music'] as const;
export type AnimeFormat = (typeof ANIME_FORMATS)[number];
export const ANIME_FORMAT_LABELS: Record<AnimeFormat, string> = {
  tv: 'TV',
  tv_short: 'TV Short',
  movie: 'Movie',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
  music: 'Music',
};

export const AIRING_STATUSES = ['not_yet_released', 'releasing', 'finished', 'cancelled', 'hiatus'] as const;
export type AiringStatus = (typeof AIRING_STATUSES)[number];
export const AIRING_STATUS_LABELS: Record<AiringStatus, string> = {
  not_yet_released: 'Not yet released',
  releasing: 'Releasing',
  finished: 'Finished',
  cancelled: 'Cancelled',
  hiatus: 'Hiatus',
};

export const ANIME_SEASONS = ['winter', 'spring', 'summer', 'fall'] as const;
export type AnimeSeason = (typeof ANIME_SEASONS)[number];
export const ANIME_SEASON_LABELS: Record<AnimeSeason, string> = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Fall',
};

export const TITLE_LANGUAGES = ['romaji', 'english', 'native'] as const;
export type TitleLanguage = (typeof TITLE_LANGUAGES)[number];

export const AUDIO_PREFS = ['sub', 'dub', 'both'] as const;
export type AudioPref = (typeof AUDIO_PREFS)[number];

export const ARTWORK_SLOTS = ['cover', 'banner', 'logo', 'icon', 'background'] as const;
export type ArtworkSlot = (typeof ARTWORK_SLOTS)[number];
export const ARTWORK_SLOT_LABELS: Record<ArtworkSlot, string> = {
  cover: 'Cover',
  banner: 'Banner',
  logo: 'Logo',
  icon: 'Icon',
  background: 'Background',
};

export const MOOD_ICONS = [
  'sofa',
  'clock',
  'cloud',
  'bolt',
  'heart',
  'laugh',
  'users',
  'repeat',
  'mountain',
  'star',
  'leaf',
  'moon',
  'sun',
  'music',
  'ghost',
  'flame',
] as const;
export type MoodIcon = (typeof MOOD_ICONS)[number];
export const MOOD_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'] as const;
export type MoodColor = (typeof MOOD_COLORS)[number];

export const RELATION_TYPES = [
  'sequel',
  'spin_off',
  'side_story',
  'adaptation_of',
  'remake_of',
  'same_franchise',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
/** Relation kinds a user may pick; `prequel` is stored as the inverse `sequel`. */
export const RELATION_INPUTS = ['prequel', ...RELATION_TYPES] as const;
export type RelationInput = (typeof RELATION_INPUTS)[number];
export const RELATION_LABELS: Record<RelationInput | 'adapted_as', string> = {
  prequel: 'Prequel',
  sequel: 'Sequel',
  spin_off: 'Spin-off',
  side_story: 'Side story',
  adaptation_of: 'Adaptation of',
  adapted_as: 'Adapted as',
  remake_of: 'Remake of',
  same_franchise: 'Same franchise',
};

export const SPOILER_MODES = ['default', 'shield', 'show'] as const;
export type SpoilerMode = (typeof SPOILER_MODES)[number];

export const HOURS_SOURCES = ['manual', 'sessions', 'steam'] as const;
export type HoursSource = (typeof HOURS_SOURCES)[number];

export const SESSION_KINDS = ['play', 'watch', 'read'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export function sessionKindFor(type: MediaType): SessionKind {
  return type === 'game' ? 'play' : type === 'book' ? 'read' : 'watch';
}

export const AVAILABILITY_KINDS = [
  'owned_digital',
  'owned_physical',
  'subscription',
  'library_loan',
  'borrowed',
  'wishlist',
] as const;
export type AvailabilityKind = (typeof AVAILABILITY_KINDS)[number];
export const AVAILABILITY_LABELS: Record<AvailabilityKind, string> = {
  owned_digital: 'Owned (digital)',
  owned_physical: 'Owned (physical)',
  subscription: 'Subscription',
  library_loan: 'Library loan',
  borrowed: 'Borrowed',
  wishlist: 'Wishlist',
};
/** Kinds that mean "I can start this right now". */
export const ACCESSIBLE_KINDS: readonly AvailabilityKind[] = [
  'owned_digital',
  'owned_physical',
  'subscription',
  'library_loan',
  'borrowed',
];

export const SERVICE_KINDS = ['subscription', 'store', 'library', 'other'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

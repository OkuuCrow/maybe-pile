/**
 * UI string catalog and Intl formatting. All user-facing copy that isn't
 * data-driven lives here so the app is ready for translation.
 */
import {
  STATUS_LABELS,
  TYPE_LABELS,
  TYPE_LABELS_PLURAL,
  type MediaType,
  type Status,
} from '../../shared/enums';

export const S = {
  app: { name: 'Maybe Pile', tagline: 'Someday, maybe. Now organized.', skip: 'Skip to main content' },
  nav: { dashboard: 'Dashboard', library: 'Library', settings: 'Settings', add: 'Add item', label: 'Main' },
  common: {
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    delete: 'Delete',
    edit: 'Edit',
    retry: 'Try again',
    loading: 'Loading…',
    undo: 'Undo',
    reset: 'Reset',
    apply: 'Apply',
    back: 'Back',
    none: 'None',
    unknown: 'Unknown',
    yes: 'Yes',
    no: 'No',
    remove: 'Remove',
    add: 'Add',
    import: 'Import',
    export: 'Export',
    moveUp: 'Move up',
    moveDown: 'Move down',
  },
  dashboard: {
    title: 'Dashboard',
    emptyTitle: 'Your pile is empty — for now',
    emptyBody:
      'Add the movies, shows, games and books you mean to get to. Search online sources or enter details yourself.',
    emptyAction: 'Add your first item',
    counts: 'Library counts',
    continue: 'Continue',
    continueEmpty: 'Nothing in progress. Start something from your library!',
    recentlyUpdated: 'Recently updated',
    recentlyAdded: 'Recently added',
    recentlyCompleted: 'Recently completed',
    completedEmpty: 'Nothing completed yet.',
    activity: 'Progress over time',
    activityEmpty: 'No progress logged in the last 12 weeks. Activity appears here as you track progress.',
    tags: 'Tags',
    tagsEmpty: 'No tags yet. Add tags to items to group them.',
    customize: 'Customize dashboard',
  },
  library: {
    title: 'Library',
    search: 'Search library',
    searchPlaceholder: 'Search titles, creators, notes, tags…',
    emptyTitle: 'No items yet',
    emptyBody: 'Your library is empty. Add something to get started.',
    noMatches: 'No items match these filters.',
    clearFilters: 'Clear all filters',
    grid: 'Grid',
    list: 'List',
    view: 'View',
    sort: 'Sort by',
    direction: 'Direction',
    asc: 'Ascending',
    desc: 'Descending',
    results: (n: number) => `${n.toLocaleString()} item${n === 1 ? '' : 's'}`,
    selected: (n: number) => `${n} selected`,
    loadMore: 'Load more',
  },
  item: {
    notFound: 'This item no longer exists.',
    details: 'Details',
    progress: 'Progress',
    history: 'History',
    notes: 'Notes',
    source: 'Source',
    links: 'Links',
  },
  errors: {
    generic: 'Something went wrong.',
    offline: 'You appear to be offline. Your library still works; online lookups need a connection.',
  },
};

export const statusLabel = (s: Status): string => STATUS_LABELS[s];
export const typeLabel = (t: MediaType): string => TYPE_LABELS[t];
export const typeLabelPlural = (t: MediaType): string => TYPE_LABELS_PLURAL[t];

const locale = (): string => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

/** Formats a partial (YYYY / YYYY-MM / YYYY-MM-DD) or calendar date for display. */
export function fmtPartialDate(d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-').map(Number);
  if (!y) return d;
  if (!m) return String(y);
  const date = new Date(Date.UTC(y, m - 1, day ?? 1));
  return new Intl.DateTimeFormat(
    locale(),
    day
      ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { year: 'numeric', month: 'short', timeZone: 'UTC' },
  ).format(date);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat(locale()).format(n);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Local date (YYYY-MM-DD) for "today" in the user's calendar. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Converts a <input type="datetime-local"> value to ISO UTC, or null. */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

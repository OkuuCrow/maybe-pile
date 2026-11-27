/**
 * Feature registry (§13.2). Every nav entry, settings section, dashboard
 * component, library control and feature declares a tier. Simple Mode
 * renders only `core`; advanced features keep working in the background
 * (reminders still fire, imported data stays) and stay findable from the
 * omnibox with a "Turn on Full mode to use this" hint. Dependency-free.
 */
export type Tier = 'core' | 'advanced';
export type FeatureKind = 'nav' | 'settings' | 'dashboard' | 'library' | 'item' | 'feature';

export interface FeatureEntry {
  id: string;
  kind: FeatureKind;
  tier: Tier;
  /** Full-mode name. */
  label: string;
  /** Plain-language name used in Simple Mode (no jargon). */
  simpleLabel?: string;
  /** Hash route that opens it, if any. */
  route?: string;
  keywords?: string[];
}

export const FEATURES: readonly FeatureEntry[] = [
  /* navigation — Simple Mode: Home, Library, Settings (+ Add) */
  {
    id: 'nav.home',
    kind: 'nav',
    tier: 'core',
    label: 'Dashboard',
    simpleLabel: 'Home',
    route: '#/dashboard',
  },
  { id: 'nav.library', kind: 'nav', tier: 'core', label: 'Library', route: '#/library' },
  { id: 'nav.settings', kind: 'nav', tier: 'core', label: 'Settings', route: '#/settings/appearance' },
  { id: 'nav.pile', kind: 'nav', tier: 'advanced', label: 'Pile', route: '#/pile' },
  { id: 'nav.lists', kind: 'nav', tier: 'advanced', label: 'Lists', route: '#/lists' },
  { id: 'nav.stats', kind: 'nav', tier: 'advanced', label: 'Stats', route: '#/stats' },
  { id: 'nav.upcoming', kind: 'nav', tier: 'advanced', label: 'Upcoming', route: '#/upcoming' },
  {
    id: 'nav.pick',
    kind: 'nav',
    tier: 'advanced',
    label: 'Pick for Me',
    route: '#/pick',
    keywords: ['random'],
  },
  {
    id: 'nav.goals',
    kind: 'nav',
    tier: 'advanced',
    label: 'Goals',
    route: '#/goals',
    keywords: ['time goal'],
  },
  {
    id: 'nav.health',
    kind: 'nav',
    tier: 'advanced',
    label: 'Pile Health',
    simpleLabel: 'Not touched in a while',
    route: '#/health',
  },
  {
    id: 'nav.import',
    kind: 'nav',
    tier: 'advanced',
    label: 'Import',
    route: '#/import/sources',
    keywords: ['steam', 'csv', 'goodreads'],
  },
  {
    id: 'nav.wall',
    kind: 'nav',
    tier: 'advanced',
    label: 'Cover wall',
    route: '#/wall',
    keywords: ['posters', 'finished'],
  },
  {
    id: 'nav.triage',
    kind: 'nav',
    tier: 'advanced',
    label: 'Triage',
    route: '#/triage',
    keywords: ['review', 'sort'],
  },
  {
    id: 'nav.people',
    kind: 'nav',
    tier: 'advanced',
    label: 'Loans & people',
    route: '#/people',
    keywords: ['lent', 'borrowed', 'recommended'],
  },
  {
    id: 'nav.changes',
    kind: 'nav',
    tier: 'advanced',
    label: 'Recent changes',
    route: '#/changes',
    keywords: ['undo', 'history', 'log'],
  },
  {
    id: 'nav.trash',
    kind: 'nav',
    tier: 'core',
    label: 'Recently deleted',
    route: '#/trash',
    keywords: ['trash', 'restore'],
  },

  /* settings sections — Simple: Appearance, Reminders, Backup & restore, Data sources, Interface */
  {
    id: 'settings.appearance',
    kind: 'settings',
    tier: 'core',
    label: 'Appearance',
    route: '#/settings/appearance',
  },
  {
    id: 'settings.notifications',
    kind: 'settings',
    tier: 'core',
    label: 'Notifications',
    simpleLabel: 'Reminders',
    route: '#/settings/notifications',
  },
  {
    id: 'settings.backup',
    kind: 'settings',
    tier: 'core',
    label: 'Backup & Restore',
    simpleLabel: 'Backup & restore',
    route: '#/settings/backup',
  },
  {
    id: 'settings.providers',
    kind: 'settings',
    tier: 'core',
    label: 'Providers',
    simpleLabel: 'Data sources',
    route: '#/settings/providers',
  },
  {
    id: 'settings.interface',
    kind: 'settings',
    tier: 'core',
    label: 'Interface',
    route: '#/settings/interface',
  },
  { id: 'settings.layout', kind: 'settings', tier: 'advanced', label: 'Layout', route: '#/settings/layout' },
  {
    id: 'settings.library',
    kind: 'settings',
    tier: 'advanced',
    label: 'Custom fields & series',
    route: '#/settings/library',
  },
  {
    id: 'settings.features',
    kind: 'settings',
    tier: 'advanced',
    label: 'Features',
    route: '#/settings/features',
  },
  {
    id: 'settings.data',
    kind: 'settings',
    tier: 'advanced',
    label: 'Data & Behavior',
    route: '#/settings/data',
  },
  {
    id: 'settings.advanced',
    kind: 'settings',
    tier: 'advanced',
    label: 'Advanced',
    route: '#/settings/advanced',
    keywords: ['templates', 'views', 'rules', 'storage', 'libraries'],
  },
  { id: 'settings.about', kind: 'settings', tier: 'advanced', label: 'About', route: '#/settings/about' },

  /* library controls */
  {
    id: 'library.filters',
    kind: 'library',
    tier: 'advanced',
    label: 'Filters (tags, rating, dates, moods, lists)',
  },
  { id: 'library.views', kind: 'library', tier: 'advanced', label: 'Saved views' },
  { id: 'library.bulkEdit', kind: 'library', tier: 'advanced', label: 'Bulk edit with preview' },
  { id: 'library.bulkBasic', kind: 'library', tier: 'core', label: 'Basic bulk actions' },

  /* item detail */
  { id: 'item.nextStep', kind: 'item', tier: 'core', label: 'Next step' },
  { id: 'item.skippedEpisodes', kind: 'item', tier: 'core', label: 'Skipped episodes' },
  { id: 'item.recommendedBy', kind: 'item', tier: 'core', label: 'Recommended by' },
  { id: 'item.checklist', kind: 'item', tier: 'advanced', label: 'Checklist' },
  { id: 'item.loans', kind: 'item', tier: 'advanced', label: 'Lent / borrowed' },
  { id: 'item.journal', kind: 'item', tier: 'advanced', label: 'Journal' },
  { id: 'item.backdropPicker', kind: 'item', tier: 'advanced', label: 'Backdrop picker' },

  /* features (§14–§16) */
  { id: 'feature.quickRating', kind: 'feature', tier: 'core', label: 'Quick rating prompt' },
  { id: 'feature.pasteList', kind: 'feature', tier: 'core', label: 'Paste a list to import' },
  { id: 'feature.backupCheck', kind: 'feature', tier: 'core', label: 'Backup destination check' },
  { id: 'feature.trash', kind: 'feature', tier: 'core', label: 'Recently deleted' },
  { id: 'feature.offlineQueue', kind: 'feature', tier: 'core', label: 'Offline add queue' },
  { id: 'feature.restorePlace', kind: 'feature', tier: 'core', label: 'Restore my place' },
  { id: 'feature.dyslexiaFont', kind: 'feature', tier: 'core', label: 'Dyslexia-friendly font' },
  { id: 'feature.ambientBackdrops', kind: 'feature', tier: 'core', label: 'Ambient backdrops' },
  { id: 'feature.keyFreeCovers', kind: 'feature', tier: 'core', label: 'Key-free cover search' },
  { id: 'feature.timeGoals', kind: 'feature', tier: 'advanced', label: 'Time-based goals' },
  { id: 'feature.coverWall', kind: 'feature', tier: 'advanced', label: 'Cover wall' },
  { id: 'feature.savedViews', kind: 'feature', tier: 'advanced', label: 'Saved views' },
  { id: 'feature.templates', kind: 'feature', tier: 'advanced', label: 'Item templates' },
  { id: 'feature.sharePage', kind: 'feature', tier: 'advanced', label: 'Share page' },
  { id: 'feature.checklists', kind: 'feature', tier: 'advanced', label: 'Checklists' },
  { id: 'feature.loans', kind: 'feature', tier: 'advanced', label: 'Lent and borrowed' },
  { id: 'feature.changeLog', kind: 'feature', tier: 'advanced', label: 'Recent changes' },
  {
    id: 'feature.checkup',
    kind: 'feature',
    tier: 'advanced',
    label: 'Library check-up',
    simpleLabel: 'Check my library',
  },
  { id: 'feature.triage', kind: 'feature', tier: 'advanced', label: 'Triage mode' },
  { id: 'feature.bulkEdit', kind: 'feature', tier: 'advanced', label: 'Bulk edit' },
  { id: 'feature.autoRules', kind: 'feature', tier: 'advanced', label: 'Automatic status rules' },
  { id: 'feature.journal', kind: 'feature', tier: 'advanced', label: 'Journal' },
  { id: 'feature.themeSchedule', kind: 'feature', tier: 'advanced', label: 'Theme schedule' },
  { id: 'feature.trayMenu', kind: 'feature', tier: 'advanced', label: 'Tray menu' },
  { id: 'feature.libraries', kind: 'feature', tier: 'advanced', label: 'Multiple libraries' },
  { id: 'feature.backdropPicker', kind: 'feature', tier: 'advanced', label: 'Backdrop picker & storage' },
];

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

export function feature(id: string): FeatureEntry | undefined {
  return BY_ID.get(id);
}

/** Whether a registered entry is shown at this interface level (unknown ids are treated as advanced). */
export function isShown(id: string, level: 'simple' | 'full'): boolean {
  if (level === 'full') return true;
  return BY_ID.get(id)?.tier === 'core';
}

export function labelFor(id: string, level: 'simple' | 'full'): string {
  const f = BY_ID.get(id);
  if (!f) return id;
  return level === 'simple' ? (f.simpleLabel ?? f.label) : f.label;
}

/** Omnibox/palette search over features, including hidden ones (with a hint). */
export function searchFeatures(
  q: string,
  level: 'simple' | 'full',
): { entry: FeatureEntry; hidden: boolean }[] {
  const t = q.trim().toLowerCase();
  if (t.length < 2) return [];
  return FEATURES.filter(
    (f) =>
      f.route &&
      [f.label, f.simpleLabel ?? '', ...(f.keywords ?? [])].some((s) => s.toLowerCase().includes(t)),
  )
    .slice(0, 6)
    .map((entry) => ({ entry, hidden: !isShown(entry.id, level) }));
}

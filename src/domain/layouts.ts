/**
 * Layout format: which dashboard/library components are shown and in what
 * order. Only whitelisted component IDs and settings are accepted.
 * Required = every known component must appear exactly once (visible or hidden);
 * a layout missing some is repaired by appending defaults, with a notice.
 */
import { z } from 'zod';
import { formatZodIssues, type ParseOutcome } from './themes';

export const LAYOUT_FORMAT = 'maybepile-layout';
export const LAYOUT_SCHEMA_VERSION = 1;
export const LAYOUT_MAX_BYTES = 32 * 1024;

export const DASHBOARD_COMPONENTS = [
  'counts',
  'upNext',
  'continue',
  'pick',
  'recentlyUpdated',
  'recentlyAdded',
  'recentlyCompleted',
  'activity',
  'yearStats',
  'tags',
] as const;
export const LIBRARY_COMPONENTS = [
  'search',
  'filters',
  'sort',
  'viewToggle',
  'statusStrip',
  'bulkBar',
] as const;

export type DashboardComponentId = (typeof DASHBOARD_COMPONENTS)[number];
export type LibraryComponentId = (typeof LIBRARY_COMPONENTS)[number];
export type LayoutSurface = 'dashboard' | 'library';

export const COMPONENT_LABELS: Record<DashboardComponentId | LibraryComponentId, string> = {
  counts: 'Library counts',
  upNext: 'Up Next queue',
  pick: 'Pick something for me',
  yearStats: 'This year',
  continue: 'Continue (in progress)',
  recentlyUpdated: 'Recently updated',
  recentlyAdded: 'Recently added',
  recentlyCompleted: 'Recently completed',
  activity: 'Progress over time',
  tags: 'Tag overview',
  search: 'Search bar',
  filters: 'Filter bar',
  sort: 'Sort control',
  viewToggle: 'Grid/list toggle',
  statusStrip: 'Status summary strip',
  bulkBar: 'Bulk-action bar',
};

export interface LayoutEntry {
  id: string;
  visible: boolean;
  span: 1 | 2;
}

export const DEFAULT_LAYOUTS: Record<LayoutSurface, LayoutEntry[]> = {
  dashboard: [
    { id: 'counts', visible: true, span: 2 },
    { id: 'upNext', visible: true, span: 1 },
    { id: 'pick', visible: true, span: 1 },
    { id: 'continue', visible: true, span: 2 },
    { id: 'recentlyUpdated', visible: true, span: 1 },
    { id: 'recentlyAdded', visible: true, span: 1 },
    { id: 'recentlyCompleted', visible: true, span: 1 },
    { id: 'activity', visible: true, span: 1 },
    { id: 'yearStats', visible: true, span: 1 },
    { id: 'tags', visible: true, span: 1 },
  ],
  library: LIBRARY_COMPONENTS.map((id) => ({ id, visible: true, span: 1 as const })),
};

const dashboardEntry = z.strictObject({
  id: z.enum(DASHBOARD_COMPONENTS),
  visible: z.boolean(),
  span: z.union([z.literal(1), z.literal(2)]).optional(),
});
const libraryEntry = z.strictObject({ id: z.enum(LIBRARY_COMPONENTS), visible: z.boolean() });

const noDuplicateIds = <T extends { id: string }>(arr: T[]) =>
  new Set(arr.map((e) => e.id)).size === arr.length;

export const LayoutFileSchema = z.strictObject({
  format: z.literal(LAYOUT_FORMAT),
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  dashboard: z
    .array(dashboardEntry)
    .max(DASHBOARD_COMPONENTS.length)
    .refine(noDuplicateIds, 'Each dashboard component may appear only once.'),
  library: z
    .array(libraryEntry)
    .max(LIBRARY_COMPONENTS.length)
    .refine(noDuplicateIds, 'Each library component may appear only once.'),
});
export type LayoutFile = z.infer<typeof LayoutFileSchema>;

/** Appends missing components (hidden-by-default = their default visibility) and drops unknown ones. */
export function repairLayout(
  surface: LayoutSurface,
  entries: readonly LayoutEntry[],
): { entries: LayoutEntry[]; notices: string[] } {
  const allowed: readonly string[] = surface === 'dashboard' ? DASHBOARD_COMPONENTS : LIBRARY_COMPONENTS;
  const seen = new Set<string>();
  const out: LayoutEntry[] = [];
  const notices: string[] = [];
  for (const e of entries) {
    if (!allowed.includes(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ id: e.id, visible: e.visible, span: surface === 'dashboard' ? e.span : 1 });
  }
  const missing = DEFAULT_LAYOUTS[surface].filter((d) => !seen.has(d.id));
  if (missing.length > 0) {
    out.push(...missing.map((m) => ({ ...m })));
    notices.push(
      `The ${surface} layout was missing ${missing.length} component(s) (${missing
        .map((m) => COMPONENT_LABELS[m.id as DashboardComponentId])
        .join(', ')}); they were restored with default settings.`,
    );
  }
  return { entries: out, notices };
}

export function layoutFileToEntries(f: LayoutFile): Record<LayoutSurface, LayoutEntry[]> {
  return {
    dashboard: f.dashboard.map((e) => ({ id: e.id, visible: e.visible, span: e.span ?? 1 })),
    library: f.library.map((e) => ({ id: e.id, visible: e.visible, span: 1 as const })),
  };
}

export function entriesToLayoutFile(layouts: Record<LayoutSurface, readonly LayoutEntry[]>): LayoutFile {
  return {
    format: LAYOUT_FORMAT,
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    dashboard: layouts.dashboard.map((e) => ({
      id: e.id as DashboardComponentId,
      visible: e.visible,
      span: e.span,
    })),
    library: layouts.library.map((e) => ({ id: e.id as LibraryComponentId, visible: e.visible })),
  };
}

export function parseLayoutFile(textContent: string): ParseOutcome<LayoutFile> {
  if (new TextEncoder().encode(textContent).byteLength > LAYOUT_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: '$', message: `File is larger than ${LAYOUT_MAX_BYTES / 1024} KB.` }],
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(textContent);
  } catch {
    return { ok: false, issues: [{ path: '$', message: 'File is not valid JSON.' }] };
  }
  if (typeof json === 'object' && json !== null && 'schemaVersion' in json) {
    const v = (json as { schemaVersion: unknown }).schemaVersion;
    if (typeof v === 'number' && v > LAYOUT_SCHEMA_VERSION) {
      return {
        ok: false,
        issues: [
          {
            path: '$.schemaVersion',
            message: `Layout format version ${v} is newer than this app supports (${LAYOUT_SCHEMA_VERSION}).`,
          },
        ],
      };
    }
  }
  const r = LayoutFileSchema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: formatZodIssues(r.error) };
}

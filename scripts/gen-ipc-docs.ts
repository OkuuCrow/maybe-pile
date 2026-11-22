/**
 * Regenerates the IPC channel table in docs/security.md from API_SHAPE and
 * REQUEST_SCHEMAS so the documentation cannot drift from the code.
 * Usage: node scripts/run-ts.mjs scripts/gen-ipc-docs.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { API_SHAPE, type Channel } from '../src/shared/ipc-channels';
import { REQUEST_SCHEMAS } from '../src/shared/ipc-contract';

const INFO: Record<Channel, [purpose: string, sideEffects: string]> = {
  'app:info': ['App/version/data-location info', 'none'],
  'app:openDataFolder': ['Open the userData folder in the OS file manager', 'launches file manager'],
  'app:openExternal': [
    'Open a validated https link in the default browser',
    'shell.openExternal (allowlisted hosts only)',
  ],
  'app:exportLog': ['Save the redacted diagnostic log', 'save dialog → file write'],
  'app:chooseBackupFolder': ['Choose default export/backup folder', 'folder dialog → main-owned setting'],
  'app:acknowledgeNotices': ['Dismiss upgrade/recovery notices', 'in-memory'],
  'settings:get': ['Read settings', 'none'],
  'settings:update': ['Update non-secret settings (strict schema)', 'DB write'],
  'items:query': ['Search/filter/sort library page', 'none'],
  'items:get': ['Item detail', 'none'],
  'items:create': ['Create item (duplicate check)', 'DB write'],
  'items:update': ['Edit metadata/personal fields (provenance → user)', 'DB write'],
  'items:setStatus': ['Status change with confirmed options', 'DB write'],
  'items:acceptSuggestion': ['Apply a status suggestion', 'DB write'],
  'items:setRating': ['Set rating', 'DB write'],
  'items:delete': ['Soft-delete items (undoable)', 'DB write'],
  'items:undoDelete': ['Undo soft delete', 'DB write'],
  'items:bulk': ['Bulk status/tag/delete', 'DB write'],
  'items:checkDuplicates': ['Likely duplicates', 'none'],
  'items:dashboard': ['Dashboard aggregates', 'none'],
  'items:tags': ['Tag counts', 'none'],
  'items:audit': ['Metadata audit log', 'none'],
  'progress:add': ['Add progress entry', 'DB write'],
  'progress:edit': ['Edit history entry', 'DB write'],
  'progress:remove': ['Delete history entry', 'DB write'],
  'progress:history': ['List history', 'none'],
  'progress:addViewing': ['Log movie viewing', 'DB write'],
  'progress:editViewing': ['Edit viewing', 'DB write'],
  'progress:removeViewing': ['Delete viewing', 'DB write'],
  'progress:viewings': ['List viewings', 'none'],
  'progress:toggleEpisodes': ['Mark episodes (un)watched', 'DB write'],
  'progress:upsertSeason': ['Add/edit season', 'DB write'],
  'progress:deleteSeason': ['Delete season', 'DB write'],
  'progress:upsertEpisode': ['Add/edit episode', 'DB write'],
  'progress:deleteEpisode': ['Delete episode', 'DB write'],
  'progress:setMilestones': ['Replace game milestones', 'DB write'],
  'progress:setScheme': ['Switch game progress scheme', 'DB write'],
  'customFields:list': ['List custom fields', 'none'],
  'customFields:save': ['Create/edit custom field', 'DB write'],
  'customFields:delete': ['Delete custom field', 'DB write'],
  'series:list': ['List book series', 'none'],
  'series:save': ['Create/edit series', 'DB write'],
  'series:delete': ['Delete series', 'DB write'],
  'series:setMembership': ['Add/remove book in series', 'DB write'],
  'providers:list': ['Provider info (keys: set/unset only)', 'none'],
  'providers:search': ['Search a provider', 'network (provider API)'],
  'providers:preview': ['Fetch details for import preview', 'network'],
  'providers:import': ['Import the previewed item', 'network (artwork) + DB write + artwork file'],
  'providers:refreshPreview': ['Compare current vs provider metadata', 'network'],
  'providers:refreshApply': ['Apply per-field refresh choices', 'DB write'],
  'providers:setKey': ['Store/clear an API key (write-only)', 'secrets.json write'],
  'providers:setEnabled': ['Enable/disable provider', 'DB write'],
  'providers:watch': ['Where-to-watch for a region (TMDB)', 'network'],
  'artwork:chooseLocal': ['Pick a local image', 'open dialog → artwork file + DB'],
  'artwork:remove': ['Remove item artwork', 'DB write + artwork GC'],
  'artwork:retry': ['Cache remote artwork (cache-allowed providers)', 'network + artwork file'],
  'themes:list': ['List themes', 'none'],
  'themes:get': ['Theme tokens + contrast warnings', 'none'],
  'themes:active': ['Resolved active theme (with fallback)', 'may reset setting to fallback'],
  'themes:save': ['Create/update custom theme (validated)', 'DB write'],
  'themes:duplicate': ['Duplicate a theme', 'DB write'],
  'themes:delete': ['Delete custom theme', 'DB write'],
  'themes:import': ['Import .mptheme.json (validated, never executed)', 'open dialog → DB write'],
  'themes:export': ['Export theme file', 'save dialog → file write'],
  'themes:reset': ['Reset to System (optionally delete custom)', 'DB write'],
  'layouts:get': ['Dashboard/library layouts', 'none'],
  'layouts:set': ['Save layout (whitelisted ids, repaired)', 'DB write'],
  'layouts:reset': ['Reset layout(s)', 'DB write'],
  'layouts:import': ['Import .mplayout.json (validated)', 'open dialog → DB write'],
  'layouts:export': ['Export layout file', 'save dialog → file write'],
  'data:exportJson': ['JSON export', 'save dialog → file write'],
  'data:exportCsv': ['CSV export', 'save dialog → file write'],
  'data:importPreview': [
    'Validate JSON/CSV/backup and stage preview',
    'open dialog → read; backup staged in temp folder',
  ],
  'data:importApply': [
    'Apply staged import/restore (typed confirm for restore)',
    'DB transaction / atomic swap + pre-restore snapshot',
  ],
  'data:importCancel': ['Discard staged import/restore', 'temp cleanup'],
  'data:backupCreate': ['Create .mpbackup', 'save dialog → file write'],
  'data:backupList': ['List safety snapshots', 'none'],
  'data:restoreInternalPreview': ['Preview restoring a safety snapshot', 'staging in temp folder'],
};

function schemaSummary(c: Channel): string {
  const s = REQUEST_SCHEMAS[c] as {
    def?: { type?: string; shape?: Record<string, unknown>; options?: unknown[] };
  };
  const def = (s as unknown as { _zod?: { def?: { type?: string; shape?: Record<string, unknown> } } })._zod
    ?.def;
  if (def?.type === 'undefined') return '—';
  if (def?.shape) return `{ ${Object.keys(def.shape).join(', ')} }`;
  if (def?.type) return def.type === 'union' ? 'discriminated union' : def.type;
  return 'object';
}

const rows = Object.entries(API_SHAPE).flatMap(([ns, methods]) =>
  Object.entries(methods).map(([m, ch]) => {
    const c = ch as Channel;
    const [purpose, fx] = INFO[c];
    return `| \`${c}\` | \`${ns}.${m}\` | ${purpose} | ${schemaSummary(c).replace(/\|/g, '\\|')} | \`Result<${'…'}>\` | ${fx} |`;
  }),
);
const table = [
  '| Channel | Preload method | Purpose | Request (validated in main) | Response | Side effects |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows,
].join('\n');

const path = 'docs/security.md';
const doc = readFileSync(path, 'utf8');
const start = '<!-- IPC-TABLE:START -->';
const end = '<!-- IPC-TABLE:END -->';
const next = doc.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${table}\n${end}`);
writeFileSync(path, next);
console.log(`Wrote ${rows.length} channels to ${path}`);

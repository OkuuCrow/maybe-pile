/**
 * The complete, enumerated renderer → main API surface.
 *
 * Each entry maps `namespace.method` to one fixed IPC channel. The preload
 * script exposes exactly these methods (and nothing else) via contextBridge;
 * each method can only invoke its own channel. There is deliberately no
 * generic "invoke(channel)" function.
 *
 * This file has no runtime dependencies so the sandboxed preload stays tiny.
 */
export const API_SHAPE = {
  app: {
    info: 'app:info',
    openDataFolder: 'app:openDataFolder',
    openExternal: 'app:openExternal',
    exportLog: 'app:exportLog',
    chooseBackupFolder: 'app:chooseBackupFolder',
    acknowledgeNotices: 'app:acknowledgeNotices',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
  },
  items: {
    query: 'items:query',
    get: 'items:get',
    create: 'items:create',
    update: 'items:update',
    setStatus: 'items:setStatus',
    acceptSuggestion: 'items:acceptSuggestion',
    setRating: 'items:setRating',
    remove: 'items:delete',
    undoRemove: 'items:undoDelete',
    bulk: 'items:bulk',
    checkDuplicates: 'items:checkDuplicates',
    dashboard: 'items:dashboard',
    tags: 'items:tags',
    audit: 'items:audit',
  },
  progress: {
    add: 'progress:add',
    edit: 'progress:edit',
    remove: 'progress:remove',
    history: 'progress:history',
    addViewing: 'progress:addViewing',
    editViewing: 'progress:editViewing',
    removeViewing: 'progress:removeViewing',
    viewings: 'progress:viewings',
    toggleEpisodes: 'progress:toggleEpisodes',
    upsertSeason: 'progress:upsertSeason',
    deleteSeason: 'progress:deleteSeason',
    upsertEpisode: 'progress:upsertEpisode',
    deleteEpisode: 'progress:deleteEpisode',
    setMilestones: 'progress:setMilestones',
    setScheme: 'progress:setScheme',
  },
  catalog: {
    customFields: 'customFields:list',
    saveCustomField: 'customFields:save',
    deleteCustomField: 'customFields:delete',
    series: 'series:list',
    saveSeries: 'series:save',
    deleteSeries: 'series:delete',
    setSeriesMembership: 'series:setMembership',
  },
  providers: {
    list: 'providers:list',
    search: 'providers:search',
    preview: 'providers:preview',
    importPreviewed: 'providers:import',
    refreshPreview: 'providers:refreshPreview',
    refreshApply: 'providers:refreshApply',
    setKey: 'providers:setKey',
    setEnabled: 'providers:setEnabled',
    watch: 'providers:watch',
  },
  artwork: {
    chooseLocal: 'artwork:chooseLocal',
    remove: 'artwork:remove',
    retry: 'artwork:retry',
  },
  themes: {
    list: 'themes:list',
    get: 'themes:get',
    active: 'themes:active',
    save: 'themes:save',
    duplicate: 'themes:duplicate',
    remove: 'themes:delete',
    importFile: 'themes:import',
    exportFile: 'themes:export',
    reset: 'themes:reset',
  },
  layouts: {
    get: 'layouts:get',
    set: 'layouts:set',
    reset: 'layouts:reset',
    importFile: 'layouts:import',
    exportFile: 'layouts:export',
  },
  data: {
    exportJson: 'data:exportJson',
    exportCsv: 'data:exportCsv',
    importPreview: 'data:importPreview',
    importApply: 'data:importApply',
    importCancel: 'data:importCancel',
    backupCreate: 'data:backupCreate',
    backupList: 'data:backupList',
    restoreInternalPreview: 'data:restoreInternalPreview',
  },
} as const;

/** Main → renderer push events (fixed names; renderer may only subscribe). */
export const EVENT_CHANNELS = {
  menuCommand: 'event:menuCommand',
} as const;

export const MENU_COMMANDS = [
  'new-item',
  'focus-search',
  'go-dashboard',
  'go-library',
  'go-settings',
  'show-shortcuts',
  'import',
  'export',
  'backup',
  'about',
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

type Shape = typeof API_SHAPE;
export type Channel = { [N in keyof Shape]: Shape[N][keyof Shape[N]] }[keyof Shape];

export const ALL_CHANNELS: readonly Channel[] = Object.values(API_SHAPE).flatMap((ns) =>
  Object.values(ns),
) as Channel[];

/**
 * Builds the API object from an invoke function. Used by the preload (with
 * ipcRenderer.invoke) and by tests. Every method is bound to one constant channel.
 */
export function buildApi(
  invoke: (channel: Channel, payload: unknown) => Promise<unknown>,
): Record<string, Record<string, (payload?: unknown) => Promise<unknown>>> {
  const api: Record<string, Record<string, (payload?: unknown) => Promise<unknown>>> = {};
  for (const [ns, methods] of Object.entries(API_SHAPE)) {
    const group: Record<string, (payload?: unknown) => Promise<unknown>> = {};
    for (const [name, channel] of Object.entries(methods)) {
      const fixed = channel as Channel;
      group[name] = (payload?: unknown) => invoke(fixed, payload);
    }
    api[ns] = Object.freeze(group);
  }
  return api;
}

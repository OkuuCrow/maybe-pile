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
    setUpNext: 'items:setUpNext',
    moveUpNext: 'items:moveUpNext',
    pickRandom: 'items:pickRandom',
    titles: 'items:titles',
    quickCapture: 'items:quickCapture',
  },
  pick: {
    roll: 'pick:roll',
    respond: 'pick:respond',
    history: 'pick:history',
    clearSkips: 'pick:clearSkips',
  },
  health: {
    overview: 'health:overview',
    snooze: 'health:snooze',
    unsnooze: 'health:unsnooze',
    keep: 'health:keep',
  },
  lists: {
    list: 'lists:list',
    get: 'lists:get',
    save: 'lists:save',
    remove: 'lists:delete',
    move: 'lists:move',
    setMembership: 'lists:setMembership',
    moveItem: 'lists:moveItem',
  },
  stats: {
    get: 'stats:get',
    yearInReview: 'stats:yearInReview',
    exportCsv: 'stats:exportCsv',
    saveImage: 'stats:saveImage',
    heatmap: 'stats:heatmap',
  },
  radar: {
    upcoming: 'radar:upcoming',
    refreshPreview: 'radar:refreshPreview',
    refreshApply: 'radar:refreshApply',
    exportIcs: 'radar:exportIcs',
  },
  sources: {
    list: 'sources:list',
    saveSteam: 'sources:saveSteam',
    clearSteamKey: 'sources:clearSteamKey',
    remove: 'sources:delete',
    testSteam: 'sources:testSteam',
    startFetch: 'sources:startFetch',
    fetchStatus: 'sources:fetchStatus',
    cancelFetch: 'sources:cancelFetch',
    entries: 'sources:entries',
    setIgnored: 'sources:setIgnored',
    importSelected: 'sources:import',
    diff: 'sources:diff',
    applyPlaytime: 'sources:applyPlaytime',
    loadManual: 'sources:loadManual',
    loadManualFile: 'sources:loadManualFile',
  },
  batches: {
    list: 'batches:list',
    undoPreview: 'batches:undoPreview',
    undo: 'batches:undo',
  },
  tracker: {
    preview: 'tracker:preview',
    remap: 'tracker:remap',
    apply: 'tracker:apply',
    profiles: 'tracker:profiles',
    saveProfile: 'tracker:saveProfile',
    deleteProfile: 'tracker:deleteProfile',
  },
  goals: {
    list: 'goals:list',
    save: 'goals:save',
    archive: 'goals:archive',
    remove: 'goals:delete',
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
    /* Expansion Pack 2: Artwork Picker */
    slots: 'artwork:slots',
    gallery: 'artwork:gallery',
    choose: 'artwork:choose',
    revert: 'artwork:revert',
    clearSlot: 'artwork:clearSlot',
    autoPick: 'artwork:autoPick',
    bulkAutoPick: 'artwork:bulkAutoPick',
  },
  /* ---------------------------------------------------------------- Expansion Pack 2 */
  anime: {
    searchAll: 'anime:searchAll',
  },
  pileTime: {
    item: 'pileTime:item',
    totals: 'pileTime:totals',
    fits: 'pileTime:fits',
    setManual: 'pileTime:setManual',
    fetchIgdb: 'pileTime:fetchIgdb',
  },
  moods: {
    list: 'moods:list',
    create: 'moods:create',
    update: 'moods:update',
    remove: 'moods:delete',
    reorder: 'moods:reorder',
    forItem: 'moods:forItem',
    setForItem: 'moods:setForItem',
    bulk: 'moods:bulk',
  },
  itemExtras: {
    prefs: 'itemExtras:prefs',
    setPrefs: 'itemExtras:setPrefs',
    runs: 'itemExtras:runs',
    updateRun: 'itemExtras:updateRun',
    streaming: 'itemExtras:streaming',
    relations: 'itemExtras:relations',
    addRelation: 'itemExtras:addRelation',
    removeRelation: 'itemExtras:removeRelation',
    suggestions: 'itemExtras:suggestions',
    resolveSuggestion: 'itemExtras:resolveSuggestion',
    franchisesForItem: 'itemExtras:franchisesForItem',
  },
  franchises: {
    list: 'franchises:list',
    get: 'franchises:get',
    create: 'franchises:create',
    update: 'franchises:update',
    setEntries: 'franchises:setEntries',
    remove: 'franchises:delete',
  },
  value: {
    list: 'value:list',
    add: 'value:add',
    update: 'value:update',
    remove: 'value:delete',
    summary: 'value:summary',
  },
  sessions: {
    open: 'sessions:open',
    forItem: 'sessions:forItem',
    start: 'sessions:start',
    pause: 'sessions:pause',
    resume: 'sessions:resume',
    stop: 'sessions:stop',
    log: 'sessions:log',
    edit: 'sessions:edit',
    remove: 'sessions:delete',
  },
  availability: {
    services: 'availability:services',
    addService: 'availability:addService',
    updateService: 'availability:updateService',
    removeService: 'availability:removeService',
    forItem: 'availability:forItem',
    add: 'availability:add',
    update: 'availability:update',
    remove: 'availability:delete',
    leavingSoon: 'availability:leavingSoon',
  },
  recs: {
    list: 'recs:list',
    feedback: 'recs:feedback',
    clearFeedback: 'recs:clearFeedback',
  },
  merge: {
    pairs: 'merge:pairs',
    dismiss: 'merge:dismiss',
    preview: 'merge:preview',
    apply: 'merge:apply',
    lastUndoable: 'merge:lastUndoable',
    undo: 'merge:undo',
  },
  share: {
    saveCard: 'share:saveCard',
  },
  sync: {
    status: 'sync:status',
    chooseFolder: 'sync:chooseFolder',
    disable: 'sync:disable',
    setDeviceName: 'sync:setDeviceName',
    preview: 'sync:preview',
    apply: 'sync:apply',
    conflicts: 'sync:conflicts',
    resolve: 'sync:resolve',
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
  'command-palette',
  'quick-capture',
  'pick-for-me',
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

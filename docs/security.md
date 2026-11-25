# Security model

Maybe Pile is a local-first desktop app: the library lives on the user's computer and nothing is collected. Security work focuses on keeping the Electron renderer contained, treating every external input as untrusted, and protecting the user's data and API keys.

## Threat model

| Threat | Where it could come from | Mitigation |
| --- | --- | --- |
| Script injection in the UI | Provider text (titles, summaries), imported JSON/CSV, theme/layout files | React renders text only. ESLint bans `dangerouslySetInnerHTML` and `innerHTML`. Provider HTML is stripped to plain text (`htmlToPlainText`). Strict CSP with no inline or remote script. |
| Renderer compromise escalating to the OS | Any of the above if they slipped through | `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webviewTag`. The preload exposes only enumerated methods, and every IPC payload is validated in main with sender checks. |
| Malicious theme/layout files | Shared files | Strict Zod schemas: hex colours only, bounded numbers, enum fonts. Values are applied via `style.setProperty` with property names from a fixed table. Nothing is ever evaluated as CSS, JS or URLs. Files are capped at 64 KB / 32 KB. |
| Malicious backups (zip bombs, path traversal) | `.mpbackup` from elsewhere | Entry-name allowlist (`manifest.json`, `library.sqlite`, `artwork/<sha256>.(jpg\|png)`). Size, ratio and entry-count limits. SHA-256 checksums. SQLite `integrity_check` and `foreign_key_check` run on a staged copy before the live library is touched. |
| CSV/formula injection when exports are opened in a spreadsheet | User data in CSV | Cells starting with `= + - @ TAB CR` get a `'` prefix. The importer reverses this. |
| Dangerous links | Provider data, user-entered IDs | Links are re-validated in main at click time: https only, no credentials, no custom ports, at most 2048 characters, per-kind host allowlist. They open via `shell.openExternal`, never in-app. |
| API key leakage | Logs, exports, backups, renderer | Keys are stored outside the DB (`secrets.json`), encrypted with `safeStorage`, and are write-only from the renderer, which can only see whether a key is set. The logger redacts key-like values and sensitive fields, and redaction runs again on export. |
| Arbitrary file read/write via IPC | Renderer | The renderer never passes paths. Files are chosen in native dialogs run by main, or are app-managed. The artwork protocol serves only `^[a-f0-9]{64}(\.thumb)?\.(jpg\|png)$` from the artwork folder. |
| Steam key / account leakage | Library sources | The key is a normal provider secret (`steam.apiKey` in `secrets.json`, encrypted, write-only). Library-source rows hold the account as typed and the resolved SteamID64, never the key. Logs redact 32-hex keys and SteamID64s. Requests are never logged. |
| Malicious import files (Goodreads/Letterboxd/CSV, game lists) | Files from elsewhere | 25 MB / 50,000-row caps, ZIP entries filtered by name and capped at 20 MB, strict CSV parsing. Cells are text only: never evaluated, URLs never fetched or opened. Formula prefixes are neutralized again on CSV export. |
| Global shortcut abuse | Settings | Opt-in only, accelerator validated against a strict pattern, registration failure tolerated, unregistered on change/quit. |
| Data loss | Crashes, failed migrations/restores | WAL with transactions. Pre-migration and pre-restore snapshots. Atomic temp-then-rename writes with fsync. Restores swap files by rename, with rollback. |

## Electron hardening checklist

- [x] `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `nodeIntegrationInSubFrames: false`, `sandbox: true`, `webviewTag: false`, `webSecurity: true` (`src/main/security/policy.ts → secureWebPreferences`, asserted by `tests/unit/security.test.ts` and checked live in the e2e launch).
- [x] Sandbox-compatible preload: it imports only `electron` and is bundled to a single CJS file.
- [x] The renderer is loaded from a privileged custom scheme `app://maybepile/`, which serves files only inside `dist/renderer` (traversal tested).
- [x] CSP is sent as a response header: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: maybepile-art:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The dev-server CSP (only when `MAYBEPILE_DEV_SERVER_URL` is set and the app is unpacked) also allows inline styles and the Vite websocket.
- [x] `will-navigate` and `will-redirect` block anything outside the app origin. `setWindowOpenHandler` denies all new windows; valid https links are routed to the external opener. `will-attach-webview` is prevented, including for any later webContents.
- [x] Permission request, check and device handlers all deny by default.
- [x] A single-instance lock means only one process opens the database.
- [x] Cached artwork is served through the read-only `maybepile-art://` protocol (`file/`, `remote/`, `preview/` hosts). Remote images are fetched by main from allowlisted provider hosts only, so the renderer never touches the network.
- [x] Every IPC handler checks the sender (`senderFrame.url` origin must be the app origin, the frame must be the main frame, and the `webContents.id` must be the main window's). It then validates the payload with Zod and returns `Result<T>` with a user-safe error (`{ code, message, recovery?, fieldErrors? }`). Unexpected errors are logged and returned as a generic message, never as a stack or path.
- [x] No `eval`, `new Function` or dynamic import of user content (ESLint `no-eval`, `no-implied-eval`, `no-new-func`).
- [x] Renderer code cannot import Node, Electron or main-process modules (ESLint `no-restricted-imports`).

## External link policy

`src/domain/links.ts` and `src/main/security/policy.ts → checkOpenExternal`:

- Only `https:` is allowed. No provider needs `http:`, so there is no exception.
- Hosts must be in the allowlist: `www.imdb.com`, `www.themoviedb.org`, `www.justwatch.com`, `store.steampowered.com`, `www.xbox.com`, `apps.microsoft.com`, `store.playstation.com`, `www.tvmaze.com`, `openlibrary.org`, `www.igdb.com`, plus documentation hosts for attribution and sign-up links.
- URLs with credentials, custom ports, control characters, or more than 2048 characters are rejected. `javascript:`, `file:`, `data:`, `ftp:` and custom schemes are always rejected.
- The URL is checked again immediately before `shell.openExternal`.

## Secret handling

- Storage is `<userData>/secrets.json`, and each value is encrypted with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). Availability is checked with `isAsyncEncryptionAvailable()`. On Linux the `basic_text` backend counts as unavailable.
- Fallback: if OS encryption is unavailable, values are stored base64-encoded (not encrypted) and Settings → Providers shows a warning.
- The Steam Web API key (1.2) uses the same storage under `steam.apiKey`. It is set and cleared through `sources:saveSteam` / `sources:clearSteamKey`; responses only report `keySet: true/false`. Tests assert it never appears in IPC responses, logs, the database, JSON exports or `.mpbackup` files (`tests/integration/steam-import.test.ts`, `feature-pack.test.ts`).
- For developers, environment variables `MAYBEPILE_TMDB_API_KEY`, `MAYBEPILE_IGDB_CLIENT_ID` and `MAYBEPILE_IGDB_CLIENT_SECRET`, or a JSON file named by `MAYBEPILE_PROVIDER_CONFIG`, take precedence.
- Keys are never in the DB, exports, backups, logs or the renderer. Tests assert this in `provider-service.test.ts → "secrets never leak"`.

## Network

The app contacts only these hosts, and only on explicit user action (search, import, refresh, availability check, opening an artwork that is remote-only):

`api.themoviedb.org`, `image.tmdb.org`, `api.tvmaze.com`, `static.tvmaze.com`, `openlibrary.org`, `covers.openlibrary.org` (which may redirect to `archive.org` image servers), `id.twitch.tv`, `api.igdb.com`, `images.igdb.com`, `www.wikidata.org`, `graphql.anilist.co`, `s4.anilist.co`, and (1.2) `api.steampowered.com` for Steam library import (only with your own key, only when you press Test / Load / Sync).

All network calls are made by the main process through the injectable HTTP client and per-host rate limiters. The renderer's CSP keeps `connect-src 'self'`; no new renderer network access was added. Release Radar date refresh uses the existing metadata providers. Steam images are not loaded at all (see providers.md). Store links (`store.steampowered.com`) open only through the HTTPS allowlisted opener.

There are no update checks, analytics or crash reporting.

## IPC / preload API

The preload exposes `window.maybePile` with these namespaces: `app`, `settings`, `items`, `progress`, `catalog`, `providers`, `artwork`, `themes`, `layouts`, `data`, and (1.2) `pick`, `health`, `lists`, `stats`, `radar`, `sources`, `batches`, `tracker`, `goals`, plus `events.onMenuCommand(cb)`. The last one receives only the fixed menu command names. Every method maps to exactly one channel; there is no generic `invoke`. "Who may call" is the same for every row: only the main frame of the app window at `app://maybepile` (or the dev-server origin in unpacked dev mode). The table below is generated by `node scripts/run-ts.mjs scripts/gen-ipc-docs.ts`, and the API shape is snapshot-tested in `tests/unit/__snapshots__/security.test.ts.snap`.

<!-- IPC-TABLE:START -->
| Channel | Preload method | Purpose | Request (validated in main) | Response | Side effects |
| --- | --- | --- | --- | --- | --- |
| `app:info` | `app.info` | App/version/data-location info | — | `Result<…>` | none |
| `app:openDataFolder` | `app.openDataFolder` | Open the userData folder in the OS file manager | — | `Result<…>` | launches file manager |
| `app:openExternal` | `app.openExternal` | Open a validated https link in the default browser | { url } | `Result<…>` | shell.openExternal (allowlisted hosts only) |
| `app:exportLog` | `app.exportLog` | Save the redacted diagnostic log | — | `Result<…>` | save dialog → file write |
| `app:chooseBackupFolder` | `app.chooseBackupFolder` | Choose default export/backup folder | — | `Result<…>` | folder dialog → main-owned setting |
| `app:acknowledgeNotices` | `app.acknowledgeNotices` | Dismiss upgrade/recovery notices | — | `Result<…>` | in-memory |
| `settings:get` | `settings.get` | Read settings | — | `Result<…>` | none |
| `settings:update` | `settings.update` | Update non-secret settings (strict schema) | { activeThemeId, region, autoApplySuggestions, libraryView, libraryQuery, providerEnabled, csvBom, lastSeenSchemaVersion, upNextMax, pick, pileHealth, releaseRadar, quickCapture, stats, importUndoRetentionDays, anime, artwork, spoilers, value, sessions, availability, recommendations } | `Result<…>` | DB write |
| `items:query` | `items.query` | Search/filter/sort library page | { text, types, statuses, tags, tagMode, ratingMin, ratingMax, addedFrom, addedTo, sort, direction, offset, limit, listId, upNextOnly, health } | `Result<…>` | none |
| `items:get` | `items.get` | Item detail | { id } | `Result<…>` | none |
| `items:create` | `items.create` | Create item (duplicate check) | { type, meta, personal, seasons, milestones, allowDuplicate } | `Result<…>` | DB write |
| `items:update` | `items.update` | Edit metadata/personal fields (provenance → user) | { id, meta, personal } | `Result<…>` | DB write |
| `items:setStatus` | `items.setStatus` | Status change with confirmed options | { id, status, startNewPass, clearDateCompleted, fillRemaining } | `Result<…>` | DB write |
| `items:acceptSuggestion` | `items.acceptSuggestion` | Apply a status suggestion | { id, suggestion } | `Result<…>` | DB write |
| `items:setRating` | `items.setRating` | Set rating | { id, rating } | `Result<…>` | DB write |
| `items:delete` | `items.remove` | Soft-delete items (undoable) | { ids } | `Result<…>` | DB write |
| `items:undoDelete` | `items.undoRemove` | Undo soft delete | { ids } | `Result<…>` | DB write |
| `items:bulk` | `items.bulk` | Bulk status/tag/delete | discriminated union | `Result<…>` | DB write |
| `items:checkDuplicates` | `items.checkDuplicates` | Likely duplicates | { type, title, releaseDate, externalIds, excludeId } | `Result<…>` | none |
| `items:dashboard` | `items.dashboard` | Dashboard aggregates | — | `Result<…>` | none |
| `items:tags` | `items.tags` | Tag counts | — | `Result<…>` | none |
| `items:audit` | `items.audit` | Metadata audit log | { id } | `Result<…>` | none |
| `items:setUpNext` | `items.setUpNext` | Add to / remove from the Up Next queue | { id, queued } | `Result<…>` | DB write |
| `items:moveUpNext` | `items.moveUpNext` | Reorder the Up Next queue | { id, direction } | `Result<…>` | DB write |
| `items:pickRandom` | `items.pickRandom` | Random Planned item ("Pick something for me") | { types, excludeId } | `Result<…>` | none |
| `items:titles` | `items.titles` | Id/title/type list for the command palette | — | `Result<…>` | none |
| `items:quickCapture` | `items.quickCapture` | Quick Capture: add a Planned item (same validation as Add) | { title, type, allowDuplicate } | `Result<…>` | DB write |
| `pick:roll` | `pick.roll` | Weighted constraint-aware pick | { constraints, avoid, seed } | `Result<…>` | DB write (pick history) |
| `pick:respond` | `pick.respond` | Start / Not now / Add to Up Next for a pick | { historyId, outcome } | `Result<…>` | DB write |
| `pick:history` | `pick.history` | Recent picks | — | `Result<…>` | none |
| `pick:clearSkips` | `pick.clearSkips` | Clear "Not now" skips | — | `Result<…>` | DB write |
| `health:overview` | `health.overview` | Stale items, snoozes and pile stats | — | `Result<…>` | none |
| `health:snooze` | `health.snooze` | Snooze items until a date | { ids, until } | `Result<…>` | DB write |
| `health:unsnooze` | `health.unsnooze` | Remove snoozes | { ids } | `Result<…>` | DB write |
| `health:keep` | `health.keep` | Keep: stop nudging for one threshold period | { ids } | `Result<…>` | DB write |
| `lists:list` | `lists.list` | Custom lists with counts | — | `Result<…>` | none |
| `lists:get` | `lists.get` | List detail with ordered items | { id } | `Result<…>` | none |
| `lists:save` | `lists.save` | Create/rename a list | { id, name, description, color, icon } | `Result<…>` | DB write |
| `lists:delete` | `lists.remove` | Delete a list (items are kept) | { id } | `Result<…>` | DB write |
| `lists:move` | `lists.move` | Reorder lists | { id, direction } | `Result<…>` | DB write |
| `lists:setMembership` | `lists.setMembership` | Add/remove items to a list | { listId, itemIds, member } | `Result<…>` | DB write |
| `lists:moveItem` | `lists.moveItem` | Reorder items inside a list | { listId, itemId, direction } | `Result<…>` | DB write |
| `stats:get` | `stats.get` | Stats aggregates (local only) | { year } | `Result<…>` | none |
| `stats:yearInReview` | `stats.yearInReview` | Year in Review summary | { year } | `Result<…>` | none |
| `stats:exportCsv` | `stats.exportCsv` | Save one chart's data as CSV | { chart, year } | `Result<…>` | save dialog → file write |
| `stats:saveImage` | `stats.saveImage` | Save a chart region as PNG | { name, rect } | `Result<…>` | window capture → save dialog → file write |
| `stats:heatmap` | `stats.heatmap` | Completion heatmap for a year (all runs) | { year } | `Result<…>` | none |
| `radar:upcoming` | `radar.upcoming` | Upcoming releases | — | `Result<…>` | none |
| `radar:refreshPreview` | `radar.refreshPreview` | Re-fetch release dates (diff only) | — | `Result<…>` | network (provider, rate-limited) |
| `radar:refreshApply` | `radar.refreshApply` | Apply chosen release-date updates | { token, choices } | `Result<…>` | DB write |
| `radar:exportIcs` | `radar.exportIcs` | Export upcoming releases as .ics | — | `Result<…>` | save dialog → file write |
| `sources:list` | `sources.list` | Library sources (Steam/manual) with counts; key presence only | — | `Result<…>` | none |
| `sources:saveSteam` | `sources.saveSteam` | Save Steam account + key (key → safeStorage) | { sourceId, label, account, apiKey } | `Result<…>` | secrets write, DB write |
| `sources:clearSteamKey` | `sources.clearSteamKey` | Forget the Steam key | — | `Result<…>` | secrets write |
| `sources:delete` | `sources.remove` | Delete a library source and its snapshot (items kept) | { sourceId } | `Result<…>` | DB write |
| `sources:testSteam` | `sources.testSteam` | Test the Steam connection | { sourceId } | `Result<…>` | network (api.steampowered.com) |
| `sources:startFetch` | `sources.startFetch` | Start a Steam library fetch job | { sourceId } | `Result<…>` | network, DB write (snapshot) |
| `sources:fetchStatus` | `sources.fetchStatus` | Poll a fetch job | { jobId } | `Result<…>` | none |
| `sources:cancelFetch` | `sources.cancelFetch` | Cancel a fetch job | { jobId } | `Result<…>` | aborts request |
| `sources:entries` | `sources.entries` | Review list for a source snapshot | { sourceId, view, search, showNonGames, sort, direction } | `Result<…>` | none |
| `sources:setIgnored` | `sources.setIgnored` | Ignore / un-ignore entries | { sourceId, externalIds, ignored } | `Result<…>` | DB write |
| `sources:import` | `sources.importSelected` | Import selected entries as items (batched, undoable) | { sourceId, externalIds, status, tags, listId, importPlaytime, enrich } | `Result<…>` | DB write (+ optional provider lookups) |
| `sources:diff` | `sources.diff` | Re-sync diff (new / playtime / removed) | { sourceId } | `Result<…>` | none |
| `sources:applyPlaytime` | `sources.applyPlaytime` | Record Steam playtime as new hours entries (opt-in) | { sourceId, externalIds } | `Result<…>` | DB write |
| `sources:loadManual` | `sources.loadManual` | Create/update a pasted game list | { sourceId, label, text } | `Result<…>` | DB write |
| `sources:loadManualFile` | `sources.loadManualFile` | Load a game list from a chosen file | { sourceId, label } | `Result<…>` | open dialog → file read, DB write |
| `batches:list` | `batches.list` | Recent import batches | — | `Result<…>` | none |
| `batches:undoPreview` | `batches.undoPreview` | What undo would remove / keep | { batchId } | `Result<…>` | none |
| `batches:undo` | `batches.undo` | Undo an import (untouched items only) | { batchId } | `Result<…>` | DB write |
| `tracker:preview` | `tracker.preview` | Preview a Goodreads/Letterboxd/CSV import | { kind, profileId } | `Result<…>` | open dialog → file read |
| `tracker:remap` | `tracker.remap` | Re-map CSV columns | { mapToken, previousToken, mapping } | `Result<…>` | none |
| `tracker:apply` | `tracker.apply` | Apply a tracker import | { token, defaultResolution, resolutions, confirmation } | `Result<…>` | DB transaction |
| `tracker:profiles` | `tracker.profiles` | CSV mapping profiles | — | `Result<…>` | none |
| `tracker:saveProfile` | `tracker.saveProfile` | Save a mapping profile | { name, mapping } | `Result<…>` | DB write |
| `tracker:deleteProfile` | `tracker.deleteProfile` | Delete a mapping profile | { id } | `Result<…>` | DB write |
| `goals:list` | `goals.list` | Goals with progress and pace | { includeArchived } | `Result<…>` | none |
| `goals:save` | `goals.save` | Create/edit a goal | { id, title, mediaType, metric, period, startDate, endDate, target, listId, tag } | `Result<…>` | DB write |
| `goals:archive` | `goals.archive` | Archive/unarchive a goal | { id, archived } | `Result<…>` | DB write |
| `goals:delete` | `goals.remove` | Delete a goal | { id } | `Result<…>` | DB write |
| `progress:add` | `progress.add` | Add progress entry | { itemId, entry, occurredAt, note } | `Result<…>` | DB write |
| `progress:edit` | `progress.edit` | Edit history entry | { eventId, occurredAt, note, value, text } | `Result<…>` | DB write |
| `progress:remove` | `progress.remove` | Delete history entry | { eventId } | `Result<…>` | DB write |
| `progress:history` | `progress.history` | List history | { itemId } | `Result<…>` | none |
| `progress:addViewing` | `progress.addViewing` | Log movie viewing | { itemId, watchedAt, note } | `Result<…>` | DB write |
| `progress:editViewing` | `progress.editViewing` | Edit viewing | { viewingId, watchedAt, note } | `Result<…>` | DB write |
| `progress:removeViewing` | `progress.removeViewing` | Delete viewing | { viewingId } | `Result<…>` | DB write |
| `progress:viewings` | `progress.viewings` | List viewings | { itemId } | `Result<…>` | none |
| `progress:toggleEpisodes` | `progress.toggleEpisodes` | Mark episodes (un)watched | { itemId, episodeIds, watched, scope } | `Result<…>` | DB write |
| `progress:upsertSeason` | `progress.upsertSeason` | Add/edit season | { itemId, seasonId, number, title, episodeCountKnown } | `Result<…>` | DB write |
| `progress:deleteSeason` | `progress.deleteSeason` | Delete season | { itemId, seasonId } | `Result<…>` | DB write |
| `progress:upsertEpisode` | `progress.upsertEpisode` | Add/edit episode | { itemId, seasonId, episodeId, number, title, airDate, runtime } | `Result<…>` | DB write |
| `progress:deleteEpisode` | `progress.deleteEpisode` | Delete episode | { itemId, episodeId } | `Result<…>` | DB write |
| `progress:setMilestones` | `progress.setMilestones` | Replace game milestones | { itemId, milestones } | `Result<…>` | DB write |
| `progress:setScheme` | `progress.setScheme` | Switch game progress scheme | { itemId, scheme } | `Result<…>` | DB write |
| `customFields:list` | `catalog.customFields` | List custom fields | — | `Result<…>` | none |
| `customFields:save` | `catalog.saveCustomField` | Create/edit custom field | { id, name, type, options } | `Result<…>` | DB write |
| `customFields:delete` | `catalog.deleteCustomField` | Delete custom field | { id } | `Result<…>` | DB write |
| `series:list` | `catalog.series` | List book series | — | `Result<…>` | none |
| `series:save` | `catalog.saveSeries` | Create/edit series | { id, name, description, totalKnown } | `Result<…>` | DB write |
| `series:delete` | `catalog.deleteSeries` | Delete series | { id } | `Result<…>` | DB write |
| `series:setMembership` | `catalog.setSeriesMembership` | Add/remove book in series | { seriesId, itemId, position, member } | `Result<…>` | DB write |
| `providers:list` | `providers.list` | Provider info (keys: set/unset only) | — | `Result<…>` | none |
| `providers:search` | `providers.search` | Search a provider | { providerId, type, query, year } | `Result<…>` | network (provider API) |
| `providers:preview` | `providers.preview` | Fetch details for import preview | { providerId, id, type } | `Result<…>` | network |
| `providers:import` | `providers.importPreviewed` | Import the previewed item | { previewToken, status, tags, allowDuplicate } | `Result<…>` | network (artwork) + DB write + artwork file |
| `providers:refreshPreview` | `providers.refreshPreview` | Compare current vs provider metadata | { itemId } | `Result<…>` | network |
| `providers:refreshApply` | `providers.refreshApply` | Apply per-field refresh choices | { token, choices } | `Result<…>` | DB write |
| `providers:setKey` | `providers.setKey` | Store/clear an API key (write-only) | { providerId, field, value } | `Result<…>` | secrets.json write |
| `providers:setEnabled` | `providers.setEnabled` | Enable/disable provider | { providerId, enabled } | `Result<…>` | DB write |
| `providers:watch` | `providers.watch` | Where-to-watch for a region (TMDB) | { itemId, region } | `Result<…>` | network |
| `artwork:chooseLocal` | `artwork.chooseLocal` | Pick a local image | { itemId } | `Result<…>` | open dialog → artwork file + DB |
| `artwork:remove` | `artwork.remove` | Remove item artwork | { itemId } | `Result<…>` | DB write + artwork GC |
| `artwork:retry` | `artwork.retry` | Cache remote artwork (cache-allowed providers) | { itemId } | `Result<…>` | network + artwork file |
| `artwork:slots` | `artwork.slots` | Selected art per slot (cover/banner/logo/icon/background) | { itemId } | `Result<…>` | none |
| `artwork:gallery` | `artwork.gallery` | Fetch candidate art from all sources in parallel (tokens only) | { itemId } | `Result<…>` | network (allowlisted art sources) |
| `artwork:choose` | `artwork.choose` | Apply a gallery choice as the user’s selection | { itemId, token } | `Result<…>` | image fetch (cache-allowed only) → DB write |
| `artwork:revert` | `artwork.revert` | Clear the user’s choice and auto-pick again | { itemId, slot } | `Result<…>` | network → DB write |
| `artwork:clearSlot` | `artwork.clearSlot` | Remove the image from a slot | { itemId, slot } | `Result<…>` | DB write |
| `artwork:autoPick` | `artwork.autoPick` | Auto-pick art for an item (never over a user choice) | { itemId, slots } | `Result<…>` | network → DB write |
| `artwork:bulkAutoPick` | `artwork.bulkAutoPick` | Auto-pick art for many items (sequential, rate-limited) | { itemIds, slots } | `Result<…>` | network → DB writes |
| `anime:searchAll` | `anime.searchAll` | Search all enabled anime sources and merge by cross ids | { query, year } | `Result<…>` | network (enabled anime sources) |
| `pileTime:item` | `pileTime.item` | Time estimate for an item, with source and confidence | { itemId } | `Result<…>` | none |
| `pileTime:totals` | `pileTime.totals` | Backlog time totals by type and confidence | — | `Result<…>` | none |
| `pileTime:fits` | `pileTime.fits` | Unfinished items that fit a time budget | { budgetMinutes, types, moodIds } | `Result<…>` | none |
| `pileTime:setManual` | `pileTime.setManual` | Set/clear the user’s own estimate | { itemId, minutes } | `Result<…>` | DB write |
| `pileTime:fetchIgdb` | `pileTime.fetchIgdb` | Fetch typical time-to-beat from IGDB (user keys) | { itemId } | `Result<…>` | network (IGDB) → DB write |
| `moods:list` | `moods.list` | List moods | — | `Result<…>` | none |
| `moods:create` | `moods.create` | Create a custom mood | { name, icon, color } | `Result<…>` | DB write |
| `moods:update` | `moods.update` | Rename/recolor/hide a mood | { id, name, icon, color, hidden } | `Result<…>` | DB write |
| `moods:delete` | `moods.remove` | Delete a custom mood | { id } | `Result<…>` | DB write |
| `moods:reorder` | `moods.reorder` | Reorder moods | { ids } | `Result<…>` | DB write |
| `moods:forItem` | `moods.forItem` | Moods on an item | { itemId } | `Result<…>` | none |
| `moods:setForItem` | `moods.setForItem` | Replace an item’s moods | { itemId, moodIds } | `Result<…>` | DB write |
| `moods:bulk` | `moods.bulk` | Add/remove a mood on many items | { itemIds, moodId, add } | `Result<…>` | DB transaction |
| `itemExtras:prefs` | `itemExtras.prefs` | Item preferences (spoilers, hours source, sub/dub) | { itemId } | `Result<…>` | none |
| `itemExtras:setPrefs` | `itemExtras.setPrefs` | Update item preferences | { itemId, spoilerMode, notesSpoiler, hoursSource, audioPref } | `Result<…>` | DB write |
| `itemExtras:runs` | `itemExtras.runs` | Run (rewatch/replay) history | { itemId } | `Result<…>` | DB write (syncs current run) |
| `itemExtras:updateRun` | `itemExtras.updateRun` | Edit a finished run | { itemId, runNumber, dateStarted, dateCompleted, rating, notes } | `Result<…>` | DB write |
| `itemExtras:streaming` | `itemExtras.streaming` | Provider-documented streaming links (allowlisted hosts) | { itemId } | `Result<…>` | none |
| `itemExtras:relations` | `itemExtras.relations` | Linked items (sequel, spin-off…) | { itemId } | `Result<…>` | none |
| `itemExtras:addRelation` | `itemExtras.addRelation` | Link two items | { itemId, otherId, relation } | `Result<…>` | DB write |
| `itemExtras:removeRelation` | `itemExtras.removeRelation` | Unlink two items | { itemId, relationId } | `Result<…>` | DB write |
| `itemExtras:suggestions` | `itemExtras.suggestions` | Pending provider relation suggestions | { itemId } | `Result<…>` | none |
| `itemExtras:resolveSuggestion` | `itemExtras.resolveSuggestion` | Accept/dismiss a relation suggestion | { itemId, suggestionId, accept } | `Result<…>` | DB write |
| `itemExtras:franchisesForItem` | `itemExtras.franchisesForItem` | Series containing an item, with Next in series | { itemId } | `Result<…>` | none |
| `franchises:list` | `franchises.list` | List series/franchises | — | `Result<…>` | none |
| `franchises:get` | `franchises.get` | Series detail | { id } | `Result<…>` | none |
| `franchises:create` | `franchises.create` | Create a series | { name, itemIds } | `Result<…>` | DB transaction |
| `franchises:update` | `franchises.update` | Rename / toggle order | { id, name, respectOrder } | `Result<…>` | DB write |
| `franchises:setEntries` | `franchises.setEntries` | Replace ordered entries | { id, entries } | `Result<…>` | DB transaction |
| `franchises:delete` | `franchises.remove` | Delete a series (items kept) | { id } | `Result<…>` | DB write |
| `value:list` | `value.list` | Purchases for an item | { itemId } | `Result<…>` | none |
| `value:add` | `value.add` | Add a purchase (minor units + currency) | { itemId, purchase } | `Result<…>` | DB write |
| `value:update` | `value.update` | Edit a purchase | { id, purchase } | `Result<…>` | DB write |
| `value:delete` | `value.remove` | Delete a purchase | { id } | `Result<…>` | DB write |
| `value:summary` | `value.summary` | Per-currency totals (no conversion) | — | `Result<…>` | none |
| `sessions:open` | `sessions.open` | Running/paused timers | — | `Result<…>` | none |
| `sessions:forItem` | `sessions.forItem` | Sessions for an item | { itemId } | `Result<…>` | none |
| `sessions:start` | `sessions.start` | Start a timer (pauses any running timer) | { itemId } | `Result<…>` | DB transaction |
| `sessions:pause` | `sessions.pause` | Pause a timer | { id } | `Result<…>` | DB write |
| `sessions:resume` | `sessions.resume` | Resume a timer | { id } | `Result<…>` | DB transaction |
| `sessions:stop` | `sessions.stop` | Stop a timer (optional correction) | { id, adjustedSeconds, note } | `Result<…>` | DB transaction (+ hours if source = sessions) |
| `sessions:log` | `sessions.log` | Log a past session | { itemId, startedAt, seconds, note } | `Result<…>` | DB transaction |
| `sessions:edit` | `sessions.edit` | Edit a finished session | { id, seconds, note } | `Result<…>` | DB transaction |
| `sessions:delete` | `sessions.remove` | Delete a session | { id } | `Result<…>` | DB transaction |
| `availability:services` | `availability.services` | List services | — | `Result<…>` | none |
| `availability:addService` | `availability.addService` | Add a service | { name, kind } | `Result<…>` | DB write |
| `availability:updateService` | `availability.updateService` | Edit a service | { id, name, kind, active } | `Result<…>` | DB write |
| `availability:removeService` | `availability.removeService` | Delete a service | { id } | `Result<…>` | DB write |
| `availability:forItem` | `availability.forItem` | Ownership/availability for an item | { itemId } | `Result<…>` | none |
| `availability:add` | `availability.add` | Add an availability entry | { itemId, entry } | `Result<…>` | DB write |
| `availability:update` | `availability.update` | Edit an availability entry | { id, entry } | `Result<…>` | DB write |
| `availability:delete` | `availability.remove` | Delete an availability entry | { id } | `Result<…>` | DB write |
| `availability:leavingSoon` | `availability.leavingSoon` | Unfinished items whose access ends soon | — | `Result<…>` | none |
| `recs:list` | `recs.list` | Offline, explained recommendations from the pile | { limit, types } | `Result<…>` | none |
| `recs:feedback` | `recs.feedback` | Not now / Not interested | { itemId, kind } | `Result<…>` | DB write |
| `recs:clearFeedback` | `recs.clearFeedback` | Reset recommendation feedback | — | `Result<…>` | DB write |
| `merge:pairs` | `merge.pairs` | Possible duplicate pairs | — | `Result<…>` | none |
| `merge:dismiss` | `merge.dismiss` | Mark a pair as not duplicates | { keepId, removeId } | `Result<…>` | DB write |
| `merge:preview` | `merge.preview` | Field-by-field merge preview | { keepId, removeId } | `Result<…>` | none |
| `merge:apply` | `merge.apply` | Merge two items (full snapshot for undo) | { keepId, removeId, fields } | `Result<…>` | DB transaction |
| `merge:lastUndoable` | `merge.lastUndoable` | Most recent undoable merge | — | `Result<…>` | none |
| `merge:undo` | `merge.undo` | Undo a merge from its snapshot | { id } | `Result<…>` | DB transaction |
| `share:saveCard` | `share.saveCard` | Save a locally drawn share card PNG (validated in main) | { name, pngBase64 } | `Result<…>` | save dialog → file write |
| `sync:status` | `sync.status` | Sync folder status, devices, open conflicts | — | `Result<…>` | reads sync folder |
| `sync:chooseFolder` | `sync.chooseFolder` | Choose the sync folder (native dialog in main) | — | `Result<…>` | folder dialog → settings |
| `sync:disable` | `sync.disable` | Turn sync off | — | `Result<…>` | settings write |
| `sync:setDeviceName` | `sync.setDeviceName` | Rename this device | { name } | `Result<…>` | settings write |
| `sync:preview` | `sync.preview` | Dry run: outgoing, incoming, conflicts (writes nothing) | — | `Result<…>` | reads sync folder |
| `sync:apply` | `sync.apply` | Apply sync (snapshot → transaction → append own log) | — | `Result<…>` | DB snapshot + transaction; writes own .jsonl |
| `sync:conflicts` | `sync.conflicts` | Open sync conflicts | — | `Result<…>` | none |
| `sync:resolve` | `sync.resolve` | Keep mine / take theirs | { id, choice } | `Result<…>` | DB transaction |
| `themes:list` | `themes.list` | List themes | — | `Result<…>` | none |
| `themes:get` | `themes.get` | Theme tokens + contrast warnings | { id } | `Result<…>` | none |
| `themes:active` | `themes.active` | Resolved active theme (with fallback) | — | `Result<…>` | may reset setting to fallback |
| `themes:save` | `themes.save` | Create/update custom theme (validated) | { id, name, tokens } | `Result<…>` | DB write |
| `themes:duplicate` | `themes.duplicate` | Duplicate a theme | { id } | `Result<…>` | DB write |
| `themes:delete` | `themes.remove` | Delete custom theme | { id } | `Result<…>` | DB write |
| `themes:import` | `themes.importFile` | Import .mptheme.json (validated, never executed) | — | `Result<…>` | open dialog → DB write |
| `themes:export` | `themes.exportFile` | Export theme file | { id } | `Result<…>` | save dialog → file write |
| `themes:reset` | `themes.reset` | Reset to System (optionally delete custom) | { deleteCustom } | `Result<…>` | DB write |
| `layouts:get` | `layouts.get` | Dashboard/library layouts | — | `Result<…>` | none |
| `layouts:set` | `layouts.set` | Save layout (whitelisted ids, repaired) | { surface, entries } | `Result<…>` | DB write |
| `layouts:reset` | `layouts.reset` | Reset layout(s) | { surface } | `Result<…>` | DB write |
| `layouts:import` | `layouts.importFile` | Import .mplayout.json (validated) | — | `Result<…>` | open dialog → DB write |
| `layouts:export` | `layouts.exportFile` | Export layout file | — | `Result<…>` | save dialog → file write |
| `data:exportJson` | `data.exportJson` | JSON export | — | `Result<…>` | save dialog → file write |
| `data:exportCsv` | `data.exportCsv` | CSV export | — | `Result<…>` | save dialog → file write |
| `data:importPreview` | `data.importPreview` | Validate JSON/CSV/backup and stage preview | { kind } | `Result<…>` | open dialog → read; backup staged in temp folder |
| `data:importApply` | `data.importApply` | Apply staged import/restore (typed confirm for restore) | { token, defaultResolution, resolutions, confirmation, kind } | `Result<…>` | DB transaction / atomic swap + pre-restore snapshot |
| `data:importCancel` | `data.importCancel` | Discard staged import/restore | { token, kind } | `Result<…>` | temp cleanup |
| `data:backupCreate` | `data.backupCreate` | Create .mpbackup | — | `Result<…>` | save dialog → file write |
| `data:backupList` | `data.backupList` | List safety snapshots | — | `Result<…>` | none |
| `data:restoreInternalPreview` | `data.restoreInternalPreview` | Preview restoring a safety snapshot | { label } | `Result<…>` | staging in temp folder |
<!-- IPC-TABLE:END -->


## Expansion Pack 2 additions

- **New keys:** MyAnimeList client ID, fanart.tv personal/project keys, SteamGridDB key. All are stored with `safeStorage` (like TMDB/IGDB) and sent only as request **headers** (`X-MAL-CLIENT-ID`, `client-key`/`api-key`, `Authorization: Bearer`), never in URLs, logs or exports.
- **Image fetching** is main-process only, with per-source host allowlists. Redirects are manual: at most 3 hops, same host or declared host only. Electron's `net.fetch` can't do manual redirects, so `src/main/electron-fetch.ts` uses `net.request` and its `redirect` event; this is verified in `tests/e2e/pack2.spec.ts`. Further limits: byte caps, header-based pixel caps before decoding, a magic-byte allowlist (SVG rejected), re-encoding to strip EXIF, and SHA-256 file names. The remote proxy (`maybepile-art://remote|preview`) applies the same magic-byte and dimension checks before passing bytes to the renderer.
- **The renderer never sees remote image URLs:** artwork candidates are 128-bit random tokens, mapped in main.
- **MAL XML import** rejects DOCTYPE/ENTITY declarations (XXE), decodes only built-in entities, and caps decompressed size (60 MB, checking the gzip ISIZE first) and entry count.
- **Share card PNGs** from the renderer are re-validated in main (magic bytes, dimensions, size) before being written through the save dialog.
- **E2E hook:** when `MAYBEPILE_E2E_HOOKS=1`, main exposes its HTTP client on a main-process global for the Playwright suite. The renderer can't reach main globals, and the variable is never set in normal use.
- **IPC:** 80 new channels, each with a strict Zod request schema validated in main. The table above is regenerated by `scripts/gen-ipc-docs.ts`, and the preload snapshot test was updated (additions only).
- **Sync folder:** the path comes only from main's native folder dialog. `settings:update` rejects the `sync` key. Logs of other devices are size-capped and validated line by line (Zod). Only file names matching `<uuid>.jsonl` are read, and only this device's own file is written (temp file + rename). A database snapshot is taken before every apply.

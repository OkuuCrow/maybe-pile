# Security model

Maybe Pile is a local-first desktop app. It has no accounts, no server, and no telemetry. Security work focuses on keeping the Electron renderer contained, treating every external input as untrusted, and protecting the user's data and API keys.

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
- For developers, environment variables `MAYBEPILE_TMDB_API_KEY`, `MAYBEPILE_IGDB_CLIENT_ID` and `MAYBEPILE_IGDB_CLIENT_SECRET`, or a JSON file named by `MAYBEPILE_PROVIDER_CONFIG`, take precedence.
- Keys are never in the DB, exports, backups, logs or the renderer. Tests assert this in `provider-service.test.ts → "secrets never leak"`.

## Network

The app contacts only these hosts, and only on explicit user action (search, import, refresh, availability check, opening an artwork that is remote-only):

`api.themoviedb.org`, `image.tmdb.org`, `api.tvmaze.com`, `static.tvmaze.com`, `openlibrary.org`, `covers.openlibrary.org` (which may redirect to `archive.org` image servers), `id.twitch.tv`, `api.igdb.com`, `images.igdb.com`.

There are no update checks, analytics or crash reporting.

## IPC / preload API

The preload exposes `window.maybePile` with these namespaces: `app`, `settings`, `items`, `progress`, `catalog`, `providers`, `artwork`, `themes`, `layouts`, `data`, and `events.onMenuCommand(cb)`. The last one receives only the fixed menu command names. Every method maps to exactly one channel; there is no generic `invoke`. "Who may call" is the same for every row: only the main frame of the app window at `app://maybepile` (or the dev-server origin in unpacked dev mode). The table below is generated by `node scripts/run-ts.mjs scripts/gen-ipc-docs.ts`, and the API shape is snapshot-tested in `tests/unit/__snapshots__/security.test.ts.snap`.

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
| `settings:update` | `settings.update` | Update non-secret settings (strict schema) | { activeThemeId, region, autoApplySuggestions, libraryView, libraryQuery, providerEnabled, csvBom, lastSeenSchemaVersion } | `Result<…>` | DB write |
| `items:query` | `items.query` | Search/filter/sort library page | { text, types, statuses, tags, tagMode, ratingMin, ratingMax, addedFrom, addedTo, sort, direction, offset, limit } | `Result<…>` | none |
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

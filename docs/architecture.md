# Architecture

## Processes and layers

```
┌──────────────────────── Renderer (sandboxed Chromium) ────────────────────────┐
│ React + TypeScript (src/renderer)                                              │
│  app/  shell, hash router, theme engine, toasts, shortcuts                     │
│  features/  dashboard · library · item · add · settings                        │
│  components/  Dialog, Fields, StatusBadge, ProgressBar, Cover …                │
│  Uses only window.maybePile (typed: MaybePileApi)                              │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │ typed call, e.g. maybePile.items.create(input)
┌──────────────▼──────────────── Preload (sandboxed) ───────────────────────────┐
│ src/preload/preload.ts: contextBridge exposes API_SHAPE methods only           │
│ each method → ipcRenderer.invoke(<its fixed channel>, payload)                 │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │ ipcRenderer.invoke
┌──────────────▼──────────────── Main process (Node/Electron) ──────────────────┐
│ ipc/register.ts  dispatch(channel, sender, payload)                            │
│    1. sender check (origin app://maybepile, main frame, our webContents)      │
│    2. Zod validate + normalize (REQUEST_SCHEMAS)                               │
│    3. handler → services → Result<T, UserSafeError>                            │
│ ipc/handlers.ts  channel → service (dialogs/shell via injected Platform)       │
│ services/  library · progress · provider · artwork · import · export ·         │
│            backup · customization · catalog · secrets · logger · db-manager    │
│ security/  window prefs, CSP, navigation, external-link policy                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ domain/ (pure)  status rules · progress math · metadata merge · links ·        │
│                 csv · themes · layouts · contrast · dates · normalization      │
│ db/  connection (node:sqlite) · migrations · repositories                      │
│ providers/  MetadataProvider + TMDB · TVmaze · Open Library · IGDB             │
│            one injectable HttpClient + per-provider RateLimiter                │
└──────┬───────────────────────────────┬─────────────────────────┬──────────────┘
       ▼                               ▼                         ▼
  SQLite library.sqlite (WAL)   Provider HTTPS APIs        Filesystem: userData/
                                (user-initiated only)      artwork, backups, logs;
                                                           user-chosen files via
                                                           native dialogs in main
```

Data flow for every request:

```
Renderer ──typed call──▶ Preload ──invoke──▶ Main dispatcher
                                              │ 1 validate + normalize (Zod)
                                              │ 2 authorize (sender frame, path policy)
                                              ▼
                       Service (domain rules) ──▶ Repositories ──▶ SQLite (transaction)
                                              ├──▶ Provider layer (HttpClient, mockable)
                                              └──▶ Filesystem (app-managed dirs / dialog paths)
Result<T, UserSafeError> back to the renderer; diagnostics go to the redacted local log.
```

## Key decisions

| Area | Decision | Why |
| --- | --- | --- |
| Shell | **Electron 45.4.1** (pinned, current stable major when built) | Required; bundles Node 24.22 and Chromium. |
| SQLite driver | **`node:sqlite`** (built into Node/Electron; SQLite 3.54.1, FTS5 enabled) | No native module, so no `@electron/rebuild`, no ASAR unpacking, and identical bundles for every OS/arch. Trade-off: the API is newer than better-sqlite3's and is marked "release candidate" in Node 24. We use only its stable core (`DatabaseSync`, prepared statements, `exec`). If it ever regressed, the `Db` wrapper in `src/db/connection.ts` is the only place to swap to better-sqlite3. |
| Migrations | Small versioned runner (`src/db/migrate.ts`) over SQL modules | Ordered, contiguous, checksummed, one transaction per migration, pre-migration `VACUUM INTO` snapshot. Fully tested, including injected failure. |
| Validation | **Zod 4** at every boundary | IPC requests, imports, theme/layout files, provider responses, settings rows. Types are inferred from the schemas. |
| Renderer build | **Vite 8** + React 19 | Output is served via the `app://` protocol under a strict CSP. |
| Main/preload build | **esbuild** bundles | One CJS file each. The sandboxed preload depends on `electron` only. |
| Packaging | **electron-builder 26** | NSIS + portable (Windows), dmg/zip (macOS), AppImage/deb/rpm/tar.gz (Linux). |
| HTTP | Electron `net.fetch` through one `HttpClient` | Respects system proxy. Timeouts, abort and a size cap. Injected, so tests use fakes. |
| Zip | **fflate** | Pure JS. Lets us inspect the central directory (names, declared sizes) before inflating. |

## Storage layout (`app.getPath('userData')` is set to `<appData>/MaybePile`)

```
MaybePile/
├─ library.sqlite (+ -wal, -shm)     all library data, settings, themes, layouts
├─ artwork/                          <sha256>.(jpg|png) + <sha256>.thumb.jpg
├─ backups/                          pre-migration-*.sqlite (last 3), pre-restore-*.mpbackup (last 5)
├─ logs/                             maybepile.log (+ .1–.3), JSON lines, 1 MB rotation
├─ secrets.json                      provider keys, safeStorage-encrypted
└─ .running                          unclean-shutdown marker (removed on clean quit)
```

Portable builds use `<exe dir>/MaybePileData/`; see [backup-and-transfer.md](backup-and-transfer.md).

## Lifecycle

1. Before `ready`: resolve the data location (portable or installed), set `userData`, register privileged schemes, take the single-instance lock.
2. `ready`: harden the session, then open the DB. Opening takes a pre-migration snapshot if migrations are pending, runs migrations, and runs `PRAGMA quick_check`. A newer schema shows a dialog offering read-only mode or quit.
3. If the `.running` marker exists, the last shutdown was unclean: run a full `integrity_check` and surface a recovery notice if it fails.
4. Housekeeping: purge soft-deleted items, garbage-collect artwork, remove stale restore staging folders.
5. Register IPC handlers and protocols, build the menu, create the window (shown on `ready-to-show`).
6. Quit: WAL checkpoint (TRUNCATE), close the DB, remove the `.running` marker.
7. If the renderer crashes, offer to reload. If it becomes unresponsive, offer to wait or reload.

## Performance

`npm run bench` (dev only) builds 10,000 items with 100,000 episode rows and times common queries. Results are in [verification-log.md](verification-log.md). Library lists are virtualized: only visible rows plus overscan are rendered, and pages of 200 are fetched as you scroll. Grid images use 320px thumbnails generated at import.

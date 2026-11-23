# Verification log

What was actually run while building Maybe Pile 1.0.0, and the results. Nothing is marked as verified unless it was run here.

## Environment

| | |
| --- | --- |
| OS | Windows 11 Home (10.0.26300), x64 |
| Node (tooling/tests) | v27.0.0-alpha (system install) |
| npm | 12.1.0 |
| Electron | 45.4.1 (runtime Node 24.22.3, SQLite 3.54.1 via `node:sqlite`) |
| Shell quirk | The environment exports `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. All launch scripts and e2e tests remove it. |
| OS policy | Windows Application Control blocks unsigned executables (see packaging below). |

## Commands and results (final run)

| Command | Result |
| --- | --- |
| `npm ci`-equivalent install (`npm install` of pinned versions) | OK. npm 12 required approving esbuild's install script (`allowScripts`). |
| `npm run format:check` | ✅ All files use Prettier style |
| `npm run lint` (`--max-warnings 0`) | ✅ 0 errors, 0 warnings |
| `npm run typecheck` (node, web and ui-tests configs, all strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | ✅ 0 errors |
| `npm test` | ✅ **9 files, 262 tests passed** (~9 s) |
| `npm run test:coverage` | ✅ 262 passed; statements 71.4%, branches 61.8%, functions 60.7%, lines 74.3% (includes UI code) |
| `npm run test:a11y` | ✅ Included in `npm test` (UI project): axe-core with no violations on 13 screens/dialogs |
| `npm run test:e2e` (build + Playwright for Electron) | ✅ **1 passed** (~36 s). See "E2E flow" below |
| `npm run bench` | ✅ See performance below |
| `npm run smoke:providers` (live network) | ✅ See below |
| `npm audit` | 6 moderate advisories, all in **dev/build tooling** (`minimatch` via electron-builder → `@electron/universal`, `app-builder-lib`, `dmg-builder`). No non-breaking fix available. Vitest advisories were fixed by upgrading to 4.1.12. `npm audit --omit=dev` → **0 vulnerabilities** (the app ships no runtime `node_modules`). |
| `npx electron-builder --win nsis portable --x64` | ✅ Built `Maybe-Pile-Setup-1.0.0.exe` (121.6 MB) and `Maybe-Pile-Portable-1.0.0.exe` (110.7 MB), both unsigned |

### Test breakdown

| Project | Files | Covers |
| --- | --- | --- |
| unit | `domain.test.ts`, `providers.test.ts`, `security.test.ts` | Dates, normalization, ratings, status rules, refresh merge, links (accept/reject matrix), CSV and formula injection, themes (accept/reject, AA contrast of built-ins, example file), layouts, log redaction. All four providers with mocked HTTP (success, missing fields, malformed JSON, wrong content type, network, timeout, 401/403, 404, 5xx, 429 + Retry-After, rate limiter). Every IPC channel rejects invalid payloads, sender checks, API snapshot, window prefs, CSP, navigation, external opener, renderer path traversal, portable data location, text decoding |
| integration | `migrations`, `library`, `progress`, `portability`, `provider-service` | Fresh create, v1→v2 upgrade with data and FTS back-fill, failure rollback, newer-schema refusal, checksum tamper, CHECK/FK. CRUD for all types, duplicates, provenance, tags, soft delete/undo/purge, persistence across reopen, search/filter/sort, bulk, dashboard. Progress for every type and scheme, unknown totals, specials, passes, history edit/delete, page-count changes, status suggestions and auto-apply. JSON round-trip equality, conflicts (skip/duplicate/update; newer local kept), invalid input, failure mid-import rolls back. CSV export/import with row errors. Backup round-trip with artwork, themes and layouts, pre-restore snapshot and undo, **injected failure at each restore step leaves the library intact**, checksum mismatch, truncated archive, path traversal, unsupported versions. Theme/layout persistence across restart, corrupt-theme fallback, reset. Provider import/refresh/watch, caching policies, artwork retry, secrets never in logs/exports/backups |
| ui | `app.test.tsx` | Real handlers in-process behind the bridge. Empty/populated dashboard, add dialog (focus trap/restore, Esc), manual form validation (error summary, `aria-invalid`, input kept), duplicate choice, library search/filter chips/keyboard selection, bulk delete with typed confirmation and undo, item detail progress, delete dialog defaults to Cancel, completion suggested not forced, re-open dialog, external links via the main opener, all settings tabs (axe), layout editor, theme contrast warning, `?` overlay not triggered while typing |

### Bugs found and fixed by these checks

- The error summary re-focused itself on every render, stealing focus while typing (UI test).
- A dialog `<header>` created a duplicate banner landmark (axe).
- Theme IDs accepted arbitrary strings over IPC (dispatcher test); now restricted to built-in IDs or UUIDs.
- Pre-restore snapshot names could collide within the same millisecond (integration test).
- Progress-history IDs changed on JSON round-trip (equality test).
- Open Library used an edition year instead of the first publication year (live smoke).
- Zod 4 optional-key handling in loose provider schemas (provider tests).
- `client_secret=` values were not redacted outside query strings (redaction test).

## E2E flow (`tests/e2e/smoke.spec.ts`, real app, temp userData, no network)

1. Launch with an empty library → "Your pile is empty" (no fake data).
2. Add a Movie, a TV show (1 season, 3 episodes), a Game (hours scheme), a Book with page count and tag, and a Book without page count.
3. Movie: Mark watched → completion **suggested**, status still Planned → accept → Completed.
4. TV: tick S1E1 → "1 of 3 episodes"; "Up to here" on S1E3 → "3 of 3".
5. Game: 12.5 hours. Book: page 100 → edit the history entry to 120 → "120 of 272 pages". Unknown-length book: 40%.
6. Edit details → provenance badge "edited by you".
7. Search ("piran" → 1 item), filter Books (2 items), clear filters (5), sort by title.
8. **Quit and relaunch → 5 items and history intact.**
9. Switch to Pile Dark → the CSS variable changes. Reorder the layout.
10. Export JSON (validated `format`) and CSV. Create a `.mpbackup` (native dialogs stubbed in main).
11. Add another item, then restore: the preview shows counts, the button is disabled until `RESTORE` is typed → restored to 5 items, and a `pre-restore-*.mpbackup` exists.
12. **Injected failure:** a truncated backup → "damaged or truncated", cancel, library unchanged.
13. No uncaught page errors throughout.

A separate launch probe confirmed: window URL `app://maybepile/index.html`, live webPreferences `contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false`, `window.require` undefined, bridge namespaces exactly `app, settings, items, progress, catalog, providers, artwork, themes, layouts, data, events`, and no console errors or warnings.

## Performance (`npm run bench`, 10,000 items, 100,000 episode rows)

| Operation | Time |
| --- | --- |
| Insert 10,000 items incl. 2,000 shows × 50 episodes (one transaction) | 7.3 s |
| Library page (default sort, 200 rows) | 5.7 ms |
| Full-text search "riv" | 4.7 ms |
| Diacritic search "pokemon" → "Pokémon" | 3.6 ms |
| Type + status + tag + rating filter, sort by title | 6.5 ms |
| Sort by progress, offset 9,000 | 24.3 ms |
| Dashboard aggregates | 62.4 ms |
| Load TV detail (50 episodes) | 0.4 ms |
| Mark 50 episodes watched | 4.1 ms |

## Live provider smoke check (`npm run smoke:providers`)

Run against the real keyless APIs (not part of the test suite):

```
tvmaze search "Severance" → 3 hits; first: Severance (2022) ref=44933
tvmaze details → title="Severance" date=2022-02-18 creators=Dan Erickson ids=tvmaze:44933,imdb:tt11280740 pages=— seasons=3 episodes=19 artwork=yes (732 ms)
openlibrary search "Piranesi Susanna Clarke" → 1 hits; first: Piranesi (2020) ref=OL20893680W
openlibrary details → title="Piranesi" date=2020 creators=Susanna Clarke ids=openlibrary:OL20893680W,isbn13:9781526681539 pages=400 seasons=0 episodes=0 artwork=yes (3639 ms)
```

**TMDB and IGDB were not exercised live** (no API keys in this environment). They are verified with mocked HTTP only.

## Packaging

| | Built | Launched | Tests run | Installer/portable verified |
| --- | --- | --- | --- | --- |
| Windows | ✅ NSIS + portable (unsigned) | ⚠️ Unpacked app run via Electron in dev/e2e mode ✅; **packaged `Maybe Pile.exe` blocked by Windows Application Control** ("An Application Control policy has blocked this file") because it is unsigned | ✅ all suites | ⚠️ Not run: the installer would modify the real user profile (shortcuts, registry) and is blocked by the same policy. The portable exe was not launched for the same reason. Packaged `app.asar` contents were inspected (only `dist/*` bundles, icon, `package.json`; no `node_modules`, no source maps) |
| macOS | ⚠️ configured, not built (requires macOS) | ❌ | ❌ | ❌ |
| Linux | ⚠️ configured, not built (requires Linux) | ❌ | ❌ | ❌ |

The CI workflow (`.github/workflows/ci.yml`) was **written but not executed**. No git repository existed in the workspace, so no commits were made.

## Not performed

- Manual screen-reader and keyboard pass by a person (automated keyboard/axe coverage only).
- Running the NSIS installer/uninstaller and the portable exe end to end (OS policy and side effects).
- macOS/Linux builds and runs; code signing and notarization.
- Live TMDB/IGDB requests.

---

## Version 1.1.0 update

Changes: two new keyless providers (Wikidata, AniList), Up Next queue, "Pick something for me", "This year" dashboard stats, schema migration v3, and softer privacy wording in the UI and README.

| Command | Result |
| --- | --- |
| `npm run format:check` / `npm run lint` / `npm run typecheck` | ✅ all clean |
| `npm test` | ✅ **11 files, 281 tests passed** (adds keyless-provider tests, Up Next/pick/stats tests, v2→v3 migration test, Up Next UI + axe test) |
| `npm run test:e2e` | ✅ 1 passed (37 s), full acceptance flow unchanged |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| `npm run smoke:providers` (live network) | ✅ See below |

Live keyless provider check (real APIs):

```
wikidata  "Inception"     → Inception (2010) Q25188; date 2010-07-08; Christopher Nolan + cast; ids imdb:tt1375666, tmdb:27205
wikidata  "Hades" (game)  → Hades (2018) Q59756366; Supergiant Games; ids steam:1145360
wikidata  "Breaking Bad"  → Breaking Bad (2008) Q1079; Vince Gilligan + cast; ids imdb:tt0903747, tmdb:1396
wikidata  "Piranesi"      → Piranesi (2020) Q99434216; Susanna Clarke
anilist   "Frieren" (TV)  → Frieren: Beyond Journey's End (2023); 1 season, 28 episodes; ids anilist:154587, mal:52991; cover
anilist   "Spirited Away" → Spirited Away (2001); Hayao Miyazaki; ids anilist:199, mal:199; cover
anilist   "Berserk" (book)→ Berserk (1989); Kentarou Miura; ids anilist:30002, mal:2; cover
```

Evaluated and rejected: **Google Books** without an API key returned HTTP 429 on every request (3 attempts), so it isn't a usable keyless source.

Bugs found by the new tests and fixed: Up Next/layout reorder lost keyboard focus when an item reached the top or bottom (the button it was on became disabled); AniList role strings with qualifiers ("Story & Art (vols 1-41)") dropped manga authors; AniList counted every "… Director" credit as a director; Wikidata TV listed every episode director as a creator.

Windows installers were **not** rebuilt for 1.1.0 (they are build output, not stored in git); run `npm run dist:win` to produce them.

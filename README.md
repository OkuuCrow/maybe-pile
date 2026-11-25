# Maybe Pile

**Someday, maybe. Now organized.**

Maybe Pile is a local-first desktop app for the movies, TV shows, anime, video games and books you mean to get to, are deep into, or have finished. It runs on Windows, macOS and Linux, works fully offline, and keeps your library on your computer in open formats.

- Track items as **Planned, In Progress, Completed, On Hold or Dropped**, with ratings (half-star), notes, tags, custom fields and dates.
- Progress that fits each medium: **movie viewings**, **TV seasons and episodes** (specials, unknown totals, "up to here"), **game progress schemes** (percent, hours, milestones, free text), and **book pages, percent or audiobook time** (unknown or changing page counts are fine). Every update is kept in an editable history.
- **Search online sources**, preview, and import. Wikidata, TVmaze, Open Library and Kitsu need no setup and cover every media type; TMDB, IGDB and the official MyAnimeList API are optional extras with your own free keys. AniList and Jikan can be turned on after reading their terms notes. Or enter everything by hand. Refresh metadata later and choose per field what to keep; your edits are never silently overwritten.
- **Search, filter (type, status, tags, rating, date added) and sort** large libraries instantly. Bulk actions and duplicate detection are included.
- **Steam library import** with your own key: see what you haven't played, choose what joins the pile, re-sync later and undo imports. Other stores work through a pasted or uploaded game list.
- **Pick for Me** (weighted, with constraints such as time tonight, lists, tags and rating), a reorderable **Up Next** shelf, gentle **Pile Health** nudges with snoozes, and your own **Lists**.
- **Stats & Year in Review** (accessible charts, CSV/PNG export), **Release Radar** for upcoming releases (`.ics` export, opt-in notifications) and **Goals** with plain-text pace.
- **Tracker imports** from Goodreads, Letterboxd and any CSV (column mapper with saved profiles), all with preview and undo.
- A **command palette** (Ctrl/⌘+K) and **Quick Capture** (Ctrl/⌘+Shift+N, optional global shortcut).
- **Themes and layouts** you can edit, share and reset. Accessible by design (keyboard, screen readers, WCAG AA contrast).
- **Anime** as its own type: romaji/English/native titles, format, airing status, season, studios, sub/dub preference, adult content hidden by default, "All anime sources" search with de-duplication, relation suggestions, documented streaming links, and **MyAnimeList XML import** with undo.
- An **Artwork Picker** for cover, banner, logo, icon and background, gathering candidates from several sources (TMDB, fanart.tv, SteamGridDB and the item's own source). Your choices are never replaced automatically, and every image passes strict safety checks.
- **Pile Time** (how long your pile would take, with sources and confidence), **Moods**, **Runs** (rewatch/replay history), **Series** with "Next in series", **Spoiler Shield**, **Pile Value** (per currency, no conversion), a **session timer** that survives restarts, **ownership & Leaving Soon**, offline **explainable recommendations**, a local **share card**, a **completion heatmap** (with table view), **duplicate merge** with undo, and a **sync folder** for keeping computers in step without a server.
- **Backups** (`.mpbackup`), **JSON/CSV export and import** with preview and conflict handling, and safe moves between Windows, macOS and Linux.

## Requirements

| | Version |
| --- | --- |
| Node.js | 22.12 or newer (24 LTS recommended, see `.nvmrc`) |
| npm | 10+ |
| Electron | 45.4.1 (installed as a pinned dev dependency) |

There are no native modules: SQLite comes from Electron's built-in `node:sqlite`.

## Setup and development

```bash
npm ci                 # install exactly the locked dependencies
npm run dev            # Vite dev server + esbuild watch + Electron
npm start              # production build + launch
```

| Task | Command |
| --- | --- |
| Lint (ESLint, typescript-eslint strict, jsx-a11y) | `npm run lint` |
| Type-check (strict, 3 configs) | `npm run typecheck` |
| Formatting check / fix | `npm run format:check` / `npm run format` |
| All tests (unit + integration + UI/a11y) | `npm test` |
| Unit / integration / UI / accessibility only | `npm run test:unit`, `npm run test:int`, `npm run test:ui`, `npm run test:a11y` |
| Coverage | `npm run test:coverage` |
| End-to-end smoke (builds, then drives the real app) | `npm run test:e2e` |
| Everything | `npm run test:all` |
| Benchmark (10k items / 100k episodes / 100k history rows, stats, pile health, 10k-row import review) | `npm run bench` |
| Live check of keyless providers (network) | `npm run smoke:providers` |
| Regenerate the app icon | `npm run icons` |

Tests never touch the network or your real data: they use temporary folders and fake HTTP.

## Building installers

```bash
npm run dist:win     # NSIS installer + portable .exe  (run on Windows)
npm run dist:mac     # dmg + zip, x64 + arm64          (run on macOS)
npm run dist:linux   # AppImage, deb, rpm, tar.gz      (run on Linux)
```

See [docs/packaging.md](docs/packaging.md) for prerequisites, signing and notarization, and what each installer does. Builds are unsigned unless you provide certificates.

## Using Maybe Pile

1. **Add something:** click **Add item** (or press `N`). Search an online source, pick the right result, review the preview, then **Import**. Or switch to **Enter manually**.
2. **Track it:** on the item page, log a viewing, tick episodes ("Up to here" marks earlier ones too), record hours, milestones, pages or percent. Maybe Pile *suggests* status changes (for example "Mark Completed?") but never forces them.
3. **Find things:** in **Library**, type to search titles, creators, notes and tags. Open **Filters** for type, status, tags, rating and date added. Remove filters with the chips or **Clear all filters**.
4. **Make it yours:** Settings → **Appearance** (duplicate a built-in theme and edit its colours, with live preview and a contrast check) and **Layout** (reorder and hide dashboard and library components).
5. **Keep it safe:** Settings → **Backup & Restore** → **Create backup…**. Restoring shows a preview and asks you to type `RESTORE`; your previous library is snapshotted first.
6. **Online sources:** Wikidata, TVmaze, Open Library and AniList need no setup. TMDB and IGDB are optional and need free API keys: Settings → **Providers** (see [docs/providers.md](docs/providers.md)).
7. **Decide what's next:** add items to **Up Next** from their page (or select several in the Library), reorder the queue on the dashboard, or open **Pick for Me** (Ctrl/⌘+Shift+P) and say how much time you have.
8. **Import your Steam library:** get your own key at steamcommunity.com/dev/apikey, then **Import → Game libraries → Add Steam account**. Make your Steam *Game details* public, load the library, select unplayed games and import them. See [docs/steam-import.md](docs/steam-import.md).
9. **Bring other trackers:** **Import → Other trackers** for Goodreads, Letterboxd or any CSV. Undo any import under **Import history & undo**.
10. **Organize and reflect:** create **Lists**, triage **Pile Health**, set **Goals**, check **Stats** and **Upcoming releases**. Press **Ctrl/⌘+K** to jump anywhere.

Press `?` at any time for keyboard shortcuts.

## Documentation

| Doc | Contents |
| --- | --- |
| [architecture.md](docs/architecture.md) | Processes, layers, data flow, key decisions |
| [security.md](docs/security.md) | Threat model, Electron hardening, full IPC table, link and secret policies |
| [data-model.md](docs/data-model.md) | ER diagram, tables, JSON exceptions, full-text search |
| [migrations.md](docs/migrations.md) | Adding migrations, testing checklist, recovery |
| [backup-and-transfer.md](docs/backup-and-transfer.md) | Formats, restore semantics, moving between OSes, portable build |
| [customization.md](docs/customization.md) | Theme and layout file formats, validation, examples |
| [providers.md](docs/providers.md) | Providers, keys, attribution, rate limits, caching, adding one |
| [product-decisions.md](docs/product-decisions.md) | Status and progress rules and every other judgement call |
| [accessibility.md](docs/accessibility.md) | Keyboard map, tested behaviours, known gaps |
| [troubleshooting.md](docs/troubleshooting.md) | Installation, network, database, import and recovery problems |
| [packaging.md](docs/packaging.md) | Builds, installers, signing, CI |
| [verification-log.md](docs/verification-log.md) | Exactly what was run for this build, and the results |
| [steam-import.md](docs/steam-import.md) | Steam key setup, privacy settings, review/import/re-sync/undo, troubleshooting |
| [anime.md](docs/anime.md) | Anime fields, sources, episode edge cases, MAL XML import |
| [artwork.md](docs/artwork.md) | Artwork Picker, slots, automatic picks, storage and image safety |
| [sync.md](docs/sync.md) | Sync folder: what syncs, how conflicts work, safety |
| [features/](docs/features/) | One page each: Pick for Me, Up Next, Pile Health, Lists, Stats, Release Radar, Tracker Imports, Quick Capture & palette, Goals, Pile Time, Moods, Runs, Series, Spoiler Shield, Pile Value, Sessions, Ownership, Recommendations, Share card, Heatmap, Duplicate merge |
| [CHANGELOG.md](CHANGELOG.md) | Release notes and migration notes |

## AI assistance disclaimer

AI tools were used as an assistant during development of Maybe Pile, including for finding, fixing bugs, and assisting in making the GitHub page. All changes were reviewed and are maintained by the project owner.

## License

MIT; see [LICENSE](LICENSE). Third-party licenses are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) (regenerate with `npm run licenses`). Metadata comes from TMDB, TVmaze, Open Library and IGDB under their own terms and attribution requirements (see [docs/providers.md](docs/providers.md)). This product uses the TMDB API but is not endorsed or certified by TMDB.

# Maybe Pile

**Someday, maybe. Now organized.**

Maybe Pile is a local-first desktop app for the movies, TV shows, video games and books you mean to get to, are deep into, or have finished. It runs on Windows, macOS and Linux, works fully offline, and keeps your library on your computer in open formats.

- Track items as **Planned, In Progress, Completed, On Hold or Dropped**, with ratings (half-star), notes, tags, custom fields and dates.
- Progress that fits each medium: **movie viewings**, **TV seasons and episodes** (specials, unknown totals, "up to here"), **game progress schemes** (percent, hours, milestones, free text), and **book pages, percent or audiobook time** (unknown or changing page counts are fine). Every update is kept in an editable history.
- **Search online sources**, preview, and import. Wikidata, TVmaze, Open Library and AniList need no setup and cover every media type; TMDB and IGDB are optional extras with free API keys. Or enter everything by hand. Refresh metadata later and choose per field what to keep; your edits are never silently overwritten.
- **Search, filter (type, status, tags, rating, date added) and sort** large libraries instantly. Bulk actions and duplicate detection are included.
- **Up Next** queue for what to start soon, **Pick something for me** when you can't decide, and a **This year** summary on the dashboard.
- **Themes and layouts** you can edit, share and reset. Accessible by design (keyboard, screen readers, WCAG AA contrast).
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
| Benchmark (10k items / 100k episodes) | `npm run bench` |
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
7. **Decide what's next:** add items to **Up Next** from their page (or select several in the Library), reorder the queue on the dashboard, or press **Pick for me** for a random Planned item.

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

## AI assistance disclaimer

AI tools were used as an assistant during development of Maybe Pile, including for finding, fixing bugs, and assisting in making the GitHub page. All changes were reviewed and are maintained by the project owner.

## License

MIT; see [LICENSE](LICENSE). Third-party licenses are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) (regenerate with `npm run licenses`). Metadata comes from TMDB, TVmaze, Open Library and IGDB under their own terms and attribution requirements (see [docs/providers.md](docs/providers.md)). This product uses the TMDB API but is not endorsed or certified by TMDB.

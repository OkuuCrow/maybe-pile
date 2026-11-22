# Building and packaging

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **22.12+ (24 LTS recommended)**; `.nvmrc` says 24 | Development was done on Node 27.0.0-alpha; CI uses Node 24 |
| npm | 10+ (verified with 12.1.0) | npm 12 asks you to approve install scripts. esbuild's is approved in `package.json → allowScripts`. Electron downloads its binary on first run. |
| Electron | 45.4.1 (pinned, devDependency) | Bundles Node 24.22.3 and SQLite 3.54.1 (via `node:sqlite`) |
| OS toolchains | none for native modules | The app has **no native Node modules** |

```bash
npm ci
npm run build        # dist/main, dist/preload, dist/renderer
npm start            # build + launch
npm run dev          # Vite dev server + esbuild watch + Electron
```

## Per-OS packages

| Target | Command | Must run on | Output (`release/`) |
| --- | --- | --- | --- |
| Windows NSIS installer + portable | `npm run dist:win` | Windows (or Linux/macOS with Wine for NSIS) | `Maybe-Pile-Setup-<v>.exe`, `Maybe-Pile-Portable-<v>.exe` |
| macOS dmg + zip (x64 + arm64) | `npm run dist:mac` | macOS (required for dmg and signing) | `Maybe-Pile-<v>-<arch>.dmg`, `.zip` |
| Linux AppImage, deb, rpm, tar.gz | `npm run dist:linux` | Linux (rpm needs `rpmbuild`) | `Maybe-Pile-<v>-<arch>.AppImage`, `.deb`, `.rpm`, `.tar.gz` |

If your shell exports `ELECTRON_RUN_AS_NODE`, unset it before running electron-builder.

### Windows installer behaviour (`build/installer.nsh`)

- Assisted installer (`oneClick: false`). **Per-user install is the default** (no admin rights); the installer also offers "for all users" with elevation. You can change the installation folder.
- A **Shortcuts** page lets the user create or skip a Desktop shortcut and a Start Menu shortcut (both on by default; silent `/S` installs use the defaults).
- The uninstaller removes the app and shortcuts, then asks whether to also delete the library in `%APPDATA%\MaybePile`. **The default answer is No (keep).** It never asks during updates.

## Signing and notarization (not done here)

- **Windows:** set `CSC_LINK` (path or base64 of a .pfx) and `CSC_KEY_PASSWORD`. Unsigned builds trigger SmartScreen and can be blocked outright by Smart App Control / WDAC.
- **macOS:** set `CSC_LINK`/`CSC_KEY_PASSWORD` for a Developer ID Application certificate. For notarization, set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` and set `mac.notarize: true` in `electron-builder.yml` (or override it with `-c.mac.notarize=true`). Hardened runtime and entitlements are already configured (`build/entitlements.mac.plist`: JIT plus network client only).
- **Linux:** no signing is needed for AppImage/deb/rpm. Repository signing depends on your distribution channel.

Never commit certificates or passwords. Store them as CI secrets.

## Reproducibility

- `package-lock.json` is committed, all versions are pinned exactly, and installs use `npm ci`.
- Node is pinned via `.nvmrc` and `engines`. Electron is pinned exactly.
- The renderer and main bundles are deterministic for a given lockfile. No network access is needed at build time except electron-builder downloading Electron, NSIS and AppImage tooling into its cache.

## CI

`.github/workflows/ci.yml` runs lint, type-check, unit/integration/UI tests and the e2e smoke test on ubuntu, windows and macos, then packages each OS and uploads the artifacts. It was **written but has not been executed** as part of this work; see [verification-log.md](verification-log.md).

## Auto-update

Not included (no hosted release server). To add it: configure `publish` in `electron-builder.yml`, add `electron-updater`, sign all builds, and make update checks opt-in so the app keeps its "no unexpected network calls" guarantee.

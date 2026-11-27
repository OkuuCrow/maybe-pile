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

`.github/workflows/ci.yml` runs lint, type-check, unit/integration/UI tests and the e2e smoke test on ubuntu, windows and macos, then packages each OS and uploads the artifacts. It runs on every push to `main`; the Actions tab shows results.

## Auto-update

Not included (no hosted release server). To add it: configure `publish` in `electron-builder.yml`, add `electron-updater`, sign all builds, and make update checks opt-in so the app keeps its "no unexpected network calls" guarantee.

## Releases

`.github/workflows/release.yml` builds and publishes a GitHub Release:

```bash
# bump "version" in package.json first, commit, then:
git tag v1.1.0
git push origin v1.1.0
```

It builds on GitHub's runners: Windows (`Maybe-Pile-Setup-<v>.exe`, `Maybe-Pile-Portable-<v>.exe`) and Linux (`Maybe-Pile-<v>-x86_64.AppImage`, `maybe-pile_<v>_amd64.deb`, `maybe-pile-<v>.x86_64.rpm`, `Maybe-Pile-<v>-x64.tar.gz`). It then creates the release with a `SHA256SUMS.txt`. You can also run it manually from the Actions tab with a tag name. macOS packages aren't included (they need a Mac signing identity to be usable).

## 2.1: notifications

- `electron-builder.yml` declares the `maybepile` protocol (NSIS registers it per user; Linux `.desktop` gets
  `MimeType=x-scheme-handler/maybepile;`). Portable builds register it at runtime only when a background
  reminder mode is enabled; AppImage gets an optional per-user URL-handler `.desktop` file.
- `app.setAppUserModelId('app.maybepile.desktop')` matches the electron-builder `appId`, which NSIS uses for
  its shortcuts. If the user declined the Start Menu shortcut, enabling a background mode offers to create one
  (toasts need it); the user's choice in the installer still works.
- NSIS uninstall (not during updates) deletes the `MaybePile\ReminderCheck` task, the login item and the
  protocol key. Linux packages cannot remove per-user files: see notifications-troubleshooting.md.
- The Linux helper ships as `dist/helper/reminder-check.cjs` inside `app.asar`; it is copied to the user data
  folder when scheduled mode is enabled (works for deb/rpm/AppImage alike).

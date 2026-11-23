# Themes and layouts

Both are customised in Settings (Appearance, Layout), stored in the library database (so they're included in backups and JSON exports), and can be exchanged as files. Files are **data only**: they are validated against strict schemas and never evaluated as code, CSS, HTML or URLs.

## Theme files (`*.mptheme.json`)

```json
{
  "format": "maybepile-theme",
  "schemaVersion": 1,
  "name": "Ocean",
  "tokens": {
    "colorScheme": "light",
    "colors": { "bg": "#F2F7F9", "surface": "#FFFFFF", "...": "..." },
    "radius": "large",
    "density": "comfortable",
    "fontScale": 1.05,
    "fontFamily": "humanist"
  }
}
```

A complete, valid example is [`examples/ocean.mptheme.json`](../examples/ocean.mptheme.json). The test suite validates it.

### Field reference

| Field | Type / allowed values | CSS custom property |
| --- | --- | --- |
| `format` | `"maybepile-theme"` | — |
| `schemaVersion` | `1` | — |
| `name` | 1–60 characters | — |
| `tokens.colorScheme` | `"light"` \| `"dark"` | `color-scheme` |
| `tokens.colors.bg` | hex colour | `--mp-bg` (page background) |
| `tokens.colors.surface` | hex | `--mp-surface` (cards, dialogs, inputs) |
| `tokens.colors.surfaceAlt` | hex | `--mp-surface-alt` (hover, chips, selected) |
| `tokens.colors.text` | hex | `--mp-text` |
| `tokens.colors.textMuted` | hex | `--mp-text-muted` |
| `tokens.colors.accent` | hex | `--mp-accent` (primary buttons, links, progress) |
| `tokens.colors.onAccent` | hex | `--mp-on-accent` (text on accent) |
| `tokens.colors.border` | hex | `--mp-border` (control borders) |
| `tokens.colors.snoozed` *(optional, 1.2)* | hex | `--mp-state-snoozed` ("Snoozed" badge) |
| `tokens.colors.ignored` *(optional, 1.2)* | hex | `--mp-state-ignored` ("Ignored" badge) |
| `tokens.colors.inPile` *(optional, 1.2)* | hex | `--mp-state-in-pile` ("In pile" badge) |
| `tokens.colors.newItem` *(optional, 1.2)* | hex | `--mp-state-new` ("New" badge) |
| `tokens.colors.focus` | hex | `--mp-focus` (focus ring) |
| `tokens.colors.planned` / `inProgress` / `completed` / `onHold` / `dropped` | hex | `--mp-status-*` |
| `tokens.colors.success` / `warning` / `danger` | hex | `--mp-success`, `--mp-warning`, `--mp-danger` |
| `tokens.radius` | `"none"` (0) \| `"small"` (4px) \| `"medium"` (8px) \| `"large"` (14px) | `--mp-radius` |
| `tokens.density` | `"compact"` (6px) \| `"comfortable"` (8px) | `--mp-space` |
| `tokens.fontScale` | number 0.85–1.5 | `--mp-font-scale` (root font size) |
| `tokens.fontFamily` | `"system"` \| `"humanist"` \| `"serif"` \| `"mono"` (fixed lists of locally installed fonts, no URLs) | `--mp-font-family` |

Hex colours must be `#RRGGBB` or `#RRGGBBAA`. Named colours, `rgb()`, `url()` and anything else are rejected.

### Validation rules

- Maximum file size is 64 KB. The file must be valid JSON.
- **Unknown keys are rejected** (not ignored), so typos are surfaced instead of silently doing nothing.
- `schemaVersion` greater than the app supports gives a clear "update Maybe Pile" error. Missing or wrong types give an error with the JSON path.
- Values are applied with `document.documentElement.style.setProperty(name, value)`, where `name` comes only from the fixed token table in `src/domain/themes.ts`.
- If the active custom theme becomes invalid, missing or corrupt, the app falls back to **Pile Light** and shows a notice.
- Contrast: the editor checks 18 text/UI colour pairs against WCAG 2.2 AA (4.5:1 for text, 3:1 for focus ring and borders). It shows a non-blocking warning listing each failing pair and its ratio. Built-in themes pass every pair (tested).

### Error examples

```
$.tokens.colors.bg: Colors must be hex values like #1A2B3C or #1A2B3CFF.
$.tokens: Unknown key(s): script. Remove them.
$.tokens.density: Invalid value. Allowed: "compact", "comfortable".
$.tokens.fontScale: Too big: expected number to be <=1.5
$.schemaVersion: This theme uses format version 2, but this app supports up to 1. Update Maybe Pile to import it.
$: File is not valid JSON.
```

### Built-in themes

**Pile Light**, **Pile Dark** and **System** (follows the OS setting live via `prefers-color-scheme`). Built-ins are read-only: duplicate one to customise it. **Reset themes** switches back to System and can optionally delete all custom themes, after confirmation.

## Layout files (`*.mplayout.json`)

```json
{
  "format": "maybepile-layout",
  "schemaVersion": 1,
  "dashboard": [{ "id": "continue", "visible": true, "span": 2 }, "..."],
  "library": [{ "id": "search", "visible": true }, "..."]
}
```

Complete example: [`examples/focused.mplayout.json`](../examples/focused.mplayout.json) (validated by tests).

| Surface | Component IDs | Settings |
| --- | --- | --- |
| `dashboard` | `counts`, `upNext`, `pick`, `continue`, `recentlyUpdated`, `recentlyAdded`, `recentlyCompleted`, `activity`, `yearStats`, `tags` | `visible` (bool), optional `span` (`1` half width, `2` full width) |
| `library` | `search`, `filters`, `sort`, `viewToggle`, `statusStrip`, `bulkBar` | `visible` (bool) |

Rules:
- Only these IDs and settings are allowed. Unknown IDs or keys, duplicates, wrong types and oversized arrays are rejected. Maximum file size is 32 KB.
- Order in the array is display order.
- **Repair:** an imported layout missing some components (for example, written by an older version) is accepted. The missing components are appended with their defaults, and the app shows a notice naming them. Saved layouts get components added by app updates (such as `upNext`, `pick` and `yearStats` in 1.1) appended silently.
- Settings → Layout has an accessible list editor (Move up/Move down buttons that keep focus, Visible checkboxes, width select), a one-click **Reset both to defaults**, and import/export.

## Versioning and migration policy

`schemaVersion` changes only when a file written by the new version could be misread by an older one (for example, a token whose meaning changes). Adding new **optional** tokens would also bump the version, because unknown keys are rejected. When the version bumps, the importer keeps accepting all older versions and upgrades them in memory (filling new tokens from the built-in theme that matches `colorScheme`). Exports always write the newest version.

## Feature-pack additions (1.2)

### State badge tokens

`snoozed`, `ignored`, `inPile` and `newItem` are **optional**, so theme files made for 1.0/1.1 stay valid. Missing values fall back to safe defaults for the theme's colour scheme (light: `#5B4B8A`, `#57534B`, `#276B2B`, `#1F5FA6`; dark: `#C4B5FD`, `#ABA79F`, `#7BD389`, `#7DB9F0`). All of them pass AA (4.5:1) on both built-in surfaces, and the contrast checker now covers these four pairs too. Badges always combine an icon and text with the colour. `examples/ocean.mptheme.json` sets them explicitly.

### Layout schema v2

`schemaVersion: 2` adds the dashboard components **`pileHealth`** (Pile Health), **`upcoming`** (Upcoming releases), **`goals`**, **`lists`** and **`statsSummary`** (Stats summary, hidden by default). `pick` (Pick for Me) and `upNext` already existed. Version-1 layout files are **migrated** on import: the new components are appended with their default visibility, with no "missing component" notice. Saved layouts in the database get the new components appended the same way. Files with an unknown component id or a newer `schemaVersion` are still rejected. [`examples/focused.mplayout.json`](../examples/focused.mplayout.json) is a v2 file.


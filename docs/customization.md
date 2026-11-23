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

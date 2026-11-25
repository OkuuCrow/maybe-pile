# Accessibility

The target is WCAG 2.2 AA.

## Keyboard map

| Shortcut | Alternative | Action |
| --- | --- | --- |
| Ctrl/⌘ + N (menu) | `N` | Add a new item |
| Ctrl/⌘ + F (menu) | `/` | Focus library search |
| Ctrl/⌘ + 1 | `G` then `D` | Dashboard |
| Ctrl/⌘ + 2 | `G` then `L` | Library |
| Ctrl/⌘ + , | `G` then `S` | Settings |
| Ctrl/⌘ + S | Save button | Save the item form |
| Esc | Cancel button | Close the current dialog (non-destructive dialogs) |
| Arrow keys / Home / End | Tab | Move between library items (grid: all four arrows; list: up/down) |
| `X` or Space | Item checkbox | Select/deselect the focused library item |
| Enter | Click | Open the focused item |
| `?` | Help → Keyboard Shortcuts | Show the shortcut list |
| Ctrl/⌘ + K | **Search & commands** button | Command palette (items, views, actions) |
| Ctrl/⌘ + Shift + N | Command palette → Quick Capture | Quick Capture (optional global shortcut in Settings → Features) |
| Ctrl/⌘ + Shift + P | Command palette → Pick for Me | Pick for Me |
| ↑ ↓ Home End PgUp PgDn | — | Import review list: move focus |
| Space / Shift + ↑↓ / Ctrl/⌘ + A | Click / Shift+click / "Select all shown" | Import review list: toggle / extend / select all shown |
| `I` / `O` | "Ignore" / "Open on Steam" buttons | Import review list: ignore / open the focused game |

Single-key shortcuts are ignored while focus is in a text field, select or text area, and while a modal is open. Modifier shortcuts are native menu accelerators, so they never compete with text editing. The shortcut list is available from the Help menu, the `?` key, and Settings → About.

## Implemented behaviours

- Landmarks: one `header` (banner), `nav` (labelled "Main"), `main`. Settings has its own labelled `nav`. A skip link ("Skip to main content") appears on focus.
- One `h1` per view, with a logical `h2`/`h3` order. On route change, focus moves to `main`.
- A visible focus ring (3px, theme `focus` colour, ≥3:1 contrast) on every interactive element.
- Dialogs: `role="dialog"` or `"alertdialog"`, `aria-modal`, labelled by their title. Focus moves inside on open, Tab and Shift+Tab are trapped, Esc closes non-destructive dialogs, and focus returns to the opener on close.
- Destructive confirmations focus **Cancel** first, so Enter is safe. Bulk delete and restore require typing `DELETE` / `RESTORE`.
- Forms: every control has a `<label>`. Hints and errors are linked through `aria-describedby`, and invalid fields set `aria-invalid`. On submit, an error summary (`role="alert"`) receives focus once and links to each invalid field. Unsaved input is kept on errors.
- Status is never colour-only: badges combine an icon, a text label and colour. Progress bars have `role="progressbar"` with `aria-valuetext` such as "12 of 30 episodes". Errors use an icon plus text.
- Live regions: toasts use `role="status"` (polite) for success/info and `role="alert"` for errors. The library result count and async search results are announced.
- Charts: the dashboard activity chart is decorative (`aria-hidden`), and the same data is available as a table ("Show as table"). Stats and Pile Health charts are `role="img"` with a title and text summary. Bars carry their numbers as text and use fill **patterns** as well as colour, and each chart has a **Show data table** toggle (`aria-expanded`).
- Command palette: ARIA combobox + listbox with `aria-activedescendant`. The result count is announced, Esc closes, and focus returns to where it was.
- Import review list: a virtualized `listbox` with `aria-multiselectable`, `aria-activedescendant`, and `aria-setsize`/`aria-posinset` on each option. Rows contain no nested controls; per-row actions are in a toolbar that acts on the focused row (and on `I`/`O`).
- Pick for Me results, Steam sync progress, import results and Year in Review are polite live regions.
- Goal pace and Pile Health reasons are plain text ("Behind pace", "No progress for 3 months"), never colour alone. State badges (Snoozed, Ignored, In pile, New, Possible duplicate) pair an icon with text.
- Motion: `prefers-reduced-motion` disables animations. The only animation is a loading spinner.
- Text scaling: sizes are rem-based, so OS/browser zoom (Ctrl +/−) and the theme's text-size setting reflow the layout. The window minimum is 760×520; below 900px wide the layouts become single-column with no horizontal page scroll.
- Images have alt text ("Cover of …"). Missing or unavailable covers render a labelled placeholder.
- Contrast: both built-in themes pass WCAG AA for 18 checked pairs (tested). The theme editor warns about failing pairs in custom themes.
- Windows High Contrast / forced colours: progress bars use system `Highlight`.

## How it is tested

- **Automated (`npm run test:a11y`):** axe-core 4.14 runs WCAG 2.0/2.1/2.2 A and AA rules plus best practices on the empty and populated dashboard, library, item detail, add dialog (search and manual form with errors), status-change dialog, and all eight Settings tabs. In 1.2 it also covers (`tests/ui/features.test.tsx`): the **Steam review screen** and its import/confirm/result dialogs, the Steam setup form with field errors, **Pick for Me** (result and empty pool), the dashboard with **Up Next / Pick / Pile Health / Goals / Upcoming / Lists**, the **Pile Health** page and snooze dialog, **Lists** (index, editor, detail), **Stats** (charts and Year in Review), the **Command Palette**, **Goals** (editor with errors), and **Quick Capture**. Keyboard multi-select (Space, Shift+↓, Ctrl+A, `I`) and palette focus return are tested too. Colour contrast is excluded from axe (jsdom can't compute styles) and is verified by `tests/unit/domain.test.ts › built-in themes meet WCAG AA`.
- **Automated keyboard and focus tests** (`tests/ui/app.test.tsx`): focus trap and restore in dialogs, Esc to close, Enter on a destructive confirmation activates Cancel, `X` toggles selection in the library, `?` doesn't trigger while typing, and error-summary focus.
- **End-to-end** (`tests/e2e/smoke.spec.ts`): drives the real app through role-based locators (labels, roles, accessible names). Each step that passes also confirms the elements are reachable by accessible name.

## Manual verification status

A full manual keyboard-only and screen-reader pass by a person was **not** performed in this build environment, for 1.0 or for the 1.2 feature pack. Before release, include in the manual pass: the Steam review list (NVDA/VoiceOver announce option name, selection state and position), the command palette, Stats data tables, and the Pile Health triage buttons. The automated tests above cover keyboard operation of the main flows. Before release, do a manual pass with NVDA (Windows), VoiceOver (macOS) and Orca (Linux) covering add → track → complete, library filtering, refresh, theme editing and restore.

## Known gaps

- Library grid arrow-key navigation moves focus between item links. A full ARIA `grid` pattern (row/column semantics) isn't implemented; items are exposed as a list with position and set size.
- The colour picker inputs (`<input type="color">`) rely on the OS picker's accessibility. A hex text field next to each one is the accessible alternative.
- Toasts disappear after 5–10 seconds. Undo stays available for 10 seconds, and the same action (restore deleted items) isn't otherwise available after that.


## Expansion Pack 2

- **Artwork Picker:** slot tabs (`role=tab`, `aria-selected`) with counts. Candidates are buttons whose accessible names include source, size, language and an adult flag. Arrow keys move between them, Enter or Space previews, and selection is shown by a thick outline **and** `aria-pressed`. A per-source status list explains missing sources in text.
- **Spoiler Shield:** hidden text is replaced by plain text and a labelled Reveal button, never only blurred or colored.
- **Moods:** toggle buttons with `aria-pressed` and a ✓/+ glyph.
- **Heatmap:** a grid with a focusable, labelled cell per active day, intensity shown with dots as well as color, and a **Show as table** alternative. Forced-colors styles are included.
- **Session timer:** a labelled group. The readout isn't a live region (so it doesn't announce every second); the header link states the running or paused status and duration.
- **Pile page:** every card is a labelled section; tables have captions and row headers.
- **Tests:** `tests/ui/pack2.test.tsx` runs axe (WCAG 2.2 A/AA plus best practices, with contrast checked separately) on the Pile page, the item page panels, the Artwork Picker, Spoiler Shield, settings and the heatmap. All pass.

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
- Charts: the activity chart is decorative (`aria-hidden`), and the same data is available as a table ("Show as table").
- Motion: `prefers-reduced-motion` disables animations. The only animation is a loading spinner.
- Text scaling: sizes are rem-based, so OS/browser zoom (Ctrl +/−) and the theme's text-size setting reflow the layout. The window minimum is 760×520; below 900px wide the layouts become single-column with no horizontal page scroll.
- Images have alt text ("Cover of …"). Missing or unavailable covers render a labelled placeholder.
- Contrast: both built-in themes pass WCAG AA for 18 checked pairs (tested). The theme editor warns about failing pairs in custom themes.
- Windows High Contrast / forced colours: progress bars use system `Highlight`.

## How it is tested

- **Automated (`npm run test:a11y`):** axe-core 4.14 runs WCAG 2.0/2.1/2.2 A and AA rules plus best practices on the empty and populated dashboard, library, item detail, add dialog (search and manual form with errors), status-change dialog, and all seven Settings tabs. Colour contrast is excluded from axe (jsdom can't compute styles) and is verified by `tests/unit/domain.test.ts › built-in themes meet WCAG AA`.
- **Automated keyboard and focus tests** (`tests/ui/app.test.tsx`): focus trap and restore in dialogs, Esc to close, Enter on a destructive confirmation activates Cancel, `X` toggles selection in the library, `?` doesn't trigger while typing, and error-summary focus.
- **End-to-end** (`tests/e2e/smoke.spec.ts`): drives the real app through role-based locators (labels, roles, accessible names). Each step that passes also confirms the elements are reachable by accessible name.

## Manual verification status

A full manual keyboard-only and screen-reader pass by a person was **not** performed in this build environment. The automated tests above cover keyboard operation of the main flows. Before release, do a manual pass with NVDA (Windows), VoiceOver (macOS) and Orca (Linux) covering add → track → complete, library filtering, refresh, theme editing and restore.

## Known gaps

- Library grid arrow-key navigation moves focus between item links. A full ARIA `grid` pattern (row/column semantics) isn't implemented; items are exposed as a list with position and set size.
- The colour picker inputs (`<input type="color">`) rely on the OS picker's accessibility. A hex text field next to each one is the accessible alternative.
- Toasts disappear after 5–10 seconds. Undo stays available for 10 seconds, and the same action (restore deleted items) isn't otherwise available after that.

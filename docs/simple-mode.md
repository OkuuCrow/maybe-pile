# Simple Mode (2.1)

Simple Mode is the default for **new installs**; libraries that already existed when 2.1 was installed
stay in **Full** mode and see a one-time, dismissible “Try Simple view” banner. Switch any time in
Settings → Interface (or from the omnibox: features hidden in Simple Mode show “turns on Full mode”).
Switching never changes stored data; advanced features keep working in the background (configured
reminders still fire, Steam data stays, rules still run).

## How it is built

A feature registry (`src/shared/feature-registry.ts`) gives every nav entry, settings section, library
control, item panel and feature a tier (`core` / `advanced`). Screens are **not forked**: the same
components render fewer controls (progressive disclosure). Exceptions where a dedicated small
component was clearer: Home (`SimpleHome`), the Library toolbar, the Simple appearance picker and the
Reminders card.

Custom dashboard layouts and themes: Simple Mode uses its own fixed Home; Full mode still uses your saved
dashboard layout, untouched. Themes apply in both modes (Simple offers only Light/Dark/System, and keeps a
custom theme you picked in Full mode until you choose another).

## Core (shown in Simple Mode)

- **Sidebar**: Home, Library, Settings + a prominent **Add item** button. (Full adds Pile and a collapsible
  **More**: Lists, Stats, Import, Upcoming, Pick for Me, Goals, Cover wall, Triage, Loans & people, Recent
  changes, Recently deleted.)
- **Home**: omnibox (search/add), **Continue** (in-progress items with one-tap progress), short **Up Next**,
  four count tiles (In progress, Planned, Completed, All), pinned views (if you created any).
- **Library**: search, type tabs (only types you track; a hidden type that still has items stays), one status
  filter, sort (Recently updated / Title / Rating / Date added), basic bulk actions.
- **Item page**: title, cover, status, progress, rating, notes, Next step, Remind me / Mute, one-tap actions;
  everything else is inside **More details** (history, time, runs, related items, details, artwork,
  ownership, sources, Recommended by).
- **Add**: (1) title + type chip → (2) pick a search result or “Add without searching” → added as Planned.
  Offline: “Add now, look up details later”. Second tab: **Paste a list**.
- **Settings**: Appearance (theme, text size, font, spacing, backdrops), Interface, Reminders, Data sources,
  Backup & restore (incl. backup-folder check, Check my library, Recently deleted link).
- Core features from §14–§16: quick rating prompt, paste a list (text), backup destination check, Recently
  deleted, Next step, offline add queue, restore my place, dyslexia-friendly font option, ambient backdrops,
  key-free cover search, skipped episodes (TV/anime detail).

Everything else is **advanced** (Full mode): see the registry for the full list.

Plain language in Simple Mode: “Not touched in a while” (Pile Health), “Check my library” (check-up),
“Reminders” (Notifications), “Data sources” (Providers).

## Interaction rules

- Omnibox (Ctrl/Cmd+K, and always on Home): library matches first, then “Add “X” to Maybe Pile”;
  Enter does the obvious thing. In Full mode Ctrl+K opens the command palette.
- One-tap progress on cards and Continue: Movie → Mark watched; TV/Anime → +1 episode; Book → +10 pages /
  Set page; Game → Set progress; any → Start / Done / Put on hold. Reversible actions show an **Undo**
  toast (polite live region, keyboard-reachable button) instead of a confirmation; destructive actions
  (permanent delete, emptying Recently deleted, deleting a library) still confirm.
- One primary action per area; secondary actions in a labelled “… More” menu; icons always have text.
- Larger text and “more space” options; generous targets in Simple Mode.
- Dialogs never stack more than one deep; Esc closes; focus returns to the opener.
- Prompts offer “Don't ask again” (reset in Settings → Interface).
- First run (3 skippable steps): what you track → look (live preview) → “your data stays on this computer”.
  Re-open it from Settings → Interface. No sample data is forced.

## Click / keystroke budgets (enforced by `tests/ui/simple.test.tsx`)

Counted: clicks and Enter presses (“actions”); typed characters are counted separately.

| Task (from Home, Simple Mode) | Budget | Measured in the scripted walkthrough |
| --- | --- | --- |
| Add an item with online search | ≤ 4 actions | 4 (Add item, type chip, Search, result) — typing the title excluded |
| Update progress | ≤ 2 actions | 1 (“+10 pages”) |
| Find an existing item | ≤ 3 keystrokes after focusing search | 3 (“Pir” → first option is the item) |
| Change status | ≤ 2 actions | 2 (“… More” → “Put on hold”) |
| Create a backup | ≤ 3 actions | 3 (Settings → Backup & restore → Create backup) |

These are measured in jsdom with fake data (the real Electron flow is exercised more loosely by
`tests/e2e/simple.spec.ts`). **No user testing was done.**

## Heuristic self-review (honest, by the implementer)

| Heuristic | Assessment |
| --- | --- |
| Consistency | Same components in both modes; Simple labels map 1:1 to Full names (registry). Item pages in Simple still show the Full progress panel inside the main column, which is denser than the rest. |
| Visibility of state | Toggles show On/Off text; current page highlighted in nav and Settings; undo toasts announce changes; reminder status panel shows last/next check. |
| Error recovery | Undo for one-tap actions, bulk edits, rules and triage; Recently deleted for 30 days; offline adds never lose input. |
| Minimal memory load | Omnibox finds features and items; “More details” keeps advanced data one click away rather than gone. |
| Known gaps | The dyslexia-friendly option uses OpenDyslexic only if installed on the computer (bundling the font needs a new dependency — not added, see the report). Screen-reader testing with NVDA/Orca was not done; checks are axe-core + keyboard tests. |

# Quick Capture & command palette

## Command palette (Ctrl/⌘ + K)

Also available from the **Search & commands** button in the header and View → Command Palette. Type to fuzzy-search:

- **Items**: every title in your library (jump to its page);
- **Views**: Dashboard, Library, Lists, Stats, Goals, Pile Health, Upcoming, Import, Settings;
- **Actions**: Add item, Quick Capture, Pick for Me, Start Steam sync, Export library (JSON), Export upcoming releases, Switch theme, Show/Hide each dashboard component, Show keyboard shortcuts.

Accessibility: the input is an ARIA **combobox** controlling a **listbox**. ↑/↓/Home/End move the active option (`aria-activedescendant`), Enter runs it, and Esc closes the palette and returns focus to where it was. The number of results is announced politely. Ranking (`src/domain/fuzzy.ts`) is accent- and case-insensitive and deterministic: ties are broken by label, then id.

## Quick Capture (Ctrl/⌘ + Shift + N)

A small dialog: **Title** + **Type** → **Add to pile**. It adds a **Planned** item immediately through the same validated create path as the Add dialog (same Zod schema, same duplicate check). It **never waits on the network**. Afterwards, a toast offers **Open & search details** to look the item up online.

- A gentle type hint appears for titles that look like a show/book/game ("Severance season 2" → TV). It never overrides your choice.
- If a likely duplicate exists, you can open it or **Add anyway**.

### Optional global shortcut

Settings → Features → **Register a global shortcut** (off by default) adds a system-wide shortcut (default `CommandOrControl+Shift+Space`, Electron accelerator syntax) that brings Maybe Pile to the front with Quick Capture open. If another app already owns the shortcut, or the system refuses it, registration is skipped. Maybe Pile keeps working and the in-app shortcut still works. The shortcut is unregistered when you turn it off or quit.

Settings stored: `quickCapture.{globalShortcut, accelerator}` (the accelerator is validated against a strict pattern).

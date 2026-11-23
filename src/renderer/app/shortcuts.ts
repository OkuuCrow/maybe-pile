/**
 * Global keyboard shortcuts. Single-key shortcuts never fire while typing in a
 * text field; modifier shortcuts (Ctrl/Cmd+N etc.) come from the native menu.
 */
export interface ShortcutDef {
  keys: string;
  alt?: string;
  description: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { keys: 'Ctrl/⌘ + N', alt: 'N', description: 'Add a new item' },
  { keys: 'Ctrl/⌘ + K', description: 'Command palette: search items, views and actions' },
  { keys: 'Ctrl/⌘ + Shift + N', description: 'Quick Capture (add a Planned item fast)' },
  { keys: 'Ctrl/⌘ + Shift + P', description: 'Pick for Me' },
  { keys: 'Ctrl/⌘ + F', alt: '/', description: 'Focus library search' },
  { keys: 'Ctrl/⌘ + 1', alt: 'G then D', description: 'Go to Dashboard' },
  { keys: 'Ctrl/⌘ + 2', alt: 'G then L', description: 'Go to Library' },
  { keys: 'Ctrl/⌘ + ,', alt: 'G then S', description: 'Go to Settings' },
  { keys: 'Ctrl/⌘ + S', description: 'Save the form you are editing' },
  { keys: 'Esc', description: 'Cancel / close the current dialog' },
  { keys: 'X or Space', description: 'Select / deselect the focused library item' },
  { keys: 'Arrow keys', description: 'Move between library items' },
  { keys: 'Enter', description: 'Open the focused library item' },
  {
    keys: 'Space / Shift+↑↓ / Ctrl/⌘+A',
    description: 'Import review list: select, extend, select all shown',
  },
  { keys: 'I / O', description: 'Import review list: ignore / open on Steam (focused game)' },
  { keys: '?', description: 'Show this list of shortcuts' },
];

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type);
  }
  return false;
}

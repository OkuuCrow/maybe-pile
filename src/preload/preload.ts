/**
 * Sandboxed preload. Exposes exactly the enumerated API in API_SHAPE as
 * `window.maybePile`. No Node built-ins, no ipcRenderer, no generic invoke.
 * Menu events are delivered only for the fixed command names.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { buildApi, EVENT_CHANNELS, MENU_COMMANDS, type MenuCommand } from '../shared/ipc-channels';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const api = buildApi((channel, payload) => ipcRenderer.invoke(channel, payload));

const events = Object.freeze({
  onMenuCommand(cb: (command: MenuCommand) => void): () => void {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_e: unknown, command: unknown) => {
      if (typeof command === 'string' && (MENU_COMMANDS as readonly string[]).includes(command))
        cb(command as MenuCommand);
    };
    ipcRenderer.on(EVENT_CHANNELS.menuCommand, listener);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.menuCommand, listener);
    };
  },
  /** In-app reminder banner; only plain strings (length-capped) and a UUID item id pass through. */
  onInAppNotification(cb: (n: { title: string; body: string; itemId: string | null }) => void): () => void {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_e: unknown, n: unknown) => {
      if (!n || typeof n !== 'object') return;
      const { title, body, itemId } = n as Record<string, unknown>;
      if (typeof title !== 'string' || typeof body !== 'string') return;
      const id = typeof itemId === 'string' && UUID.test(itemId) ? itemId : null;
      cb({ title: title.slice(0, 200), body: body.slice(0, 400), itemId: id });
    };
    ipcRenderer.on(EVENT_CHANNELS.inAppNotification, listener);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.inAppNotification, listener);
    };
  },
  /** Notification click / maybepile://item link: navigate only (never changes data). */
  onOpenItem(cb: (itemId: string) => void): () => void {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_e: unknown, id: unknown) => {
      if (typeof id === 'string' && UUID.test(id)) cb(id);
    };
    ipcRenderer.on(EVENT_CHANNELS.openItem, listener);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.openItem, listener);
    };
  },
});

contextBridge.exposeInMainWorld('maybePile', Object.freeze({ ...api, events }));

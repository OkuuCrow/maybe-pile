/**
 * Sandboxed preload. Exposes exactly the enumerated API in API_SHAPE as
 * `window.maybePile`. No Node built-ins, no ipcRenderer, no generic invoke.
 * Menu events are delivered only for the fixed command names.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { buildApi, EVENT_CHANNELS, MENU_COMMANDS, type MenuCommand } from '../shared/ipc-channels';

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
});

contextBridge.exposeInMainWorld('maybePile', Object.freeze({ ...api, events }));

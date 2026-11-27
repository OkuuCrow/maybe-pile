/**
 * Windows toast XML (used by the Electron Notification `toastXml` option).
 *
 * - The toast body click and every button use protocol activation
 *   (`maybepile://…`), so they work even when no Maybe Pile process is
 *   running: Windows launches the registered protocol handler.
 * - Every text/attribute is XML-escaped; texts were already plain-text
 *   sanitized and length-capped by the engine.
 * - Requires the app's AppUserModelID on a Start Menu shortcut for reliable
 *   delivery/activation (see docs/notifications.md, "Windows prerequisites").
 */
import type { PlannedNotification } from '../engine/types';

export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  );
}

export function buildToastXml(n: PlannedNotification, opts: { sound: boolean; actions: boolean }): string {
  const buttons = opts.actions ? n.actions.filter((a) => a.id !== 'open').slice(0, 3) : [];
  const actions =
    buttons.length > 0
      ? `<actions>${buttons
          .map(
            (a) =>
              `<action content="${xmlEscape(a.label)}" activationType="protocol" arguments="${xmlEscape(a.url)}"/>`,
          )
          .join('')}</actions>`
      : '';
  const audio = opts.sound
    ? '<audio src="ms-winsoundevent:Notification.Reminder"/>'
    : '<audio silent="true"/>';
  return (
    `<toast launch="${xmlEscape(n.openUrl)}" activationType="protocol">` +
    `<visual><binding template="ToastGeneric"><text>${xmlEscape(n.title)}</text><text>${xmlEscape(n.body)}</text></binding></visual>` +
    actions +
    audio +
    `</toast>`
  );
}

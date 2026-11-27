/**
 * Silent notification actions (snooze / mute) handled in a short-lived
 * process launched by the OS for `maybepile://action/...` — no window, no
 * library database, only notify-state.sqlite. Item and reminder ids are
 * UUIDs, so the action is applied under every library id (harmless where the
 * id does not exist); a category mute therefore applies to all libraries.
 */
import { addDays, localDateString, zonedToUtc } from './engine/time';
import type { ProtocolCommand, SnoozeDuration } from './protocol';
import type { NotifyState } from './state/notify-state';

export function snoozeEnd(duration: SnoozeDuration, now: Date, tz: string): Date {
  if (duration === '1h') return new Date(now.getTime() + 3_600_000);
  return zonedToUtc(addDays(localDateString(now, tz), 1), '09:00', tz);
}

export function applySilentAction(
  state: NotifyState,
  libraryIds: readonly string[],
  cmd: ProtocolCommand,
  now: Date,
  tz: string,
): boolean {
  if (cmd.kind !== 'snooze' && cmd.kind !== 'mute') return false;
  for (const lib of libraryIds) {
    if (cmd.kind === 'mute') state.mute(lib, cmd.target.scope, cmd.target.id, now);
    else state.snooze(lib, cmd.target.scope, cmd.target.id, snoozeEnd(cmd.duration, now, tz));
  }
  return true;
}

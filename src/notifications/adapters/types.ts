/**
 * Delivery adapter contract. `show` never throws for expected failures; it
 * reports `unsupported` (no way to show anything here) or `failed` with a
 * short, content-free reason.
 */
import type { PlannedNotification } from '../engine/types';

export type DeliveryResult =
  { status: 'delivered' } | { status: 'unsupported'; reason: string } | { status: 'failed'; reason: string };

export interface Capabilities {
  /** Buttons (snooze/mute) can be offered. */
  actions: boolean;
  /** Body supports (escaped) markup — we never send markup, but must escape when this is on. */
  bodyMarkup: boolean;
  /** Notifications persist in a notification center after they time out. */
  persistent: boolean;
  icon: boolean;
}

export interface Notifier {
  readonly id: string;
  probe(): Promise<{ available: boolean; reason: string | null; capabilities: Capabilities }>;
  show(n: PlannedNotification, opts: { sound: boolean }): Promise<DeliveryResult>;
}

export const NO_CAPABILITIES: Capabilities = {
  actions: false,
  bodyMarkup: false,
  persistent: false,
  icon: false,
};

/** Runs a program with an argument array (never a shell string). */
export type ExecFn = (
  file: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

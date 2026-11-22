/**
 * IPC handler registration. Every channel goes through `wrap`, which:
 * 1. verifies the sender (trusted main-frame of our window, our origin),
 * 2. validates + normalizes the payload with the channel's Zod schema,
 * 3. runs the handler,
 * 4. returns `Result<T>`; errors become user-safe errors (never stacks/paths).
 */
import { z } from 'zod';
import type { Channel } from '../../shared/ipc-channels';
import { REQUEST_SCHEMAS, type ParsedRequestOf, type ResponseTypes } from '../../shared/ipc-contract';
import { AppError, err, ok, type Result, type UserSafeError } from '../../shared/result';
import type { Logger } from '../services/logger';

export interface SenderInfo {
  /** URL of the frame that sent the message, or null if unavailable. */
  frameUrl: string | null;
  /** True when the sending frame is the top-level frame. */
  isMainFrame: boolean;
  webContentsId: number;
}

export type Handlers = {
  [C in Channel]: (payload: ParsedRequestOf<C>) => Promise<ResponseTypes[C]> | ResponseTypes[C];
};

export function zodToSafe(e: z.ZodError): UserSafeError {
  const fieldErrors: Record<string, string> = {};
  for (const i of e.issues.slice(0, 50)) {
    const key = i.path.map(String).join('.') || '_';
    if (!fieldErrors[key]) fieldErrors[key] = i.message;
  }
  return {
    code: 'VALIDATION',
    message: 'Some values are not valid.',
    recovery: 'Check the highlighted fields and try again.',
    fieldErrors,
  };
}

/** Maps any thrown value to a user-safe error; unexpected errors are logged, not shown. */
export function toSafeError(e: unknown, log: Logger, channel: string): UserSafeError {
  if (e instanceof AppError) return e.safe;
  if (e instanceof z.ZodError) return zodToSafe(e);
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ERR_SQLITE_ERROR' || /SQLITE|database/i.test(msg)) {
    if (/readonly|read-only/i.test(msg)) {
      return {
        code: 'READ_ONLY',
        message: 'The library is open read-only, so changes cannot be saved.',
        recovery: 'Update Maybe Pile to edit this library.',
      };
    }
    if (/busy|locked/i.test(msg)) {
      return {
        code: 'FILE_LOCKED',
        message: 'The library is busy.',
        recovery: 'Wait a moment and try again.',
      };
    }
    if (/constraint/i.test(msg)) {
      log.warn('ipc.constraint', { channel, error: e });
      return {
        code: 'VALIDATION',
        message: 'That change would make the library inconsistent, so it was not saved.',
        recovery: 'Check the values and try again.',
      };
    }
    if (/disk|full/i.test(msg))
      return { code: 'DISK_FULL', message: 'The disk is full.', recovery: 'Free up space and try again.' };
  }
  log.error('ipc.unexpected', { channel, error: e });
  return {
    code: 'INTERNAL',
    message: 'Something went wrong. Your data was not changed.',
    recovery: 'Try again. If it keeps happening, export the diagnostic log from Settings → Logs.',
  };
}

export function createDispatcher(handlers: Handlers, isTrusted: (s: SenderInfo) => boolean, log: Logger) {
  return async function dispatch(
    channel: Channel,
    sender: SenderInfo,
    payload: unknown,
  ): Promise<Result<unknown>> {
    if (!isTrusted(sender)) {
      log.warn('ipc.untrustedSender', { channel });
      return err({ code: 'FORBIDDEN', message: 'This request is not allowed.' });
    }
    const schema = REQUEST_SCHEMAS[channel] as z.ZodType | undefined;
    const handler = handlers[channel] as ((p: unknown) => unknown) | undefined;
    if (!schema || !handler) return err({ code: 'FORBIDDEN', message: 'Unknown request.' });
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return err(zodToSafe(parsed.error));
    try {
      return ok(await handler(parsed.data));
    } catch (e) {
      return err(toSafeError(e, log, channel));
    }
  };
}

/** Origin check helper used by main.ts. */
export function makeTrustCheck(allowedOrigins: readonly string[], getWebContentsId: () => number | null) {
  return (s: SenderInfo): boolean => {
    if (!s.isMainFrame || !s.frameUrl) return false;
    if (getWebContentsId() !== s.webContentsId) return false;
    let origin: string;
    try {
      const u = new URL(s.frameUrl);
      origin = u.protocol === 'app:' ? `app://${u.host}` : u.origin;
    } catch {
      return false;
    }
    return allowedOrigins.includes(origin);
  };
}

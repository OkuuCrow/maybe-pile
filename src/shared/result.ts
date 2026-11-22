/**
 * Structured, user-safe results returned across the IPC boundary.
 *
 * Every IPC handler resolves to `Result<T>` and never rejects. Errors carry a
 * stable `code` (for logic and tests), a human `message` (safe to display), an
 * optional `recovery` hint and optional per-field messages. They never contain
 * stack traces, secrets or filesystem paths the user did not choose.
 */

export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'DATABASE',
  'IO',
  'PERMISSION',
  'DISK_FULL',
  'FILE_LOCKED',
  'CANCELLED',
  'UNSUPPORTED_VERSION',
  'CORRUPT',
  'TOO_LARGE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAUTHORIZED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_NETWORK',
  'PROVIDER_TIMEOUT',
  'PROVIDER_MALFORMED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_NOT_CONFIGURED',
  'FORBIDDEN',
  'READ_ONLY',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface UserSafeError {
  code: ErrorCode;
  message: string;
  recovery?: string;
  fieldErrors?: Record<string, string>;
  /** Seconds to wait, only for PROVIDER_RATE_LIMITED. */
  retryAfterSeconds?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: UserSafeError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: UserSafeError): Result<T> => ({ ok: false, error });

/**
 * Thrown inside the main process to signal an expected, user-facing failure.
 * The IPC wrapper converts it to `{ ok: false, error }`; anything else is
 * logged and reported as a generic INTERNAL error.
 */
export class AppError extends Error {
  readonly safe: UserSafeError;
  constructor(safe: UserSafeError) {
    super(safe.message);
    this.name = 'AppError';
    this.safe = safe;
  }
}

export const appError = (
  code: ErrorCode,
  message: string,
  extra: Omit<UserSafeError, 'code' | 'message'> = {},
): AppError => new AppError({ code, message, ...extra });

export function isResult(value: unknown): value is Result<unknown> {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  const v = value as { ok: unknown; error?: unknown };
  if (v.ok === true) return 'value' in value;
  if (v.ok === false) {
    const e = v.error as { code?: unknown; message?: unknown } | undefined;
    return typeof e?.code === 'string' && typeof e.message === 'string';
  }
  return false;
}

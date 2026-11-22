/**
 * Renderer access to the preload bridge. `call` unwraps Result<T> and throws
 * an ApiError carrying the user-safe error, so components can use try/catch
 * and still show structured messages / field errors.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MaybePileApi } from '../../shared/ipc-contract';
import { isResult, type Result, type UserSafeError } from '../../shared/result';

declare global {
  interface Window {
    maybePile?: MaybePileApi;
  }
}

export class ApiError extends Error {
  constructor(readonly safe: UserSafeError) {
    super(safe.message);
    this.name = 'ApiError';
  }
}

export function getApi(): MaybePileApi {
  const api = window.maybePile;
  if (!api)
    throw new ApiError({
      code: 'INTERNAL',
      message: 'The app bridge is unavailable.',
      recovery: 'Restart Maybe Pile.',
    });
  return api;
}

/** Unwraps a Result; throws ApiError on failure or on a malformed response. */
export async function call<T>(p: Promise<Result<T>>): Promise<T> {
  let r: unknown;
  try {
    r = await p;
  } catch {
    throw new ApiError({
      code: 'INTERNAL',
      message: 'The request could not be completed.',
      recovery: 'Try again.',
    });
  }
  if (!isResult(r)) throw new ApiError({ code: 'INTERNAL', message: 'Unexpected response from the app.' });
  const res = r as Result<T>;
  if (!res.ok) throw new ApiError(res.error);
  return res.value;
}

export function errorOf(e: unknown): UserSafeError {
  if (e instanceof ApiError) return e.safe;
  return { code: 'INTERNAL', message: 'Something went wrong.', recovery: 'Try again.' };
}

export interface AsyncState<T> {
  data: T | null;
  error: UserSafeError | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Loads data and re-loads when deps change. Stale responses are ignored. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<UserSafeError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setError(errorOf(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

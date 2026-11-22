/**
 * Toasts announced through live regions: success/info use role="status"
 * (polite), errors use role="alert" (assertive). Toasts with an action (Undo)
 * stay longer and are keyboard reachable.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UserSafeError } from '../../shared/result';
import { IconAlert, IconCheck, IconClose, IconInfo } from '../components/Icons';

export interface Toast {
  id: number;
  kind: 'success' | 'info' | 'error';
  message: string;
  detail?: string | undefined;
  action?: { label: string; run: () => void } | undefined;
}

interface ToastApi {
  show(t: Omit<Toast, 'id'>, ttlMs?: number): void;
  success(message: string, action?: Toast['action']): void;
  error(e: UserSafeError | string): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('ToastProvider missing');
  return c;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (t: Omit<Toast, 'id'>, ttlMs?: number) => {
      const id = next.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      const ttl = ttlMs ?? (t.action ? 10_000 : t.kind === 'error' ? 9_000 : 5_000);
      setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, action) => show({ kind: 'success', message, action }),
      error: (e) =>
        typeof e === 'string'
          ? show({ kind: 'error', message: e })
          : show({ kind: 'error', message: e.message, detail: e.recovery }),
    }),
    [show],
  );
  const polite = toasts.filter((t) => t.kind !== 'error');
  const assertive = toasts.filter((t) => t.kind === 'error');
  const render = (t: Toast) => (
    <div key={t.id} className={`toast toast-${t.kind}`}>
      {t.kind === 'error' ? <IconAlert /> : t.kind === 'success' ? <IconCheck /> : <IconInfo />}
      <div className="toast-body">
        <p>{t.message}</p>
        {t.detail && <p className="toast-detail">{t.detail}</p>}
      </div>
      {t.action && (
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            t.action?.run();
            dismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(t.id)}
      >
        <IconClose size={14} />
      </button>
    </div>
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-region">
        <div role="status" aria-live="polite">
          {polite.map(render)}
        </div>
        <div role="alert" aria-live="assertive">
          {assertive.map(render)}
        </div>
      </div>
    </Ctx.Provider>
  );
}

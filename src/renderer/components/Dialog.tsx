/**
 * Accessible modal dialog: role="dialog", aria-modal, labelled by its title,
 * traps Tab focus inside, restores focus to the opener on close, Esc closes
 * (unless `dismissible` is false, e.g. while saving).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './Icons';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'small' | 'medium' | 'large';
  dismissible?: boolean;
  /** Element id to focus first; defaults to the first focusable element. */
  initialFocusId?: string;
  role?: 'dialog' | 'alertdialog';
  describedBy?: string;
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  size = 'medium',
  dismissible = true,
  initialFocusId,
  role = 'dialog',
  describedBy,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const first =
      (initialFocusId ? node.querySelector<HTMLElement>(`#${CSS.escape(initialFocusId)}`) : null) ??
      node.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.closest('[hidden]') && tabbableRadio(el, node),
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    node.addEventListener('keydown', onKey);
    const previouslyFocused = opener.current;
    return () => {
      node.removeEventListener('keydown', onKey);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused))
        previouslyFocused.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="dialog-backdrop">
      <div
        ref={ref}
        className={`dialog dialog-${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          {dismissible && (
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
              <IconClose />
            </button>
          )}
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** If set, the user must type this word to enable the confirm button. */
  typeToConfirm?: string | undefined;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog. For destructive actions, focus starts on Cancel (the
 * safe default), so Enter never destroys anything by accident; the user must
 * move focus to the destructive button (or type the confirmation word).
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive,
  typeToConfirm,
  busy,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const descId = useId();
  const inputId = useId();
  const cancelId = useId();
  const [typed, setTyped] = useState('');
  const canConfirm = !busy && (!typeToConfirm || typed === typeToConfirm);
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      size="small"
      role="alertdialog"
      describedBy={descId}
      dismissible={!busy}
      initialFocusId={typeToConfirm ? inputId : cancelId}
      footer={
        <>
          <button type="button" id={cancelId} className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${destructive ? 'button-danger' : 'button-primary'}`}
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div id={descId}>{message}</div>
      {typeToConfirm && (
        <div className="field">
          <label htmlFor={inputId}>
            Type <strong>{typeToConfirm}</strong> to confirm
          </label>
          <input
            id={inputId}
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
    </Dialog>
  );
}

/** Browsers tab only to the checked radio of a group (or the first one when none is checked). */
function tabbableRadio(el: HTMLElement, root: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true;
  const group = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
    (r) => r.name === el.name && !r.disabled,
  );
  const checked = group.find((r) => r.checked);
  return checked ? checked === el : group[0] === el;
}

/** Small display components: status badge, progress bar, rating, cover, empty/error states. */
import { useState, type ReactNode } from 'react';
import { STATUSES, type MediaType, type Status } from '../../shared/enums';
import type { UserSafeError } from '../../shared/result';
import { ratingLabel } from '../../domain/rating';
import { statusLabel, typeLabel } from '../app/strings';
import { IconAlert, IconInfo, StatusIcon, TypeIcon } from './Icons';

/** Status = icon + text + color (never color alone). */
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status-badge status-${status}`}>
      <StatusIcon status={status} />
      <span>{statusLabel(status)}</span>
    </span>
  );
}

export function TypeBadge({ type }: { type: MediaType }) {
  return (
    <span className="type-badge">
      <TypeIcon type={type} />
      <span>{typeLabel(type)}</span>
    </span>
  );
}

export function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  if (percent === null) return <p className="progress-text">{label}</p>;
  return (
    <div className="progress">
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={label}
        aria-label="Progress"
      >
        <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      <p className="progress-text">{label}</p>
    </div>
  );
}

export function RatingDisplay({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="muted">Not rated</span>;
  const full = Math.floor(rating / 2);
  const half = rating % 2 === 1;
  return (
    <span className="rating" role="img" aria-label={ratingLabel(rating)}>
      <span aria-hidden="true">
        {'★'.repeat(full)}
        {half ? '⯪' : ''}
        {'☆'.repeat(5 - full - (half ? 1 : 0))}
      </span>
    </span>
  );
}

export const RATING_OPTIONS = [
  { value: '', label: 'Not rated' },
  ...Array.from({ length: 10 }, (_, i) => ({
    value: String(i + 1),
    label: `${(i + 1) / 2} star${i === 1 ? '' : 's'}`,
  })),
];

export const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: statusLabel(s) }));

/** Cover image with an accessible placeholder when missing/unavailable (offline, failed). */
export function Cover({
  url,
  title,
  type,
  size = 'medium',
}: {
  url: string | null;
  title: string;
  type: MediaType;
  size?: 'small' | 'medium' | 'large';
}) {
  const [failed, setFailed] = useState(false);
  const [lastUrl, setLastUrl] = useState(url);
  if (url !== lastUrl) {
    setLastUrl(url);
    setFailed(false);
  }
  if (!url || failed) {
    return (
      <div
        className={`cover cover-${size} cover-placeholder`}
        role="img"
        aria-label={failed ? `Cover for ${title} unavailable` : `No cover for ${title}`}
      >
        <TypeIcon type={type} size={size === 'small' ? 20 : 36} />
      </div>
    );
  }
  return (
    <img
      className={`cover cover-${size}`}
      src={url}
      alt={`Cover of ${title}`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: UserSafeError; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <IconAlert />
      <div>
        <p className="notice-title">{error.message}</p>
        {error.recovery && <p>{error.recovery}</p>}
        {onRetry && (
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function Notice({
  kind = 'info',
  children,
  onDismiss,
}: {
  kind?: 'info' | 'warning' | 'success';
  children: ReactNode;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <div className={`notice notice-${kind}`} role="status">
      {kind === 'warning' ? <IconAlert /> : <IconInfo />}
      <div className="notice-content">{children}</div>
      {onDismiss && (
        <button type="button" className="button button-small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Wraps matches of the search tokens in <mark>. Text only — never HTML. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return <>{text}</>;
  const folded = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  // Only highlight when folding didn't change string length (keeps indices aligned).
  if (folded.length !== text.length) return <>{text}</>;
  const marks: [number, number][] = [];
  for (const t of tokens) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gu');
    for (const m of folded.matchAll(re)) {
      const start = (m.index ?? 0) + (m[1]?.length ?? 0);
      marks.push([start, start + t.length]);
    }
  }
  if (marks.length === 0) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([s, e], i) => {
    if (s < pos) return;
    if (s > pos) out.push(text.slice(pos, s));
    out.push(<mark key={i}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  out.push(text.slice(pos));
  return <>{out}</>;
}

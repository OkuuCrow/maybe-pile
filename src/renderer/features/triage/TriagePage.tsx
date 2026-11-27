/**
 * §16.3 Triage: one card at a time with single-key actions, visible key hints,
 * announcements, unlimited undo within the session, a summary with Undo all,
 * and resume (position kept per source in this session).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemSummary } from '../../../shared/types';
import type { TriageUndoView } from '../../../shared/views-21';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { statusLabel, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { isTypingTarget } from '../../app/shortcuts';
import { ConfirmDialog } from '../../components/Dialog';
import { Cover, EmptyState, Loading } from '../../components/Bits';

type Act = 'keep' | 'upNext' | 'snooze' | 'hold' | 'drop' | 'skip';
const KEYS: [string, Act, string][] = [
  ['k', 'keep', 'Keep'],
  ['u', 'upNext', 'Up Next'],
  ['s', 'snooze', 'Snooze 30 days'],
  ['h', 'hold', 'Put on hold'],
  ['d', 'drop', 'Drop'],
  ['n', 'skip', 'Skip'],
];
const LABEL: Record<Act, string> = {
  keep: 'Kept',
  upNext: 'Added to Up Next',
  snooze: 'Snoozed',
  hold: 'On hold',
  drop: 'Dropped',
  skip: 'Skipped',
};

export function TriagePage() {
  const app = useApp();
  const toast = useToast();
  const lists = useAsync(() => call(getApi().lists.list()), []);
  const views = useAsync(() => call(getApi().views.list()), []);
  const [source, setSource] = useState<{ source: 'planned' | 'list' | 'view'; id: string | null }>({
    source: 'planned',
    id: null,
  });
  const [queue, setQueue] = useState<ItemSummary[] | null>(null);
  const key = `mp-triage-${source.source}-${source.id ?? ''}`;
  const [pos, setPos] = useState(0);
  const [history, setHistory] = useState<{ act: Act; undo: TriageUndoView; pos: number }[]>([]);
  const [announce, setAnnounce] = useState('');
  const [confirmDrop, setConfirmDrop] = useState<ItemSummary | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setQueue(null);
    void call(getApi().triage.queue(source))
      .then((q) => {
        if (!alive) return;
        setQueue(q);
        const saved = Number(sessionStorage.getItem(key) ?? 0);
        setPos(Number.isFinite(saved) ? Math.min(saved, q.length) : 0);
        setHistory([]);
      })
      .catch((e: unknown) => toast.error(errorOf(e)));
    return () => {
      alive = false;
    };
  }, [source, key, toast]);
  useEffect(() => sessionStorage.setItem(key, String(pos)), [key, pos]);
  const item = queue?.[pos] ?? null;
  const total = queue?.length ?? 0;

  const act = useCallback(
    async (a: Act, confirmed = false) => {
      if (!item) return;
      if (a === 'drop' && !confirmed && (item.progressPercent ?? 0) > 0) return setConfirmDrop(item);
      try {
        const r = await call(
          getApi().triage.act({ itemId: item.id, action: a, snoozeDays: a === 'snooze' ? 30 : null }),
        );
        setHistory((h) => [...h, { act: a, undo: r.undo, pos }]);
        setPos((p) => p + 1);
        setAnnounce(`${LABEL[a]}: ${item.title}. ${pos + 1} of ${total} reviewed.`);
        if (a !== 'keep' && a !== 'skip') app.bumpData();
      } catch (e) {
        toast.error(errorOf(e));
      }
    },
    [item, pos, total, app, toast],
  );
  const undoLast = useCallback(async () => {
    const last = history[history.length - 1];
    if (!last) return;
    try {
      await call(getApi().triage.undo({ undo: last.undo }));
      setHistory((h) => h.slice(0, -1));
      setPos(last.pos);
      setAnnounce(`Undid: ${LABEL[last.act]}.`);
      app.bumpData();
    } catch (e) {
      toast.error(errorOf(e));
    }
  }, [history, app, toast]);
  const undoAll = async () => {
    for (const h of [...history].reverse())
      await call(getApi().triage.undo({ undo: h.undo })).catch(() => undefined);
    setHistory([]);
    setPos(0);
    app.bumpData();
    setAnnounce('Everything from this session was undone.');
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        isTypingTarget(e.target) ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      const k = e.key.toLowerCase();
      const hit = KEYS.find(([key]) => key === k);
      if (hit) {
        e.preventDefault();
        void act(hit[1]);
      } else if (k === 'z') {
        e.preventDefault();
        void undoLast();
      } else if (k === 'o' && item) {
        e.preventDefault();
        app.navigate({ name: 'item', id: item.id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, undoLast, item, app]);

  const counts = history.reduce<Record<string, number>>((m, h) => ((m[h.act] = (m[h.act] ?? 0) + 1), m), {});
  return (
    <div className="page triage-page">
      <div className="page-header">
        <h1>Triage</h1>
      </div>
      <div className="toolbar-block row">
        <label htmlFor="triage-src">Review</label>
        <select
          id="triage-src"
          className="input input-inline"
          value={`${source.source}:${source.id ?? ''}`}
          onChange={(e) => {
            const [s, id] = e.target.value.split(':');
            setSource({ source: s as 'planned', id: id || null });
          }}
        >
          <option value="planned:">All Planned items</option>
          {(lists.data ?? []).map((l) => (
            <option key={l.id} value={`list:${l.id}`}>
              List: {l.name}
            </option>
          ))}
          {(views.data ?? []).map((v) => (
            <option key={v.id} value={`view:${v.id}`}>
              View: {v.name}
            </option>
          ))}
        </select>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>
      {!queue && <Loading />}
      {queue && total === 0 && <EmptyState title="Nothing to review here" />}
      {queue && total > 0 && (
        <p className="muted">
          {Math.min(pos, total)} of {total} reviewed
        </p>
      )}
      {item && (
        <div ref={cardRef} className="triage-card" aria-labelledby="triage-title">
          <Cover url={item.thumbUrl} title={item.title} type={item.type} size="large" />
          <div>
            <h2 id="triage-title">{item.title}</h2>
            <p>
              {typeLabel(item.type)}
              {item.year ? ` · ${item.year}` : ''} · {statusLabel(item.status)}
            </p>
            <p className="muted">{item.progressLabel}</p>
            {item.nextStep && !item.nextStepSpoiler && <p>Next: {item.nextStep}</p>}
            <div className="button-row triage-actions">
              {KEYS.map(([k, a, label]) => (
                <button
                  key={a}
                  type="button"
                  className="button"
                  onClick={() => void act(a)}
                  aria-keyshortcuts={k}
                >
                  {label} <kbd>{k.toUpperCase()}</kbd>
                </button>
              ))}
              <button
                type="button"
                className="button"
                onClick={() => void undoLast()}
                disabled={history.length === 0}
                aria-keyshortcuts="z"
              >
                Undo last <kbd>Z</kbd>
              </button>
              <a className="button" href={`#/item/${item.id}`} aria-keyshortcuts="o">
                Open details <kbd>O</kbd>
              </a>
            </div>
          </div>
        </div>
      )}
      {queue && total > 0 && pos >= total && (
        <section className="triage-summary" aria-labelledby="triage-sum">
          <h2 id="triage-sum">Done</h2>
          <p>
            {Object.entries(counts)
              .map(([a, n]) => `${LABEL[a as Act]} ${n}`)
              .join(' · ') || 'No changes.'}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button"
              onClick={() => void undoAll()}
              disabled={history.length === 0}
            >
              Undo all
            </button>
            <button type="button" className="button" onClick={() => (setPos(0), setHistory([]))}>
              Start over
            </button>
          </div>
        </section>
      )}
      {confirmDrop && (
        <ConfirmDialog
          title={`Drop ${confirmDrop.title}?`}
          message="It has progress. It moves to Dropped (you can undo)."
          confirmLabel="Drop"
          onCancel={() => setConfirmDrop(null)}
          onConfirm={() => {
            setConfirmDrop(null);
            void act('drop', true);
          }}
        />
      )}
    </div>
  );
}

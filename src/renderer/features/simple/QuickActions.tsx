/**
 * One-tap progress (§13.4): Movies → Mark watched; TV/Anime → +1 episode;
 * Books → +10 pages / set page; Games → set progress; every type → Start /
 * Done / Put on hold. Reversible actions use an Undo toast (keyboard
 * reachable, announced politely) instead of a confirmation dialog.
 */
import { useId, useState } from 'react';
import type { ItemSummary } from '../../../shared/types';
import { call, errorOf, getApi } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';
import { NumberField } from '../../components/Fields';

type Action = 'watched' | 'nextEpisode' | 'pages10' | 'setPage' | 'setPercent' | 'start' | 'done' | 'hold';

export const ACTION_LABELS: Record<Action, string> = {
  watched: 'Mark watched',
  nextEpisode: '+1 episode',
  pages10: '+10 pages',
  setPage: 'Set page…',
  setPercent: 'Set progress…',
  start: 'Start',
  done: 'Done',
  hold: 'Put on hold',
};

export function actionsFor(item: Pick<ItemSummary, 'type' | 'status'>): Action[] {
  const a: Action[] = [];
  if (item.type === 'movie' && item.status !== 'completed') a.push('watched');
  if ((item.type === 'tv' || item.type === 'anime') && item.status !== 'completed') a.push('nextEpisode');
  if (item.type === 'book' && item.status !== 'completed') a.push('pages10', 'setPage');
  if (item.type === 'game' && item.status !== 'completed') a.push('setPercent');
  if (item.status !== 'in_progress' && item.status !== 'completed') a.push('start');
  if (item.status !== 'completed' && item.type !== 'movie') a.push('done');
  if (item.status === 'in_progress') a.push('hold');
  return a;
}

/** Fired after something becomes Completed by a single user action (never for bulk/import/sync). */
export const COMPLETED_EVENT = 'mp:completed';
export function emitCompleted(itemId: string, title: string, rating: number | null): void {
  window.dispatchEvent(new CustomEvent(COMPLETED_EVENT, { detail: { itemId, title, rating } }));
}

export function useQuickAction() {
  const app = useApp();
  const toast = useToast();
  return async (
    item: ItemSummary,
    action: Action,
    value: number | null = null,
  ): Promise<ItemSummary | null> => {
    try {
      const r = await call(getApi().quick.act({ itemId: item.id, action, value }));
      app.bumpData();
      toast.show(
        {
          kind: 'success',
          message: r.message,
          detail: r.suggestion?.message,
          action: {
            label: 'Undo',
            run: () =>
              void call(getApi().quick.undo({ token: r.undoToken }))
                .then(() => {
                  app.bumpData();
                  toast.show({ kind: 'info', message: 'Undone.' });
                })
                .catch((e: unknown) => toast.error(errorOf(e))),
          },
        },
        10_000,
      );
      if (item.status !== 'completed' && r.item.status === 'completed')
        emitCompleted(item.id, item.title, r.item.rating);
      return r.item;
    } catch (e) {
      toast.error(errorOf(e));
      return null;
    }
  };
}

/** Primary one-tap button + a labelled "…" menu with the rest (text labels, never icons alone). */
export function QuickActions({ item, compact = false }: { item: ItemSummary; compact?: boolean }) {
  const act = useQuickAction();
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState<'setPage' | 'setPercent' | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const menuId = useId();
  const actions = actionsFor(item);
  if (actions.length === 0) return null;
  const [primary, ...rest] = actions;
  if (!primary) return null;
  const run = (a: Action) => {
    setOpen(false);
    if (a === 'setPage' || a === 'setPercent') {
      setValue(null);
      setAsk(a);
      return;
    }
    void act(item, a);
  };
  return (
    <div className={`quick-actions ${compact ? 'quick-compact' : ''}`}>
      <button
        type="button"
        className="button button-small button-primary"
        onClick={() => run(primary)}
        aria-label={`${ACTION_LABELS[primary]}: ${item.title}`}
      >
        {ACTION_LABELS[primary]}
      </button>
      {rest.length > 0 && (
        <div className="menu-wrap">
          <button
            type="button"
            className="button button-small"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={`More actions for ${item.title}`}
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          >
            … More
          </button>
          {open && (
            <div
              id={menuId}
              className="menu"
              role="menu"
              tabIndex={-1}
              onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            >
              {rest.map((a) => (
                <button key={a} type="button" role="menuitem" className="menu-item" onClick={() => run(a)}>
                  {ACTION_LABELS[a]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {ask && (
        <Dialog
          title={ask === 'setPage' ? `Page for ${item.title}` : `Progress for ${item.title}`}
          onClose={() => setAsk(null)}
          size="small"
          footer={
            <button
              type="button"
              className="button button-primary"
              disabled={value === null}
              onClick={() => {
                const a = ask;
                setAsk(null);
                void act(item, a, value);
              }}
            >
              Save
            </button>
          }
        >
          <NumberField
            label={ask === 'setPage' ? 'Page' : 'Percent done (0–100)'}
            value={value}
            onChange={setValue}
            min={0}
            max={ask === 'setPage' ? 100_000 : 100}
          />
        </Dialog>
      )}
    </div>
  );
}

/**
 * Item detail additions (2.1): Next step, reminders + mute, one-tap actions,
 * "More details" disclosure (Simple Mode), checklist, loans, recommended by,
 * journal, backdrop style, and the backdrop layer itself.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ItemDetail } from '../../../shared/types';
import type { BackdropStyle } from '../../../shared/schemas';
import { resolveBackdrop, scrimOpacity } from '../../../domain/backdrop';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtDateTime, todayLocal } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog } from '../../components/Dialog';
import { Checkbox, SelectField, TextArea, TextField } from '../../components/Fields';
import { RemindersManager } from '../notifications/Reminders';
import { QuickActions } from '../simple/QuickActions';

/** Simple Mode wraps secondary sections in one collapsed "More details"; Full mode shows them as-is. */
export function MoreDetails({ children, label = 'More details' }: { children: ReactNode; label?: string }) {
  const app = useApp();
  if (app.level !== 'simple') return <>{children}</>;
  return (
    <details className="more-details">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

/** Next step (core), Remind me / mute (core), one-tap actions. */
export function ItemQuickPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const toast = useToast();
  const extras = useAsync(
    () => call(getApi().extras.forItem({ itemId: item.id })),
    [item.id, app.dataVersion],
  );
  const controls = useAsync(() => call(getApi().notify.itemControls({ itemId: item.id })), [item.id]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [remind, setRemind] = useState(false);
  const ns = extras.data?.nextStep ?? null;
  const save = async (text: string | null, sp: boolean) => {
    try {
      await call(getApi().extras.setNextStep({ itemId: item.id, text, spoiler: sp }));
      setEditing(false);
      extras.reload();
      app.bumpData();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const summary = useMemo(
    () => ({
      id: item.id,
      type: item.type,
      title: item.meta.title,
      year: null,
      status: item.personal.status,
      rating: item.personal.rating,
      tags: [],
      creators: [],
      dateAdded: item.personal.dateAdded,
      updatedAt: item.updatedAt,
      releaseDate: null,
      thumbUrl: null,
      progressPercent: item.progress.percent,
      progressLabel: item.progress.label,
    }),
    [item],
  );
  const muted = controls.data?.muted ?? false;
  return (
    <section className="card" aria-labelledby="sec-next">
      <h2 id="sec-next">Next step</h2>
      {!editing ? (
        <p>
          {ns ? (
            ns.spoiler ? (
              <span>
                <span aria-hidden="true">🛡 </span>Hidden (marked as a spoiler).{' '}
              </span>
            ) : (
              <span className="next-step-line">{ns.text} </span>
            )
          ) : (
            <span className="muted">No next step. </span>
          )}
          {!readOnly && (
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setDraft(ns?.text ?? '');
                setSpoiler(ns?.spoiler ?? false);
                setEditing(true);
              }}
            >
              {ns ? 'Edit' : 'Add a next step'}
            </button>
          )}
        </p>
      ) : (
        <div>
          <label htmlFor="next-step-input">Next step</label>
          <input
            id="next-step-input"
            className="input"
            maxLength={140}
            value={draft}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            placeholder="e.g. finish chapter 3"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save(draft.trim() || null, spoiler);
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <Checkbox
            label="This is spoilery (hide it in lists and reminders)"
            checked={spoiler}
            onChange={setSpoiler}
          />
          <p className="field-hint">Enter saves, Esc cancels.</p>
          <div className="button-row">
            <button
              type="button"
              className="button button-small button-primary"
              onClick={() => void save(draft.trim() || null, spoiler)}
            >
              Save
            </button>
            {ns && (
              <button type="button" className="button button-small" onClick={() => void save(null, false)}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
      {!readOnly && <QuickActions item={summary} />}
      {!readOnly && (
        <div className="button-row">
          <button type="button" className="button button-small" onClick={() => setRemind(true)}>
            Remind me…
          </button>
          <button
            type="button"
            className="button button-small"
            aria-pressed={muted}
            onClick={() =>
              void call(getApi().notify.setItemMute({ itemId: item.id, muted: !muted }))
                .then(() => {
                  controls.reload();
                  toast.show({
                    kind: 'info',
                    message: muted
                      ? 'Reminders for this item are on again.'
                      : 'Reminders for this item are muted.',
                  });
                })
                .catch((e: unknown) => toast.error(errorOf(e)))
            }
          >
            {muted ? 'Unmute reminders' : 'Mute reminders for this item'}
          </button>
        </div>
      )}
      {remind && (
        <div className="reminders-inline">
          <RemindersManager itemId={item.id} fixedItem={{ id: item.id, title: item.meta.title }} />
          <button type="button" className="button button-small" onClick={() => setRemind(false)}>
            Close reminders
          </button>
        </div>
      )}
    </section>
  );
}

/** Checklist (Full), loans (Full), recommended by (core, inside More details), journal (Full), backdrop style (Full). */
export function Pack21Panels({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const full = app.level === 'full';
  return (
    <>
      {full && <ChecklistPanel item={item} readOnly={readOnly} />}
      <RecommenderPanel item={item} readOnly={readOnly} />
      {full && <LoansPanel item={item} readOnly={readOnly} />}
      {full && <JournalPanel item={item} readOnly={readOnly} />}
      {full && <BackdropStylePanel item={item} readOnly={readOnly} />}
    </>
  );
}

function ChecklistPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const toast = useToast();
  const [text, setText] = useState('');
  const data = useAsync(() => call(getApi().extras.forItem({ itemId: item.id })), [item.id, app.dataVersion]);
  const cl = data.data?.checklist;
  const op = (o: Parameters<ReturnType<typeof getApi>['extras']['checklist']>[0]) =>
    void call(getApi().extras.checklist(o))
      .then((r) => {
        data.reload();
        if (r.complete && item.personal.status !== 'completed')
          toast.show({
            kind: 'info',
            message:
              'Everything on the checklist is done. Mark it Completed from the Status menu if you like.',
          });
      })
      .catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <section className="card" aria-labelledby="sec-checklist">
      <h2 id="sec-checklist">Checklist {cl && cl.total > 0 ? `(${cl.done} of ${cl.total})` : ''}</h2>
      <p className="field-hint">Separate from progress: it never changes the status by itself.</p>
      <ul className="checklist">
        {(cl?.entries ?? []).map((e, i, all) => (
          <li key={e.id} className="row">
            <Checkbox
              label={e.text}
              checked={e.checked}
              onChange={(v) => !readOnly && op({ op: 'check', itemId: item.id, entryId: e.id, checked: v })}
            />
            {!readOnly && (
              <>
                <button
                  type="button"
                  className="button button-small"
                  disabled={i === 0}
                  onClick={() => op({ op: 'move', itemId: item.id, entryId: e.id, direction: 'up' })}
                  aria-label={`Move “${e.text}” up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="button button-small"
                  disabled={i === all.length - 1}
                  onClick={() => op({ op: 'move', itemId: item.id, entryId: e.id, direction: 'down' })}
                  aria-label={`Move “${e.text}” down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => op({ op: 'delete', itemId: item.id, entryId: e.id })}
                  aria-label={`Delete “${e.text}”`}
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) op({ op: 'add', itemId: item.id, text: text.trim() });
            setText('');
          }}
        >
          <TextField label="New checklist entry" value={text} onChange={setText} maxLength={200} />
          <button type="submit" className="button button-small">
            Add
          </button>
        </form>
      )}
    </section>
  );
}

function RecommenderPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const toast = useToast();
  const data = useAsync(() => call(getApi().extras.forItem({ itemId: item.id })), [item.id, app.dataVersion]);
  const names = useAsync(() => call(getApi().extras.peopleNames()), []);
  const [person, setPerson] = useState<string | null>(null);
  const cur = data.data?.recommender ?? null;
  const value = person ?? cur?.person ?? '';
  const listId = `rec-names-${item.id}`;
  const save = () =>
    void call(
      getApi().extras.setRecommender({
        itemId: item.id,
        person: value.trim() || null,
        note: cur?.note ?? null,
        recommendedOn: cur?.recommendedOn ?? todayLocal(),
      }),
    )
      .then(() => {
        setPerson(null);
        data.reload();
        toast.success(value.trim() ? 'Saved.' : 'Removed.');
      })
      .catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <section className="card" aria-labelledby="sec-rec">
      <h2 id="sec-rec">Recommended by</h2>
      <div className="row">
        <div className="field">
          <label htmlFor={`${listId}-input`}>Person or source</label>
          <input
            id={`${listId}-input`}
            className="input"
            list={listId}
            maxLength={80}
            value={value}
            disabled={readOnly}
            onChange={(e) => setPerson(e.target.value)}
          />
          <datalist id={listId}>
            {(names.data ?? []).map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
        {!readOnly && person !== null && (
          <button type="button" className="button button-small" onClick={save}>
            Save
          </button>
        )}
      </div>
      <p className="field-hint">Kept on this computer only; never shown in share pages.</p>
    </section>
  );
}

function LoansPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const toast = useToast();
  const data = useAsync(() => call(getApi().extras.forItem({ itemId: item.id })), [item.id, app.dataVersion]);
  const [dir, setDir] = useState<'lent' | 'borrowed'>('lent');
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const loans = data.data?.loans ?? [];
  const add = () =>
    void call(
      getApi().extras.saveLoan({
        id: null,
        itemId: item.id,
        person: who,
        direction: dir,
        loanedOn: todayLocal(),
        dueOn: due || null,
        returnedOn: null,
        note: null,
      }),
    )
      .then(() => {
        setWho('');
        setDue('');
        data.reload();
        app.bumpData();
      })
      .catch((e: unknown) => toast.error(errorOf(e)));
  const returned = (l: (typeof loans)[number]) =>
    void call(
      getApi().extras.saveLoan({
        id: l.id,
        itemId: item.id,
        person: l.person,
        direction: l.direction,
        loanedOn: l.loanedOn,
        dueOn: l.dueOn,
        returnedOn: todayLocal(),
        note: l.note,
      }),
    )
      .then(() => data.reload())
      .catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <section className="card" aria-labelledby="sec-loans">
      <h2 id="sec-loans">Lent &amp; borrowed</h2>
      <ul className="plain-list">
        {loans.map((l) => (
          <li key={l.id}>
            {l.direction === 'lent' ? 'Lent to' : 'Borrowed from'} {l.person} on {l.loanedOn}
            {l.dueOn ? ` · due ${l.dueOn}` : ''}
            {l.returnedOn ? ` · returned ${l.returnedOn}` : ''}
            {l.overdue && <span className="badge badge-warning"> ⚠ Overdue</span>}
            {!readOnly && !l.returnedOn && (
              <button type="button" className="button button-small" onClick={() => returned(l)}>
                Mark returned
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                className="button button-small"
                onClick={() => setDeleting(l.id)}
                aria-label="Delete loan"
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="field-row">
          <SelectField
            label="Direction"
            value={dir}
            onChange={setDir}
            options={[
              { value: 'lent', label: 'I lent it to' },
              { value: 'borrowed', label: 'I borrowed it from' },
            ]}
          />
          <TextField label="Name" value={who} onChange={setWho} maxLength={80} />
          <TextField label="Due (optional)" type="date" value={due} onChange={setDue} />
          <button type="button" className="button button-small" disabled={!who.trim()} onClick={add}>
            Add loan
          </button>
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete loan?"
          message="This loan record will be deleted."
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            void call(getApi().extras.deleteLoan({ id })).then(() => data.reload());
          }}
        />
      )}
    </section>
  );
}

function JournalPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const toast = useToast();
  const list = useAsync(() => call(getApi().extras.journal({ itemId: item.id })), [item.id]);
  const [body, setBody] = useState('');
  const [label, setLabel] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const add = () =>
    void call(
      getApi().extras.saveJournal({
        id: null,
        itemId: item.id,
        entryDate: todayLocal(),
        body,
        progressLabel: label.trim() || null,
        spoiler,
      }),
    )
      .then((r) => {
        list.setData(r);
        setBody('');
        setLabel('');
        setSpoiler(false);
      })
      .catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <section className="card" aria-labelledby="sec-journal">
      <h2 id="sec-journal">Journal</h2>
      <ol className="journal">
        {(list.data ?? []).map((j) => (
          <li key={j.id}>
            <p className="muted">
              {j.entryDate}
              {j.progressLabel ? ` · ${j.progressLabel}` : ''}
            </p>
            {j.spoiler && !shown.has(j.id) ? (
              <button
                type="button"
                className="button button-small"
                onClick={() => setShown((s) => new Set(s).add(j.id))}
              >
                <span aria-hidden="true">🛡 </span>Reveal spoiler entry
              </button>
            ) : (
              <p className="journal-body">{j.body}</p>
            )}
            {!readOnly && (
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  void call(getApi().extras.deleteJournal({ id: j.id })).then(() => list.reload())
                }
                aria-label={`Delete journal entry from ${j.entryDate}`}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ol>
      {!readOnly && (
        <>
          <TextArea label="New entry" value={body} onChange={setBody} rows={3} maxLength={20000} />
          <div className="field-row">
            <TextField
              label="Progress tag (optional, e.g. S2E5)"
              value={label}
              onChange={setLabel}
              maxLength={40}
            />
            <Checkbox label="Contains spoilers" checked={spoiler} onChange={setSpoiler} />
          </div>
          <button type="button" className="button button-small" disabled={!body.trim()} onClick={add}>
            Add entry
          </button>
        </>
      )}
    </section>
  );
}

function BackdropStylePanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const toast = useToast();
  const bd = useAsync(() => call(getApi().backdrop.forItem({ itemId: item.id })), [item.id]);
  if (!bd.data) return null;
  return (
    <section className="card" aria-labelledby="sec-bd">
      <h2 id="sec-bd">Backdrop</h2>
      <SelectField
        label="Backdrop for this item"
        value={bd.data.itemStyle}
        onChange={(v) =>
          !readOnly &&
          void call(getApi().backdrop.setItemStyle({ itemId: item.id, style: v }))
            .then((r) => {
              bd.setData(r);
              window.dispatchEvent(new CustomEvent('mp:backdrop-changed'));
            })
            .catch((e: unknown) => toast.error(errorOf(e)))
        }
        options={[
          { value: 'default', label: 'Same as Settings' },
          { value: 'off', label: 'Off' },
          { value: 'ambient', label: 'Ambient (from cover colors)' },
          { value: 'banner', label: 'Banner image' },
          { value: 'blurred', label: 'Full-page blurred' },
        ]}
      />
      {!bd.data.backgroundUrl && (
        <p className="field-hint">
          No background image yet. Pick one in Artwork… (Background tab) or use Ambient.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ backdrop layer */

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

/**
 * Renders the backdrop behind the item page. The scrim is solved for WCAG AA
 * against the image's own extremes (or pure black/white when unknown).
 */
export function ItemBackdrop({ item, artHidden }: { item: ItemDetail; artHidden: boolean }) {
  const app = useApp();
  const [tick, setTick] = useState(0);
  const bd = useAsync(
    () => call(getApi().backdrop.forItem({ itemId: item.id })),
    [item.id, tick, item.artwork?.id],
  );
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener('mp:backdrop-changed', on);
    return () => window.removeEventListener('mp:backdrop-changed', on);
  }, []);
  const prefersContrast =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(prefers-contrast: more)').matches ||
      window.matchMedia('(prefers-reduced-transparency: reduce)').matches);
  const s = app.settings;
  const ref = useRef<HTMLDivElement>(null);
  if (!s || !bd.data) return null;
  const decision = resolveBackdrop({
    global: s.backdrops.style as BackdropStyle,
    item: bd.data.itemStyle,
    reduceEffects: s.interface.reduceEffects,
    prefersContrast,
    artHidden,
    adultBlurred: bd.data.adult && s.anime.blurAdultArt,
    hasBackgroundImage: !!bd.data.backgroundUrl,
    hasCover: !!item.artwork,
  });
  if (decision.style === 'off') return null;
  const text = cssVar('--mp-text', '#1d1b18');
  const bg = cssVar('--mp-bg', '#f6f5f2');
  const alpha = scrimOpacity({
    textHex: text,
    scrimHex: bg,
    palette: decision.style === 'ambient' ? bd.data.palette : null,
    intensity: s.backdrops.intensity,
    themeMin: 0.35,
  });
  const pal = bd.data.palette?.colors ?? [];
  const image = decision.style === 'banner' || decision.style === 'blurred' ? bd.data.backgroundUrl : null;
  const style: React.CSSProperties =
    decision.style === 'ambient'
      ? {
          backgroundImage: `linear-gradient(135deg, ${pal[0] ?? '#888888'}, ${pal[1] ?? pal[0] ?? '#666666'} 60%, ${pal[2] ?? bg})`,
        }
      : {
          backgroundImage: image ? `url("${image.replace(/["\\]/g, '')}")` : undefined,
          filter: decision.style === 'blurred' ? `blur(${s.backdrops.blur}px)` : undefined,
        };
  return (
    <div ref={ref} className={`item-backdrop backdrop-${decision.style}`} aria-hidden="true">
      <div className="backdrop-image" style={style} />
      <div className="backdrop-scrim" style={{ backgroundColor: bg, opacity: alpha }} />
    </div>
  );
}

export { fmtDateTime };

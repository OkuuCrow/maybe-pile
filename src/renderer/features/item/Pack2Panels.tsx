/**
 * Expansion Pack 2 item panels. Every panel is keyboard-operable and labelled;
 * state is never conveyed by color alone (text labels accompany badges).
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ARTWORK_SLOTS,
  ARTWORK_SLOT_LABELS,
  AVAILABILITY_KINDS,
  RELATION_LABELS,
  type ArtworkSlot,
  type AvailabilityKind,
  type RelationInput,
} from '../../../shared/enums';
import type {
  ArtworkCandidateView,
  ArtworkGallery,
  ArtworkSlotView,
  AvailabilityView,
  FranchiseView,
  ItemDetail,
  ItemPrefsView,
  ItemSummary,
  MoodView,
  PurchaseView,
  RelationView,
  RunView,
  SessionView,
  StreamingLinkView,
  SuggestionView,
} from '../../../shared/types';
import { DEFAULT_LIBRARY_QUERY } from '../../../shared/schemas';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtPartialDate, statusLabel, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { formatMoney, parseAmount } from '../../../domain/value';
import { formatDuration } from '../../../domain/sessions';
import { Dialog } from '../../components/Dialog';
import { Checkbox, NumberField, SelectField, TextField } from '../../components/Fields';
import { ErrorBox, Loading } from '../../components/Bits';

/* ---------------------------------------------------------------- shared helpers */

function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      return r;
    } catch (e) {
      toast.error(errorOf(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export const fmtMinutes = (m: number | null): string => {
  if (m === null) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return r ? `${h} h ${r} min` : `${h} h`;
};

/** Spoiler Shield state shared with the progress panels (episode titles). */
export const SpoilerShieldContext = createContext<{ active: boolean; revealed: boolean; reveal: () => void }>(
  {
    active: false,
    revealed: false,
    reveal: () => undefined,
  },
);
export const useSpoilerShield = () => useContext(SpoilerShieldContext);

/** Text hidden behind a labelled Reveal button while the shield is active. */
export function SpoilerText({ text, label }: { text: string; label: string }) {
  const s = useSpoilerShield();
  const [shown, setShown] = useState(false);
  if (!s.active || s.revealed || shown) return <>{text}</>;
  return (
    <span className="spoiler-hidden">
      <span className="muted">{label} hidden (Spoiler Shield).</span>{' '}
      <button type="button" className="button button-small" onClick={() => setShown(true)}>
        Reveal
      </button>
    </span>
  );
}

/* ---------------------------------------------------------------- preferences / spoiler shield */

export function PrefsPanel({
  item,
  readOnly,
  prefs,
  onChange,
}: {
  item: ItemDetail;
  readOnly: boolean;
  prefs: ItemPrefsView | null;
  onChange: (p: ItemPrefsView) => void;
}) {
  const { busy, run } = useRun();
  if (!prefs) return <Loading />;
  const set = (patch: Partial<Omit<ItemPrefsView, 'shieldActive'>>) =>
    void run(() => call(getApi().itemExtras.setPrefs({ itemId: item.id, ...patch }))).then(
      (p) => p && onChange(p),
    );
  return (
    <div className="stack">
      <SelectField
        label="Spoiler Shield"
        hint={prefs.shieldActive ? 'On: unwatched episode titles are hidden.' : 'Off for this item.'}
        value={prefs.spoilerMode}
        onChange={(v) => set({ spoilerMode: v })}
        options={[
          { value: 'default', label: 'Use app default' },
          { value: 'shield', label: 'Always shield' },
          { value: 'show', label: 'Never shield' },
        ]}
      />
      <Checkbox
        label="My notes contain spoilers"
        hint="Notes stay hidden behind a Reveal button."
        checked={prefs.notesSpoiler}
        onChange={(v) => set({ notesSpoiler: v })}
      />
      {item.type === 'game' && (
        <SelectField
          label="Hours played come from"
          hint="Sessions never overwrite hours you typed unless you choose “Sessions”."
          value={prefs.hoursSource}
          onChange={(v) => set({ hoursSource: v })}
          options={[
            { value: 'manual', label: 'What I enter (default)' },
            { value: 'sessions', label: 'Session timer totals' },
            { value: 'steam', label: 'Steam playtime imports' },
          ]}
        />
      )}
      {item.type === 'anime' && (
        <SelectField
          label="Audio preference"
          value={prefs.audioPref ?? ''}
          onChange={(v) => set({ audioPref: v === '' ? null : v })}
          options={[
            { value: '' as const, label: 'Use app default' },
            { value: 'sub', label: 'Subtitles' },
            { value: 'dub', label: 'Dub' },
            { value: 'both', label: 'Either' },
          ]}
        />
      )}
      {(busy || readOnly) && <span className="visually-hidden">{busy ? 'Saving…' : ''}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------- artwork */

export function ArtworkSlotsPanel({
  item,
  readOnly,
  onChanged,
}: {
  item: ItemDetail;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const app = useApp();
  const q = useAsync(() => call(getApi().artwork.slots({ itemId: item.id })), [item.id, app.dataVersion]);
  const [picker, setPicker] = useState<ArtworkSlot | null>(null);
  const { busy, run } = useRun();
  const blur = app.settings?.anime.blurAdultArt ?? true;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const slots = q.data;
  const revert = (slot: ArtworkSlot) =>
    void run(
      () => call(getApi().artwork.revert({ itemId: item.id, slot })),
      'Reverted to automatic artwork.',
    ).then((s) => s && (q.setData(s), onChanged()));
  return (
    <>
      <ul className="artwork-slots" aria-label="Artwork slots">
        {slots.map((s) => (
          <li key={s.slot} className="artwork-slot">
            <div className="artwork-slot-head">
              <strong>{ARTWORK_SLOT_LABELS[s.slot]}</strong>{' '}
              <span className="muted">
                {s.artworkId ? (s.userSelected ? 'Your choice' : 'Automatic') : 'None'}
                {s.cacheState === 'remote-only' ? ' · shown live' : ''}
              </span>
            </div>
            {s.thumbUrl ? (
              <SafeThumb
                url={s.thumbUrl}
                alt={`${ARTWORK_SLOT_LABELS[s.slot]} for ${item.meta.title}`}
                adult={s.adult && blur}
                slot={s.slot}
              />
            ) : (
              <div className={`artwork-thumb artwork-${s.slot} artwork-empty`} aria-hidden="true" />
            )}
            {s.attribution && <p className="muted small">{s.attribution}</p>}
            {!readOnly && (
              <div className="row wrap">
                <button type="button" className="button button-small" onClick={() => setPicker(s.slot)}>
                  Choose…
                </button>
                {s.userSelected && (
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy}
                    onClick={() => revert(s.slot)}
                  >
                    Revert to automatic
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {picker && (
        <ArtworkPickerDialog
          item={item}
          initialSlot={picker}
          onClose={() => setPicker(null)}
          onChosen={(s) => (q.setData(s), onChanged())}
        />
      )}
    </>
  );
}

function SafeThumb({
  url,
  alt,
  adult,
  slot,
}: {
  url: string;
  alt: string;
  adult: boolean;
  slot: ArtworkSlot;
}) {
  const [revealed, setRevealed] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div
        className={`artwork-thumb artwork-${slot} artwork-empty`}
        role="img"
        aria-label={`${alt} (unavailable)`}
      />
    );
  return (
    <div className="artwork-thumb-wrap">
      <img
        className={`artwork-thumb artwork-${slot}${adult && !revealed ? ' artwork-blurred' : ''}`}
        src={url}
        alt={adult && !revealed ? `${alt} (adult content, blurred)` : alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      {adult && !revealed && (
        <button
          type="button"
          className="button button-small artwork-reveal"
          onClick={() => setRevealed(true)}
        >
          Adult content — show
        </button>
      )}
    </div>
  );
}

export function ArtworkPickerDialog({
  item,
  initialSlot,
  onClose,
  onChosen,
}: {
  item: ItemDetail;
  initialSlot: ArtworkSlot;
  onClose: () => void;
  onChosen: (slots: ArtworkSlotView[]) => void;
}) {
  const app = useApp();
  const toast = useToast();
  const [slot, setSlot] = useState<ArtworkSlot>(initialSlot);
  const [source, setSource] = useState<string>('all');
  const [lang, setLang] = useState<string>('all');
  const [preview, setPreview] = useState<ArtworkCandidateView | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useAsync<ArtworkGallery>(() => call(getApi().artwork.gallery({ itemId: item.id })), [item.id]);
  const blur = app.settings?.anime.blurAdultArt ?? true;
  const gridRef = useRef<HTMLUListElement>(null);
  const headingId = useId();

  const list = useMemo(
    () =>
      (q.data?.candidates ?? []).filter(
        (c) =>
          c.slot === slot &&
          (source === 'all' || c.sourceId === source) &&
          (lang === 'all' || (lang === 'none' ? c.language === null : c.language === lang)),
      ),
    [q.data, slot, source, lang],
  );
  const sources = [
    ...new Set((q.data?.candidates ?? []).filter((c) => c.slot === slot).map((c) => c.sourceId)),
  ];
  const langs = [
    ...new Set(
      (q.data?.candidates ?? [])
        .filter((c) => c.slot === slot)
        .map((c) => c.language)
        .filter((l): l is string => !!l),
    ),
  ];
  const counts = Object.fromEntries(
    ARTWORK_SLOTS.map((s) => [s, (q.data?.candidates ?? []).filter((c) => c.slot === s).length]),
  );

  const choose = async (c: ArtworkCandidateView) => {
    setBusy(true);
    try {
      const r = await call(getApi().artwork.choose({ itemId: item.id, token: c.token }));
      if (r.warning) toast.show({ kind: 'info', message: r.warning });
      else toast.success(`${ARTWORK_SLOT_LABELS[c.slot]} updated.`);
      onChosen(r.slots);
      onClose();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  // Arrow-key navigation across the gallery grid (roving focus over buttons).
  const onKey = (e: React.KeyboardEvent) => {
    const btns = [
      ...(gridRef.current?.querySelectorAll<HTMLButtonElement>('button.artwork-candidate') ?? []),
    ];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const cols = Math.max(1, Math.round((gridRef.current?.clientWidth ?? 600) / 150));
    const next =
      e.key === 'ArrowRight'
        ? i + 1
        : e.key === 'ArrowLeft'
          ? i - 1
          : e.key === 'ArrowDown'
            ? i + cols
            : e.key === 'ArrowUp'
              ? i - cols
              : -1;
    if (next >= 0 && next < btns.length && next !== i) {
      e.preventDefault();
      btns[next]?.focus();
    }
  };

  return (
    <Dialog title={`Artwork for “${item.meta.title}”`} onClose={onClose} size="large">
      <div role="tablist" aria-label="Artwork slot" className="tabs">
        {ARTWORK_SLOTS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={slot === s}
            className={`tab${slot === s ? ' tab-active' : ''}`}
            onClick={() => (setSlot(s), setPreview(null), setSource('all'), setLang('all'))}
          >
            {ARTWORK_SLOT_LABELS[s]} ({counts[s] ?? 0})
          </button>
        ))}
      </div>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <ul className="artwork-sources" aria-label="Sources">
            {q.data.sources.map((s) => (
              <li key={s.sourceId}>
                <strong>{s.sourceName}:</strong>{' '}
                {s.state === 'ok'
                  ? `${s.count} image(s)`
                  : s.state === 'not-configured'
                    ? 'Not set up'
                    : 'Unavailable'}
                {s.message && <span className="muted"> — {s.message}</span>}
              </li>
            ))}
          </ul>
          <div className="row wrap">
            <SelectField
              label="Source"
              value={source}
              onChange={setSource}
              options={[
                { value: 'all', label: 'All sources' },
                ...sources.map((s) => ({
                  value: s,
                  label: q.data?.sources.find((x) => x.sourceId === s)?.sourceName ?? s,
                })),
              ]}
            />
            <SelectField
              label="Language"
              value={lang}
              onChange={setLang}
              options={[
                { value: 'all', label: 'Any' },
                { value: 'none', label: 'No text / unknown' },
                ...langs.map((l) => ({ value: l, label: l.toUpperCase() })),
              ]}
            />
          </div>
          <h3 id={headingId} className="visually-hidden">
            {ARTWORK_SLOT_LABELS[slot]} candidates
          </h3>
          {list.length === 0 ? (
            <p className="muted">
              No {ARTWORK_SLOT_LABELS[slot].toLowerCase()} images found. Add API keys in Settings → Providers
              for more sources.
            </p>
          ) : (
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys move focus between the candidate buttons inside; each button is itself focusable and operable
            <ul
              className={`artwork-grid artwork-grid-${slot}`}
              aria-labelledby={headingId}
              ref={gridRef}
              onKeyDown={onKey}
            >
              {list.map((c, i) => (
                <li key={c.token}>
                  <button
                    type="button"
                    className={`artwork-candidate${preview?.token === c.token ? ' artwork-candidate-selected' : ''}`}
                    aria-pressed={preview?.token === c.token}
                    aria-label={`${ARTWORK_SLOT_LABELS[slot]} ${i + 1} from ${c.sourceName}${c.width && c.height ? `, ${c.width}×${c.height}` : ''}${c.language ? `, ${c.language}` : ''}${c.adult ? ', adult content' : ''}`}
                    onClick={() => setPreview(c)}
                    onDoubleClick={() => void choose(c)}
                  >
                    <img
                      src={c.thumbUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className={c.adult && blur ? 'artwork-blurred' : undefined}
                    />
                    <span className="artwork-candidate-meta">
                      {c.sourceName}
                      {c.width && c.height ? ` · ${c.width}×${c.height}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {preview && (
            <section className="artwork-preview" aria-label="Preview">
              <img
                src={preview.previewUrl}
                alt={`Preview from ${preview.sourceName}`}
                className={preview.adult && blur ? 'artwork-blurred' : undefined}
              />
              <div className="stack">
                <p>
                  <strong>{preview.sourceName}</strong>
                  {preview.attribution && <> — {preview.attribution}</>}
                </p>
                <p className="muted small">
                  {preview.cachePolicy === 'remote-only'
                    ? 'Shown live from the source; it is not stored on this computer.'
                    : 'A copy is saved on this computer.'}
                  {preview.licenseNote ? ` ${preview.licenseNote}` : ''}
                </p>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void choose(preview)}
                >
                  Use this {ARTWORK_SLOT_LABELS[slot].toLowerCase()}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}

/* ---------------------------------------------------------------- pile time */

export function PileTimePanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().pileTime.item({ itemId: item.id })), [item.id, app.dataVersion]);
  const [edit, setEdit] = useState(false);
  const [hours, setHours] = useState<number | null>(null);
  const { busy, run } = useRun();
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const e = q.data;
  return (
    <div className="stack">
      <dl className="details-list">
        <div>
          <dt>Time left</dt>
          <dd>{fmtMinutes(e.remainingMinutes)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{fmtMinutes(e.totalMinutes)}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{e.confidence ? `${e.confidence.charAt(0).toUpperCase()}${e.confidence.slice(1)}` : '—'}</dd>
        </div>
      </dl>
      <p className="muted small">{e.explanation}</p>
      {!readOnly &&
        (edit ? (
          <form
            className="row wrap"
            onSubmit={(ev) => {
              ev.preventDefault();
              void run(
                () =>
                  call(
                    getApi().pileTime.setManual({
                      itemId: item.id,
                      minutes: hours === null ? null : Math.round(hours * 60),
                    }),
                  ),
                'Estimate saved.',
              ).then((r) => r && (q.reload(), setEdit(false)));
            }}
          >
            <NumberField label="Your estimate (hours)" value={hours} onChange={setHours} min={0} step={0.5} />
            <button type="submit" className="button button-primary button-small" disabled={busy}>
              Save
            </button>
            <button type="button" className="button button-small" onClick={() => setEdit(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="row wrap">
            <button
              type="button"
              className="button button-small"
              onClick={() => (setHours(e.manualMinutes ? e.manualMinutes / 60 : null), setEdit(true))}
            >
              {e.manualMinutes ? 'Change my estimate…' : 'Add my estimate…'}
            </button>
            {e.manualMinutes !== null && (
              <button
                type="button"
                className="button button-small"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => call(getApi().pileTime.setManual({ itemId: item.id, minutes: null })),
                    'Estimate cleared.',
                  ).then((r) => r && q.reload())
                }
              >
                Clear my estimate
              </button>
            )}
            {item.type === 'game' && (
              <button
                type="button"
                className="button button-small"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => call(getApi().pileTime.fetchIgdb({ itemId: item.id })),
                    'Typical time fetched from IGDB.',
                  ).then((r) => r && q.setData(r))
                }
              >
                Get typical time from IGDB
              </button>
            )}
          </div>
        ))}
    </div>
  );
}

/* ---------------------------------------------------------------- moods */

export function MoodsPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const all = useAsync(() => call(getApi().moods.list()), [app.dataVersion]);
  const mine = useAsync(() => call(getApi().moods.forItem({ itemId: item.id })), [item.id, app.dataVersion]);
  const { busy, run } = useRun();
  if (all.error) return <ErrorBox error={all.error} onRetry={all.reload} />;
  if (!all.data || !mine.data) return <Loading />;
  const selected = new Set(mine.data);
  const visible = all.data.filter((m: MoodView) => !m.hidden || selected.has(m.id));
  const toggle = (id: string) => {
    const next = selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id];
    void run(() => call(getApi().moods.setForItem({ itemId: item.id, moodIds: next }))).then(
      (r) => r && mine.setData(r),
    );
  };
  return (
    <fieldset className="mood-picker" disabled={readOnly || busy}>
      <legend className="visually-hidden">Moods for {item.meta.title}</legend>
      <ul className="chip-list">
        {visible.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className={`chip chip-toggle mood-${m.color ?? 'slate'}`}
              aria-pressed={selected.has(m.id)}
              onClick={() => toggle(m.id)}
            >
              <span aria-hidden="true">{selected.has(m.id) ? '✓ ' : '+ '}</span>
              {m.name}
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/* ---------------------------------------------------------------- sessions */

export function SessionsPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().sessions.forItem({ itemId: item.id })), [item.id, app.dataVersion]);
  const [now, setNow] = useState(() => Date.now());
  const [logOpen, setLogOpen] = useState(false);
  const { busy, run } = useRun();
  const open = q.data?.find((s) => s.state !== 'done') ?? null;
  // Server-computed seconds are exact at fetch time; the readout adds time elapsed since then.
  const fetchedAt = useRef(Date.now());
  useEffect(() => {
    fetchedAt.current = Date.now();
    setNow(Date.now());
  }, [q.data]);
  useEffect(() => {
    if (open?.state !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open?.state]);
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const liveSeconds = (s: SessionView) =>
    s.state === 'running' ? s.seconds + Math.max(0, Math.floor((now - fetchedAt.current) / 1000)) : s.seconds;
  const after = (r: unknown) => {
    if (r) {
      q.reload();
      app.bumpData();
    }
  };
  const done = q.data.filter((s) => s.state === 'done');
  const total = done.reduce((n, s) => n + s.seconds, 0);
  return (
    <div className="stack">
      {open ? (
        <div className="timer" role="group" aria-label="Session timer">
          <span className="timer-readout" aria-live="off">
            {formatDuration(liveSeconds(open))}
          </span>{' '}
          <span className="muted">{open.state === 'running' ? 'Running' : 'Paused'}</span>
          {open.needsReview && <span className="badge"> Long session — check the time when you stop</span>}
          {!readOnly && (
            <div className="row wrap">
              {open.state === 'running' ? (
                <button
                  type="button"
                  className="button button-small"
                  disabled={busy}
                  onClick={() => void run(() => call(getApi().sessions.pause({ id: open.id }))).then(after)}
                >
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-small"
                  disabled={busy}
                  onClick={() => void run(() => call(getApi().sessions.resume({ id: open.id }))).then(after)}
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                className="button button-primary button-small"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => call(getApi().sessions.stop({ id: open.id, adjustedSeconds: null, note: null })),
                    'Session saved.',
                  ).then(after)
                }
              >
                Stop and save
              </button>
            </div>
          )}
        </div>
      ) : (
        !readOnly && (
          <div className="row wrap">
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() =>
                void run(() => call(getApi().sessions.start({ itemId: item.id })), 'Timer started.').then(
                  after,
                )
              }
            >
              Start timer
            </button>
            <button type="button" className="button button-small" onClick={() => setLogOpen(true)}>
              Log a past session…
            </button>
          </div>
        )
      )}
      <p className="muted small">
        {done.length} session(s), {formatDuration(total)} total.
      </p>
      {done.length > 0 && (
        <ul className="plain-list">
          {done.slice(0, 8).map((s) => (
            <li key={s.id}>
              {new Date(s.startedAt).toLocaleString()} — {formatDuration(s.seconds)}
              {s.source === 'manual' ? ' (logged)' : ''}
              {s.note ? ` · ${s.note}` : ''}
              {!readOnly && (
                <button
                  type="button"
                  className="button button-small button-link"
                  aria-label={`Delete session from ${new Date(s.startedAt).toLocaleString()}`}
                  onClick={() =>
                    void run(() => call(getApi().sessions.remove({ id: s.id })), 'Session deleted.').then(
                      () => after(true),
                    )
                  }
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {logOpen && (
        <LogSessionDialog itemId={item.id} onClose={() => setLogOpen(false)} onDone={() => after(true)} />
      )}
    </div>
  );
}
function LogSessionDialog({
  itemId,
  onClose,
  onDone,
}: {
  itemId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [when, setWhen] = useState(() => new Date(Date.now() - 3600_000).toISOString().slice(0, 16));
  const [minutes, setMinutes] = useState<number | null>(60);
  const [note, setNote] = useState('');
  const { busy, run } = useRun();
  const id = useId();
  return (
    <Dialog
      title="Log a past session"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={id}
            className="button button-primary"
            disabled={busy || !minutes || minutes < 1}
          >
            Save session
          </button>
        </>
      }
    >
      <form
        id={id}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const start = new Date(when);
          void run(
            () =>
              call(
                getApi().sessions.log({
                  itemId,
                  startedAt: start.toISOString(),
                  seconds: Math.round((minutes ?? 0) * 60),
                  note: note || null,
                }),
              ),
            'Session logged.',
          ).then((r) => r && (onDone(), onClose()));
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-when`}>Started</label>
          <input
            id={`${id}-when`}
            className="input"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </div>
        <NumberField label="Length (minutes)" value={minutes} onChange={setMinutes} min={1} />
        <TextField label="Note (optional)" value={note} onChange={setNote} />
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- runs */

export function RunsPanel({ item }: { item: ItemDetail }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().itemExtras.runs({ itemId: item.id })), [item.id, app.dataVersion]);
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  if (q.data.length <= 1)
    return (
      <p className="muted">
        First {item.type === 'book' ? 'read' : item.type === 'game' ? 'playthrough' : 'watch'}. Starting it
        again from Completed begins run 2.
      </p>
    );
  return (
    <table className="table">
      <caption className="visually-hidden">Runs of {item.meta.title}</caption>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Status</th>
          <th scope="col">Started</th>
          <th scope="col">Finished</th>
          <th scope="col">Rating</th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((r: RunView) => (
          <tr key={r.runNumber}>
            <th scope="row">
              {r.runNumber}
              {r.current ? ' (current)' : ''}
            </th>
            <td>{statusLabel(r.status as never)}</td>
            <td>{fmtPartialDate(r.dateStarted)}</td>
            <td>{fmtPartialDate(r.dateCompleted)}</td>
            <td>{r.rating === null ? '—' : `${r.rating / 2}★`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------------------------------------------------------- value */

export function ValuePanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().value.list({ itemId: item.id })), [item.id, app.dataVersion]);
  const currency = app.settings?.value.currency ?? 'USD';
  const [amount, setAmount] = useState('');
  const [store, setStore] = useState('');
  const [date, setDate] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useRun();
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const add = () => {
    const minor = parseAmount(amount, currency);
    if (minor === null) return setErr(`Enter an amount like 19.99 (${currency}).`);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return setErr('Use a date like 2025-03-10.');
    setErr(null);
    void run(
      () =>
        call(
          getApi().value.add({
            itemId: item.id,
            purchase: {
              amountMinor: minor,
              currency,
              purchasedOn: date || null,
              store: store || null,
              edition: null,
              notes: null,
            },
          }),
        ),
      'Purchase added.',
    ).then((r) => r && (q.setData(r), setAmount(''), setStore(''), setDate('')));
  };
  return (
    <div className="stack">
      {q.data.length === 0 ? (
        <p className="muted">No purchases recorded.</p>
      ) : (
        <ul className="plain-list">
          {q.data.map((p: PurchaseView) => (
            <li key={p.id}>
              {formatMoney(p.amountMinor, p.currency)}
              {p.store ? ` · ${p.store}` : ''}
              {p.purchasedOn ? ` · ${fmtPartialDate(p.purchasedOn)}` : ''}
              {!readOnly && (
                <button
                  type="button"
                  className="button button-small button-link"
                  aria-label={`Delete purchase of ${formatMoney(p.amountMinor, p.currency)}`}
                  onClick={() =>
                    void run(() => call(getApi().value.remove({ id: p.id })), 'Purchase removed.').then(
                      (r) => r && q.setData(r),
                    )
                  }
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <TextField
            label={`Price (${currency})`}
            value={amount}
            onChange={setAmount}
            error={err ?? undefined}
          />
          <TextField label="Store (optional)" value={store} onChange={setStore} />
          <TextField label="Date (optional)" hint="YYYY-MM-DD" value={date} onChange={setDate} />
          <button type="submit" className="button button-small" disabled={busy}>
            Add purchase
          </button>
        </form>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- availability */

const AVAIL_LABELS: Record<AvailabilityKind, string> = {
  owned_digital: 'Owned (digital)',
  owned_physical: 'Owned (physical)',
  subscription: 'On a subscription',
  library_loan: 'Library loan',
  borrowed: 'Borrowed',
  wishlist: 'Wishlist',
};

export function AvailabilityPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const q = useAsync(
    () => call(getApi().availability.forItem({ itemId: item.id })),
    [item.id, app.dataVersion],
  );
  const services = useAsync(() => call(getApi().availability.services()), [app.dataVersion]);
  const [kind, setKind] = useState<AvailabilityKind>('owned_digital');
  const [serviceId, setServiceId] = useState('');
  const [until, setUntil] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useRun();
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  return (
    <div className="stack">
      {q.data.length === 0 ? (
        <p className="muted">Not recorded. Note where you own or can access this.</p>
      ) : (
        <ul className="plain-list">
          {q.data.map((a: AvailabilityView) => (
            <li key={a.id}>
              {AVAIL_LABELS[a.kind]}
              {a.serviceName ? ` · ${a.serviceName}` : ''}
              {a.availableUntil ? ` · until ${fmtPartialDate(a.availableUntil)}` : ''}
              {!readOnly && (
                <button
                  type="button"
                  className="button button-small button-link"
                  aria-label={`Remove ${AVAIL_LABELS[a.kind]}${a.serviceName ? ` on ${a.serviceName}` : ''}`}
                  onClick={() =>
                    void run(() => call(getApi().availability.remove({ id: a.id })), 'Removed.').then(
                      (r) => r && q.setData(r),
                    )
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return setErr('Use a date like 2025-03-31.');
            setErr(null);
            void run(
              () =>
                call(
                  getApi().availability.add({
                    itemId: item.id,
                    entry: {
                      kind,
                      serviceId: serviceId || null,
                      platform: null,
                      availableUntil: until || null,
                      remindDays: null,
                      notes: null,
                    },
                  }),
                ),
              'Saved.',
            ).then((r) => r && (q.setData(r), setUntil('')));
          }}
        >
          <SelectField
            label="Where"
            value={kind}
            onChange={setKind}
            options={AVAILABILITY_KINDS.map((k) => ({ value: k, label: AVAIL_LABELS[k] }))}
          />
          <SelectField
            label="Service"
            hint="Manage services in Settings → Library."
            value={serviceId}
            onChange={setServiceId}
            options={[
              { value: '', label: 'None' },
              ...(services.data ?? []).map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          <TextField
            label="Available until (optional)"
            hint="YYYY-MM-DD"
            value={until}
            onChange={setUntil}
            error={err ?? undefined}
          />
          <button type="submit" className="button button-small" disabled={busy}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- streaming (anime) */

export function StreamingPanel({ item }: { item: ItemDetail }) {
  const app = useApp();
  const toast = useToast();
  const q = useAsync(
    () => call(getApi().itemExtras.streaming({ itemId: item.id })),
    [item.id, app.dataVersion],
  );
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  if (q.data.length === 0)
    return <p className="muted">No streaming links from the data sources. Maybe Pile never guesses links.</p>;
  return (
    <ul className="plain-list">
      {q.data.map((l: StreamingLinkView) => (
        <li key={l.url}>
          <button
            type="button"
            className="button-link"
            onClick={() =>
              void call(getApi().app.openExternal({ url: l.url })).catch((e: unknown) =>
                toast.error(errorOf(e)),
              )
            }
          >
            {l.service}
          </button>
          {l.subs.length > 0 && <span className="muted"> · Subtitles: {l.subs.join(', ')}</span>}
          {l.dubs.length > 0 && <span className="muted"> · Dub: {l.dubs.join(', ')}</span>}
          {l.matchesPref && <span className="badge"> Matches your audio preference</span>}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- relations, suggestions, series */

const RELATION_OPTIONS: { value: RelationInput; label: string }[] = (
  ['prequel', 'sequel', 'spin_off', 'side_story', 'adaptation_of', 'remake_of', 'same_franchise'] as const
).map((r) => ({ value: r, label: RELATION_LABELS[r] }));

export function RelationsPanel({ item, readOnly }: { item: ItemDetail; readOnly: boolean }) {
  const app = useApp();
  const rel = useAsync(
    () => call(getApi().itemExtras.relations({ itemId: item.id })),
    [item.id, app.dataVersion],
  );
  const sug = useAsync(
    () => call(getApi().itemExtras.suggestions({ itemId: item.id })),
    [item.id, app.dataVersion],
  );
  const fr = useAsync(
    () => call(getApi().itemExtras.franchisesForItem({ itemId: item.id })),
    [item.id, app.dataVersion],
  );
  const [linkOpen, setLinkOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const { busy, run } = useRun();
  if (rel.error) return <ErrorBox error={rel.error} onRetry={rel.reload} />;
  if (!rel.data || !sug.data || !fr.data) return <Loading />;
  const reloadAll = () => (rel.reload(), sug.reload(), fr.reload(), app.bumpData());
  return (
    <div className="stack">
      {fr.data.map((f: FranchiseView) => (
        <div key={f.id}>
          <p>
            <strong>{f.name}</strong>{' '}
            <span className="muted">
              ({f.entries.length} entries{f.respectOrder ? ', in order' : ''})
            </span>
          </p>
          {f.nextItemId && f.nextItemId !== item.id && (
            <p>
              Next in series:{' '}
              <a href={`#/item/${f.nextItemId}`}>{f.entries.find((e) => e.itemId === f.nextItemId)?.title}</a>
            </p>
          )}
          {f.nextItemId === item.id && <p className="badge">This is next in the series</p>}
          <ol className="plain-list">
            {f.entries.map((e) => (
              <li key={e.itemId}>
                {e.itemId === item.id ? (
                  <strong>{e.title}</strong>
                ) : (
                  <a href={`#/item/${e.itemId}`}>{e.title}</a>
                )}{' '}
                <span className="muted">
                  · {statusLabel(e.status as never)}
                  {e.mainline ? '' : ' · side story'}
                </span>
              </li>
            ))}
          </ol>
          {!readOnly && <SeriesEditor franchise={f} onSaved={reloadAll} />}
        </div>
      ))}
      {rel.data.length > 0 && (
        <ul className="plain-list" aria-label="Linked items">
          {rel.data.map((r: RelationView) => (
            <li key={r.id}>
              {RELATION_LABELS[r.relation]}: <a href={`#/item/${r.otherItemId}`}>{r.otherTitle}</a>{' '}
              <span className="muted">
                ({typeLabel(r.otherType as never)}, {statusLabel(r.otherStatus as never)})
              </span>
              {!readOnly && (
                <button
                  type="button"
                  className="button button-small button-link"
                  aria-label={`Unlink ${r.otherTitle}`}
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      call(getApi().itemExtras.removeRelation({ itemId: item.id, relationId: r.id })),
                    ).then((x) => x && reloadAll())
                  }
                >
                  Unlink
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sug.data.length > 0 && (
        <details>
          <summary>{sug.data.length} related title(s) suggested by the data source</summary>
          <ul className="plain-list">
            {sug.data.map((s: SuggestionView) => (
              <li key={s.id}>
                {RELATION_LABELS[s.relation]}: {s.title}
                {s.year ? ` (${s.year})` : ''}{' '}
                <span className="muted">
                  {s.targetItemId ? '· in your library' : '· not in your library'}
                </span>
                {!readOnly && (
                  <span className="row-inline">
                    {s.targetItemId && (
                      <button
                        type="button"
                        className="button button-small"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              call(
                                getApi().itemExtras.resolveSuggestion({
                                  itemId: item.id,
                                  suggestionId: s.id,
                                  accept: true,
                                }),
                              ),
                            'Linked.',
                          ).then((x) => x && reloadAll())
                        }
                      >
                        Link
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          call(
                            getApi().itemExtras.resolveSuggestion({
                              itemId: item.id,
                              suggestionId: s.id,
                              accept: false,
                            }),
                          ),
                        ).then((x) => x && reloadAll())
                      }
                    >
                      Dismiss
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!readOnly && (
        <div className="row wrap">
          <button type="button" className="button button-small" onClick={() => setLinkOpen(true)}>
            Link another item…
          </button>
          {fr.data.length === 0 && (
            <button type="button" className="button button-small" onClick={() => setSeriesOpen(true)}>
              Start a series…
            </button>
          )}
        </div>
      )}
      {linkOpen && (
        <ItemPickerDialog
          title="Link another item"
          excludeId={item.id}
          extra={(sel, setRelation) => (
            <SelectField
              label="Relationship (the other item is…)"
              value={sel}
              onChange={setRelation}
              options={RELATION_OPTIONS}
            />
          )}
          onClose={() => setLinkOpen(false)}
          onPick={(other, relation) =>
            void run(
              () => call(getApi().itemExtras.addRelation({ itemId: item.id, otherId: other.id, relation })),
              'Linked.',
            ).then((x) => x && (setLinkOpen(false), reloadAll()))
          }
        />
      )}
      {seriesOpen && (
        <NewSeriesDialog
          item={item}
          onClose={() => setSeriesOpen(false)}
          onCreated={() => (setSeriesOpen(false), reloadAll())}
        />
      )}
    </div>
  );
}

function SeriesEditor({ franchise, onSaved }: { franchise: FranchiseView; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(
    franchise.entries.map((e) => ({ itemId: e.itemId, title: e.title, mainline: e.mainline })),
  );
  const [adding, setAdding] = useState(false);
  const { busy, run } = useRun();
  if (!open)
    return (
      <button type="button" className="button button-small" onClick={() => setOpen(true)}>
        Edit series order…
      </button>
    );
  const move = (i: number, d: -1 | 1) =>
    setEntries((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const c = [...xs];
      const a = c[i];
      const b = c[j];
      if (a === undefined || b === undefined) return xs;
      c[i] = b;
      c[j] = a;
      return c;
    });
  return (
    <Dialog
      title={`Edit “${franchise.name}”`}
      onClose={() => setOpen(false)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  call(
                    getApi().franchises.setEntries({
                      id: franchise.id,
                      entries: entries.map((e) => ({ itemId: e.itemId, mainline: e.mainline })),
                    }),
                  ),
                'Series saved.',
              ).then((r) => r && (setOpen(false), onSaved()))
            }
          >
            Save
          </button>
        </>
      }
    >
      <Checkbox
        label="Watch/play/read in this order"
        hint="When on, Next in series is the first unfinished main entry after your last completed one."
        checked={franchise.respectOrder}
        onChange={(v) =>
          void run(() => call(getApi().franchises.update({ id: franchise.id, respectOrder: v }))).then(
            (r) => r && onSaved(),
          )
        }
      />
      <ol className="plain-list">
        {entries.map((e, i) => (
          <li key={e.itemId} className="row wrap">
            <span>{e.title}</span>
            <Checkbox
              label="Main entry"
              checked={e.mainline}
              onChange={(v) =>
                setEntries((xs) => xs.map((x) => (x.itemId === e.itemId ? { ...x, mainline: v } : x)))
              }
            />
            <button
              type="button"
              className="button button-small"
              aria-label={`Move ${e.title} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="button button-small"
              aria-label={`Move ${e.title} down`}
              disabled={i === entries.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="button button-small"
              aria-label={`Remove ${e.title} from series`}
              onClick={() => setEntries((xs) => xs.filter((x) => x.itemId !== e.itemId))}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="button button-small" onClick={() => setAdding(true)}>
        Add an item…
      </button>
      {adding && (
        <ItemPickerDialog
          title="Add to series"
          excludeId={null}
          onClose={() => setAdding(false)}
          onPick={(it) => (
            setEntries((xs) =>
              xs.some((x) => x.itemId === it.id)
                ? xs
                : [...xs, { itemId: it.id, title: it.title, mainline: true }],
            ),
            setAdding(false)
          )}
        />
      )}
    </Dialog>
  );
}

function NewSeriesDialog({
  item,
  onClose,
  onCreated,
}: {
  item: ItemDetail;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState(item.meta.title.replace(/[:\-–].*$/, '').trim() || item.meta.title);
  const { busy, run } = useRun();
  const id = useId();
  return (
    <Dialog
      title="Start a series"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={id} className="button button-primary" disabled={busy || !name.trim()}>
            Create series
          </button>
        </>
      }
    >
      <form
        id={id}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => call(getApi().franchises.create({ name, itemIds: [item.id] })),
            'Series created.',
          ).then((r) => r && onCreated());
        }}
      >
        <TextField label="Series name" value={name} onChange={setName} />
      </form>
    </Dialog>
  );
}

/** Searches the user's own library (never the network). */
export function ItemPickerDialog({
  title,
  excludeId,
  onClose,
  onPick,
  extra,
}: {
  title: string;
  excludeId: string | null;
  onClose: () => void;
  onPick: (item: ItemSummary, relation: RelationInput) => void;
  extra?: (relation: RelationInput, setRelation: (r: RelationInput) => void) => React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [relation, setRelation] = useState<RelationInput>('sequel');
  const q = useAsync(
    () =>
      text.trim().length < 2
        ? Promise.resolve({ total: 0, items: [] as ItemSummary[] })
        : call(getApi().items.query({ ...DEFAULT_LIBRARY_QUERY, text, limit: 20 })),
    [text],
  );
  return (
    <Dialog title={title} onClose={onClose}>
      <TextField label="Search your library" value={text} onChange={setText} />
      {extra?.(relation, setRelation)}
      {q.data && q.data.items.length > 0 && (
        <ul className="plain-list" aria-label="Matching items">
          {q.data.items
            .filter((i) => i.id !== excludeId)
            .map((i) => (
              <li key={i.id}>
                <button type="button" className="button button-small" onClick={() => onPick(i, relation)}>
                  {i.title}
                  {i.year ? ` (${i.year})` : ''} · {typeLabel(i.type)}
                </button>
              </li>
            ))}
        </ul>
      )}
      {text.trim().length >= 2 && q.data?.items.length === 0 && <p className="muted">No matches.</p>}
    </Dialog>
  );
}

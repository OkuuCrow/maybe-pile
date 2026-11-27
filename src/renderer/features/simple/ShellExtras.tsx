/**
 * App-shell additions (2.1): first run, quick rating prompt, appearance
 * attributes, theme schedule, restore my place, Simple Mode offer banner.
 */
import { useEffect, useRef, useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Bits';
import { COMPLETED_EVENT } from './QuickActions';

/* ------------------------------------------------------------------ appearance */

/** Applies text size / spacing / font / density / reduce-effects as data attributes on <html> (CSS does the rest). */
export function useAppearanceAttributes(): void {
  const app = useApp();
  const ui = app.settings?.interface;
  useEffect(() => {
    if (!ui) return;
    const d = document.documentElement.dataset;
    d['textSize'] = ui.textSize;
    d['density'] = ui.density;
    d['font'] = ui.font;
    d['lineSpacing'] = ui.lineSpacing;
    d['letterSpacing'] = ui.letterSpacing;
    d['reduceEffects'] = ui.reduceEffects ? 'true' : 'false';
    d['level'] = ui.level;
  }, [ui]);
}

/* ------------------------------------------------------------------ theme schedule */

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Local-time theme switching (no location, no network). A manual change lasts until the next boundary. */
export function useThemeSchedule(): void {
  const app = useApp();
  const ts = app.settings?.themeSchedule;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!ts?.enabled) return;
    const tick = () => {
      const now = new Date();
      const cur = now.getHours() * 60 + now.getMinutes();
      const l = minutes(ts.lightAt);
      const dk = minutes(ts.darkAt);
      const isDay = l < dk ? cur >= l && cur < dk : cur >= l || cur < dk;
      const boundary = `${now.toDateString()}:${isDay ? 'day' : 'night'}`;
      if (last.current === boundary) return;
      last.current = boundary;
      const want = isDay ? ts.lightThemeId : ts.darkThemeId;
      if (app.settings?.activeThemeId !== want)
        void app
          .updateSettings({ activeThemeId: want })
          .then(() => app.reloadTheme())
          .catch(() => undefined);
    };
    tick();
    const h = setInterval(tick, 60_000);
    return () => clearInterval(h);
  }, [ts, app]);
}

/* ------------------------------------------------------------------ restore my place */

/** Saves the current route (debounced) and restores it once at start-up when enabled. */
export function useRestorePlace(): void {
  const app = useApp();
  const restored = useRef(false);
  const enabled = app.settings?.interface.restorePlace;
  useEffect(() => {
    if (!app.settings || restored.current) return;
    restored.current = true;
    const place = app.settings.place;
    const startHash = window.location.hash;
    if (
      enabled &&
      place.hash &&
      (startHash === '' || startHash === '#/' || startHash === '#/dashboard') &&
      /^#\/[A-Za-z0-9/_-]*$/.test(place.hash)
    ) {
      window.location.hash = place.hash;
      const y = place.scrollY;
      setTimeout(() => document.getElementById('main')?.scrollTo?.({ top: y }), 400);
    }
  }, [app.settings, enabled]);
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  useEffect(() => {
    if (!enabled || !restored.current) return;
    const t = setTimeout(() => {
      const h = window.location.hash;
      if (!/^#\/[A-Za-z0-9/_-]*$/.test(h) || h.length > 200) return;
      const y = Math.max(
        0,
        Math.min(10_000_000, Math.round(document.getElementById('main')?.scrollTop ?? 0)),
      );
      void app.updateSettings({ place: { hash: h, scrollY: y } }).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.route, enabled, hash]);
}

/* ------------------------------------------------------------------ first run */

export function FirstRun() {
  const app = useApp();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const ui = app.settings?.interface;
  const [hidden, setHidden] = useState<MediaType[]>(ui?.hiddenTypes ?? []);
  const [theme, setTheme] = useState(app.settings?.activeThemeId ?? 'system');
  if (!ui || ui.firstRunDone) return null;
  const finish = async () => {
    try {
      await app.updateSettings({
        interface: { ...ui, hiddenTypes: hidden, firstRunDone: true },
        activeThemeId: theme,
      });
      app.reloadTheme();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const skip = () => void finish();
  const previewTheme = (id: string) => {
    setTheme(id);
    void app.updateSettings({ activeThemeId: id }).then(() => app.reloadTheme());
  };
  const titles = ['What do you want to track?', 'Choose a look', 'All set'];
  return (
    <Dialog
      title={`Welcome to Maybe Pile — ${titles[step]}`}
      onClose={skip}
      size="medium"
      footer={
        <>
          <button type="button" className="button" onClick={skip}>
            Skip
          </button>
          {step > 0 && (
            <button type="button" className="button" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {step < 2 ? (
            <button type="button" className="button button-primary" onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          ) : (
            <button type="button" className="button button-primary" onClick={() => void finish()}>
              Start
            </button>
          )}
        </>
      }
    >
      <p className="muted">Step {step + 1} of 3</p>
      {step === 0 && (
        <fieldset className="field">
          <legend>Track these (you can change it later in Settings → Interface)</legend>
          <div className="day-row">
            {MEDIA_TYPES.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(t)}
                  onChange={(e) =>
                    setHidden((h) =>
                      e.target.checked
                        ? h.filter((x) => x !== t)
                        : h.length < MEDIA_TYPES.length - 1
                          ? [...h, t]
                          : h,
                    )
                  }
                />{' '}
                {typeLabelPlural(t)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {step === 1 && (
        <fieldset className="mode-picker">
          <legend>Look</legend>
          {(
            [
              ['system', 'Match my computer'],
              ['pile-light', 'Light'],
              ['pile-dark', 'Dark'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className={`mode-option ${theme === id ? 'mode-selected' : ''}`}>
              <input type="radio" name="fr-theme" checked={theme === id} onChange={() => previewTheme(id)} />{' '}
              <strong>{label}</strong>
            </label>
          ))}
        </fieldset>
      )}
      {step === 2 && (
        <>
          <p>Your library stays on this computer. No account, nothing uploaded.</p>
          <p className="muted">
            Backups: Settings → Backup &amp; restore. Reminders can be set up later in Settings → Reminders.
          </p>
        </>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Simple Mode offer for upgraders */

export function SimpleOfferBanner() {
  const app = useApp();
  const ui = app.settings?.interface;
  if (!ui || ui.level !== 'full' || ui.simpleOfferDismissed || !ui.firstRunDone) return null;
  const set = (p: Partial<typeof ui>) => void app.updateSettings({ interface: { ...ui, ...p } });
  return (
    <Notice kind="info" onDismiss={() => set({ simpleOfferDismissed: true })}>
      New: a calmer <strong>Simple view</strong> with just Home, Library and Settings. Nothing is removed and
      you can switch back any time.{' '}
      <button
        type="button"
        className="button button-small"
        onClick={() => set({ level: 'simple', simpleOfferDismissed: true })}
      >
        Try Simple view
      </button>{' '}
      <button
        type="button"
        className="button button-small"
        onClick={() => set({ simpleOfferDismissed: true })}
      >
        No thanks
      </button>
    </Notice>
  );
}

/* ------------------------------------------------------------------ quick rating prompt (§14.3) */

interface Prompt {
  itemId: string;
  title: string;
}

/** Non-blocking “How was it?” card. Skipping or timing out saves nothing. */
export function RatingPromptHost() {
  const app = useApp();
  const toast = useToast();
  const [p, setP] = useState<Prompt | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [moods, setMoods] = useState<string[]>([]);
  const moodList = useAsync(() => (p ? call(getApi().moods.list()) : Promise.resolve([])), [p?.itemId]);
  const cfg = app.settings?.ratingPrompt;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ itemId: string; title: string; rating: number | null }>).detail;
      if (!cfg?.enabled || !d) return;
      if (cfg.onlyUnrated && d.rating !== null) return;
      setRating(null);
      setNote('');
      setMoods([]);
      setP({ itemId: d.itemId, title: d.title });
    };
    window.addEventListener(COMPLETED_EVENT, on);
    return () => window.removeEventListener(COMPLETED_EVENT, on);
  }, [cfg]);
  useEffect(() => {
    if (!p) return;
    const t = setTimeout(() => setP(null), 60_000);
    return () => clearTimeout(t);
  }, [p]);
  if (!p) return null;
  const save = async () => {
    try {
      await call(
        getApi().extras.ratingPrompt({ itemId: p.itemId, rating, note: note.trim() || null, moodIds: moods }),
      );
      toast.success('Thanks — saved.');
      app.bumpData();
    } catch (e) {
      toast.error(errorOf(e));
    }
    setP(null);
  };
  return (
    <aside className="rating-prompt" aria-labelledby="rp-title" role="region">
      <p id="rp-title" className="rating-prompt-title">
        How was <strong>{p.title}</strong>?
      </p>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[2, 4, 6, 8, 10].map((v) => (
          <label key={v} className={`star ${rating !== null && rating >= v ? 'star-on' : ''}`}>
            <input
              type="radio"
              name="rp-rating"
              checked={rating === v}
              onChange={() => setRating(v)}
              aria-label={`${v / 2} of 5 stars`}
            />
            <span aria-hidden="true">★</span>
          </label>
        ))}
      </div>
      <label htmlFor="rp-note" className="visually-hidden">
        One-line note (optional)
      </label>
      <input
        id="rp-note"
        className="input"
        maxLength={200}
        placeholder="One line (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {(moodList.data ?? []).length > 0 && (
        <div className="chip-row" aria-label="Moods (optional)">
          {(moodList.data ?? []).slice(0, 6).map((m: { id: string; name: string }) => (
            <button
              key={m.id}
              type="button"
              className="chip"
              aria-pressed={moods.includes(m.id)}
              onClick={() => setMoods((x) => (x.includes(m.id) ? x.filter((y) => y !== m.id) : [...x, m.id]))}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
      <div className="button-row">
        <button
          type="button"
          className="button button-small button-primary"
          onClick={() => void save()}
          disabled={rating === null && !note.trim() && moods.length === 0}
        >
          Save
        </button>
        <button type="button" className="button button-small" onClick={() => setP(null)}>
          Skip
        </button>
      </div>
    </aside>
  );
}

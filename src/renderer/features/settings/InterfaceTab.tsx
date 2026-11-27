/** Settings → Interface: Simple / Full, tracked media types, restore my place, first run, about. */
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { InterfaceSettings } from '../../../shared/schemas';
import { useApp } from '../../app/context';
import { typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Loading } from '../../components/Bits';
import { errorOf } from '../../app/api';
import { Toggle } from '../notifications/shared';

export function InterfaceTab() {
  const app = useApp();
  const toast = useToast();
  const s = app.settings;
  if (!s) return <Loading />;
  const ui = s.interface;
  const set = async (patch: Partial<InterfaceSettings>, msg?: string) => {
    try {
      await app.updateSettings({ interface: { ...ui, ...patch } });
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const hidden = new Set(ui.hiddenTypes);
  return (
    <div className="interface-tab">
      <section className="subsection" aria-labelledby="if-level">
        <h3 id="if-level">How much to show</h3>
        <fieldset className="mode-picker">
          <legend className="visually-hidden">Interface level</legend>
          <label className={`mode-option ${ui.level === 'simple' ? 'mode-selected' : ''}`}>
            <input
              type="radio"
              name="if-level"
              checked={ui.level === 'simple'}
              onChange={() => void set({ level: 'simple' }, 'Simple view is on.')}
            />
            <strong>Simple</strong>
            <span className="mode-help">
              Home, Library and Settings only. Calm, with the essentials. Nothing is deleted; everything else
              keeps working.
            </span>
          </label>
          <label className={`mode-option ${ui.level === 'full' ? 'mode-selected' : ''}`}>
            <input
              type="radio"
              name="if-level"
              checked={ui.level === 'full'}
              onChange={() => void set({ level: 'full' }, 'All features are shown.')}
            />
            <strong>Full</strong>
            <span className="mode-help">
              Every feature: lists, stats, goals, triage, templates, views, custom layouts and more.
            </span>
          </label>
        </fieldset>
      </section>
      <section className="subsection" aria-labelledby="if-types">
        <h3 id="if-types">What you track</h3>
        <p className="muted">
          Hidden types disappear from tabs, Add and filters. Hiding never deletes anything; types that already
          contain items stay visible.
        </p>
        <div className="day-row">
          {MEDIA_TYPES.map((t: MediaType) => (
            <label key={t}>
              <input
                type="checkbox"
                checked={!hidden.has(t)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? ui.hiddenTypes.filter((x) => x !== t)
                    : [...ui.hiddenTypes, t];
                  if (next.length >= MEDIA_TYPES.length) return toast.error('Keep at least one type.');
                  void set({ hiddenTypes: next });
                }}
              />{' '}
              {typeLabelPlural(t)}
            </label>
          ))}
        </div>
      </section>
      <section className="subsection" aria-labelledby="if-place">
        <h3 id="if-place">Starting up</h3>
        <Toggle
          label="Restore my place (last screen, filters and scroll position)"
          hint="Off: always start on Home. Window size and position are always remembered."
          checked={ui.restorePlace}
          onChange={(v) => void set({ restorePlace: v })}
        />
        <button type="button" className="button" onClick={() => void set({ firstRunDone: false })}>
          Show the welcome steps again
        </button>
      </section>
      <section className="subsection" aria-labelledby="if-prompts">
        <h3 id="if-prompts">Questions you turned off</h3>
        {ui.dontAsk.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() => void set({ dontAsk: [] }, 'Maybe Pile will ask again.')}
          >
            Ask me again ({ui.dontAsk.length})
          </button>
        )}
      </section>
      {ui.level === 'simple' && app.info && (
        <section className="subsection" aria-labelledby="if-about">
          <h3 id="if-about">About</h3>
          <p>
            Maybe Pile {app.info.version} — {app.info.tagline}
          </p>
          <p className="muted">Your data stays on this computer: {app.info.dataLocationLabel}</p>
        </section>
      )}
    </div>
  );
}

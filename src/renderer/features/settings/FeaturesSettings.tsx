/**
 * Settings → Features: Up Next size, Pick for Me defaults, Pile Health
 * thresholds, Release Radar & notifications, Quick Capture shortcut, Stats and
 * import-undo retention. Each control saves on change; validation errors are
 * shown next to the control that caused them.
 */
import { useState } from 'react';
import type { SettingsPatch } from '../../../shared/schemas';
import { errorOf } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { Loading } from '../../components/Bits';
import { Checkbox, NumberField, SelectField, TextField } from '../../components/Fields';

export function FeaturesSettings() {
  const app = useApp();
  const toast = useToast();
  const s = app.settings;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [accel, setAccel] = useState(s?.quickCapture.accelerator ?? 'CommandOrControl+Shift+Space');
  if (!s) return <Loading />;
  const save = async (patch: SettingsPatch, key: string) => {
    try {
      await app.updateSettings(patch);
      setErrors((e) => ({ ...e, [key]: '' }));
      toast.show({ kind: 'info', message: 'Saved.' }, 1500);
    } catch (e) {
      const err = errorOf(e);
      setErrors((x) => ({ ...x, [key]: Object.values(err.fieldErrors ?? {})[0] ?? err.message }));
    }
  };
  const num = (v: number | null, min: number, max: number) =>
    v === null ? null : Math.min(max, Math.max(min, Math.round(v)));
  return (
    <div className="features-settings">
      <section className="subsection" aria-labelledby="fs-upnext">
        <h3 id="fs-upnext">Up Next</h3>
        <NumberField
          label="Maximum items in Up Next (3–25)"
          value={s.upNextMax}
          error={errors['upNextMax'] || undefined}
          onChange={(v) => {
            const n = num(v, 3, 25);
            if (n !== null) void save({ upNextMax: n }, 'upNextMax');
          }}
        />
        <p className="field-hint">Completing or dropping an item takes it off Up Next automatically.</p>
      </section>

      <section className="subsection" aria-labelledby="fs-pick">
        <h3 id="fs-pick">Pick for Me</h3>
        <SelectField<'neutral' | 'older' | 'newer'>
          label="Favor"
          value={s.pick.favor}
          onChange={(v) => void save({ pick: { ...s.pick, favor: v } }, 'pick')}
          options={[
            { value: 'neutral', label: 'Neutral (every item equally likely)' },
            { value: 'older', label: 'Older items (added longest ago)' },
            { value: 'newer', label: 'Newer items' },
          ]}
          hint="Preferences only tilt the odds; every eligible item can still be picked."
        />
        <Checkbox
          label="Favor items I'm already partway through"
          checked={s.pick.favorInProgress}
          onChange={(v) => void save({ pick: { ...s.pick, favorInProgress: v } }, 'pick')}
        />
        <Checkbox
          label="Include In Progress items by default"
          checked={s.pick.includeInProgress}
          onChange={(v) => void save({ pick: { ...s.pick, includeInProgress: v } }, 'pick')}
        />
        <Checkbox
          label="Include On Hold items by default"
          checked={s.pick.includeOnHold}
          onChange={(v) => void save({ pick: { ...s.pick, includeOnHold: v } }, 'pick')}
        />
        <NumberField
          label="“Not now” hides a pick for (days)"
          value={s.pick.skipDays}
          error={errors['pick'] || undefined}
          onChange={(v) => {
            const n = num(v, 1, 365);
            if (n !== null) void save({ pick: { ...s.pick, skipDays: n } }, 'pick');
          }}
        />
      </section>

      <section className="subsection" aria-labelledby="fs-health">
        <h3 id="fs-health">Pile Health</h3>
        <Checkbox
          label="Show Pile Health nudges"
          checked={s.pileHealth.enabled}
          onChange={(v) => void save({ pileHealth: { ...s.pileHealth, enabled: v } }, 'pileHealth')}
          hint="When off, the panel and all nudges are hidden. Pile Health never sends system notifications."
        />
        <NumberField
          label="Planned items are stale after (months)"
          value={s.pileHealth.plannedStaleMonths}
          error={errors['pileHealth'] || undefined}
          onChange={(v) => {
            const n = num(v, 1, 120);
            if (n !== null)
              void save({ pileHealth: { ...s.pileHealth, plannedStaleMonths: n } }, 'pileHealth');
          }}
        />
        <NumberField
          label="In Progress items are stale after no progress for (days)"
          value={s.pileHealth.inProgressStaleDays}
          onChange={(v) => {
            const n = num(v, 7, 3650);
            if (n !== null)
              void save({ pileHealth: { ...s.pileHealth, inProgressStaleDays: n } }, 'pileHealth');
          }}
        />
      </section>

      <section className="subsection" aria-labelledby="fs-radar">
        <h3 id="fs-radar">Release Radar</h3>
        <Checkbox
          label="Include On Hold items"
          checked={s.releaseRadar.includeOnHold}
          onChange={(v) =>
            void save({ releaseRadar: { ...s.releaseRadar, includeOnHold: v } }, 'releaseRadar')
          }
        />
        <Checkbox
          label="Notify me the day before and on release day"
          checked={s.releaseRadar.notifications}
          onChange={(v) =>
            void save({ releaseRadar: { ...s.releaseRadar, notifications: v } }, 'releaseRadar')
          }
          hint="Off by default. Notifications only appear while Maybe Pile is open (it checks at start-up and every hour); there is no background service. They never include your notes."
        />
        <Checkbox
          label="Check for release-date changes when Maybe Pile starts"
          checked={s.releaseRadar.refreshOnStart}
          onChange={(v) =>
            void save({ releaseRadar: { ...s.releaseRadar, refreshOnStart: v } }, 'releaseRadar')
          }
          hint="Uses your metadata providers (rate-limited). Changes are only shown, never applied, until you review them."
        />
      </section>

      <section className="subsection" aria-labelledby="fs-capture">
        <h3 id="fs-capture">Quick Capture</h3>
        <p>
          Inside Maybe Pile, <kbd>Ctrl/⌘ + Shift + N</kbd> always opens Quick Capture. You can also register a
          system-wide shortcut (off by default).
        </p>
        <Checkbox
          label="Register a global shortcut"
          checked={s.quickCapture.globalShortcut}
          onChange={(v) =>
            void save({ quickCapture: { ...s.quickCapture, globalShortcut: v } }, 'quickCapture')
          }
          hint="If another app already uses the shortcut, registration is skipped and the in-app shortcut keeps working."
        />
        <div className="row wrap">
          <TextField
            label="Global shortcut"
            value={accel}
            onChange={setAccel}
            error={errors['quickCapture'] || undefined}
            hint="For example CommandOrControl+Shift+Space."
          />
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              void save({ quickCapture: { ...s.quickCapture, accelerator: accel.trim() } }, 'quickCapture')
            }
          >
            Save shortcut
          </button>
        </div>
      </section>

      <section className="subsection" aria-labelledby="fs-stats">
        <h3 id="fs-stats">Stats &amp; imports</h3>
        <Checkbox
          label="Show activity streaks on the Stats page"
          checked={s.stats.showStreaks}
          onChange={(v) => void save({ stats: { showStreaks: v } }, 'stats')}
        />
        <NumberField
          label="Keep import undo history for (days)"
          value={s.importUndoRetentionDays}
          error={errors['importUndoRetentionDays'] || undefined}
          onChange={(v) => {
            const n = num(v, 1, 365);
            if (n !== null) void save({ importUndoRetentionDays: n }, 'importUndoRetentionDays');
          }}
          hint="After this, the record of an import is removed (the items stay) and it can no longer be undone."
        />
        <p className="muted">Goals never send notifications.</p>
      </section>
    </div>
  );
}

/**
 * Appearance additions (core): text size, spacing, readable font, density,
 * reduce effects, and backdrops (§15.6). Saves on change; previews live.
 */
import type { BackdropSettings, InterfaceSettings } from '../../../shared/schemas';
import { errorOf } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { NumberField, SelectField } from '../../components/Fields';
import { Toggle } from '../notifications/shared';

export function AppearanceExtras() {
  const app = useApp();
  const toast = useToast();
  const s = app.settings;
  if (!s) return null;
  const ui = s.interface;
  const b = s.backdrops;
  const setUi = (p: Partial<InterfaceSettings>) =>
    void app.updateSettings({ interface: { ...ui, ...p } }).catch((e: unknown) => toast.error(errorOf(e)));
  const setB = (p: Partial<BackdropSettings>) =>
    void app.updateSettings({ backdrops: { ...b, ...p } }).catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <>
      <section className="subsection" aria-labelledby="ap-text">
        <h3 id="ap-text">Text</h3>
        <div className="field-row">
          <SelectField
            label="Text size"
            value={ui.textSize}
            onChange={(v) => setUi({ textSize: v })}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' },
              { value: 'larger', label: 'Larger' },
            ]}
          />
          <SelectField
            label="Font"
            hint="Dyslexia-friendly uses OpenDyslexic when it is installed, otherwise a clear rounded font."
            value={ui.font}
            onChange={(v) => setUi({ font: v })}
            options={[
              { value: 'default', label: 'Default' },
              { value: 'dyslexic', label: 'Dyslexia-friendly' },
            ]}
          />
        </div>
        <div className="field-row">
          <SelectField
            label="Line spacing"
            value={ui.lineSpacing}
            onChange={(v) => setUi({ lineSpacing: v })}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'relaxed', label: 'Relaxed' },
              { value: 'loose', label: 'Loose' },
            ]}
          />
          <SelectField
            label="Letter spacing"
            value={ui.letterSpacing}
            onChange={(v) => setUi({ letterSpacing: v })}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'wide', label: 'Wide' },
              { value: 'wider', label: 'Wider' },
            ]}
          />
        </div>
        <SelectField
          label="Spacing between things"
          value={ui.density}
          onChange={(v) => setUi({ density: v })}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'spacious', label: 'More space (larger click targets)' },
          ]}
        />
        <p className="appearance-sample" aria-label="Preview">
          The quick brown fox — preview of your text settings.
        </p>
      </section>
      <section className="subsection" aria-labelledby="ap-bd">
        <h3 id="ap-bd">Backdrops</h3>
        <p className="muted">
          A soft background on item pages. Text always stays readable: a shade is added automatically.
        </p>
        <Toggle
          label="Reduce effects / high contrast (turns backdrops and blur off)"
          checked={ui.reduceEffects}
          onChange={(v) => setUi({ reduceEffects: v })}
        />
        {!ui.reduceEffects && (
          <>
            <SelectField
              label="Backdrop style"
              value={b.style}
              onChange={(v) => setB({ style: v })}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'ambient', label: 'Ambient — colors from the cover (works offline)' },
                { value: 'banner', label: 'Banner image behind the title' },
                { value: 'blurred', label: 'Full-page blurred image' },
              ]}
            />
            {b.style !== 'off' && (
              <div className="field-row">
                <NumberField
                  label="Intensity (0–100)"
                  value={b.intensity}
                  min={0}
                  max={100}
                  onChange={(v) => v !== null && v >= 0 && v <= 100 && setB({ intensity: v })}
                />
                {app.level === 'full' && (
                  <NumberField
                    label="Blur (0–40 px)"
                    value={b.blur}
                    min={0}
                    max={40}
                    onChange={(v) => v !== null && v >= 0 && v <= 40 && setB({ blur: v })}
                  />
                )}
              </div>
            )}
            {app.level === 'full' && b.style !== 'off' && (
              <Toggle
                label="Only on item pages"
                checked={b.onlyDetail}
                onChange={(v) => setB({ onlyDetail: v })}
              />
            )}
          </>
        )}
      </section>
    </>
  );
}

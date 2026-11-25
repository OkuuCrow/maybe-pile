import { useEffect, useId, useState } from 'react';
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '../../../shared/enums';
import type {
  ImportPreviewView,
  LayoutComponentView,
  LayoutsView,
  ProviderInfo,
} from '../../../shared/types';
import type { ThemeDetailView } from '../../../shared/ipc-contract';
import { COMPONENT_LABELS, type LayoutSurface } from '../../../domain/layouts';
import {
  ALL_COLOR_TOKENS,
  colorOf,
  type AnyColorToken,
  DENSITY_OPTIONS,
  FONT_FAMILY_OPTIONS,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  RADIUS_OPTIONS,
  contrastWarnings,
  type ThemeTokens,
} from '../../../domain/themes';
import { HEX_COLOR_RE } from '../../../domain/contrast';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { SETTINGS_TABS, applyTheme, useApp, type SettingsTab } from '../../app/context';
import { S, fmtBytes, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog } from '../../components/Dialog';
import { ErrorBox, Loading, Notice } from '../../components/Bits';
import { Checkbox, ListInput, NumberField, SelectField, TextField } from '../../components/Fields';
import { IconArrowDown, IconArrowUp, IconCheck, IconAlert } from '../../components/Icons';
import { ExternalLink } from '../item/LinksPanel';
import { ImportPreviewDialog } from './ImportPreviewDialog';
import { FeaturesSettings } from './FeaturesSettings';
import { Pack2Settings } from './Pack2Settings';
import { SyncSettings } from './SyncSettings';
import { SteamSetupForm } from '../import/SteamSetup';
import { REGIONS } from './regions';

const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  layout: 'Layout',
  providers: 'Providers',
  library: 'Custom fields & series',
  features: 'Features',
  backup: 'Backup & Restore',
  data: 'Data & Behavior',
  about: 'About',
};

export function Settings({ tab }: { tab: SettingsTab }) {
  return (
    <div className="page settings-page">
      <h1>{S.nav.settings}</h1>
      <div className="settings-layout">
        <nav aria-label="Settings sections" className="settings-nav">
          <ul>
            {SETTINGS_TABS.map((t) => (
              <li key={t}>
                <a
                  href={`#/settings/${t}`}
                  aria-current={t === tab ? 'page' : undefined}
                  className={t === tab ? 'nav-current' : undefined}
                >
                  {TAB_LABELS[t]}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <section className="settings-content" aria-labelledby="settings-heading">
          <h2 id="settings-heading">{TAB_LABELS[tab]}</h2>
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'layout' && <LayoutTab />}
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'library' && <LibraryTab />}
          {tab === 'features' && (
            <>
              <FeaturesSettings />
              <Pack2Settings />
            </>
          )}
          {tab === 'backup' && <BackupTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'about' && <AboutTab />}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ appearance */

const COLOR_LABELS: Record<AnyColorToken, string> = {
  snoozed: 'Badge: Snoozed',
  ignored: 'Badge: Ignored',
  inPile: 'Badge: In pile',
  newItem: 'Badge: New',
  bg: 'Background',
  surface: 'Surface (cards)',
  surfaceAlt: 'Alternate surface',
  text: 'Text',
  textMuted: 'Muted text',
  accent: 'Accent / links',
  onAccent: 'Text on accent',
  border: 'Borders',
  focus: 'Focus ring',
  planned: 'Status: Planned',
  inProgress: 'Status: In Progress',
  completed: 'Status: Completed',
  onHold: 'Status: On Hold',
  dropped: 'Status: Dropped',
  success: 'Success',
  warning: 'Warning',
  danger: 'Error / danger',
};

function AppearanceTab() {
  const app = useApp();
  const toast = useToast();
  const themes = useAsync(() => call(getApi().themes.list()), []);
  // The chosen radio shows immediately; it reverts if saving fails.
  const [pendingTheme, setPendingTheme] = useState<string | null>(null);
  const active = pendingTheme ?? app.settings?.activeThemeId ?? 'system';
  const [editing, setEditing] = useState<ThemeDetailView | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'reset' | null>(null);
  const [resetCustom, setResetCustom] = useState(false);
  const id = useId();

  const choose = async (themeId: string) => {
    setPendingTheme(themeId);
    try {
      await app.updateSettings({ activeThemeId: themeId });
      app.reloadTheme();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setPendingTheme(null);
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      themes.reload();
      app.reloadTheme();
      toast.success(ok);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const selected = themes.data?.find((t) => t.id === active);

  return (
    <div>
      {themes.loading && !themes.data && <Loading />}
      {themes.data && (
        <fieldset className="theme-list">
          <legend>Theme</legend>
          {themes.data.map((t) => (
            <div key={t.id} className="radio-row">
              <input
                id={`${id}-${t.id}`}
                type="radio"
                name={`${id}-theme`}
                checked={t.id === active}
                onChange={() => void choose(t.id)}
              />
              <label htmlFor={`${id}-${t.id}`}>
                {t.name}
                {t.builtIn && t.id !== 'system' && <span className="muted"> (built-in, read-only)</span>}
              </label>
            </div>
          ))}
        </fieldset>
      )}
      <div className="row wrap">
        <button
          type="button"
          className="button"
          onClick={() =>
            void act(
              async () => setEditing(await call(getApi().themes.duplicate({ id: active }))),
              'Theme duplicated — now editing the copy.',
            )
          }
        >
          Duplicate selected
        </button>
        {selected && !selected.builtIn && (
          <>
            <button
              type="button"
              className="button"
              onClick={() =>
                void call(getApi().themes.get({ id: active })).then(setEditing, (e: unknown) =>
                  toast.error(errorOf(e)),
                )
              }
            >
              Edit / rename
            </button>
            <button type="button" className="button button-danger" onClick={() => setConfirm('delete')}>
              Delete
            </button>
          </>
        )}
        <button
          type="button"
          className="button"
          onClick={() =>
            void act(async () => {
              const t = await call(getApi().themes.importFile());
              if (t) await choose(t.id);
            }, 'Theme imported.')
          }
        >
          Import theme…
        </button>
        <button
          type="button"
          className="button"
          onClick={() => void act(() => call(getApi().themes.exportFile({ id: active })), 'Theme exported.')}
        >
          Export selected…
        </button>
        <button type="button" className="button" onClick={() => setConfirm('reset')}>
          Reset themes…
        </button>
      </div>
      {editing && (
        <ThemeEditor
          theme={editing}
          onCancel={() => {
            setEditing(null);
            app.reloadTheme();
          }}
          onSaved={(t) => {
            setEditing(null);
            themes.reload();
            void choose(t.id);
            toast.success('Theme saved.');
          }}
        />
      )}
      {confirm === 'delete' && selected && (
        <ConfirmDialog
          title={`Delete theme “${selected.name}”?`}
          message={<p>The app will switch to the System theme.</p>}
          confirmLabel="Delete theme"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void act(async () => {
              await call(getApi().themes.remove({ id: selected.id }));
              const s = await call(getApi().settings.get());
              await app.updateSettings({ activeThemeId: s.activeThemeId });
            }, 'Theme deleted.');
          }}
        />
      )}
      {confirm === 'reset' && (
        <ConfirmDialog
          title="Reset themes?"
          message={
            <>
              <p>The active theme returns to System (follows your OS).</p>
              <Checkbox
                label="Also delete all my custom themes"
                checked={resetCustom}
                onChange={setResetCustom}
              />
            </>
          }
          confirmLabel="Reset"
          destructive={resetCustom}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void act(async () => {
              await call(getApi().themes.reset({ deleteCustom: resetCustom }));
              await app.updateSettings({ activeThemeId: 'system' });
            }, 'Themes reset.');
          }}
        />
      )}
    </div>
  );
}

function ThemeEditor({
  theme,
  onCancel,
  onSaved,
}: {
  theme: ThemeDetailView;
  onCancel: () => void;
  onSaved: (t: ThemeDetailView) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(theme.name);
  const [tokens, setTokens] = useState<ThemeTokens>(theme.tokens);
  const [busy, setBusy] = useState(false);
  const warnings = contrastWarnings(tokens);
  const valid =
    Object.values(tokens.colors).every((c) => c === undefined || HEX_COLOR_RE.test(c)) &&
    name.trim().length > 0;

  // Live preview while editing (validated values only; applied via setProperty).
  useEffect(() => {
    if (valid)
      applyTheme(
        { selectedId: theme.id, light: tokens, dark: tokens, followSystem: false, notice: null },
        false,
      );
  }, [tokens, valid, theme.id]);

  const setColor = (k: AnyColorToken, v: string) =>
    setTokens((t) => ({ ...t, colors: { ...t.colors, [k]: v } }));
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await call(getApi().themes.save({ id: theme.id, name, tokens })));
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card theme-editor" aria-labelledby="theme-editor-h">
      <h3 id="theme-editor-h">Editing “{theme.name}” — changes preview live</h3>
      <TextField
        label="Name"
        value={name}
        onChange={setName}
        maxLength={60}
        required
        error={name.trim() ? undefined : 'Enter a name.'}
      />
      <div className="form-grid">
        <SelectField
          label="Base scheme"
          value={tokens.colorScheme}
          onChange={(v) => setTokens((t) => ({ ...t, colorScheme: v }))}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <SelectField
          label="Corner radius"
          value={tokens.radius}
          onChange={(v) => setTokens((t) => ({ ...t, radius: v }))}
          options={RADIUS_OPTIONS.map((r) => ({ value: r, label: r }))}
        />
        <SelectField
          label="Density"
          value={tokens.density}
          onChange={(v) => setTokens((t) => ({ ...t, density: v }))}
          options={DENSITY_OPTIONS.map((r) => ({ value: r, label: r }))}
        />
        <SelectField
          label="Font"
          value={tokens.fontFamily}
          onChange={(v) => setTokens((t) => ({ ...t, fontFamily: v }))}
          options={FONT_FAMILY_OPTIONS.map((r) => ({ value: r, label: r }))}
        />
        <NumberField
          label={`Text size (${FONT_SCALE_MIN}–${FONT_SCALE_MAX})`}
          value={tokens.fontScale}
          onChange={(v) =>
            v !== null &&
            v >= FONT_SCALE_MIN &&
            v <= FONT_SCALE_MAX &&
            setTokens((t) => ({ ...t, fontScale: v }))
          }
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={0.05}
        />
      </div>
      <fieldset className="color-grid">
        <legend>Colors</legend>
        {ALL_COLOR_TOKENS.map((k) => (
          <ColorInput
            key={k}
            label={COLOR_LABELS[k]}
            value={colorOf(tokens, k)}
            onChange={(v) => setColor(k, v)}
          />
        ))}
      </fieldset>
      {warnings.length > 0 ? (
        <div className="notice notice-warning" role="status">
          <IconAlert />
          <div>
            <p className="notice-title">Some colors fall below WCAG AA contrast (you can still save):</p>
            <ul>
              {warnings.map((w) => (
                <li key={w.pair}>
                  {w.pair}: {w.ratio}:1 (needs {w.required}:1)
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="success-text">
          <IconCheck /> All checked color pairs meet WCAG AA.
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void save()}
          disabled={busy || !valid}
        >
          Save theme
        </button>
      </div>
    </section>
  );
}

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  const valid = HEX_COLOR_RE.test(text);
  return (
    <div className="color-input">
      <label htmlFor={`${id}-t`}>{label}</label>
      <div className="row">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={value.slice(0, 7)}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <input
          id={`${id}-t`}
          className="input input-inline mono"
          value={text}
          aria-invalid={!valid || undefined}
          aria-describedby={valid ? undefined : `${id}-e`}
          onChange={(e) => {
            setText(e.target.value);
            if (HEX_COLOR_RE.test(e.target.value)) onChange(e.target.value.toUpperCase());
          }}
        />
      </div>
      {!valid && (
        <p className="field-error" id={`${id}-e`}>
          Use #RRGGBB or #RRGGBBAA.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

function LayoutTab() {
  const app = useApp();
  const toast = useToast();
  const save = async (surface: LayoutSurface, entries: LayoutComponentView[]) => {
    try {
      app.setLayouts(await call(getApi().layouts.set({ surface, entries })));
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'dashboard' in r) app.setLayouts(r as LayoutsView);
      toast.success(ok);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  if (!app.layouts) return <Loading />;
  return (
    <div>
      <p>Choose which components appear and in what order. Changes apply immediately.</p>
      <LayoutEditor
        title="Dashboard"
        surface="dashboard"
        entries={app.layouts.dashboard}
        onChange={(e) => void save('dashboard', e)}
      />
      <LayoutEditor
        title="Library"
        surface="library"
        entries={app.layouts.library}
        onChange={(e) => void save('library', e)}
      />
      <div className="row wrap">
        <button
          type="button"
          className="button"
          onClick={() =>
            void act(() => call(getApi().layouts.reset({ surface: 'both' })), 'Layouts reset to defaults.')
          }
        >
          Reset both to defaults
        </button>
        <button
          type="button"
          className="button"
          onClick={() => void act(() => call(getApi().layouts.importFile()), 'Layout imported.')}
        >
          Import layout…
        </button>
        <button
          type="button"
          className="button"
          onClick={() => void act(() => call(getApi().layouts.exportFile()), 'Layout exported.')}
        >
          Export layout…
        </button>
      </div>
    </div>
  );
}

function LayoutEditor({
  title,
  surface,
  entries,
  onChange,
}: {
  title: string;
  surface: LayoutSurface;
  entries: LayoutComponentView[];
  onChange: (e: LayoutComponentView[]) => void;
}) {
  const id = useId();
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= entries.length) return;
    const n = [...entries];
    const a = n[i];
    const b = n[j];
    if (!a || !b) return;
    n[i] = b;
    n[j] = a;
    onChange(n);
    // Keep focus on the moved row's same button.
    setTimeout(() => {
      const same = document.getElementById(
        `${id}-${a.id}-${d === -1 ? 'up' : 'down'}`,
      ) as HTMLButtonElement | null;
      const other = document.getElementById(`${id}-${a.id}-${d === -1 ? 'down' : 'up'}`);
      (same && !same.disabled ? same : other)?.focus();
    }, 30);
  };
  return (
    <fieldset className="layout-editor card">
      <legend>{title}</legend>
      <ol className="reorder-list">
        {entries.map((e, i) => {
          const label = COMPONENT_LABELS[e.id as keyof typeof COMPONENT_LABELS] ?? e.id;
          return (
            <li key={e.id} className="row">
              <span className="reorder-label">
                {i + 1}. {label}
              </span>
              <Checkbox
                label="Visible"
                checked={e.visible}
                onChange={(v) => onChange(entries.map((x) => (x.id === e.id ? { ...x, visible: v } : x)))}
                id={`${id}-${e.id}-vis`}
              />
              {surface === 'dashboard' && (
                <>
                  <label htmlFor={`${id}-${e.id}-span`} className="visually-hidden">
                    Width of {label}
                  </label>
                  <select
                    id={`${id}-${e.id}-span`}
                    className="input input-inline"
                    value={e.span}
                    onChange={(ev) =>
                      onChange(
                        entries.map((x) =>
                          x.id === e.id ? { ...x, span: ev.target.value === '2' ? 2 : 1 } : x,
                        ),
                      )
                    }
                  >
                    <option value="1">Half width</option>
                    <option value="2">Full width</option>
                  </select>
                </>
              )}
              <button
                type="button"
                id={`${id}-${e.id}-up`}
                className="icon-button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${label} up`}
              >
                <IconArrowUp />
              </button>
              <button
                type="button"
                id={`${id}-${e.id}-down`}
                className="icon-button"
                onClick={() => move(i, 1)}
                disabled={i === entries.length - 1}
                aria-label={`Move ${label} down`}
              >
                <IconArrowDown />
              </button>
            </li>
          );
        })}
      </ol>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ providers */

function ProvidersTab() {
  const app = useApp();
  const toast = useToast();
  const providers = useAsync(() => call(getApi().providers.list()), []);
  return (
    <div>
      <p>Online sources are optional — everything works offline and you can always add items manually.</p>
      {app.info?.secretStorage === 'plaintext-fallback' && (
        <Notice kind="warning">
          Your system has no secure key storage available (for example, no keyring on Linux). API keys you
          enter are stored without OS encryption in the app data folder.
        </Notice>
      )}
      <div className="field field-inline">
        <label htmlFor="region-select">Region for availability</label>
        <select
          id="region-select"
          className="input input-inline"
          value={app.settings?.region ?? 'US'}
          onChange={(e) =>
            void app
              .updateSettings({ region: e.target.value })
              .catch((err: unknown) => toast.error(errorOf(err)))
          }
        >
          {REGIONS.map(([c, n]) => (
            <option key={c} value={c}>
              {n} ({c})
            </option>
          ))}
        </select>
      </div>
      {providers.error && <ErrorBox error={providers.error} onRetry={providers.reload} />}
      {providers.data?.map((p) => (
        <ProviderCard key={p.id} p={p} onChange={(list) => providers.setData(list)} />
      ))}
      <SteamProviderSection />
    </div>
  );
}

const KEY_LABELS = {
  apiKey: 'API key or read access token',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
} as const;

function ProviderCard({ p, onChange }: { p: ProviderInfo; onChange: (l: ProviderInfo[]) => void }) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<ProviderInfo[]>, ok: string) => {
    try {
      onChange(await fn());
      toast.success(ok);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <section className="card provider-card" aria-labelledby={`prov-${p.id}`}>
      <h3 id={`prov-${p.id}`}>
        {p.displayName}
        {p.kind === 'art' && <span className="badge"> Artwork only</span>}
      </h3>
      <p>
        Covers: {p.supports.map(typeLabel).join(', ')} · Rate limit: {p.rateLimitText} · Artwork:{' '}
        {p.cachingPolicy === 'cache-allowed' ? 'saved for offline use' : 'shown from the web only'}
      </p>
      {p.termsNote && (
        <p className="notice notice-info provider-terms">
          <IconAlert /> <span>{p.termsNote}</span>
        </p>
      )}
      <p className={p.configured ? 'success-text' : 'warning-text'}>
        {p.configured ? <IconCheck /> : <IconAlert />} {p.configured ? 'Ready to use' : 'Needs credentials'}
      </p>
      <Checkbox
        label={`Use ${p.displayName}`}
        checked={p.enabled}
        onChange={(v) =>
          void run(
            () => call(getApi().providers.setEnabled({ providerId: p.id, enabled: v })),
            v ? 'Enabled.' : 'Disabled.',
          )
        }
      />
      {p.keyFields.map((f) => (
        <div key={f} className="row wrap key-row">
          <TextField
            type="password"
            label={`${p.keyLabels[f] ?? KEY_LABELS[f]}${p.keysSet[f] ? ' (saved)' : ''}`}
            hint={
              p.keysSet[f]
                ? 'A value is saved. Enter a new one to replace it. Saved keys are never shown.'
                : undefined
            }
            value={drafts[f] ?? ''}
            onChange={(v) => setDrafts((d) => ({ ...d, [f]: v }))}
          />
          <button
            type="button"
            className="button button-small"
            disabled={!drafts[f]}
            onClick={() =>
              void run(
                () => call(getApi().providers.setKey({ providerId: p.id, field: f, value: drafts[f] ?? '' })),
                'Saved.',
              ).then(() => setDrafts((d) => ({ ...d, [f]: '' })))
            }
          >
            Save
          </button>
          {p.keysSet[f] && (
            <button
              type="button"
              className="button button-small"
              onClick={() =>
                void run(
                  () => call(getApi().providers.setKey({ providerId: p.id, field: f, value: '' })),
                  'Cleared.',
                )
              }
            >
              Clear
            </button>
          )}
        </div>
      ))}
      {p.signupUrl && (
        <p>
          Get credentials:{' '}
          <ExternalLink
            link={{ kind: 'tmdb', label: `${p.displayName} developer sign-up`, url: p.signupUrl }}
          />
        </p>
      )}
      <p className="attribution">
        {p.attribution.text}{' '}
        <ExternalLink link={{ kind: 'tmdb', label: 'Website', url: p.attribution.url }} />
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ custom fields & series */

function LibraryTab() {
  const toast = useToast();
  const defs = useAsync(() => call(getApi().catalog.customFields()), []);
  const series = useAsync(() => call(getApi().catalog.series()), []);
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState<string[]>([]);
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const [delId, setDelId] = useState<string | null>(null);
  const add = async () => {
    try {
      setFieldErr(undefined);
      defs.setData(
        await call(
          getApi().catalog.saveCustomField({
            id: null,
            name,
            type,
            options: type === 'select' ? options : [],
          }),
        ),
      );
      setName('');
      setOptions([]);
      toast.success('Custom field added.');
    } catch (e) {
      const err = errorOf(e);
      setFieldErr(err.fieldErrors?.['name'] ?? err.fieldErrors?.['options'] ?? err.message);
    }
  };
  return (
    <div>
      <h3>Custom fields</h3>
      <p className="muted">Add your own fields (shown on every item’s edit form).</p>
      {defs.data && defs.data.length > 0 && (
        <table className="table">
          <caption className="visually-hidden">Custom fields</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Used by</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {defs.data.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>
                  {d.type}
                  {d.type === 'select' ? `: ${d.options.join(', ')}` : ''}
                </td>
                <td>{d.usageCount} item(s)</td>
                <td>
                  <button
                    type="button"
                    className="button button-small button-danger"
                    onClick={() => setDelId(d.id)}
                  >
                    Delete<span className="visually-hidden"> {d.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-grid">
        <TextField label="New field name" value={name} onChange={setName} error={fieldErr} />
        <SelectField
          label="Type"
          value={type}
          onChange={setType}
          options={CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: t === 'select' ? 'single-select' : t }))}
        />
      </div>
      {type === 'select' && <ListInput label="Options" values={options} onChange={setOptions} />}
      <button type="button" className="button" disabled={!name.trim()} onClick={() => void add()}>
        Add field
      </button>
      {delId && (
        <ConfirmDialog
          title="Delete custom field?"
          message={
            <p>
              This removes the field and its values from{' '}
              {defs.data?.find((d) => d.id === delId)?.usageCount ?? 0} item(s).
            </p>
          }
          confirmLabel="Delete field"
          destructive
          onCancel={() => setDelId(null)}
          onConfirm={() => {
            const id = delId;
            setDelId(null);
            void call(getApi().catalog.deleteCustomField({ id })).then(defs.setData, (e: unknown) =>
              toast.error(errorOf(e)),
            );
          }}
        />
      )}
      <h3>Book series</h3>
      {series.data && series.data.length === 0 && (
        <p className="muted">No series yet. Add a book to a series from its page.</p>
      )}
      <ul className="plain-list">
        {series.data?.map((s) => (
          <li key={s.id}>
            <strong>{s.name}</strong> — {s.members.length} book(s)
            {s.totalKnown ? ` of ${s.totalKnown} known` : ''}
            {s.members.length > 0 && (
              <ol>
                {s.members.map((m) => (
                  <li key={m.itemId}>
                    <a href={`#/item/${m.itemId}`}>{m.title}</a>
                    {m.position !== null ? ` (#${m.position})` : ''}
                  </li>
                ))}
              </ol>
            )}
            <button
              type="button"
              className="button button-tiny button-danger"
              onClick={() =>
                void call(getApi().catalog.deleteSeries({ id: s.id })).then(series.setData, (e: unknown) =>
                  toast.error(errorOf(e)),
                )
              }
            >
              Delete series<span className="visually-hidden"> {s.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ backup */

function BackupTab() {
  const app = useApp();
  const toast = useToast();
  const [preview, setPreview] = useState<ImportPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const snapshots = useAsync(() => call(getApi().data.backupList()), [app.dataVersion]);
  const run = async <T,>(fn: () => Promise<T>, onOk: (r: T) => void) => {
    setBusy(true);
    try {
      onOk(await fn());
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  const saved = (r: { fileLabel: string; bytes: number } | null, what: string) =>
    r && toast.success(`${what} saved as “${r.fileLabel}” (${fmtBytes(r.bytes)}).`);
  const readOnly = app.info?.readOnly ?? false;
  return (
    <div aria-busy={busy}>
      <section className="card">
        <h3>Full backup</h3>
        <p>
          A single .mpbackup file with your whole library, history, artwork, themes, layouts and settings. API
          keys are never included. Use it to move to another computer or OS.
        </p>
        <div className="row wrap">
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() =>
              void run(
                () => call(getApi().data.backupCreate()),
                (r) => saved(r, 'Backup'),
              )
            }
          >
            Create backup…
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || readOnly}
            onClick={() =>
              void run(
                () => call(getApi().data.importPreview({ kind: 'backup' })),
                (p) => p && setPreview(p),
              )
            }
          >
            Restore from backup…
          </button>
        </div>
        <p className="muted">
          Default folder: {app.info?.backupLocationLabel ?? '…'}{' '}
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              void run(
                () => call(getApi().app.chooseBackupFolder()),
                (r) => (r && toast.success(`Default folder set to ${r.label}.`), app.reloadInfo()),
              )
            }
          >
            Change…
          </button>
        </p>
      </section>
      <section className="card">
        <h3>Export</h3>
        <p>
          JSON contains everything except artwork files and API keys. CSV is one row per item (no episode
          lists, history or provenance) — handy for spreadsheets.
        </p>
        <div className="row wrap">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => call(getApi().data.exportJson()),
                (r) => saved(r, 'JSON export'),
              )
            }
          >
            Export JSON…
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => call(getApi().data.exportCsv()),
                (r) => saved(r, 'CSV export'),
              )
            }
          >
            Export CSV…
          </button>
          <Checkbox
            label="Add a byte-order mark to CSV (helps Excel read accents)"
            checked={app.settings?.csvBom ?? true}
            onChange={(v) => void app.updateSettings({ csvBom: v })}
          />
        </div>
      </section>
      <section className="card">
        <h3>Import (merge)</h3>
        <p>
          Adds items from a Maybe Pile JSON export or a CSV file. You’ll see a preview with any conflicts
          before anything changes.
        </p>
        <div className="row wrap">
          <button
            type="button"
            className="button"
            disabled={busy || readOnly}
            onClick={() =>
              void run(
                () => call(getApi().data.importPreview({ kind: 'json' })),
                (p) => p && setPreview(p),
              )
            }
          >
            Import JSON…
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || readOnly}
            onClick={() =>
              void run(
                () => call(getApi().data.importPreview({ kind: 'csv' })),
                (p) => p && setPreview(p),
              )
            }
          >
            Import CSV…
          </button>
        </div>
      </section>
      <section className="card">
        <h3>Automatic safety snapshots</h3>
        <p className="muted">
          Maybe Pile saves a snapshot before every restore (last 5 kept) and before every library upgrade
          (last 3 kept).
        </p>
        {snapshots.data && snapshots.data.length === 0 && <p className="muted">No snapshots yet.</p>}
        <ul className="plain-list">
          {snapshots.data?.map((s) => (
            <li key={s.label}>
              {s.label} ({fmtBytes(s.bytes)}){' '}
              {s.label.endsWith('.mpbackup') && (
                <button
                  type="button"
                  className="button button-tiny"
                  disabled={busy || readOnly}
                  onClick={() =>
                    void run(() => call(getApi().data.restoreInternalPreview({ label: s.label })), setPreview)
                  }
                >
                  Restore this…
                </button>
              )}
              {s.kind === 'pre-migration' && (
                <span className="muted"> (database file; see troubleshooting guide to restore)</span>
              )}
            </li>
          ))}
        </ul>
      </section>
      {preview && (
        <ImportPreviewDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={(r) => {
            setPreview(null);
            app.bumpData();
            app.reloadTheme();
            void call(getApi().layouts.get()).then(app.setLayouts);
            void call(getApi().settings.get()).then(() => app.updateSettings({}));
            snapshots.reload();
            toast.success(
              preview.mode === 'replace'
                ? `Library restored. A snapshot of your previous library was saved as ${r.snapshotLabel ?? 'a snapshot'}.`
                : `Import complete: ${r.added} added, ${r.updated} updated, ${r.duplicated} kept as duplicates, ${r.skipped} skipped.`,
            );
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ data & behavior */

function DataTab() {
  const app = useApp();
  const toast = useToast();
  const info = app.info;
  return (
    <div>
      <section className="card">
        <SyncSettings />
      </section>
      <section className="card">
        <h3>Data location</h3>
        <p>
          Your library is stored locally at:
          <br />
          <code className="path">{info?.dataLocationLabel ?? '…'}</code>
          {info?.portable && (
            <span className="muted"> (portable mode — separate from any installed copy)</span>
          )}
        </p>
        <button
          type="button"
          className="button"
          onClick={() =>
            void call(getApi().app.openDataFolder()).catch((e: unknown) => toast.error(errorOf(e)))
          }
        >
          Open data folder
        </button>
      </section>
      <section className="card">
        <h3>Behavior</h3>
        <Checkbox
          label="Automatically apply status suggestions"
          hint="When you log progress on a Planned item it moves to In Progress automatically. Completion is always confirmed by you."
          checked={app.settings?.autoApplySuggestions ?? false}
          onChange={(v) => void app.updateSettings({ autoApplySuggestions: v })}
        />
      </section>
      <section className="card">
        <h3>Diagnostic log</h3>
        <p>
          The log records events and error codes — never titles, notes or API keys. Export it to share when
          reporting a problem.
        </p>
        <button
          type="button"
          className="button"
          onClick={() =>
            void call(getApi().app.exportLog()).then(
              (r) => r && toast.success(`Log saved as “${r.fileLabel}”.`),
              (e: unknown) => toast.error(errorOf(e)),
            )
          }
        >
          Export diagnostic log…
        </button>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ about */

const THIRD_PARTY = [
  ['Electron', 'MIT'],
  ['React / React DOM', 'MIT'],
  ['Zod', 'MIT'],
  ['fflate', 'MIT'],
  ['SQLite (via Node.js node:sqlite)', 'Public domain'],
  ['Chromium & Node.js (bundled with Electron)', 'BSD-3-Clause / MIT and others'],
];

function AboutTab() {
  const app = useApp();
  const providers = useAsync(() => call(getApi().providers.list()), []);
  const i = app.info;
  if (!i) return <Loading />;
  return (
    <div>
      <p className="tagline">{i.tagline}</p>
      <dl className="details-list">
        <div>
          <dt>Version</dt>
          <dd>{i.version}</dd>
        </div>
        <div>
          <dt>Electron / Chromium / Node</dt>
          <dd>
            {i.electron} / {i.chrome} / {i.node}
          </dd>
        </div>
        <div>
          <dt>SQLite / library schema</dt>
          <dd>
            {i.sqlite} / v{i.schemaVersion}
          </dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>
            {i.platform}
            {i.portable ? ' (portable)' : ''}
          </dd>
        </div>
      </dl>
      <h3>Data sources & attribution</h3>
      <ul className="plain-list">
        {providers.data?.map((p) => (
          <li key={p.id}>
            <strong>{p.displayName}</strong>: {p.attribution.text}{' '}
            <ExternalLink link={{ kind: 'tmdb', label: 'Website', url: p.attribution.url }} />
          </li>
        ))}
        <li>
          <strong>JustWatch</strong>: Where-to-watch data is provided by JustWatch through TMDB.
        </li>
      </ul>
      <h3>License</h3>
      <p>Maybe Pile is released under the MIT License. It includes third-party software:</p>
      <ul className="plain-list">
        {THIRD_PARTY.map(([n, l]) => (
          <li key={n}>
            {n} — {l}
          </li>
        ))}
      </ul>
      <p className="muted">
        Online sources are only contacted when you search, import, refresh or check availability.
      </p>
      <button type="button" className="button" onClick={() => app.setShortcutsOpen(true)}>
        Keyboard shortcuts
      </button>
    </div>
  );
}

/** Settings → Providers → Steam: same form as the Import page. */
function SteamProviderSection() {
  const q = useAsync(() => call(getApi().sources.list()), []);
  const steam = (q.data ?? []).filter((s) => s.kind === 'steam');
  return (
    <section className="card provider-card" aria-labelledby="steam-provider">
      <h3 id="steam-provider">Steam (library import)</h3>
      <p className="muted">
        Imports the games you own using your own Steam Web API key. Review and import them under{' '}
        <a href="#/import/sources">Import → Game libraries</a>.
      </p>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && <SteamSetupForm source={steam[0] ?? null} onSaved={(l) => q.setData(l)} />}
    </section>
  );
}

/** Settings → Advanced (Full mode only). */
import { useState } from 'react';
import {
  CUSTOM_FIELD_TYPES,
  MEDIA_TYPES,
  STATUSES,
  type CustomFieldType,
  type MediaType,
  type Status,
} from '../../../shared/enums';
import type { AutoRules, SettingsPatch } from '../../../shared/schemas';
import type { ItemTemplateBody } from '../../../shared/pack21-schemas';
import type { TemplateView } from '../../../shared/views-21';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtBytes, statusLabel, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { batchAction } from '../../app/undo';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { ErrorBox, Loading } from '../../components/Bits';
import { NumberField, SelectField, TextArea, TextField } from '../../components/Fields';
import { Toggle } from '../notifications/shared';

export function AdvancedTab() {
  const app = useApp();
  const toast = useToast();
  const s = app.settings;
  if (!s) return <Loading />;
  const save = (p: SettingsPatch) =>
    void app.updateSettings(p).catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <div className="advanced-tab">
      <section className="subsection" aria-labelledby="adv-keep">
        <h3 id="adv-keep">Keeping things</h3>
        <NumberField
          label="Keep deleted items in Recently deleted for (days)"
          value={s.trash.retentionDays}
          min={1}
          max={365}
          onChange={(v) => v && v >= 1 && v <= 365 && save({ trash: { retentionDays: v } })}
        />
        <Toggle
          label="Keep a log of recent changes (with undo)"
          checked={s.changeLog.enabled}
          onChange={(v) => save({ changeLog: { ...s.changeLog, enabled: v } })}
        />
        <div className="field-row">
          <NumberField
            label="Keep changes for (days)"
            value={s.changeLog.retentionDays}
            min={1}
            max={3650}
            onChange={(v) => v && save({ changeLog: { ...s.changeLog, retentionDays: v } })}
          />
          <NumberField
            label="At most this many changes"
            value={s.changeLog.maxEntries}
            min={100}
            max={100_000}
            onChange={(v) => v && v >= 100 && save({ changeLog: { ...s.changeLog, maxEntries: v } })}
          />
        </div>
        <a href="#/changes">Open Recent changes…</a>
      </section>
      <section className="subsection" aria-labelledby="adv-rate">
        <h3 id="adv-rate">When you finish something</h3>
        <Toggle
          label="Ask “How was it?” (never blocks; skip any time)"
          checked={s.ratingPrompt.enabled}
          onChange={(v) => save({ ratingPrompt: { ...s.ratingPrompt, enabled: v } })}
        />
        <Toggle
          label="Only when there is no rating yet"
          checked={s.ratingPrompt.onlyUnrated}
          onChange={(v) => save({ ratingPrompt: { ...s.ratingPrompt, onlyUnrated: v } })}
        />
        <Toggle
          label="Clear the “Next step” line when an item is completed"
          checked={s.nextStep.clearOnComplete}
          onChange={(v) => save({ nextStep: { clearOnComplete: v } })}
        />
      </section>
      <RulesSection rules={s.autoRules} save={(r) => save({ autoRules: r })} />
      <TemplatesSection />
      <ViewsSection />
      <section className="subsection" aria-labelledby="adv-theme">
        <h3 id="adv-theme">Theme schedule</h3>
        <Toggle
          label="Switch theme by time of day"
          hint="Computed on this computer from the times below; no location or network is used. A manual theme change lasts until the next switch."
          checked={s.themeSchedule.enabled}
          onChange={(v) => save({ themeSchedule: { ...s.themeSchedule, enabled: v } })}
        />
        {s.themeSchedule.enabled && <ThemeScheduleFields />}
      </section>
      <ArtworkStorageSection />
      <LibrariesSection />
    </div>
  );
}

function ThemeScheduleFields() {
  const app = useApp();
  const themes = useAsync(() => call(getApi().themes.list()), []);
  const s = app.settings;
  if (!s) return null;
  const ts = s.themeSchedule;
  const opts = [
    { value: 'system', label: 'System' },
    ...(themes.data ?? []).filter((t) => t.id !== 'system').map((t) => ({ value: t.id, label: t.name })),
  ];
  const set = (p: Partial<typeof ts>) => void app.updateSettings({ themeSchedule: { ...ts, ...p } });
  return (
    <div className="field-row">
      <SelectField
        label="Day theme"
        value={ts.lightThemeId}
        onChange={(v) => set({ lightThemeId: v })}
        options={opts}
      />
      <TextField label="From" type="time" value={ts.lightAt} onChange={(v) => v && set({ lightAt: v })} />
      <SelectField
        label="Night theme"
        value={ts.darkThemeId}
        onChange={(v) => set({ darkThemeId: v })}
        options={opts}
      />
      <TextField label="From" type="time" value={ts.darkAt} onChange={(v) => v && set({ darkAt: v })} />
    </div>
  );
}

function RulesSection({ rules, save }: { rules: AutoRules; save: (r: AutoRules) => void }) {
  const toast = useToast();
  const app = useApp();
  const preview = useAsync(() => call(getApi().rules.preview()), [JSON.stringify(rules), app.dataVersion]);
  const run = async () => {
    try {
      const r = await call(getApi().rules.run());
      toast.show(
        {
          kind: 'success',
          message: `${r.changed} change(s) applied${r.suggestions.length ? ` · ${r.suggestions.length} suggestion(s) to review on their pages` : ''}.`,
          action: batchAction(r.batchId, () => app.bumpData()),
        },
        12_000,
      );
      app.bumpData();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <section className="subsection" aria-labelledby="adv-rules">
      <h3 id="adv-rules">Automatic status rules</h3>
      <p className="muted">
        Off by default. They run when the app starts and once a day, never delete anything, and every change
        can be undone in Recent changes.
      </p>
      <Toggle
        label="Suggest Completed when all episodes, pages or milestones are done (asks first)"
        checked={rules.suggestCompleted}
        onChange={(v) => save({ ...rules, suggestCompleted: v })}
      />
      <Toggle
        label={`Move In Progress items to On Hold after ${rules.onHoldAfterDays.days} days without progress`}
        checked={rules.onHoldAfterDays.enabled}
        onChange={(v) => save({ ...rules, onHoldAfterDays: { ...rules.onHoldAfterDays, enabled: v } })}
      />
      {rules.onHoldAfterDays.enabled && (
        <NumberField
          label="Days"
          value={rules.onHoldAfterDays.days}
          min={7}
          max={3650}
          onChange={(v) =>
            v && v >= 7 && save({ ...rules, onHoldAfterDays: { ...rules.onHoldAfterDays, days: v } })
          }
        />
      )}
      <Toggle
        label={`Flag Planned items as stale after ${rules.stalePlanned.months} months (flag only)`}
        checked={rules.stalePlanned.enabled}
        onChange={(v) => save({ ...rules, stalePlanned: { ...rules.stalePlanned, enabled: v } })}
      />
      {rules.stalePlanned.enabled && (
        <NumberField
          label="Months"
          value={rules.stalePlanned.months}
          min={1}
          max={120}
          onChange={(v) => v && save({ ...rules, stalePlanned: { ...rules.stalePlanned, months: v } })}
        />
      )}
      <Toggle
        label="When I start an item, remove it from Up Next"
        checked={rules.removeFromUpNextOnStart}
        onChange={(v) => save({ ...rules, removeFromUpNextOnStart: v })}
      />
      {preview.data && preview.data.length > 0 && (
        <div className="rule-preview" role="status">
          <h4>What would change right now</h4>
          <ul>
            {preview.data.map((p) => (
              <li key={p.rule}>
                {p.label}: <strong>{p.items.length}</strong>
                {p.items.length > 0 && (
                  <span className="muted">
                    {' '}
                    (
                    {p.items
                      .slice(0, 3)
                      .map((i) => i.title)
                      .join(', ')}
                    {p.items.length > 3 ? '…' : ''})
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="button" onClick={() => void run()}>
            Run rules now
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ templates */

const emptyBody = (): ItemTemplateBody => ({
  version: 1,
  type: 'game',
  status: 'planned',
  tags: [],
  moodIds: [],
  customFields: [],
  checklist: [],
  listId: null,
  platform: null,
});

function TemplatesSection() {
  const toast = useToast();
  const list = useAsync(() => call(getApi().templates.list()), []);
  const starters = useAsync(() => call(getApi().templates.starters()), []);
  const [editing, setEditing] = useState<TemplateView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TemplateView | null>(null);
  const reload = list.reload;
  const io = async (p: Promise<unknown>, msg: string) => {
    try {
      const r = await p;
      if (r) toast.success(msg);
      reload();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const existing = new Set((list.data ?? []).map((t) => t.name.toLowerCase()));
  return (
    <section className="subsection" aria-labelledby="adv-tpl">
      <h3 id="adv-tpl">Item templates</h3>
      <p className="muted">
        Presets for Add (“Start from template”). Deleting a template never changes items made from it. Board
        games and similar are games with custom fields — no new media type.
      </p>
      {list.error && <ErrorBox error={list.error} onRetry={reload} />}
      <ul className="plain-list">
        {(list.data ?? []).map((t) => (
          <li key={t.id} className="row">
            <span>
              {t.name} <span className="muted">({typeLabel(t.body.type)})</span>
            </span>
            <button
              type="button"
              className="button button-small"
              onClick={() => setEditing(t)}
              aria-label={`Edit template ${t.name}`}
            >
              Edit
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => void io(call(getApi().templates.duplicate({ id: t.id })), 'Duplicated.')}
              aria-label={`Duplicate template ${t.name}`}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => void io(call(getApi().templates.exportFile({ id: t.id })), 'Exported.')}
              aria-label={`Export template ${t.name}`}
            >
              Export
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => setDeleting(t)}
              aria-label={`Delete template ${t.name}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button type="button" className="button" onClick={() => setEditing('new')}>
          New template…
        </button>
        <button
          type="button"
          className="button"
          onClick={() => void io(call(getApi().templates.importFile()), 'Template imported.')}
        >
          Import…
        </button>
      </div>
      {(starters.data ?? []).filter((st) => !existing.has(st.name.toLowerCase())).length > 0 && (
        <div className="starters">
          <h4>Suggestions</h4>
          {(starters.data ?? [])
            .filter((st) => !existing.has(st.name.toLowerCase()))
            .map((st) => (
              <button
                key={st.name}
                type="button"
                className="button button-small"
                onClick={() =>
                  void io(
                    call(getApi().templates.save({ id: null, name: st.name, body: st.body })),
                    `Added “${st.name}”.`,
                  )
                }
              >
                Add “{st.name}”
              </button>
            ))}
        </div>
      )}
      {editing && (
        <TemplateEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), reload())}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete template?"
          message={`“${deleting.name}” will be deleted. Items created from it are not changed.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            void io(call(getApi().templates.remove({ id: d.id })), 'Template deleted.');
          }}
        />
      )}
    </section>
  );
}

function TemplateEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: TemplateView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [body, setBody] = useState<ItemTemplateBody>(initial?.body ?? emptyBody());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (p: Partial<ItemTemplateBody>) => setBody((b) => ({ ...b, ...p }));
  const save = async () => {
    try {
      await call(getApi().templates.save({ id: initial?.id ?? null, name, body }));
      onSaved();
    } catch (e) {
      const err = errorOf(e);
      setErrors(err.fieldErrors ?? { _: err.message });
    }
  };
  return (
    <Dialog
      title={initial ? 'Edit template' : 'New template'}
      onClose={onClose}
      size="medium"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void save()}
            disabled={!name.trim()}
          >
            Save
          </button>
        </>
      }
    >
      {errors['_'] && <ErrorBox error={{ code: 'VALIDATION', message: errors['_'] }} />}
      <TextField
        label="Name"
        value={name}
        onChange={setName}
        maxLength={80}
        required
        error={errors['name']}
      />
      <div className="field-row">
        <SelectField
          label="Type"
          value={body.type}
          onChange={(v: MediaType) => set({ type: v })}
          options={MEDIA_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))}
        />
        <SelectField
          label="Status"
          value={body.status}
          onChange={(v: Status) => set({ status: v })}
          options={STATUSES.map((st) => ({ value: st, label: statusLabel(st) }))}
        />
      </div>
      <TextField
        label="Tags (comma separated)"
        value={body.tags.join(', ')}
        onChange={(v) =>
          set({
            tags: v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 50),
          })
        }
      />
      {body.type === 'game' && (
        <TextField
          label="Platform"
          value={body.platform ?? ''}
          onChange={(v) => set({ platform: v.trim() || null })}
          maxLength={80}
        />
      )}
      <TextArea
        label="Checklist (one per line)"
        value={body.checklist.join('\n')}
        onChange={(v) =>
          set({
            checklist: v
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 50),
          })
        }
        rows={4}
      />
      <fieldset className="field">
        <legend>Custom fields</legend>
        {body.customFields.map((f, i) => (
          <div key={i} className="field-row">
            <TextField
              label="Field name"
              value={f.name}
              onChange={(v) =>
                set({ customFields: body.customFields.map((x, j) => (j === i ? { ...x, name: v } : x)) })
              }
            />
            <SelectField
              label="Kind"
              value={f.type}
              onChange={(v: CustomFieldType) =>
                set({
                  customFields: body.customFields.map((x, j) =>
                    j === i ? { ...x, type: v, defaultValue: null } : x,
                  ),
                })
              }
              options={CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: t }))}
            />
            <TextField
              label="Default"
              value={f.defaultValue === null ? '' : String(f.defaultValue)}
              onChange={(v) =>
                set({
                  customFields: body.customFields.map((x, j) =>
                    j === i
                      ? { ...x, defaultValue: v === '' ? null : x.type === 'number' ? Number(v) || 0 : v }
                      : x,
                  ),
                })
              }
            />
            <button
              type="button"
              className="button button-small"
              onClick={() => set({ customFields: body.customFields.filter((_, j) => j !== i) })}
              aria-label={`Remove field ${f.name || i + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
        {body.customFields.length < 20 && (
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              set({
                customFields: [
                  ...body.customFields,
                  { name: '', type: 'text', defaultValue: null, options: [] },
                ],
              })
            }
          >
            Add field
          </button>
        )}
      </fieldset>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ saved views */

function ViewsSection() {
  const toast = useToast();
  const views = useAsync(() => call(getApi().views.list()), []);
  const starters = useAsync(() => call(getApi().views.starters()), []);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const run = async (p: Promise<unknown>, msg?: string) => {
    try {
      const r = await p;
      if (msg && r) toast.success(msg);
      views.reload();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const names = new Set((views.data ?? []).map((v) => v.name.toLowerCase()));
  return (
    <section className="subsection" aria-labelledby="adv-views">
      <h3 id="adv-views">Saved views</h3>
      <p className="muted">
        Save Library filters from the Library page (“Save view”). Pinned views appear on Home.
      </p>
      <ul className="plain-list">
        {(views.data ?? []).map((v, i, all) => (
          <li key={v.id} className="row">
            <span>
              {v.name}
              {v.pinned ? ' · pinned' : ''}
              {v.notices.length > 0 && <span className="field-error"> ⚠ {v.notices.join(' ')}</span>}
            </span>
            <button
              type="button"
              className="button button-small"
              disabled={i === 0}
              onClick={() => void run(call(getApi().views.move({ id: v.id, direction: 'up' })))}
              aria-label={`Move ${v.name} up`}
            >
              ↑
            </button>
            <button
              type="button"
              className="button button-small"
              disabled={i === all.length - 1}
              onClick={() => void run(call(getApi().views.move({ id: v.id, direction: 'down' })))}
              aria-label={`Move ${v.name} down`}
            >
              ↓
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() =>
                void run(
                  call(
                    getApi().views.save({
                      id: v.id,
                      name: v.name,
                      query: v.query,
                      viewMode: v.viewMode,
                      pinned: !v.pinned,
                    }),
                  ),
                )
              }
              aria-label={`${v.pinned ? 'Unpin' : 'Pin'} ${v.name} to Home`}
            >
              {v.pinned ? 'Unpin' : 'Pin to Home'}
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => setRenaming({ id: v.id, name: v.name })}
              aria-label={`Rename ${v.name}`}
            >
              Rename
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => void run(call(getApi().views.duplicate({ id: v.id })), 'Duplicated.')}
              aria-label={`Duplicate ${v.name}`}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => void run(call(getApi().views.exportFile({ id: v.id })), 'Exported.')}
              aria-label={`Export ${v.name}`}
            >
              Export
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => setDeleting({ id: v.id, name: v.name })}
              aria-label={`Delete ${v.name}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button"
        onClick={() => void run(call(getApi().views.importFile()), 'View imported.')}
      >
        Import a view…
      </button>
      {(starters.data ?? []).some((s) => !names.has(s.name.toLowerCase())) && (
        <div className="starters">
          <h4>Suggestions</h4>
          {(starters.data ?? [])
            .filter((s) => !names.has(s.name.toLowerCase()))
            .map((s) => (
              <button
                key={s.name}
                type="button"
                className="button button-small"
                onClick={() =>
                  void run(
                    call(
                      getApi().views.save({
                        id: null,
                        name: s.name,
                        query: { ...DEFAULT_Q, ...s.query },
                        viewMode: s.viewMode,
                        pinned: false,
                      }),
                    ),
                    `Added “${s.name}”.`,
                  )
                }
              >
                Add “{s.name}”
              </button>
            ))}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete view?"
          message={`“${deleting.name}” will be deleted. Your items are not affected.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            void run(call(getApi().views.remove({ id: d.id })), 'View deleted.');
          }}
        />
      )}
      {renaming && (
        <Dialog
          title="Rename view"
          onClose={() => setRenaming(null)}
          size="small"
          footer={
            <button
              type="button"
              className="button button-primary"
              onClick={() => {
                const v = (views.data ?? []).find((x) => x.id === renaming.id);
                setRenaming(null);
                if (v)
                  void run(
                    call(
                      getApi().views.save({
                        id: v.id,
                        name: renaming.name,
                        query: v.query,
                        viewMode: v.viewMode,
                        pinned: v.pinned,
                      }),
                    ),
                    'Renamed.',
                  );
              }}
            >
              Save
            </button>
          }
        >
          <TextField
            label="Name"
            value={renaming.name}
            onChange={(name) => setRenaming({ ...renaming, name })}
            maxLength={80}
          />
        </Dialog>
      )}
    </section>
  );
}

const DEFAULT_Q = {
  text: '',
  types: [],
  statuses: [],
  tags: [],
  tagMode: 'any' as const,
  ratingMin: null,
  ratingMax: null,
  addedFrom: null,
  addedTo: null,
  sort: 'dateAdded' as const,
  direction: 'desc' as const,
  offset: 0,
  limit: 200,
  listId: null,
  upNextOnly: false,
  health: null,
};

/* ------------------------------------------------------------------ artwork + storage */

function ArtworkStorageSection() {
  const app = useApp();
  const toast = useToast();
  const storage = useAsync(() => call(getApi().backdrop.storage()), [app.dataVersion]);
  const [confirm, setConfirm] = useState(false);
  const s = app.settings;
  if (!s) return null;
  return (
    <section className="subsection" aria-labelledby="adv-art">
      <h3 id="adv-art">Images and storage</h3>
      <p className="muted">
        Key-free image sources need no account. Coverage is smaller than TMDB; add a free key in Providers for
        more.
      </p>
      <Toggle
        label="TVmaze (TV posters and backgrounds, CC BY-SA)"
        checked={s.artworkSources.tvmaze}
        onChange={(v) => void app.updateSettings({ artworkSources: { ...s.artworkSources, tvmaze: v } })}
      />
      <Toggle
        label="Wikimedia Commons (freely licensed images only)"
        checked={s.artworkSources.commons}
        onChange={(v) => void app.updateSettings({ artworkSources: { ...s.artworkSources, commons: v } })}
      />
      <p className="muted">
        Unofficial community image services are not offered: their terms do not clearly allow this use.
      </p>
      {storage.data && (
        <dl className="status-grid">
          <dt>Downloaded images</dt>
          <dd>{fmtBytes(storage.data.cacheBytes)}</dd>
          <dt>Images you chose or added (never removed automatically)</dt>
          <dd>{fmtBytes(storage.data.userBytes)}</dd>
          <dt>Can be downloaded again if cleared</dt>
          <dd>{fmtBytes(storage.data.evictableBytes)}</dd>
        </dl>
      )}
      <NumberField
        label="Image cache limit (MB)"
        hint="When exceeded, the least recently fetched downloadable images are removed first."
        value={s.backdrops.cacheCapMb}
        min={100}
        max={20_000}
        onChange={(v) =>
          v &&
          v >= 100 &&
          void app
            .updateSettings({ backdrops: { ...s.backdrops, cacheCapMb: v } })
            .then(() => call(getApi().backdrop.enforceCap()))
            .then(() => storage.reload())
        }
      />
      <button type="button" className="button" onClick={() => setConfirm(true)}>
        Clear cached images
      </button>
      {confirm && (
        <ConfirmDialog
          title="Clear cached images?"
          message="Downloaded images that can be fetched again are removed. Images you picked or added yourself are kept. Your library is not changed."
          confirmLabel="Clear"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void call(getApi().backdrop.clearCache())
              .then((r) => {
                toast.success(`Freed ${fmtBytes(r.freedBytes)}.`);
                storage.reload();
              })
              .catch((e: unknown) => toast.error(errorOf(e)));
          }}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ libraries */

function LibrariesSection() {
  const toast = useToast();
  const libs = useAsync(() => call(getApi().libraries.list()), []);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'switch'; id: string; name: string } | null>(
    null,
  );
  const run = async (p: Promise<unknown>, msg: string) => {
    try {
      await p;
      toast.success(msg);
      libs.reload();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <section className="subsection" aria-labelledby="adv-libs">
      <h3 id="adv-libs">Libraries</h3>
      <p className="muted">
        Separate libraries (for example “Family movies”) each have their own items, images, settings and
        reminders. Switching restarts Maybe Pile. Backups and exports cover the library that is open.
      </p>
      <ul className="plain-list">
        {(libs.data ?? []).map((l) => (
          <li key={l.id} className="row">
            <span>
              {l.name}
              {l.active ? ' (open now)' : ''}
            </span>
            {!l.active && (
              <button
                type="button"
                className="button button-small"
                onClick={() => setConfirm({ kind: 'switch', id: l.id, name: l.name })}
              >
                Switch to
              </button>
            )}
            <button
              type="button"
              className="button button-small"
              onClick={() => void run(call(getApi().libraries.duplicate({ id: l.id })), 'Copy created.')}
              aria-label={`Duplicate ${l.name}`}
            >
              Duplicate
            </button>
            {!l.active && !l.isDefault && (
              <button
                type="button"
                className="button button-small"
                onClick={() => setConfirm({ kind: 'delete', id: l.id, name: l.name })}
                aria-label={`Delete ${l.name}`}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="field-row">
        <TextField label="New library name" value={name} onChange={setName} maxLength={60} />
        <button
          type="button"
          className="button"
          disabled={!name.trim()}
          onClick={() =>
            void run(call(getApi().libraries.create({ name })), 'Library created.').then(() => setName(''))
          }
        >
          Create library
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'delete' ? `Delete “${confirm.name}”?` : `Switch to “${confirm.name}”?`}
          message={
            confirm.kind === 'delete'
              ? 'Its items, images and settings are deleted. A copy of its database is saved in the backups folder first.'
              : 'Maybe Pile restarts and opens that library.'
          }
          confirmLabel={confirm.kind === 'delete' ? 'Delete library' : 'Switch and restart'}
          destructive={confirm.kind === 'delete'}
          typeToConfirm={confirm.kind === 'delete' ? 'DELETE' : undefined}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            if (c.kind === 'delete')
              void run(call(getApi().libraries.remove({ id: c.id })), 'Library deleted.');
            else
              void call(getApi().libraries.switchTo({ id: c.id })).catch((e: unknown) =>
                toast.error(errorOf(e)),
              );
          }}
        />
      )}
    </section>
  );
}

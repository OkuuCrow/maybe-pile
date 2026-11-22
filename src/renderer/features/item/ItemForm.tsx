/**
 * Type-aware item form used for manual add and for editing. Validation uses
 * the same Zod schemas as main (client-side for fast feedback; main validates
 * again). On server errors the form keeps all unsaved input so nothing is lost.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  BOOK_FORMATS,
  CREATOR_ROLES,
  EXTERNAL_ID_KINDS,
  GAME_SCHEMES,
  MEDIA_TYPES,
  ROLES_BY_TYPE,
  ROLE_LABELS,
  SHOW_STATUSES,
  type BookFormat,
  type CreatorRole,
  type ExternalIdKind,
  type GameScheme,
  type MediaType,
  type ShowStatus,
  type Status,
} from '../../../shared/enums';
import {
  ItemCreateSchema,
  MetadataFieldsSchema,
  PersonalFieldsSchema,
  type MetadataFields,
  type PersonalFields,
  type SeasonInput,
} from '../../../shared/schemas';
import type { CustomFieldDefView } from '../../../shared/types';
import type { UserSafeError } from '../../../shared/result';
import { externalIdError } from '../../../domain/links';
import { FIELD_LABELS, releaseDateLabel } from '../../../domain/metadata';
import { planStatusChange } from '../../../domain/status-rules';
import { call, getApi, useAsync } from '../../app/api';
import { todayLocal, typeLabel } from '../../app/strings';
import {
  Checkbox,
  ErrorSummary,
  ListInput,
  NumberField,
  SelectField,
  TextArea,
  TextField,
} from '../../components/Fields';
import { RATING_OPTIONS, STATUS_OPTIONS } from '../../components/Bits';
import { IconTrash } from '../../components/Icons';

export interface ItemFormValue {
  type: MediaType;
  meta: MetadataFields;
  personal: PersonalFields;
  /** Only used when creating: quick season setup (TV) and milestones (games). */
  seasons: { number: number; episodes: number | null }[];
  milestones: string[];
}

export interface ItemFormProps {
  mode: 'create' | 'edit';
  initial: ItemFormValue;
  submitLabel: string;
  busy: boolean;
  serverError: UserSafeError | null;
  onSubmit: (v: ItemFormValue) => void;
  onCancel: () => void;
}

const SHOW_STATUS_LABELS: Record<ShowStatus, string> = {
  returning: 'Returning / airing',
  ended: 'Ended',
  unknown: 'Unknown',
};
const SCHEME_LABELS: Record<GameScheme, string> = {
  percent: 'Percentage complete',
  hours: 'Hours played',
  milestones: 'Milestones / checkpoints',
  text: 'Free-form notes',
};
const FORMAT_LABELS: Record<BookFormat, string> = { print: 'Print', ebook: 'E-book', audiobook: 'Audiobook' };
const EXT_LABELS: Record<ExternalIdKind, string> = {
  tmdb: 'TMDB ID',
  imdb: 'IMDb ID',
  tvmaze: 'TVmaze ID',
  openlibrary: 'Open Library work ID',
  isbn10: 'ISBN-10',
  isbn13: 'ISBN-13',
  igdb: 'IGDB ID',
  steam: 'Steam app ID or store URL',
  xbox: 'Xbox store URL',
  playstation: 'PlayStation Store URL',
};

/** Maps a schema/server path like "meta.title" to the form control id. */
const fieldId = (base: string, path: string) => `${base}-${path.replace(/\./g, '-')}`;

export function toSeasonInputs(seasons: ItemFormValue['seasons']): SeasonInput[] {
  return seasons.map((s) => ({
    number: s.number,
    title: null,
    episodeCountKnown: s.episodes,
    episodes: Array.from({ length: Math.min(s.episodes ?? 0, 500) }, (_, i) => ({
      number: i + 1,
      title: null,
      airDate: null,
      runtime: null,
    })),
  }));
}

export function ItemForm({
  mode,
  initial,
  submitLabel,
  busy,
  serverError,
  onSubmit,
  onCancel,
}: ItemFormProps) {
  const base = useId().replace(/:/g, '');
  const [v, setV] = useState<ItemFormValue>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [submitCount, setSubmitCount] = useState(0);
  const defs = useAsync(() => call(getApi().catalog.customFields()), []);
  const t = v.type;

  const meta = <K extends keyof MetadataFields>(k: K, val: MetadataFields[K]) =>
    setV((s) => ({ ...s, meta: { ...s.meta, [k]: val } }));
  const personal = <K extends keyof PersonalFields>(k: K, val: PersonalFields[K]) =>
    setV((s) => ({ ...s, personal: { ...s.personal, [k]: val } }));

  const onStatus = (status: Status) => {
    // Pre-fill dates the same way the app does on a status change (user can still edit them).
    const plan = planStatusChange(
      {
        type: t,
        status: v.personal.status,
        dateStarted: v.personal.dateStarted,
        dateCompleted: v.personal.dateCompleted,
        pass: 1,
      },
      { status, startNewPass: false, clearDateCompleted: false },
      todayLocal(),
    );
    setV((s) => ({
      ...s,
      personal: { ...s.personal, status, dateStarted: plan.dateStarted, dateCompleted: plan.dateCompleted },
    }));
  };

  const validate = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const m = MetadataFieldsSchema.safeParse(v.meta);
    if (!m.success) for (const i of m.error.issues) out[`meta.${i.path.join('.')}`] ??= i.message;
    const p = PersonalFieldsSchema.safeParse(v.personal);
    if (!p.success) for (const i of p.error.issues) out[`personal.${i.path.join('.')}`] ??= i.message;
    v.meta.externalIds.forEach((e, i) => {
      const msg = e.value ? externalIdError(e) : 'Enter a value or remove this row.';
      if (msg) out[`meta.externalIds.${i}.value`] = msg;
    });
    if (
      v.personal.dateStarted &&
      v.personal.dateCompleted &&
      v.personal.dateCompleted < v.personal.dateStarted
    ) {
      out['personal.dateCompleted'] = 'Completed date cannot be before the start date.';
    }
    if (mode === 'create') {
      const full = ItemCreateSchema.safeParse({
        type: t,
        meta: v.meta,
        personal: v.personal,
        seasons: toSeasonInputs(v.seasons),
        milestones: v.milestones,
        allowDuplicate: false,
      });
      if (!full.success) for (const i of full.error.issues) out[i.path.join('.')] ??= i.message;
    }
    return out;
  };

  const allErrors = useMemo(
    () => ({ ...errors, ...(serverError?.fieldErrors ?? {}) }),
    [errors, serverError],
  );
  const err = (path: string) => (attempted || serverError ? allErrors[path] : undefined);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    setSubmitCount((n) => n + 1);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(v);
  };

  // Ctrl/Cmd+S saves while focus is anywhere inside the form.
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        submitRef.current();
      }
    };
    form.addEventListener('keydown', onKey);
    return () => form.removeEventListener('keydown', onKey);
  }, []);

  const summary = Object.entries(allErrors)
    .filter(() => attempted || serverError)
    .map(([path, message]) => ({
      fieldId: fieldId(base, path),
      message: `${labelForPath(path, t)}: ${message}`,
    }));

  return (
    <form
      ref={formRef}
      className="item-form"
      onSubmit={submit}
      noValidate
      aria-label={mode === 'create' ? 'New item' : 'Edit item'}
    >
      {serverError && !serverError.fieldErrors && (
        <div className="notice notice-error" role="alert">
          <p className="notice-title">{serverError.message}</p>
          {serverError.recovery && <p>{serverError.recovery}</p>}
          <p>Your changes have not been lost — fix the problem and save again.</p>
        </div>
      )}
      {summary.length > 0 && <ErrorSummary errors={summary} focusKey={submitCount} />}

      {mode === 'create' && (
        <fieldset className="form-section">
          <legend>Type</legend>
          <div className="segmented" role="radiogroup" aria-label="Media type">
            {MEDIA_TYPES.map((mt) => (
              <label key={mt} className="radio-pill">
                <input
                  type="radio"
                  name={`${base}-type`}
                  value={mt}
                  checked={t === mt}
                  onChange={() =>
                    setV((s) => ({
                      ...s,
                      type: mt,
                      personal: {
                        ...s.personal,
                        gameScheme: mt === 'game' ? (s.personal.gameScheme ?? 'percent') : null,
                        bookFormat: mt === 'book' ? (s.personal.bookFormat ?? 'print') : null,
                      },
                    }))
                  }
                />
                <span>{typeLabel(mt)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="form-section">
        <legend>Details</legend>
        <TextField
          id={fieldId(base, 'meta.title')}
          label="Title"
          required
          value={v.meta.title}
          onChange={(x) => meta('title', x)}
          error={err('meta.title')}
          maxLength={500}
        />
        <ListInput
          label="Alternate titles"
          values={v.meta.altTitles}
          onChange={(x) => meta('altTitles', x)}
          max={20}
        />
        <TextField
          id={fieldId(base, 'meta.releaseDate')}
          label={releaseDateLabel(t)}
          hint="YYYY, YYYY-MM or YYYY-MM-DD — partial dates are fine."
          value={v.meta.releaseDate ?? ''}
          onChange={(x) => meta('releaseDate', x.trim() === '' ? null : x.trim())}
          error={err('meta.releaseDate')}
        />
        <TextArea
          id={fieldId(base, 'meta.description')}
          label="Description"
          value={v.meta.description ?? ''}
          onChange={(x) => meta('description', x === '' ? null : x)}
          error={err('meta.description')}
          rows={4}
        />
        <ListInput label="Genres" values={v.meta.genres} onChange={(x) => meta('genres', x)} max={50} />
        <CreatorsEditor
          type={t}
          value={v.meta.creators}
          onChange={(x) => meta('creators', x)}
          base={base}
          err={err}
        />
        {t === 'movie' && (
          <div className="form-grid">
            <NumberField
              label="Runtime (minutes)"
              value={v.meta.runtimeMinutes}
              onChange={(x) => meta('runtimeMinutes', x)}
              min={0}
              error={err('meta.runtimeMinutes')}
            />
            <TextField
              label="Original language"
              hint="e.g. en, ja"
              value={v.meta.originalLanguage ?? ''}
              onChange={(x) => meta('originalLanguage', x || null)}
            />
            <TextField
              label="Age rating"
              value={v.meta.ageRating ?? ''}
              onChange={(x) => meta('ageRating', x || null)}
            />
          </div>
        )}
        {t === 'tv' && (
          <div className="form-grid">
            <TextField
              label="Network"
              value={v.meta.network ?? ''}
              onChange={(x) => meta('network', x || null)}
            />
            <SelectField
              label="Show status"
              value={v.meta.showStatus ?? 'unknown'}
              onChange={(x) => meta('showStatus', x)}
              options={SHOW_STATUSES.map((s) => ({ value: s, label: SHOW_STATUS_LABELS[s] }))}
            />
            <NumberField
              label="Episode runtime (minutes)"
              value={v.meta.episodeRuntime}
              onChange={(x) => meta('episodeRuntime', x)}
              min={0}
              error={err('meta.episodeRuntime')}
            />
            <TextField
              label="Last air date"
              hint="Partial dates are fine."
              value={v.meta.lastAirDate ?? ''}
              onChange={(x) => meta('lastAirDate', x.trim() || null)}
              error={err('meta.lastAirDate')}
            />
          </div>
        )}
        {t === 'book' && (
          <div className="form-grid">
            <NumberField
              label="Page count"
              hint="Leave empty if unknown — you can track by percentage."
              value={v.meta.pageCount}
              onChange={(x) => meta('pageCount', x)}
              min={1}
              error={err('meta.pageCount')}
            />
            <NumberField
              label="Audiobook length (minutes)"
              value={v.meta.audioMinutes}
              onChange={(x) => meta('audioMinutes', x)}
              min={0}
              error={err('meta.audioMinutes')}
            />
            <TextField
              label="Publisher"
              value={v.meta.publisher ?? ''}
              onChange={(x) => meta('publisher', x || null)}
            />
            <TextField
              label="ISBN-13"
              value={v.meta.isbn13 ?? ''}
              onChange={(x) => meta('isbn13', x.replace(/[\s-]/g, '') || null)}
              error={err('meta.isbn13')}
            />
            <TextField
              label="ISBN-10"
              value={v.meta.isbn10 ?? ''}
              onChange={(x) => meta('isbn10', x.replace(/[\s-]/g, '') || null)}
              error={err('meta.isbn10')}
            />
          </div>
        )}
        <ExternalIdsEditor
          value={v.meta.externalIds}
          onChange={(x) => meta('externalIds', x)}
          base={base}
          err={err}
        />
      </fieldset>

      {mode === 'create' && t === 'tv' && (
        <fieldset className="form-section">
          <legend>Seasons (optional)</legend>
          <p className="field-hint">Add seasons now or later. Leave the episode count empty if unknown.</p>
          {v.seasons.map((s, i) => (
            <div className="row" key={i}>
              <NumberField
                label={`Season ${i + 1} number`}
                value={s.number}
                onChange={(x) =>
                  setV((st) => ({
                    ...st,
                    seasons: st.seasons.map((y, j) => (j === i ? { ...y, number: x ?? 0 } : y)),
                  }))
                }
                min={0}
              />
              <NumberField
                label="Episodes"
                value={s.episodes}
                onChange={(x) =>
                  setV((st) => ({
                    ...st,
                    seasons: st.seasons.map((y, j) => (j === i ? { ...y, episodes: x } : y)),
                  }))
                }
                min={0}
                max={500}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove season row ${i + 1}`}
                onClick={() => setV((st) => ({ ...st, seasons: st.seasons.filter((_, j) => j !== i) }))}
              >
                <IconTrash />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              setV((st) => ({
                ...st,
                seasons: [...st.seasons, { number: (st.seasons.at(-1)?.number ?? 0) + 1, episodes: null }],
              }))
            }
          >
            Add season
          </button>
          {err('seasons') && <p className="field-error">{err('seasons')}</p>}
        </fieldset>
      )}

      {t === 'game' && (
        <fieldset className="form-section">
          <legend>Game</legend>
          <SelectField
            label="Progress scheme"
            hint="How you want to track this game. You can switch later without losing history."
            value={v.personal.gameScheme ?? 'percent'}
            onChange={(x) => personal('gameScheme', x)}
            options={GAME_SCHEMES.map((s) => ({ value: s, label: SCHEME_LABELS[s] }))}
          />
          {mode === 'create' && v.personal.gameScheme === 'milestones' && (
            <ListInput
              label="Milestones (in order)"
              values={v.milestones}
              onChange={(x) => setV((s) => ({ ...s, milestones: x }))}
              max={200}
            />
          )}
          <PlatformsEditor value={v.personal.platforms} onChange={(x) => personal('platforms', x)} />
        </fieldset>
      )}

      <fieldset className="form-section">
        <legend>Your tracking</legend>
        <div className="form-grid">
          <SelectField
            label="Status"
            value={v.personal.status}
            onChange={onStatus}
            options={STATUS_OPTIONS}
          />
          <SelectField
            label="Rating"
            value={v.personal.rating === null ? '' : String(v.personal.rating)}
            onChange={(x) => personal('rating', x === '' ? null : Number(x))}
            options={RATING_OPTIONS}
          />
          {t === 'book' && (
            <SelectField
              label="Format"
              value={v.personal.bookFormat ?? 'print'}
              onChange={(x) => personal('bookFormat', x)}
              options={BOOK_FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f] }))}
            />
          )}
          <TextField
            id={fieldId(base, 'personal.dateAdded')}
            type="date"
            label="Date added"
            value={v.personal.dateAdded}
            onChange={(x) => personal('dateAdded', x)}
            error={err('personal.dateAdded')}
            required
          />
          <TextField
            id={fieldId(base, 'personal.dateStarted')}
            type="date"
            label="Date started"
            value={v.personal.dateStarted ?? ''}
            onChange={(x) => personal('dateStarted', x || null)}
            error={err('personal.dateStarted')}
          />
          <TextField
            id={fieldId(base, 'personal.dateCompleted')}
            type="date"
            label="Date completed"
            value={v.personal.dateCompleted ?? ''}
            onChange={(x) => personal('dateCompleted', x || null)}
            error={err('personal.dateCompleted')}
          />
        </div>
        <ListInput
          label="Tags"
          values={v.personal.tags}
          onChange={(x) => personal('tags', x)}
          placeholder="e.g. cozy, with friends"
          hint="Press Enter or Add. Tags are matched without regard to case."
          max={100}
        />
        <TextArea
          label="Notes"
          hint="Plain text. Only you can see this; it never leaves your computer unless you export it."
          value={v.personal.notes}
          onChange={(x) => personal('notes', x)}
          rows={5}
        />
        {defs.data && defs.data.length > 0 && (
          <CustomFieldsEditor
            defs={defs.data}
            value={v.personal.customFields}
            onChange={(x) => personal('customFields', x)}
            err={err}
          />
        )}
      </fieldset>

      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function labelForPath(path: string, type: MediaType): string {
  const [scope, field] = path.split('.');
  if (scope === 'meta' && field)
    return field === 'releaseDate'
      ? releaseDateLabel(type)
      : (FIELD_LABELS[field as keyof typeof FIELD_LABELS] ?? field);
  const personalLabels: Record<string, string> = {
    dateAdded: 'Date added',
    dateStarted: 'Date started',
    dateCompleted: 'Date completed',
    tags: 'Tags',
    notes: 'Notes',
    rating: 'Rating',
    customFields: 'Custom fields',
  };
  return personalLabels[field ?? ''] ?? field ?? path;
}

function CreatorsEditor({
  type,
  value,
  onChange,
  base,
  err,
}: {
  type: MediaType;
  value: MetadataFields['creators'];
  onChange: (v: MetadataFields['creators']) => void;
  base: string;
  err: (p: string) => string | undefined;
}) {
  const roles = [...ROLES_BY_TYPE[type], ...CREATOR_ROLES.filter((r) => !ROLES_BY_TYPE[type].includes(r))];
  return (
    <fieldset className="subsection">
      <legend>Creators</legend>
      {value.map((c, i) => (
        <div className="row" key={i}>
          <TextField
            id={fieldId(base, `meta.creators.${i}.name`)}
            label={`Creator ${i + 1} name`}
            value={c.name}
            onChange={(x) => onChange(value.map((y, j) => (j === i ? { ...y, name: x } : y)))}
            error={err(`meta.creators.${i}.name`)}
          />
          <SelectField
            label="Role"
            value={c.role}
            onChange={(x: CreatorRole) => onChange(value.map((y, j) => (j === i ? { ...y, role: x } : y)))}
            options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove creator ${c.name || i + 1}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <IconTrash />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button button-small"
        onClick={() => onChange([...value, { name: '', role: ROLES_BY_TYPE[type][0] ?? 'creator' }])}
      >
        Add creator
      </button>
    </fieldset>
  );
}

function ExternalIdsEditor({
  value,
  onChange,
  base,
  err,
}: {
  value: MetadataFields['externalIds'];
  onChange: (v: MetadataFields['externalIds']) => void;
  base: string;
  err: (p: string) => string | undefined;
}) {
  const used = new Set(value.map((e) => e.kind));
  return (
    <fieldset className="subsection">
      <legend>External IDs & store links</legend>
      <p className="field-hint">
        Used for links (IMDb, stores) and duplicate detection. Only exact IDs/official URLs are used — nothing
        is guessed.
      </p>
      {value.map((e, i) => (
        <div className="row" key={i}>
          <SelectField
            label="Kind"
            value={e.kind}
            onChange={(x: ExternalIdKind) => onChange(value.map((y, j) => (j === i ? { ...y, kind: x } : y)))}
            options={EXTERNAL_ID_KINDS.filter((k) => k === e.kind || !used.has(k)).map((k) => ({
              value: k,
              label: EXT_LABELS[k],
            }))}
          />
          <TextField
            id={fieldId(base, `meta.externalIds.${i}.value`)}
            label="Value"
            value={e.value}
            onChange={(x) => onChange(value.map((y, j) => (j === i ? { ...y, value: x.trim() } : y)))}
            error={err(`meta.externalIds.${i}.value`)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${EXT_LABELS[e.kind]}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <IconTrash />
          </button>
        </div>
      ))}
      {used.size < EXTERNAL_ID_KINDS.length && (
        <button
          type="button"
          className="button button-small"
          onClick={() =>
            onChange([...value, { kind: EXTERNAL_ID_KINDS.find((k) => !used.has(k)) ?? 'imdb', value: '' }])
          }
        >
          Add ID or link
        </button>
      )}
    </fieldset>
  );
}

function PlatformsEditor({
  value,
  onChange,
}: {
  value: PersonalFields['platforms'];
  onChange: (v: PersonalFields['platforms']) => void;
}) {
  const [draft, setDraft] = useState('');
  const id = useId();
  return (
    <fieldset className="subsection">
      <legend>Platforms</legend>
      {value.map((p, i) => (
        <div className="row" key={i}>
          <span className="platform-name">{p.name}</span>
          <Checkbox
            label="Owned"
            checked={p.owned}
            onChange={(x) => onChange(value.map((y, j) => (j === i ? { ...y, owned: x } : y)))}
          />
          <Checkbox
            label="Played"
            checked={p.played}
            onChange={(x) => onChange(value.map((y, j) => (j === i ? { ...y, played: x } : y)))}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove platform ${p.name}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <IconTrash />
          </button>
        </div>
      ))}
      <div className="row">
        <label htmlFor={id}>Add platform</label>
        <input
          id={id}
          className="input input-inline"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. PC, Switch"
        />
        <button
          type="button"
          className="button button-small"
          disabled={!draft.trim()}
          onClick={() => {
            onChange([...value, { name: draft.trim().slice(0, 80), owned: true, played: false }]);
            setDraft('');
          }}
        >
          Add
        </button>
      </div>
    </fieldset>
  );
}

function CustomFieldsEditor({
  defs,
  value,
  onChange,
  err,
}: {
  defs: CustomFieldDefView[];
  value: PersonalFields['customFields'];
  onChange: (v: PersonalFields['customFields']) => void;
  err: (p: string) => string | undefined;
}) {
  const get = (defId: string) => value.find((c) => c.defId === defId)?.value ?? null;
  const set = (defId: string, v: string | number | boolean | null) =>
    onChange([
      ...value.filter((c) => c.defId !== defId),
      ...(v === null || v === '' ? [] : [{ defId, value: v }]),
    ]);
  return (
    <fieldset className="subsection">
      <legend>Custom fields</legend>
      <div className="form-grid">
        {defs.map((d) => {
          const idx = value.findIndex((c) => c.defId === d.id);
          const e = idx >= 0 ? err(`personal.customFields.${idx}.value`) : undefined;
          const cur = get(d.id);
          switch (d.type) {
            case 'number':
              return (
                <NumberField
                  key={d.id}
                  label={d.name}
                  value={typeof cur === 'number' ? cur : null}
                  onChange={(x) => set(d.id, x)}
                  error={e}
                  step={0.01}
                />
              );
            case 'boolean':
              return (
                <Checkbox
                  key={d.id}
                  label={d.name}
                  checked={cur === true}
                  onChange={(x) => set(d.id, x ? true : null)}
                />
              );
            case 'date':
              return (
                <TextField
                  key={d.id}
                  type="date"
                  label={d.name}
                  value={typeof cur === 'string' ? cur : ''}
                  onChange={(x) => set(d.id, x || null)}
                  error={e}
                />
              );
            case 'select':
              return (
                <SelectField
                  key={d.id}
                  label={d.name}
                  value={typeof cur === 'string' ? cur : ''}
                  onChange={(x) => set(d.id, x || null)}
                  options={[{ value: '', label: '—' }, ...d.options.map((o) => ({ value: o, label: o }))]}
                  error={e}
                />
              );
            default:
              return (
                <TextField
                  key={d.id}
                  label={d.name}
                  value={typeof cur === 'string' ? cur : ''}
                  onChange={(x) => set(d.id, x || null)}
                  error={e}
                />
              );
          }
        })}
      </div>
    </fieldset>
  );
}

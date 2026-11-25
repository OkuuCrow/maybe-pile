/**
 * Settings for Expansion Pack 2: anime (title language, adult content,
 * audio, source order), artwork (auto slots, per-type priority), spoilers,
 * Pile Value currency, sessions, Leaving Soon, recommendations, moods and
 * services. Each control saves on change.
 */
import { useState } from 'react';
import {
  ARTWORK_SLOTS,
  ARTWORK_SLOT_LABELS,
  MEDIA_TYPES,
  MOOD_COLORS,
  MOOD_ICONS,
  SERVICE_KINDS,
  type ArtworkSlot,
  type MediaType,
  type MoodColor,
  type MoodIcon,
  type ServiceKind,
} from '../../../shared/enums';
import type { SettingsPatch } from '../../../shared/schemas';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ErrorBox, Loading } from '../../components/Bits';
import { Checkbox, NumberField, SelectField, TextField } from '../../components/Fields';

const PROVIDER_NAMES: Record<string, string> = {
  kitsu: 'Kitsu',
  mal: 'MyAnimeList (official)',
  tmdb: 'TMDB',
  anilist: 'AniList',
  jikan: 'Jikan (unofficial)',
  fanart: 'fanart.tv',
  steamgriddb: 'SteamGridDB',
  tvmaze: 'TVmaze',
  igdb: 'IGDB',
  openlibrary: 'Open Library',
};

function OrderList({
  ids,
  onChange,
  label,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  label: string;
}) {
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const c = [...ids];
    const a = c[i];
    const b = c[j];
    if (a === undefined || b === undefined) return;
    c[i] = b;
    c[j] = a;
    onChange(c);
  };
  return (
    <ol className="order-list" aria-label={label}>
      {ids.map((id, i) => (
        <li key={id} className="row">
          <span>
            {i + 1}. {PROVIDER_NAMES[id] ?? id}
          </span>
          <button
            type="button"
            className="button button-small"
            aria-label={`Move ${PROVIDER_NAMES[id] ?? id} up`}
            disabled={i === 0}
            onClick={() => move(i, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="button button-small"
            aria-label={`Move ${PROVIDER_NAMES[id] ?? id} down`}
            disabled={i === ids.length - 1}
            onClick={() => move(i, 1)}
          >
            ↓
          </button>
        </li>
      ))}
    </ol>
  );
}

export function Pack2Settings() {
  const app = useApp();
  const toast = useToast();
  const s = app.settings;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState(s?.value.currency ?? 'USD');
  const [artType, setArtType] = useState<MediaType>('movie');
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
  const a = s.anime;
  return (
    <div className="features-settings">
      <section className="subsection" aria-labelledby="p2-anime">
        <h3 id="p2-anime">Anime</h3>
        <SelectField
          label="Show titles in"
          hint="Applied when you add anime. Other titles are kept as alternative titles."
          value={a.titleLanguage}
          onChange={(v) => void save({ anime: { ...a, titleLanguage: v } }, 'anime')}
          options={[
            { value: 'romaji', label: 'Romaji (e.g. Sousou no Frieren)' },
            { value: 'english', label: 'English (e.g. Frieren: Beyond Journey’s End)' },
            { value: 'native', label: 'Native script (e.g. 葬送のフリーレン)' },
          ]}
        />
        <SelectField
          label="Default audio preference"
          value={a.audioPref}
          onChange={(v) => void save({ anime: { ...a, audioPref: v } }, 'anime')}
          options={[
            { value: 'both', label: 'Either' },
            { value: 'sub', label: 'Subtitles' },
            { value: 'dub', label: 'Dub' },
          ]}
        />
        <Checkbox
          label="Show adult titles in search"
          hint="Off by default. Adult titles are never shown unless you turn this on."
          checked={a.showAdult}
          onChange={(v) => void save({ anime: { ...a, showAdult: v } }, 'anime')}
        />
        <Checkbox
          label="Blur adult artwork until I choose to show it"
          checked={a.blurAdultArt}
          onChange={(v) => void save({ anime: { ...a, blurAdultArt: v } }, 'anime')}
        />
        <p className="field-hint">
          Source order for “All sources” anime search (earlier sources win when the same show appears twice).
          Turn sources on or off in Settings → Providers.
        </p>
        <OrderList
          label="Anime source order"
          ids={a.providerOrder}
          onChange={(ids) => void save({ anime: { ...a, providerOrder: ids } }, 'anime')}
        />
        <p className="field-hint">
          Manga isn’t a separate type: add manga and light novels as Books (AniList can fill in details if you
          enable it).
        </p>
      </section>

      <section className="subsection" aria-labelledby="p2-art">
        <h3 id="p2-art">Artwork</h3>
        <fieldset>
          <legend>
            Slots filled by “Auto-pick artwork” (Library bulk action). Imports use the source’s own cover and
            banner.
          </legend>
          {ARTWORK_SLOTS.map((slot: ArtworkSlot) => (
            <Checkbox
              key={slot}
              label={ARTWORK_SLOT_LABELS[slot]}
              checked={s.artwork.autoSlots.includes(slot)}
              onChange={(v) =>
                void save(
                  {
                    artwork: {
                      ...s.artwork,
                      autoSlots: v
                        ? [...new Set([...s.artwork.autoSlots, slot])]
                        : s.artwork.autoSlots.filter((x) => x !== slot),
                    },
                  },
                  'artwork',
                )
              }
            />
          ))}
        </fieldset>
        <p className="field-hint">
          Your own choices are never replaced automatically. Use “Revert to automatic” on an item to allow it
          again.
        </p>
        <SelectField
          label="Source priority for"
          value={artType}
          onChange={setArtType}
          options={MEDIA_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))}
        />
        <OrderList
          label={`Artwork source priority for ${typeLabel(artType)}`}
          ids={s.artwork.priority[artType] ?? []}
          onChange={(ids) =>
            void save(
              { artwork: { ...s.artwork, priority: { ...s.artwork.priority, [artType]: ids } } },
              'artwork',
            )
          }
        />
        {errors['artwork'] && <p className="error-text">{errors['artwork']}</p>}
      </section>

      <section className="subsection" aria-labelledby="p2-spoilers">
        <h3 id="p2-spoilers">Spoiler Shield</h3>
        <Checkbox
          label="Shield unfinished items by default"
          hint="Hides titles of episodes after your next one. Each item can override this."
          checked={s.spoilers.shieldByDefault}
          onChange={(v) => void save({ spoilers: { ...s.spoilers, shieldByDefault: v } }, 'spoilers')}
        />
        <Checkbox
          label="Treat notes as spoilers by default"
          checked={s.spoilers.shieldNotes}
          onChange={(v) => void save({ spoilers: { ...s.spoilers, shieldNotes: v } }, 'spoilers')}
        />
      </section>

      <section className="subsection" aria-labelledby="p2-value">
        <h3 id="p2-value">Pile Value</h3>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ value: { currency: currency.trim().toUpperCase() } }, 'currency');
          }}
        >
          <TextField
            label="Default currency"
            hint="Three-letter code such as USD, EUR, JPY. Amounts are never converted between currencies."
            value={currency}
            onChange={setCurrency}
            error={errors['currency'] || undefined}
          />
          <button type="submit" className="button button-small">
            Save currency
          </button>
        </form>
      </section>

      <section className="subsection" aria-labelledby="p2-sessions">
        <h3 id="p2-sessions">Sessions</h3>
        <NumberField
          label="Flag sessions longer than (hours)"
          hint="A timer left running overnight is flagged for you to correct when you stop it."
          value={s.sessions.maxSessionHours}
          error={errors['sessions'] || undefined}
          onChange={(v) =>
            v !== null &&
            v >= 1 &&
            v <= 48 &&
            void save({ sessions: { maxSessionHours: Math.round(v) } }, 'sessions')
          }
        />
      </section>

      <section className="subsection" aria-labelledby="p2-leaving">
        <h3 id="p2-leaving">Leaving Soon</h3>
        <NumberField
          label="Warn this many days before access ends"
          value={s.availability.leavingSoonDays}
          onChange={(v) =>
            v !== null &&
            v >= 1 &&
            v <= 90 &&
            void save({ availability: { ...s.availability, leavingSoonDays: Math.round(v) } }, 'availability')
          }
        />
        <Checkbox
          label="Desktop notification when something is leaving soon"
          checked={s.availability.notifications}
          onChange={(v) =>
            void save({ availability: { ...s.availability, notifications: v } }, 'availability')
          }
        />
      </section>

      <section className="subsection" aria-labelledby="p2-recs">
        <h3 id="p2-recs">Recommendations</h3>
        <Checkbox
          label="Show “From your pile” suggestions"
          hint="Computed on this computer from your own ratings and library."
          checked={s.recommendations.enabled}
          onChange={(v) => void save({ recommendations: { enabled: v } }, 'recs')}
        />
        <button
          type="button"
          className="button button-small"
          onClick={() =>
            void call(getApi().recs.clearFeedback())
              .then((r) => toast.success(`Reset ${r.cleared} hidden suggestion(s).`))
              .catch((e: unknown) => toast.error(errorOf(e)))
          }
        >
          Reset “Not now” and “Not interested”
        </button>
      </section>

      <MoodsSettings />
      <ServicesSettings />
    </div>
  );
}

function MoodsSettings() {
  const toast = useToast();
  const q = useAsync(() => call(getApi().moods.list()), []);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<MoodIcon>('star');
  const [color, setColor] = useState<MoodColor>('blue');
  const run = (p: Promise<unknown>) => void p.catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <section className="subsection" aria-labelledby="p2-moods">
      <h3 id="p2-moods">Moods</h3>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      <ul className="plain-list">
        {(q.data ?? []).map((m) => (
          <li key={m.id} className="row wrap">
            <span>
              {m.name}{' '}
              <span className="muted">
                ({m.itemCount} item(s){m.builtin ? ', built-in' : ''})
              </span>
            </span>
            <Checkbox
              label="Hidden"
              checked={m.hidden}
              onChange={(v) => run(call(getApi().moods.update({ id: m.id, hidden: v })).then(q.setData))}
            />
            {!m.builtin && (
              <button
                type="button"
                className="button button-small"
                aria-label={`Delete mood ${m.name}`}
                onClick={() => run(call(getApi().moods.remove({ id: m.id })).then(q.setData))}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          run(call(getApi().moods.create({ name, icon, color })).then((r) => (q.setData(r), setName(''))));
        }}
      >
        <TextField label="New mood" value={name} onChange={setName} />
        <SelectField
          label="Icon"
          value={icon}
          onChange={setIcon}
          options={MOOD_ICONS.map((i) => ({ value: i, label: i }))}
        />
        <SelectField
          label="Color"
          value={color}
          onChange={setColor}
          options={MOOD_COLORS.map((c) => ({ value: c, label: c }))}
        />
        <button type="submit" className="button button-small" disabled={!name.trim()}>
          Add mood
        </button>
      </form>
    </section>
  );
}

function ServicesSettings() {
  const toast = useToast();
  const q = useAsync(() => call(getApi().availability.services()), []);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ServiceKind>('subscription');
  const run = (p: Promise<unknown>) => void p.catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <section className="subsection" aria-labelledby="p2-services">
      <h3 id="p2-services">Services and stores</h3>
      <p className="field-hint">
        Used for ownership, subscriptions and Leaving Soon. Turn a subscription off when you cancel it.
      </p>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      <ul className="plain-list">
        {(q.data ?? []).map((sv) => (
          <li key={sv.id} className="row wrap">
            <span>
              {sv.name}{' '}
              <span className="muted">
                ({sv.kind}, {sv.entryCount} item(s))
              </span>
            </span>
            <Checkbox
              label="Active"
              checked={sv.active}
              onChange={(v) =>
                run(call(getApi().availability.updateService({ id: sv.id, active: v })).then(q.setData))
              }
            />
            <button
              type="button"
              className="button button-small"
              aria-label={`Delete service ${sv.name}`}
              onClick={() => run(call(getApi().availability.removeService({ id: sv.id })).then(q.setData))}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            call(getApi().availability.addService({ name, kind })).then((r) => (q.setData(r), setName(''))),
          );
        }}
      >
        <TextField label="Service name" value={name} onChange={setName} />
        <SelectField
          label="Kind"
          value={kind}
          onChange={setKind}
          options={SERVICE_KINDS.map((k) => ({ value: k, label: k }))}
        />
        <button type="submit" className="button button-small" disabled={!name.trim()}>
          Add service
        </button>
      </form>
    </section>
  );
}

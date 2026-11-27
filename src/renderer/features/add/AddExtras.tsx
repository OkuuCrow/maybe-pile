/**
 * Add-flow extras: §14.6 Paste a list (core; text only — OCR not shipped) and
 * §14.5 Start from template (Full mode).
 */
import { useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { MatchedLineView, PasteParseView, TemplateView } from '../../../shared/views-21';
import { defaultPersonal, emptyMeta } from '../../../domain/metadata';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { todayLocal, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ErrorBox } from '../../components/Bits';
import { SelectField, TextArea, TextField } from '../../components/Fields';

type Decision = {
  action: 'match' | 'manual' | 'skip';
  candidate: number | null;
  type: MediaType;
  title: string;
};

export function PasteList({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [text, setText] = useState('');
  const [defaultType, setDefaultType] = useState<MediaType | ''>('');
  const [parsed, setParsed] = useState<PasteParseView | null>(null);
  const [lines, setLines] = useState<MatchedLineView[]>([]);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const parse = async () => {
    setBusy(true);
    try {
      const r = await call(getApi().paste.parse({ text, defaultType: defaultType || null }));
      setParsed(r);
      setLines(r.lines);
      setDecisions(
        Object.fromEntries(
          r.lines.map((l) => [
            l.lineId,
            {
              action: l.duplicateOf || l.repeatOfLine !== null ? 'skip' : 'manual',
              candidate: null,
              type: l.type ?? 'movie',
              title: l.title,
            },
          ]),
        ),
      );
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  /** Sequential lookups in small batches; the main-process limiter paces requests. */
  const lookUp = async () => {
    if (!parsed) return;
    setBusy(true);
    const ids = lines.filter((l) => l.repeatOfLine === null && !l.duplicateOf).map((l) => l.lineId);
    try {
      for (let i = 0; i < ids.length; i += 5) {
        setProgress(`Looking up ${Math.min(i + 5, ids.length)} of ${ids.length}…`);
        const r = await call(getApi().paste.match({ token: parsed.token, lineIds: ids.slice(i, i + 5) }));
        setLines(r);
        setDecisions((d) => {
          const next = { ...d };
          for (const l of r) {
            const cur = next[l.lineId];
            if (cur && cur.action !== 'skip' && l.candidates.length > 0 && cur.candidate === null)
              next[l.lineId] = {
                ...cur,
                action: l.candidates[0]?.confidence === 'low' ? 'manual' : 'match',
                candidate: 0,
              };
          }
          return next;
        });
      }
      setProgress('Done. Check the matches, then import.');
    } catch (e) {
      toast.error(errorOf(e));
      setProgress('');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const r = await call(
        getApi().paste.apply({
          token: parsed.token,
          status: 'planned',
          decisions: Object.entries(decisions).map(([id, d]) => ({ lineId: Number(id), ...d })),
        }),
      );
      app.bumpData();
      toast.success(
        `Added ${r.added}, skipped ${r.skipped}${r.failed ? `, ${r.failed} failed` : ''}. Undo it any time from Import history.`,
      );
      onDone();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (id: number, p: Partial<Decision>) =>
    setDecisions((d) => {
      const cur = d[id];
      return cur ? { ...d, [id]: { ...cur, ...p } } : d;
    });

  if (!parsed)
    return (
      <div className="paste-list">
        <TextArea
          label="Paste a list (one title per line)"
          hint="Hints like “Dune 2021 (movie)” or “Hades [game]” help. Nothing is added until you confirm."
          value={text}
          onChange={setText}
          rows={8}
          maxLength={100_000}
        />
        <SelectField
          label="Type for lines without a hint"
          value={defaultType}
          onChange={setDefaultType}
          options={[
            { value: '', label: 'Ask me per line' },
            ...MEDIA_TYPES.map((t) => ({ value: t, label: typeLabel(t) })),
          ]}
        />
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !text.trim()}
          onClick={() => void parse()}
        >
          Review list
        </button>
      </div>
    );

  const toAdd = Object.values(decisions).filter((d) => d.action !== 'skip').length;
  return (
    <div className="paste-list">
      <p role="status" aria-live="polite">
        {lines.length} line(s). {progress}
      </p>
      <div className="button-row">
        <button type="button" className="button" onClick={() => void lookUp()} disabled={busy}>
          Look up online
        </button>
        <button type="button" className="button" onClick={() => setParsed(null)} disabled={busy}>
          Edit the list
        </button>
      </div>
      <table className="table review-table">
        <caption className="visually-hidden">Review pasted lines</caption>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Type</th>
            <th scope="col">Match</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const d = decisions[l.lineId];
            if (!d) return null;
            return (
              <tr key={l.lineId}>
                <td>
                  <TextField
                    label={`Title, line ${l.lineId + 1}`}
                    value={d.title}
                    onChange={(v) => set(l.lineId, { title: v })}
                    maxLength={500}
                  />
                  {l.year && <span className="muted">{l.year} · </span>}
                  {l.duplicateOf && <span className="badge">Already in your library</span>}
                  {l.repeatOfLine !== null && (
                    <span className="badge">Repeats line {l.repeatOfLine + 1}</span>
                  )}
                  {l.error && <span className="muted"> {l.error}</span>}
                </td>
                <td>
                  <SelectField
                    label={`Type, line ${l.lineId + 1}`}
                    value={d.type}
                    onChange={(v) => set(l.lineId, { type: v })}
                    options={MEDIA_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))}
                  />
                </td>
                <td>
                  {l.candidates.length === 0 ? (
                    <span className="muted">
                      {l.status === 'pending' ? '—' : l.status === 'no-match' ? 'No match' : (l.error ?? '—')}
                    </span>
                  ) : (
                    <SelectField
                      label={`Match, line ${l.lineId + 1}`}
                      value={d.candidate === null ? '' : String(d.candidate)}
                      onChange={(v) =>
                        set(
                          l.lineId,
                          v === ''
                            ? { candidate: null, action: 'manual' }
                            : { candidate: Number(v), action: 'match' },
                        )
                      }
                      options={[
                        { value: '', label: 'No match — add title only' },
                        ...l.candidates.map((c, i) => ({
                          value: String(i),
                          label: `${c.title}${c.year ? ` (${c.year})` : ''} · ${c.confidence} confidence`,
                        })),
                      ]}
                    />
                  )}
                </td>
                <td>
                  <SelectField
                    label={`Action, line ${l.lineId + 1}`}
                    value={d.action}
                    onChange={(v) =>
                      set(l.lineId, {
                        action: v,
                        candidate: v === 'match' ? (d.candidate ?? 0) : d.candidate,
                      })
                    }
                    options={[
                      ...(l.candidates.length ? [{ value: 'match' as const, label: 'Import match' }] : []),
                      { value: 'manual' as const, label: 'Add title only' },
                      { value: 'skip' as const, label: 'Skip' },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button
        type="button"
        className="button button-primary"
        disabled={busy || toAdd === 0}
        onClick={() => void apply()}
      >
        Import {toAdd} item(s) as Planned
      </button>
    </div>
  );
}

export function FromTemplate({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const toast = useToast();
  const templates = useAsync(() => call(getApi().templates.list()), []);
  const [chosen, setChosen] = useState<TemplateView | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!chosen) return;
    const b = chosen.body;
    try {
      const defs = await call(getApi().catalog.customFields());
      const values: { defId: string; value: string | number | boolean | null }[] = [];
      for (const f of b.customFields) {
        let def = defs.find((d) => d.name.toLowerCase() === f.name.toLowerCase() && d.type === f.type);
        if (!def) {
          const all = await call(
            getApi().catalog.saveCustomField({ id: null, name: f.name, type: f.type, options: f.options }),
          );
          def = all.find((d) => d.name.toLowerCase() === f.name.toLowerCase());
        }
        const ok =
          f.defaultValue === null ||
          (f.type === 'number'
            ? typeof f.defaultValue === 'number'
            : f.type === 'boolean'
              ? typeof f.defaultValue === 'boolean'
              : typeof f.defaultValue === 'string');
        if (def && ok && f.defaultValue !== null) values.push({ defId: def.id, value: f.defaultValue });
      }
      const personal = {
        ...defaultPersonal(b.type, todayLocal()),
        status: b.status,
        tags: b.tags,
        customFields: values,
        ...(b.type === 'game' && b.platform
          ? { platforms: [{ name: b.platform, owned: true, played: false }] }
          : {}),
      };
      const r = await call(
        getApi().items.create({
          type: b.type,
          meta: emptyMeta(title.trim()),
          personal,
          seasons: [],
          milestones: [],
          allowDuplicate: true,
        }),
      );
      if (r.kind !== 'created') return;
      for (const text of b.checklist)
        await call(getApi().extras.checklist({ op: 'add', itemId: r.item.id, text }));
      if (b.moodIds.length)
        await call(getApi().moods.setForItem({ itemId: r.item.id, moodIds: b.moodIds })).catch(
          () => undefined,
        );
      if (b.listId)
        await call(
          getApi().lists.setMembership({ listId: b.listId, itemIds: [r.item.id], member: true }),
        ).catch(() => undefined);
      app.bumpData();
      toast.success(`Added ${r.item.meta.title} from “${chosen.name}”.`);
      onDone();
      app.navigate({ name: 'item', id: r.item.id });
    } catch (e) {
      setError(errorOf(e).message);
    }
  };
  if ((templates.data ?? []).length === 0)
    return (
      <p className="muted">
        No templates yet. Create one in <a href="#/settings/advanced">Settings → Advanced</a>.
      </p>
    );
  return (
    <div>
      {error && <ErrorBox error={{ code: 'VALIDATION', message: error }} />}
      <SelectField
        label="Template"
        value={chosen?.id ?? ''}
        onChange={(v) => setChosen((templates.data ?? []).find((t) => t.id === v) ?? null)}
        options={[
          { value: '', label: 'Choose…' },
          ...(templates.data ?? []).map((t) => ({
            value: t.id,
            label: `${t.name} (${typeLabel(t.body.type)})`,
          })),
        ]}
      />
      {chosen && (
        <>
          <TextField label="Title" value={title} onChange={setTitle} maxLength={500} required />
          <button
            type="button"
            className="button button-primary"
            disabled={!title.trim()}
            onClick={() => void create()}
          >
            Add from template
          </button>
        </>
      )}
    </div>
  );
}

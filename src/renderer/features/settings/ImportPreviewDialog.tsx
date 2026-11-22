/**
 * Preview for JSON/CSV import (merge) and full-backup restore (replace).
 * Nothing changes until the user confirms; cancelling discards the staged data.
 */
import { useId, useState } from 'react';
import { MEDIA_TYPES } from '../../../shared/enums';
import type { CountsView, ImportPreviewView, ImportResultView } from '../../../shared/types';
import { call, errorOf, getApi } from '../../app/api';
import { typeLabelPlural } from '../../app/strings';
import { Dialog } from '../../components/Dialog';
import { ErrorBox } from '../../components/Bits';
import type { UserSafeError } from '../../../shared/result';

type Resolution = 'skip' | 'duplicate' | 'update';
const RES_LABELS: Record<Resolution, string> = {
  skip: 'Skip (keep mine)',
  duplicate: 'Keep both',
  update: 'Update from file (only if newer)',
};

function CountsTable({
  current,
  incoming,
  mode,
}: {
  current: CountsView;
  incoming: CountsView;
  mode: 'merge' | 'replace';
}) {
  const rows: [string, number, number][] = [
    ...MEDIA_TYPES.map((t): [string, number, number] => [
      typeLabelPlural(t),
      current.items[t],
      incoming.items[t],
    ]),
    ['Episodes', current.episodes, incoming.episodes],
    ['Progress entries', current.progressEntries, incoming.progressEntries],
    ['Viewings', current.viewings, incoming.viewings],
    ['Tags', current.tags, incoming.tags],
    ['Custom themes', current.themes, incoming.themes],
    ['Artwork files', current.artwork, incoming.artwork],
  ];
  return (
    <table className="table">
      <caption>
        {mode === 'replace'
          ? 'Your library now vs. the backup that will replace it'
          : 'Your library and what the file contains'}
      </caption>
      <thead>
        <tr>
          <th scope="col">What</th>
          <th scope="col">Your library now</th>
          <th scope="col">{mode === 'replace' ? 'After restore' : 'In the file'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, a, b]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>{a}</td>
            <td>{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ImportPreviewDialog({
  preview,
  onClose,
  onApplied,
}: {
  preview: ImportPreviewView;
  onClose: () => void;
  onApplied: (r: ImportResultView) => void;
}) {
  const id = useId();
  const [def, setDef] = useState<Resolution>('skip');
  const [per, setPer] = useState<Record<string, Resolution>>({});
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserSafeError | null>(null);
  const errors = preview.messages.filter((m) => m.severity === 'error');
  const warnings = preview.messages.filter((m) => m.severity === 'warning');
  const needsWord = preview.confirmationWord !== null;
  const canApply = preview.canApply && !busy && (!needsWord || typed === preview.confirmationWord);

  const cancel = () => {
    if (preview.token)
      void call(getApi().data.importCancel({ kind: preview.kind, token: preview.token })).catch(
        () => undefined,
      );
    onClose();
  };
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call(
        getApi().data.importApply({
          kind: preview.kind,
          token: preview.token,
          defaultResolution: def,
          resolutions: per,
          confirmation: typed,
        }),
      );
      onApplied(r);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={
        preview.mode === 'replace'
          ? 'Restore backup — review before replacing'
          : 'Import — review before merging'
      }
      onClose={cancel}
      size="large"
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button" onClick={cancel} disabled={busy}>
            Cancel — change nothing
          </button>
          {preview.canApply && (
            <button
              type="button"
              className={`button ${preview.mode === 'replace' ? 'button-danger' : 'button-primary'}`}
              disabled={!canApply}
              onClick={() => void apply()}
            >
              {busy ? 'Working…' : preview.mode === 'replace' ? 'Replace my library' : 'Import'}
            </button>
          )}
        </>
      }
    >
      <p>
        <strong>File:</strong> {preview.fileLabel} · <strong>Format:</strong> {preview.formatVersion}
      </p>
      <p className={preview.mode === 'replace' ? 'notice notice-warning' : undefined}>{preview.summary}</p>
      {errors.length > 0 && (
        <div className="notice notice-error" role="alert">
          <div className="notice-content">
            <p className="notice-title">{errors.length} problem(s) found — nothing will be imported:</p>
            <ul>
              {errors.slice(0, 50).map((m, i) => (
                <li key={i}>
                  <code>{m.path}</code>: {m.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((m, i) => (
            <li key={i}>⚠ {m.message}</li>
          ))}
        </ul>
      )}
      <CountsTable current={preview.current} incoming={preview.incoming} mode={preview.mode} />
      {preview.conflicts.length > 0 && (
        <>
          <h3>Conflicts ({preview.conflicts.length})</h3>
          <div className="field field-inline">
            <label htmlFor={`${id}-def`}>For all conflicts</label>
            <select
              id={`${id}-def`}
              className="input input-inline"
              value={def}
              onChange={(e) => setDef(e.target.value as Resolution)}
            >
              {(Object.keys(RES_LABELS) as Resolution[]).map((r) => (
                <option key={r} value={r}>
                  {RES_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <table className="table">
            <caption className="visually-hidden">Conflicts</caption>
            <thead>
              <tr>
                <th scope="col">In file</th>
                <th scope="col">In your library</th>
                <th scope="col">Why</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {preview.conflicts.slice(0, 500).map((c) => (
                <tr key={c.id}>
                  <td>{c.importedTitle}</td>
                  <td>{c.existingTitle}</td>
                  <td>
                    {c.reason === 'local-id'
                      ? 'Same item'
                      : c.reason === 'provider-id'
                        ? 'Same online ID'
                        : 'Same title, year, type'}
                    {c.importIsNewer === false && (
                      <span className="muted block">Your copy is newer — it will be kept</span>
                    )}
                  </td>
                  <td>
                    <label className="visually-hidden" htmlFor={`${id}-${c.id}`}>
                      Action for {c.importedTitle}
                    </label>
                    <select
                      id={`${id}-${c.id}`}
                      className="input input-inline"
                      value={per[c.id] ?? def}
                      onChange={(e) => setPer((p) => ({ ...p, [c.id]: e.target.value as Resolution }))}
                    >
                      {(Object.keys(RES_LABELS) as Resolution[]).map((r) => (
                        <option key={r} value={r}>
                          {RES_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {needsWord && preview.canApply && (
        <div className="field">
          <label htmlFor={`${id}-confirm`}>
            Type <strong>{preview.confirmationWord}</strong> to replace your current library
          </label>
          <input
            id={`${id}-confirm`}
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      {error && <ErrorBox error={error} />}
    </Dialog>
  );
}

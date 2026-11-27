/** Backup & restore additions: destination check (§14.7), Check my library (§16.2), Recently deleted link. */
import { useState } from 'react';
import type { CheckupReportView } from '../../../shared/views-21';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtDateTime } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog } from '../../components/Dialog';
import { Loading, Notice } from '../../components/Bits';

export function BackupDestination() {
  const app = useApp();
  const check = useAsync(() => call(getApi().backupCheck.current()), [app.info?.backupLocationLabel]);
  if (check.loading && !check.data) return null;
  const c = check.data;
  if (!c || c.warnings.length === 0)
    return <p className="muted">Backup folder: {c?.folderLabel ?? '—'}. No problems found.</p>;
  return (
    <Notice kind="warning">
      <p>
        <strong>About your backup folder ({c.folderLabel}):</strong>
      </p>
      <ul>
        {c.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <p className="muted">You can choose another folder above, or keep using this one.</p>
    </Notice>
  );
}

export function CheckupPanel() {
  const toast = useToast();
  const app = useApp();
  const [report, setReport] = useState<CheckupReportView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setReport(await call(getApi().checkup.run()));
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  const fix = async (ids: string[]) => {
    setConfirm(null);
    setBusy(true);
    try {
      const r = await call(getApi().checkup.fix({ fixes: ids as never }));
      toast.success(
        `Fixed ${r.applied.length} problem type(s). A copy of your library was saved first (${r.snapshot}).`,
      );
      app.bumpData();
      setReport(await call(getApi().checkup.run()));
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  const safe = report?.findings.filter((f) => f.fix?.safe).flatMap((f) => (f.fix ? [f.fix.id] : [])) ?? [];
  const label = app.level === 'simple' ? 'Check my library' : 'Library check-up';
  return (
    <section className="subsection" aria-labelledby="chk-h">
      <h3 id="chk-h">{label}</h3>
      <p className="muted">
        Looks for problems. It only reads; nothing changes unless you choose a fix (a copy is saved first).
      </p>
      <div className="button-row">
        <button type="button" className="button" onClick={() => void run()} disabled={busy}>
          {busy ? 'Checking…' : label}
        </button>
        {report && (
          <button
            type="button"
            className="button"
            onClick={() =>
              void call(getApi().checkup.exportReport()).then(
                (r) => r && toast.success(`Saved ${r.fileLabel}.`),
              )
            }
          >
            Save report (no titles)
          </button>
        )}
      </div>
      <div role="status" aria-live="polite">
        {busy && !report && <Loading label="Checking…" />}
        {report && (
          <>
            <p>
              Checked {fmtDateTime(report.ranAt)}:{' '}
              {report.findings.length === 0 ? 'no problems found.' : `${report.findings.length} finding(s).`}
            </p>
            <ul className="findings">
              {report.findings.map((f) => (
                <li key={f.code} className={`finding finding-${f.severity}`}>
                  <span className="finding-sev">
                    {f.severity === 'error' ? '⛔ Problem' : f.severity === 'warning' ? '⚠ Check' : 'ℹ Note'}
                  </span>{' '}
                  <strong>{f.title}</strong> ({f.count})<br />
                  <span className="muted">{f.explanation}</span>
                  {f.fix && (
                    <div>
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => f.fix && setConfirm([f.fix.id])}
                        disabled={busy}
                      >
                        {f.fix.label}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {safe.length > 1 && (
              <button type="button" className="button" onClick={() => setConfirm(safe)} disabled={busy}>
                Fix all safe issues ({safe.length})
              </button>
            )}
          </>
        )}
      </div>
      {confirm && report && (
        <ConfirmDialog
          title="Apply these fixes?"
          message={
            <>
              <ul>
                {report.findings
                  .filter((f) => f.fix && confirm.includes(f.fix.id))
                  .map((f) => (
                    <li key={f.code}>{f.fix?.preview}</li>
                  ))}
              </ul>
              <p>A copy of your library is saved before anything changes.</p>
            </>
          }
          confirmLabel="Apply"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void fix(confirm)}
        />
      )}
      <p>
        <a href="#/trash">Recently deleted…</a>
      </p>
    </section>
  );
}

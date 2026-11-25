/**
 * Completion heatmap (calendar grid) with an always-available table view,
 * plus a local share card (PNG drawn on a canvas in the renderer, validated
 * and saved by main; nothing is uploaded).
 *
 * Accessibility: each day cell has a text label (date + count); intensity is
 * shown by color AND by a pattern of dots for 1/2/3+ so it is not color-only;
 * the table toggle presents the same data as rows.
 */
import { useMemo, useState } from 'react';
import type { MediaType } from '../../../shared/enums';
import type { HeatmapView, StatsView } from '../../../shared/types';
import { typeLabel } from '../../app/strings';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { ErrorBox, Loading } from '../../components/Bits';

const DAY_MS = 86_400_000;

function daysOfYear(year: number): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(year, 0, 1); t <= Date.UTC(year, 11, 31); t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const level = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3);
const LEVEL_TEXT = ['none', 'one', 'two', 'three or more'];

export function HeatmapCard({ year }: { year: number }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().stats.heatmap({ year })), [year, app.dataVersion]);
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card" aria-labelledby="heatmap-h">
      <div className="row wrap">
        <h2 id="heatmap-h">Completions in {year}</h2>
        <button
          type="button"
          className="button button-small"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? 'Show calendar' : 'Show as table'}
        </button>
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!q.data && !q.error && <Loading />}
      {q.data && (asTable ? <HeatmapTable data={q.data} /> : <HeatmapGrid data={q.data} />)}
    </section>
  );
}

function HeatmapGrid({ data }: { data: HeatmapView }) {
  const by = useMemo(() => new Map(data.days.map((d) => [d.date, d])), [data]);
  const days = daysOfYear(data.year);
  const firstDow = new Date(`${data.year}-01-01T00:00:00Z`).getUTCDay();
  const cells: (string | null)[] = [...Array<null>(firstDow).fill(null), ...days];
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return (
    <>
      <p className="muted small">
        {data.total} completion(s) — including rewatches and replays. Busiest day: {data.maxPerDay}.
      </p>
      <div className="heatmap" role="grid" aria-label={`Completions per day in ${data.year}`}>
        {weeks.map((w, wi) => (
          <div className="heatmap-week" role="row" key={wi}>
            {w.map((d, di) => {
              if (!d)
                return (
                  <span key={di} className="heatmap-cell heatmap-pad" role="gridcell" aria-hidden="true" />
                );
              const e = by.get(d);
              const n = e?.count ?? 0;
              const label = `${d}: ${n} completion${n === 1 ? '' : 's'}${e ? ` — ${e.titles.join(', ')}` : ''}`;
              return (
                <span
                  key={d}
                  role="gridcell"
                  className={`heatmap-cell heatmap-l${level(n)}`}
                  aria-label={label}
                  title={label}
                  tabIndex={n > 0 ? 0 : -1}
                >
                  <span aria-hidden="true">{n >= 3 ? '•••' : n === 2 ? '••' : n === 1 ? '•' : ''}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <p className="muted small" aria-hidden="true">
        Legend: {LEVEL_TEXT.map((t, i) => `${['·', '•', '••', '•••'][i]} ${t}`).join(' · ')}
      </p>
    </>
  );
}

function HeatmapTable({ data }: { data: HeatmapView }) {
  if (data.days.length === 0) return <p className="muted">No completions recorded in {data.year}.</p>;
  return (
    <table className="table">
      <caption>Days with completions in {data.year}</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Completions</th>
          <th scope="col">Titles</th>
        </tr>
      </thead>
      <tbody>
        {data.days.map((d) => (
          <tr key={d.date}>
            <th scope="row">{d.date}</th>
            <td>{d.count}</td>
            <td>{d.titles.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------------------------------------------------------- share card */

/** Draws a 1200×630 card from stats already on screen. Pure canvas; no network, no external fonts/images. */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  s: { year: number; completed: number; top: string[]; byType: [string, number][] },
): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  canvas.width = 1200;
  canvas.height = 630;
  ctx.fillStyle = '#1d2433';
  ctx.fillRect(0, 0, 1200, 630);
  ctx.fillStyle = '#f5f1e8';
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.fillText(`My ${s.year} in Maybe Pile`, 72, 140);
  ctx.font = '40px system-ui, sans-serif';
  ctx.fillText(`${s.completed} finished`, 72, 230);
  ctx.font = '30px system-ui, sans-serif';
  let y = 370;
  for (const [t, n] of s.byType) {
    ctx.fillText(`${t}: ${n}`, 72, y);
    y += 44;
  }
  if (s.top.length) {
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText('Favorites', 640, 230);
    ctx.font = '28px system-ui, sans-serif';
    s.top
      .slice(0, 5)
      .forEach((t, i) =>
        ctx.fillText(`${i + 1}. ${t.length > 34 ? `${t.slice(0, 33)}…` : t}`, 640, 280 + i * 44),
      );
  }
  ctx.fillStyle = '#9fb0c8';
  ctx.font = '22px system-ui, sans-serif';
  ctx.fillText('Made locally with Maybe Pile', 72, 590);
  return true;
}

export function ShareCardButton({ year, stats }: { year: number; stats: StatsView | null }) {
  // `stats` gates the button until the page has data; the card itself uses Year in Review.
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!stats) return;
    setBusy(true);
    try {
      const yr = await call(getApi().stats.yearInReview({ year }));
      const canvas = document.createElement('canvas');
      const ok = drawShareCard(canvas, {
        year,
        completed: yr.finished,
        top: yr.favorites.map((f) => f.title),
        byType: (Object.entries(yr.finishedByType) as [MediaType, number][])
          .filter(([, n]) => n > 0)
          .map(([t, n]) => [typeLabel(t), n] as [string, number]),
      });
      if (!ok) throw new Error('Canvas unavailable');
      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const r = await call(getApi().share.saveCard({ name: `year-${year}`, pngBase64: b64 }));
      if (r) toast.success(`Saved ${r.fileLabel}.`);
    } catch (e) {
      toast.error(
        e instanceof Error && e.message === 'Canvas unavailable'
          ? 'Share cards need image drawing, which is unavailable here.'
          : errorOf(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="button" disabled={busy || !stats} onClick={() => void save()}>
      Save share card…
    </button>
  );
}

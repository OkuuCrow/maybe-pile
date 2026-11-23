/**
 * Accessible bar charts for Stats / Pile Health.
 *
 * - The SVG is a labelled image (`role="img"` + a text summary); every bar
 *   carries its number as a visible label, so values never depend on color.
 * - Series use fill patterns (solid / stripes / dots / cross-hatch) in addition
 *   to color, and the legend repeats the pattern swatch with text.
 * - "Show data table" reveals the exact numbers in a real <table>.
 * - Export: CSV of the same numbers, and PNG captured by the main process.
 * No animation is used.
 */
import { useId, useRef, useState } from 'react';
import { call, errorOf, getApi } from '../app/api';
import { useToast } from '../app/toast';

export interface Series {
  key: string;
  label: string;
}

export interface BarDatum {
  label: string;
  values: Record<string, number>;
}

const PATTERNS = ['solid', 'stripes', 'dots', 'cross'] as const;
const SERIES_VARS = [
  'var(--mp-accent)',
  'var(--mp-status-completed)',
  'var(--mp-status-on-hold)',
  'var(--mp-status-in-progress)',
];

export type ChartExportId =
  | 'completedByMonth'
  | 'completedByYear'
  | 'avgRatingByType'
  | 'topGenres'
  | 'topCreators'
  | 'timeToComplete'
  | 'episodesByMonth';

export function BarChart({
  title,
  summary,
  data,
  series,
  exportId,
  year,
  valueFormat = (n) => String(n),
  headingLevel = 3,
}: {
  title: string;
  /** One-sentence text alternative describing the chart. */
  summary: string;
  data: BarDatum[];
  series: Series[];
  /** When set, CSV and PNG export buttons are shown. */
  exportId?: ChartExportId;
  year?: number | null;
  valueFormat?: (n: number) => string;
  headingLevel?: 2 | 3;
}) {
  const uid = useId().replace(/:/g, '');
  const [table, setTable] = useState(false);
  const figRef = useRef<HTMLElement>(null);
  const toast = useToast();
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const max = Math.max(1, ...data.map((d) => series.reduce((n, s) => n + (d.values[s.key] ?? 0), 0)));
  const barW = 28;
  const gap = 14;
  const height = 160;
  const width = Math.max(240, data.length * (barW + gap) + gap);

  const exportCsv = async () => {
    if (!exportId) return;
    try {
      const r = await call(getApi().stats.exportCsv({ chart: exportId, year: year ?? null }));
      if (r) toast.success(`Saved ${r.fileLabel}.`);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const exportPng = async () => {
    const el = figRef.current;
    if (!el || !exportId) return;
    const b = el.getBoundingClientRect();
    try {
      const r = await call(
        getApi().stats.saveImage({
          name: `${exportId.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}${year ? `-${year}` : ''}`.slice(
            0,
            40,
          ),
          rect: {
            x: Math.max(0, Math.floor(b.left)),
            y: Math.max(0, Math.floor(b.top)),
            width: Math.max(1, Math.ceil(b.width)),
            height: Math.max(1, Math.ceil(b.height)),
          },
        }),
      );
      if (r) toast.success(`Saved ${r.fileLabel}.`);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };

  return (
    <figure className="chart" ref={figRef} aria-labelledby={`${uid}-t`}>
      <H id={`${uid}-t`} className="chart-title">
        {title}
      </H>
      {data.length === 0 ? (
        <p className="muted">No data yet.</p>
      ) : (
        <>
          <div className="chart-scroll">
            <svg
              role="img"
              aria-labelledby={`${uid}-t ${uid}-d`}
              width={width}
              height={height + 40}
              viewBox={`0 0 ${width} ${height + 40}`}
              className="chart-svg"
            >
              <desc id={`${uid}-d`}>{summary}</desc>
              <defs>
                {series.map((s, i) => {
                  const color = SERIES_VARS[i % SERIES_VARS.length];
                  const pat = PATTERNS[i % PATTERNS.length];
                  return (
                    <pattern
                      key={s.key}
                      id={`${uid}-p${i}`}
                      width="6"
                      height="6"
                      patternUnits="userSpaceOnUse"
                    >
                      <rect width="6" height="6" fill={pat === 'solid' ? color : 'var(--mp-surface)'} />
                      {pat === 'stripes' && <path d="M0 6 L6 0" stroke={color} strokeWidth="2.2" />}
                      {pat === 'dots' && <circle cx="3" cy="3" r="1.6" fill={color} />}
                      {pat === 'cross' && <path d="M0 0 L6 6 M6 0 L0 6" stroke={color} strokeWidth="1.4" />}
                    </pattern>
                  );
                })}
              </defs>
              {data.map((d, i) => {
                const x = gap + i * (barW + gap);
                let y = height;
                const total = series.reduce((n, s) => n + (d.values[s.key] ?? 0), 0);
                return (
                  <g key={d.label}>
                    <title>{`${d.label}: ${series
                      .map((s) => `${s.label} ${valueFormat(d.values[s.key] ?? 0)}`)
                      .join(', ')}`}</title>
                    {series.map((s, si) => {
                      const v = d.values[s.key] ?? 0;
                      if (v <= 0) return null;
                      const h = (v / max) * (height - 18);
                      y -= h;
                      return (
                        <rect
                          key={s.key}
                          x={x}
                          y={y}
                          width={barW}
                          height={h}
                          fill={`url(#${uid}-p${si})`}
                          stroke="var(--mp-text)"
                          strokeWidth="0.8"
                        />
                      );
                    })}
                    <text x={x + barW / 2} y={y - 4} textAnchor="middle" className="chart-value">
                      {valueFormat(total)}
                    </text>
                    <text x={x + barW / 2} y={height + 14} textAnchor="middle" className="chart-label">
                      {d.label.length > 7 ? `${d.label.slice(0, 7)}` : d.label}
                    </text>
                  </g>
                );
              })}
              <line x1={gap / 2} x2={width - gap / 2} y1={height} y2={height} stroke="var(--mp-border)" />
            </svg>
          </div>
          {series.length > 1 && (
            <ul className="chart-legend" aria-label="Legend">
              {series.map((s, i) => (
                <li key={s.key}>
                  <svg width="14" height="14" aria-hidden="true">
                    <rect
                      width="14"
                      height="14"
                      fill={`url(#${uid}-p${i})`}
                      stroke="var(--mp-text)"
                      strokeWidth="0.8"
                    />
                  </svg>
                  {s.label}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="row wrap chart-actions">
        <button
          type="button"
          className="button button-small"
          aria-expanded={table}
          aria-controls={`${uid}-table`}
          onClick={() => setTable((t) => !t)}
          disabled={data.length === 0}
        >
          {table ? 'Hide data table' : 'Show data table'}
        </button>
        {exportId && (
          <>
            <button
              type="button"
              className="button button-small"
              onClick={() => void exportCsv()}
              disabled={data.length === 0}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => void exportPng()}
              disabled={data.length === 0}
            >
              Save as image
            </button>
          </>
        )}
      </div>
      {table && data.length > 0 && (
        <table className="table" id={`${uid}-table`}>
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Label</th>
              {series.map((s) => (
                <th scope="col" key={s.key}>
                  {s.label}
                </th>
              ))}
              {series.length > 1 && <th scope="col">Total</th>}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label}>
                <th scope="row">{d.label}</th>
                {series.map((s) => (
                  <td key={s.key}>{valueFormat(d.values[s.key] ?? 0)}</td>
                ))}
                {series.length > 1 && (
                  <td>{valueFormat(series.reduce((n, s) => n + (d.values[s.key] ?? 0), 0))}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}

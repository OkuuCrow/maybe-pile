/**
 * Stats & Year in Review — local only, computed from real history. Every chart
 * has a text summary, a data table, CSV export and PNG export. Missing data is
 * stated plainly instead of guessed.
 */
import { useState } from 'react';
import { MEDIA_TYPES, TYPE_LABELS_PLURAL } from '../../../shared/enums';
import type { StatsView, YearInReviewView } from '../../../shared/types';
import { call, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtNumber, typeLabelPlural } from '../../app/strings';
import { BarChart } from '../../components/Charts';
import { EmptyState, ErrorBox, Loading, RatingDisplay } from '../../components/Bits';
import { TypeIcon } from '../../components/Icons';

const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y ?? 2000, (mo ?? 1) - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
    year: '2-digit',
  });
};
const typeSeries = MEDIA_TYPES.map((t) => ({ key: t, label: TYPE_LABELS_PLURAL[t] }));

export function StatsPage() {
  const app = useApp();
  const [year, setYear] = useState<number | null>(null);
  const [tab, setTab] = useState<'stats' | 'review'>('stats');
  const q = useAsync(() => call(getApi().stats.get({ year })), [year, app.dataVersion]);
  const years = q.data?.years ?? [];
  const reviewYear = year ?? years[0] ?? new Date().getFullYear();
  return (
    <div className="page">
      <div className="page-header">
        <h1>Stats</h1>
        <div className="row wrap">
          <label htmlFor="stats-year">Year</label>
          <select
            id="stats-year"
            className="input input-inline"
            value={year === null ? '' : String(year)}
            onChange={(e) => setYear(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All time</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="segmented" role="group" aria-label="Stats view">
        <button
          type="button"
          className="button"
          aria-pressed={tab === 'stats'}
          onClick={() => setTab('stats')}
        >
          Charts
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={tab === 'review'}
          onClick={() => setTab('review')}
        >
          Year in Review
        </button>
      </div>
      <p className="muted">
        Everything here is calculated on this computer from your own history. Nothing is uploaded.
      </p>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {tab === 'stats' && q.data && <StatsCharts s={q.data} />}
      {tab === 'review' && (
        <>
          <h2 className="visually-hidden">Year in Review {reviewYear}</h2>
          <YearInReview year={reviewYear} />
        </>
      )}
    </div>
  );
}

function StatsCharts({ s }: { s: StatsView }) {
  if (s.completedTotal === 0 && s.episodesByMonth.length === 0)
    return (
      <EmptyState title={s.year ? `Nothing finished in ${s.year}` : 'No finished items yet'}>
        Stats are built from completion dates and progress you record. Mark something Completed to see it
        here.
      </EmptyState>
    );
  const rated = s.avgRatingByType.filter((r) => r.completed > 0);
  return (
    <div className="stats-grid">
      <section className="card">
        <BarChart
          title={s.year ? `Completed per month in ${s.year}` : 'Completed per month'}
          summary={`${s.completedTotal} items completed across ${s.completedByMonth.length} month(s).`}
          data={s.completedByMonth.map((m) => ({ label: monthLabel(m.month), values: m.byType }))}
          series={typeSeries}
          exportId="completedByMonth"
          year={s.year}
          headingLevel={2}
        />
      </section>
      {!s.year && (
        <section className="card">
          <BarChart
            title="Completed per year"
            summary={s.completedByYear.map((y) => `${y.year}: ${y.total}`).join(', ')}
            data={s.completedByYear.map((y) => ({ label: String(y.year), values: y.byType }))}
            series={typeSeries}
            exportId="completedByYear"
            headingLevel={2}
          />
        </section>
      )}
      <section className="card">
        <h2>Average rating by type</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Average</th>
              <th scope="col">Rated / completed</th>
            </tr>
          </thead>
          <tbody>
            {rated.map((r) => (
              <tr key={r.type}>
                <th scope="row">
                  <TypeIcon type={r.type} /> {typeLabelPlural(r.type)}
                </th>
                <td>
                  {r.average === null ? 'No ratings' : <RatingDisplay rating={Math.round(r.average)} />}
                </td>
                <td>
                  {r.rated} of {r.completed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rated.some((r) => r.rated < r.completed) && (
          <p className="muted">
            {rated.reduce((n, r) => n + (r.completed - r.rated), 0)} of your{' '}
            {rated.reduce((n, r) => n + r.completed, 0)} finished items had no rating and are not in the
            averages.
          </p>
        )}
      </section>
      <section className="card">
        <BarChart
          title="Top genres among completed"
          summary={
            s.topGenres
              .slice(0, 3)
              .map((g) => `${g.name} ${g.count}`)
              .join(', ') || 'No genres recorded.'
          }
          data={s.topGenres.map((g) => ({ label: g.name, values: { n: g.count } }))}
          series={[{ key: 'n', label: 'Completed' }]}
          exportId="topGenres"
          year={s.year}
          headingLevel={2}
        />
      </section>
      <section className="card">
        <BarChart
          title="Top creators among completed"
          summary={
            s.topCreators
              .slice(0, 3)
              .map((g) => `${g.name} ${g.count}`)
              .join(', ') || 'No creators recorded.'
          }
          data={s.topCreators.map((g) => ({ label: g.name, values: { n: g.count } }))}
          series={[{ key: 'n', label: 'Completed' }]}
          exportId="topCreators"
          year={s.year}
          headingLevel={2}
        />
      </section>
      <section className="card">
        <BarChart
          title="Time from start to finish"
          summary={`${s.timeToComplete.map((b) => `${b.bucket}: ${b.count}`).join(', ')}.`}
          data={s.timeToComplete.map((b) => ({ label: b.bucket, values: { n: b.count } }))}
          series={[{ key: 'n', label: 'Items' }]}
          exportId="timeToComplete"
          year={s.year}
          headingLevel={2}
        />
        {s.timeToCompleteUnknown > 0 && (
          <p className="muted">
            {s.timeToCompleteUnknown} finished item(s) have no start date and are not shown.
          </p>
        )}
      </section>
      <section className="card">
        <BarChart
          title="Episodes watched per month"
          summary={`${s.episodesByMonth.reduce((n, m) => n + m.count, 0)} episodes over ${s.episodesByMonth.length} month(s).`}
          data={s.episodesByMonth.map((m) => ({ label: monthLabel(m.month), values: { n: m.count } }))}
          series={[{ key: 'n', label: 'Episodes' }]}
          exportId="episodesByMonth"
          year={s.year}
          headingLevel={2}
        />
      </section>
      <section className="card">
        <h2>Totals</h2>
        <dl className="year-stats">
          <div>
            <dt>Pages read (finished books)</dt>
            <dd>{fmtNumber(s.pages.total)}</dd>
          </div>
          <div>
            <dt>Game hours (tracked)</dt>
            <dd>{fmtNumber(s.gameHours.total)}</dd>
          </div>
        </dl>
        {s.pages.booksWithoutPages > 0 && (
          <p className="muted">{s.pages.booksWithoutPages} finished book(s) have no page count.</p>
        )}
        <p className="muted">
          Game hours count only games tracked by hours ({s.gameHours.gamesTracked} game(s)).
        </p>
        {s.streaks && (
          <p>
            Activity streak: <strong>{s.streaks.current}</strong> week(s) in a row (longest{' '}
            {s.streaks.longest}).
          </p>
        )}
      </section>
    </div>
  );
}

function YearInReview({ year }: { year: number }) {
  const app = useApp();
  const q = useAsync<YearInReviewView>(
    () => call(getApi().stats.yearInReview({ year })),
    [year, app.dataVersion],
  );
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const y = q.data;
  if (y.finished === 0)
    return (
      <EmptyState title={`Nothing finished in ${year} yet`}>
        Year in Review fills in as you complete things. Pick another year above.
      </EmptyState>
    );
  return (
    <div className="stats-grid" aria-live="polite">
      <section className="card">
        <h2>{year} at a glance</h2>
        <p className="big-number">
          {y.finished} <span className="muted">finished</span>
        </p>
        <ul className="status-counts">
          {MEDIA_TYPES.map((t) => (
            <li key={t}>
              <TypeIcon type={t} /> {typeLabelPlural(t)}: <strong>{y.finishedByType[t]}</strong>
            </li>
          ))}
        </ul>
        {y.busiestMonth && (
          <p>
            Busiest month: <strong>{monthLabel(y.busiestMonth.month)}</strong> ({y.busiestMonth.count}{' '}
            finished)
          </p>
        )}
      </section>
      <section className="card">
        <h2>Favorites</h2>
        {y.favorites.length === 0 ? (
          <p className="muted">None of this year's finished items have a rating.</p>
        ) : (
          <ol className="mini-list">
            {y.favorites.map((f) => (
              <li key={f.id}>
                <a href={`#/item/${f.id}`}>
                  <TypeIcon type={f.type} /> <span className="mini-title">{f.title}</span>
                </a>
                <RatingDisplay rating={f.rating} />
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="card">
        <h2>Longest finished</h2>
        <ul className="plain-list">
          <li>
            Book: {y.longestBook ? <a href={`#/item/${y.longestBook.id}`}>{y.longestBook.title}</a> : '—'}{' '}
            {y.longestBook && `(${fmtNumber(y.longestBook.pages)} pages)`}
          </li>
          <li>
            Game: {y.longestGame ? <a href={`#/item/${y.longestGame.id}`}>{y.longestGame.title}</a> : '—'}{' '}
            {y.longestGame && `(${y.longestGame.hours} hours)`}
          </li>
          <li>
            Show: {y.longestShow ? <a href={`#/item/${y.longestShow.id}`}>{y.longestShow.title}</a> : '—'}{' '}
            {y.longestShow && `(${y.longestShow.episodes} episodes)`}
          </li>
        </ul>
      </section>
      <section className="card">
        <h2>Most-used tags</h2>
        {y.topTags.length === 0 ? (
          <p className="muted">No tags on this year's finished items.</p>
        ) : (
          <ul className="chip-list">
            {y.topTags.map((t) => (
              <li key={t.name} className="chip">
                {t.name} <span className="muted">({t.count})</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>About the data</h2>
        <ul className="plain-list">
          <li>
            {y.missing.unrated} of your {y.finished} finished items had no rating.
          </li>
          <li>{y.missing.noStartDate} had no start date.</li>
          {y.missing.booksWithoutPages > 0 && (
            <li>{y.missing.booksWithoutPages} book(s) had no page count.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

export function StatsSummaryWidget({ headingId }: { headingId: string }) {
  const app = useApp();
  const year = new Date().getFullYear();
  const q = useAsync(() => call(getApi().stats.get({ year })), [app.dataVersion]);
  return (
    <>
      <h2 id={headingId}>Stats summary</h2>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <p>
            <strong>{q.data.completedTotal}</strong> finished in {year} ·{' '}
            <strong>{fmtNumber(q.data.pages.total)}</strong> pages ·{' '}
            <strong>{q.data.episodesByMonth.reduce((n, m) => n + m.count, 0)}</strong> episodes
          </p>
          <a href="#/stats">All stats &amp; Year in Review</a>
        </>
      )}
    </>
  );
}

import type { ReactNode } from 'react';
import { MEDIA_TYPES, STATUSES } from '../../../shared/enums';
import type { DashboardData, ItemSummary } from '../../../shared/types';
import { DEFAULT_LAYOUTS } from '../../../domain/layouts';
import { call, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { S, fmtPartialDate, statusLabel, typeLabelPlural } from '../../app/strings';
import { Cover, EmptyState, ErrorBox, Loading, ProgressBar, StatusBadge } from '../../components/Bits';
import { TypeIcon } from '../../components/Icons';
import { UpNextWidget, YearStatsWidget } from './Widgets';
import { PickPanel } from '../pick/PickPage';
import { HealthWidget } from '../health/HealthPage';
import { GoalsWidget } from '../goals/GoalsPage';
import { UpcomingWidget } from '../radar/UpcomingPage';
import { ListsWidget } from '../lists/ListsPage';
import { StatsSummaryWidget } from '../stats/StatsPage';

export function Dashboard() {
  const app = useApp();
  const q = useAsync(() => call(getApi().items.dashboard()), [app.dataVersion]);
  const layout = app.layouts?.dashboard ?? DEFAULT_LAYOUTS.dashboard;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{S.dashboard.title}</h1>
        <a className="button" href="#/settings/layout">
          {S.dashboard.customize}
        </a>
      </div>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.total === 0 && (
        <EmptyState
          title={S.dashboard.emptyTitle}
          action={
            <button
              type="button"
              className="button button-primary"
              onClick={() => app.openAdd()}
              disabled={app.info?.readOnly}
            >
              {S.dashboard.emptyAction}
            </button>
          }
        >
          {S.dashboard.emptyBody}
        </EmptyState>
      )}
      {q.data && q.data.total > 0 && (
        <div className="dashboard-grid">
          {layout
            .filter((c) => c.visible)
            .map((c) => (
              <section
                key={c.id}
                className={`card dashboard-card span-${c.span}`}
                aria-labelledby={`dash-${c.id}`}
              >
                {renderWidget(c.id, q.data as DashboardData)}
              </section>
            ))}
        </div>
      )}
    </div>
  );
}

function renderWidget(id: string, d: DashboardData): ReactNode {
  switch (id) {
    case 'counts':
      return (
        <>
          <h2 id="dash-counts">{S.dashboard.counts}</h2>
          <div className="stat-row">
            {MEDIA_TYPES.map((t) => (
              <a key={t} className="stat" href="#/library" onClick={() => setLibraryHint({ types: [t] })}>
                <TypeIcon type={t} size={20} />
                <span className="stat-value">{d.countsByType[t]}</span>
                <span className="stat-label">{typeLabelPlural(t)}</span>
              </a>
            ))}
          </div>
          <ul className="status-counts">
            {STATUSES.map((s) => (
              <li key={s}>
                <StatusBadge status={s} /> <strong>{d.countsByStatus[s]}</strong>
                <span className="visually-hidden"> items {statusLabel(s)}</span>
              </li>
            ))}
          </ul>
        </>
      );
    case 'continue':
      return (
        <>
          <h2 id="dash-continue">{S.dashboard.continue}</h2>
          {d.continueItems.length === 0 ? (
            <p className="muted">{S.dashboard.continueEmpty}</p>
          ) : (
            <ul className="continue-list">
              {d.continueItems.map((i) => (
                <li key={i.id}>
                  <a className="continue-item" href={`#/item/${i.id}`}>
                    <Cover url={i.thumbUrl} title={i.title} type={i.type} size="small" />
                    <span className="continue-text">
                      <span className="continue-title">{i.title}</span>
                      <span className="muted">{i.nextAction ?? i.progressLabel}</span>
                      <ProgressBar percent={i.progressPercent} label={i.progressLabel} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case 'recentlyUpdated':
      return (
        <MiniList
          id="recentlyUpdated"
          title={S.dashboard.recentlyUpdated}
          items={d.recentlyUpdated}
          meta={(i) => `Updated ${fmtPartialDate(i.updatedAt.slice(0, 10))}`}
        />
      );
    case 'recentlyAdded':
      return (
        <MiniList
          id="recentlyAdded"
          title={S.dashboard.recentlyAdded}
          items={d.recentlyAdded}
          meta={(i) => `Added ${fmtPartialDate(i.dateAdded)}`}
        />
      );
    case 'recentlyCompleted':
      return (
        <MiniList
          id="recentlyCompleted"
          title={S.dashboard.recentlyCompleted}
          items={d.recentlyCompleted}
          empty={S.dashboard.completedEmpty}
          meta={(i) =>
            `Completed ${fmtPartialDate((i as ItemSummary & { dateCompleted: string | null }).dateCompleted)}`
          }
        />
      );
    case 'activity':
      return <Activity d={d} />;
    case 'upNext':
      return <UpNextWidget items={d.upNext} />;
    case 'pick':
      return (
        <>
          <h2 id="dash-pick">Pick for Me</h2>
          {d.countsByStatus.planned + d.countsByStatus.in_progress + d.countsByStatus.on_hold === 0 ? (
            <p className="muted">Nothing on the pile yet. Add a few things and come back.</p>
          ) : (
            <>
              <PickPanel compact />
              <a href="#/pick">More options</a>
            </>
          )}
        </>
      );
    case 'pileHealth':
      return <HealthWidget headingId="dash-pileHealth" />;
    case 'upcoming':
      return <UpcomingWidget headingId="dash-upcoming" />;
    case 'goals':
      return <GoalsWidget headingId="dash-goals" />;
    case 'lists':
      return <ListsWidget headingId="dash-lists" />;
    case 'statsSummary':
      return <StatsSummaryWidget headingId="dash-statsSummary" />;
    case 'yearStats':
      return <YearStatsWidget s={d.yearStats} />;
    case 'tags':
      return (
        <>
          <h2 id="dash-tags">{S.dashboard.tags}</h2>
          {d.tagCounts.length === 0 ? (
            <p className="muted">{S.dashboard.tagsEmpty}</p>
          ) : (
            <ul className="chip-list">
              {d.tagCounts.map((t) => (
                <li key={t.tag}>
                  <a
                    className="chip chip-link"
                    href="#/library"
                    onClick={() => setLibraryHint({ tags: [t.tag] })}
                  >
                    {t.tag} <span className="muted">({t.count})</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    default:
      return null;
  }
}

/** One-shot filter hint consumed by the Library view when navigating from the dashboard. */
export function setLibraryHint(h: { types?: string[]; tags?: string[] }): void {
  sessionStorage.setItem('mp-library-hint', JSON.stringify(h));
}

function MiniList({
  id,
  title,
  items,
  meta,
  empty,
}: {
  id: string;
  title: string;
  items: ItemSummary[];
  meta: (i: ItemSummary) => string;
  empty?: string;
}) {
  return (
    <>
      <h2 id={`dash-${id}`}>{title}</h2>
      {items.length === 0 ? (
        <p className="muted">{empty ?? 'Nothing here yet.'}</p>
      ) : (
        <ul className="mini-list">
          {items.map((i) => (
            <li key={i.id}>
              <a href={`#/item/${i.id}`}>
                <TypeIcon type={i.type} />
                <span className="mini-title">{i.title}</span>
              </a>
              <span className="muted">{meta(i)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Weekly activity as an accessible bar chart with a data table fallback. */
function Activity({ d }: { d: DashboardData }) {
  const max = Math.max(1, ...d.activityByWeek.map((w) => w.entries + w.completed));
  const total = d.activityByWeek.reduce((n, w) => n + w.entries, 0);
  return (
    <>
      <h2 id="dash-activity">{S.dashboard.activity}</h2>
      {total === 0 && d.activityByWeek.every((w) => w.completed === 0) ? (
        <p className="muted">{S.dashboard.activityEmpty}</p>
      ) : (
        <>
          <div className="bars" aria-hidden="true">
            {d.activityByWeek.map((w) => (
              <div
                key={w.weekStart}
                className="bar-col"
                title={`Week of ${w.weekStart}: ${w.entries} updates, ${w.completed} completed`}
              >
                <div className="bar" style={{ height: `${((w.entries + w.completed) / max) * 100}%` }} />
              </div>
            ))}
          </div>
          <details>
            <summary>Show as table</summary>
            <table className="table">
              <caption className="visually-hidden">Progress updates and completions per week</caption>
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <th scope="col">Progress updates</th>
                  <th scope="col">Completed</th>
                </tr>
              </thead>
              <tbody>
                {d.activityByWeek.map((w) => (
                  <tr key={w.weekStart}>
                    <td>{fmtPartialDate(w.weekStart)}</td>
                    <td>{w.entries}</td>
                    <td>{w.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <p className="muted">{total} progress update(s) in the last 12 weeks.</p>
        </>
      )}
    </>
  );
}

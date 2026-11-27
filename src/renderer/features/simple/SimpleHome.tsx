/**
 * Simple Mode Home: search/add box, Continue (in progress, one-tap progress),
 * a short Up Next row, four count tiles, pinned views. No charts or widgets.
 */
import type { DashboardData, ItemSummary } from '../../../shared/types';
import { call, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { typeLabel } from '../../app/strings';
import { Cover, EmptyState, ErrorBox, Loading, ProgressBar } from '../../components/Bits';
import { Omnibox } from './Omnibox';
import { QuickActions } from './QuickActions';

function setLibraryHint(hint: Record<string, unknown>) {
  try {
    sessionStorage.setItem('mp-library-hint', JSON.stringify(hint));
  } catch {
    /* ignore */
  }
}

export function NextStepLine({ item }: { item: ItemSummary }) {
  if (!item.nextStep || item.nextStepSpoiler) return null;
  return <span className="next-step-line">Next: {item.nextStep}</span>;
}

export function SimpleHome() {
  const app = useApp();
  const q = useAsync(() => call(getApi().items.dashboard()), [app.dataVersion]);
  const views = useAsync(() => call(getApi().views.list()), [app.dataVersion]);
  const queue = useAsync(() => call(getApi().queue.list()), [app.dataVersion]);
  const d = q.data as DashboardData | null;
  const pinned = (views.data ?? []).filter((v) => v.pinned);
  return (
    <div className="page simple-home">
      <div className="page-header">
        <h1>Home</h1>
      </div>
      <Omnibox id="home-omnibox" />
      {q.loading && !d && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {queue.data && queue.data.length > 0 && (
        <p className="badge-line" role="status">
          <span className="badge">{queue.data.length} waiting for details</span>{' '}
          <a href="#/library">Review in Library</a>
        </p>
      )}
      {d && d.total === 0 && (
        <EmptyState
          title="Add your first movie, show, game, or book"
          action={
            <button type="button" className="button button-primary" onClick={() => app.openAdd()}>
              Add something
            </button>
          }
        >
          Everything stays on this computer.
        </EmptyState>
      )}
      {d && d.total > 0 && (
        <>
          <section className="home-section" aria-labelledby="home-continue">
            <h2 id="home-continue">Continue</h2>
            {d.continueItems.length === 0 ? (
              <p className="muted">Nothing in progress. Start something from your library.</p>
            ) : (
              <ul className="continue-row">
                {d.continueItems.slice(0, 8).map((i) => (
                  <li key={i.id} className="continue-card">
                    <a href={`#/item/${i.id}`} className="continue-link">
                      <Cover url={i.thumbUrl} title={i.title} type={i.type} size="small" />
                      <span className="continue-text">
                        <span className="continue-title">{i.title}</span>
                        <span className="muted">{i.nextAction ?? i.progressLabel}</span>
                        <NextStepLine item={i} />
                        {i.checklist && app.level === 'full' && (
                          <span className="muted">
                            Checklist {i.checklist.done} of {i.checklist.total}
                          </span>
                        )}
                        <ProgressBar percent={i.progressPercent} label={i.progressLabel} />
                      </span>
                    </a>
                    <QuickActions item={i} compact />
                  </li>
                ))}
              </ul>
            )}
          </section>
          {d.upNext.length > 0 && (
            <section className="home-section" aria-labelledby="home-upnext">
              <h2 id="home-upnext">Up Next</h2>
              <ul className="upnext-row">
                {d.upNext.slice(0, 5).map((i) => (
                  <li key={i.id}>
                    <a href={`#/item/${i.id}`} className="upnext-link">
                      <Cover url={i.thumbUrl} title={i.title} type={i.type} size="small" />
                      <span>
                        {i.title} <span className="muted">· {typeLabel(i.type)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="home-section" aria-labelledby="home-counts">
            <h2 id="home-counts">Your pile</h2>
            <ul className="count-tiles">
              {(
                [
                  ['In progress', d.countsByStatus.in_progress, { statuses: ['in_progress'] }],
                  ['Planned', d.countsByStatus.planned, { statuses: ['planned'] }],
                  ['Completed', d.countsByStatus.completed, { statuses: ['completed'] }],
                  ['All', d.total, {}],
                ] as const
              ).map(([label, n, hint]) => (
                <li key={label}>
                  <a className="count-tile" href="#/library" onClick={() => setLibraryHint(hint)}>
                    <span className="count-value">{n}</span>
                    <span className="count-label">{label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
          {pinned.length > 0 && (
            <section className="home-section" aria-labelledby="home-views">
              <h2 id="home-views">Your views</h2>
              <ul className="plain-list row-wrap">
                {pinned.map((v) => (
                  <li key={v.id}>
                    <a className="button" href="#/library" onClick={() => setLibraryHint({ ...v.query })}>
                      {v.name}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

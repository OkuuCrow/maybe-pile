/** Interactive dashboard widgets: Up Next queue and This year. (Pick for Me lives in features/pick.) */
import { useState } from 'react';
import { MEDIA_TYPES } from '../../../shared/enums';
import type { DashboardData } from '../../../shared/types';
import { call, errorOf, getApi } from '../../app/api';
import { useApp } from '../../app/context';
import { typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { IconArrowDown, IconArrowUp, IconClose, TypeIcon } from '../../components/Icons';

export function UpNextWidget({ items }: { items: DashboardData['upNext'] }) {
  const app = useApp();
  const toast = useToast();
  const [list, setList] = useState(items);
  const [last, setLast] = useState(items);
  if (items !== last) {
    setLast(items);
    setList(items);
  }
  const move = async (id: string, direction: 'up' | 'down', title: string) => {
    try {
      setList(await call(getApi().items.moveUpNext({ id, direction })));
      // Keep keyboard focus on the moved item; if that button just became disabled (top/bottom), use the other one.
      setTimeout(() => {
        const same = document.getElementById(`upnext-${id}-${direction}`) as HTMLButtonElement | null;
        const other = document.getElementById(`upnext-${id}-${direction === 'up' ? 'down' : 'up'}`);
        (same && !same.disabled ? same : other)?.focus();
      }, 30);
      toast.show({ kind: 'info', message: `Moved “${title}” ${direction}.` }, 2500);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const remove = async (id: string, title: string) => {
    try {
      await call(getApi().items.setUpNext({ id, queued: false }));
      setList((l) => l.filter((x) => x.id !== id));
      app.bumpData();
      toast.success(`Removed “${title}” from Up Next.`);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <>
      <h2 id="dash-upNext">Up Next</h2>
      {list.length > 0 && (
        <p className="muted">
          {list.length} of {app.settings?.upNextMax ?? 10} ·{' '}
          <a
            href="#/library"
            onClick={() => sessionStorage.setItem('mp-library-hint', JSON.stringify({ upNextOnly: true }))}
          >
            View in Library
          </a>
        </p>
      )}
      {list.length === 0 ? (
        <p className="muted">
          Your queue is empty. Use “Add to Up Next” on an item (or select items in the Library) to line up
          what to start next.
        </p>
      ) : (
        <ol className="upnext-list">
          {list.map((i, idx) => (
            <li key={i.id} className="upnext-item">
              <span className="upnext-pos" aria-hidden="true">
                {idx + 1}
              </span>
              <a href={`#/item/${i.id}`} className="upnext-link">
                <TypeIcon type={i.type} />
                <span className="mini-title">{i.title}</span>
              </a>
              <span className="upnext-actions">
                <button
                  type="button"
                  id={`upnext-${i.id}-up`}
                  className="icon-button"
                  disabled={idx === 0}
                  onClick={() => void move(i.id, 'up', i.title)}
                  aria-label={`Move ${i.title} up`}
                >
                  <IconArrowUp />
                </button>
                <button
                  type="button"
                  id={`upnext-${i.id}-down`}
                  className="icon-button"
                  disabled={idx === list.length - 1}
                  onClick={() => void move(i.id, 'down', i.title)}
                  aria-label={`Move ${i.title} down`}
                >
                  <IconArrowDown />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void remove(i.id, i.title)}
                  aria-label={`Remove ${i.title} from Up Next`}
                >
                  <IconClose size={16} />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function YearStatsWidget({ s }: { s: DashboardData['yearStats'] }) {
  const empty = s.completedTotal === 0 && s.added === 0 && s.progressEntries === 0 && s.viewings === 0;
  return (
    <>
      <h2 id="dash-yearStats">This year ({s.year})</h2>
      {empty ? (
        <p className="muted">Nothing logged in {s.year} yet.</p>
      ) : (
        <>
          <dl className="year-stats">
            <div>
              <dt>Finished</dt>
              <dd>{s.completedTotal}</dd>
            </div>
            <div>
              <dt>Added</dt>
              <dd>{s.added}</dd>
            </div>
            <div>
              <dt>Episodes watched</dt>
              <dd>{s.episodesWatched}</dd>
            </div>
            <div>
              <dt>Movie viewings</dt>
              <dd>{s.viewings}</dd>
            </div>
          </dl>
          <ul className="status-counts" aria-label={`Finished in ${s.year} by type`}>
            {MEDIA_TYPES.map((t) => (
              <li key={t}>
                <TypeIcon type={t} /> {typeLabelPlural(t)}: <strong>{s.completedByType[t]}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * External links. Links are opened only through main's validated opener
 * (https + host allowlist), in the default browser. "Where to watch" uses the
 * link TMDB returns for the exact title and region; nothing is guessed.
 */
import { useId, useState } from 'react';
import type { ExternalLinkView, ItemDetail, WatchAvailability } from '../../../shared/types';
import { call, errorOf, getApi } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { IconExternal } from '../../components/Icons';
import { REGIONS } from '../settings/regions';

export function ExternalLink({ link }: { link: ExternalLinkView }) {
  const toast = useToast();
  return (
    <a
      href={link.url}
      className="external-link"
      onClick={(e) => {
        e.preventDefault();
        void call(getApi().app.openExternal({ url: link.url })).catch((err: unknown) =>
          toast.error(errorOf(err)),
        );
      }}
    >
      {link.label} <IconExternal />
      <span className="visually-hidden"> (opens in your browser)</span>
    </a>
  );
}

export function LinksPanel({ item }: { item: ItemDetail }) {
  const app = useApp();
  const id = useId();
  const [region, setRegion] = useState(app.settings?.region ?? 'US');
  const [watch, setWatch] = useState<WatchAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const isScreen = item.type === 'movie' || item.type === 'tv' || item.type === 'anime';

  const check = async (r: string) => {
    setBusy(true);
    try {
      setWatch(await call(getApi().providers.watch({ itemId: item.id, region: r })));
    } catch (e) {
      setWatch({
        status: 'error',
        region: r,
        link: null,
        providers: [],
        attribution: null,
        message: errorOf(e).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {item.links.length === 0 ? (
        <p className="muted">
          {item.type === 'game'
            ? 'No official store links are known for this game.'
            : 'No external links known.'}
        </p>
      ) : (
        <ul className="plain-list">
          {item.links.map((l) => (
            <li key={l.kind}>
              <ExternalLink link={l} />
            </li>
          ))}
        </ul>
      )}
      {isScreen && (
        <div className="watch">
          <h3>Where to watch</h3>
          <div className="row wrap">
            <label htmlFor={`${id}-region`}>Region</label>
            <select
              id={`${id}-region`}
              className="input input-inline"
              value={region}
              onChange={(e) => (setRegion(e.target.value), setWatch(null))}
            >
              {REGIONS.map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button button-small"
              onClick={() => void check(region)}
              disabled={busy}
            >
              {busy ? 'Checking…' : 'Check availability'}
            </button>
          </div>
          {watch && (
            <div role="status" className="watch-result">
              {watch.link && <ExternalLink link={watch.link} />}
              {watch.status !== 'available' && <p>Availability unavailable.</p>}
              <p className="muted">{watch.message}</p>
              {watch.providers.length > 0 && (
                <ul className="plain-list">
                  {watch.providers.map((p) => (
                    <li key={`${p.kind}-${p.name}`}>
                      {p.name}{' '}
                      <span className="muted">({p.kind === 'stream' ? 'subscription' : p.kind})</span>
                    </li>
                  ))}
                </ul>
              )}
              {watch.attribution && <p className="attribution">{watch.attribution}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useId, useState } from 'react';
import type { ItemDetail } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useToast } from '../../app/toast';
import { NumberField } from '../../components/Fields';

export function SeriesPanel({
  item,
  readOnly,
  onChange,
}: {
  item: ItemDetail;
  readOnly: boolean;
  onChange: () => void;
}) {
  const toast = useToast();
  const id = useId();
  const all = useAsync(() => call(getApi().catalog.series()), [item.updatedAt]);
  const [seriesId, setSeriesId] = useState('');
  const [position, setPosition] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      all.reload();
      onChange();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const available = (all.data ?? []).filter((s) => !item.series.some((m) => m.seriesId === s.id));
  return (
    <div>
      {item.series.length === 0 ? (
        <p className="muted">Not part of a series.</p>
      ) : (
        <ul className="plain-list">
          {item.series.map((s) => {
            const full = all.data?.find((x) => x.id === s.seriesId);
            return (
              <li key={s.seriesId}>
                <strong>{s.name}</strong>
                {s.position !== null && ` · #${s.position}`}
                {full?.totalKnown ? ` of ${full.totalKnown}` : ''}
                {!readOnly && (
                  <button
                    type="button"
                    className="button button-tiny"
                    onClick={() =>
                      void run(
                        () =>
                          call(
                            getApi().catalog.setSeriesMembership({
                              seriesId: s.seriesId,
                              itemId: item.id,
                              position: null,
                              member: false,
                            }),
                          ),
                        'Removed from series.',
                      )
                    }
                  >
                    Remove<span className="visually-hidden"> from {s.name}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && (
        <details>
          <summary>Add to a series</summary>
          {available.length > 0 && (
            <div className="row wrap">
              <label htmlFor={`${id}-s`}>Series</label>
              <select
                id={`${id}-s`}
                className="input input-inline"
                value={seriesId}
                onChange={(e) => setSeriesId(e.target.value)}
              >
                <option value="">Choose…</option>
                {available.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <NumberField label="Position" value={position} onChange={setPosition} min={0} step={0.5} />
              <button
                type="button"
                className="button button-small"
                disabled={!seriesId}
                onClick={() =>
                  void run(
                    () =>
                      call(
                        getApi().catalog.setSeriesMembership({
                          seriesId,
                          itemId: item.id,
                          position,
                          member: true,
                        }),
                      ),
                    'Added to series.',
                  )
                }
              >
                Add
              </button>
            </div>
          )}
          <div className="row wrap">
            <label htmlFor={`${id}-n`}>New series</label>
            <input
              id={`${id}-n`}
              className="input input-inline"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              type="button"
              className="button button-small"
              disabled={!newName.trim()}
              onClick={() =>
                void run(async () => {
                  const list = await call(
                    getApi().catalog.saveSeries({
                      id: null,
                      name: newName.trim(),
                      description: null,
                      totalKnown: null,
                    }),
                  );
                  const created = list.find(
                    (s) => s.name === newName.trim() && !item.series.some((m) => m.seriesId === s.id),
                  );
                  if (created)
                    await call(
                      getApi().catalog.setSeriesMembership({
                        seriesId: created.id,
                        itemId: item.id,
                        position: null,
                        member: true,
                      }),
                    );
                  setNewName('');
                }, 'Series created.')
              }
            >
              Create and add
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

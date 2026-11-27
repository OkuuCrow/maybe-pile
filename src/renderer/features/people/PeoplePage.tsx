/** §14.10 Loans + §16.9 Recommended by: open loans with overdue flags, people with counts, rename/merge/forget. */
import { useState } from 'react';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { EmptyState, ErrorBox, Loading } from '../../components/Bits';
import { SelectField, TextField } from '../../components/Fields';

export function PeoplePage() {
  const app = useApp();
  const toast = useToast();
  const loans = useAsync(() => call(getApi().extras.loans({ openOnly: true })), [app.dataVersion]);
  const people = useAsync(() => call(getApi().extras.people()), [app.dataVersion]);
  const [forget, setForget] = useState<{ id: string; name: string } | null>(null);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [merge, setMerge] = useState<{ id: string; name: string; into: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const recs = useAsync(
    () => (selected ? call(getApi().extras.recommendedBy({ id: selected })) : Promise.resolve([])),
    [selected, app.dataVersion],
  );
  const run = (p: Promise<unknown>, msg: string) =>
    void p
      .then(() => {
        toast.success(msg);
        app.bumpData();
      })
      .catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Loans &amp; people</h1>
      </div>
      <p className="muted">
        Names stay on this computer. They are never shown in share pages, share cards or logs.
      </p>
      <section aria-labelledby="loans-h">
        <h2 id="loans-h">Currently lent out or borrowed</h2>
        {loans.loading && !loans.data && <Loading />}
        {loans.error && <ErrorBox error={loans.error} onRetry={loans.reload} />}
        {loans.data && loans.data.length === 0 && (
          <p className="muted">Nothing is lent out or borrowed. Add loans on an item’s page.</p>
        )}
        {(loans.data ?? []).length > 0 && (
          <table className="table">
            <caption className="visually-hidden">Open loans</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Who</th>
                <th scope="col">Since</th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {(loans.data ?? []).map((l) => (
                <tr key={l.id}>
                  <td>
                    <a href={`#/item/${l.itemId}`}>{l.itemTitle}</a>
                  </td>
                  <td>
                    {l.direction === 'lent' ? 'Lent to' : 'Borrowed from'} {l.person}
                  </td>
                  <td>{l.loanedOn}</td>
                  <td>
                    {l.dueOn ?? '—'}
                    {l.overdue && <span className="badge badge-warning"> ⚠ Overdue</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="people-h">
        <h2 id="people-h">People</h2>
        {people.data && people.data.length === 0 && (
          <EmptyState title="No people yet">
            They appear when you add a loan or a “Recommended by”.
          </EmptyState>
        )}
        <ul className="plain-list">
          {(people.data ?? []).map((p) => (
            <li key={p.id} className="row">
              <button
                type="button"
                className="button-link"
                onClick={() => setSelected(p.id)}
                aria-pressed={selected === p.id}
              >
                {p.name}
              </button>
              <span className="muted">
                {p.recommended > 0 &&
                  `recommended ${p.recommended} (${p.recommendedInPile} in pile, ${p.recommendedCompleted} completed)`}
                {p.loans > 0 && ` · ${p.loans} loan(s)`}
              </span>
              {!p.forgotten && (
                <>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setRename({ id: p.id, name: p.name })}
                    aria-label={`Rename ${p.name}`}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setMerge({ id: p.id, name: p.name, into: '' })}
                    aria-label={`Merge ${p.name} into someone else`}
                  >
                    Merge…
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setForget({ id: p.id, name: p.name })}
                    aria-label={`Forget ${p.name}`}
                  >
                    Forget this person
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {selected && (recs.data ?? []).length > 0 && (
          <div>
            <h3>Recommended by {(people.data ?? []).find((p) => p.id === selected)?.name}</h3>
            <ul>
              {(recs.data ?? []).map((i) => (
                <li key={i.id}>
                  <a href={`#/item/${i.id}`}>{i.title}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {forget && (
        <ConfirmDialog
          title={`Forget ${forget.name}?`}
          message="Their name is replaced with “Forgotten person” everywhere. Loans and recommendations keep their dates. This cannot be undone."
          confirmLabel="Forget"
          destructive
          onCancel={() => setForget(null)}
          onConfirm={() => {
            const f = forget;
            setForget(null);
            run(call(getApi().extras.forgetPerson({ id: f.id })), 'Name removed.');
          }}
        />
      )}
      {rename && (
        <Dialog
          title="Rename"
          onClose={() => setRename(null)}
          size="small"
          footer={
            <button
              type="button"
              className="button button-primary"
              onClick={() => {
                const r = rename;
                setRename(null);
                run(call(getApi().extras.renamePerson({ id: r.id, name: r.name })), 'Renamed.');
              }}
            >
              Save
            </button>
          }
        >
          <TextField
            label="Name"
            value={rename.name}
            onChange={(name) => setRename({ ...rename, name })}
            maxLength={80}
            hint="Using an existing name merges the two."
          />
        </Dialog>
      )}
      {merge && (
        <Dialog
          title={`Merge ${merge.name} into…`}
          onClose={() => setMerge(null)}
          size="small"
          footer={
            <button
              type="button"
              className="button button-primary"
              disabled={!merge.into}
              onClick={() => {
                const m = merge;
                setMerge(null);
                run(call(getApi().extras.mergePeople({ fromId: m.id, intoId: m.into })), 'Merged.');
              }}
            >
              Merge
            </button>
          }
        >
          <SelectField
            label="Keep this person"
            value={merge.into}
            onChange={(into) => setMerge({ ...merge, into })}
            options={[
              { value: '', label: 'Choose…' },
              ...(people.data ?? [])
                .filter((p) => p.id !== merge.id && !p.forgotten)
                .map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Dialog>
      )}
    </div>
  );
}

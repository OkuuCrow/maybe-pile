/**
 * Custom lists: index (create/rename/reorder/delete), list detail (ordered
 * items, progress summary, remove/reorder) and the "Add to list…" dialog used
 * from item pages, the Library bulk bar and imports. Colors are optional and
 * always paired with the list's name and icon.
 */
import { useId, useState } from 'react';
import { LIST_COLORS, LIST_ICONS } from '../../../shared/schemas';
import type { ListColor, ListDetailView, ListIcon, ListSummaryView } from '../../../shared/types';
import { call, errorOf, getApi, useAsync, type AsyncState } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { EmptyState, ErrorBox, Loading, ProgressBar, StatusBadge } from '../../components/Bits';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { SelectField, TextArea, TextField } from '../../components/Fields';
import { IconArrowDown, IconArrowUp, IconClose, TypeIcon } from '../../components/Icons';

const ICON_GLYPH: Record<ListIcon, string> = {
  list: '☰',
  star: '★',
  heart: '♥',
  ghost: '👻',
  users: '👥',
  plane: '✈',
  flame: '🔥',
  leaf: '🍃',
};
const ICON_LABEL: Record<ListIcon, string> = {
  list: 'List',
  star: 'Star',
  heart: 'Heart',
  ghost: 'Ghost',
  users: 'People',
  plane: 'Travel',
  flame: 'Flame',
  leaf: 'Leaf',
};
const COLOR_LABEL: Record<ListColor, string> = {
  slate: 'Slate',
  blue: 'Blue',
  green: 'Green',
  amber: 'Amber',
  red: 'Red',
  purple: 'Purple',
  teal: 'Teal',
  pink: 'Pink',
};

export function ListBadge({ list }: { list: Pick<ListSummaryView, 'name' | 'color' | 'icon'> }) {
  return (
    <span className={`list-badge ${list.color ? `list-color-${list.color}` : ''}`}>
      <span aria-hidden="true">{ICON_GLYPH[list.icon ?? 'list']}</span> {list.name}
    </span>
  );
}

export function ListsPage() {
  const app = useApp();
  const toast = useToast();
  const q = useAsync(() => call(getApi().lists.list()), [app.dataVersion]);
  const [editing, setEditing] = useState<ListSummaryView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ListSummaryView | null>(null);
  const move = async (l: ListSummaryView, direction: 'up' | 'down') => {
    try {
      q.setData(await call(getApi().lists.move({ id: l.id, direction })));
      setTimeout(() => document.getElementById(`list-${l.id}-${direction}`)?.focus(), 20);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <h1>Lists</h1>
        <button type="button" className="button button-primary" onClick={() => setEditing('new')}>
          New list
        </button>
      </div>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && (
        <EmptyState
          title="No lists yet"
          action={
            <button type="button" className="button button-primary" onClick={() => setEditing('new')}>
              Create a list
            </button>
          }
        >
          Lists are your own collections — “Spooky season”, “Co-op with Sam”, “Books for the trip”. They can
          mix movies, shows, games and books.
        </EmptyState>
      )}
      {q.data && q.data.length > 0 && (
        <ol className="list-index">
          {q.data.map((l, i) => (
            <li key={l.id} className="card list-row">
              <a href={`#/list/${l.id}`} className="list-link">
                <ListBadge list={l} />
              </a>
              <span className="muted">
                {l.completed} of {l.total} completed
              </span>
              {l.description && <p className="muted list-desc">{l.description}</p>}
              <span className="upnext-actions">
                <button
                  type="button"
                  id={`list-${l.id}-up`}
                  className="icon-button"
                  disabled={i === 0}
                  onClick={() => void move(l, 'up')}
                  aria-label={`Move ${l.name} up`}
                >
                  <IconArrowUp />
                </button>
                <button
                  type="button"
                  id={`list-${l.id}-down`}
                  className="icon-button"
                  disabled={i === (q.data?.length ?? 0) - 1}
                  onClick={() => void move(l, 'down')}
                  aria-label={`Move ${l.name} down`}
                >
                  <IconArrowDown />
                </button>
                <button
                  type="button"
                  className="button button-tiny"
                  onClick={() => setEditing(l)}
                  aria-label={`Edit ${l.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button button-tiny"
                  onClick={() => setDeleting(l)}
                  aria-label={`Delete ${l.name}`}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <ListEditor
          list={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(ls) => {
            q.setData(ls);
            setEditing(null);
            app.bumpData();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          message={
            <p>
              The list is removed. The {deleting.total} item(s) in it stay in your library — only the list
              goes away.
            </p>
          }
          confirmLabel="Delete list"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const l = deleting;
            setDeleting(null);
            void call(getApi().lists.remove({ id: l.id }))
              .then((ls) => {
                q.setData(ls);
                app.bumpData();
                toast.success(`Deleted the list “${l.name}”. Its items were kept.`);
              })
              .catch((e: unknown) => toast.error(errorOf(e)));
          }}
        />
      )}
    </div>
  );
}

export function ListEditor({
  list,
  onClose,
  onSaved,
}: {
  list: ListSummaryView | null;
  onClose: () => void;
  onSaved: (lists: ListSummaryView[]) => void;
}) {
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const [color, setColor] = useState<ListColor | ''>(list?.color ?? '');
  const [icon, setIcon] = useState<ListIcon>(list?.icon ?? 'list');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(
        await call(
          getApi().lists.save({
            id: list?.id ?? null,
            name,
            description: description || null,
            color: color || null,
            icon,
          }),
        ),
      );
    } catch (e) {
      const err = errorOf(e);
      setErrors(err.fieldErrors ?? { name: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={list ? `Edit “${list.name}”` : 'New list'}
      onClose={onClose}
      size="small"
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button button-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <TextField label="Name" required value={name} onChange={setName} error={errors['name']} />
      <TextArea
        label="Description (optional)"
        value={description}
        onChange={setDescription}
        error={errors['description']}
      />
      <SelectField<ListIcon>
        label="Icon"
        value={icon}
        onChange={setIcon}
        options={LIST_ICONS.map((i) => ({ value: i, label: `${ICON_GLYPH[i]} ${ICON_LABEL[i]}` }))}
      />
      <SelectField<ListColor | ''>
        label="Color (optional)"
        hint="Color is decorative; the list is always shown with its name and icon."
        value={color}
        onChange={setColor}
        options={[
          { value: '', label: 'None' },
          ...LIST_COLORS.map((c) => ({ value: c, label: COLOR_LABEL[c] })),
        ]}
      />
    </Dialog>
  );
}

export function ListDetailPage({ id }: { id: string }) {
  const app = useApp();
  const toast = useToast();
  const q: AsyncState<ListDetailView> = useAsync(
    () => call(getApi().lists.get({ id })),
    [id, app.dataVersion],
  );
  const [editing, setEditing] = useState(false);
  const remove = async (itemId: string, title: string) => {
    try {
      await call(getApi().lists.setMembership({ listId: id, itemIds: [itemId], member: false }));
      q.reload();
      toast.success(`Removed “${title}” from the list.`);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const move = async (itemId: string, direction: 'up' | 'down') => {
    try {
      q.setData(await call(getApi().lists.moveItem({ listId: id, itemId, direction })));
      setTimeout(() => document.getElementById(`li-${itemId}-${direction}`)?.focus(), 20);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const d = q.data;
  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <a href="#/lists">Lists</a>
      </nav>
      {q.loading && !d && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {d && (
        <>
          <div className="page-header">
            <h1>
              <ListBadge list={d} />
            </h1>
            <button type="button" className="button" onClick={() => setEditing(true)}>
              Edit list
            </button>
          </div>
          {d.description && <p>{d.description}</p>}
          <ProgressBar
            percent={d.total === 0 ? null : (d.completed / d.total) * 100}
            label={`${d.completed} of ${d.total} completed`}
          />
          <p className="muted">
            {d.completed} of {d.total} completed
          </p>
          {d.items.length === 0 ? (
            <p className="muted">
              This list is empty. Use “Add to list…” on an item, or select items in the Library.
            </p>
          ) : (
            <ol className="upnext-list">
              {d.items.map((i, idx) => (
                <li key={i.id} className="upnext-item">
                  <span className="upnext-pos" aria-hidden="true">
                    {idx + 1}
                  </span>
                  <a href={`#/item/${i.id}`} className="upnext-link">
                    <TypeIcon type={i.type} />
                    <span className="mini-title">{i.title}</span>
                  </a>
                  <StatusBadge status={i.status} />
                  <span className="upnext-actions">
                    <button
                      type="button"
                      id={`li-${i.id}-up`}
                      className="icon-button"
                      disabled={idx === 0}
                      onClick={() => void move(i.id, 'up')}
                      aria-label={`Move ${i.title} up`}
                    >
                      <IconArrowUp />
                    </button>
                    <button
                      type="button"
                      id={`li-${i.id}-down`}
                      className="icon-button"
                      disabled={idx === d.items.length - 1}
                      onClick={() => void move(i.id, 'down')}
                      aria-label={`Move ${i.title} down`}
                    >
                      <IconArrowDown />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void remove(i.id, i.title)}
                      aria-label={`Remove ${i.title} from this list`}
                    >
                      <IconClose size={16} />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {editing && (
            <ListEditor
              list={d}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                q.reload();
                app.bumpData();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/** "Add to list…" — drag-free list picker; can create a list inline. */
export function AddToListDialog({
  itemIds,
  onClose,
  onDone,
}: {
  itemIds: string[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const app = useApp();
  const toast = useToast();
  const uid = useId();
  const q = useAsync(() => call(getApi().lists.list()), []);
  const [listId, setListId] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      let target = listId;
      if (target === '__new') {
        const lists = await call(
          getApi().lists.save({ id: null, name: newName, description: null, color: null, icon: 'list' }),
        );
        target = lists.find((l) => l.name.toLowerCase() === newName.trim().toLowerCase())?.id ?? '';
      }
      if (!target) {
        setError('Choose a list.');
        return;
      }
      const r = await call(getApi().lists.setMembership({ listId: target, itemIds, member: true }));
      const name = r.lists.find((l) => l.id === target)?.name ?? 'the list';
      toast.success(r.changed === 0 ? `Already in ${name}.` : `Added ${r.changed} item(s) to ${name}.`);
      app.bumpData();
      onDone?.();
      onClose();
    } catch (e) {
      const err = errorOf(e);
      setError(err.fieldErrors?.['name'] ?? err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={itemIds.length === 1 ? 'Add to list' : `Add ${itemIds.length} items to a list`}
      onClose={onClose}
      size="small"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void add()}
            disabled={busy || !listId || (listId === '__new' && !newName.trim())}
          >
            Add
          </button>
        </>
      }
    >
      {q.loading && <Loading />}
      <div className={`field ${error ? 'field-invalid' : ''}`}>
        <label htmlFor={`${uid}-l`}>List</label>
        <select
          id={`${uid}-l`}
          className="input"
          value={listId}
          onChange={(e) => setListId(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${uid}-e` : undefined}
        >
          <option value="">Choose…</option>
          {(q.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          <option value="__new">New list…</option>
        </select>
        {error && (
          <p className="field-error" id={`${uid}-e`}>
            <span aria-hidden="true">⚠ </span>
            {error}
          </p>
        )}
      </div>
      {listId === '__new' && (
        <TextField label="New list name" required value={newName} onChange={setNewName} />
      )}
    </Dialog>
  );
}

export function ListsWidget({ headingId }: { headingId: string }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().lists.list()), [app.dataVersion]);
  return (
    <>
      <h2 id={headingId}>Lists</h2>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && (
        <p className="muted">
          No lists yet. <a href="#/lists">Create one</a>.
        </p>
      )}
      {q.data && q.data.length > 0 && (
        <ul className="mini-list">
          {q.data.slice(0, 8).map((l) => (
            <li key={l.id}>
              <a href={`#/list/${l.id}`}>
                <ListBadge list={l} />
              </a>
              <span className="muted">
                {l.completed}/{l.total} done
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

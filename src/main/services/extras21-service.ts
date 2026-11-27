/**
 * Per-item extras added in 2.1:
 *  §16.5 Next step · §14.9 checklists · §14.10 loans · §16.9 recommended by
 *  (people are shared by loans and recommendations; "forget this person"
 *  anonymizes everywhere) · §16.10 journal (FTS) · §16.8 skipped episodes ·
 *  §14.3 quick rating prompt save.
 *
 * Third-party names are personal data: kept locally, included in JSON export
 * and backups (documented), never in logs, notifications (unless allowed),
 * share pages or share cards.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { appError } from '../../shared/result';
import { tagKey } from '../../domain/normalize';
import type {
  ChecklistOpSchema,
  JournalSaveSchema,
  LoanSaveSchema,
  NextStepSchema,
  RatingPromptSchema,
  RecommenderSaveSchema,
} from '../../shared/pack21-schemas';
import * as items from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';
import type { HistoryService } from './history-service';
import type { LibraryService } from './library-service';
import type { MoodsService } from './moods-service';

export interface ChecklistView {
  itemId: string;
  entries: { id: string; text: string; position: number; checked: boolean; checkedAt: string | null }[];
  done: number;
  total: number;
  /** True when every entry is checked — the UI may *suggest* marking the item Completed. */
  complete: boolean;
}

export interface LoanView {
  id: string;
  itemId: string;
  itemTitle: string;
  personId: string | null;
  person: string;
  direction: 'lent' | 'borrowed';
  loanedOn: string;
  dueOn: string | null;
  returnedOn: string | null;
  note: string | null;
  overdue: boolean;
}

export interface PersonView {
  id: string;
  name: string;
  forgotten: boolean;
  loans: number;
  recommended: number;
  recommendedInPile: number;
  recommendedCompleted: number;
}

export interface JournalEntryView {
  id: string;
  itemId: string;
  entryDate: string;
  body: string;
  progressLabel: string | null;
  spoiler: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ItemExtrasView {
  nextStep: { text: string; spoiler: boolean } | null;
  checklist: ChecklistView;
  loans: LoanView[];
  recommender: { person: string; personId: string; note: string | null; recommendedOn: string | null } | null;
  journalCount: number;
}

export class Extras21Service {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
    private readonly history: HistoryService,
    private readonly moods: MoodsService,
  ) {}

  private get db() {
    return this.ctx.db();
  }
  private nowIso() {
    return this.ctx.clock.now().toISOString();
  }
  private today() {
    return this.library.today();
  }
  private requireItem(id: string) {
    if (!this.db.get('SELECT 1 AS x FROM items WHERE id = ? AND deleted_at IS NULL', [id]))
      throw appError('NOT_FOUND', 'That item no longer exists.');
  }

  forItem(itemId: string): ItemExtrasView {
    this.requireItem(itemId);
    const ns = this.db.get<{ text: string; spoiler: number }>(
      'SELECT text, spoiler FROM item_next_steps WHERE item_id = ?',
      [itemId],
    );
    const rec = this.db.get<{
      name: string;
      forgotten: number;
      person_id: string;
      note: string | null;
      recommended_on: string | null;
    }>(
      `SELECT p.name, p.forgotten, r.person_id, r.note, r.recommended_on FROM item_recommenders r JOIN people p ON p.id = r.person_id WHERE r.item_id = ?`,
      [itemId],
    );
    return {
      nextStep: ns ? { text: ns.text, spoiler: ns.spoiler === 1 } : null,
      checklist: this.checklist(itemId),
      loans: this.loans({ itemId }),
      recommender: rec
        ? {
            person: rec.forgotten ? 'Someone' : rec.name,
            personId: rec.person_id,
            note: rec.note,
            recommendedOn: rec.recommended_on,
          }
        : null,
      journalCount:
        this.db.get<{ n: number }>('SELECT count(*) AS n FROM journal_entries WHERE item_id = ?', [itemId])
          ?.n ?? 0,
    };
  }

  /* ---------------------------------------------------------------- next step */

  setNextStep(input: z.output<typeof NextStepSchema>): ItemExtrasView {
    this.requireItem(input.itemId);
    this.history.logged([input.itemId], 'user', () => {
      if (input.text === null) this.db.run('DELETE FROM item_next_steps WHERE item_id = ?', [input.itemId]);
      else
        this.db.run(
          `INSERT INTO item_next_steps (item_id, text, spoiler, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(item_id) DO UPDATE SET text = excluded.text, spoiler = excluded.spoiler, updated_at = excluded.updated_at`,
          [input.itemId, input.text, input.spoiler ? 1 : 0, this.nowIso()],
        );
    });
    return this.forItem(input.itemId);
  }

  /** Called when an item becomes Completed and the user opted in to clearing next steps. */
  clearNextStepOnComplete(itemId: string): void {
    this.db.run('DELETE FROM item_next_steps WHERE item_id = ?', [itemId]);
  }

  /* ---------------------------------------------------------------- checklists */

  checklist(itemId: string): ChecklistView {
    const rows = this.db.all<{ id: string; text: string; position: number; checked_at: string | null }>(
      `SELECT ci.id, ci.text, ci.position, ci.checked_at FROM checklists c JOIN checklist_items ci ON ci.checklist_id = c.id
        WHERE c.item_id = ? ORDER BY ci.position`,
      [itemId],
    );
    const entries = rows.map((r) => ({
      id: r.id,
      text: r.text,
      position: r.position,
      checked: r.checked_at !== null,
      checkedAt: r.checked_at,
    }));
    const done = entries.filter((e) => e.checked).length;
    return {
      itemId,
      entries,
      done,
      total: entries.length,
      complete: entries.length > 0 && done === entries.length,
    };
  }

  private checklistId(itemId: string, create: boolean): string | null {
    const r = this.db.get<{ id: string }>('SELECT id FROM checklists WHERE item_id = ?', [itemId]);
    if (r || !create) return r?.id ?? null;
    const id = randomUUID();
    this.db.run('INSERT INTO checklists (id, item_id, created_at) VALUES (?, ?, ?)', [
      id,
      itemId,
      this.nowIso(),
    ]);
    return id;
  }

  checklistOp(op: z.output<typeof ChecklistOpSchema>): ChecklistView {
    this.requireItem(op.itemId);
    const db = this.db;
    db.transaction(() => {
      const cl = this.checklistId(op.itemId, op.op === 'add');
      if (!cl) throw appError('NOT_FOUND', 'This item has no checklist.');
      const own = (entryId: string) => {
        const e = db.get<{ position: number }>(
          'SELECT position FROM checklist_items WHERE id = ? AND checklist_id = ?',
          [entryId, cl],
        );
        if (!e) throw appError('NOT_FOUND', 'That checklist entry no longer exists.');
        return e;
      };
      switch (op.op) {
        case 'add': {
          const n =
            db.get<{ n: number }>('SELECT count(*) AS n FROM checklist_items WHERE checklist_id = ?', [cl])
              ?.n ?? 0;
          if (n >= 200) throw appError('VALIDATION', 'A checklist can have at most 200 entries.');
          db.run(
            'INSERT INTO checklist_items (id, checklist_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)',
            [randomUUID(), cl, op.text, n, this.nowIso()],
          );
          break;
        }
        case 'edit':
          own(op.entryId);
          db.run('UPDATE checklist_items SET text = ? WHERE id = ?', [op.text, op.entryId]);
          break;
        case 'check':
          own(op.entryId);
          db.run('UPDATE checklist_items SET checked_at = ? WHERE id = ?', [
            op.checked ? this.nowIso() : null,
            op.entryId,
          ]);
          break;
        case 'move': {
          const e = own(op.entryId);
          const target = op.direction === 'up' ? e.position - 1 : e.position + 1;
          const other = db.get<{ id: string }>(
            'SELECT id FROM checklist_items WHERE checklist_id = ? AND position = ?',
            [cl, target],
          );
          if (!other) break;
          db.run('UPDATE checklist_items SET position = ? WHERE id = ?', [e.position, other.id]);
          db.run('UPDATE checklist_items SET position = ? WHERE id = ?', [target, op.entryId]);
          break;
        }
        case 'delete': {
          own(op.entryId);
          db.run('DELETE FROM checklist_items WHERE id = ?', [op.entryId]);
          const rest = db.all<{ id: string }>(
            'SELECT id FROM checklist_items WHERE checklist_id = ? ORDER BY position',
            [cl],
          );
          rest.forEach((r, i) => db.run('UPDATE checklist_items SET position = ? WHERE id = ?', [i, r.id]));
          if (rest.length === 0) db.run('DELETE FROM checklists WHERE id = ?', [cl]);
          break;
        }
      }
      items.touch(db, op.itemId, this.nowIso());
    });
    return this.checklist(op.itemId);
  }

  /* ---------------------------------------------------------------- people */

  private personFor(name: string): string {
    const key = tagKey(name);
    const r = this.db.get<{ id: string }>('SELECT id FROM people WHERE name_key = ? AND forgotten = 0', [
      key,
    ]);
    if (r) return r.id;
    const id = randomUUID();
    this.db.run('INSERT INTO people (id, name, name_key, forgotten, created_at) VALUES (?, ?, ?, 0, ?)', [
      id,
      name.trim(),
      key,
      this.nowIso(),
    ]);
    return id;
  }

  people(): PersonView[] {
    return this.db
      .all<{
        id: string;
        name: string;
        forgotten: number;
        loans: number;
        rec: number;
        rec_pile: number;
        rec_done: number;
      }>(
        `SELECT p.id, p.name, p.forgotten,
           (SELECT count(*) FROM loans l JOIN items i ON i.id = l.item_id WHERE l.person_id = p.id AND i.deleted_at IS NULL) AS loans,
           (SELECT count(*) FROM item_recommenders r JOIN items i ON i.id = r.item_id WHERE r.person_id = p.id AND i.deleted_at IS NULL) AS rec,
           (SELECT count(*) FROM item_recommenders r JOIN items i ON i.id = r.item_id WHERE r.person_id = p.id AND i.deleted_at IS NULL AND i.status IN ('planned','in_progress','on_hold')) AS rec_pile,
           (SELECT count(*) FROM item_recommenders r JOIN items i ON i.id = r.item_id WHERE r.person_id = p.id AND i.deleted_at IS NULL AND i.status = 'completed') AS rec_done
         FROM people p ORDER BY p.forgotten, p.name COLLATE NOCASE`,
      )
      .map((r) => ({
        id: r.id,
        name: r.forgotten ? 'Forgotten person' : r.name,
        forgotten: r.forgotten === 1,
        loans: r.loans,
        recommended: r.rec,
        recommendedInPile: r.rec_pile,
        recommendedCompleted: r.rec_done,
      }));
  }

  /** Autocomplete for "Recommended by" and loan names. */
  peopleNames(): string[] {
    return this.db
      .all<{ name: string }>(
        'SELECT name FROM people WHERE forgotten = 0 ORDER BY name COLLATE NOCASE LIMIT 500',
      )
      .map((r) => r.name);
  }

  renamePerson(id: string, name: string): PersonView[] {
    const key = tagKey(name);
    const clash = this.db.get<{ id: string }>('SELECT id FROM people WHERE name_key = ? AND id != ?', [
      key,
      id,
    ]);
    if (clash) return this.mergePeople(id, clash.id);
    if (
      this.db.run('UPDATE people SET name = ?, name_key = ? WHERE id = ? AND forgotten = 0', [
        name.trim(),
        key,
        id,
      ]).changes === 0
    )
      throw appError('NOT_FOUND', 'That person no longer exists.');
    return this.people();
  }

  mergePeople(fromId: string, intoId: string): PersonView[] {
    if (fromId === intoId) return this.people();
    this.db.transaction(() => {
      this.db.run('UPDATE loans SET person_id = ? WHERE person_id = ?', [intoId, fromId]);
      this.db.run('UPDATE item_recommenders SET person_id = ? WHERE person_id = ?', [intoId, fromId]);
      this.db.run('DELETE FROM people WHERE id = ?', [fromId]);
    });
    return this.people();
  }

  /** "Forget this person": anonymizes the name everywhere (loans and recommendations keep their dates). */
  forgetPerson(id: string): PersonView[] {
    const n = this.db.run(
      "UPDATE people SET name = 'Forgotten person', name_key = 'forgotten:' || id, forgotten = 1 WHERE id = ?",
      [id],
    ).changes;
    if (n === 0) throw appError('NOT_FOUND', 'That person no longer exists.');
    this.ctx.log.info('people.forgotten');
    return this.people();
  }

  /* ---------------------------------------------------------------- loans */

  loans(filter: { itemId?: string; open?: boolean } = {}): LoanView[] {
    const today = this.today();
    return this.db
      .all<{
        id: string;
        item_id: string;
        title: string;
        person_id: string | null;
        name: string | null;
        forgotten: number | null;
        direction: 'lent' | 'borrowed';
        loaned_on: string;
        due_on: string | null;
        returned_on: string | null;
        note: string | null;
      }>(
        `SELECT l.*, i.title, p.name, p.forgotten FROM loans l JOIN items i ON i.id = l.item_id LEFT JOIN people p ON p.id = l.person_id
          WHERE i.deleted_at IS NULL ${filter.itemId ? 'AND l.item_id = ?' : ''} ${filter.open ? 'AND l.returned_on IS NULL' : ''}
          ORDER BY l.returned_on IS NOT NULL, l.due_on IS NULL, l.due_on, l.loaned_on DESC`,
        filter.itemId ? [filter.itemId] : [],
      )
      .map((r) => ({
        id: r.id,
        itemId: r.item_id,
        itemTitle: r.title,
        personId: r.person_id,
        person: !r.name || r.forgotten ? 'Someone' : r.name,
        direction: r.direction,
        loanedOn: r.loaned_on,
        dueOn: r.due_on,
        returnedOn: r.returned_on,
        note: r.note,
        overdue: r.returned_on === null && r.due_on !== null && r.due_on < today,
      }));
  }

  saveLoan(input: z.output<typeof LoanSaveSchema>): LoanView[] {
    this.requireItem(input.itemId);
    const now = this.nowIso();
    this.db.transaction(() => {
      const person = this.personFor(input.person);
      if (input.id) {
        const n = this.db.run(
          'UPDATE loans SET person_id = ?, direction = ?, loaned_on = ?, due_on = ?, returned_on = ?, note = ?, updated_at = ? WHERE id = ? AND item_id = ?',
          [
            person,
            input.direction,
            input.loanedOn,
            input.dueOn,
            input.returnedOn,
            input.note,
            now,
            input.id,
            input.itemId,
          ],
        ).changes;
        if (n === 0) throw appError('NOT_FOUND', 'That loan no longer exists.');
      } else
        this.db.run(
          'INSERT INTO loans (id, item_id, person_id, direction, loaned_on, due_on, returned_on, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            randomUUID(),
            input.itemId,
            person,
            input.direction,
            input.loanedOn,
            input.dueOn,
            input.returnedOn,
            input.note,
            now,
            now,
          ],
        );
    });
    return this.loans({ itemId: input.itemId });
  }

  deleteLoan(id: string): void {
    this.db.run('DELETE FROM loans WHERE id = ?', [id]);
  }

  /* ---------------------------------------------------------------- recommended by */

  setRecommender(input: z.output<typeof RecommenderSaveSchema>): ItemExtrasView {
    this.requireItem(input.itemId);
    this.db.transaction(() => {
      if (input.person === null) {
        this.db.run('DELETE FROM item_recommenders WHERE item_id = ?', [input.itemId]);
        return;
      }
      const person = this.personFor(input.person);
      this.db.run(
        `INSERT INTO item_recommenders (item_id, person_id, note, recommended_on, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET person_id = excluded.person_id, note = excluded.note, recommended_on = excluded.recommended_on`,
        [input.itemId, person, input.note, input.recommendedOn, this.nowIso()],
      );
    });
    return this.forItem(input.itemId);
  }

  /** Item ids recommended by a person (Library filter / grouped view). */
  recommendedBy(personId: string): string[] {
    return this.db
      .all<{ item_id: string }>(
        'SELECT r.item_id FROM item_recommenders r JOIN items i ON i.id = r.item_id WHERE r.person_id = ? AND i.deleted_at IS NULL',
        [personId],
      )
      .map((r) => r.item_id);
  }

  /* ---------------------------------------------------------------- journal */

  journal(itemId: string): JournalEntryView[] {
    return this.db
      .all<{
        id: string;
        item_id: string;
        entry_date: string;
        body: string;
        progress_label: string | null;
        spoiler: number;
        created_at: string;
        updated_at: string;
      }>(
        'SELECT id, item_id, entry_date, body, progress_label, spoiler, created_at, updated_at FROM journal_entries WHERE item_id = ? ORDER BY entry_date DESC, created_at DESC',
        [itemId],
      )
      .map((r) => ({
        id: r.id,
        itemId: r.item_id,
        entryDate: r.entry_date,
        body: r.body,
        progressLabel: r.progress_label,
        spoiler: r.spoiler === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  saveJournal(input: z.output<typeof JournalSaveSchema>): JournalEntryView[] {
    this.requireItem(input.itemId);
    const now = this.nowIso();
    this.db.transaction(() => {
      let id = input.id;
      if (id) {
        const n = this.db.run(
          'UPDATE journal_entries SET entry_date = ?, body = ?, progress_label = ?, spoiler = ?, updated_at = ? WHERE id = ? AND item_id = ?',
          [input.entryDate, input.body, input.progressLabel, input.spoiler ? 1 : 0, now, id, input.itemId],
        ).changes;
        if (n === 0) throw appError('NOT_FOUND', 'That journal entry no longer exists.');
      } else {
        id = randomUUID();
        this.db.run(
          'INSERT INTO journal_entries (id, item_id, entry_date, body, progress_label, spoiler, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            input.itemId,
            input.entryDate,
            input.body,
            input.progressLabel,
            input.spoiler ? 1 : 0,
            now,
            now,
          ],
        );
      }
      const rid = this.db.get<{ rid: number }>('SELECT rid FROM journal_entries WHERE id = ?', [id])?.rid;
      if (rid !== undefined) {
        this.db.run('DELETE FROM journal_fts WHERE rowid = ?', [rid]);
        this.db.run('INSERT INTO journal_fts (rowid, body) VALUES (?, ?)', [rid, input.body]);
      }
    });
    return this.journal(input.itemId);
  }

  deleteJournal(id: string): void {
    this.db.transaction(() => {
      const r = this.db.get<{ rid: number }>('SELECT rid FROM journal_entries WHERE id = ?', [id]);
      if (!r) return;
      this.db.run('DELETE FROM journal_fts WHERE rowid = ?', [r.rid]);
      this.db.run('DELETE FROM journal_entries WHERE id = ?', [id]);
    });
  }

  /** Local full-text search over journal entries; returns matching item ids (newest first). */
  searchJournal(q: string): { itemId: string; entryId: string }[] {
    const terms = q
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' ');
    if (!terms) return [];
    return this.db
      .all<{ item_id: string; id: string }>(
        `SELECT j.item_id, j.id FROM journal_fts f JOIN journal_entries j ON j.rid = f.rowid JOIN items i ON i.id = j.item_id
          WHERE journal_fts MATCH ? AND i.deleted_at IS NULL ORDER BY j.entry_date DESC LIMIT 200`,
        [terms],
      )
      .map((r) => ({ itemId: r.item_id, entryId: r.id }));
  }

  /* ---------------------------------------------------------------- skipped episodes */

  skipEpisodes(itemId: string, episodeIds: readonly string[], skipped: boolean): number {
    this.requireItem(itemId);
    return this.db.transaction(() => {
      let n = 0;
      for (const e of episodeIds)
        n += this.db.run(
          'UPDATE episodes SET skipped = ?, watched = CASE WHEN ? = 1 THEN 0 ELSE watched END WHERE id = ? AND item_id = ?',
          [skipped ? 1 : 0, skipped ? 1 : 0, e, itemId],
        ).changes;
      items.recomputeProgress(this.db, itemId);
      items.touch(this.db, itemId, this.nowIso());
      return n;
    });
  }

  /* ---------------------------------------------------------------- quick rating prompt */

  saveRatingPrompt(input: z.output<typeof RatingPromptSchema>): void {
    this.requireItem(input.itemId);
    this.history.logged([input.itemId], 'user', () => {
      if (input.rating !== null) this.library.setRating(input.itemId, input.rating);
      if (input.note) {
        const d = this.library.get(input.itemId);
        const notes = d.personal.notes ? `${d.personal.notes}\n\n${input.note}` : input.note;
        this.library.update({ id: input.itemId, personal: { ...d.personal, notes } });
      }
    });
    if (input.moodIds.length > 0) {
      const current = this.moods.forItem(input.itemId);
      this.moods.setForItem(input.itemId, [...new Set([...current, ...input.moodIds])]);
    }
  }
}

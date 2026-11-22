/** Custom fields, book series, audit log and tags. */
import { appError } from '../../shared/result';
import type { CustomFieldDefInput } from '../../shared/schemas';
import type { AuditEntryView, CustomFieldDefView, SeriesView, TagCount } from '../../shared/types';
import * as cat from '../../db/repositories/catalog-repo';
import { getItemRow, touch } from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';

export class CatalogService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }
  private now() {
    return this.ctx.clock.now().toISOString();
  }

  listCustomFields(): CustomFieldDefView[] {
    return cat.listCustomFieldDefs(this.db);
  }

  saveCustomField(input: CustomFieldDefInput): CustomFieldDefView[] {
    const clash = cat.findCustomFieldByName(this.db, input.name);
    if (clash && clash.id !== input.id) {
      throw appError('CONFLICT', 'A custom field with that name already exists.', {
        fieldErrors: { name: 'Choose a different name.' },
      });
    }
    if (input.id) {
      const existing = this.listCustomFields().find((d) => d.id === input.id);
      if (!existing) throw appError('NOT_FOUND', 'That custom field no longer exists.');
      if (existing.type !== input.type) {
        throw appError('VALIDATION', "A field's type can't be changed after it's created.", {
          recovery: 'Create a new field instead.',
        });
      }
      if (existing.type === 'select') {
        const used = this.db.all<{ v: string }>(
          'SELECT DISTINCT text_value AS v FROM custom_field_values WHERE def_id = ?',
          [input.id],
        );
        const missing = used.map((u) => u.v).filter((v) => !input.options.includes(v));
        if (missing.length > 0) {
          throw appError(
            'VALIDATION',
            `Options still in use can't be removed: ${missing.slice(0, 5).join(', ')}.`,
            {
              fieldErrors: { options: 'Some removed options are still used by items.' },
            },
          );
        }
      }
    }
    this.db.transaction(() => cat.upsertCustomFieldDef(this.db, input, this.now()));
    return this.listCustomFields();
  }

  deleteCustomField(id: string): CustomFieldDefView[] {
    cat.deleteCustomFieldDef(this.db, id);
    return this.listCustomFields();
  }

  listSeries(): SeriesView[] {
    return cat.listSeries(this.db);
  }

  saveSeries(input: {
    id: string | null;
    name: string;
    description: string | null;
    totalKnown: number | null;
  }): SeriesView[] {
    cat.upsertSeries(this.db, input, this.now());
    return this.listSeries();
  }

  deleteSeries(id: string): SeriesView[] {
    cat.deleteSeries(this.db, id);
    return this.listSeries();
  }

  setMembership(seriesId: string, itemId: string, position: number | null, member: boolean): SeriesView[] {
    const item = getItemRow(this.db, itemId);
    if (!item) throw appError('NOT_FOUND', 'That item no longer exists.');
    if (item.type !== 'book') throw appError('VALIDATION', 'Only books can belong to a book series.');
    if (!this.listSeries().some((s) => s.id === seriesId))
      throw appError('NOT_FOUND', 'That series no longer exists.');
    this.db.transaction(() => {
      if (member) cat.setSeriesMembership(this.db, seriesId, itemId, position);
      else cat.removeSeriesMembership(this.db, seriesId, itemId);
      touch(this.db, itemId, this.now());
    });
    return this.listSeries();
  }

  audit(itemId: string): AuditEntryView[] {
    return cat.listAudit(this.db, itemId);
  }

  tags(): TagCount[] {
    return cat.tagCounts(this.db);
  }
}

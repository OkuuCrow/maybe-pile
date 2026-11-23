/**
 * Release Radar: upcoming release dates for Planned (optionally On Hold) items,
 * on-demand date refresh through the normal provenance-respecting refresh
 * path, `.ics` export and the "today / tomorrow" notification schedule.
 *
 * Date refresh never overwrites a date the user edited unless they choose so
 * in the diff (the same rule as metadata refresh). Only the release date is
 * touched; every other field is explicitly kept.
 */
import { randomBytes } from 'node:crypto';
import type { MediaType, Status } from '../../shared/enums';
import { appError } from '../../shared/result';
import type { RadarDiffRow, RadarRefreshView, RefreshPreview, UpcomingItemView } from '../../shared/types';
import { localDate } from '../../domain/dates';
import { isUserEdited } from '../../domain/metadata';
import type { ProvenanceOrigin } from '../../shared/enums';
import { buildIcs, type IcsEvent } from '../../domain/ics';
import {
  isUpcoming,
  notificationKind,
  precisionOf,
  radarSortKey,
  relativeLabel,
} from '../../domain/release-radar';
import { getProvider } from '../../providers/registry';
import { readSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';

export interface RefreshPort {
  refreshPreview(itemId: string): Promise<RefreshPreview>;
  refreshApply(input: { token: string; choices: Record<string, 'keep' | 'update'> }): unknown;
}

export const RADAR_REFRESH_LIMIT = 50;

interface PendingRefresh {
  at: number;
  perItem: Map<string, { token: string; fields: string[] }>;
}

export interface DueNotification {
  itemId: string;
  kind: 'today' | 'tomorrow';
  title: string;
  body: string;
}

export class ReleaseRadarService {
  private readonly pending = new Map<string, PendingRefresh>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly refresh: RefreshPort,
  ) {}

  private get db() {
    return this.ctx.db();
  }
  today(): string {
    return localDate(this.ctx.clock.now());
  }

  private candidateRows() {
    const { releaseRadar } = readSettings(this.db).settings;
    const statuses: Status[] = releaseRadar.includeOnHold ? ['planned', 'on_hold'] : ['planned'];
    return this.db.all<{
      id: string;
      title: string;
      type: MediaType;
      release_date: string;
      origin: string | null;
      prov_provider: string | null;
      prov_value: string | null;
      fetched_at: string | null;
    }>(
      `SELECT i.id, i.title, i.type, i.release_date, fp.origin, fp.provider_id AS prov_provider, fp.provider_value AS prov_value,
              (SELECT max(s.fetched_at) FROM item_sources s WHERE s.item_id = i.id) AS fetched_at
       FROM items i LEFT JOIN field_provenance fp ON fp.item_id = i.id AND fp.field = 'releaseDate'
       WHERE i.deleted_at IS NULL AND i.release_date IS NOT NULL AND i.status IN (${statuses.map(() => '?').join(',')})`,
      statuses,
    );
  }

  upcoming(): UpcomingItemView[] {
    const today = this.today();
    const rows = this.candidateRows().filter((r) => isUpcoming(r.release_date, today));
    rows.sort(
      (a, b) =>
        radarSortKey(a.release_date).localeCompare(radarSortKey(b.release_date)) ||
        a.title.localeCompare(b.title),
    );
    const out: UpcomingItemView[] = [];
    for (const r of rows.slice(0, 500)) {
      const s = items.summariesWhere(this.db, 'i.id = ?', [r.id], '')[0];
      if (!s) continue;
      const userEdited = isUserEdited(
        'releaseDate',
        r.release_date,
        r.origin
          ? {
              origin: r.origin as ProvenanceOrigin,
              providerId: r.prov_provider,
              providerValue: r.prov_value,
              updatedAt: '',
            }
          : undefined,
      );
      out.push({
        ...s,
        releaseDate: r.release_date,
        precision: precisionOf(r.release_date),
        relative: relativeLabel(r.release_date, today),
        dateSource:
          r.origin === 'provider' && r.prov_provider
            ? (getProvider(r.prov_provider)?.displayName ?? r.prov_provider)
            : r.origin
              ? 'you'
              : 'unknown',
        fetchedAt: r.fetched_at,
        userEdited,
      });
    }
    return out;
  }

  /** Re-fetches details for upcoming items that came from a provider and shows release-date changes only. */
  async refreshPreview(): Promise<RadarRefreshView> {
    const list = this.upcoming();
    const withSource = list.filter((u) =>
      this.db.get('SELECT 1 FROM item_sources WHERE item_id = ?', [u.id]),
    );
    const rows: RadarDiffRow[] = [];
    const failures: RadarRefreshView['failures'] = [];
    const perItem = new Map<string, { token: string; fields: string[] }>();
    for (const u of withSource.slice(0, RADAR_REFRESH_LIMIT)) {
      try {
        const p = await this.refresh.refreshPreview(u.id);
        const row = p.rows.find((r) => r.field === 'releaseDate');
        if (!row) continue;
        perItem.set(u.id, { token: p.token, fields: p.rows.map((r) => r.field) });
        rows.push({
          itemId: u.id,
          title: u.title,
          current: row.current || null,
          incoming: row.incoming || null,
          userEdited: row.userEdited,
          defaultChoice: row.userEdited ? 'keep' : row.defaultChoice,
        });
      } catch (e) {
        const msg =
          e instanceof Error && 'safe' in e
            ? (e as { safe: { message: string } }).safe.message
            : 'Could not refresh.';
        failures.push({ itemId: u.id, title: u.title, message: msg });
        if (
          e instanceof Error &&
          'safe' in e &&
          (e as { safe: { code: string } }).safe.code === 'PROVIDER_RATE_LIMITED'
        )
          break;
      }
    }
    const token = randomBytes(16).toString('hex');
    this.pending.set(token, { at: Date.now(), perItem });
    while (this.pending.size > 5) {
      const k = this.pending.keys().next().value;
      if (k === undefined) break;
      this.pending.delete(k);
    }
    return {
      token,
      rows,
      checked: Math.min(withSource.length, RADAR_REFRESH_LIMIT),
      failures,
      skippedNoSource: list.length - withSource.length,
    };
  }

  refreshApply(token: string, choices: Record<string, 'keep' | 'update'>): { updated: number } {
    const p = this.pending.get(token);
    if (!p)
      throw appError('NOT_FOUND', 'This refresh has expired.', { recovery: 'Refresh upcoming dates again.' });
    let updated = 0;
    for (const [itemId, choice] of Object.entries(choices)) {
      const entry = p.perItem.get(itemId);
      if (!entry || choice !== 'update') continue;
      const fieldChoices = Object.fromEntries(
        entry.fields.map((f) => [f, f === 'releaseDate' ? 'update' : 'keep']),
      ) as Record<string, 'keep' | 'update'>;
      this.refresh.refreshApply({ token: entry.token, choices: fieldChoices });
      updated++;
    }
    this.pending.delete(token);
    return { updated };
  }

  ics(): { text: string; included: number; skipped: number } {
    const list = this.upcoming();
    const events: IcsEvent[] = list
      .filter((u) => u.precision === 'day')
      .map((u) => ({
        itemId: u.id,
        date: u.releaseDate,
        summary: `${u.title} releases`,
        description: 'From Maybe Pile Release Radar',
      }));
    return {
      text: buildIcs(events, this.ctx.clock.now()),
      included: events.length,
      skipped: list.length - events.length,
    };
  }

  /**
   * Notifications due now (opt-in). Each (item, date, kind) fires at most once;
   * text never includes notes. Returns [] when notifications are off.
   */
  dueNotifications(): DueNotification[] {
    const { releaseRadar } = readSettings(this.db).settings;
    if (!releaseRadar.notifications) return [];
    const today = this.today();
    const due: DueNotification[] = [];
    const now = this.ctx.clock.now().toISOString();
    this.db.transaction(() => {
      for (const r of this.candidateRows()) {
        const kind = notificationKind(r.release_date, today);
        if (!kind) continue;
        const ins = this.db.run(
          'INSERT INTO release_notifications (item_id, release_date, kind, notified_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          [r.id, r.release_date, kind, now],
        );
        if (ins.changes === 0) continue;
        due.push({
          itemId: r.id,
          kind,
          title: kind === 'today' ? 'Out today' : 'Out tomorrow',
          body: `${r.title} ${kind === 'today' ? 'releases today' : 'releases tomorrow'}.`,
        });
      }
    });
    return due;
  }
}

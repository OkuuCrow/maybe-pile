# Recently deleted and Recent changes (§16.1)

**Recently deleted (core).** Deleting moves items to Recently deleted for 30 days (Settings → Advanced:
1–365). All related data stays attached, so **Restore** brings everything back (history, runs, tags, lists,
Up Next, artwork, checklists, loans). Permanent delete and *Empty* confirm with the count. Soft-deleted
items never trigger reminders and are excluded from search, stats and the helper. Exports and full backups
include them (with their deletion time); before 2.1, deleted items were purged at every start.

**Recent changes (Full).** A bounded local log of edits to title, status, rating, dates, tags, next step and
deletion — old → new — with per-change **Undo** when the field still has the logged value (otherwise the
reason is shown). Notes are recorded only as “notes edited”, never their text. Bulk edits, rules and triage
write one batch each (undone together from their toast). Retention 90 days / 5 000 entries (configurable);
*Clear log*. Not exported (local history).

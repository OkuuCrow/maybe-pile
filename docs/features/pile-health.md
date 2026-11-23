# Pile Health

Gentle, optional, never nagging. **Pile Health never sends system notifications.**

## What counts as stale (Settings → Features → Pile Health)

- **Planned** for longer than *N* months (default **12**): `date_added ≤ today − N months`.
- **In Progress** with no progress for *N* days (default **60**). "Last progress" is the latest progress entry, viewing or watched episode; if there are none, the start date, then the date added.

Shown in the **Pile Health** dashboard component (top 5) and on the **Pile Health** page (all, with bulk actions). The Library has a filter: Filters → Collections → Pile Health → *Stale* / *Snoozed*.

## Triage (all reversible)

| Action | Effect |
| --- | --- |
| **Keep** | Stop nudging about it for one more threshold period (12 months / 60 days). Pick for Me still includes it. |
| **Snooze…** | Hide from nudges **and** Pick for Me for 30 / 90 / 180 days or until a date. The snooze ends the day after the chosen date. |
| **On Hold** | Status → On Hold. |
| **Drop…** | Status → Dropped, after a confirmation. History is kept. |
| **Open details** | The item link. |

Bulk actions (on the page) cover Keep, Snooze, On Hold and Drop; Drop and On Hold ask for confirmation first. **Wake now** removes a snooze. Item pages show "Snoozed until …" with a **Wake** button.

## Pile stats

Real data only: items on the pile (Planned + In Progress + On Hold) by type, the median age of Planned items (labelled "only N items" for small samples), items added vs completed in the last 30 and 90 days, and a 12-month pile-size trend. The trend is hidden until you have at least 5 items, so tiny samples don't produce misleading charts.

Trend approximation: the pile size at a month end counts items added by then that weren't completed by then. Drop dates aren't recorded, so a currently Dropped item is left out of the whole series.

## Turning it off

**Settings → Features → Show Pile Health nudges** off hides the panel and all nudges. Snoozes and data are kept.

## Data stored

`item_snoozes (item_id, until, reason: manual | pile-health | keep, created_at)`. Expired snoozes are cleaned up at startup. Settings: `pileHealth.{enabled, plannedStaleMonths, inProgressStaleDays}`. Snoozes are in JSON exports and backups.

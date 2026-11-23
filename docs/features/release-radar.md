# Release Radar

Upcoming release dates for **Planned** items (and optionally **On Hold**, Settings → Features).

## Upcoming

The **Upcoming** dashboard component and page list items whose release date could still be today or later, sorted by the earliest possible day. Each row states, in text:

- the date at its real precision: "2027" (year only), "Mar 2027" (month only) or "14 Mar 2027" (exact date);
- a relative time ("tomorrow", "in 3 weeks", "sometime this year", "in 2027");
- where the date came from (the provider's name, or "you") and when it was last checked.

## Refresh dates

**Refresh dates** re-fetches details for upcoming items that came from an online source (up to 50 per run, rate-limited per provider) and shows **only release-date changes** as a diff. Dates you edited are marked "edited by you" and default to **Keep mine**. Untouched provider dates default to **Use new**. Applying updates only the release date; every other field is explicitly kept. This uses the same provenance rules and audit log as metadata refresh.

**Check for release-date changes when Maybe Pile starts** (opt-in, off by default) runs the same check about 15 seconds after start-up. It doesn't apply anything.

## Notifications (opt-in, off by default)

**Notify me the day before and on release day** shows a system notification ("Out tomorrow" / "Out today") for exact-date releases. Each fires at most once per item, date and kind. The text includes only the title, never your notes.

**Notifications only appear while Maybe Pile is running.** It checks at start-up and then every hour. There is no background service or login item, so nothing is shown while the app is closed.

## Calendar export

**Export calendar (.ics)** writes a standards-compliant iCalendar file through a native save dialog: all-day events, RFC 5545 text escaping, 75-octet line folding, and stable UIDs (`release-<item id>@maybe-pile`), so re-importing an updated file moves events instead of duplicating them. Only exact dates are exported; the message says how many month/year-only dates were left out. Nothing connects to a calendar account.

## Data stored

`release_notifications (item_id, release_date, kind, notified_at)`. Settings: `releaseRadar.{includeOnHold, notifications, refreshOnStart}`.

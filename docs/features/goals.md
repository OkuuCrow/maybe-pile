# Goals

Simple targets such as "Read 24 books in 2027", "Finish 10 games this year" or "Watch 4 movies this month". Goals are suggestions, never nags: **no notifications are ever sent**.

## Fields

- **Name**, **target** (1–1,000,000).
- **Count:** items finished, pages (finished books), episodes watched, or game hours logged.
- **Media type** (or all). Pages require books, episodes require TV, hours require games; the form says so if they don't match.
- **Period:** calendar year, calendar month, or custom start/end dates.
- **Scope** (optional): only items in a list, or with a tag.

## How progress is computed

| Metric | Counted |
| --- | --- |
| Items | Items with status Completed and a completion date inside the period |
| Pages | Page counts of books completed in the period (books without a page count add nothing) |
| Episodes | Regular episodes whose watched time falls in the period, by your **local** date |
| Hours | For each game: the latest hours entry in the period minus the latest one before it (never negative) |

Un-completing an item (Completed → In Progress) removes it from the count.

## Pace

Shown in plain text ("On pace", "Ahead of pace", "Behind pace", "Goal reached", "Not started yet", "Period ended") with an icon, never colour alone. The math is shown under "How is this calculated?":

```
elapsed   = days from start through today (inclusive), clamped to the period
expected  = target × elapsed ÷ days in the period
tolerance = max(1, 10% of expected)
ahead if progress ≥ expected + tolerance; behind if progress < expected − tolerance; otherwise on pace
```

A "to finish on time: about N per week" hint is shown while the goal is open.

## Managing

Edit, **Archive** (hidden from the dashboard, kept on the Goals page under "Show archived"), or **Delete** (with confirmation; your items aren't affected). The **Goals** dashboard component can be shown, hidden and reordered.

## Data stored

`goals (id, title, media_type, metric, period, start_date, end_date, target, list_id → lists SET NULL, tag, archived_at, created_at)`. Included in JSON exports and backups.

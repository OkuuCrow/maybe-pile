# Stats & Year in Review

Local-only charts computed from your real history. Nothing is uploaded, and there are no placeholder charts.

## Stats page

Choose **All time** or a year.

- Completed per month (by type) and per year.
- Average rating by type, with "rated / completed" counts. Unrated items are excluded and the count of them is stated.
- Top genres and top creators (director, creator, developer, author) among completed items.
- Time from start to finish (under a week, 1–4 weeks, 1–3 months, 3–12 months, over a year). Items without a start date are counted separately.
- Episodes watched per month.
- Totals: pages read (finished books with a page count) and game hours (games tracked by hours: the latest hours entry).
- **Activity streak** (weeks in a row with any activity): off by default, Settings → Features.

## Year in Review

Items finished (by type), favourites by rating, the longest book / game / show finished, the busiest month, most-used tags, and an "About the data" card ("12 of your 30 finished items had no rating").

## Accessibility

Each chart is an SVG with `role="img"`, a title and a text summary. Bars show their numbers as text and use **patterns** (solid, stripes, dots, cross-hatch) as well as colour, and the legend repeats the swatch with a label. **Show data table** reveals the exact numbers in a real table. No animation is used.

## Export

Each chart has **Export CSV** (the same numbers as its data table, formula-safe) and **Save as image**. Save as image captures the chart region of the window in the main process and saves it as PNG through a native save dialog. Nothing is uploaded.

## Time zones and boundaries

- `date_completed` / `date_started` are **local calendar dates** and are used as stored. Year and month are their first characters.
- History instants (episode watches, viewings, progress entries) are stored in **UTC** and converted to your **local calendar date** (the system time zone) before bucketing. An episode watched at 23:30 on 31 December in New York counts for December.
- The `UTC` and other zones are covered by unit tests (`instantToLocalDate`).

## Performance

Measured with `npm run bench` on 10,000 items / 100,000 history rows: **stats ≈ 0.9 s**, Year in Review ≈ 4 ms (see the verification log). Queries are indexed, and conversions use a cached formatter.

# Tracker imports (Goodreads, Letterboxd, custom CSV)

Import files **you exported yourself**. Maybe Pile never signs in to other sites, never scrapes, and never fetches or opens a URL found inside a file. **Import → Other trackers.**

All three use the standard import preview: counts, row-numbered warnings and errors, conflicts (same online id or ISBN, or same normalized title + year + type), and a choice per conflict of **Skip** or **Keep both**. Tracker imports never replace existing items, so "Update from file" isn't offered. Nothing changes until you press **Import**. The whole import runs in one transaction and is recorded as an import batch, so you can **undo** it later (untouched items only, as for Steam).

## Goodreads

Goodreads: **My Books → Import and export → Export Library**.

| Goodreads | Maybe Pile |
| --- | --- |
| Title, Author | Title, author |
| ISBN, ISBN13 (`="0441172717"` cells are unwrapped) | ISBN-10/13 (checksums validated; also used for duplicate detection) |
| My Rating (0–5; 0 = not rated) | Rating (5 stars → 10) |
| Exclusive Shelf: `read` / `currently-reading` / `to-read` | Completed / In Progress / Planned |
| Any other exclusive shelf | Recognized words (dnf, abandoned, on hold…) or Planned, with a warning; the shelf is kept as a tag |
| Bookshelves | Tags |
| Date Read, Date Added | Completion date, date added |
| Number of Pages, Publisher, Original Publication Year | Page count, publisher, release year |
| My Review + Private Notes | Notes |

## Letterboxd

Letterboxd: **Settings → Data → Export your data**. Choose the `.zip` or any of `watched.csv`, `ratings.csv`, `watchlist.csv`, `diary.csv`. Rows are merged per film (by Letterboxd URI, else name + year). Files under `deleted/` or `orphaned/` are ignored.

- `watchlist` → Planned · `watched` → Completed (completion date = date logged).
- `ratings` (0.5–5 stars) → rating (half stars kept).
- `diary` → one **viewing** per *Watched Date*, diary tags → tags, rating.

Diary dates are calendar dates and are stored at 12:00 UTC so they show on the same day in every time zone from UTC−11 to UTC+11.

## Custom CSV (column mapper)

Choose any CSV/TSV/TXT. Maybe Pile detects the **separator** (`,` `;` tab `|`), **encoding** (UTF-8 with or without BOM, UTF-16 by BOM, otherwise Windows-1252) and handles **quoted fields with newlines**. It then shows:

- a mapping for each field (title is required; type, creator, status, rating, dates, release year/date, tags, ISBN, page count, platform, notes), guessed from the header;
- the default type when there's no type column or a row's type is unknown;
- the rating scale (0–5, 0.5–5, 1–10, 1–100 → the app's 1–10), date format (Y-M-D, M/D/Y, D/M/Y) and tag separator;
- the first five rows of the file, and the preview counts, which update as you change the mapping.

**Save mapping** stores the mapping as a reusable profile (*Start from a saved mapping*). Status words such as "read", "watching", "want to play", "dnf" and "paused" are recognized; unknown values become Planned plus a tag, with a warning.

## Safety limits

- Files over **25 MB** or **50,000 rows** are refused with a clear message.
- Cells are only ever text. A title like `=HYPERLINK(...)` is imported as text and is neutralized again (`'=`) in CSV exports.
- No file content is executed, evaluated or fetched.

## Data stored

Imported items are normal items. `csv_mapping_profiles (name, mapping JSON)` stores saved mappings (validated on read). `import_batches` / `import_batch_items` record the import for undo.

# Saved views (§14.4, Full mode)

Library → **Save view…** stores the current search, filters, sort and view mode under a name. Views can be
renamed, reordered, duplicated, deleted (confirmed), **pinned to Home** and exported/imported as
`.mpview.json` (`{format:"maybepile-view", version:1, name, query, viewMode}`; strict schema, 64 KB cap,
only the documented Library query fields — nothing is evaluated).

- Lists are referenced by stable id; if the list was deleted, the view shows a notice instead of silently
  dropping the filter.
- Starter suggestions (In progress, Short movies to watch, Games on hold, Top rated, Recently added) are
  offered, never auto-created.
- Data: `saved_views` (validated JSON query). Exported in `pack21.savedViews`.

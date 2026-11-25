# Runs (rewatch / replay / reread)

A *run* is one time through an item. Run *n* is `items.pass = n`, and the current run mirrors the item's live status, dates and rating.

- Moving a Completed item back to In Progress offers **Start a new run**. The finishing run keeps its dates and rating. For TV and anime, the episode checkmarks are **snapshotted** for that run before they reset.
- **Item page → Runs** lists every run with its status, start, finish and rating. The data is kept per run.
- The migration back-filled runs from existing `pass` values. Earlier passes became completed runs, using what the database knew.
- The **completion heatmap** counts every completed run, so rewatches count.
- MAL imports turn "times watched" into earlier runs.

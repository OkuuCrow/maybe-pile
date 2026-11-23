# Up Next

A small, manually ordered queue of what to start soon. Items can be any mix of movies, shows, games and books.

- **Size:** at most 10 by default (Settings → Features, 3–25). Adding to a full queue says so; bulk add skips items once it's full.
- **Add/remove:** from an item's page, the Library bulk bar, or a Pick for Me result. Remove with the × on the dashboard widget.
- **Reorder:** Move up / Move down buttons (keyboard-operable; focus stays on the moved item). Drag-and-drop isn't offered; the buttons are the accessible primary method.
- **Starting** an Up Next item (status → In Progress) shows a toast offering **Remove from Up Next**. It stays unless you choose that.
- **Completing or dropping** an item removes it automatically. Other status changes keep it.
- **Library filter:** Filters → Collections → *Only Up Next*, or "View in Library" on the widget.
- **Dashboard:** the *Up Next queue* component can be shown, hidden and reordered like the others.

## Data stored

Table `up_next (item_id PK → items ON DELETE CASCADE, position UNIQUE, added_at)`. Migration v4 moved the queue here from `items.up_next_position`, keeping its order. Positions are compacted to 0..n-1 after every change. Reorders swap through a free temporary slot, so the UNIQUE constraint always holds.

## Export

JSON export: `upNextPosition` per item. CSV: `up_next_position` column (1-based). Both are re-imported in order after the existing queue, while there's room. Full backups include the table.

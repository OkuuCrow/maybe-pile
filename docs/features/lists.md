# Custom lists

Your own collections: "Halloween watchlist", "Couch co-op", "Books for the trip". Lists can mix media types, and an item can be in many lists.

- **Create, rename, describe, reorder (Move up/down) and delete** on the **Lists** page.
- **Colour and icon** are optional and decorative. A list is always shown with its name and icon; colour is never the only identifier.
- **Add items** from the item page (**Add to list…**), the Library bulk bar (**Add to list…**, which can also create a list), and during Steam / game-list imports. The dialog is drag-free.
- **List page:** ordered items (Move up/down, remove) and a progress summary ("3 of 8 completed").
- **Library filter:** Filters → Collections → List.
- **Deleting a list never deletes its items.** The confirmation says so.
- **Names** are unique case- and accent-insensitively ("Spooky Season" = "spooky season"). A duplicate name shows an error on the name field.

## Data stored

`lists (id, name, name_key UNIQUE, description, color, icon, position, …)` and `list_items (list_id, item_id, position, added_at)`, both cascading on delete.

## Export

- **JSON:** `data.lists[]` with ordered memberships. Import merges by name: an existing list with the same name is reused.
- **CSV:** a `lists` column (names separated by `; `). CSV import creates missing lists by name. Order within a list isn't represented in CSV.
- **Backups:** included.

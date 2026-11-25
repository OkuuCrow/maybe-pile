# Duplicate merge

**Pile page → Possible duplicates** lists pairs of the same type that share an external ID, or have the same normalized title (with the same year when both have one). **Not duplicates** hides a pair for good.

**Merge…** shows each field that differs side by side. You choose a value per field, and notes can keep both.

When merging:

- External IDs, alternative titles, tags, genres and moods are combined.
- Sessions, purchases, availability, viewings, list memberships, series memberships and relations move to the kept item.
- Episode and progress history move only if the kept item has none.
- The other item is soft-deleted, and old links to it resolve to the kept item.

**Undo** restores the exact pre-merge state from a full snapshot. Every row that references either item is captured, found generically from the foreign keys and two levels deep. Undo is **refused** if the kept item changed after the merge, because restoring would silently discard that change.

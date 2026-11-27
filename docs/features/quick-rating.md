# Quick rating prompt (§14.3, core)

When an item becomes **Completed** by a single action (one-tap Done/Mark watched, the status menu), a small
card asks “How was it?” with 5 stars, an optional one-line note and mood chips.

- Non-blocking, dismissible, keyboard-operable; auto-dismisses after 60 s **without saving anything**.
- Settings → Advanced: on/off (default on), “only when there is no rating yet” (default on).
- Never shown for bulk edits, imports, sync, rules or triage.
- Saving sets the rating, appends the note to the item's notes, and adds the chosen moods.

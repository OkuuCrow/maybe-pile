# Pick for Me

A fast, fair answer to "what should I do tonight?"

**Where:** Dashboard widget, the **Pick for Me** page (`#/pick`), the command palette, and **Ctrl/⌘ + Shift + P**.

## Constraints (all optional)

Media type · list · tags · minimum rating · **time tonight** · only Up Next · include In Progress · include On Hold · skip things I said "Not now" to.

- **Candidates:** Planned items, plus In Progress and On Hold if you include them. Dropped and Completed items are never picked. Items snoozed by Pile Health are excluded.
- **Time tonight:** a movie fits if its runtime is at most your time + 20 minutes (90 min → films up to 110 min). A TV show fits if one episode fits. Games and books fit only when tagged with a session length (`session-30`, `session:45`, `30min`…) or tagged `short`. Unknown runtimes don't fit. That's deliberate: a pick that doesn't fit your evening is worse than none.
- **Empty pool:** the message names the filter that removed the last candidates (for example "Available time") and offers **Loosen that filter and try again**.

## Weighting (Settings → Features → Pick for Me)

Weighted random with a seedable PRNG (`src/domain/pick.ts`, unit-tested with fixed seeds):

```
ageYears = min(5, days since added / 365)
neutral → 1        older → 1 + ageYears        newer → 1 + (5 − ageYears)
× 2 if "favor items I'm already partway through" is on and the item is In Progress or has progress
```

Weights are never zero, so every eligible item can be picked. **Re-roll** never repeats the previous pick when there is another option.

## Result and actions

The pick shows its cover, type and status, and **why** it matched ("Planned 14 months · fits 90 min (95 min) · tag: cozy"). The result is announced through a polite live region; no animation is used.

- **Start it**: after confirmation, sets In Progress (with today as the start date if it has none).
- **Re-roll**.
- **Not now**: skip it for *N* days (default 7, Settings → Features). Recorded locally.
- **Add to Up Next**.
- **Open details**.

**Recent picks** lists the last 8 with what you did. **Clear "Not now" skips** makes everything eligible again.

## Data stored

`pick_history` (item, time, outcome, skip-until), trimmed to the last 200 picks (active skips are kept). Settings: `pick.*`. Pick history isn't exported; the settings are, in JSON exports and backups.

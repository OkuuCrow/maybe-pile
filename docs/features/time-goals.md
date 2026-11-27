# Time-based goals (§14.1, Full mode)

“30 minutes a day” or “5 hours a week”, optionally only for one media type, list or mood. Goals → Time goals.

- **Source of time**: the `sessions` log (play/watch/read timers and manual session entries). A running
  timer counts live. Skipped episodes never count as time.
- **Day/week boundaries** are local days; weeks start on Sunday. A session that spans midnight is split
  between the two days in proportion to its duration (sessions store start, end and length only).
- **Pace**: on track / a bit behind / ahead / done for this period — text plus a bar, never color alone.
  History of the last 7 days or weeks. No guilt wording; goals never nag.
- **Notification** “Daily time goal” (off by default): one evening nudge (20:00) if a daily goal is open.
- Data: `time_goals`. Exported in JSON (`pack21.timeGoals`; list/mood scopes are not mapped across
  libraries and are dropped on import) and in full backups.

# Automatic status rules (§16.7, Full mode)

Settings → Advanced. Four toggles, all off by default, each with a “what would change right now” preview:

1. Suggest Completed when everything is done (suggestion only — never applied silently).
2. Move In Progress to On Hold after N days without progress (default 90).
3. Flag Planned items as stale after N months (flag only; nothing is deleted).
4. When you start an item, remove it from Up Next.

Rules run when the app starts and daily, **only in the app process** (they write the library; the
read-only helper never runs them). Every change is one batch in Recent changes with an Undo; the optional
“Automatic changes” notification summarizes the day. No rule ever deletes data.

# Sessions and the hours rule

- **Item page → Time → Start timer**, then Pause, Resume, and **Stop and save**. **Log a past session…** adds one by hand.
- **Survives restarts:** the timer state is stored in the database (banked seconds plus the start of the current segment), so quitting or a crash doesn't lose it. After a restart the header shows the running or paused timer, and its link opens the item.
- **One timer at a time:** starting a second timer pauses the first.
- **Long sessions** (more than 12 h by default, configurable) are flagged when you stop them, so a forgotten timer can be corrected.
- **Hours source of truth** (games: Preferences → Hours played come from):
  - *What I enter* (the default) means sessions are a log only and never change your hours.
  - *Session timer totals* means each change records the session total as an "hours" progress entry, so goals and stats see it.
  - *Steam playtime imports* means hours come from Steam, and sessions are only a log.

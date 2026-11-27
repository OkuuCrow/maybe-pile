# Journal (§16.10, Full mode)

A dated timeline of entries per item: plain text, optional progress tag (“S2E5”, “p. 120”) and a spoiler
flag (hidden until revealed). The existing notes field stays as the pinned note. Entries are searchable
locally (SQLite FTS, `journal_fts`), included in JSON exports and backups, and **never** included in logs,
notifications, share outputs or the change log.

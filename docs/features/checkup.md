# Library check-up (§16.2)

Backup & restore → **Check my library** (also Full mode) runs read-only diagnostics:

`integrity_check`, `foreign_key_check`, search index consistency, missing artwork files, cached images
nothing uses, unused tags/creators/genres, progress labels that don't match history, dates that don't fit
the status, duplicate online IDs, invalid saved links, and background-reminder health.

Each finding has a severity (text + icon) and, where safe, a **Fix** with a preview. Fixes first take a
database snapshot (`backups/pre-fix-*.sqlite`, newest 5 kept) and run in one transaction; file and OS
operations (unused files, background repair) run after the commit. “Fix all safe issues” previews counts.
The report can be saved as redacted text (codes and counts only). Optional monthly reminder (off).

# Backup destination check (§14.7, core)

Backup & restore shows warnings about the backup folder, re-checked at each backup:

- **same drive/volume as the library** (Windows: same drive root or volume serial; Linux: same device),
- folder name looks like a **cloud-sync** folder (Dropbox, OneDrive, Google Drive, iCloud, Syncthing,
  Nextcloud, …) — a hint only,
- **removable** drive hint on Linux (`/media`, `/run/media`, `/mnt`).

Never blocks; never scans the filesystem — only the chosen path and the library folder are `stat`ed. The
backup reminder notification mentions a same-drive backup folder.

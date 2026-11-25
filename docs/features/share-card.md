# Share card

Stats → Year in Review → **Save share card…** draws a 1200×630 PNG locally on a canvas, showing the year, finished count, counts per type and up to five favorites. The image includes **no provider artwork** (so there are no third-party image rights to worry about), no external fonts and no network access.

Main re-checks the PNG before writing it: magic bytes, header dimensions of at most 4096 px, and at most 6 MB. Saving goes through the native save dialog.

# Artwork Picker

Every item has five artwork **slots**: cover, banner, logo, icon and background. Each slot holds at most one selected image.

## Choosing art

On the item page, **Artwork…** (or **Choose…** on a slot) opens the picker:

- Candidates are fetched **in parallel** from every applicable source. The item's own metadata source supplies its cover and banner. TMDB, fanart.tv and SteamGridDB supply more when you've added their keys.
- A status line per source shows the image count, "Not set up" (with where to add a key) or "Unavailable".
- **Slot tabs** show each slot's candidate count. You can filter by source and language.
- **Keyboard:** Tab moves into the grid, and the arrow keys move between candidates. Enter or Space previews, and **Use this …** applies. Double-click applies straight away. Each candidate's accessible name includes the source, size, language and an adult flag.
- The preview shows the source's credit (for example the SteamGridDB author or the fanart.tv copyright) and whether the image is stored or shown live.

## Your choice wins

A choice you make is marked **Your choice** (`user_selected`). Metadata refreshes, imports and auto-pick **never replace it**. **Revert to automatic** clears the mark and immediately auto-picks again.

## Automatic picks

- On import, the source's cover (and banner, if any) fill their slots automatically.
- **Library → select items → Auto-pick artwork** fills the slots ticked in Settings → Features → Artwork. It runs one item at a time, within each source's rate limit. The summary reports how many items were updated, how many kept your choice, and how many found nothing.
- Candidates are ranked by **per-type source priority** (Settings → Features → Artwork; for example movies: TMDB, then fanart.tv), then by English or text-free images, then by the source's own score.

## Storage and safety

Images are fetched **only by the main process**, never by the renderer. Each source's terms decide whether an image is stored:

| Policy | Sources | What happens |
| --- | --- | --- |
| Cached | Open Library, TVmaze | The image is downloaded, checked, re-encoded and saved as `<sha256>.png|jpg`, plus a thumbnail. |
| Remote-only | TMDB, AniList, Kitsu, MAL/Jikan, IGDB, fanart.tv, SteamGridDB | Only the https URL is stored. The image is proxied live through `maybepile-art://remote/<id>` and kept in an in-memory cache. |

Safety rules apply to every fetch (cached or proxied):

- **Host allowlist** per source.
- **Redirects** are followed manually, at most 3 hops, each re-validated. A hop may only go to the same host or a declared host (Open Library → `archive.org`, `*.us.archive.org`). Anything else fails.
- **Byte cap**: 15 MB for downloads, 8 MB for the proxy.
- **Pixel cap**: at most 12,000 px per side and 40 MP. This is checked from the **image header before decoding**, as a decompression-bomb guard.
- **Magic-byte check**: PNG, JPEG, WebP or GIF only. SVG and anything else is rejected, whatever the `Content-Type` says.
- **Re-encoding** (Electron `nativeImage`) strips EXIF and other metadata.
- **File names** are SHA-256 content hashes and are never influenced by input.

API keys for fanart.tv and SteamGridDB are stored with `safeStorage`, sent only in request headers, and never logged or exported. The renderer only ever receives opaque tokens and `maybepile-art://` URLs.

## Adult artwork

Art for adult items is blurred (CSS blur plus an "Adult content — show" button and an "(adult content, blurred)" alt text) until you reveal it. Settings → Features → Anime → *Blur adult artwork* controls this.

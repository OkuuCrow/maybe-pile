# Anime

Anime is a media type of its own (since 2.0) and uses the TV progress model: one season with absolute episode numbers, episode checkmarks, and runs for rewatches.

## Fields

Anime has these fields, in addition to the common ones (title, alternative titles, description, release date, genres, creators, IDs):

| Field | Notes |
| --- | --- |
| Romaji / English / native title | Stored separately; the display title follows **Settings → Features → Anime → Show titles in**. |
| Format | TV, TV Short, Movie, OVA, ONA, Special, Music. |
| Airing status | Not yet released, Releasing, Finished, Cancelled, Hiatus. |
| Season and year | For example, Fall 2023. Shows that premiere in the last week of a quarter count as the next season (a 29 Sep premiere is a Fall show). |
| Source material | For example, Manga or Light novel. |
| Episode count and length | When the count is unknown or the show is airing, only aired or known episodes are listed. |
| Next episode / airing time | Schedule fields. A refresh may clear them when a show finishes. |
| Adult | Adult titles are hidden from search unless you enable them. Their artwork is blurred until you choose to show it. |
| Studios | Stored as creators with the role "Studio". |

**Manga** isn't a separate type. Track manga and light novels as **Books** (AniList can fill in book details if you enable it).

## Sources

Kitsu is the default (keyless). The official MyAnimeList API needs your own client ID. TMDB anime needs your TMDB key. AniList and Jikan are off by default for terms reasons. See [providers.md](providers.md#expansion-pack-2-20-anime-and-artwork-sources) for the terms review.

- **All anime sources:** search every ready source at once. Duplicates merge by cross IDs (AniList, MAL, Kitsu), and each result notes which other sources also have it.
- **Title language:** applied when you import. The other titles become alternative titles, so search still finds them.
- **Relations:** sequels, prequels, spin-offs, side stories and adaptations reported by the source become **suggestions** on the item page (Series & related). Nothing is linked until you accept it. A suggestion can only be linked when the target is already in your library.
- **Where to watch:** only links the source documents (Kitsu/Jikan streaming links), and only to hosts on the streaming allowlist. Subtitle and dub languages are shown, and links that match your audio preference are marked. Maybe Pile never guesses or builds streaming URLs. With a TMDB key, the TMDB/JustWatch availability panel also works for anime.

## Episode import edge cases

| Case | Behaviour |
| --- | --- |
| Unknown total, no episode list | Empty season with "count unknown"; add episodes by hand. |
| Still airing | Only aired episodes are listed (from the episode list or the next-episode number); the count stays unknown. |
| Movie / one-shot | A single episode. |
| More than 2,000 episodes reported | Treated as unknown (nothing generated). |
| Duplicate, missing or out-of-range numbers | Skipped. Gaps are filled with untitled episodes. |
| Long shows (Kitsu) | Up to 200 titled episodes are fetched; the rest are numbered. |

## MyAnimeList XML import

**Import → Trackers → MyAnimeList** takes the `.xml.gz` (or `.xml`) from MAL's *Export lists*. The import maps:

| MAL field | Maybe Pile |
| --- | --- |
| Status (Watching, Completed, On-Hold, Dropped, Plan to Watch) | Status |
| Score 1–10 | Rating 0.5–5★ (1:1) |
| Watched episodes | Checkmarks |
| Start and finish dates | Dates (MAL's `0000-00-00` means none) |
| Tags | Tags |
| Comments | Notes |
| Times watched | Extra runs |

Manga entries are skipped, with a message.

The file goes through the normal preview: counts, row messages, and a Skip / Keep both choice for duplicates (matched by MAL ID or title). The whole import is a batch you can undo from Import → History.

Security: the parser rejects files with a DOCTYPE or ENTITY declaration, so there is no entity expansion and no XXE. It decodes only the five XML entities and numeric references. Decompressed size is capped at 60 MB (the gzip header is checked first), and a file may hold at most 20,000 entries.

# Metadata providers

Online lookups are optional. The library works fully offline, and every item can be entered manually. Providers are only contacted when you search, import, refresh, check availability, or view a remote-only image.

## Chosen providers

These were researched in November 2026; terms change, so re-check them before shipping commercially. Sources consulted: [TMDB API terms](https://www.themoviedb.org/api-terms-of-use), [TMDB developer FAQ](https://developer.themoviedb.org/docs/faq), [TVmaze API](https://www.tvmaze.com/api) and its forum guidance on attribution, [Open Library developer docs](https://openlibrary.org/developers/api), and [IGDB API docs](https://api-docs.igdb.com/).

| Provider | Types | Auth | Rate limit used | Artwork caching | Attribution shown |
| --- | --- | --- | --- | --- | --- |
| **TMDB** | Movies, TV, where-to-watch | API key (v3) or read-access token (v4) | 35 req / 10 s (TMDB is commonly cited at ~40/10 s) | **Remote-only**: the terms aren't explicit about local caching in desktop apps, so we store the URL and proxy it | "This product uses the TMDB API but is not endorsed or certified by TMDB." Watch data: "provided by JustWatch via TMDB" |
| **TVmaze** | TV | none | 18 req / 10 s (documented ≥20/10 s) | Cached (CC BY-SA 4.0) | "TV data provided by TVmaze.com (CC BY-SA 4.0)." |
| **Open Library** | Books | none | 1 req / 1.1 s (unidentified clients: 1/s) | Cached | "Book data and covers from Open Library (openlibrary.org)." |
| **IGDB** | Games, store IDs | Twitch client ID + secret (client-credentials OAuth) | 4 req / s | **Remote-only** (caching terms unverified) | "Game data provided by IGDB.com." |
| **Wikidata** | Movies, TV, games, books | none | 10 req / 2 s | No artwork (Wikidata images are rarely covers) | "Data from Wikidata, available under CC0 (public domain)." |
| **AniList** | Anime (TV, movies), manga and light novels (books) | none | 25 req / min (documented 90/min, sometimes reduced to 30/min) | **Remote-only** | "Anime and manga data from AniList (anilist.co)." |

**Every media type has at least one keyless source** (tested): movies → Wikidata, AniList; TV → TVmaze, Wikidata, AniList; games → Wikidata; books → Open Library, Wikidata, AniList. In the Add dialog the default source for a type is the first *ready* provider in this order: TMDB, TVmaze, Open Library, Wikidata, AniList, IGDB, so keyless sources are used automatically until you add keys.

- **Wikidata** uses the documented MediaWiki Action API (`wbsearchentities`, `wbgetentities`). Search results are filtered to the requested type by *instance of* (P31) classes, with the item description as a fallback. Details map release date (earliest P577/P580, at the stated precision), directors/writers/cast, creators, developers/publishers, authors/illustrators/translators, genres, network, runtime (P2047), page count (P1104), ISBNs (P212/P957), and **exact identifiers**: IMDb (P345), TMDB (P4947 movie, P4983 TV), Steam app ID (P1733, which powers the Steam store link), AniList (P8729/P8731) and MyAnimeList (P4086/P4087). Wikidata has no season/episode lists; refresh a show from TVmaze for those.
- **AniList** uses its public GraphQL API (`https://graphql.anilist.co`, read-only queries need no token). Anime TV formats map to TV shows (one season with numbered episodes when the count is known), anime movies to movies, and manga/light novels to books. Only main credits are kept (director, original creator, "Story & Art" author, illustrator). Adult entries are excluded. Free for non-commercial use.

Not used: **Google Books** (evaluated in v1.1: without an API key the volumes endpoint returned HTTP 429 on every request from this environment, so it is not a usable keyless source), **OMDb** (redundant with TMDB, with a stricter free tier), **RAWG** (its terms require a prominent link-back on every page that uses its data), the **Steam Web API as a metadata provider** (IGDB's `external_games` already supplies exact Steam app IDs; Steam is used only as a *library source*, below). No provider is scraped, and only documented endpoints are used.

Non-commercial use: TMDB's free API is for non-commercial use. Distributing Maybe Pile commercially would need a TMDB agreement, or removing TMDB from the registry.

### Where attribution appears

Search results (under the list), the import preview ("Source: …"), the item's Source panel (provider and fetch time), Settings → Providers, and Settings → About. Watch availability always shows the JustWatch/TMDB attribution and an "may be incomplete or out of date" note.

## Configuring keys

- **TMDB:** create an account and request an API key at <https://www.themoviedb.org/settings/api>. Paste either the *API Key* or the *API Read Access Token* into Settings → Providers → TMDB.
- **IGDB:** create a Twitch developer application (<https://dev.twitch.tv/console/apps>, see <https://api-docs.igdb.com/#account-creation>), then paste the Client ID and Client Secret.
- **Developers / CI:** set `MAYBEPILE_TMDB_API_KEY`, `MAYBEPILE_IGDB_CLIENT_ID` and `MAYBEPILE_IGDB_CLIENT_SECRET`, or point `MAYBEPILE_PROVIDER_CONFIG` at a JSON file (`{"tmdb":{"apiKey":"…"},"igdb":{"clientId":"…","clientSecret":"…"}}`). Keep that file out of git; `provider-keys.local.json` is already ignored.

Key storage and protection are described in [security.md](security.md#secret-handling). Settings can only *replace* or *clear* a key; saved keys are never shown.

## Error handling

All requests go through `requestJson()`, which maps every failure to a `ProviderResult`:

| Situation | Result | What the user sees |
| --- | --- | --- |
| OK, valid JSON matching the schema | `ok` | Results |
| Missing or extra fields | tolerated by loose schemas, invalid values dropped (`finalizeMeta`) | Results with warnings in the preview (e.g. "Page count is unknown") |
| Invalid JSON, wrong content type, schema mismatch, response over 5 MB | `malformedResponse` | "…sent a response Maybe Pile couldn't understand." |
| DNS or connection failure | `networkError` | "Couldn't reach … Your library is unaffected and works offline." |
| Timeout (12 s, abortable) | `timeout` | "…took too long to respond." |
| 401/403 (or IGDB token 400) | `unauthorized` | "…rejected the API credentials." Link to Settings |
| 404 | `notFound` | "…has no record for that title any more." |
| 429 | `rateLimited` (honours `Retry-After`; the limiter blocks further calls) | "…is limiting requests right now. Try again in about N seconds." |
| 5xx / other | `unavailable` | "…is unavailable right now." |
| Missing key | `notConfigured` | Prompt to add a key or enter details manually |

Provider strings are never trusted as HTML or URLs: summaries are converted to plain text, URLs are checked against per-provider host allowlists, and IDs are validated (IMDb `tt\d{7,10}`, Steam numeric app ID, ISBN checksums).

## Links

- **IMDb:** shown whenever a valid IMDb ID is known: `https://www.imdb.com/title/tt…/`.
- **Where to watch** (movies/TV): fetched on demand from TMDB `/{movie|tv}/{id}/watch/providers` for the selected region. Only the `link` TMDB returns for that exact title and region is shown (it points to TMDB's JustWatch-powered watch page). Nothing is constructed or guessed, and JustWatch is never scraped. With no data, the panel says "Availability unavailable". Region defaults to Settings → Providers → Region and can be changed per item view.
- **Store links** (games): built only from IGDB `external_games` records whose source is Steam (1, numeric app ID → `https://store.steampowered.com/app/{id}/`), Microsoft (11) or PlayStation Store (36). For the last two, only the provider-supplied URL is used, and only if its host is allowlisted. No fuzzy title matching. Users can also enter official store URLs themselves; they are validated the same way.

## Live verification

`npm run smoke:providers` runs a real search and detail fetch against the **keyless** providers (TVmaze, Open Library, Wikidata, AniList). It is not part of the test suite. See [verification-log.md](verification-log.md) for the actual output from this build. TMDB and IGDB were **not** exercised live (no keys available); they are covered by mock-based tests only.

## How to add a provider

1. Create `src/providers/<name>.ts` exporting a `MetadataProvider` (see `src/providers/types.ts`):
   - `id`, `displayName`, `supports`, `attribution` (the provider's required wording), `requiresApiKey`, `keyFields`, `signupUrl`
   - `rateLimit` (stay below the documented limit), `cachingPolicy` (`cache-allowed` only if the terms permit), `artworkHosts`
   - `search()` and `fetchDetails()` using `requestJson(ctx.http, ctx.limiter, …, ZodSchema)` with **loose** schemas (`looseString`, `looseNumber`, `looseArray`), so missing fields don't break parsing
   - Build metadata with `finalizeMeta(type, {...})`, which truncates, validates dates/IDs and drops invalid values
   - Optionally `discoverLinks()` for availability links
2. Register it in `PROVIDERS` in `src/providers/registry.ts` and add its hosts to `OUTBOUND_HOSTS`. Add link/attribution hosts to `LINK_HOSTS`/`INFO_HOSTS` in `src/domain/links.ts` if needed.
3. If it needs keys, add environment-variable names to `ENV_VARS` in `secrets-service.ts`.
4. Add mock-based tests in `tests/unit/providers.test.ts`: success, missing fields, malformed JSON, 401, 404, 429 and the ID/URL mapping. **Never** call the live API from tests.
5. Document terms, limits, attribution and caching in this file and in the security doc's network section.

## Library sources (1.2)

Library sources import the games you **own**. They are separate from metadata providers and use the `LibrarySource` interface in `src/library-sources/types.ts`: `id`, `displayName`, `attribution`, `rateLimit`, `configure()`, `testConnection()`, `fetchEntries(ctx)`. Two are implemented: **Steam** and the **manual game list** (paste or upload). Both feed the same review, select, import and undo flow. User guide: [steam-import.md](steam-import.md).

### Steam Web API: terms findings (checked 23 Nov 2026)

Read on 23 November 2026 from the official pages. Valve's [Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms) say "Last updated July 2010".

| Topic | What the official pages say | What Maybe Pile does |
| --- | --- | --- |
| Rate limit | "You are limited to one hundred thousand (100,000) calls to the Steam Web API per day." No other limit is stated. | A sync uses 1–2 calls. The client-side limiter allows 10 requests / 10 s. 429s honour `Retry-After` (≤ 60 s, 3 retries max), then stop. |
| Keys | "keep your Steam Web API key confidential, and not … share it with any third party"; the licence is "personal to you". | No key ships with the app. Each user enters their own; it is stored with `safeStorage`, never shown, exported, backed up or logged. |
| Use of data | "only retrieve Steam Data about a Steam end user as requested by the end user"; "inform the end user about any Steam Data you will store". | Fetches only when the user presses Test / Load / Sync. The in-app help and steam-import.md list exactly what is stored (names, app ids, playtime, last-played dates, the account as typed). Nothing leaves the computer except calls to Steam. |
| Branding / endorsement | Must not appear "endorsed or affiliated with Valve or Steam"; links to Valve must not be `nofollow`. The separate "Network Branding Requirements" page was not reviewed. | Attribution text: "Data from the Steam Web API using your own key. Maybe Pile is not affiliated with or endorsed by Valve or Steam." No Steam logos are used. |
| Caching | No explicit caching rule. | The snapshot (no images) is stored locally so review works offline. Deleting the source deletes its snapshot. |
| Termination | Valve may change or end the API or a key "at any time … without notice". | Errors are mapped to recovery messages. The last snapshot and imported items stay. |

**Endpoints** (host `api.steampowered.com`, the public Web API host for user keys; Valve's partner docs show the same paths on `partner.steam-api.com` for publisher keys):

- `GET /ISteamUser/ResolveVanityURL/v1/?key=…&vanityurl=…&url_type=1`. Parameters are from the official docs. The response shape (`response.success` 1 / 42, `response.steamid`) is **not** documented on the page that was read; it is handled defensively and covered by mocks.
- `GET /IPlayerService/GetOwnedGames/v1/?key=…&steamid=…&include_appinfo=true&include_played_free_games=true&format=json`. The official page documents the parameters but **no response schema**. The fields used (`appid`, `name`, `playtime_forever`, `rtime_last_played`) are parsed with a lenient per-row schema, and unreadable rows are skipped and counted. A response without `games` and without `game_count` is treated as **private game details**; this is how private profiles behave in practice, but it isn't stated in the docs.

**Not used, by decision:** the Store `appdetails` endpoint (no official Valve page documents it or its terms), and icon/header image URLs built from `img_icon_url` (the URL format isn't documented by Valve). Non-games are therefore recognized by **name** (see steam-import.md), and rows use a placeholder icon. "Also fetch richer metadata" uses your configured game provider (IGDB or Wikidata), not Steam.

**Live verification:** no live Steam call was made while building this (no key available). See [verification-log.md](verification-log.md) and the manual steps in [steam-import.md](steam-import.md#manual-verification-with-your-own-key).

### Adding a library source

1. Implement `LibrarySource<Config>` in `src/library-sources/<name>.ts`. Use only documented APIs or files the user chooses, and never scrape. Network calls must go through `requestJson(http, limiter, …)` so they are rate-limited, size-capped, timed out and mockable.
2. Add its `kind` to the `library_sources.kind` CHECK in a **new** migration, and to `import_batches.kind` if it gets its own batch kind.
3. Wire it in `createFeatureServices` (`src/main/services/feature-services.ts`) and in `LibrarySourceService` (configuration, fetch job). Add its host to `OUTBOUND_HOSTS` and the [security](security.md#network) network list.
4. Write mock-based tests like `tests/integration/steam-import.test.ts`: success, auth failure, 429, malformed/partial data, large libraries.

# Steam library import

Bring the games you own on Steam into Maybe Pile, see which ones you have **not played yet**, and choose which to add. Nothing is added until you select games and confirm.

Maybe Pile uses only Valve's documented Steam Web API (`ISteamUser/ResolveVanityURL`, `IPlayerService/GetOwnedGames`) with **your own** API key. It does not scrape Steam pages, call undocumented endpoints, or ask for your Steam password.

## 1. Get your own Steam Web API key

1. Sign in at **<https://steamcommunity.com/dev/apikey>**.
2. Enter any domain name (for example `localhost`). It isn't used.
3. Copy the 32-character key.

Keys are personal. Valve's terms say to keep the key confidential and not share it with third parties, so Maybe Pile never ships, embeds or shares a key. Your key is:

- stored on this computer only, encrypted with your operating system's key store (Electron `safeStorage`: DPAPI, Keychain or libsecret/kwallet). If no key store is available (for example Linux without a keyring), Settings shows a warning;
- never shown again. Settings can only tell you that a key is saved, and lets you replace or forget it;
- never written to the library database, logs, JSON/CSV exports or `.mpbackup` backups. Re-enter it after restoring on a new computer.

## 2. Tell Maybe Pile which account

Any of these work (Settings → Providers → **Steam**, or **Import → Game libraries → Add Steam account**):

| You enter | Example |
| --- | --- |
| SteamID64 (17 digits) | `76561197960287930` |
| Profile URL | `https://steamcommunity.com/id/yourname` or `https://steamcommunity.com/profiles/7656119…` |
| Custom profile name | `yourname` |

Only `steamcommunity.com` URLs are accepted. Anything else is rejected with a message next to the field.

## 3. Make your game details visible

Steam only returns your library when your game details are **Public**:

1. In Steam, open **your profile → Edit Profile → Privacy Settings**.
2. Set **My profile** to **Public** and **Game details** to **Public**.
3. Wait a few minutes. Steam can take a while to apply the change.

You can set these back to Private after importing. Maybe Pile keeps the last snapshot it loaded.

Press **Test connection**. You'll see "Connected. Steam lists N game(s) for this account.", or a specific explanation of what to fix (wrong key, unknown custom name, private game details…).

## 4. Load, review and select

**Import → Game libraries → Load my Steam library.** A progress line shows what's happening, and you can **Cancel** at any time (the previous snapshot is kept). Large libraries (10,000+ games) load and filter quickly; the list is virtualized.

The review list shows **Unplayed** games by default: Steam recorded 0 minutes, the game isn't already in your pile, and you haven't ignored it. Other views: *Played*, *All*, *Already in pile*, *Ignored*, *New since last sync* and *No longer in library*. You can search by name and sort by name, playtime, last played or app id.

Obvious non-games (soundtracks, dedicated servers, SDKs and tools, demos, playtests, benchmarks) are hidden by default. Steam's owned-games API doesn't say what kind of app something is, so these are recognized **by name** (shown with the reason, such as "Soundtrack?"). Tick **Show non-game items** to see them.

Each row shows a placeholder icon, the name, platform, playtime ("Never played (per Steam)" for 0 minutes), last played date, and badges: **✓ In pile**, **⊘ Ignored**, **★ New**, **⚠ Possible duplicate** (same title as a game already in your pile, but not linked by app id). Badges always include text and an icon, not just colour.

> **About playtime.** Steam can miss offline play, games launched outside Steam, free weekends and Family Sharing. "Never played" means *Steam recorded no time*, not that you definitely never played it.

### Selecting with the keyboard or mouse

| Key | Action |
| --- | --- |
| ↑ / ↓, Page Up / Page Down, Home / End | Move the focus |
| Space | Select or deselect the focused game |
| Shift + ↑ / ↓ | Extend the selection |
| Ctrl/⌘ + A | Select every game shown (the current filter) |
| I | Ignore / un-ignore the focused game |
| O | Open the focused game on the Steam store (in your browser) |

With the mouse, click to toggle and Shift+click to select a range. The selection bar shows a live count, plus **Select all shown**, **Select all unplayed**, **Clear selection**, **Ignore selected** and **Import selected…**.

**Ignore** hides a game permanently (useful for tools, soundtracks and things you'll never play). Find ignored games under *Ignored* and un-ignore them there.

## 5. Import options and confirmation

- **Status**: Planned by default.
- **Tags**: `steam` is suggested.
- **List**: optionally add everything to one of your lists.
- **Import Steam playtime as progress**: for games with recorded playtime, sets progress tracking to *hours* and adds one history entry ("Imported from Steam playtime"). Off by default.
- **Also fetch richer metadata from my configured game provider**: looks each game up by exact title in your configured game provider (IGDB if you set it up, otherwise Wikidata) and fills **only empty** fields. It is slower and rate-limited, so at most 25 games are looked up per import.

**Review…** shows a summary ("Add 42 game(s) as Planned, tag “steam”"). Press **Import** to confirm.

Imports run in chunks of 200, each in its own transaction. If something fails, that chunk is rolled back completely (no half-created items, IDs or provenance rows) and the result lists exactly which games weren't added and why. Games already in your pile (same Steam app id) are always skipped, never duplicated.

The result screen shows counts for added, skipped and not added, with **View in Library** and **Undo this import**.

Imported games get the Steam app id (powering the "Steam store" link), the platform "PC (Steam)" (owned, with played set if Steam recorded time), and `provider = steam` provenance for the title. If you edit the title later, refreshes never silently overwrite it.

## 6. Sync again (re-sync)

**Sync again** fetches the library again and compares it with the last snapshot:

- **New since last sync**: shown in the *New* view.
- **Playtime changed**: for games in your pile, the "What changed?" dialog shows *your* recorded hours next to Steam's, defaulting to **Keep mine**. Choosing "Add Steam's as a new entry" records a new hours entry (history is never rewritten).
- **No longer in library** (refunded, removed or region-locked): pile items get a neutral "Not in Steam anymore" note on their page. **They are never deleted.**

Nothing in your pile changes during a sync.

## 7. Undo

Every import is recorded. **Import → Import history & undo** (or the result screen) lets you undo it. Undo removes only games you **haven't touched** since the import: no edits, rating, status change, notes, tags, progress or viewings. Changed items are kept and listed with the reason. Undo is available for 30 days by default (Settings → Features → *Keep import undo history*). After that the record is removed; the games stay.

## Offline

Without a connection, the Steam screen shows "Offline — showing the last snapshot (read-only)" and the sync button is disabled. You can still review, ignore and import from the snapshot.

## Other stores (GOG, Xbox, PlayStation, Epic…)

Use **Paste or upload a game list**: one title per line, or a CSV/TSV with a `title` (or `name`) column and an optional `platform` column. You get the same review, select, ignore, import and undo flow. Nothing is looked up online.

## Limits

- Steam allows 100,000 Web API calls per day per key. A sync uses one or two. Maybe Pile also limits itself to 10 requests per 10 seconds.
- On HTTP 429 Maybe Pile honours `Retry-After` (waiting up to 60 seconds, retrying at most 3 times) and otherwise stops with "Steam is limiting requests right now". On 5xx errors and timeouts it backs off (2 s, 4 s, 8 s).
- Game icons and store artwork aren't downloaded. Valve doesn't document a URL format for the icon hashes returned by `GetOwnedGames`, and the store's `appdetails` endpoint isn't part of the documented Web API, so rows show a placeholder.

## Troubleshooting

| Message | Fix |
| --- | --- |
| "Steam returned no games because this profile's game details are private." | Set **Game details** (and **My profile**) to Public, wait a few minutes, then press Sync again. |
| "Steam rejected the API key." | The key is wrong or was revoked. Get it again at steamcommunity.com/dev/apikey and paste it in Steam settings. |
| "Steam has no profile with the custom name …" | Check the name in your profile URL, or use your SteamID64. |
| "Steam is limiting requests right now." | Wait the time shown and try again. Your last snapshot is still available. |
| "Could not reach Steam." / "Steam did not answer in time." | Check your connection or proxy. Maybe Pile uses the system proxy settings. |
| "Steam sent a response Maybe Pile could not read." | Usually temporary on Steam's side. Try again later. |
| A game shows "Possible duplicate" | You added it by hand before. Open it with "View possible duplicate"; importing would add a second copy. |

## Manual verification with your own key

Live Steam calls were **not** made while building this feature (no key in the build environment). All behaviour is covered by tests against mocked Steam responses. To verify with your own account:

1. `npm start`, open **Import → Game libraries → Add Steam account**.
2. Enter your key and SteamID64 or profile URL, then **Test connection**. Expect "Connected. Steam lists N game(s)".
3. **Load my Steam library**: expect your unplayed games, with soundtracks and servers hidden.
4. Select two games with Space, press **Import selected… → Review… → Import**. Check them in the Library (tag `steam`, Steam store link).
5. Set Game details to Private on Steam, wait a few minutes and press **Sync again**. Expect the specific privacy explanation, and the snapshot is unchanged.
6. **Import history & undo → Undo…** removes the two games if you didn't touch them.

# Item templates (§14.5, Full mode)

Presets for Add → **From template**: media type, status, tags, moods, custom fields with defaults, an
optional checklist, optional list, and (games) a platform. Managed in Settings → Advanced; import/export as
`.mptemplate.json` (strict schema, version 1, 64 KB cap, no code).

- Starter templates (accepted by you): Board game night (a Game with platform “Tabletop”, players and play
  time fields), Book club pick, Weekend binge.
- **No new media type** is added for board games: templates + custom fields cover them.
- Applying a template creates missing custom-field definitions by name. Deleting a template never changes
  items created from it.

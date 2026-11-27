# Share page (§14.8, Full mode)

Library → select items → **Share page…** saves one self-contained HTML file (no hosting, no upload).

- Fields you choose: title (always), type, year, status, rating, cover. **Never**: notes, prices, loans,
  people, journal, private data. Adult-flagged items excluded unless you include them. Provider artwork
  excluded unless you opt in (with a rights notice); your own images are allowed.
- Security: all text HTML-escaped; no scripts or event handlers; images only as size-capped `data:` URIs
  (PNG/JPEG/WebP, ≤ 90 KB each, ≤ 8 MB total; SVG never); CSP
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  `referrer: no-referrer`. Works offline, readable without CSS (table with caption and scoped headers),
  light/dark via `prefers-color-scheme`. Tested with hostile titles (`tests/unit/pack21-domain.test.ts`).

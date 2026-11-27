/**
 * §14.8 Read-only share page: one self-contained static HTML file.
 *
 * Security of the output (tested):
 * - every text and attribute is HTML-escaped;
 * - no scripts, no event handlers, no remote resources (images are
 *   size-capped `data:` URIs or omitted);
 * - CSP: default-src 'none'; img-src data:; style-src 'unsafe-inline';
 *   base-uri 'none'; form-action 'none' — nothing can load or run;
 * - readable without CSS (table semantics, caption, scope, alt text);
 *   light/dark via prefers-color-scheme.
 * Contents are only the fields the user chose; notes, prices, loans, people
 * and private data are never available to this builder.
 */

export const SHARE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
export const MAX_IMAGE_DATA_URI = 90_000;
export const MAX_PAGE_IMAGES_BYTES = 8_000_000;

export interface ShareRow {
  title: string;
  type: string;
  status: string;
  rating: number | null;
  year: number | null;
  /** data:image/(png|jpeg|webp);base64,… or null */
  cover: string | null;
}

export type ShareField = 'type' | 'status' | 'rating' | 'year' | 'cover';

export function escapeHtml(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  );
}

const DATA_URI_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Only well-formed, size-capped image data URIs survive; anything else is dropped. */
export function safeDataUri(uri: string | null): string | null {
  if (!uri || uri.length > MAX_IMAGE_DATA_URI || !DATA_URI_RE.test(uri)) return null;
  return uri;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1b18;--muted:#5b574f;--line:#d9d5cc;--head:#f0ede6}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#f1eee8;--muted:#b8b2a6;--line:#3a3732;--head:#211f1c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px}
h1{font-size:1.6rem;margin:0 0 4px}
.meta{color:var(--muted);margin:0 0 20px}
table{width:100%;border-collapse:collapse}
caption{text-align:left;color:var(--muted);padding-bottom:8px}
th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:middle}
thead th{background:var(--head)}
img{width:48px;height:72px;object-fit:cover;border-radius:4px;display:block}
footer{color:var(--muted);font-size:.85rem;margin-top:24px}
`;

export function buildSharePage(input: {
  title: string;
  generatedOn: string;
  rows: readonly ShareRow[];
  fields: readonly ShareField[];
}): string {
  const f = new Set(input.fields);
  let budget = MAX_PAGE_IMAGES_BYTES;
  const head: string[] = [];
  if (f.has('cover')) head.push('<th scope="col"><span>Cover</span></th>');
  head.push('<th scope="col">Title</th>');
  if (f.has('type')) head.push('<th scope="col">Type</th>');
  if (f.has('year')) head.push('<th scope="col">Year</th>');
  if (f.has('status')) head.push('<th scope="col">Status</th>');
  if (f.has('rating')) head.push('<th scope="col">Rating</th>');
  const body = input.rows
    .map((r) => {
      const cells: string[] = [];
      if (f.has('cover')) {
        let img = safeDataUri(r.cover);
        if (img && img.length > budget) img = null;
        if (img) budget -= img.length;
        cells.push(`<td>${img ? `<img src="${img}" alt="Cover of ${escapeHtml(r.title)}">` : ''}</td>`);
      }
      cells.push(`<th scope="row">${escapeHtml(r.title)}</th>`);
      if (f.has('type')) cells.push(`<td>${escapeHtml(r.type)}</td>`);
      if (f.has('year')) cells.push(`<td>${r.year === null ? '' : String(Math.trunc(r.year))}</td>`);
      if (f.has('status')) cells.push(`<td>${escapeHtml(r.status)}</td>`);
      if (f.has('rating')) cells.push(`<td>${r.rating === null ? '' : `${Math.trunc(r.rating)}/10`}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('\n');
  const title = escapeHtml(input.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="meta">${input.rows.length} item${input.rows.length === 1 ? '' : 's'} · ${escapeHtml(input.generatedOn)}</p>
<table>
<caption>${title}</caption>
<thead><tr>${head.join('')}</tr></thead>
<tbody>
${body}
</tbody>
</table>
<footer>Made with Maybe Pile. This page works offline and contains no scripts or tracking.</footer>
</main>
</body>
</html>
`;
}

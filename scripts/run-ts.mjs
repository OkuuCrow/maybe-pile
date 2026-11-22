// Bundles a TypeScript dev script with esbuild and runs it in Node (dev-only tooling).
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <script.ts> [args]');
  process.exit(2);
}
const out = join(mkdtempSync(join(tmpdir(), 'mp-script-')), 'script.mjs');
await build({
  entryPoints: [resolve(entry)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  logLevel: 'warning',
});
await import(pathToFileURL(out).href);

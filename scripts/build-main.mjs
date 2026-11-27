// Bundles the Electron main process and the sandboxed preload with esbuild.
// Everything (zod, fflate, app code) is bundled, so the packaged app needs no node_modules.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
  legalComments: 'linked',
};

const targets = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs' },
  // Headless reminder helper (Linux scheduled mode runs it with ELECTRON_RUN_AS_NODE=1; no Electron APIs).
  {
    ...common,
    entryPoints: ['src/helper/reminder-check.ts'],
    outfile: 'dist/helper/reminder-check.cjs',
    sourcemap: false,
  },
  // Sandboxed preloads may only require('electron') — no other Node modules.
  {
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload/preload.cjs',
    sourcemap: false,
  },
];

if (watch) {
  const { context } = await import('esbuild');
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map((t) => build(t)));
}

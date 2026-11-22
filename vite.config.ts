import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Renderer build. Output is served by the app:// protocol in main with a strict CSP.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
    // Keep everything as files (CSP forbids inline scripts/styles and data: scripts).
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: { port: 5173, strictPort: true },
});

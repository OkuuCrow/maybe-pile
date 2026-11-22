// Development: Vite dev server for the renderer + esbuild watch for main/preload + Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = `http://localhost:${server.config.server.port}/`;

const build = spawn(process.execPath, ['scripts/build-main.mjs', '--watch'], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));

const env = { ...process.env, MAYBEPILE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(String(electronPath), ['.'], { stdio: 'inherit', env });
app.on('exit', async (code) => {
  build.kill();
  await server.close();
  process.exit(code ?? 0);
});

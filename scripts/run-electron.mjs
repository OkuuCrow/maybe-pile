// Launches Electron for `npm start` / `npm run dev`.
// Removes ELECTRON_RUN_AS_NODE, which some hosts (e.g. VS Code extension terminals)
// export and which would make Electron run as plain Node with no `app` API.
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(String(electronPath), ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));

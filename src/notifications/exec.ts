/** Real ExecFn: execFile with an argument array (no shell), hidden window, timeout, bounded output. */
import { execFile } from 'node:child_process';
import type { ExecFn } from './adapters/types';

export const nodeExec: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: opts.timeoutMs ?? 10_000,
        windowsHide: true,
        shell: false,
        maxBuffer: 1024 * 1024,
        env: opts.env ?? process.env,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err);
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

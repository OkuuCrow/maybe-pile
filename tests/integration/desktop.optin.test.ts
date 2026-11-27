/**
 * Opt-in desktop integration tests (skipped unless MAYBEPILE_DESKTOP_IT=1).
 * They touch the real OS: run them only on a machine where that is fine.
 *
 * Windows: registers a DISABLED task (unique name, never runs) from the exact XML the
 * installer generates, reads it back, deletes it and verifies it is gone.
 * Linux: checks gdbus/notify-send availability and, with MAYBEPILE_DESKTOP_IT_SHOW=1,
 * shows one real notification through the headless path.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeExec } from '../../src/notifications/exec';
import { buildWindowsTaskXml, parseWindowsTaskXml } from '../../src/notifications/registration/templates';
import { createLinuxNotifier, dbusEnv } from '../../src/notifications/adapters/linux';
import { existsSync } from 'node:fs';

const ON = process.env['MAYBEPILE_DESKTOP_IT'] === '1';

describe.skipIf(!ON || process.platform !== 'win32')('Windows Task Scheduler (real, opt-in)', () => {
  it('creates, reads back and removes a disabled per-user task without admin rights', async () => {
    const name = `MaybePile\\IntegrationTest-${Date.now()}`;
    const exe = 'C:\\Windows\\System32\\notepad.exe'; // never launched: the task is disabled
    const xml = buildWindowsTaskXml({
      exePath: exe,
      intervalMinutes: 15,
      startBoundary: '2026-01-01T00:00:00',
      author: 'Maybe Pile test',
    })
      .replace('<URI>\\MaybePile\\ReminderCheck</URI>', `<URI>\\${name}</URI>`)
      .replace('<Enabled>true</Enabled>\n    <Hidden>', '<Enabled>false</Enabled>\n    <Hidden>');
    const dir = mkdtempSync(join(tmpdir(), 'mp-it-'));
    const file = join(dir, 'task.xml');
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    try {
      const create = await nodeExec('schtasks', ['/Create', '/TN', name, '/XML', file, '/F'], {
        timeoutMs: 20_000,
      });
      expect(create.code, create.stderr).toBe(0);
      const q = await nodeExec('schtasks', ['/Query', '/TN', name, '/XML'], { timeoutMs: 20_000 });
      expect(q.code).toBe(0);
      expect(parseWindowsTaskXml(q.stdout)).toMatchObject({
        command: exe,
        args: '--reminder-check',
        intervalMinutes: 15,
        enabled: false,
      });
    } finally {
      await nodeExec('schtasks', ['/Delete', '/TN', name, '/F'], { timeoutMs: 20_000 });
      rmSync(dir, { recursive: true, force: true });
    }
    const gone = await nodeExec('schtasks', ['/Query', '/TN', name], { timeoutMs: 20_000 });
    expect(gone.code).not.toBe(0);
  });
});

describe.skipIf(!ON || process.platform !== 'linux')('Linux notification service (real, opt-in)', () => {
  it('probes the session bus; optionally shows one notification', async () => {
    const n = createLinuxNotifier({ exec: nodeExec, env: dbusEnv(process.env, existsSync) });
    const p = await n.probe();
    // Report, don't assume: a minimal system may have no daemon.
    expect(typeof p.available).toBe('boolean');
    if (p.available && process.env['MAYBEPILE_DESKTOP_IT_SHOW'] === '1') {
      const r = await n.show(
        {
          key: 'it',
          category: 'custom',
          kind: 'single',
          title: 'Maybe Pile test',
          body: 'Integration test notification',
          itemId: null,
          urgency: 'low',
          scheduledFor: new Date().toISOString(),
          actions: [],
          memberKeys: [],
          members: [],
          openUrl: 'maybepile://open',
        },
        { sound: false },
      );
      expect(r.status).toBe('delivered');
    }
  });
});

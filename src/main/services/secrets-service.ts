/**
 * Provider API keys. Kept out of the database (so they are never in exports or
 * backups), out of logs, and out of the renderer: the renderer may only submit
 * a value or ask whether one is set.
 *
 * Storage: `secrets.json` in userData, values encrypted with Electron
 * `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
 * Linux). If OS encryption is unavailable (e.g. Linux without a keyring, where
 * Electron reports the `basic_text` backend), values are stored base64-encoded
 * and Settings shows a warning. Developers can also supply keys via environment
 * variables or a local JSON file (see docs/providers.md).
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicWrite } from './fs-safe';
import type { Logger } from './logger';
import type { ProviderKeys } from '../../providers/types';

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

const FileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({ enc: z.enum(['os', 'plain']), data: z.string() })),
});

export type KeyField = 'apiKey' | 'clientId' | 'clientSecret';

const ENV_VARS: Record<string, Partial<Record<KeyField, string>>> = {
  tmdb: { apiKey: 'MAYBEPILE_TMDB_API_KEY' },
  igdb: { clientId: 'MAYBEPILE_IGDB_CLIENT_ID', clientSecret: 'MAYBEPILE_IGDB_CLIENT_SECRET' },
};

const DevConfigSchema = z.record(
  z.string(),
  z.object({ apiKey: z.string(), clientId: z.string(), clientSecret: z.string() }).partial(),
);

export class SecretsService {
  private entries: Record<string, { enc: 'os' | 'plain'; data: string }> = {};
  private devConfig: z.infer<typeof DevConfigSchema> = {};

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
    private readonly log: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.load();
  }

  get storage(): 'os-encrypted' | 'plaintext-fallback' {
    return this.cipher.isEncryptionAvailable() ? 'os-encrypted' : 'plaintext-fallback';
  }

  private load(): void {
    if (existsSync(this.file)) {
      try {
        const parsed = FileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
        if (parsed.success) this.entries = parsed.data.entries;
        else this.log.warn('secrets.invalidFile');
      } catch {
        this.log.warn('secrets.unreadable');
      }
    }
    const devPath = this.env['MAYBEPILE_PROVIDER_CONFIG'];
    if (devPath && existsSync(devPath)) {
      try {
        const parsed = DevConfigSchema.safeParse(JSON.parse(readFileSync(devPath, 'utf8')));
        if (parsed.success) this.devConfig = parsed.data;
      } catch {
        this.log.warn('secrets.devConfigUnreadable');
      }
    }
  }

  private persist(): void {
    atomicWrite(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2), {
      overwrite: true,
    });
  }

  set(providerId: string, field: KeyField, value: string): void {
    const key = `${providerId}.${field}`;
    if (value === '') {
      this.entries = Object.fromEntries(Object.entries(this.entries).filter(([k]) => k !== key));
    } else if (this.cipher.isEncryptionAvailable()) {
      this.entries[key] = { enc: 'os', data: this.cipher.encrypt(value).toString('base64') };
    } else {
      this.entries[key] = { enc: 'plain', data: Buffer.from(value, 'utf8').toString('base64') };
    }
    this.persist();
    this.log.info('secrets.set', { providerId, field, cleared: value === '' });
  }

  private getStored(providerId: string, field: KeyField): string | undefined {
    const e = this.entries[`${providerId}.${field}`];
    if (!e) return undefined;
    try {
      const buf = Buffer.from(e.data, 'base64');
      return e.enc === 'os' ? this.cipher.decrypt(buf) : buf.toString('utf8');
    } catch {
      this.log.warn('secrets.decryptFailed', { providerId, field });
      return undefined;
    }
  }

  /** Main-process only. Precedence: environment variable → dev config file → stored value. */
  keysFor(providerId: string): ProviderKeys {
    const out: ProviderKeys = {};
    for (const field of ['apiKey', 'clientId', 'clientSecret'] as const) {
      const envName = ENV_VARS[providerId]?.[field];
      const v =
        (envName ? this.env[envName] : undefined) ??
        this.devConfig[providerId]?.[field] ??
        this.getStored(providerId, field);
      if (v) out[field] = v;
    }
    return out;
  }

  /** What the renderer may learn: only whether each key is set. */
  isSet(providerId: string, fields: readonly KeyField[]): Partial<Record<KeyField, boolean>> {
    const keys = this.keysFor(providerId);
    return Object.fromEntries(fields.map((f) => [f, Boolean(keys[f])]));
  }
}

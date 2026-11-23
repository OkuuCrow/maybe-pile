/**
 * Structured JSON-lines logger with size-capped rotation and redaction.
 *
 * Policy: log event names, IDs, counts and error codes, never titles, notes,
 * API keys, tokens or full paths. Redaction is applied when writing *and*
 * again when exporting the diagnostic log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

const SENSITIVE_KEY =
  /(key|token|secret|password|passphrase|authorization|notes?|title|description|query|cookie|email)/i;
const MAX_STRING = 300;

/** Values that look like secrets even under innocuous keys. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted]'], // JWT (TMDB v4 tokens)
  [/\b((?:api_key|apikey|client_secret|client_id|access_token|token|key)=)[^&\s"]+/gi, '$1[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
  [/\b[a-f0-9]{32}\b/gi, '[redacted]'], // TMDB v3 key shape; also Steam Web API keys
  [/\b7656119\d{10}\b/g, '[steamid]'], // SteamID64
  [/\b[a-z0-9]{30}\b/g, '[redacted]'], // Twitch client id/secret shape
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  // Absolute paths → keep only the last segment.
  out = out.replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'<>|]+[\\/])+([^\s"'<>|\\/]+)/g, '…/$1');
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined)
    return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export class FileLogger implements Logger {
  private readonly file: string;
  constructor(
    private readonly dir: string,
    private readonly maxBytes = 1_000_000,
    private readonly keep = 3,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'maybepile.log');
  }

  private write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      event,
      ...(data ? { data: redact(data) } : {}),
    });
    try {
      this.rotateIfNeeded();
      appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      // Logging must never crash the app; there is nowhere else to report this.
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file) || statSync(this.file).size < this.maxBytes) return;
    const oldest = join(this.dir, `maybepile.${this.keep}.log`);
    if (existsSync(oldest)) rmSync(oldest);
    for (let i = this.keep - 1; i >= 1; i--) {
      const f = join(this.dir, `maybepile.${i}.log`);
      if (existsSync(f)) renameSync(f, join(this.dir, `maybepile.${i + 1}.log`));
    }
    renameSync(this.file, join(this.dir, 'maybepile.1.log'));
  }

  debug(event: string, data?: Record<string, unknown>): void {
    if (process.env['MAYBEPILE_DEBUG'] === '1') this.write('debug', event, data);
  }
  info(event: string, data?: Record<string, unknown>): void {
    this.write('info', event, data);
  }
  warn(event: string, data?: Record<string, unknown>): void {
    this.write('warn', event, data);
  }
  error(event: string, data?: Record<string, unknown>): void {
    this.write('error', event, data);
  }

  /** Concatenated logs (oldest first) with redaction re-applied line by line. */
  exportRedacted(): string {
    const files = [];
    for (let i = this.keep; i >= 1; i--) files.push(join(this.dir, `maybepile.${i}.log`));
    files.push(this.file);
    const lines: string[] = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          lines.push(JSON.stringify(redact(JSON.parse(line))));
        } catch {
          lines.push(JSON.stringify({ unparsable: redactString(line) }));
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

export class MemoryLogger implements Logger {
  readonly lines: { level: LogLevel; event: string; data?: unknown }[] = [];
  private push(level: LogLevel, event: string, data?: Record<string, unknown>) {
    this.lines.push({ level, event, ...(data ? { data: redact(data) } : {}) });
  }
  debug(e: string, d?: Record<string, unknown>) {
    this.push('debug', e, d);
  }
  info(e: string, d?: Record<string, unknown>) {
    this.push('info', e, d);
  }
  warn(e: string, d?: Record<string, unknown>) {
    this.push('warn', e, d);
  }
  error(e: string, d?: Record<string, unknown>) {
    this.push('error', e, d);
  }
  text(): string {
    return JSON.stringify(this.lines);
  }
}

/**
 * RFC 4180 CSV writing and parsing.
 *
 * Formula-injection defence: any cell whose first character is one of
 * `= + - @`, TAB or CR is prefixed with a single quote (') so spreadsheet apps
 * treat it as text. The importer strips exactly one leading quote again when the
 * following character is one of those triggers, so values round-trip.
 */

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function neutralizeFormula(value: string): string {
  const first = value.charAt(0);
  return FORMULA_TRIGGERS.has(first) ? `'${value}` : value;
}

export function restoreFormula(value: string): string {
  if (value.length >= 2 && value.charAt(0) === "'" && FORMULA_TRIGGERS.has(value.charAt(1))) {
    return value.slice(1);
  }
  return value;
}

export function escapeCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = neutralizeFormula(typeof value === 'string' ? value : String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null)[])[],
  bom: boolean,
): string {
  const lines = [header.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))];
  return `${bom ? '﻿' : ''}${lines.join('\r\n')}\r\n`;
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** Parses RFC 4180 CSV (CRLF or LF line endings, optional BOM). Throws CsvParseError on malformed quoting. */
export function parseCsv(input: string, maxRows = 200_000): string[][] {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = '';
    // Skip completely empty lines.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new CsvParseError(`Too many rows (limit ${maxRows}).`, line);
  };
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        const next = s[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new CsvParseError('Unexpected character after closing quote.', line);
        }
        continue;
      }
      if (c === '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field !== '') throw new CsvParseError('Quote in the middle of an unquoted field.', line);
      inQuotes = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      pushRow();
      line++;
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (inQuotes) throw new CsvParseError('File ends inside a quoted field (truncated?).', line);
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/** Joins list values for a single CSV cell. "; " is used because commas are common in titles. */
export const LIST_DELIMITER = '; ';
export function joinList(values: readonly string[]): string {
  return values.map((v) => v.replace(/;/g, ',')).join(LIST_DELIMITER);
}
export function splitList(cell: string): string[] {
  return cell
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

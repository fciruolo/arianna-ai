// Our own CSV reader for bank statements (D-183): RFC 4180 quoting, CRLF, LF or
// CR line ends, a UTF-8 BOM, the separator guessed among `;`, `,` and tab, and
// the text decoded as UTF-8 when it is valid UTF-8, otherwise as Windows-1252.
// No third-party code touches the file.
import { FinanceImportError, limitsWith } from './table.ts';
import type { ReadLimits, SheetRow } from './table.ts';

export type CsvSeparator = ';' | ',' | '\t';
export type CsvEncoding = 'utf-8' | 'windows-1252';

export interface CsvReadOptions {
  /** Skip the guess. */
  separator?: CsvSeparator;
  limits?: Partial<ReadLimits>;
}

export interface CsvTable {
  rows: SheetRow[];
  separator: CsvSeparator;
  encoding: CsvEncoding;
}

const SEPARATORS: readonly CsvSeparator[] = [';', ',', '\t'];

// Windows-1252 differs from Latin-1 only in 0x80-0x9F; the five holes map to
// the same code point, as the WHATWG decoder does.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

function decodeCp1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk = 8192;
  for (let start = 0; start < bytes.length; start += chunk) {
    const codes: number[] = [];
    for (const byte of bytes.subarray(start, start + chunk)) {
      codes.push(byte >= 0x80 && byte <= 0x9f ? (CP1252_HIGH[byte - 0x80] ?? byte) : byte);
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

/** The file as text: UTF-8 (BOM dropped) when valid, otherwise Windows-1252. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new FinanceImportError('unsupported-encoding', 'UTF-16 text is not supported: save the file as UTF-8 CSV');
  }
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), encoding: 'utf-8' };
  } catch {
    return { text: decodeCp1252(body), encoding: 'windows-1252' };
  }
}

interface ParseState {
  rows: SheetRow[];
  /** Stop after this many records (the separator guess reads only the start). */
  stopAfter: number;
}

/**
 * Splits the text into records. Blank records are dropped; `line` is the
 * physical line a record starts on. A quote opens a quoted field only at the
 * start of the field; elsewhere it is an ordinary character.
 */
function parse(text: string, separator: CsvSeparator, limits: ReadLimits, stopAfter: number): SheetRow[] {
  const state: ParseState = { rows: [], stopAfter };
  let line = 1;
  let recordLine = 1;
  let field = '';
  let fields: string[] = [];
  let quoted = false;
  let fieldStart = true;
  let i = 0;

  const pushField = (): void => {
    if (field.length > limits.maxCellChars) {
      throw new FinanceImportError('cell-too-long', 'A cell is too long', recordLine);
    }
    fields.push(field);
    if (fields.length > limits.maxColumns) {
      throw new FinanceImportError('too-many-columns', 'Too many columns', recordLine);
    }
    field = '';
    fieldStart = true;
  };
  const pushRecord = (): void => {
    pushField();
    if (fields.some((value) => value.trim() !== '')) {
      if (state.rows.length >= limits.maxRows) {
        throw new FinanceImportError('too-many-rows', `The file has more than ${String(limits.maxRows)} rows`);
      }
      state.rows.push({ line: recordLine, cells: fields });
    }
    fields = [];
  };

  while (i < text.length) {
    if (state.rows.length >= state.stopAfter) return state.rows;
    const char = text[i] ?? '';
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line += 1;
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && fieldStart && field.trim() === '') {
      // Spaces before an opening quote are tolerated and dropped.
      quoted = true;
      fieldStart = false;
      field = '';
      i += 1;
      continue;
    }
    if (char === separator) {
      pushField();
      i += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      pushRecord();
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    if (char !== ' ') fieldStart = false;
    field += char;
    i += 1;
  }
  if (quoted) throw new FinanceImportError('unterminated-quote', 'A quoted cell is never closed', recordLine);
  if (field !== '' || fields.length > 0) pushRecord();
  return state.rows;
}

/**
 * The separator that splits the start of the file into the most rows with the
 * same number of cells: preamble lines of the bank and commas inside Italian
 * amounts (`-1,50`) weigh less than the real columns.
 */
export function guessSeparator(text: string, limits: ReadLimits): CsvSeparator {
  const sample = text.slice(0, 64 * 1024);
  let best: CsvSeparator = ';';
  let bestScore = 0;
  for (const separator of SEPARATORS) {
    let rows: SheetRow[];
    try {
      rows = parse(sample, separator, { ...limits, maxRows: Number.MAX_SAFE_INTEGER }, 50);
    } catch {
      continue;
    }
    const counts = new Map<number, number>();
    for (const row of rows) {
      if (row.cells.length > 1) counts.set(row.cells.length, (counts.get(row.cells.length) ?? 0) + 1);
    }
    let score = 0;
    for (const [width, rowsWithWidth] of counts) score = Math.max(score, width * rowsWithWidth);
    if (score > bestScore) {
      best = separator;
      bestScore = score;
    }
  }
  return best;
}

/** Reads a CSV file into non-empty rows of text cells. */
export function readCsv(bytes: Uint8Array, options: CsvReadOptions = {}): CsvTable {
  const limits = limitsWith(options.limits);
  if (bytes.length === 0) throw new FinanceImportError('empty', 'The file is empty');
  if (bytes.length > limits.maxFileBytes) {
    throw new FinanceImportError('too-large', `The file is larger than ${String(limits.maxFileBytes)} bytes`);
  }
  const { text, encoding } = decodeText(bytes);
  const separator = options.separator ?? guessSeparator(text, limits);
  const rows = parse(text, separator, limits, Number.POSITIVE_INFINITY);
  if (rows.length === 0) throw new FinanceImportError('empty', 'The file has no rows');
  return { rows, separator, encoding };
}

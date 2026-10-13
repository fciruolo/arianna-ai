// Our own .xlsx reader for bank statements (D-183), without libraries: the zip
// is read by `zip.ts`, and only the workbook, its relationships, the shared
// strings, the styles and one worksheet are decompressed. Cells come back as
// text, numbers or days (numbers whose style is a date format).
import { FinanceImportError, isBlank, limitsWith } from './table.ts';
import type { Cell, ReadLimits, SheetRow } from './table.ts';
import type { Day } from './types.ts';
import { xmlEvents } from './xml.ts';
import { ZipReader } from './zip.ts';

export interface XlsxReadOptions {
  /** The sheet by name or by 0-based position; the first one by default. */
  sheet?: string | number;
  limits?: Partial<ReadLimits>;
}

export interface XlsxTable {
  rows: SheetRow[];
  /** The name of the sheet read. */
  sheet: string;
  /** All sheet names, in workbook order. */
  sheets: string[];
  /** The workbook counts serial days from 1904 (old Mac Excel). */
  date1904: boolean;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

/** An old binary Excel file (or an encrypted .xlsx, which uses the same container). */
export function isOleFile(bytes: Uint8Array): boolean {
  return startsWith(bytes, OLE_MAGIC);
}

export function isZipFile(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP_MAGIC);
}

export function xlsError(): FinanceImportError {
  return new FinanceImportError(
    'xls',
    'Old .xls files (or password-protected workbooks) cannot be read: open the file in Excel or Numbers and save it as .xlsx or CSV',
  );
}

const MS_PER_DAY = 86_400_000;

/**
 * An Excel serial day as a calendar day. In the 1900 system serial 1 is
 * 1900-01-01 and serial 60 is the 29 February 1900 Excel invents (Lotus bug),
 * which is refused; in the 1904 system serial 0 is 1904-01-01.
 */
export function excelSerialToDay(serial: number, date1904 = false): Day | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (whole > 2_958_465) return null;
  let ms: number;
  if (date1904) {
    if (whole < 0) return null;
    ms = Date.UTC(1904, 0, 1) + whole * MS_PER_DAY;
  } else {
    if (whole < 1 || whole === 60) return null;
    ms = whole < 60 ? Date.UTC(1899, 11, 31) + whole * MS_PER_DAY : Date.UTC(1899, 11, 30) + whole * MS_PER_DAY;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

// Built-in number formats that show a date (ECMA-376 18.8.30, plus the East Asian ones).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** True when a custom format code shows a day, month-and-year or year. */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .split(';')[0] ?? '';
  return /[dy]/i.test(stripped);
}

/** Column letters (`A`, `AB`) of a cell reference as a 0-based index. */
export function columnIndex(reference: string): number | null {
  const letters = /^([A-Z]{1,3})\d*$/.exec(reference.toUpperCase());
  if (letters === null) return null;
  let index = 0;
  for (const letter of letters[1] ?? '') index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FinanceImportError('bad-xlsx', 'A part of the workbook is not valid UTF-8');
  }
}

interface Workbook {
  date1904: boolean;
  sheets: { name: string; relationship: string }[];
}

function readWorkbook(xml: string): Workbook {
  const workbook: Workbook = { date1904: false, sheets: [] };
  for (const event of xmlEvents(xml)) {
    if (event.type !== 'open') continue;
    if (event.name === 'workbookPr') {
      const value = event.attrs.date1904;
      workbook.date1904 = value === '1' || value === 'true';
    } else if (event.name === 'sheet') {
      const relationship = event.attrs.id;
      if (relationship !== undefined) workbook.sheets.push({ name: event.attrs.name ?? '', relationship });
    }
  }
  return workbook;
}

function readRelationships(xml: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const event of xmlEvents(xml)) {
    if (event.type === 'open' && event.name === 'Relationship' && event.attrs.Id !== undefined && event.attrs.Target !== undefined) {
      targets.set(event.attrs.Id, event.attrs.Target);
    }
  }
  return targets;
}

/** The zip path of a relationship target of `xl/workbook.xml`. */
function resolveTarget(target: string): string {
  const parts: string[] = target.startsWith('/') ? [] : ['xl'];
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function readSharedStrings(xml: string, limits: ReadLimits): string[] {
  const strings: string[] = [];
  let current: string[] | null = null;
  let inText = false;
  let phonetic = 0;
  for (const event of xmlEvents(xml)) {
    if (event.type === 'open') {
      if (event.name === 'si') {
        current = [];
        if (event.selfClosing) {
          strings.push('');
          current = null;
        }
      } else if (event.name === 'rPh' && !event.selfClosing) {
        phonetic += 1;
      } else if (event.name === 't' && !event.selfClosing) {
        inText = true;
      }
    } else if (event.type === 'close') {
      if (event.name === 'si' && current !== null) {
        const text = current.join('');
        if (text.length > limits.maxCellChars) throw new FinanceImportError('cell-too-long', 'A cell is too long');
        strings.push(text);
        current = null;
      } else if (event.name === 'rPh') {
        phonetic -= 1;
      } else if (event.name === 't') {
        inText = false;
      }
    } else if (inText && phonetic === 0 && current !== null) {
      current.push(event.text);
    }
  }
  return strings;
}

/** For each cell style index, whether it shows a date. */
function readDateStyles(xml: string): boolean[] {
  const custom = new Map<number, string>();
  const styles: boolean[] = [];
  let inCellXfs = false;
  const events = [...xmlEvents(xml)];
  for (const event of events) {
    if (event.type === 'open' && event.name === 'numFmt') {
      const id = Number(event.attrs.numFmtId);
      if (Number.isInteger(id)) custom.set(id, event.attrs.formatCode ?? '');
    }
  }
  for (const event of events) {
    if (event.type === 'open' && event.name === 'cellXfs' && !event.selfClosing) inCellXfs = true;
    else if (event.type === 'close' && event.name === 'cellXfs') inCellXfs = false;
    else if (event.type === 'open' && event.name === 'xf' && inCellXfs) {
      const id = Number(event.attrs.numFmtId ?? '0');
      const code = custom.get(id);
      styles.push(code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id));
    }
  }
  return styles;
}

interface SheetContext {
  shared: string[];
  dateStyles: boolean[];
  date1904: boolean;
  limits: ReadLimits;
}

function cellValue(type: string, raw: string, inline: string | null, isDate: boolean, context: SheetContext, line: number): Cell {
  switch (type) {
    case 's': {
      const index = Number(raw);
      const text = Number.isInteger(index) ? context.shared[index] : undefined;
      if (text === undefined) throw new FinanceImportError('bad-xlsx', 'A cell refers to a missing shared string', line);
      return text;
    }
    case 'inlineStr':
      return inline ?? '';
    case 'str':
    case 'e':
      return raw;
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'd':
      return /^\d{4}-\d{2}-\d{2}/.test(raw) ? { day: raw.slice(0, 10) } : raw;
    default: {
      if (raw.trim() === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new FinanceImportError('bad-xlsx', 'A numeric cell is not a number', line);
      if (isDate) {
        const day = excelSerialToDay(value, context.date1904);
        return day === null ? value : { day };
      }
      return value;
    }
  }
}

function readSheet(xml: string, context: SheetContext): SheetRow[] {
  const { limits } = context;
  const rows: SheetRow[] = [];
  let rowNumber = 0;
  let cells: Cell[] | null = null;
  let column = -1;
  let cell: { type: string; style: number; raw: string; inline: string[] | null } | null = null;
  let capture: 'v' | 't' | null = null;
  let inInline = false;

  for (const event of xmlEvents(xml)) {
    if (event.type === 'open') {
      if (event.name === 'row') {
        const r = Number(event.attrs.r);
        rowNumber = Number.isInteger(r) && r > rowNumber ? r : rowNumber + 1;
        cells = [];
        column = -1;
        if (event.selfClosing) cells = null;
      } else if (event.name === 'c' && cells !== null) {
        const reference = event.attrs.r;
        const index = reference === undefined ? null : columnIndex(reference);
        column = index !== null && index > column ? index : column + 1;
        if (column >= limits.maxColumns) throw new FinanceImportError('too-many-columns', 'Too many columns', rowNumber);
        const style = Number(event.attrs.s ?? '0');
        cell = { type: event.attrs.t ?? 'n', style: Number.isInteger(style) ? style : 0, raw: '', inline: null };
        if (event.selfClosing) cell = null;
      } else if (cell !== null && event.name === 'v' && !event.selfClosing) {
        capture = 'v';
      } else if (cell !== null && event.name === 'is') {
        inInline = !event.selfClosing;
        cell.inline = [];
      } else if (cell !== null && inInline && event.name === 't' && !event.selfClosing) {
        capture = 't';
      }
    } else if (event.type === 'close') {
      if (event.name === 'v' || event.name === 't') {
        capture = null;
      } else if (event.name === 'is') {
        inInline = false;
      } else if (event.name === 'c' && cell !== null && cells !== null) {
        const value = cellValue(cell.type, cell.raw, cell.inline?.join('') ?? null, context.dateStyles[cell.style] ?? false, context, rowNumber);
        if (typeof value === 'string' && value.length > limits.maxCellChars) {
          throw new FinanceImportError('cell-too-long', 'A cell is too long', rowNumber);
        }
        while (cells.length < column) cells.push(null);
        cells[column] = value;
        cell = null;
      } else if (event.name === 'row' && cells !== null) {
        if (!cells.every((value) => isBlank(value))) {
          if (rows.length >= limits.maxRows) {
            throw new FinanceImportError('too-many-rows', `The sheet has more than ${String(limits.maxRows)} rows`);
          }
          rows.push({ line: rowNumber, cells });
        }
        cells = null;
      }
    } else if (cell !== null && capture === 'v') {
      cell.raw += event.text;
    } else if (cell !== null && capture === 't') {
      cell.inline?.push(event.text);
    }
  }
  return rows;
}

/** Reads one worksheet of an .xlsx file into non-empty rows. */
export function readXlsx(bytes: Uint8Array, options: XlsxReadOptions = {}): XlsxTable {
  const limits = limitsWith(options.limits);
  if (bytes.length === 0) throw new FinanceImportError('empty', 'The file is empty');
  if (bytes.length > limits.maxFileBytes) {
    throw new FinanceImportError('too-large', `The file is larger than ${String(limits.maxFileBytes)} bytes`);
  }
  if (isOleFile(bytes)) throw xlsError();
  if (!isZipFile(bytes)) throw new FinanceImportError('type-mismatch', 'The file is not an .xlsx workbook');

  const zip = new ZipReader(bytes, limits.maxZipEntries, limits.maxUnzippedBytes);
  const part = (name: string): string => decodeUtf8(zip.read(name));
  if (!zip.has('xl/workbook.xml')) throw new FinanceImportError('bad-xlsx', 'The archive has no workbook');

  const workbook = readWorkbook(part('xl/workbook.xml'));
  if (workbook.sheets.length === 0) throw new FinanceImportError('no-sheet', 'The workbook has no sheets');
  const chosen =
    typeof options.sheet === 'number'
      ? workbook.sheets[options.sheet]
      : options.sheet === undefined
        ? workbook.sheets[0]
        : workbook.sheets.find((sheet) => sheet.name === options.sheet);
  if (chosen === undefined) throw new FinanceImportError('no-sheet', 'The requested sheet does not exist');

  const relationships = zip.has('xl/_rels/workbook.xml.rels') ? readRelationships(part('xl/_rels/workbook.xml.rels')) : new Map<string, string>();
  const target = relationships.get(chosen.relationship);
  if (target === undefined) throw new FinanceImportError('bad-xlsx', 'The sheet has no part in the archive');
  const sheetPath = resolveTarget(target);
  if (!zip.has(sheetPath)) throw new FinanceImportError('bad-xlsx', 'The sheet has no part in the archive');

  const shared = zip.has('xl/sharedStrings.xml') ? readSharedStrings(part('xl/sharedStrings.xml'), limits) : [];
  const dateStyles = zip.has('xl/styles.xml') ? readDateStyles(part('xl/styles.xml')) : [];
  const rows = readSheet(part(sheetPath), { shared, dateStyles, date1904: workbook.date1904, limits });
  if (rows.length === 0) throw new FinanceImportError('empty', 'The sheet has no rows');
  return { rows, sheet: chosen.name, sheets: workbook.sheets.map((sheet) => sheet.name), date1904: workbook.date1904 };
}

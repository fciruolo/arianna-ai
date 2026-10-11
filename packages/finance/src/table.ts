// The shape both readers (CSV and .xlsx) return, the limits they enforce and
// the error they throw (D-183). Error messages never quote the file's content:
// at most a line number, so a log or a toast cannot leak a movement.
import type { Day } from './types.ts';

/** A cell Excel marked as a date, already converted to a calendar day. */
export interface DateCell {
  readonly day: Day;
}

/** Text (CSV, or an Excel string), a number (Excel), a date (Excel), or nothing. */
export type Cell = string | number | DateCell | null;

/** One non-empty row of the file with its 1-based line (CSV) or row number (Excel). */
export interface SheetRow {
  line: number;
  cells: Cell[];
}

export interface ReadLimits {
  /** Bytes of the file as uploaded. */
  maxFileBytes: number;
  /** Non-empty rows kept from the file. */
  maxRows: number;
  /** Cells in one row. */
  maxColumns: number;
  /** Characters of one cell. */
  maxCellChars: number;
  /** Bytes decompressed from an .xlsx, all parts together (zip bombs). */
  maxUnzippedBytes: number;
  /** Entries in the central directory of an .xlsx. */
  maxZipEntries: number;
}

export const DEFAULT_LIMITS: Readonly<ReadLimits> = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 200,
  maxCellChars: 10_000,
  maxUnzippedBytes: 64 * 1024 * 1024,
  maxZipEntries: 2_000,
});

export function limitsWith(overrides: Partial<ReadLimits> | undefined): ReadLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/** Why a file cannot be read at all; the UI translates the code. */
export type ImportErrorCode =
  | 'empty'
  | 'too-large'
  | 'too-many-rows'
  | 'too-many-columns'
  | 'cell-too-long'
  | 'unterminated-quote'
  | 'unsupported-encoding'
  | 'unsupported-type'
  | 'type-mismatch'
  | 'xls'
  | 'bad-zip'
  | 'encrypted'
  | 'zip64'
  | 'bad-path'
  | 'unzipped-too-large'
  | 'bad-xlsx'
  | 'bad-xml'
  | 'no-sheet'
  | 'no-header'
  | 'unknown-columns'
  | 'profile-mismatch';

export class FinanceImportError extends Error {
  readonly code: ImportErrorCode;
  /** The line (CSV) or row (Excel) the problem is on, when there is one. */
  readonly line: number | null;

  constructor(code: ImportErrorCode, message: string, line: number | null = null) {
    super(line === null ? message : `${message} (line ${String(line)})`);
    this.name = 'FinanceImportError';
    this.code = code;
    this.line = line;
  }
}

/** True when the cell holds nothing worth reading. */
export function isBlank(cell: Cell | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

export function isDateCell(cell: Cell | undefined): cell is DateCell {
  return typeof cell === 'object' && cell !== null;
}

/** The cell as text, for headers and descriptions. */
export function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  return cell.day;
}

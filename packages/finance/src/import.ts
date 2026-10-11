// The preview of a bank statement import (D-183): the file read by our own
// readers, the header found below the bank's preamble, the profile given or
// guessed, every row normalized to a `Transaction` or rejected with a reason,
// and the movements already present recognized by their fingerprint. Nothing
// is saved here: the caller shows the preview and stores what the user confirms.
import { readCsv } from './csv.ts';
import type { CsvEncoding, CsvReadOptions, CsvSeparator } from './csv.ts';
import { OccurrenceCounter } from './fingerprint.ts';
import { columnOf, findHeader, guessProfile, normalizeHeader, parseAmount, parseDate } from './profiles.ts';
import type { BankProfile } from './profiles.ts';
import { cellText, FinanceImportError, isBlank } from './table.ts';
import type { Cell, ReadLimits, SheetRow } from './table.ts';
import type { Transaction } from './types.ts';
import { isOleFile, isZipFile, readXlsx, xlsError } from './xlsx.ts';
import type { XlsxReadOptions } from './xlsx.ts';

export type FileKind = 'csv' | 'xlsx';

export interface PreviewOptions {
  /** The account the statement belongs to; part of every fingerprint. */
  account: string;
  /** The bank profile; guessed from the header when missing. */
  profile?: BankProfile;
  /** Fingerprints of the movements already stored for the account. */
  existing?: ReadonlySet<string>;
  /** The worksheet of an .xlsx, by name or 0-based position. */
  sheet?: string | number;
  /** ISO 4217 code when the file has no currency column. */
  currency?: string;
  limits?: Partial<ReadLimits>;
}

/** Why one row was not imported; the UI translates it. */
export type RejectReason = 'missing-date' | 'bad-date' | 'missing-amount' | 'bad-amount' | 'both-amounts';

export interface PreviewRow {
  /** The line (CSV) or row (Excel) of the file. */
  line: number;
  transaction: Transaction;
}

export interface ImportPreview {
  kind: FileKind;
  source: { kind: 'csv'; encoding: CsvEncoding; separator: CsvSeparator } | { kind: 'xlsx'; sheet: string; sheets: string[] };
  profile: BankProfile;
  /** True when the profile was guessed rather than given. */
  guessed: boolean;
  headerLine: number;
  /** The file listed the newest movements first; `rows` were turned around. */
  newestFirst: boolean;
  /** New movements in chronological order (booking day, then order within the day). */
  rows: PreviewRow[];
  /** Movements whose fingerprint is already among `existing`. */
  duplicates: PreviewRow[];
  /** Rows that are not movements, with the reason (never their content). */
  rejected: { line: number; reason: RejectReason }[];
  /** Over the new movements: money in and money out as positive cents. */
  totals: { count: number; income: number; expenses: number };
}

const CSV_EXTENSIONS = new Set(['csv', 'txt', 'tsv']);

/** The kind of file from its extension, confirmed by its first bytes. */
export function detectKind(bytes: Uint8Array, name: string): FileKind {
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  if (extension === 'xls') throw xlsError();
  if (extension === 'xlsx') {
    if (isOleFile(bytes)) throw xlsError();
    if (!isZipFile(bytes)) throw new FinanceImportError('type-mismatch', 'The file is named .xlsx but is not an Excel workbook');
    return 'xlsx';
  }
  if (CSV_EXTENSIONS.has(extension)) {
    if (isOleFile(bytes)) throw xlsError();
    if (isZipFile(bytes)) throw new FinanceImportError('type-mismatch', 'The file is named .csv but is an archive: is it an .xlsx?');
    return 'csv';
  }
  throw new FinanceImportError('unsupported-type', 'Only .csv and .xlsx files can be imported');
}

interface Columns {
  booked: number;
  value: number | null;
  description: number[];
  amount: { kind: 'single'; column: number } | { kind: 'split'; debit: number; credit: number };
  balance: number | null;
  currency: number | null;
}

function resolveColumns(header: readonly Cell[], profile: BankProfile): Columns {
  const required = (name: string): number => {
    const index = columnOf(header, name);
    if (index === -1) throw new FinanceImportError('profile-mismatch', 'A column of the profile is missing from the file');
    return index;
  };
  const optional = (name: string | null): number | null => (name === null ? null : required(name));
  return {
    booked: required(profile.booked),
    value: optional(profile.value),
    description: profile.description.map(required),
    amount:
      profile.amount.kind === 'single'
        ? { kind: 'single', column: required(profile.amount.column) }
        : { kind: 'split', debit: required(profile.amount.debit), credit: required(profile.amount.credit) },
    balance: optional(profile.balance),
    currency: optional(profile.currency),
  };
}

function currencyOf(cell: Cell | undefined, fallback: string): string {
  const text = cellText(cell).trim();
  if (text === '€') return 'EUR';
  return /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : fallback;
}

type AmountResult = { cents: number } | { reason: RejectReason };

function amountOf(cells: readonly Cell[], columns: Columns, profile: BankProfile): AmountResult {
  if (columns.amount.kind === 'single') {
    const cell = cells[columns.amount.column];
    if (isBlank(cell)) return { reason: 'missing-amount' };
    const cents = parseAmount(cell, profile.decimal);
    return cents === null ? { reason: 'bad-amount' } : { cents };
  }
  const debitCell = cells[columns.amount.debit];
  const creditCell = cells[columns.amount.credit];
  if (isBlank(debitCell) && isBlank(creditCell)) return { reason: 'missing-amount' };
  const debit = isBlank(debitCell) ? 0 : parseAmount(debitCell, profile.decimal);
  const credit = isBlank(creditCell) ? 0 : parseAmount(creditCell, profile.decimal);
  if (debit === null || credit === null) return { reason: 'bad-amount' };
  if (debit !== 0 && credit !== 0) return { reason: 'both-amounts' };
  // Debit columns hold money out whether the bank writes it with a sign or not.
  return { cents: credit !== 0 ? Math.abs(credit) : -Math.abs(debit) };
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * True when the rows (in file order) go from the newest to the oldest: by the
 * booking days when they change, otherwise (a single day) by the balance,
 * which in a newest-first file is the previous row's balance minus its amount.
 */
export function isNewestFirst(rows: readonly Transaction[]): boolean {
  let up = 0;
  let down = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1] as Transaction;
    const after = rows[index] as Transaction;
    if (after.booked > before.booked) up += 1;
    else if (after.booked < before.booked) down += 1;
  }
  if (up !== down) return down > up;
  let forward = 0;
  let backward = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1] as Transaction;
    const after = rows[index] as Transaction;
    if (before.balance === null || after.balance === null) continue;
    if (after.balance === before.balance + after.amount) forward += 1;
    if (before.balance === after.balance + before.amount) backward += 1;
  }
  return backward > forward;
}

/** Reads the file and prepares the import, without saving anything. */
export function previewImport(bytes: Uint8Array, name: string, options: PreviewOptions): ImportPreview {
  const kind = detectKind(bytes, name);
  let rows: SheetRow[];
  let source: ImportPreview['source'];
  let date1904 = false;
  if (kind === 'csv') {
    const csvOptions: CsvReadOptions = {};
    if (name.toLowerCase().endsWith('.tsv')) csvOptions.separator = '\t';
    if (options.limits !== undefined) csvOptions.limits = options.limits;
    const table = readCsv(bytes, csvOptions);
    rows = table.rows;
    source = { kind: 'csv', encoding: table.encoding, separator: table.separator };
  } else {
    const xlsxOptions: XlsxReadOptions = {};
    if (options.sheet !== undefined) xlsxOptions.sheet = options.sheet;
    if (options.limits !== undefined) xlsxOptions.limits = options.limits;
    const table = readXlsx(bytes, xlsxOptions);
    rows = table.rows;
    date1904 = table.date1904;
    source = { kind: 'xlsx', sheet: table.sheet, sheets: table.sheets };
  }

  const headerIndex = findHeader(rows, options.profile);
  if (headerIndex === null) {
    throw options.profile === undefined
      ? new FinanceImportError('no-header', 'No row of the file names the columns of a bank statement')
      : new FinanceImportError('profile-mismatch', 'No row of the file has the columns of the profile');
  }
  const headerRow = rows[headerIndex] as SheetRow;
  const body = rows.slice(headerIndex + 1);
  const profile = options.profile ?? guessProfile(headerRow.cells, body.slice(0, 20).map((row) => row.cells));
  if (profile === null) throw new FinanceImportError('unknown-columns', 'The columns of the file are not recognized: choose them by hand');
  const columns = resolveColumns(headerRow.cells, profile);
  const headerNames = headerRow.cells.map((cell) => normalizeHeader(cellText(cell)));
  const fallbackCurrency = options.currency ?? 'EUR';

  const accepted: PreviewRow[] = [];
  const preview: ImportPreview = {
    kind,
    source,
    profile,
    guessed: options.profile === undefined,
    headerLine: headerRow.line,
    newestFirst: false,
    rows: [],
    duplicates: [],
    rejected: [],
    totals: { count: 0, income: 0, expenses: 0 },
  };

  for (const row of body) {
    const { cells, line } = row;
    // Some exports repeat the header on every page.
    if (cells.length === headerNames.length && cells.every((cell, index) => normalizeHeader(cellText(cell)) === headerNames[index])) continue;
    const bookedCell = cells[columns.booked];
    if (isBlank(bookedCell)) {
      preview.rejected.push({ line, reason: 'missing-date' });
      continue;
    }
    const booked = parseDate(bookedCell, profile.dateFormat, date1904);
    if (booked === null) {
      preview.rejected.push({ line, reason: 'bad-date' });
      continue;
    }
    const amount = amountOf(cells, columns, profile);
    if ('reason' in amount) {
      preview.rejected.push({ line, reason: amount.reason });
      continue;
    }
    const description = cleanText(columns.description.map((index) => cleanText(cellText(cells[index]))).filter((part) => part !== '').join(' '));
    const value = columns.value === null ? null : parseDate(cells[columns.value], profile.dateFormat, date1904);
    const balance = columns.balance === null || isBlank(cells[columns.balance]) ? null : parseAmount(cells[columns.balance], profile.decimal);
    const transaction: Transaction = {
      account: options.account,
      booked,
      value,
      description,
      amount: amount.cents,
      currency: columns.currency === null ? fallbackCurrency : currencyOf(cells[columns.currency], fallbackCurrency),
      balance,
      fingerprint: '',
    };
    accepted.push({ line, transaction });
  }

  // Chronological order, so that a running balance and the occurrence count
  // of identical movements follow time whatever order the bank exported.
  preview.newestFirst = isNewestFirst(accepted.map((row) => row.transaction));
  if (preview.newestFirst) accepted.reverse();
  accepted.sort((a, b) => (a.transaction.booked < b.transaction.booked ? -1 : a.transaction.booked > b.transaction.booked ? 1 : 0));

  const counter = new OccurrenceCounter();
  for (const row of accepted) {
    const { transaction } = row;
    transaction.fingerprint = counter.next(options.account, transaction.booked, transaction.amount, transaction.description);
    if (options.existing?.has(transaction.fingerprint) === true) {
      preview.duplicates.push(row);
      continue;
    }
    preview.rows.push(row);
    preview.totals.count += 1;
    if (transaction.amount > 0) preview.totals.income += transaction.amount;
    else preview.totals.expenses -= transaction.amount;
  }
  return preview;
}

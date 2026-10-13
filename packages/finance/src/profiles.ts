// Bank profiles (D-183): which columns hold the dates, the description, the
// amount (or debit and credit), the balance and the currency, and how the
// bank writes dates and numbers. Amounts become integer cents by parsing the
// text, never through a float; Excel numbers go through their shortest
// decimal representation.
import { cellText, isBlank, isDateCell } from './table.ts';
import type { Cell, SheetRow } from './table.ts';
import type { Day } from './types.ts';
import { excelSerialToDay } from './xlsx.ts';

export type DateFormat = 'dd/mm/yyyy' | 'dd-mm-yyyy' | 'dd.mm.yyyy' | 'yyyy-mm-dd' | 'dd/mm/yy' | 'serial';

/** The decimal mark; the other one (or a space, or an apostrophe) groups thousands. */
export type DecimalMark = ',' | '.';

export type AmountColumns = { kind: 'single'; column: string } | { kind: 'split'; debit: string; credit: string };

/** Columns are named as in the header row of the file, compared without case, accents or punctuation. */
export interface BankProfile {
  booked: string;
  value: string | null;
  /** One or more columns joined with a space (some banks split causale and descrizione). */
  description: string[];
  amount: AmountColumns;
  balance: string | null;
  currency: string | null;
  dateFormat: DateFormat;
  decimal: DecimalMark;
}

export const DATE_FORMATS: readonly DateFormat[] = ['dd/mm/yyyy', 'dd-mm-yyyy', 'dd.mm.yyyy', 'yyyy-mm-dd', 'dd/mm/yy', 'serial'];

/** Lower case, no accents, punctuation and currency signs as spaces, single spaces. */
export function normalizeHeader(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isValidDay(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function day(year: number, month: number, dayOfMonth: number): Day | null {
  if (!isValidDay(year, month, dayOfMonth)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
}

const DAY_FIRST: Record<string, RegExp> = {
  'dd/mm/yyyy': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  'dd-mm-yyyy': /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
  'dd.mm.yyyy': /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
  'dd/mm/yy': /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
};

/**
 * A cell as a calendar day in the given format. Excel date cells are accepted
 * whatever the format; a time after the date (`01/02/2026 10:30`) is ignored.
 */
export function parseDate(cell: Cell | undefined, format: DateFormat, date1904 = false): Day | null {
  if (cell === null || cell === undefined) return null;
  if (isDateCell(cell)) return cell.day;
  if (typeof cell === 'number') return format === 'serial' ? excelSerialToDay(cell, date1904) : null;
  const text = cell.trim().split(/[\sT]/)[0] ?? '';
  if (format === 'serial') return /^\d+(\.\d+)?$/.test(text) ? excelSerialToDay(Number(text), date1904) : null;
  if (format === 'yyyy-mm-dd') {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    return match === null ? null : day(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  const match = DAY_FIRST[format]?.exec(text);
  if (match === null || match === undefined) return null;
  const year = format === 'dd/mm/yy' ? 2000 + Number(match[3]) : Number(match[3]);
  return day(year, Number(match[2]), Number(match[1]));
}

const MAX_CENTS = 1e15;

/** `digits` and `fraction` (both only digits) as cents; extra decimals must be zeros. */
function toCents(digits: string, fraction: string, roundExtra: boolean): number | null {
  let cents = BigInt(digits === '' ? '0' : digits) * 100n + BigInt((fraction + '00').slice(0, 2));
  const extra = fraction.slice(2);
  if (/[1-9]/.test(extra)) {
    if (!roundExtra) return null;
    if ((extra[0] ?? '0') >= '5') cents += 1n;
  }
  if (cents > BigInt(MAX_CENTS)) return null;
  return Number(cents);
}

/** A finite number from an Excel cell as cents, through its shortest decimal text. */
function numberToCents(value: number): number | null {
  if (!Number.isFinite(value) || Math.abs(value) >= MAX_CENTS / 100) return null;
  let text = String(Math.abs(value));
  if (text.includes('e')) text = Math.abs(value).toFixed(12);
  const [whole = '', fraction = ''] = text.split('.');
  const cents = toCents(whole, fraction, true);
  return cents === null ? null : value < 0 ? -cents : cents;
}

const THOUSANDS_SPACES = /(?<=\d)[ \u00a0\u202f'](?=\d{3}(?:\D|$))/g;

/**
 * An amount as integer cents: `1.234,56` or `1,234.56` (by the decimal mark),
 * `-12,50`, `12,50-`, `(12,50)`, `+12,50`, `€ 12,50`, `12,50 EUR`. Thousands
 * groups must have three digits, so a wrong decimal mark fails instead of
 * shifting the comma; more than two decimals are refused unless they are zeros.
 */
export function parseAmount(cell: Cell | undefined, decimal: DecimalMark): number | null {
  if (cell === null || cell === undefined || isDateCell(cell)) return null;
  if (typeof cell === 'number') return numberToCents(cell);
  let text = cell.trim().replace(/€|\bEUR\b/gi, '').replace(/\u2212/g, '-').trim();
  if (text === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('-') || text.startsWith('+')) {
    negative = negative !== text.startsWith('-');
    text = text.slice(1).trim();
  } else if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  }
  const grouping = decimal === ',' ? '.' : ',';
  // `1 234,56`, `1'234.56`: a space or an apostrophe between digit groups groups thousands.
  text = text.replace(THOUSANDS_SPACES, grouping);
  const separator = decimal === ',' ? ',' : '\\.';
  const groupSeparator = grouping === '.' ? '\\.' : ',';
  const pattern = new RegExp(`^(\\d{1,3}(?:${groupSeparator}\\d{3})+|\\d+)(?:${separator}(\\d+))?$`);
  const match = pattern.exec(text);
  if (match === null) return null;
  const whole = (match[1] ?? '').split(grouping).join('');
  const cents = toCents(whole, match[2] ?? '', false);
  if (cents === null) return null;
  return negative && cents !== 0 ? -cents : cents;
}

type Role = 'booked' | 'value' | 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance' | 'currency';

// Normalized header names, most specific first: the first match decides.
const VOCABULARY: readonly [Role, readonly string[]][] = [
  ['value', ['data valuta', 'valuta', 'value date']],
  ['booked', ['data contabile', 'data operazione', 'data registrazione', 'data movimento', 'data contabilizzazione', 'booking date', 'transaction date', 'posting date', 'booked', 'date operation']],
  ['date', ['data', 'date', 'giorno']],
  ['balance', ['saldo', 'saldo contabile', 'saldo disponibile', 'balance', 'running balance']],
  ['debit', ['dare', 'uscite', 'uscita', 'addebiti', 'addebito', 'debit', 'debits', 'money out', 'paid out', 'withdrawals', 'withdrawal']],
  ['credit', ['avere', 'entrate', 'entrata', 'accrediti', 'accredito', 'credit', 'credits', 'money in', 'paid in', 'deposits', 'deposit']],
  ['amount', ['importo', 'importo eur', 'importo euro', 'ammontare', 'movimento', 'movimenti', 'amount', 'amount eur', 'value', 'importo in euro']],
  ['currency', ['divisa', 'currency', 'valuta divisa', 'ccy']],
  ['description', ['descrizione', 'descrizione operazione', 'causale', 'causale abi', 'dettagli', 'dettaglio', 'operazione', 'beneficiario', 'description', 'details', 'memo', 'payee', 'narrative', 'reference', 'riferimento', 'concetto']],
];

/** The role a header cell names, or null. */
function headerRole(header: string): Role | null {
  const name = normalizeHeader(header);
  if (name === '') return null;
  for (const [role, words] of VOCABULARY) {
    if (words.includes(name)) return role;
  }
  // `Importo (€)`, `Descrizione estesa`: a known name followed by other words.
  for (const [role, words] of VOCABULARY) {
    if (words.some((word) => word.length > 3 && name.startsWith(`${word} `))) return role;
  }
  return null;
}

/** How many cells of a row name a column we know. */
function knownColumns(row: SheetRow): Set<Role> {
  const roles = new Set<Role>();
  for (const cell of row.cells) {
    if (typeof cell !== 'string') continue;
    const role = headerRole(cell);
    if (role !== null) roles.add(role);
  }
  return roles;
}

/** The columns the profile names, as they appear in a header. */
function profileColumns(profile: BankProfile): string[] {
  const amount = profile.amount.kind === 'single' ? [profile.amount.column] : [profile.amount.debit, profile.amount.credit];
  return [profile.booked, ...profile.description, ...amount].map(normalizeHeader);
}

/**
 * The position in `rows` of the header row: with a profile, the first row
 * that names all its columns; without, the first row (among the first 40)
 * that names a date, a description and an amount (or debit and credit).
 * Null when there is none: the bank's preamble lines are what comes before.
 */
export function findHeader(rows: readonly SheetRow[], profile?: BankProfile): number | null {
  const limit = Math.min(rows.length, 40);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (profile !== undefined) {
      const names = new Set(row.cells.map((cell) => normalizeHeader(cellText(cell))));
      if (profileColumns(profile).every((name) => names.has(name))) return index;
      continue;
    }
    const roles = knownColumns(row);
    const hasDate = roles.has('booked') || roles.has('date');
    const hasAmount = roles.has('amount') || (roles.has('debit') && roles.has('credit'));
    if (hasDate && hasAmount && roles.has('description')) return index;
  }
  return null;
}

/** The position of a column in the header, by its normalized name. */
export function columnOf(header: readonly Cell[], name: string): number {
  const wanted = normalizeHeader(name);
  return header.findIndex((cell) => normalizeHeader(cellText(cell)) === wanted);
}

/**
 * The format that reads the most sample dates, at least half of them: footer
 * lines (`Saldo finale`) and the odd broken row must not spoil the guess.
 */
function guessDateFormat(samples: readonly Cell[]): DateFormat | null {
  const filled = samples.filter((cell) => !isBlank(cell));
  if (filled.length === 0) return null;
  let best: DateFormat | null = null;
  let bestCount = 0;
  for (const format of DATE_FORMATS) {
    const count = filled.filter((cell) => (format !== 'serial' || typeof cell !== 'string') && parseDate(cell, format) !== null).length;
    if (count > bestCount) {
      best = format;
      bestCount = count;
    }
  }
  return bestCount * 2 >= filled.length ? best : null;
}

/** The decimal mark that reads more samples; comma (Italian banks) on a tie. */
function guessDecimal(samples: readonly Cell[]): DecimalMark {
  const filled = samples.filter((cell) => typeof cell === 'string' && cell.trim() !== '');
  const comma = filled.filter((cell) => parseAmount(cell, ',') !== null).length;
  const point = filled.filter((cell) => parseAmount(cell, '.') !== null).length;
  return point > comma ? '.' : ',';
}

/**
 * A profile from the header row and a few data rows, or null when the
 * columns are not recognized. The user confirms it in the preview.
 */
export function guessProfile(header: readonly Cell[], sample: readonly (readonly Cell[])[]): BankProfile | null {
  const columns = new Map<Role, number[]>();
  header.forEach((cell, index) => {
    if (typeof cell !== 'string') return;
    let role = headerRole(cell);
    // `Valuta` is the value date in Italian statements, but a column of
    // three-letter codes is a currency.
    if (role === 'value' && sample.some((row) => /^[A-Z]{3}$/.test(cellText(row[index]).trim()))) role = 'currency';
    if (role !== null) columns.set(role, [...(columns.get(role) ?? []), index]);
  });
  const first = (role: Role): number | undefined => columns.get(role)?.[0];
  const name = (index: number): string => cellText(header[index]).trim();

  const booked = first('booked') ?? first('date') ?? first('value');
  const descriptions = (columns.get('description') ?? []).slice(0, 3);
  if (booked === undefined || descriptions.length === 0) return null;
  const value = first('value') !== booked ? first('value') : undefined;

  let amount: AmountColumns;
  const amountColumns: number[] = [];
  const single = first('amount');
  const debit = first('debit');
  const credit = first('credit');
  if (single !== undefined) {
    amount = { kind: 'single', column: name(single) };
    amountColumns.push(single);
  } else if (debit !== undefined && credit !== undefined) {
    amount = { kind: 'split', debit: name(debit), credit: name(credit) };
    amountColumns.push(debit, credit);
  } else {
    return null;
  }

  const dateFormat = guessDateFormat(sample.map((row) => row[booked] ?? null));
  if (dateFormat === null) return null;
  const balance = first('balance');
  const currency = first('currency');
  const decimal = guessDecimal([...amountColumns, ...(balance === undefined ? [] : [balance])].flatMap((index) => sample.map((row) => row[index] ?? null)));

  return {
    booked: name(booked),
    value: value === undefined ? null : name(value),
    description: descriptions.map(name),
    amount,
    balance: balance === undefined ? null : name(balance),
    currency: currency === undefined ? null : name(currency),
    dateFormat,
    decimal,
  };
}

import { DATE_FORMATS, isDay, isMonth, type BankProfile, type Day, type Month } from '@arianna/finance';

/**
 * The checks of what the page of the Finances sends (I-18, D-183,
 * docs/FINANCE-API.md): pure, without the database. A request that does not
 * pass is a FinanceError with a code the page translates; messages never
 * quote a value the user sent (a description, a file name).
 */
export type FinanceErrorCode = 'not-found' | 'invalid' | 'conflict' | 'too-large';

export class FinanceError extends Error {
  override name = 'FinanceError';
  /** A FinanceErrorCode, or an ImportErrorCode of @arianna/finance. */
  readonly code: string;
  readonly status: number;
  /** The line (CSV) or row (Excel) of an import error, when there is one. */
  readonly line: number | null;

  constructor(code: string, status: number, message: string = code, line: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.line = line;
  }
}

export function invalid(message: string): FinanceError {
  return new FinanceError('invalid', 400, message);
}

export function notFound(what: string): FinanceError {
  return new FinanceError('not-found', 404, `${what} not found`);
}

/** Bytes of a statement once decoded from base64 (DEFAULT_LIMITS.maxFileBytes of @arianna/finance). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** The body of an import or its preview: the file in base64 (a third more), and room for the rest. */
export const MAX_IMPORT_BODY = Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 64 * 1024;
/** New movements shown in a preview (docs/FINANCE-API.md). */
export const PREVIEW_ROWS = 200;
export const MAX_ACCOUNT_NAME = 80;
export const MAX_CATEGORY_NAME = 60;
export const MAX_RULE_MATCH = 200;
export const MAX_FILE_NAME = 255;
/** Movements in one page of the list. */
export const DEFAULT_TX_LIMIT = 100;
export const MAX_TX_LIMIT = 500;
/** Movements asked by fingerprint at once (the rows of an alert). */
export const MAX_FINGERPRINTS = 50;
/** The largest budget: a million euro a month, in cents. */
export const MAX_BUDGET_CENTS = 100_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Only the given fields: an unknown one is refused, as in every route of the core (D-168). */
export function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalid(`unknown field(s): ${unknown.join(', ')}`);
}

/** One line of text, trimmed, 1 to `max` characters, without control characters. */
export function lineOf(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const line = value.trim();
  if (line === '') throw invalid(`${field} is empty`);
  if (/\p{Cc}/u.test(line)) throw invalid(`${field} must be one line`);
  if (Array.from(line).length > max) throw invalid(`${field} is longer than ${String(max)} characters`);
  return line;
}

export function currencyOf(value: unknown): string {
  if (value === undefined) return 'EUR';
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) throw invalid('currency must be an ISO 4217 code');
  return value.toUpperCase();
}

/** The file of an import, decoded from strict base64: at most MAX_IMPORT_BYTES (413 above). */
export function decodeFile(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw invalid('data must be the file in base64');
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid('data is not valid base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((value.length / 4) * 3 - padding > MAX_IMPORT_BYTES) throw new FinanceError('too-large', 413, 'the file is larger than 10 MiB');
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** The worksheet of an .xlsx: its name or its 0-based position. */
export function sheetOf(value: unknown): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000) return value;
  if (typeof value === 'string' && value !== '' && value.length <= 200) return value;
  throw invalid('sheet must be the name or the position of a worksheet');
}

function columnName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200 || /\p{Cc}/u.test(value)) {
    throw invalid(`profile.${field} must name a column`);
  }
  return value;
}

function optionalColumn(value: unknown, field: string): string | null {
  return value === null ? null : columnName(value, field);
}

function ownObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function only(object: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalid(`${field}: unknown field(s) ${unknown.join(', ')}`);
}

/** A bank profile as the page sends it back, checked field by field (BankProfile of @arianna/finance). */
export function parseProfile(value: unknown): BankProfile {
  const profile = ownObject(value, 'profile');
  only(profile, ['booked', 'value', 'description', 'amount', 'balance', 'currency', 'dateFormat', 'decimal'], 'profile');
  if (!Array.isArray(profile.description) || profile.description.length < 1 || profile.description.length > 5) {
    throw invalid('profile.description must list 1 to 5 columns');
  }
  const amount = ownObject(profile.amount, 'profile.amount');
  let parsedAmount: BankProfile['amount'];
  if (amount.kind === 'single') {
    only(amount, ['kind', 'column'], 'profile.amount');
    parsedAmount = { kind: 'single', column: columnName(amount.column, 'amount.column') };
  } else if (amount.kind === 'split') {
    only(amount, ['kind', 'debit', 'credit'], 'profile.amount');
    parsedAmount = { kind: 'split', debit: columnName(amount.debit, 'amount.debit'), credit: columnName(amount.credit, 'amount.credit') };
  } else {
    throw invalid('profile.amount.kind must be single or split');
  }
  if (!(DATE_FORMATS as readonly unknown[]).includes(profile.dateFormat)) throw invalid('profile.dateFormat is not a known date format');
  if (profile.decimal !== ',' && profile.decimal !== '.') throw invalid('profile.decimal must be , or .');
  return {
    booked: columnName(profile.booked, 'booked'),
    value: optionalColumn(profile.value ?? null, 'value'),
    description: profile.description.map((item, index) => columnName(item, `description[${String(index)}]`)),
    amount: parsedAmount,
    balance: optionalColumn(profile.balance ?? null, 'balance'),
    currency: optionalColumn(profile.currency ?? null, 'currency'),
    dateFormat: profile.dateFormat as BankProfile['dateFormat'],
    decimal: profile.decimal,
  };
}

/** A profile read back from the database: null when it is not one any more (never an error). */
export function storedProfile(value: unknown): BankProfile | null {
  if (value === null || value === undefined) return null;
  try {
    return parseProfile(value);
  } catch {
    return null;
  }
}

/** The description for the search: without case or accents, single spaces (the contract's `q`). */
export function searchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface DayBounds {
  from: Day;
  to: Day;
}

/** The last day of a month. */
export function lastDayOf(month: Month): Day {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

/** A day of a query: `YYYY-MM-DD`, or a month (its first day for `from`, its last for `to`). */
export function dayParam(value: string | null, edge: 'from' | 'to', field: string): Day | undefined {
  if (value === null || value === '') return undefined;
  if (isDay(value)) return value;
  if (isMonth(value)) return edge === 'from' ? `${value}-01` : lastDayOf(value);
  throw invalid(`${field} must be a day (YYYY-MM-DD) or a month (YYYY-MM)`);
}

/** A month of a query: `YYYY-MM`, or the month of a day. */
export function monthParam(value: string | null, field: string): Month | undefined {
  if (value === null || value === '') return undefined;
  if (isMonth(value)) return value;
  if (isDay(value)) return value.slice(0, 7);
  throw invalid(`${field} must be a month (YYYY-MM)`);
}

/** The month of a date on this machine's calendar. */
export function monthOfDate(date: Date): Month {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Cents as the user reads them: `-1.234,56 €` (for the agent's tools; the page formats its own). */
export function euro(cents: number, currency = 'EUR'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${units},${rest} ${currency === 'EUR' ? '€' : currency}`;
}

/** The common categories written at the first opening (docs/FINANCE-API.md), changeable by the user. */
export const DEFAULT_CATEGORIES: readonly { name: string; kind: 'out' | 'in' }[] = [
  { name: 'Spesa', kind: 'out' },
  { name: 'Casa', kind: 'out' },
  { name: 'Bollette', kind: 'out' },
  { name: 'Trasporti', kind: 'out' },
  { name: 'Ristoranti', kind: 'out' },
  { name: 'Salute', kind: 'out' },
  { name: 'Abbonamenti', kind: 'out' },
  { name: 'Svago', kind: 'out' },
  { name: 'Shopping', kind: 'out' },
  { name: 'Tasse', kind: 'out' },
  { name: 'Altre spese', kind: 'out' },
  { name: 'Stipendio', kind: 'in' },
  { name: 'Rimborsi', kind: 'in' },
  { name: 'Altre entrate', kind: 'in' },
];

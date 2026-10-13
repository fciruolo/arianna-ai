import { ApiError } from './api.ts';
import { errorText } from './italian.ts';
import type { ImSummary } from './im.ts';

/**
 * The tab "IM" of "Progetti" (I-11 tappa P4d, D-167 punti 3-5, D-169): the
 * calendar of the meetings (the file `IM/calendario.md`), the price of one
 * IM, every IM with its money and the invoices. Pure helpers: the types of
 * `GET /api/browse/:project/im-overview`, amounts in cents read and written
 * the Italian way, the words of each state and the errors.
 * Prices and invoices are Privati (L2): they stay on this computer.
 */

export interface ImCalendar {
  /** 0 = domenica … 6 = sabato. */
  weekday: number;
  time: string;
  every: number;
}

export type CalendarIssue = 'giorno' | 'ora' | 'ogni' | 'fine' | 'intestazione';

export interface ImCalendarView {
  calendar: ImCalendar | null;
  issue: CalendarIssue | null;
  /** The last day of the IM (`fine`, D-169), `YYYY-MM-DD`; null while they go on. */
  end: string | null;
  exists: boolean;
  path: string;
  version: string;
}

export interface Money {
  currency: string;
  cents: number;
}

export type ImBillingState = 'open' | 'no-price' | 'not-billed' | 'to-invoice' | 'invoiced' | 'paid';

export interface ImBillingRow extends ImSummary {
  amountCents: number | null;
  currency: string;
  overrideCents: number | null;
  notBilled: boolean;
  closedCents: number | null;
  invoice: { id: string; number: string } | null;
  state: ImBillingState;
}

export interface ImInvoice {
  id: string;
  number: string;
  issuedOn: string;
  paidOn: string | null;
  currency: string;
  note: string | null;
  ims: number[];
  /** The taxable amount: the sum of the money of its IM. */
  totalCents: number;
  /** The total of the document as on the invoice (D-170); null for the invoices registered before. */
  documentCents: number | null;
  /** The due date written by hand; null: from the payment terms of the client. */
  dueOn: string | null;
  /** The due date that counts; null without terms and without one written. */
  due: string | null;
  createdAt: string;
}

/** What a new invoice carries (D-170): the total of the document is required, the due date is not. */
export interface NewInvoice {
  number: string;
  issuedOn: string;
  documentCents: number;
  dueOn: string | null;
  note: string | null;
}

/** The amount an invoice counts for: the total of the document, else (registered before D-170) the taxable amount. */
export function invoiceAmount(invoice: Pick<ImInvoice, 'documentCents' | 'totalCents'>): number {
  return invoice.documentCents ?? invoice.totalCents;
}

/** "scade il 31/10/2026", "scaduta il 31/10/2026", "pagata il 20/08/2026"; null without a due date. */
export function dueText(invoice: Pick<ImInvoice, 'due' | 'paidOn'>, today: string): string | null {
  if (invoice.paidOn !== null) return `pagata il ${dayText(invoice.paidOn)}`;
  if (invoice.due === null) return null;
  return invoice.due < today ? `scaduta il ${dayText(invoice.due)}` : `scade il ${dayText(invoice.due)}`;
}

export interface ImOverview {
  calendar: ImCalendarView;
  price: { amountCents: number | null; currency: string } | null;
  ims: ImBillingRow[];
  invoices: ImInvoice[];
  totals: { toInvoice: Money[]; invoiced: Money[]; paid: Money[] };
}

export const WEEKDAY_TEXT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'] as const;
/** Monday first, as an Italian week. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const MAX_EVERY = 12;

/** "ogni giovedì alle 10:00", "ogni 2 settimane, il lunedì alle 15:00". */
export function calendarText(calendar: ImCalendar): string {
  const day = WEEKDAY_TEXT[calendar.weekday] ?? '';
  return calendar.every === 1 ? `ogni ${day} alle ${calendar.time}` : `ogni ${String(calendar.every)} settimane, il ${day} alle ${calendar.time}`;
}

export const CALENDAR_ISSUE_TEXT: Record<CalendarIssue, string> = {
  intestazione: 'il file non ha l’intestazione con giorno, ora e ogni',
  giorno: 'il giorno non è un giorno della settimana',
  ora: 'l’ora non è nella forma 10:00',
  ogni: 'ogni dev’essere un numero di settimane da 1 a 12',
  fine: 'la fine non è una data nella forma 2026-12-03',
};

/** An IM whose meeting falls after the last day of the IM: made before the end was set, the user takes it away. */
export function afterEnd(date: string | null, end: string | null): boolean {
  return date !== null && end !== null && date.slice(0, 10) > end;
}

export const BILLING_STATE_TEXT: Record<ImBillingState, string> = {
  open: 'Aperto',
  'no-price': 'Senza prezzo',
  'not-billed': 'Non fatturato',
  'to-invoice': 'Da fatturare',
  invoiced: 'In fattura',
  paid: 'Pagato',
};

const SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF' };

/** 45000 cents EUR → "450,00 €"; 123456789 → "1.234.567,89 €"; other currencies with their code. */
export function moneyText(cents: number, currency: string): string {
  const negative = cents < 0;
  const whole = Math.floor(Math.abs(cents) / 100);
  const rest = String(Math.abs(cents) % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '−' : ''}${grouped},${rest} ${SYMBOL[currency] ?? currency}`;
}

/** Totals in more currencies, "1.600,00 € · 300,00 $"; "—" when there is nothing. */
export function totalsText(totals: readonly Money[]): string {
  const shown = totals.filter((money) => money.cents !== 0);
  return shown.length === 0 ? '—' : shown.map((money) => moneyText(money.cents, money.currency)).join(' · ');
}

/**
 * What the user typed as an amount, in cents: "450", "450,5", "1.234,56",
 * "1234.56", "450 €"; undefined when it is not one (negative, more than two
 * decimals, letters). An empty field is null: no price.
 */
export function parseAmount(text: string): number | null | undefined {
  let value = text.replace(/[€\s]/g, '');
  if (value === '') return null;
  // "1.234,56": dots group the thousands; "1234.56": the dot is the decimal point.
  if (value.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(value)) return undefined;
    value = value.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
    value = value.replace(/\./g, '');
  } else if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return undefined;
  }
  const [whole = '0', decimals = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : undefined;
}

/** Cents as the field shows them to change: 45000 → "450", 45050 → "450,50". */
export function amountInput(cents: number | null): string {
  if (cents === null) return '';
  const rest = cents % 100;
  return rest === 0 ? String(cents / 100) : `${String(Math.floor(cents / 100))},${String(rest).padStart(2, '0')}`;
}

/** "2026-10-31" → "31/10/2026". */
export function dayText(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match === null ? day : `${match[3] ?? ''}/${match[2] ?? ''}/${match[1] ?? ''}`;
}

/** Today as `<input type="date">` wants it, local time. */
export function todayInput(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The IM that can go in a new invoice: closed, with an amount, in no invoice. */
export function invoiceable(rows: readonly ImBillingRow[]): ImBillingRow[] {
  return rows.filter((row) => row.state === 'to-invoice');
}

/** The column "Fatturazione": "Da fatturare", "In fattura 12/2026", "Pagato · fattura 12/2026". */
export function billingText(row: Pick<ImBillingRow, 'state' | 'invoice'>): string {
  if (row.invoice === null) return BILLING_STATE_TEXT[row.state];
  return row.state === 'paid' ? `Pagato · fattura ${row.invoice.number}` : `In fattura ${row.invoice.number}`;
}

/** The total of the IM chosen for a new invoice; undefined when they are in more currencies. */
export function chosenTotal(rows: readonly ImBillingRow[], chosen: ReadonlySet<number>): Money | undefined {
  const picked = rows.filter((row) => chosen.has(row.number) && row.amountCents !== null);
  if (picked.length === 0) return undefined;
  const currencies = new Set(picked.map((row) => row.currency));
  if (currencies.size !== 1) return undefined;
  return { currency: picked[0]?.currency ?? 'EUR', cents: picked.reduce((sum, row) => sum + (row.amountCents ?? 0), 0) };
}

/** Where the price of an IM comes from, under its amount. */
export function priceSourceText(row: Pick<ImBillingRow, 'state' | 'overrideCents' | 'closedCents' | 'amountCents'>): string {
  if (row.state === 'not-billed') return 'non si fattura';
  if (row.overrideCents !== null) return 'prezzo di questo IM';
  if (row.closedCents !== null) return 'fissato alla chiusura';
  if (row.state === 'open') return row.amountCents === null ? 'manca il prezzo del progetto' : 'prezzo di oggi, si fissa alla chiusura';
  return 'manca il prezzo del progetto';
}

const BILLING_ERRORS: [RegExp, string][] = [
  [/another invoice has this number/, 'C’è già una fattura con questo numero.'],
  [/is in another invoice/, 'Uno degli IM è già in un’altra fattura.'],
  [/is not closed/, 'In una fattura vanno solo IM chiusi.'],
  [/is not billed/, 'Uno degli IM è segnato «non fatturato».'],
  [/has no price/, 'Uno degli IM non ha un prezzo: metti il prezzo del progetto o quello dell’IM.'],
  [/one currency/, 'Gli IM di una fattura devono avere la stessa valuta.'],
  [/is in an invoice/, 'L’IM è in una fattura: toglilo prima dalla fattura.'],
  [/last IM of an invoice/, 'È l’ultimo IM della fattura: annulla la fattura.'],
  [/no such invoice/, 'Questa fattura non c’è più: ricarico.'],
  [/the IM of the project have ended/, 'Gli IM del progetto sono terminati: c’è una data di fine nel calendario.'],
  [/the end must be/, 'La data di fine non è valida.'],
  [/the calendar changed/, 'Il calendario è cambiato nel file (forse in Obsidian): l’ho ricaricato, riprova.'],
  [/the number must be/, 'Il numero della fattura è una riga di al massimo 40 caratteri.'],
  [/must be YYYY-MM-DD/, 'La data non è valida.'],
  [/an invoice holds/, 'Scegli almeno un IM da mettere in fattura.'],
  [/documentCents/, 'Il totale documento non è un importo valido.'],
];

export function billingErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, text] of BILLING_ERRORS) if (pattern.test(cause.message)) return text;
    if (cause.status === 404) return 'Il progetto o l’IM non c’è più: ricarica la pagina.';
  }
  return errorText(cause);
}

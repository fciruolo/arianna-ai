import { ApiError } from './api.ts';
import { financeErrorText, MAX_FILE_BYTES, type Day } from './finance.ts';

/**
 * «Fatture» of the page "Finanze" (D-310): the shapes of the invoice routes
 * of docs/FINANCE-API.md (repeated here: the page does not import the core),
 * the codes of FatturaPA and of the reading errors in Italian, the files the
 * page sends and the deadlines grouped by how close they are. Everything here
 * is private (L2): it never leaves this Mac.
 */

export interface InvoiceParty {
  name: string;
  vat: string | null;
  taxCode: string | null;
}

export interface InvoiceSummary {
  id: string;
  fileName: string;
  signed: boolean;
  documentType: string;
  number: string;
  issuedOn: Day;
  currency: string;
  totalCents: number | null;
  taxableCents: number;
  vatCents: number;
  supplier: InvoiceParty;
  customer: InvoiceParty;
  open: number;
  openCents: number;
  importedAt: string;
}

export interface InvoiceLine {
  number: number;
  description: string;
  quantity: string | null;
  unitPrice: string;
  totalCents: number;
  vatRate: string;
  nature: string | null;
}

export interface VatSummary {
  vatRate: string;
  nature: string | null;
  taxableCents: number;
  vatCents: number;
}

export interface Deadline {
  id: string;
  invoice: string;
  method: string;
  dueOn: Day | null;
  amountCents: number;
  paidOn: Day | null;
  currency: string;
  documentType: string;
  number: string;
  issuedOn: Day;
  supplier: string;
  customer: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  format: 'FPR12' | 'FPA12';
  lines: InvoiceLine[];
  vatSummary: VatSummary[];
  payments: Deadline[];
}

export interface InvoiceImport {
  imported: InvoiceSummary[];
  duplicates: number;
}

/** TipoDocumento of FatturaPA: the common ones by name, the others by code. */
const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  TD01: 'Fattura',
  TD02: 'Acconto su fattura',
  TD03: 'Acconto su parcella',
  TD04: 'Nota di credito',
  TD05: 'Nota di debito',
  TD06: 'Parcella',
  TD24: 'Fattura differita (beni e servizi)',
  TD25: 'Fattura differita (triangolazione)',
};

export function documentTypeText(code: string): string {
  return DOCUMENT_TYPES[code] ?? `Documento ${code}`;
}

/** ModalitaPagamento of FatturaPA: the common ones by name, the others by code. */
const PAYMENT_METHODS: Readonly<Record<string, string>> = {
  MP01: 'contanti',
  MP02: 'assegno',
  MP05: 'bonifico',
  MP08: 'carta',
  MP12: 'RIBA',
  MP19: 'SEPA Direct Debit',
  MP23: 'PagoPA',
};

export function paymentMethodText(code: string): string {
  return PAYMENT_METHODS[code] ?? code;
}

/** AliquotaIVA as the user reads it: `22.00` → `22%`, `0.00` with its nature → `0% (N1)`. */
export function vatRateText(rate: string, nature: string | null): string {
  const value = Number(rate);
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',');
  return nature === null ? `${text}%` : `${text}% (${nature})`;
}

/** A decimal of the XML as the user reads it, without float rounding: `1000.00` → `1.000,00`, `12.50000000` → `12,50`, `1.00` with no minimum → `1`. */
export function decimalText(value: string, minDecimals = 2): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return value;
  const whole = (match[2] ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimals = (match[3] ?? '').replace(/0+$/, '').padEnd(minDecimals, '0');
  return `${match[1] ?? ''}${whole}${decimals === '' ? '' : `,${decimals}`}`;
}

/** The codes of the invoice routes (InvoiceErrorCode of @arianna/invoices), in Italian. */
export const INVOICE_ERROR_TEXT: Readonly<Record<string, string>> = {
  'too-large': 'Il file è troppo grande: al massimo 10 MB.',
  'not-xml': 'Il file non è una fattura elettronica: servono l’XML (.xml) o il file firmato (.xml.p7m).',
  doctype: 'Il file contiene una dichiarazione DOCTYPE, che una fattura elettronica non ha: non viene letto.',
  'bad-xml': 'L’XML del file è rovinato o non è scritto correttamente.',
  'not-fatturapa': 'Il file è un XML, ma non è una fattura elettronica FatturaPA.',
  unsupported: 'Questa versione di fattura non si legge ancora (per esempio la fattura semplificata).',
  'bad-field': 'Nella fattura manca un dato obbligatorio o non è scritto correttamente.',
  'too-many': 'Il file contiene troppe fatture, righe o rate.',
  'bad-signature': 'Il file firmato (.p7m) non si apre: prova con l’XML della fattura.',
};

export function invoiceErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    const known = INVOICE_ERROR_TEXT[cause.message];
    if (known !== undefined) return known;
    if (cause.status === 404) return 'Non trovato: forse la fattura è stata tolta, o questa versione di Arianna non ha ancora le fatture. Aggiorna e riavvia Arianna.';
  }
  return financeErrorText(cause);
}

/** What the page does with a file by its name: send it, or explain why not. */
export function invoiceFileProblem(name: string, size: number): string | null {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.xml') && !lower.endsWith('.p7m')) return 'Si possono importare solo fatture elettroniche: file .xml o .xml.p7m.';
  if (size === 0) return 'Il file è vuoto.';
  if (size > MAX_FILE_BYTES) return INVOICE_ERROR_TEXT['too-large'] ?? null;
  return null;
}

/** The sentence after an import. */
export function importText(result: InvoiceImport): string {
  const count = result.imported.length;
  const parts = [count === 0 ? 'Nessuna fattura nuova' : count === 1 ? '1 fattura importata' : `${count.toLocaleString('it-IT')} fatture importate`];
  if (result.duplicates === 1) parts.push('1 era già presente');
  else if (result.duplicates > 1) parts.push(`${result.duplicates.toLocaleString('it-IT')} erano già presenti`);
  return `${parts.join(', ')}.`;
}

export type DeadlineGroup = 'overdue' | 'soon' | 'later' | 'undated';

export const DEADLINE_GROUP_TEXT: Readonly<Record<DeadlineGroup, string>> = {
  overdue: 'Scadute',
  soon: 'Nei prossimi 30 giorni',
  later: 'Più avanti',
  undated: 'Senza data di scadenza',
};

function addDays(day: Day, days: number): Day {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Where an open deadline goes, seen from `today`: past due, within 30 days, later, or without a day. */
export function deadlineGroup(dueOn: Day | null, today: Day): DeadlineGroup {
  if (dueOn === null) return 'undated';
  if (dueOn < today) return 'overdue';
  return dueOn <= addDays(today, 30) ? 'soon' : 'later';
}

/** The open deadlines in their groups, in the order of DEADLINE_GROUP_TEXT; empty groups left out. */
export function groupDeadlines(deadlines: readonly Deadline[], today: Day): { group: DeadlineGroup; items: Deadline[] }[] {
  const order: DeadlineGroup[] = ['overdue', 'soon', 'later', 'undated'];
  return order
    .map((group) => ({ group, items: deadlines.filter((item) => item.paidOn === null && deadlineGroup(item.dueOn, today) === group) }))
    .filter((entry) => entry.items.length > 0);
}

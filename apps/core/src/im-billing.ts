import type { Project } from '@arianna/config';

import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { listIms, readImCalendar, type ImCalendarView, type ImSummary } from './im.ts';
import type { KnowledgeEnv } from './project-knowledge.ts';

/**
 * The money of the IM (I-11 tappa P4d, D-167 punti 4-5, D-169): the price of
 * one IM of a project, the exception of a single IM or "non fatturato", the
 * price fixed on each IM when the core sees it closed, and the invoices the
 * user made with their own program, each with one or more IM of one project.
 * All of it is private (L2): only in these tables, read by the local web chat;
 * never in the files IM (Interno), never in an event (ids, numbers and names of
 * fields only), never towards the orchestrator, a delegation or the cloud.
 * Amounts are in cents. The core never deletes (D-046).
 */

export const MAX_AMOUNT_CENTS = 100_000_000;
const MAX_INVOICE_NUMBER = 40;
const MAX_NOTE = 2_000;
const MAX_INVOICE_IMS = 200;

export class ImBillingError extends Error {
  override name = 'ImBillingError';
  readonly code: 'invalid' | 'not-found' | 'conflict';

  constructor(code: 'invalid' | 'not-found' | 'conflict', message: string) {
    super(message);
    this.code = code;
  }
}

export interface Money {
  currency: string;
  cents: number;
}

export interface ImPrice {
  /** Null: no price yet, the IM have no amount. */
  amountCents: number | null;
  currency: string;
}

/**
 * Where an IM is with the money: `open` (not closed yet, worth the price of
 * today), `no-price`, `not-billed`, `to-invoice`, `invoiced` (not paid yet),
 * `paid`.
 */
export type ImBillingState = 'open' | 'no-price' | 'not-billed' | 'to-invoice' | 'invoiced' | 'paid';

export interface ImBillingRow extends ImSummary {
  /** What the IM is worth: the exception, else the price fixed at the closing, else (open) the price of today. */
  amountCents: number | null;
  currency: string;
  overrideCents: number | null;
  notBilled: boolean;
  /** The price of the project fixed when the IM closed (null until then). */
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
  /** The due date written by hand (D-170); null: from the payment terms of the client. */
  dueOn: string | null;
  /** The due date that counts: by hand, else computed from the client; null without either. */
  due: string | null;
  createdAt: string;
}

export interface ImOverview {
  calendar: ImCalendarView;
  price: ImPrice | null;
  ims: ImBillingRow[];
  invoices: ImInvoice[];
  totals: { toInvoice: Money[]; invoiced: Money[]; paid: Money[] };
}

export const CURRENCY = /^[A-Z]{3}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function checkCents(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_AMOUNT_CENTS) throw new ImBillingError('invalid', `${field} must be a whole number of cents from 0 to ${String(MAX_AMOUNT_CENTS)}`);
  return value;
}

export function checkInvoiceNumber(value: unknown): string {
  const number = typeof value === 'string' ? value.trim() : '';
  if (number === '' || number.length > MAX_INVOICE_NUMBER || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(number)) throw new ImBillingError('invalid', `the number must be one line of at most ${String(MAX_INVOICE_NUMBER)} characters`);
  return number;
}

function checkNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > MAX_NOTE) throw new ImBillingError('invalid', `the note must be at most ${String(MAX_NOTE)} characters`);
  return value.trim() === '' ? null : value.trim();
}

/**
 * The due date of an invoice from the payment terms of the client (D-170):
 * the date of the invoice plus the days, then the end of that month when the
 * terms say "fine mese" ("30 gg fine mese": invoice of 30 September, due 31
 * October). Null without days.
 */
export function dueDate(issuedOn: string, days: number | null, endOfMonth: boolean): string | null {
  if (days === null || !isDay(issuedOn)) return null;
  const [year, month, day] = issuedOn.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  if (endOfMonth) date.setUTCDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate());
  return date.toISOString().slice(0, 10);
}

function checkDay(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isDay(value)) throw new ImBillingError('invalid', `${field} must be YYYY-MM-DD`);
  return value;
}

interface BillingDbRow {
  im: number;
  overrideCents: string | null;
  notBilled: boolean;
  closedCents: string | null;
  closedCurrency: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  paidOn: string | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

export async function readImPrice(sql: Queryable, project: string): Promise<ImPrice | null> {
  const [row] = await sql<{ amountCents: string | null; currency: string }[]>`
    SELECT amount_cents::text AS "amountCents", currency FROM im_prices WHERE project = ${project}`;
  return row === undefined ? null : { amountCents: num(row.amountCents), currency: row.currency };
}

/**
 * The price of the project fixed on every closed IM that has none yet (the
 * choice of the user: a change of price is for the IM still open). Without a
 * price nothing is fixed: the first price set counts for the IM closed before.
 */
export async function fixClosedPrices(sql: Queryable, project: string, ims: readonly ImSummary[]): Promise<number> {
  const price = await readImPrice(sql, project);
  if (price === null || price.amountCents === null) return 0;
  const closed = ims.filter((im) => im.status === 'chiuso').map((im) => im.number);
  if (closed.length === 0) return 0;
  const rows = await sql`
    INSERT INTO im_billing (project, im, closed_cents, closed_currency, closed_at)
    SELECT ${project}, number, ${price.amountCents}, ${price.currency}, now() FROM unnest(${closed}::int[]) AS number
    ON CONFLICT (project, im) DO UPDATE SET closed_cents = EXCLUDED.closed_cents, closed_currency = EXCLUDED.closed_currency, closed_at = EXCLUDED.closed_at, updated_at = now()
      WHERE im_billing.closed_at IS NULL
    RETURNING im`;
  return rows.length;
}

/** The same for every project with IM, at each look of the watcher. */
export async function fixAllClosedPrices(sql: Queryable, projects: readonly Project[], env: KnowledgeEnv, onError: (error: unknown) => void): Promise<void> {
  const priced = new Set((await sql<{ project: string }[]>`SELECT project FROM im_prices WHERE amount_cents IS NOT NULL`).map((row) => row.project));
  for (const project of projects) {
    if (!priced.has(project.name)) continue;
    try {
      await fixClosedPrices(sql, project.name, listIms(projects, project.name, env));
    } catch (error) {
      onError(error);
    }
  }
}

function add(totals: Money[], currency: string, cents: number): void {
  const found = totals.find((money) => money.currency === currency);
  if (found === undefined) totals.push({ currency, cents });
  else found.cents += cents;
}

function rowOf(im: ImSummary, price: ImPrice | null, billing: BillingDbRow | undefined): ImBillingRow {
  const overrideCents = num(billing?.overrideCents ?? null);
  const closedCents = num(billing?.closedCents ?? null);
  const notBilled = billing?.notBilled ?? false;
  const amountCents = notBilled ? null : (overrideCents ?? closedCents ?? (im.status === 'chiuso' ? null : (price?.amountCents ?? null)));
  const currency = billing?.closedCurrency ?? price?.currency ?? 'EUR';
  const invoice = billing?.invoiceId === null || billing?.invoiceId === undefined ? null : { id: billing.invoiceId, number: billing.invoiceNumber ?? '' };
  let state: ImBillingState;
  if (invoice !== null) state = billing?.paidOn === null ? 'invoiced' : 'paid';
  else if (notBilled) state = 'not-billed';
  else if (im.status !== 'chiuso') state = 'open';
  else if (amountCents === null) state = 'no-price';
  else state = 'to-invoice';
  return { ...im, amountCents, currency, overrideCents, notBilled, closedCents, invoice, state };
}

async function billingRows(sql: Queryable, project: string): Promise<BillingDbRow[]> {
  return [
    ...(await sql<BillingDbRow[]>`
      SELECT b.im, b.override_cents::text AS "overrideCents", b.not_billed AS "notBilled", b.closed_cents::text AS "closedCents",
        b.closed_currency AS "closedCurrency", b.invoice_id::text AS "invoiceId", i.number AS "invoiceNumber", i.paid_on::text AS "paidOn"
      FROM im_billing b LEFT JOIN im_invoices i ON i.id = b.invoice_id
      WHERE b.project = ${project}`),
  ];
}

type InvoiceDbRow = Omit<ImInvoice, 'totalCents' | 'documentCents' | 'ims' | 'due'> & {
  totalCents: string;
  documentCents: string | null;
  ims: number[];
  paymentDays: number | null;
  endOfMonth: boolean | null;
};

export async function listInvoices(sql: Queryable, project: string): Promise<ImInvoice[]> {
  // The payment terms of the client the project belongs to now (D-168), for the due date.
  const rows = await sql<InvoiceDbRow[]>`
    SELECT i.id::text, i.number, i.issued_on::text AS "issuedOn", i.paid_on::text AS "paidOn", i.currency, i.note, i.created_at::text AS "createdAt",
      i.document_cents::text AS "documentCents", i.due_on::text AS "dueOn",
      coalesce(sum(coalesce(b.override_cents, b.closed_cents)), 0)::text AS "totalCents",
      coalesce(array_agg(b.im ORDER BY b.im) FILTER (WHERE b.im IS NOT NULL), '{}') AS ims,
      (SELECT c.payment_days FROM client_projects p JOIN clients c ON c.id = p.client_id WHERE p.project = i.project AND p.removed_at IS NULL) AS "paymentDays",
      (SELECT c.payment_end_of_month FROM client_projects p JOIN clients c ON c.id = p.client_id WHERE p.project = i.project AND p.removed_at IS NULL) AS "endOfMonth"
    FROM im_invoices i LEFT JOIN im_billing b ON b.invoice_id = i.id
    WHERE i.project = ${project} AND i.cancelled_at IS NULL
    GROUP BY i.id ORDER BY i.issued_on DESC, i.created_at DESC`;
  return rows.map(({ paymentDays, endOfMonth, ...row }) => ({
    ...row,
    totalCents: Number(row.totalCents),
    documentCents: num(row.documentCents),
    due: row.dueOn ?? dueDate(row.issuedOn, paymentDays, endOfMonth ?? false),
  }));
}

export interface ImMoney {
  price: ImPrice | null;
  ims: ImBillingRow[];
  invoices: ImInvoice[];
}

/** Price, every IM with its money and the invoices of one project, the closed IM priced first. */
export async function readImMoney(sql: Queryable, projects: readonly Project[], env: KnowledgeEnv, project: string): Promise<ImMoney> {
  const ims = listIms(projects, project, env);
  await fixClosedPrices(sql, project, ims);
  const price = await readImPrice(sql, project);
  const byIm = new Map((await billingRows(sql, project)).map((row) => [row.im, row]));
  return { price, ims: ims.map((im) => rowOf(im, price, byIm.get(im.number))), invoices: await listInvoices(sql, project) };
}

/** The tab "IM" of "Progetti": calendar, price, every IM with its money, the invoices and the totals. */
export async function readImOverview(sql: Sql, projects: readonly Project[], env: KnowledgeEnv, project: string): Promise<ImOverview> {
  const calendar = readImCalendar(projects, project, env);
  const { price, ims: rows, invoices } = await readImMoney(sql, projects, env, project);
  const totals: ImOverview['totals'] = { toInvoice: [], invoiced: [], paid: [] };
  for (const row of rows) if (row.state === 'to-invoice' && row.amountCents !== null) add(totals.toInvoice, row.currency, row.amountCents);
  // Invoiced and paid from the invoices: an IM file renamed or gone still counts in its invoice.
  // The total of the document when written (D-170), else the taxable amount of an invoice registered before.
  for (const invoice of invoices) add(invoice.paidOn === null ? totals.invoiced : totals.paid, invoice.currency, invoice.documentCents ?? invoice.totalCents);
  return { calendar, price, ims: rows, invoices, totals };
}

export async function setImPrice(sql: Sql, project: string, amountCents: number | null, currency: string): Promise<ImPrice> {
  if (amountCents !== null) checkCents(amountCents, 'amount');
  if (!CURRENCY.test(currency)) throw new ImBillingError('invalid', 'the currency must be 3 capital letters');
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO im_prices (project, amount_cents, currency) VALUES (${project}, ${amountCents}, ${currency})
      ON CONFLICT (project) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency, updated_at = now()`;
    await appendEvent(tx, { kind: 'im.price.set', payload: { project } });
  });
  return { amountCents, currency };
}

/** The exception of one IM (its own price, or null for the price of the project) and "non fatturato"; not while it is in an invoice. */
export async function setImBilling(sql: Sql, project: string, im: number, overrideCents: number | null, notBilled: boolean): Promise<void> {
  if (overrideCents !== null) checkCents(overrideCents, 'override');
  await sql.begin(async (tx) => {
    const [current] = await tx<{ invoiceId: string | null }[]>`
      SELECT invoice_id::text AS "invoiceId" FROM im_billing WHERE project = ${project} AND im = ${im} FOR UPDATE`;
    if (current?.invoiceId !== null && current?.invoiceId !== undefined) throw new ImBillingError('conflict', 'the IM is in an invoice: take it out first');
    await tx`
      INSERT INTO im_billing (project, im, override_cents, not_billed) VALUES (${project}, ${im}, ${overrideCents}, ${notBilled})
      ON CONFLICT (project, im) DO UPDATE SET override_cents = EXCLUDED.override_cents, not_billed = EXCLUDED.not_billed, updated_at = now()`;
    await appendEvent(tx, { kind: 'im.billing.set', payload: { project, im } });
  });
}

function conflictOf(error: unknown): ImBillingError | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return new ImBillingError('conflict', 'another invoice has this number');
  return undefined;
}

export interface NewInvoice {
  number: string;
  issuedOn: string;
  /** The total of the document as on the invoice (D-170): required for a new one. */
  documentCents: number;
  dueOn?: string | null;
  note?: string | null;
  ims: readonly number[];
}

/**
 * A new invoice with the IM `ims` of the project: each one closed, not "non
 * fatturato", not in another invoice, with an amount, all in one currency.
 */
export async function createInvoice(sql: Sql, projects: readonly Project[], env: KnowledgeEnv, project: string, input: NewInvoice): Promise<ImInvoice> {
  const number = checkInvoiceNumber(input.number);
  const issuedOn = checkDay(input.issuedOn, 'issuedOn');
  const documentCents = checkCents(input.documentCents, 'documentCents');
  const dueOn = input.dueOn === null || input.dueOn === undefined ? null : checkDay(input.dueOn, 'dueOn');
  const note = checkNote(input.note);
  const wanted = [...new Set(input.ims)];
  if (wanted.length === 0 || wanted.length > MAX_INVOICE_IMS || wanted.some((im) => !Number.isInteger(im) || im < 1 || im > 999_999)) {
    throw new ImBillingError('invalid', `an invoice holds 1 to ${String(MAX_INVOICE_IMS)} IM`);
  }
  const ims = listIms(projects, project, env);
  await fixClosedPrices(sql, project, ims);
  const status = new Map(ims.map((im) => [im.number, im.status]));
  let id = '';
  try {
    await sql.begin(async (tx) => {
      const price = await readImPrice(tx, project);
      const rows = new Map(
        (
          await tx<{ im: number; overrideCents: string | null; notBilled: boolean; closedCents: string | null; closedCurrency: string | null; invoiceId: string | null }[]>`
            SELECT im, override_cents::text AS "overrideCents", not_billed AS "notBilled", closed_cents::text AS "closedCents",
              closed_currency AS "closedCurrency", invoice_id::text AS "invoiceId"
            FROM im_billing WHERE project = ${project} AND im = ANY(${wanted}::int[]) FOR UPDATE`
        ).map((row) => [row.im, row]),
      );
      const currencies = new Set<string>();
      for (const im of wanted) {
        if (status.get(im) !== 'chiuso') throw new ImBillingError('conflict', `IM-${String(im)} is not closed`);
        const row = rows.get(im);
        if (row?.notBilled === true) throw new ImBillingError('conflict', `IM-${String(im)} is not billed`);
        if (row?.invoiceId !== null && row?.invoiceId !== undefined) throw new ImBillingError('conflict', `IM-${String(im)} is in another invoice`);
        if ((row?.overrideCents ?? row?.closedCents ?? null) === null) throw new ImBillingError('conflict', `IM-${String(im)} has no price`);
        currencies.add(row?.closedCurrency ?? price?.currency ?? 'EUR');
      }
      if (currencies.size !== 1) throw new ImBillingError('conflict', 'the IM of an invoice must have one currency');
      const [currency] = [...currencies] as [string];
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO im_invoices (project, number, issued_on, currency, note, document_cents, due_on)
        VALUES (${project}, ${number}, ${issuedOn}, ${currency}, ${note}, ${documentCents}, ${dueOn})
        RETURNING id::text`;
      if (created === undefined) throw new Error('INSERT INTO im_invoices returned no row');
      id = created.id;
      await tx`UPDATE im_billing SET invoice_id = ${id}, updated_at = now() WHERE project = ${project} AND im = ANY(${wanted}::int[])`;
      await appendEvent(tx, { kind: 'im.invoice.created', payload: { project, invoiceId: id, ims: wanted } });
    });
  } catch (error) {
    throw conflictOf(error) ?? error;
  }
  const invoice = (await listInvoices(sql, project)).find((item) => item.id === id);
  if (invoice === undefined) throw new ImBillingError('not-found', 'no such invoice');
  return invoice;
}

export interface InvoiceChange {
  number?: string;
  issuedOn?: string;
  paidOn?: string | null;
  note?: string | null;
  documentCents?: number;
  /** Null: back to the due date computed from the client. */
  dueOn?: string | null;
}

async function lockInvoice(tx: Queryable, project: string, id: string): Promise<void> {
  const [row] = await tx`SELECT id FROM im_invoices WHERE id = ${id} AND project = ${project} AND cancelled_at IS NULL FOR UPDATE`;
  if (row === undefined) throw new ImBillingError('not-found', 'no such invoice');
}

/** Number, date, payment, note, total of the document and due date of an invoice not cancelled. */
export async function updateInvoice(sql: Sql, project: string, id: string, change: InvoiceChange): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (change.number !== undefined) fields.number = checkInvoiceNumber(change.number);
  if (change.issuedOn !== undefined) fields.issued_on = checkDay(change.issuedOn, 'issuedOn');
  if (change.paidOn !== undefined) fields.paid_on = change.paidOn === null ? null : checkDay(change.paidOn, 'paidOn');
  if (change.note !== undefined) fields.note = checkNote(change.note);
  if (change.documentCents !== undefined) fields.document_cents = checkCents(change.documentCents, 'documentCents');
  if (change.dueOn !== undefined) fields.due_on = change.dueOn === null ? null : checkDay(change.dueOn, 'dueOn');
  if (Object.keys(fields).length === 0) throw new ImBillingError('invalid', 'nothing to change');
  try {
    await sql.begin(async (tx) => {
      await lockInvoice(tx, project, id);
      await tx`UPDATE im_invoices SET ${tx(fields)}, updated_at = now() WHERE id = ${id}`;
      await appendEvent(tx, { kind: 'im.invoice.changed', payload: { project, invoiceId: id, fields: Object.keys(fields) } });
    });
  } catch (error) {
    throw conflictOf(error) ?? error;
  }
}

/** The invoice cancelled: its IM are free again, to invoice. */
export async function cancelInvoice(sql: Sql, project: string, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    await lockInvoice(tx, project, id);
    await tx`UPDATE im_billing SET invoice_id = NULL, updated_at = now() WHERE invoice_id = ${id}`;
    await tx`UPDATE im_invoices SET cancelled_at = now(), updated_at = now() WHERE id = ${id}`;
    await appendEvent(tx, { kind: 'im.invoice.cancelled', payload: { project, invoiceId: id } });
  });
}

/** One IM out of the invoice; the last one does not go: the invoice is cancelled instead. */
export async function removeFromInvoice(sql: Sql, project: string, id: string, im: number): Promise<void> {
  await sql.begin(async (tx) => {
    await lockInvoice(tx, project, id);
    const rows = await tx<{ im: number }[]>`SELECT im FROM im_billing WHERE invoice_id = ${id} FOR UPDATE`;
    if (!rows.some((row) => row.im === im)) throw new ImBillingError('not-found', `IM-${String(im)} is not in the invoice`);
    if (rows.length === 1) throw new ImBillingError('conflict', 'the last IM of an invoice does not go: cancel the invoice');
    await tx`UPDATE im_billing SET invoice_id = NULL, updated_at = now() WHERE invoice_id = ${id} AND im = ${im}`;
    await appendEvent(tx, { kind: 'im.invoice.im-removed', payload: { project, invoiceId: id, im } });
  });
}

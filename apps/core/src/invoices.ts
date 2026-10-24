import { spawn } from 'node:child_process';

import { envelopeDer, invoiceFileKind, InvoiceReadError, isDay, readInvoiceXml, MAX_INVOICE_BYTES, type Invoice, type VatSummary } from '@arianna/invoices';

import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { decodeFile, FinanceError, invalid, isId, lineOf, MAX_FILE_NAME, notFound, onlyFields } from './finance-format.ts';
import { findOpenssl } from './remote-cert.ts';

/**
 * FatturaPA invoices and their deadlines in the core (D-310): the routes of
 * docs/FINANCE-API.md («Fatture e scadenze») on the invoice tables (migration
 * 0095), with the pure reading of @arianna/invoices. Everything here is
 * private (L2) and stays on this machine: only the page «Finanze» of the web
 * chat reads it, no model or channel does; events carry ids and counts only.
 * The file is read in memory and never stored; a signed .p7m is opened with
 * the system's openssl, without checking the signature.
 */

/** An invoice in the list: what it says, without its lines. */
export interface InvoiceSummary {
  id: string;
  fileName: string;
  signed: boolean;
  documentType: string;
  number: string;
  issuedOn: string;
  currency: string;
  totalCents: number | null;
  taxableCents: number;
  vatCents: number;
  supplier: { name: string; vat: string | null; taxCode: string | null };
  customer: { name: string; vat: string | null; taxCode: string | null };
  /** Instalments still open and their sum, in cents. */
  open: number;
  openCents: number;
  importedAt: string;
}

export interface InvoiceLineOut {
  number: number;
  description: string;
  quantity: string | null;
  unitPrice: string;
  totalCents: number;
  vatRate: string;
  nature: string | null;
}

export interface Deadline {
  id: string;
  invoice: string;
  method: string;
  dueOn: string | null;
  amountCents: number;
  paidOn: string | null;
  currency: string;
  documentType: string;
  number: string;
  issuedOn: string;
  supplier: string;
  customer: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  format: 'FPR12' | 'FPA12';
  lines: InvoiceLineOut[];
  vatSummary: VatSummary[];
  payments: Deadline[];
}

export interface ImportResult {
  /** The invoices that went in, as the list shows them. */
  imported: InvoiceSummary[];
  /** Invoices of the file already present (same supplier, type, number and day). */
  duplicates: number;
}

/** The status code of a reading error: a file too large is 413, the rest 400. */
function readError(error: InvoiceReadError): FinanceError {
  return new FinanceError(error.code, error.code === 'too-large' ? 413 : 400, error.message);
}

/** The time openssl may take on one envelope. */
const OPENSSL_TIMEOUT_MS = 30_000;

export type OpenEnvelope = (der: Uint8Array) => Promise<Uint8Array>;

/**
 * The XML inside a signed envelope, taken out by openssl (`cms -verify
 * -noverify`: the content, without checking who signed). The envelope goes
 * in on stdin and the XML comes out on stdout: nothing touches the disk.
 * openssl runs with only PATH in its environment, and its messages are never
 * reported (they could quote the file).
 */
export function opensslEnvelope(openssl: string = findOpenssl(), path: string = process.env.PATH ?? ''): OpenEnvelope {
  return (der) =>
    new Promise((resolve, reject) => {
      const child = spawn(openssl, ['cms', '-verify', '-noverify', '-inform', 'DER', '-binary'], {
        env: { PATH: path },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      // Our own timer, cleared on every end: the timeout option of spawn would stay armed after a spawn error.
      const fail = (): void => {
        clearTimeout(timer);
        if (failed) return;
        failed = true;
        child.kill('SIGKILL');
        reject(new InvoiceReadError('bad-signature', 'The signed file could not be opened'));
      };
      const timer = setTimeout(fail, OPENSSL_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_INVOICE_BYTES) fail();
        else chunks.push(chunk);
      });
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0 || size === 0) fail();
        else resolve(new Uint8Array(Buffer.concat(chunks)));
      });
      child.stdin.end(Buffer.from(der));
    });
}

/** Reads the invoices of a file: an XML, or a signed envelope opened with `open`. */
export async function readInvoiceFile(bytes: Uint8Array, open: OpenEnvelope): Promise<{ invoices: Invoice[]; signed: boolean }> {
  try {
    const kind = invoiceFileKind(bytes);
    const xml = kind === 'p7m' ? await open(envelopeDer(bytes)) : bytes;
    return { invoices: readInvoiceXml(xml), signed: kind === 'p7m' };
  } catch (error) {
    if (error instanceof InvoiceReadError) throw readError(error);
    throw error;
  }
}

const SUMMARY_COLUMNS = `i.id::text, i.file_name AS "fileName", i.signed, i.document_type AS "documentType", i.number,
  i.issued_on::text AS "issuedOn", i.currency, i.total_cents::float8 AS "totalCents", i.taxable_cents::float8 AS "taxableCents",
  i.vat_cents::float8 AS "vatCents",
  json_build_object('name', i.supplier_name, 'vat', i.supplier_vat, 'taxCode', i.supplier_tax_code) AS supplier,
  json_build_object('name', i.customer_name, 'vat', i.customer_vat, 'taxCode', i.customer_tax_code) AS customer,
  (SELECT count(*)::int FROM fatturapa_payments p WHERE p.invoice_id = i.id AND p.paid_on IS NULL) AS open,
  (SELECT coalesce(sum(p.amount_cents), 0)::float8 FROM fatturapa_payments p WHERE p.invoice_id = i.id AND p.paid_on IS NULL) AS "openCents",
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "importedAt"`;

const DEADLINE_COLUMNS = `p.id::text, p.invoice_id::text AS invoice, p.method, p.due_on::text AS "dueOn", p.amount_cents::float8 AS "amountCents",
  p.paid_on::text AS "paidOn", i.currency, i.document_type AS "documentType", i.number, i.issued_on::text AS "issuedOn",
  i.supplier_name AS supplier, i.customer_name AS customer`;

/** Imports the invoices of a file: `{ name, data }`, the file in base64. All of them or none. */
export async function importInvoiceFile(sql: Sql, body: Record<string, unknown>, open: OpenEnvelope): Promise<ImportResult> {
  onlyFields(body, ['name', 'data']);
  const name = lineOf(body.name, MAX_FILE_NAME, 'name');
  const { invoices, signed } = await readInvoiceFile(decodeFile(body.data), open);
  return await sql.begin(async (tx) => {
    const ids: string[] = [];
    let duplicates = 0;
    for (const invoice of invoices) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO fatturapa_invoices (fingerprint, file_name, signed, format, document_type, number, issued_on, currency, total_cents, taxable_cents,
          vat_cents, vat_summary, supplier_name, supplier_vat, supplier_tax_code, customer_name, customer_vat, customer_tax_code)
        VALUES (${invoice.fingerprint}, ${name}, ${signed}, ${invoice.format}, ${invoice.documentType}, ${invoice.number}, ${invoice.issuedOn},
          ${invoice.currency}, ${invoice.totalCents}, ${invoice.taxableCents}, ${invoice.vatCents}, ${tx.json(invoice.vatSummary as never)},
          ${invoice.supplier.name}, ${invoice.supplier.vat}, ${invoice.supplier.taxCode},
          ${invoice.customer.name}, ${invoice.customer.vat}, ${invoice.customer.taxCode})
        ON CONFLICT (fingerprint) DO NOTHING
        RETURNING id::text`;
      if (row === undefined) {
        duplicates += 1;
        continue;
      }
      ids.push(row.id);
      if (invoice.lines.length > 0) {
        const lines = invoice.lines.map((line, position) => ({ position, ...line }));
        await tx`
          INSERT INTO fatturapa_lines (invoice_id, position, line_no, description, quantity, unit_price, total_cents, vat_rate, nature)
          SELECT ${row.id}::uuid, r.position, r.number, r.description, r.quantity, r."unitPrice", r."totalCents", r."vatRate"::numeric, r.nature
          FROM jsonb_to_recordset(${tx.json(lines)}) AS r(
            position int, number int, description text, quantity text, "unitPrice" text, "totalCents" bigint, "vatRate" text, nature text)`;
      }
      if (invoice.payments.length > 0) {
        const payments = invoice.payments.map((payment, position) => ({ position, ...payment }));
        await tx`
          INSERT INTO fatturapa_payments (invoice_id, position, method, due_on, amount_cents)
          SELECT ${row.id}::uuid, r.position, r.method, r."dueOn"::date, r."amountCents"
          FROM jsonb_to_recordset(${tx.json(payments)}) AS r(position int, method text, "dueOn" text, "amountCents" bigint)`;
      }
    }
    await appendEvent(tx, { kind: 'invoice.imported', label: 'L0', payload: { invoiceIds: ids, duplicates, signed } });
    const imported = ids.length === 0 ? [] : await tx.unsafe<InvoiceSummary[]>(
      `SELECT ${SUMMARY_COLUMNS} FROM fatturapa_invoices i WHERE i.id = ANY($1::uuid[]) ORDER BY i.issued_on DESC, i.number`,
      [ids],
    );
    return { imported: [...imported], duplicates };
  });
}

export interface InvoiceFilter {
  from?: string;
  to?: string;
  /** Words of the supplier's or the customer's name, or of the number. */
  q?: string;
}

/** Invoices, most recent first; at most 500. */
export async function listInvoices(sql: Queryable, filter: InvoiceFilter = {}): Promise<InvoiceSummary[]> {
  if (filter.from !== undefined && !isDay(filter.from)) throw invalid('from must be a day');
  if (filter.to !== undefined && !isDay(filter.to)) throw invalid('to must be a day');
  if (filter.q !== undefined && filter.q.length > 200) throw invalid('q is longer than 200 characters');
  const q = filter.q === undefined || filter.q.trim() === '' ? null : `%${filter.q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const rows = await sql.unsafe<InvoiceSummary[]>(
    `SELECT ${SUMMARY_COLUMNS} FROM fatturapa_invoices i
     WHERE ($1::date IS NULL OR i.issued_on >= $1::date) AND ($2::date IS NULL OR i.issued_on <= $2::date)
       AND ($3::text IS NULL OR i.supplier_name ILIKE $3 OR i.customer_name ILIKE $3 OR i.number ILIKE $3)
     ORDER BY i.issued_on DESC, i.created_at DESC, i.id LIMIT 500`,
    [filter.from ?? null, filter.to ?? null, q],
  );
  return [...rows];
}

/** One invoice with its lines, VAT summary and instalments. */
export async function getInvoice(sql: Queryable, id: string): Promise<InvoiceDetail> {
  if (!isId(id)) throw notFound('invoice');
  const [summary] = await sql.unsafe<(InvoiceSummary & { format: 'FPR12' | 'FPA12'; vatSummary: VatSummary[] })[]>(
    `SELECT ${SUMMARY_COLUMNS}, i.format, i.vat_summary AS "vatSummary" FROM fatturapa_invoices i WHERE i.id = $1::uuid`,
    [id],
  );
  if (summary === undefined) throw notFound('invoice');
  const lines = await sql<InvoiceLineOut[]>`
    SELECT line_no AS number, description, quantity, unit_price AS "unitPrice", total_cents::float8 AS "totalCents",
      to_char(vat_rate, 'FM990.00') AS "vatRate", nature
    FROM fatturapa_lines WHERE invoice_id = ${id} ORDER BY position`;
  const payments = await sql.unsafe<Deadline[]>(
    `SELECT ${DEADLINE_COLUMNS} FROM fatturapa_payments p JOIN fatturapa_invoices i ON i.id = p.invoice_id WHERE p.invoice_id = $1::uuid ORDER BY p.position`,
    [id],
  );
  return { ...summary, lines: [...lines], payments: [...payments] };
}

/**
 * The deadlines: the instalments of every invoice, `open` (not yet paid,
 * the default) or `all`; by due day, the ones without a day last.
 */
export async function listDeadlines(sql: Queryable, status: 'open' | 'all' = 'open'): Promise<Deadline[]> {
  const rows = await sql.unsafe<Deadline[]>(
    `SELECT ${DEADLINE_COLUMNS} FROM fatturapa_payments p JOIN fatturapa_invoices i ON i.id = p.invoice_id
     WHERE ($1::boolean OR p.paid_on IS NULL)
     ORDER BY p.due_on ASC NULLS LAST, i.issued_on, p.position, p.id LIMIT 1000`,
    [status === 'all'],
  );
  return [...rows];
}

/** Marks an instalment paid on a day (`{ paidOn: 'YYYY-MM-DD' }`) or open again (`{ paidOn: null }`). */
export async function setDeadlinePaid(sql: Sql, id: string, body: Record<string, unknown>): Promise<Deadline> {
  onlyFields(body, ['paidOn']);
  if (!isId(id)) throw notFound('deadline');
  const paidOn = body.paidOn;
  if (paidOn !== null && (typeof paidOn !== 'string' || !isDay(paidOn))) throw invalid('paidOn must be a day or null');
  return await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`UPDATE fatturapa_payments SET paid_on = ${paidOn} WHERE id = ${id} RETURNING id::text`;
    if (row === undefined) throw notFound('deadline');
    await appendEvent(tx, { kind: 'invoice.payment.updated', label: 'L0', payload: { paymentId: id, paid: paidOn !== null } });
    const [deadline] = await tx.unsafe<Deadline[]>(
      `SELECT ${DEADLINE_COLUMNS} FROM fatturapa_payments p JOIN fatturapa_invoices i ON i.id = p.invoice_id WHERE p.id = $1::uuid`,
      [id],
    );
    if (deadline === undefined) throw notFound('deadline');
    return deadline;
  });
}

/** Removes an invoice with its lines and instalments (fatturapa_delete). */
export async function deleteInvoice(sql: Sql, id: string): Promise<void> {
  if (!isId(id)) throw notFound('invoice');
  await sql.begin(async (tx) => {
    try {
      await tx`SELECT fatturapa_delete(${id}::uuid)`;
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P0002') throw notFound('invoice');
      throw error;
    }
    await appendEvent(tx, { kind: 'invoice.deleted', label: 'L0', payload: { invoiceId: id } });
  });
}

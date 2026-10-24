import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { startLiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { canaryPlaces, newCanary } from './support/canary.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

// The fake invoices of the development knowledge base (D-310): invented names, VAT numbers and amounts.
const FOLDER = join(import.meta.dirname, '..', '..', '..', 'kb', 'private', 'finanze', 'fatture');
const file = (name: string): string => readFileSync(join(FOLDER, name)).toString('base64');

interface Summary {
  id: string;
  fileName: string;
  signed: boolean;
  number: string;
  totalCents: number | null;
  supplier: { name: string; vat: string | null };
  open: number;
  openCents: number;
}

interface Deadline {
  id: string;
  invoice: string;
  dueOn: string | null;
  amountCents: number;
  paidOn: string | null;
  number: string;
  supplier: string;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the shape of the answer, said by the caller
type Json = <T>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;

async function withApi(work: (json: Json) => Promise<void>): Promise<void> {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${String(server.port)}`;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the shape of the answer, said by the caller
  const json = async <T>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (response.status === 204 ? null : await response.json()) as T };
  };
  try {
    await work(json);
  } finally {
    await server.close();
    await live.close();
  }
}

test('the routes of the invoices: import, duplicates, signed file, list, detail, deadlines, paid, delete', async () => {
  const canary = newCanary();
  await withApi(async (json) => {
    const first = await json<{ imported: Summary[]; duplicates: number }>('POST', '/api/finance/invoices', { name: 'IT12345678901_00001.xml', data: file('IT12345678901_00001.xml') });
    assert.equal(first.status, 201);
    assert.equal(first.body.duplicates, 0);
    assert.equal(first.body.imported.length, 1);
    const [invoice] = first.body.imported;
    assert.ok(invoice);
    assert.equal(invoice.number, '2026/0042');
    assert.equal(invoice.totalCents, 18300);
    assert.equal(invoice.supplier.vat, 'IT12345678901');
    assert.equal(invoice.signed, false);
    assert.equal(invoice.open, 1);
    assert.equal(invoice.openCents, 18300);

    // The same invoice again, and under another name: a duplicate, nothing new.
    const again = await json<{ imported: Summary[]; duplicates: number }>('POST', '/api/finance/invoices', { name: 'copia.xml', data: file('IT12345678901_00001.xml') });
    assert.deepEqual({ status: again.status, imported: again.body.imported.length, duplicates: again.body.duplicates }, { status: 201, imported: 0, duplicates: 1 });

    const signed = await json<{ imported: Summary[] }>('POST', '/api/finance/invoices', { name: 'IT12345678901_00002.xml.p7m', data: file('IT12345678901_00002.xml.p7m') });
    assert.equal(signed.status, 201);
    assert.equal(signed.body.imported[0]?.signed, true);
    for (const name of ['IT98765432109_0A1B2.xml', 'IT12345678901_00003.xml']) {
      assert.equal((await json('POST', '/api/finance/invoices', { name, data: file(name) })).status, 201);
    }

    // Refusals with a code, nothing saved.
    const doctype = Buffer.from(`<!DOCTYPE x><x>${canary}</x>`).toString('base64');
    assert.deepEqual(await json('POST', '/api/finance/invoices', { name: 'x.xml', data: doctype }), { status: 400, body: { error: 'doctype' } });
    assert.deepEqual(await json('POST', '/api/finance/invoices', { name: 'x.csv', data: Buffer.from('a;b').toString('base64') }), { status: 400, body: { error: 'not-xml' } });
    assert.deepEqual(await json('POST', '/api/finance/invoices', { name: 'x.xml', data: file('IT12345678901_00001.xml'), extra: 1 }), { status: 400, body: { error: 'invalid' } });
    assert.deepEqual(await json('POST', '/api/finance/invoices', { name: '', data: file('IT12345678901_00001.xml') }), { status: 400, body: { error: 'invalid' } });

    const list = await json<{ invoices: Summary[] }>('GET', '/api/finance/invoices');
    assert.deepEqual(list.body.invoices.map((item) => item.number), ['NC-0003', 'FPR 17/26', '2026/0043', '2026/0042']);
    const studio = await json<{ invoices: Summary[] }>('GET', `/api/finance/invoices?q=${encodeURIComponent('bianchi & verdi')}`);
    assert.deepEqual(studio.body.invoices.map((item) => item.number), ['FPR 17/26']);
    const october = await json<{ invoices: Summary[] }>('GET', '/api/finance/invoices?from=2026-10-16&to=2026-10-20');
    assert.deepEqual(october.body.invoices.map((item) => item.number), ['FPR 17/26', '2026/0043']);
    assert.equal((await json('GET', '/api/finance/invoices?from=ieri')).status, 400);

    const detail = await json<{ invoice: { lines: { number: number; vatRate: string; nature: string | null }[]; vatSummary: unknown[]; payments: Deadline[] } }>('GET', `/api/finance/invoices/${invoice.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.invoice.lines.map((line) => [line.number, line.vatRate, line.nature]), [[1, '22.00', null], [2, '22.00', null]]);
    assert.equal(detail.body.invoice.vatSummary.length, 1);
    assert.equal(detail.body.invoice.payments.length, 1);
    assert.deepEqual((await json('GET', '/api/finance/invoices/00000000-0000-4000-8000-000000000000')).body, { error: 'not-found' });

    // The deadlines: open ones by due day; the credit note has none.
    const open = await json<{ deadlines: Deadline[] }>('GET', '/api/finance/deadlines');
    assert.deepEqual(open.body.deadlines.map((item) => [item.dueOn, item.amountCents, item.number]), [
      ['2026-10-31', 18300, '2026/0043'],
      ['2026-11-15', 61100, 'FPR 17/26'],
      ['2026-11-30', 18300, '2026/0042'],
      ['2026-12-15', 61100, 'FPR 17/26'],
    ]);
    const firstDue = open.body.deadlines[0];
    assert.ok(firstDue);
    const paid = await json<{ deadline: Deadline }>('PATCH', `/api/finance/deadlines/${firstDue.id}`, { paidOn: '2026-10-24' });
    assert.equal(paid.body.deadline.paidOn, '2026-10-24');
    assert.equal((await json<{ deadlines: Deadline[] }>('GET', '/api/finance/deadlines')).body.deadlines.length, 3);
    assert.equal((await json<{ deadlines: Deadline[] }>('GET', '/api/finance/deadlines?status=all')).body.deadlines.length, 4);
    assert.equal((await json('GET', '/api/finance/deadlines?status=paid')).status, 400);
    assert.equal((await json('PATCH', `/api/finance/deadlines/${firstDue.id}`, { paidOn: '24/10/2026' })).status, 400);
    assert.equal((await json('PATCH', `/api/finance/deadlines/${firstDue.id}`, { paidOn: null, amountCents: 1 })).status, 400);
    const reopened = await json<{ deadline: Deadline }>('PATCH', `/api/finance/deadlines/${firstDue.id}`, { paidOn: null });
    assert.equal(reopened.body.deadline.paidOn, null);

    // Removing an invoice takes its lines and instalments.
    assert.equal((await json('DELETE', `/api/finance/invoices/${invoice.id}`)).status, 204);
    assert.equal((await json('DELETE', `/api/finance/invoices/${invoice.id}`)).status, 404);
    assert.equal((await json<{ deadlines: Deadline[] }>('GET', '/api/finance/deadlines')).body.deadlines.length, 3);
    const [lines] = await db().owner<{ count: number }[]>`SELECT count(*)::int AS count FROM fatturapa_lines WHERE invoice_id = ${invoice.id}`;
    assert.equal(lines?.count, 0);
  });

  // Events carry ids and counts only: no name, number or amount of an invoice.
  const { owner, schema } = db();
  const events = await owner<{ payload: unknown }[]>`SELECT payload FROM events WHERE kind LIKE 'invoice.%'`;
  assert.ok(events.length >= 6);
  const text = JSON.stringify(events);
  for (const secret of ['Elettroforniture', 'Bianchi', '2026/0042', 'IT12345678901', 'Finto']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(await canaryPlaces(owner, schema, canary), []);
});

test('the invoice tables: no DELETE for the core, what the file says frozen, labels never below L2', async () => {
  const { sql, owner } = db();
  const [invoice] = await sql<{ id: string }[]>`
    INSERT INTO fatturapa_invoices (fingerprint, file_name, signed, format, document_type, number, issued_on, currency, taxable_cents, vat_cents, vat_summary,
      supplier_name, supplier_vat, customer_name, customer_tax_code)
    VALUES (${'b'.repeat(64)}, 'g.xml', false, 'FPR12', 'TD01', 'G-1', '2026-01-01', 'EUR', 100, 22, '[]', 'Ditta Guardia Finta', 'IT00000000001', 'Cliente Finto', 'FNTCLN80A01H501X')
    RETURNING id::text`;
  assert.ok(invoice !== undefined);
  await sql`INSERT INTO fatturapa_lines (invoice_id, position, line_no, description, unit_price, total_cents, vat_rate) VALUES (${invoice.id}, 0, 1, 'Riga finta', '1.00', 100, 22)`;
  const [payment] = await sql<{ id: string }[]>`INSERT INTO fatturapa_payments (invoice_id, position, method, due_on, amount_cents) VALUES (${invoice.id}, 0, 'MP05', '2026-02-01', 122) RETURNING id::text`;
  assert.ok(payment !== undefined);

  await assert.rejects(sql`INSERT INTO fatturapa_invoices (fingerprint, file_name, signed, format, document_type, number, issued_on, currency, taxable_cents, vat_cents, vat_summary, supplier_name, supplier_vat, customer_name, customer_tax_code)
    VALUES (${'b'.repeat(64)}, 'h.xml', false, 'FPR12', 'TD01', 'G-2', '2026-01-02', 'EUR', 1, 0, '[]', 'Altra', 'IT00000000002', 'Cliente', 'FNTCLN80A01H501X')`, /fatturapa_invoices_fingerprint_key/);
  await assert.rejects(sql`INSERT INTO fatturapa_invoices (fingerprint, file_name, signed, format, document_type, number, issued_on, currency, taxable_cents, vat_cents, vat_summary, supplier_name, supplier_vat, customer_name, customer_tax_code, label)
    VALUES (${'c'.repeat(64)}, 'h.xml', false, 'FPR12', 'TD01', 'G-2', '2026-01-02', 'EUR', 1, 0, '[]', 'Altra', 'IT00000000002', 'Cliente', 'FNTCLN80A01H501X', 'L1')`, /check constraint/);
  await assert.rejects(sql`INSERT INTO fatturapa_invoices (fingerprint, file_name, signed, format, document_type, number, issued_on, currency, taxable_cents, vat_cents, vat_summary, supplier_name, customer_name, customer_tax_code)
    VALUES (${'d'.repeat(64)}, 'h.xml', false, 'FPR12', 'TD01', 'G-3', '2026-01-02', 'EUR', 1, 0, '[]', 'Senza id', 'Cliente', 'FNTCLN80A01H501X')`, /fatturapa_invoices_supplier_id/);

  await assert.rejects(sql`DELETE FROM fatturapa_invoices`, /permission denied/);
  await assert.rejects(sql`DELETE FROM fatturapa_lines`, /permission denied/);
  await assert.rejects(sql`DELETE FROM fatturapa_payments`, /permission denied/);
  await assert.rejects(sql`UPDATE fatturapa_invoices SET number = 'X'`, /permission denied/);
  await assert.rejects(sql`UPDATE fatturapa_lines SET total_cents = 1`, /permission denied/);
  await assert.rejects(owner`UPDATE fatturapa_invoices SET number = 'X'`, /never changes/);
  await assert.rejects(owner`UPDATE fatturapa_lines SET total_cents = 1`, /never changes/);
  await assert.rejects(sql`UPDATE fatturapa_payments SET amount_cents = 1`, /only the day it was paid changes/);
  await assert.rejects(sql`UPDATE fatturapa_payments SET due_on = '2026-03-01'`, /only the day it was paid changes/);
  await assert.rejects(sql`UPDATE fatturapa_payments SET label = 'L1'`, /check constraint|cannot go down/);
  await sql`UPDATE fatturapa_payments SET paid_on = '2026-01-15' WHERE id = ${payment.id}`;
  await sql`UPDATE fatturapa_payments SET label = 'L3' WHERE id = ${payment.id}`;
  await assert.rejects(sql`UPDATE fatturapa_payments SET label = 'L2' WHERE id = ${payment.id}`, /cannot go down/);

  await sql`SELECT fatturapa_delete(${invoice.id}::uuid)`;
  await assert.rejects(sql`SELECT fatturapa_delete(${invoice.id}::uuid)`, /does not exist/);
  const [left] = await owner<{ count: number }[]>`SELECT (SELECT count(*) FROM fatturapa_lines WHERE invoice_id = ${invoice.id}) + (SELECT count(*) FROM fatturapa_payments WHERE invoice_id = ${invoice.id}) AS count`;
  assert.equal(Number(left?.count), 0);
  const [grant] = await owner<{ public: boolean }[]>`SELECT has_function_privilege('public', 'fatturapa_delete(uuid)', 'EXECUTE') AS public`;
  assert.equal(grant?.public, false);
});

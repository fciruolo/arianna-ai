// The money of the IM against PostgreSQL (I-11 tappa P4d, D-169): the price
// of the project fixed on each IM when it is seen closed, the exception and
// "non fatturato" of one IM, invoices of one project with one or more closed
// IM, the totals, the guards of the tables and events without amounts. All
// the data are invented.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createLabelRules } from '@arianna/policy';

import { readClientDashboard } from '../src/client-dashboard.ts';
import { ClientError, createClient, linkProject } from '../src/clients.ts';
import { cancelInvoice, createInvoice, fixAllClosedPrices, ImBillingError, readImOverview, removeFromInvoice, setImBilling, setImPrice, updateInvoice } from '../src/im-billing.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

const HOME = join(resolveHome({}), 'data', 'test-tmp', `im-billing-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const im = (number: number, date: string, status: string): string => `---\nim: ${String(number)}\ndata: ${date}\nstato: ${status}\n---\n\n## Lavori\n\n- [x] Voce\n`;

function container(name: string, ims: Record<number, string>): Project {
  const root = join(HOME, 'repos', name);
  const files: Record<string, string> = { 'parte/.git/HEAD': 'ref: refs/heads/main\n' };
  for (const [number, status] of Object.entries(ims)) files[`IM/IM-${number}.md`] = im(Number(number), `2026-09-${String(Number(number)).padStart(2, '0')} 10:00`, status);
  // Fake data only.
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { name, path: `repos/${name}`, absolute: root, label: 'L1' };
}

function close(project: Project, number: number): void {
  writeFileSync(join(project.absolute, 'IM', `IM-${String(number)}.md`), im(number, `2026-09-${String(number).padStart(2, '0')} 10:00`, 'chiuso'));
}

const ARIANNA = join(HOME, 'arianna');
mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
const ENV = { home: ARIANNA, rules: createLabelRules({ folders: [], sources: [] }) };

async function rejectsWith(promise: Promise<unknown>, code: ImBillingError['code']): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof ImBillingError && error.code === code);
}

test('the price is fixed on each IM when it is seen closed; a change counts only for the IM still open', async () => {
  const sql = db().sql;
  const project = container('alfa', { 1: 'chiuso', 2: 'chiuso', 3: 'previsto' });
  const projects = [project];
  let overview = await readImOverview(sql, projects, ENV, 'alfa');
  assert.equal(overview.price, null);
  assert.deepEqual(overview.ims.map((row) => row.state), ['no-price', 'no-price', 'open']);

  await setImPrice(sql, 'alfa', 40_000, 'EUR');
  // The first price counts for the IM closed before it.
  await fixAllClosedPrices(sql, projects, ENV, (error) => assert.fail(String(error)));
  await setImPrice(sql, 'alfa', 45_000, 'EUR');
  overview = await readImOverview(sql, projects, ENV, 'alfa');
  assert.deepEqual(overview.ims.map((row) => [row.number, row.amountCents, row.state]), [[1, 40_000, 'to-invoice'], [2, 40_000, 'to-invoice'], [3, 45_000, 'open']]);
  assert.deepEqual(overview.totals.toInvoice, [{ currency: 'EUR', cents: 80_000 }]);

  // IM-3 closes in Obsidian: it takes the price of now.
  close(project, 3);
  overview = await readImOverview(sql, projects, ENV, 'alfa');
  assert.deepEqual(overview.ims.map((row) => row.closedCents), [40_000, 40_000, 45_000]);

  // The exception and "non fatturato" of one IM.
  await setImBilling(sql, 'alfa', 2, 30_000, false);
  await setImBilling(sql, 'alfa', 3, null, true);
  overview = await readImOverview(sql, projects, ENV, 'alfa');
  assert.deepEqual(overview.ims.map((row) => [row.amountCents, row.state]), [[40_000, 'to-invoice'], [30_000, 'to-invoice'], [null, 'not-billed']]);
  await rejectsWith(setImBilling(sql, 'alfa', 2, 100_000_001, false), 'invalid');
  await rejectsWith(setImPrice(sql, 'alfa', 1.5, 'EUR'), 'invalid');
  await rejectsWith(setImPrice(sql, 'alfa', 100, 'eur'), 'invalid');

  // The price fixed at the closing never changes, even by hand.
  await assert.rejects(sql`UPDATE im_billing SET closed_cents = 1 WHERE project = 'alfa' AND im = 1`, /never changes/);
});

test('an invoice holds closed IM of one project, one currency, each once', async () => {
  const sql = db().sql;
  const project = container('beta', { 1: 'chiuso', 2: 'chiuso', 3: 'chiuso', 4: 'previsto' });
  const projects = [project];
  container('gamma', { 1: 'chiuso' });
  await setImPrice(sql, 'beta', 50_000, 'EUR');
  await setImBilling(sql, 'beta', 3, null, true);

  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: '1/2026', issuedOn: '2026-10-31', ims: [1, 4] }), 'conflict');
  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: '1/2026', issuedOn: '2026-10-31', ims: [3] }), 'conflict');
  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: '1/2026', issuedOn: '2026-10-31', ims: [9] }), 'conflict');
  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: '1/2026', issuedOn: '2026-02-30', ims: [1] }), 'invalid');
  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: ' ', issuedOn: '2026-10-31', ims: [1] }), 'invalid');
  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: '1/2026', issuedOn: '2026-10-31', ims: [] }), 'invalid');

  const invoice = await createInvoice(sql, projects, ENV, 'beta', { documentCents: 122_000, number: '1/2026', issuedOn: '2026-10-31', ims: [1, 2], note: 'Settembre' });
  assert.deepEqual([invoice.ims, invoice.totalCents, invoice.documentCents, invoice.currency, invoice.paidOn], [[1, 2], 100_000, 122_000, 'EUR', null]);
  // No client for the project: no due date until one is written by hand.
  assert.deepEqual([invoice.dueOn, invoice.due], [null, null]);
  // Each IM once; the number once among the invoices not cancelled.
  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: '2/2026', issuedOn: '2026-10-31', ims: [2] }), 'conflict');
  await setImBilling(sql, 'beta', 3, null, false);
  await rejectsWith(createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: ' 1/2026 ', issuedOn: '2026-10-31', ims: [3] }), 'conflict');
  // An IM in an invoice keeps its money until it leaves it.
  await rejectsWith(setImBilling(sql, 'beta', 1, 10, false), 'conflict');
  // Not even by hand: the money of an IM in an invoice, a lower label, an invoice cancelled taken again.
  await assert.rejects(sql`UPDATE im_billing SET override_cents = 1 WHERE project = 'beta' AND im = 1`, /its money never changes/);
  await assert.rejects(sql`UPDATE im_billing SET label = 'L1' WHERE project = 'beta' AND im = 1`);
  await assert.rejects(sql`UPDATE im_invoices SET label = 'L1' WHERE id = ${invoice.id}`);
  // Never into an invoice of another project.
  await assert.rejects(sql`INSERT INTO im_billing (project, im, invoice_id) VALUES ('gamma', 1, ${invoice.id})`, /only into an invoice of its project/);

  let overview = await readImOverview(sql, projects, ENV, 'beta');
  assert.deepEqual(overview.ims.map((row) => row.state), ['invoiced', 'invoiced', 'to-invoice', 'open']);
  assert.equal(overview.ims[0]?.invoice?.number, '1/2026');
  assert.deepEqual([overview.totals.toInvoice, overview.totals.invoiced, overview.totals.paid], [[{ currency: 'EUR', cents: 50_000 }], [{ currency: 'EUR', cents: 122_000 }], []]);

  await updateInvoice(sql, 'beta', invoice.id, { paidOn: '2026-11-15' });
  overview = await readImOverview(sql, projects, ENV, 'beta');
  assert.deepEqual(overview.ims.map((row) => row.state).slice(0, 2), ['paid', 'paid']);
  // Invoiced and paid count the total of the document (D-170).
  assert.deepEqual(overview.totals.paid, [{ currency: 'EUR', cents: 122_000 }]);
  await rejectsWith(updateInvoice(sql, 'beta', invoice.id, {}), 'invalid');
  await rejectsWith(updateInvoice(sql, 'beta', invoice.id, { documentCents: -1 }), 'invalid');
  await rejectsWith(updateInvoice(sql, 'beta', invoice.id, { dueOn: '2026-11-31' }), 'invalid');
  await updateInvoice(sql, 'beta', invoice.id, { documentCents: 121_000, dueOn: '2026-11-30' });
  overview = await readImOverview(sql, projects, ENV, 'beta');
  assert.deepEqual([overview.invoices[0]?.documentCents, overview.invoices[0]?.dueOn, overview.invoices[0]?.due], [121_000, '2026-11-30', '2026-11-30']);
  await rejectsWith(updateInvoice(sql, 'gamma', invoice.id, { paidOn: null }), 'not-found');

  // Out of the invoice one by one, the last one never: the invoice is cancelled instead.
  await removeFromInvoice(sql, 'beta', invoice.id, 2);
  await rejectsWith(removeFromInvoice(sql, 'beta', invoice.id, 1), 'conflict');
  await rejectsWith(removeFromInvoice(sql, 'beta', invoice.id, 2), 'not-found');
  await cancelInvoice(sql, 'beta', invoice.id);
  await rejectsWith(cancelInvoice(sql, 'beta', invoice.id), 'not-found');
  await assert.rejects(sql`UPDATE im_invoices SET cancelled_at = NULL WHERE id = ${invoice.id}`, /cancelled, it never changes/);
  await assert.rejects(sql`UPDATE im_billing SET invoice_id = ${invoice.id} WHERE project = 'beta' AND im = 1`, /not cancelled/);
  overview = await readImOverview(sql, projects, ENV, 'beta');
  assert.deepEqual(overview.ims.map((row) => row.state), ['to-invoice', 'to-invoice', 'to-invoice', 'open']);
  assert.deepEqual(overview.invoices, []);
  // A cancelled invoice frees its number.
  const again = await createInvoice(sql, projects, ENV, 'beta', { documentCents: 54_900, number: '1/2026', issuedOn: '2026-11-02', ims: [1, 2, 3] });
  assert.equal(again.totalCents, 150_000);
  await assert.rejects(sql`UPDATE im_invoices SET currency = 'USD' WHERE id = ${again.id}`, /never change/);

  // The events carry ids, numbers and names of fields, never amounts or invoice numbers.
  const events = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind LIKE 'im.%' AND payload->>'project' = 'beta'`;
  assert.ok(events.length > 0);
  for (const { payload } of events) assert.doesNotMatch(JSON.stringify(payload), /50000|122000|121000|1\/2026|Settembre/);
});

test('mixed currencies do not go in one invoice', async () => {
  const sql = db().sql;
  const projects = [container('delta', { 1: 'chiuso', 2: 'previsto' })];
  await setImPrice(sql, 'delta', 10_000, 'EUR');
  await readImOverview(sql, projects, ENV, 'delta');
  await setImPrice(sql, 'delta', 12_000, 'USD');
  close(projects[0] as Project, 2);
  const overview = await readImOverview(sql, projects, ENV, 'delta');
  assert.deepEqual(overview.ims.map((row) => row.currency), ['EUR', 'USD']);
  assert.deepEqual(overview.totals.toInvoice, [{ currency: 'EUR', cents: 10_000 }, { currency: 'USD', cents: 12_000 }]);
  await rejectsWith(createInvoice(sql, projects, ENV, 'delta', { documentCents: 54_900, number: 'D-1', issuedOn: '2026-10-31', ims: [1, 2] }), 'conflict');
});

test('the client dashboard: due dates from the payment terms of the client, a written one over them, the money of its projects', async () => {
  const sql = db().sql;
  const projects = [container('epsilon', { 1: 'chiuso', 2: 'chiuso', 3: 'previsto' }), container('zeta', { 1: 'chiuso' })];
  const client = await createClient(sql, { displayName: 'Pasticceria Finta Epsilon', paymentDays: 30, paymentEndOfMonth: true });
  const names = { projects: projects.map((project) => project.name) };
  await linkProject(sql, client.id, 'epsilon', names);
  await linkProject(sql, client.id, 'zeta', names);
  await setImPrice(sql, 'epsilon', 45_000, 'EUR');
  await setImPrice(sql, 'zeta', 30_000, 'EUR');
  await rejectsWith(createInvoice(sql, projects, ENV, 'epsilon', { documentCents: 1.5, number: 'E-1', issuedOn: '2026-09-30', ims: [1] }), 'invalid');
  const first = await createInvoice(sql, projects, ENV, 'epsilon', { documentCents: 109_800, number: 'E-1', issuedOn: '2026-09-30', ims: [1, 2] });
  assert.deepEqual([first.dueOn, first.due], [null, '2026-10-31']);
  const second = await createInvoice(sql, projects, ENV, 'zeta', { documentCents: 36_600, number: 'Z-1', issuedOn: '2026-09-30', dueOn: '2026-10-15', ims: [1] });
  assert.deepEqual([second.dueOn, second.due], ['2026-10-15', '2026-10-15']);
  await updateInvoice(sql, 'zeta', second.id, { paidOn: '2026-10-12' });

  const dashboard = await readClientDashboard(sql, projects, ENV, client.id);
  assert.equal(dashboard.currency, 'EUR');
  assert.deepEqual(
    dashboard.projects.map((project) => [project.name, project.closed, project.next?.number ?? null]),
    [
      ['epsilon', 2, 3],
      ['zeta', 1, null],
    ],
  );
  assert.deepEqual(
    dashboard.months.map((item) => [item.month, item.project, item.invoiced, item.paid]),
    [
      ['2026-09', 'epsilon', 109_800, 0],
      ['2026-09', 'zeta', 0, 36_600],
    ],
  );
  assert.deepEqual(
    dashboard.cash.map((item) => [item.month, item.cents]),
    [['2026-10', 36_600]],
  );
  // A project of the client no longer among the containers is named, not read.
  const fewer = await readClientDashboard(sql, [projects[0] as Project], ENV, client.id);
  assert.deepEqual([fewer.projects.map((project) => project.name), fewer.missing], [['epsilon'], ['zeta']]);
  await assert.rejects(readClientDashboard(sql, projects, ENV, randomUUID()), (error) => error instanceof ClientError && error.code === 'not-found');
});

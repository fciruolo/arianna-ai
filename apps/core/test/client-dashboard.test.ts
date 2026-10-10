// The dashboard of a client (I-16 tappa C3, D-170), the pure part: the total
// of the document split among the IM of an invoice, competenza by month of
// the IM, cassa by month of the payment, due dates. Invented data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apportion, buildDashboard, type ProjectMoney } from '../src/client-dashboard.ts';
import type { ImBillingRow, ImBillingState, ImInvoice } from '../src/im-billing.ts';
import { dueDate } from '../src/im-billing.ts';

function row(number: number, date: string, state: ImBillingState, amountCents: number | null, invoice: string | null = null): ImBillingRow {
  return {
    number,
    date: `${date} 10:00`,
    call: null,
    status: state === 'open' ? 'previsto' : 'chiuso',
    label: 'L1',
    path: `IM/IM-${String(number)}.md`,
    counts: { todo: 0, doing: 0, done: 1, postponed: 0, cancelled: 0 },
    amountCents,
    currency: 'EUR',
    overrideCents: null,
    notBilled: state === 'not-billed',
    closedCents: amountCents,
    invoice: invoice === null ? null : { id: invoice, number: invoice },
    state,
  };
}

function invoice(id: string, ims: number[], totalCents: number, documentCents: number | null, issuedOn: string, paidOn: string | null, due: string | null = null): ImInvoice {
  return { id, number: id, issuedOn, paidOn, currency: 'EUR', note: null, ims, totalCents, documentCents, dueOn: null, due, createdAt: `${issuedOn} 12:00:00+00` };
}

test('apportion splits a total by weights, the cents left over to the last, equal parts without weights', () => {
  assert.deepEqual(apportion(329_400, [45_000, 45_000, 45_000, 45_000, 45_000, 45_000]), [54_900, 54_900, 54_900, 54_900, 54_900, 54_900]);
  assert.deepEqual(apportion(100, [1, 1, 1]), [33, 33, 34]);
  assert.deepEqual(apportion(1_000, [0, 0]), [500, 500]);
  assert.deepEqual(apportion(1_000, [30_000, 10_000]), [750, 250]);
  assert.deepEqual(apportion(5, []), []);
  // The shares always add up to the total.
  // Big amounts: no cents lost to the limits of a number.
  assert.deepEqual(apportion(100_000_000, [99_999_999, 1]), [99_999_999, 1]);
  const shares = apportion(123_457, [333, 777, 1, 9_999]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 123_457);
});

test('the due date: days from the invoice, then the end of the month when the terms say so', () => {
  assert.equal(dueDate('2026-09-30', 30, true), '2026-10-31');
  assert.equal(dueDate('2026-09-30', 30, false), '2026-10-30');
  assert.equal(dueDate('2026-01-31', 30, true), '2026-03-31');
  assert.equal(dueDate('2026-12-15', 0, true), '2026-12-31');
  assert.equal(dueDate('2026-09-30', null, true), null);
  assert.equal(dueDate('2026-02-30', 30, false), null);
});

test('competenza: the total of the document split on the months of the IM; cassa: the whole invoice in the month it was paid', () => {
  const money: ProjectMoney = {
    name: 'progetto-test',
    price: { amountCents: 45_000, currency: 'EUR' },
    ims: [
      row(1, '2026-08-20', 'paid', 45_000, 'A'),
      row(2, '2026-08-27', 'paid', 45_000, 'A'),
      row(3, '2026-09-03', 'paid', 45_000, 'A'),
      row(4, '2026-09-10', 'invoiced', 45_000, 'B'),
      row(5, '2026-09-17', 'not-billed', null),
      row(6, '2026-09-24', 'to-invoice', 45_000),
      row(7, '2026-10-01', 'no-price', null),
      row(8, '2026-10-08', 'open', 45_000),
    ],
    invoices: [invoice('B', [4], 45_000, 54_900, '2026-09-30', null, '2026-10-31'), invoice('A', [1, 2, 3], 135_000, 164_700, '2026-09-05', '2026-10-02')],
  };
  const dashboard = buildDashboard('EUR', '2026-11-02', [money]);
  const month = (key: string) => dashboard.months.find((item) => item.month === key);
  // A: 164.700 split on three IM, two in August, one in September.
  assert.deepEqual([month('2026-08')?.paid, month('2026-08')?.closed], [109_800, 2]);
  assert.deepEqual([month('2026-09')?.paid, month('2026-09')?.invoiced, month('2026-09')?.toInvoice, month('2026-09')?.closed], [54_900, 54_900, 45_000, 4]);
  // The IM without a price counts as closed, with no money; the open one not at all.
  assert.deepEqual([month('2026-10')?.closed, month('2026-10')?.toInvoice], [1, 0]);
  assert.deepEqual(dashboard.cash, [{ month: '2026-10', project: 'progetto-test', currency: 'EUR', cents: 164_700, invoices: 1 }]);
  // B is past its due date and not paid.
  assert.deepEqual(
    dashboard.invoices.map((item) => [item.id, item.overdue]),
    [
      ['B', true],
      ['A', false],
    ],
  );
  const [project] = dashboard.projects;
  assert.deepEqual(
    [project?.closed, project?.notBilled.map((im) => im.number), project?.noPrice.map((im) => im.number), project?.toInvoice.map((im) => im.number), project?.next?.number],
    [7, [5], [7], [6], 8],
  );
});

test('an invoice registered before has no total of the document: its taxable amount counts; an IM file gone keeps its share in the month of the invoice', () => {
  const money: ProjectMoney = {
    name: 'demo',
    price: null,
    ims: [row(2, '2026-03-05', 'paid', 30_000, 'C')],
    // IM-1 is no longer a file: its share (taxable 10.000 out of 40.000) goes to the month of the invoice, April.
    invoices: [invoice('C', [1, 2], 40_000, 48_800, '2026-04-30', '2026-05-10'), invoice('D', [3], 20_000, null, '2026-06-30', null)],
  };
  const dashboard = buildDashboard('EUR', '2026-07-01', [money]);
  const month = (key: string) => dashboard.months.find((item) => item.month === key);
  assert.equal(month('2026-03')?.paid, 36_600);
  assert.equal(month('2026-04')?.paid, 12_200);
  // D: no IM file left, its taxable amount (no total of the document) in June.
  assert.equal(month('2026-06')?.invoiced, 20_000);
  assert.equal(dashboard.invoices.find((item) => item.id === 'D')?.overdue, false);
  assert.deepEqual(dashboard.cash, [{ month: '2026-05', project: 'demo', currency: 'EUR', cents: 48_800, invoices: 1 }]);
});

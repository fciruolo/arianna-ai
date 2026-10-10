// The sums of the client dashboard (I-16 tappa C3, D-170): year, project and
// view chosen, the currency of the client, what is waiting today. Invented data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chartScale, dashboardYears, roundMoneyText, summarize, type ClientDashboard, type DashboardInvoice } from '../src/lib/client-dashboard.ts';
import { dueText, invoiceAmount } from '../src/lib/im-billing.ts';

function invoice(id: string, project: string, documentCents: number | null, totalCents: number, issuedOn: string, paidOn: string | null, due: string | null, overdue = false): DashboardInvoice {
  return { id, number: id, project, issuedOn, paidOn, currency: 'EUR', note: null, ims: [1], totalCents, documentCents, dueOn: null, due, createdAt: issuedOn, overdue };
}

const DASHBOARD: ClientDashboard = {
  currency: 'EUR',
  today: '2026-10-10',
  projects: [
    { name: 'progetto-test', price: { amountCents: 45_000, currency: 'EUR' }, closed: 5, notBilled: [], noPrice: [], toInvoice: [{ number: 60, date: '2026-10-08 10:00', cents: 45_000, currency: 'EUR' }], next: { number: 61, date: '2026-10-15 10:00' } },
    { name: 'demo', price: { amountCents: 30_000, currency: 'EUR' }, closed: 2, notBilled: [], noPrice: [{ number: 9, date: '2026-03-12 10:00', cents: null, currency: 'EUR' }], toInvoice: [], next: null },
  ],
  missing: [],
  months: [
    { month: '2025-11', project: 'progetto-test', currency: 'EUR', toInvoice: 0, invoiced: 0, paid: 54_900, closed: 1 },
    { month: '2026-08', project: 'progetto-test', currency: 'EUR', toInvoice: 0, invoiced: 0, paid: 109_800, closed: 2 },
    { month: '2026-09', project: 'progetto-test', currency: 'EUR', toInvoice: 0, invoiced: 54_900, paid: 0, closed: 1 },
    { month: '2026-10', project: 'progetto-test', currency: 'EUR', toInvoice: 45_000, invoiced: 0, paid: 0, closed: 1 },
    { month: '2026-03', project: 'demo', currency: 'EUR', toInvoice: 0, invoiced: 0, paid: 36_600, closed: 2 },
    { month: '2026-04', project: 'demo', currency: 'USD', toInvoice: 0, invoiced: 0, paid: 20_000, closed: 0 },
  ],
  cash: [
    { month: '2025-12', project: 'progetto-test', currency: 'EUR', cents: 54_900, invoices: 1 },
    { month: '2026-04', project: 'demo', currency: 'EUR', cents: 36_600, invoices: 1 },
    { month: '2026-09', project: 'progetto-test', currency: 'EUR', cents: 109_800, invoices: 1 },
  ],
  invoices: [
    invoice('B', 'progetto-test', 54_900, 45_000, '2026-09-30', null, '2026-10-31'),
    invoice('A', 'progetto-test', 109_800, 90_000, '2026-08-31', '2026-09-20', '2026-09-30'),
    invoice('C', 'demo', null, 30_000, '2026-03-31', '2026-04-15', null),
    invoice('Z', 'progetto-test', 54_900, 45_000, '2025-11-30', '2025-12-20', null),
  ],
};

test('the years with money, this year always, the most recent first', () => {
  assert.deepEqual(dashboardYears(DASHBOARD), [2026, 2025]);
  assert.deepEqual(dashboardYears({ months: [], cash: [], today: '2026-10-10' }), [2026]);
});

test('competenza of one year: the money of the IM of the year, the year before, waiting and collected', () => {
  const summary = summarize(DASHBOARD, { year: 2026, project: 'all', basis: 'accrual' });
  assert.equal(summary.earned, 109_800 + 54_900 + 45_000 + 36_600);
  assert.equal(summary.closed, 6);
  assert.equal(summary.previous, 54_900);
  assert.deepEqual(summary.toInvoice, { cents: 45_000, ims: [{ project: 'progetto-test', number: 60, date: '2026-10-08 10:00' }] });
  assert.deepEqual(summary.awaiting, { cents: 54_900, invoices: 1, overdue: 0, firstDue: '2026-10-31' });
  // Collected in 2026: A, and C at its taxable amount (no total of the document).
  assert.deepEqual(summary.collected, { cents: 109_800 + 30_000, lastPaid: '2026-09-20' });
  assert.equal(summary.chart.length, 12);
  assert.deepEqual(summary.chart[7], { key: '2026-08', label: 'ago', paid: 109_800, invoiced: 0, toInvoice: 0 });
  assert.deepEqual(summary.chart[9], { key: '2026-10', label: 'ott', paid: 0, invoiced: 0, toInvoice: 45_000 });
  // USD apart, never added to euros.
  assert.deepEqual(summary.others, [{ currency: 'USD', cents: 20_000 }]);
  assert.deepEqual(summary.othersWaiting, []);
  const usd = summarize({ ...DASHBOARD, invoices: [...DASHBOARD.invoices, { ...invoice('U', 'demo', 12_000, 10_000, '2026-09-30', null, null), currency: 'USD' }] }, { year: 2026, project: 'all', basis: 'accrual' });
  assert.deepEqual([usd.othersWaiting, usd.awaiting.cents], [[{ currency: 'USD', cents: 12_000 }], 54_900]);
  assert.deepEqual(
    summary.projects.map((project) => [project.name, project.cents, project.closed]),
    [
      ['progetto-test', 209_700, 4],
      ['demo', 36_600, 2],
    ],
  );
});

test('cassa: what came in, in the month of the payment; one project; every year', () => {
  const cash = summarize(DASHBOARD, { year: 2026, project: 'all', basis: 'cash' });
  assert.equal(cash.earned, 36_600 + 109_800);
  assert.deepEqual(cash.chart[8], { key: '2026-09', label: 'set', paid: 109_800, invoiced: 0, toInvoice: 0 });
  const demo = summarize(DASHBOARD, { year: 2026, project: 'demo', basis: 'accrual' });
  assert.deepEqual([demo.earned, demo.toInvoice.cents, demo.awaiting.invoices, demo.projects.length], [36_600, 0, 0, 1]);
  const all = summarize(DASHBOARD, { year: 'all', project: 'all', basis: 'accrual' });
  assert.equal(all.previous, null);
  assert.deepEqual(
    all.chart.map((bar) => bar.key),
    ['2025', '2026'],
  );
  assert.deepEqual(
    all.years.map((year) => [year.year, year.closed, year.cents]),
    [
      [2026, 6, 246_300],
      [2025, 1, 54_900],
    ],
  );
});

test('due dates and amounts of an invoice, round money and the scale of the chart', () => {
  assert.equal(dueText({ due: '2026-10-31', paidOn: null }, '2026-10-10'), 'scade il 31/10/2026');
  assert.equal(dueText({ due: '2026-10-31', paidOn: null }, '2026-11-01'), 'scaduta il 31/10/2026');
  assert.equal(dueText({ due: '2026-10-31', paidOn: '2026-10-20' }, '2026-11-01'), 'pagata il 20/10/2026');
  assert.equal(dueText({ due: null, paidOn: null }, '2026-11-01'), null);
  assert.equal(invoiceAmount({ documentCents: null, totalCents: 30_000 }), 30_000);
  assert.equal(invoiceAmount({ documentCents: 0, totalCents: 30_000 }), 0);
  assert.equal(roundMoneyText(2_115_049, 'EUR'), '21.150 €');
  assert.equal(chartScale([{ key: 'a', label: 'a', paid: 109_800, invoiced: 0, toInvoice: 45_000 }]), 200_000);
  assert.equal(chartScale([]), 100_000);
});

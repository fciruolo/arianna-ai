import assert from 'node:assert/strict';
import { test } from 'node:test';

import { balanceSeries, monthlyTotals, totalsByCategory, yearOverYear, type CategorizedTransaction, type Transaction } from '../src/index.ts';

let counter = 0;
const tx = (booked: string, amount: number, extra: Partial<CategorizedTransaction> = {}): CategorizedTransaction => ({
  account: 'conto-finto',
  booked,
  value: null,
  description: 'MOVIMENTO FINTO',
  amount,
  currency: 'EUR',
  balance: null,
  fingerprint: 'fp-' + String(++counter),
  category: null,
  by: null,
  ...extra,
});

test('monthlyTotals splits income and expenses and fills empty months', () => {
  const totals = monthlyTotals([tx('2025-01-05', 250000), tx('2025-01-10', -4550), tx('2025-01-31', -1), tx('2025-03-01', -1000)]);
  assert.deepEqual(totals, [
    { month: '2025-01', income: 250000, expenses: 4551, net: 245449, count: 3 },
    { month: '2025-02', income: 0, expenses: 0, net: 0, count: 0 },
    { month: '2025-03', income: 0, expenses: 1000, net: -1000, count: 1 },
  ]);
});

test('monthlyTotals with a range ignores rows outside it and counts 29 February', () => {
  const totals = monthlyTotals([tx('2024-02-29', -700), tx('2024-03-01', -300), tx('2023-12-31', -5)], { from: '2024-02', to: '2024-02' });
  assert.deepEqual(totals, [{ month: '2024-02', income: 0, expenses: 700, net: -700, count: 1 }]);
  assert.deepEqual(monthlyTotals([]), []);
  assert.deepEqual(monthlyTotals([], { from: '2025-04', to: '2025-04' }), [{ month: '2025-04', income: 0, expenses: 0, net: 0, count: 0 }]);
});

test('totals reject amounts that are not integer cents', () => {
  assert.throws(() => monthlyTotals([tx('2025-01-05', 12.5)]), RangeError);
});

test('totalsByCategory sums expenses and refunds per category inside the range', () => {
  const rows = [
    tx('2025-10-01', -5000, { category: 'spesa' }),
    tx('2025-10-15', 1000, { category: 'spesa' }),
    tx('2025-10-31', -9000, { category: 'casa' }),
    tx('2025-10-20', -200),
    tx('2025-11-01', -99999, { category: 'casa' }),
    tx('2025-09-30', -99999, { category: 'spesa' }),
  ];
  assert.deepEqual(totalsByCategory(rows, { from: '2025-10-01', to: '2025-10-31' }), [
    { category: 'casa', expenses: 9000, income: 0, count: 1 },
    { category: 'spesa', expenses: 5000, income: 1000, count: 2 },
    { category: null, expenses: 200, income: 0, count: 1 },
  ]);
  assert.deepEqual(totalsByCategory(rows, { from: '2025-12-01', to: '2025-12-31' }), []);
});

test('balanceSeries uses the bank balance when present and adds up otherwise', () => {
  const rows: Transaction[] = [
    tx('2025-10-02', -1000),
    tx('2025-10-01', 5000),
    tx('2025-10-03', -500, { balance: 100000 }),
    tx('2025-10-03', -250),
    tx('2025-10-05', -250),
  ];
  assert.deepEqual(balanceSeries(rows, 20000), [
    { day: '2025-10-01', balance: 25000, source: 'computed' },
    { day: '2025-10-02', balance: 24000, source: 'computed' },
    { day: '2025-10-03', balance: 99750, source: 'computed' },
    { day: '2025-10-05', balance: 99500, source: 'computed' },
  ]);
  assert.deepEqual(balanceSeries([tx('2025-10-01', -100, { balance: -5000 })]), [{ day: '2025-10-01', balance: -5000, source: 'bank' }]);
});

test('balanceSeries starts at zero, is empty without rows and refuses mixed accounts', () => {
  assert.deepEqual(balanceSeries([tx('2025-10-01', -100)]), [{ day: '2025-10-01', balance: -100, source: 'computed' }]);
  assert.deepEqual(balanceSeries([]), []);
  assert.throws(() => balanceSeries([tx('2025-10-01', 1), tx('2025-10-01', 1, { account: 'altro' })]), RangeError);
});

test('yearOverYear compares a month with the same month of the year before', () => {
  const rows = [tx('2024-02-29', -3000), tx('2025-02-28', -4500), tx('2025-02-01', 100000), tx('2025-01-31', -777)];
  const result = yearOverYear(rows, '2025-02');
  assert.equal(result.previous.month, '2024-02');
  assert.equal(result.previous.expenses, 3000);
  assert.equal(result.current.expenses, 4500);
  assert.equal(result.expensesChange, 1500);
  assert.equal(result.incomeChange, 100000);
});

test('yearOverYear with no data the year before compares with zero', () => {
  const result = yearOverYear([tx('2025-01-10', -100)], '2025-01');
  assert.deepEqual(result.previous, { month: '2024-01', income: 0, expenses: 0, net: 0, count: 0 });
  assert.equal(result.expensesChange, 100);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { balanceText, budgetDraft, budgetRows, latestMonths, monthChangeText, previousMonth, readableDescription } from '../src/lib/finance-dashboard.ts';
import { parseEuroInput, type MonthTotal } from '../src/lib/finance.ts';

function month(id: string, income: number, expenses: number, count = 1): MonthTotal {
  return { month: id, income, expenses, net: income - expenses, count };
}

test('previousMonth crosses the year', () => {
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-10'), '2026-09');
});

test('latestMonths takes the newest month with rows and the one before it', () => {
  const pair = latestMonths([month('2026-08', 180000, 46600), month('2026-09', 180000, 22549), month('2026-10', 0, 0, 0)]);
  assert.ok(pair !== null);
  assert.equal(pair.current.month, '2026-09');
  assert.equal(pair.previous.month, '2026-08');
});

test('latestMonths gives a zero month before when it is missing, and null without rows', () => {
  assert.deepEqual(latestMonths([month('2026-09', 0, 100)])?.previous, { month: '2026-08', income: 0, expenses: 0, net: 0, count: 0 });
  assert.equal(latestMonths([month('2026-09', 0, 0, 0)]), null);
  assert.equal(latestMonths([]), null);
});

test('monthChangeText says the change against the month before', () => {
  assert.equal(monthChangeText(22549, 46600, '2026-08'), '−52% rispetto ad agosto');
  assert.equal(monthChangeText(180000, 180000, '2026-08'), 'uguali ad agosto');
  assert.equal(monthChangeText(150, 100, '2026-09'), '+50% rispetto a settembre');
  assert.equal(monthChangeText(500, 0, '2026-07'), 'luglio: 0,00 €');
});

test('balanceText adds the accounts per currency', () => {
  assert.equal(balanceText([{ balance: 100000, currency: 'EUR' }, { balance: 184424, currency: 'EUR' }]), '2.844,24 €');
  assert.equal(balanceText([{ balance: 100000, currency: 'EUR' }, { balance: 5000, currency: 'USD' }]), '1.000,00 € · 50,00 USD');
  assert.equal(balanceText([]), '');
});

test('readableDescription splits payment kind and card from the merchant', () => {
  assert.deepEqual(readableDescription('PAGAMENTO POS SUPERMERCATO ALFA MILANO CARTA ****1234'), { title: 'Supermercato Alfa Milano', detail: 'Pagamento POS · carta ****1234' });
  assert.deepEqual(readableDescription('SDD STREAMING BETA ABBONAMENTO'), { title: 'Streaming Beta Abbonamento', detail: 'Addebito SDD' });
  assert.deepEqual(readableDescription('BONIFICO STIPENDIO DITTA FINTA SRL'), { title: 'Stipendio Ditta Finta Srl', detail: 'Bonifico' });
  assert.deepEqual(readableDescription('PAGAMENTO POS NEGOZIO DELTA DI ROSSI'), { title: 'Negozio Delta di Rossi', detail: 'Pagamento POS' });
});

test('readableDescription keeps mixed case, codes and a description that is only a kind', () => {
  assert.deepEqual(readableDescription('Caffè da Mario'), { title: 'Caffè da Mario', detail: '' });
  assert.deepEqual(readableDescription('PAGAMENTO POS AMAZON.IT*AB12CD'), { title: 'AMAZON.IT*AB12CD', detail: 'Pagamento POS' });
  assert.deepEqual(readableDescription('COMMISSIONI'), { title: 'Commissioni', detail: '' });
  assert.deepEqual(readableDescription('  '), { title: '', detail: '' });
});

test('budgetRows sets what was spent against each limit', () => {
  const rows = budgetRows(
    [{ category: 'food', monthly: 30000 }, { category: 'eat-out', monthly: 5000 }, { category: 'subs', monthly: 3000 }],
    [{ category: 'food', expenses: 9440, income: 0, count: 2 }, { category: 'eat-out', expenses: 6400, income: 0, count: 1 }],
  );
  assert.deepEqual(rows, [
    { category: 'food', limit: 30000, spent: 9440, percent: 31, over: false },
    { category: 'eat-out', limit: 5000, spent: 6400, percent: 100, over: true },
    { category: 'subs', limit: 3000, spent: 0, percent: 0, over: false },
  ]);
});

test('budgetDraft sends only what changed and refuses what is not an amount', () => {
  const budgets = [{ category: 'food', monthly: 30000 }, { category: 'eat-out', monthly: 5000 }];
  const draft = budgetDraft(budgets, { food: '300,00', 'eat-out': '80', subs: '', fun: 'tanti', shop: '0', home: '120' }, parseEuroInput);
  assert.deepEqual(draft.changes, [{ category: 'eat-out', monthly: 8000 }, { category: 'home', monthly: 12000 }]);
  assert.deepEqual(draft.invalid, ['fun', 'shop']);
  assert.deepEqual(budgetDraft(budgets, { food: '' }, parseEuroInput).changes, [{ category: 'food', monthly: null }]);
});

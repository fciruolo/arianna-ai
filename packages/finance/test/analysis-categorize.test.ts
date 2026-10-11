import assert from 'node:assert/strict';
import { test } from 'node:test';

import { categorize, matchRule, ruleFromConfirmation, type CategorizedTransaction, type CategoryRule, type Transaction } from '../src/index.ts';

let counter = 0;
const tx = (description: string, amount = -1000): Transaction => ({
  account: 'conto-finto',
  booked: '2025-10-03',
  value: null,
  description,
  amount,
  currency: 'EUR',
  balance: null,
  fingerprint: 'fp-' + String(++counter),
});

const rules: CategoryRule[] = [
  { id: 'r1', match: 'supermercato', category: 'spesa' },
  { id: 'r2', match: 'Supermercato Alfa', category: 'spesa-alfa' },
  { id: 'r3', match: 'STREAMING BETA', category: 'abbonamenti' },
  { id: 'r4', match: 'streaming beta', category: 'svago' },
  { id: 'r5', match: '   ', category: 'vuota' },
];

test('the longest matching rule wins, and the first on a tie', () => {
  assert.equal(matchRule('PAGAMENTO POS SUPERMERCATO ALFA CARTA ****1234 DEL 03/10', rules)?.id, 'r2');
  assert.equal(matchRule('PAGAMENTO POS SUPERMERCATO OMEGA', rules)?.id, 'r1');
  assert.equal(matchRule('SDD STREAMING BETA MANDATO 123456', rules)?.id, 'r3');
});

test('rules match whole words without case or accents, and an empty rule never matches', () => {
  assert.equal(matchRule('IPERSUPERMERCATONE', rules), null);
  assert.equal(matchRule('Caffè Delta', [{ id: 'c', match: 'caffe delta', category: 'bar' }])?.id, 'c');
  assert.equal(matchRule('BAR GAMMA', rules), null);
  assert.equal(matchRule('BAR GAMMA', []), null);
});

test('categorize applies rules and leaves the user choices alone', () => {
  const byUser: CategorizedTransaction = { ...tx('PAGAMENTO POS SUPERMERCATO ALFA'), category: 'regali', by: 'user' };
  const stale: CategorizedTransaction = { ...tx('BAR GAMMA'), category: 'spesa', by: 'rule' };
  const [first, second, third, fourth] = categorize([tx('POS SUPERMERCATO ALFA'), byUser, stale, tx('STREAMING BETA')], rules);
  assert.deepEqual([first?.category, first?.by], ['spesa-alfa', 'rule']);
  assert.deepEqual([second?.category, second?.by], ['regali', 'user']);
  assert.deepEqual([third?.category, third?.by], [null, null]);
  assert.deepEqual([fourth?.category, fourth?.by], ['abbonamenti', 'rule']);
  assert.notEqual(second, byUser);
});

test('categorize without rules leaves everything uncategorized', () => {
  const result = categorize([tx('SUPERMERCATO ALFA'), tx('STIPENDIO', 200000)], []);
  assert.ok(result.every((row) => row.category === null && row.by === null));
  assert.deepEqual(categorize([], rules), []);
});

test('ruleFromConfirmation proposes the merchant key, which then matches the next months', () => {
  const october = tx('PAGAMENTO POS SUPERMERCATO ALFA MILANO CARTA ****1234 DEL 03/10 ORE 18:42');
  const proposal = ruleFromConfirmation(october, 'spesa');
  assert.deepEqual(proposal, { match: 'supermercato alfa milano', category: 'spesa' });
  assert.ok(proposal);
  const november = tx('POS SUPERMERCATO ALFA MILANO CARTA XXXX1234 DEL 05/11 ORE 09.10');
  assert.equal(matchRule(november.description, [{ id: 'new', ...proposal }])?.category, 'spesa');
  assert.equal(matchRule('POS SUPERMERCATO OMEGA MILANO', [{ id: 'new', ...proposal }]), null);
});

test('ruleFromConfirmation gives nothing for a description without words', () => {
  assert.equal(ruleFromConfirmation(tx('123456 03/10'), 'spesa'), null);
});

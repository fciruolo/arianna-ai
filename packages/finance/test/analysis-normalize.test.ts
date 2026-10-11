import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMonths, daysBetween, isDay, merchantKey, monthsBetween, normalizeDescription } from '../src/index.ts';

test('normalizeDescription drops case, accents, dates, times, masked cards and references', () => {
  assert.equal(
    normalizeDescription('PAGAMENTO POS SUPERMERCATO ALFA MILANO CARTA ****1234 DEL 03/10 ORE 18:42'),
    'pagamento pos supermercato alfa milano carta del ore',
  );
  assert.equal(normalizeDescription('  Caffè   Délta\tRIF 998877  '), 'caffe delta rif');
  assert.equal(normalizeDescription('ACQUISTO 2025-10-03 NEGOZIO GAMMA 1.234,50'), 'acquisto negozio gamma');
  assert.equal(normalizeDescription('CARTA 5300********1234 BAR EPSILON'), 'carta bar epsilon');
});

test('normalizeDescription keeps short numbers and words', () => {
  assert.equal(normalizeDescription('FARMACIA 24 ORE'), 'farmacia 24 ore');
  assert.equal(normalizeDescription(''), '');
});

test('merchantKey is the same for the same shop in different months', () => {
  const october = merchantKey('PAGAMENTO POS SUPERMERCATO ALFA MILANO CARTA ****1234 DEL 03/10 ORE 18:42');
  const november = merchantKey('Pagamento POS Supermercato Alfa Milano carta XXXX1234 del 05/11/2025 ore 09.10');
  assert.equal(october, 'supermercato alfa milano');
  assert.equal(november, october);
  assert.equal(merchantKey('SDD STREAMING BETA MANDATO IT12ZZZ000000123 RIF 998877'), 'streaming beta');
  assert.equal(merchantKey('BONIFICO A FAVORE DI MARIO ROSSI CRO 123456789'), 'mario rossi');
});

test('merchantKey tells different shops apart and falls back on boilerplate-only rows', () => {
  assert.notEqual(merchantKey('PAGAMENTO POS SUPERMERCATO ALFA'), merchantKey('PAGAMENTO POS SUPERMERCATO OMEGA'));
  assert.equal(merchantKey('ADDEBITO CANONE'), 'addebito canone');
  assert.equal(merchantKey('FARMACIA 24'), 'farmacia');
});

test('calendar helpers handle leap years and month ends', () => {
  assert.ok(isDay('2024-02-29'));
  assert.ok(!isDay('2023-02-29'));
  assert.ok(!isDay('2025-13-01'));
  assert.ok(!isDay('3/10/2025'));
  assert.equal(addMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(addMonths('2025-12-15', 1), '2026-01-15');
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2);
  assert.equal(daysBetween('2025-02-28', '2025-03-01'), 1);
  assert.deepEqual(monthsBetween('2024-11', '2025-02'), ['2024-11', '2024-12', '2025-01', '2025-02']);
  assert.deepEqual(monthsBetween('2025-02', '2025-01'), []);
  assert.throws(() => daysBetween('2025-02-30', '2025-03-01'), RangeError);
});

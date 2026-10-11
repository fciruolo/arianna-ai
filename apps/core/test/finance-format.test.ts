import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext, FINANCE_DERIVED_SOURCE, isFinanceContext } from '@arianna/policy';

import {
  dayParam,
  decodeFile,
  euro,
  FinanceError,
  lastDayOf,
  lineOf,
  MAX_IMPORT_BYTES,
  monthParam,
  parseProfile,
  searchText,
  sheetOf,
  storedProfile,
} from '../src/finance-format.ts';
import { contextOf, outputSource } from '../src/finance-mark.ts';

const PROFILE = {
  booked: 'Data contabile',
  value: 'Data valuta',
  description: ['Descrizione'],
  amount: { kind: 'single', column: 'Importo' },
  balance: null,
  currency: null,
  dateFormat: 'dd/mm/yyyy',
  decimal: ',',
};

function code(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof FinanceError, String(error));
    return error.code;
  }
  assert.fail('no error');
}

test('a bank profile from the page is checked field by field', () => {
  assert.deepEqual(parseProfile(PROFILE), PROFILE);
  assert.deepEqual(parseProfile({ ...PROFILE, amount: { kind: 'split', debit: 'Dare', credit: 'Avere' } }).amount, { kind: 'split', debit: 'Dare', credit: 'Avere' });
  assert.equal(code(() => parseProfile({ ...PROFILE, extra: 1 })), 'invalid');
  assert.equal(code(() => parseProfile({ ...PROFILE, dateFormat: 'mm/dd/yyyy' })), 'invalid');
  assert.equal(code(() => parseProfile({ ...PROFILE, decimal: ';' })), 'invalid');
  assert.equal(code(() => parseProfile({ ...PROFILE, description: [] })), 'invalid');
  assert.equal(code(() => parseProfile({ ...PROFILE, amount: { kind: 'single', column: '' } })), 'invalid');
  assert.equal(code(() => parseProfile({ ...PROFILE, amount: { kind: 'both' } })), 'invalid');
  // A profile in the database that is not one any more reads as none, never as an error.
  assert.deepEqual(storedProfile(PROFILE), PROFILE);
  assert.equal(storedProfile({ booked: 1 }), null);
  assert.equal(storedProfile(null), null);
});

test('the file comes in strict base64, 10 MiB at most', () => {
  assert.deepEqual([...decodeFile(Buffer.from('a;b\n').toString('base64'))], [...Buffer.from('a;b\n')]);
  assert.equal(code(() => decodeFile('not base64!')), 'invalid');
  assert.equal(code(() => decodeFile('abc')), 'invalid');
  assert.equal(code(() => decodeFile('')), 'invalid');
  assert.equal(code(() => decodeFile(42)), 'invalid');
  const tooLarge = 'A'.repeat(Math.ceil(((MAX_IMPORT_BYTES + 3) * 4) / 3 / 4) * 4);
  assert.throws(() => decodeFile(tooLarge), (error: unknown) => error instanceof FinanceError && error.code === 'too-large' && error.status === 413);
});

test('lines, sheets, days and months of a request', () => {
  assert.equal(lineOf('  Conto corrente ', 80, 'name'), 'Conto corrente');
  assert.equal(code(() => lineOf('a\nb', 80, 'name')), 'invalid');
  assert.equal(code(() => lineOf('   ', 80, 'name')), 'invalid');
  assert.equal(code(() => lineOf('x'.repeat(81), 80, 'name')), 'invalid');
  assert.equal(sheetOf('Movimenti'), 'Movimenti');
  assert.equal(sheetOf(0), 0);
  assert.equal(sheetOf(undefined), undefined);
  assert.equal(code(() => sheetOf(-1)), 'invalid');
  assert.equal(dayParam('2026-02', 'from', 'from'), '2026-02-01');
  assert.equal(dayParam('2024-02', 'to', 'to'), '2024-02-29');
  assert.equal(dayParam('2026-10-03', 'to', 'to'), '2026-10-03');
  assert.equal(dayParam(null, 'to', 'to'), undefined);
  assert.equal(code(() => dayParam('2026-13-01', 'from', 'from')), 'invalid');
  assert.equal(monthParam('2026-10-03', 'month'), '2026-10');
  assert.equal(code(() => monthParam('ottobre', 'month')), 'invalid');
  assert.equal(lastDayOf('2026-04'), '2026-04-30');
});

test('the search ignores case and accents; amounts are written in Italian', () => {
  assert.equal(searchText('  Caffè   BAR Più '), 'caffe bar piu');
  assert.equal(euro(-123456), '-1.234,56 €');
  assert.equal(euro(5), '0,05 €');
  assert.equal(euro(100000000, 'USD'), '1.000.000,00 USD');
});

test('a marked task gives a marked context at L2 and writes finance:derived; an unmarked one does not', () => {
  const marked = contextOf({ clearance: 'L2', finance: true }, 'L0');
  assert.equal(isFinanceContext(marked), true);
  assert.equal(marked.effective, 'L2');
  assert.equal(outputSource({ finance: true }, 'task:1'), FINANCE_DERIVED_SOURCE);
  const plain = contextOf({ clearance: 'L2', finance: false }, 'L1');
  assert.equal(isFinanceContext(plain), false);
  assert.deepEqual(plain, createContext('L2', 'L1'));
  assert.equal(outputSource({ finance: false }, 'task:1'), 'task:1');
  // A work conversation can never be marked: the policy refuses the context.
  assert.throws(() => contextOf({ clearance: 'L1', finance: true }, 'L1'));
});

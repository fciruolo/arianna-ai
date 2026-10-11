import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findHeader, guessProfile, parseAmount, parseDate } from '../src/index.ts';
import type { SheetRow } from '../src/index.ts';

test('amounts with decimal comma', () => {
  assert.equal(parseAmount('1.234,56', ','), 123456);
  assert.equal(parseAmount('-12,5', ','), -1250);
  assert.equal(parseAmount('12,50-', ','), -1250);
  assert.equal(parseAmount('(12,50)', ','), -1250);
  assert.equal(parseAmount('+3', ','), 300);
  assert.equal(parseAmount('€ 1 234,56', ','), 123456);
  assert.equal(parseAmount('-1.234.567,00 EUR', ','), -123456700);
  assert.equal(parseAmount('−1,00', ','), -100);
  assert.equal(parseAmount('0,00', ','), 0);
});

test('amounts with decimal point', () => {
  assert.equal(parseAmount('1,234.56', '.'), 123456);
  assert.equal(parseAmount('-1234.56', '.'), -123456);
  assert.equal(parseAmount("1'234.50", '.'), 123450);
  assert.equal(parseAmount('0.1', '.'), 10);
});

test('the wrong decimal mark fails instead of shifting the comma', () => {
  assert.equal(parseAmount('1.234,56', '.'), null);
  assert.equal(parseAmount('1,234.56', ','), null);
  assert.equal(parseAmount('1.23456', '.'), null);
  assert.equal(parseAmount('1.2345,00', ','), null);
  assert.equal(parseAmount('12,500', ','), 1250);
  assert.equal(parseAmount('abc', ','), null);
  assert.equal(parseAmount('', ','), null);
  assert.equal(parseAmount('--1', ','), null);
});

test('Excel numbers become cents without float drift', () => {
  assert.equal(parseAmount(-1.5, ','), -150);
  assert.equal(parseAmount(0.1 + 0.2, ','), 30);
  assert.equal(parseAmount(1234.5599999999999, ','), 123456);
  assert.equal(parseAmount(1e-7, ','), 0);
  assert.equal(parseAmount(Number.POSITIVE_INFINITY, ','), null);
  assert.equal(parseAmount({ day: '2026-01-01' }, ','), null);
});

test('dates in every format', () => {
  assert.equal(parseDate('02/01/2026', 'dd/mm/yyyy'), '2026-01-02');
  assert.equal(parseDate('2/1/2026 10:30', 'dd/mm/yyyy'), '2026-01-02');
  assert.equal(parseDate('02-01-2026', 'dd-mm-yyyy'), '2026-01-02');
  assert.equal(parseDate('02.01.2026', 'dd.mm.yyyy'), '2026-01-02');
  assert.equal(parseDate('2026-01-02', 'yyyy-mm-dd'), '2026-01-02');
  assert.equal(parseDate('2026-01-02T08:00:00', 'yyyy-mm-dd'), '2026-01-02');
  assert.equal(parseDate('02/01/26', 'dd/mm/yy'), '2026-01-02');
  assert.equal(parseDate(46024, 'serial'), '2026-01-02');
  assert.equal(parseDate('46024', 'serial'), '2026-01-02');
  assert.equal(parseDate({ day: '2026-01-02' }, 'dd/mm/yyyy'), '2026-01-02');
});

test('invalid dates are refused', () => {
  assert.equal(parseDate('31/02/2026', 'dd/mm/yyyy'), null);
  assert.equal(parseDate('29/02/2025', 'dd/mm/yyyy'), null);
  assert.equal(parseDate('29/02/2024', 'dd/mm/yyyy'), '2024-02-29');
  assert.equal(parseDate('2026-01-02', 'dd/mm/yyyy'), null);
  assert.equal(parseDate('02/01/2026', 'yyyy-mm-dd'), null);
  assert.equal(parseDate(46024, 'dd/mm/yyyy'), null);
  assert.equal(parseDate('Saldo finale', 'dd/mm/yyyy'), null);
  assert.equal(parseDate(null, 'dd/mm/yyyy'), null);
});

test('the header row is found below the bank preamble', () => {
  const rows: SheetRow[] = [
    { line: 1, cells: ['Banca Finta S.p.A.'] },
    { line: 2, cells: ['Conto', 'IT00 X000 0000 0000 0000 0000 000'] },
    { line: 4, cells: ['Data contabile', 'Data valuta', 'Descrizione', 'Importo'] },
    { line: 5, cells: ['02/01/2026', '02/01/2026', 'Bar Fittizio', '-1,50'] },
  ];
  assert.equal(findHeader(rows), 2);
  assert.equal(findHeader(rows.slice(0, 2)), null);
});

test('guesses an Italian profile with a single amount', () => {
  const profile = guessProfile(
    ['Data contabile', 'Data valuta', 'Causale', 'Descrizione', 'Importo (€)', 'Saldo', 'Divisa'],
    [['02/01/2026', '03/01/2026', 'PAGAMENTO POS', 'Bar Fittizio', '-1.234,50', '10,00', 'EUR']],
  );
  assert.deepEqual(profile, {
    booked: 'Data contabile',
    value: 'Data valuta',
    description: ['Causale', 'Descrizione'],
    amount: { kind: 'single', column: 'Importo (€)' },
    balance: 'Saldo',
    currency: 'Divisa',
    dateFormat: 'dd/mm/yyyy',
    decimal: ',',
  });
});

test('guesses a debit and credit profile', () => {
  const profile = guessProfile(['Data', 'Valuta', 'Descrizione operazione', 'Dare', 'Avere'], [['02-01-2026', '02-01-2026', 'Negozio Finto', '12,00', '']]);
  assert.equal(profile?.booked, 'Data');
  assert.equal(profile.value, 'Valuta');
  assert.deepEqual(profile.amount, { kind: 'split', debit: 'Dare', credit: 'Avere' });
  assert.equal(profile.dateFormat, 'dd-mm-yyyy');
});

test('guesses an English profile with decimal point and ISO dates', () => {
  const profile = guessProfile(['Date', 'Description', 'Amount', 'Balance'], [['2026-01-02', 'Fake Store', '-1,234.50', '100.00']]);
  assert.equal(profile?.dateFormat, 'yyyy-mm-dd');
  assert.equal(profile.decimal, '.');
  assert.deepEqual(profile.amount, { kind: 'single', column: 'Amount' });
});

test('a "Valuta" column of currency codes is the currency', () => {
  const profile = guessProfile(['Data', 'Descrizione', 'Importo', 'Valuta'], [['02/01/2026', 'Bar Fittizio', '-1,50', 'EUR']]);
  assert.equal(profile?.value, null);
  assert.equal(profile.currency, 'Valuta');
});

test('Excel serial numbers as dates are guessed as serial', () => {
  const profile = guessProfile(['Data', 'Descrizione', 'Importo'], [[46024, 'Bar Fittizio', -1.5]]);
  assert.equal(profile?.dateFormat, 'serial');
});

test('no profile without a date, a description or an amount', () => {
  assert.equal(guessProfile(['Descrizione', 'Importo'], [['Bar', '-1,00']]), null);
  assert.equal(guessProfile(['Data', 'Importo'], [['02/01/2026', '-1,00']]), null);
  assert.equal(guessProfile(['Data', 'Descrizione', 'Dare'], [['02/01/2026', 'Bar', '1,00']]), null);
  assert.equal(guessProfile(['Data', 'Descrizione', 'Importo'], [['ieri', 'Bar', '-1,00']]), null);
});

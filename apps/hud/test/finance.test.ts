// The page "Finanze" (I-18, D-183): the address, amounts from cents in
// Italian, the codes of the import, the profile edited by hand, the sentences
// of the checks and the movements they point at. Every number here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  alertFilter,
  alertText,
  amountClass,
  bytesToBase64,
  centsInput,
  changeText,
  draftOf,
  draftProblems,
  EMPTY_FILTER,
  fileProblem,
  filterQuery,
  financeErrorText,
  financePathFor,
  financeTabFromPath,
  formatCents,
  formatCompact,
  formatDay,
  formatMonth,
  headerChoices,
  IMPORT_ERROR_TEXT,
  isFinancePath,
  lastDayOf,
  merchantQuery,
  nameLookup,
  nameProblem,
  parseEuroInput,
  profileOf,
  rejectText,
  REJECT_TEXT,
  type BankProfile,
  type FinanceAlert,
  type NameLookup,
} from '../src/lib/finance.ts';

test('the address: /finanze and its tabs, nothing else', () => {
  assert.equal(isFinancePath('/finanze'), true);
  assert.equal(isFinancePath('/finanze/'), true);
  assert.equal(isFinancePath('/finanze/movimenti'), true);
  assert.equal(isFinancePath('/finanze/altro'), false);
  assert.equal(isFinancePath('/finanzex'), false);
  assert.equal(financeTabFromPath('/finanze/avvisi'), 'avvisi');
  assert.equal(financeTabFromPath('/finanze'), undefined);
  assert.equal(financePathFor(undefined), '/finanze');
  assert.equal(financePathFor('importa'), '/finanze/importa');
});

test('amounts from integer cents in Italian', () => {
  assert.equal(formatCents(123456), '1.234,56 €');
  assert.equal(formatCents(-1250), '−12,50 €');
  assert.equal(formatCents(5), '0,05 €');
  assert.equal(formatCents(0), '0,00 €');
  assert.equal(formatCents(100000000), '1.000.000,00 €');
  assert.equal(formatCents(1000, { sign: true }), '+10,00 €');
  assert.equal(formatCents(-1000, { sign: true }), '−10,00 €');
  assert.equal(formatCents(1000, { currency: 'USD' }), '10,00 USD');
});

test('short amounts for the axes', () => {
  assert.equal(formatCompact(85000), '850 €');
  assert.equal(formatCompact(120000), '1,2k €');
  assert.equal(formatCompact(300000), '3k €');
  assert.equal(formatCompact(-300000), '−3k €');
});

test('what the user writes in euro becomes cents, or null', () => {
  assert.equal(parseEuroInput('12'), 1200);
  assert.equal(parseEuroInput('12,5'), 1250);
  assert.equal(parseEuroInput('1.234,56'), 123456);
  assert.equal(parseEuroInput('12.50'), 1250);
  assert.equal(parseEuroInput('1.234'), 123400);
  assert.equal(parseEuroInput(' 300 € '), 30000);
  assert.equal(parseEuroInput(''), null);
  assert.equal(parseEuroInput('abc'), null);
  assert.equal(parseEuroInput('12,345'), null);
  assert.equal(parseEuroInput('-5'), null);
  assert.equal(centsInput(123456), '1234,56');
});

test('days and months in Italian', () => {
  assert.equal(formatDay('2026-10-11'), '11/10/2026');
  assert.equal(formatDay(null), '—');
  assert.equal(formatMonth('2026-10'), 'ott 2026');
  assert.equal(formatMonth('2026-01', true), 'gennaio 2026');
  assert.equal(lastDayOf('2026-02'), '2026-02-28');
  assert.equal(lastDayOf('2028-02'), '2028-02-29');
  assert.equal(lastDayOf('2026-12'), '2026-12-31');
});

test('income in green, expenses in the normal colour', () => {
  assert.equal(amountClass(100), 'text-ok');
  assert.equal(amountClass(-100), '');
});

test('every code of the import has a sentence; an unknown reject has a generic one', () => {
  const codes = ['empty', 'too-large', 'too-many-rows', 'too-many-columns', 'cell-too-long', 'unterminated-quote', 'unsupported-encoding', 'unsupported-type', 'type-mismatch', 'xls', 'bad-zip', 'encrypted', 'zip64', 'bad-path', 'unzipped-too-large', 'bad-xlsx', 'bad-xml', 'no-sheet', 'no-header', 'unknown-columns', 'profile-mismatch'];
  for (const code of codes) assert.ok(IMPORT_ERROR_TEXT[code], code);
  for (const code of ['missing-date', 'bad-date', 'missing-amount', 'bad-amount', 'both-amounts']) assert.ok(REJECT_TEXT[code], code);
  assert.equal(rejectText('bad-date'), 'data non leggibile con il formato scelto');
  assert.equal(rejectText('something-else'), 'riga non valida');
});

test('errors of the API in Italian, with the line when the core gives it', () => {
  assert.equal(financeErrorText(new ApiError(400, 'xls')), IMPORT_ERROR_TEXT.xls);
  assert.equal(financeErrorText(new ApiError(400, 'unterminated-quote', { error: 'unterminated-quote', line: 12 })), 'Nel CSV c’è una cella fra virgolette che non viene mai chiusa (riga 12).');
  assert.equal(financeErrorText(new ApiError(413, 'HTTP 413')), IMPORT_ERROR_TEXT['too-large']);
  assert.match(financeErrorText(new ApiError(404, 'not found')), /nucleo non ha ancora le Finanze/);
  assert.equal(financeErrorText(new TypeError('fetch failed')), 'Il nucleo non risponde: controlla che sia avviato.');
  assert.equal(financeErrorText(new ApiError(400, 'something else')), 'Richiesta non valida.');
});

test('the file chosen: only .csv and .xlsx (and .tsv, .txt), not empty, at most 10 MB', () => {
  assert.equal(fileProblem('estratto.csv', 100), null);
  assert.equal(fileProblem('Estratto.XLSX', 100), null);
  assert.equal(fileProblem('vecchio.xls', 100), IMPORT_ERROR_TEXT.xls);
  assert.equal(fileProblem('foto.png', 100), IMPORT_ERROR_TEXT['unsupported-type']);
  assert.equal(fileProblem('vuoto.csv', 0), IMPORT_ERROR_TEXT.empty);
  assert.equal(fileProblem('grande.csv', 11 * 1024 * 1024), IMPORT_ERROR_TEXT['too-large']);
});

test('bytes to base64, also past one chunk', () => {
  assert.equal(bytesToBase64(new TextEncoder().encode('Data;Importo\n')), Buffer.from('Data;Importo\n').toString('base64'));
  const large = new Uint8Array(100_000).map((_, index) => index % 251);
  assert.equal(bytesToBase64(large), Buffer.from(large).toString('base64'));
  assert.equal(bytesToBase64(new Uint8Array()), '');
});

const PROFILE: BankProfile = {
  booked: 'Data contabile',
  value: 'Data valuta',
  description: ['Descrizione'],
  amount: { kind: 'split', debit: 'Dare', credit: 'Avere' },
  balance: null,
  currency: null,
  dateFormat: 'dd/mm/yyyy',
  decimal: ',',
};

test('the profile through the selects and back is the same', () => {
  assert.deepEqual(profileOf(draftOf(PROFILE)), PROFILE);
  const single: BankProfile = { ...PROFILE, value: null, description: ['Causale', 'Descrizione'], amount: { kind: 'single', column: 'Importo' }, balance: 'Saldo', decimal: '.' };
  assert.deepEqual(profileOf(draftOf(single)), single);
});

test('an incomplete profile says what is missing and gives no profile', () => {
  const empty = draftOf(null);
  assert.equal(profileOf(empty), null);
  assert.deepEqual(draftProblems(empty), ['Scegli la colonna della data.', 'Scegli la colonna della descrizione.', 'Scegli la colonna dell’importo.']);
  const same = { ...draftOf(PROFILE), credit: 'Dare' };
  assert.deepEqual(draftProblems(same), ['Dare e avere devono essere due colonne diverse.']);
  assert.equal(draftProblems(draftOf(PROFILE)).length, 0);
});

test('a second description equal to the first is dropped', () => {
  const draft = { ...draftOf(PROFILE), description2: 'Descrizione' };
  assert.deepEqual(profileOf(draft)?.description, ['Descrizione']);
});

test('header choices: trimmed, non-empty, each once', () => {
  assert.deepEqual(headerChoices(['Data', ' Data ', '', 'Importo']), ['Data', 'Importo']);
});

test('the filters as a query; uncategorized wins over a category', () => {
  assert.equal(filterQuery(EMPTY_FILTER, 100, 0), 'limit=100');
  assert.equal(filterQuery({ account: 'a1', from: '2026-01-01', to: '2026-01-31', category: 'c1', uncategorized: false, q: ' coop ' }, 50, 100), 'account=a1&from=2026-01-01&to=2026-01-31&category=c1&q=coop&limit=50&offset=100');
  assert.equal(filterQuery({ ...EMPTY_FILTER, category: 'c1', uncategorized: true }, 100, 0), 'uncategorized=1&limit=100');
});

const NAMES: NameLookup = { account: (id) => (id === 'a1' ? 'Conto corrente' : 'Conto'), category: (id) => (id === 'c1' ? 'Spesa' : 'Senza categoria') };

test('the sentences of the checks, one per kind', () => {
  const recurring: FinanceAlert = { kind: 'recurring', account: 'a1', merchant: 'palestra fit', direction: 'out', cadence: 'monthly', fingerprints: ['f1', 'f2', 'f3'], amount: 3900, lastAmount: 4500, amountChanged: true, lastDay: '2026-10-02', nextExpected: '2026-11-02' };
  const text = alertText(recurring, NAMES);
  assert.equal(text.title, 'L’addebito mensile di «palestra fit» è salito da 39,00 € a 45,00 €');
  assert.equal(text.detail, 'Ultimo il 02/10/2026, prossimo atteso verso il 02/11/2026 · Conto corrente');
  assert.equal(text.tone, 'danger');
  assert.equal(alertText({ ...recurring, direction: 'in', lastAmount: 3500 }, NAMES).title, 'L’accredito mensile di «palestra fit» è sceso da 39,00 € a 35,00 €');

  const unusual: FinanceAlert = { kind: 'unusual', fingerprint: 'f9', account: 'a1', merchant: 'ferramenta', category: 'c1', amount: 32000, basis: 'category', median: 4000, historyCount: 7, ratioPercent: 800 };
  assert.equal(alertText(unusual, NAMES).title, 'Spesa insolita da «ferramenta»: 320,00 €');
  assert.equal(alertText(unusual, NAMES).detail, 'Circa 8 volte la cifra abituale (40,00 €, la mediana delle altre 7 spese in Spesa) · Conto corrente');
  assert.match(alertText({ ...unusual, basis: 'merchant', ratioPercent: 350 }, NAMES).detail, /^Circa 3,5 volte .* da «ferramenta»\)/);

  const duplicate: FinanceAlert = { kind: 'duplicate', account: 'a1', merchant: 'streaming', amount: 1299, fingerprints: ['f4', 'f5'], firstDay: '2026-10-03', lastDay: '2026-10-04', recurring: true };
  assert.equal(alertText(duplicate, NAMES).title, 'Possibile doppio addebito da «streaming»: 2 volte 12,99 €');
  assert.match(alertText(duplicate, NAMES).detail, /^fra il 03\/10\/2026 e il 04\/10\/2026, oltre all’addebito abituale/);

  const budget: FinanceAlert = { kind: 'budget', category: 'c1', month: '2026-10', spent: 42000, limit: 40000, percent: 105, state: 'over', fingerprints: [] };
  assert.equal(alertText(budget, NAMES).title, 'Budget superato: Spesa');
  assert.equal(alertText(budget, NAMES).detail, 'Spesi 420,00 € su 400,00 € (105%) in ottobre 2026');
  assert.equal(alertText({ ...budget, state: 'near', spent: 34000, percent: 85 }, NAMES).tone, 'warn');
});

test('each check points at its movements', () => {
  assert.deepEqual(alertFilter({ kind: 'budget', category: 'c1', month: '2026-02', spent: 1, limit: 1, percent: 100, state: 'near', fingerprints: [] }), { ...EMPTY_FILTER, category: 'c1', from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(alertFilter({ kind: 'duplicate', account: 'a1', merchant: 'bar centrale', amount: 1500, fingerprints: [], firstDay: '2026-10-01', lastDay: '2026-10-03', recurring: false }), { ...EMPTY_FILTER, account: 'a1', from: '2026-10-01', to: '2026-10-03', q: 'centrale' });
  const recurring = alertFilter({ kind: 'recurring', account: 'a1', merchant: 'fit', direction: 'out', cadence: 'monthly', fingerprints: ['a', 'b', 'c'], amount: 1, lastAmount: 2, amountChanged: true, lastDay: '2026-10-02', nextExpected: '2026-11-02' });
  assert.equal(recurring.to, '2026-10-02');
  assert.equal(recurring.from, '2026-07-01');
  assert.equal(merchantQuery('pam super'), 'super');
});

test('names for the sentences, with a fallback for what was removed', () => {
  const names = nameLookup([{ id: 'a1', name: 'Conto corrente', currency: 'EUR', profile: null, archived: false, transactions: 0, lastBooked: null }], [{ id: 'c1', name: 'Spesa', kind: 'out' }]);
  assert.equal(names.account('a1'), 'Conto corrente');
  assert.equal(names.account('zz'), 'conto non più presente');
  assert.equal(names.category('c1'), 'Spesa');
  assert.equal(names.category(null), 'Senza categoria');
});

test('names of one line, 1-80 characters', () => {
  assert.equal(nameProblem('Conto corrente'), null);
  assert.equal(nameProblem('  '), 'Scrivi un nome.');
  assert.equal(nameProblem('x'.repeat(81)), 'Il nome supera 80 caratteri.');
  assert.equal(nameProblem('a\nb'), 'Il nome sta su una riga.');
});

test('the change against the year before', () => {
  assert.equal(changeText(0, 100), 'uguale');
  assert.equal(changeText(5000, 20000), '+50,00 € (+25%)');
  assert.equal(changeText(-5000, 20000), '−50,00 € (−25%)');
  assert.equal(changeText(5000, 0), '+50,00 €');
});

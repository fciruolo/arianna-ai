import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectKind, FinanceImportError, previewImport } from '../src/index.ts';
import type { BankProfile } from '../src/index.ts';
import { xlsx } from './support/xlsx-writer.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function rejects(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof FinanceImportError && error.code === code);
}

const STATEMENT = [
  'Banca Finta S.p.A. - Estratto conto',
  'Intestatario;Mario Inventato',
  '',
  'Data contabile;Data valuta;Descrizione;Importo;Saldo',
  '02/01/2026;02/01/2026;Bar Fittizio;-1,20;998,80',
  '02/01/2026;02/01/2026;Bar Fittizio;-1,20;997,60',
  '03/01/2026;03/01/2026;"Stipendio Ditta Inventata, gennaio";1.500,00;2.497,60',
  'Saldo finale;;;;2.497,60',
  '04/01/2026;04/01/2026;Errore;abc;',
  '',
].join('\n');

test('a CSV statement becomes transactions with rejected rows and totals', () => {
  const preview = previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-1' });
  assert.equal(preview.kind, 'csv');
  assert.equal(preview.guessed, true);
  assert.equal(preview.headerLine, 4);
  assert.deepEqual(
    preview.rows.map((row) => [row.line, row.transaction.booked, row.transaction.amount, row.transaction.description]),
    [
      [5, '2026-01-02', -120, 'Bar Fittizio'],
      [6, '2026-01-02', -120, 'Bar Fittizio'],
      [7, '2026-01-03', 150000, 'Stipendio Ditta Inventata, gennaio'],
    ],
  );
  const first = preview.rows[0]?.transaction;
  assert.deepEqual({ ...first, fingerprint: undefined }, {
    account: 'conto-1',
    booked: '2026-01-02',
    value: '2026-01-02',
    description: 'Bar Fittizio',
    amount: -120,
    currency: 'EUR',
    balance: 99880,
    fingerprint: undefined,
  });
  assert.notEqual(preview.rows[0]?.transaction.fingerprint, preview.rows[1]?.transaction.fingerprint);
  assert.deepEqual(preview.rejected, [
    { line: 8, reason: 'bad-date' },
    { line: 9, reason: 'bad-amount' },
  ]);
  assert.deepEqual(preview.totals, { count: 3, income: 150000, expenses: 240 });
  assert.deepEqual(preview.duplicates, []);
});

test('the same file imported twice is all duplicates', () => {
  const first = previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-1' });
  const existing = new Set(first.rows.map((row) => row.transaction.fingerprint));
  const second = previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-1', existing });
  assert.equal(second.rows.length, 0);
  assert.equal(second.duplicates.length, 3);
  assert.deepEqual(second.totals, { count: 0, income: 0, expenses: 0 });
});

test('an overlapping statement adds only the new movements, even a third identical coffee', () => {
  const first = previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-1' });
  const existing = new Set(first.rows.map((row) => row.transaction.fingerprint));
  const next = [
    'Data contabile;Data valuta;Descrizione;Importo;Saldo',
    '02/01/2026;02/01/2026;Bar Fittizio;-1,20;998,80',
    '02/01/2026;02/01/2026;Bar Fittizio;-1,20;997,60',
    '02/01/2026;02/01/2026;Bar Fittizio;-1,20;996,40',
    '05/01/2026;05/01/2026;Forno Immaginario;-3,40;993,00',
  ].join('\n');
  const preview = previewImport(utf8(next), 'febbraio.csv', { account: 'conto-1', existing });
  assert.equal(preview.duplicates.length, 2);
  assert.deepEqual(
    preview.rows.map((row) => row.line),
    [4, 5],
  );
});

test('the same movements on another account are not duplicates', () => {
  const first = previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-1' });
  const existing = new Set(first.rows.map((row) => row.transaction.fingerprint));
  assert.equal(previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-2', existing }).duplicates.length, 0);
});

test('debit and credit columns with a given profile', () => {
  const profile: BankProfile = {
    booked: 'Data',
    value: null,
    description: ['Descrizione'],
    amount: { kind: 'split', debit: 'Uscite', credit: 'Entrate' },
    balance: null,
    currency: null,
    dateFormat: 'dd/mm/yy',
    decimal: ',',
  };
  const csv = ['Data;Descrizione;Uscite;Entrate', '02/01/26;Negozio Finto;12,00;', '03/01/26;Rimborso Finto;;5,50', '04/01/26;Strano;-3,00;', '05/01/26;Doppio;1,00;1,00', '06/01/26;Vuoto;;'].join('\r\n');
  const preview = previewImport(utf8(csv), 'conto.csv', { account: 'conto-1', profile });
  assert.equal(preview.guessed, false);
  assert.deepEqual(
    preview.rows.map((row) => row.transaction.amount),
    [-1200, 550, -300],
  );
  assert.deepEqual(preview.rejected, [
    { line: 5, reason: 'both-amounts' },
    { line: 6, reason: 'missing-amount' },
  ]);
});

test('a profile whose columns are not in the file is refused', () => {
  const profile: BankProfile = {
    booked: 'Data',
    value: null,
    description: ['Descrizione'],
    amount: { kind: 'single', column: 'Movimento' },
    balance: null,
    currency: null,
    dateFormat: 'dd/mm/yyyy',
    decimal: ',',
  };
  rejects(() => previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-1', profile }), 'profile-mismatch');
});

test('a file without a recognizable header is refused', () => {
  rejects(() => previewImport(utf8('a;b;c\n1;2;3\n'), 'x.csv', { account: 'conto-1' }), 'no-header');
});

test('an .xlsx statement with shared strings and date cells', () => {
  const bytes = xlsx({
    sheets: [
      {
        name: 'Lista movimenti',
        rows: [
          ['Banca Finta'],
          ['Date', 'Description', 'Amount', 'Currency'],
          [{ serial: 46024 }, 'Fake Coffee Shop', -2.5, 'EUR'],
          [{ serial: 46024 }, 'Fake Coffee Shop', -2.5, 'EUR'],
          [{ serial: 46026 }, 'Pretend Refund', 10.1, 'USD'],
        ],
      },
    ],
  });
  const preview = previewImport(bytes, 'Movimenti.XLSX', { account: 'conto-1' });
  assert.equal(preview.kind, 'xlsx');
  assert.deepEqual(preview.source, { kind: 'xlsx', sheet: 'Lista movimenti', sheets: ['Lista movimenti'] });
  assert.deepEqual(
    preview.rows.map((row) => [row.line, row.transaction.booked, row.transaction.amount, row.transaction.currency]),
    [
      [3, '2026-01-02', -250, 'EUR'],
      [4, '2026-01-02', -250, 'EUR'],
      [5, '2026-01-04', 1010, 'USD'],
    ],
  );
  assert.equal(new Set(preview.rows.map((row) => row.transaction.fingerprint)).size, 3);
});

test('file kind from the extension, confirmed by the first bytes', () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const workbook = xlsx({ sheets: [{ name: 'S', rows: [['x']] }] });
  assert.equal(detectKind(utf8('a;b'), 'estratto.CSV'), 'csv');
  assert.equal(detectKind(workbook, 'estratto.xlsx'), 'xlsx');
  rejects(() => detectKind(ole, 'estratto.xls'), 'xls');
  rejects(() => detectKind(ole, 'estratto.xlsx'), 'xls');
  rejects(() => detectKind(utf8('a;b'), 'estratto.xlsx'), 'type-mismatch');
  rejects(() => detectKind(workbook, 'estratto.csv'), 'type-mismatch');
  rejects(() => detectKind(utf8('%PDF'), 'estratto.pdf'), 'unsupported-type');
  rejects(() => detectKind(utf8('a;b'), 'estratto'), 'unsupported-type');
});

test('a newest-first statement comes back in chronological order', () => {
  const csv = [
    'Data;Descrizione;Importo;Saldo',
    '03/01/2026;Forno Immaginario;-3,00;94,00',
    '02/01/2026;Bar Fittizio;-1,00;97,00',
    '02/01/2026;Edicola Finta;-2,00;98,00',
    '01/01/2026;Bonifico Finto;100,00;100,00',
  ].join('\n');
  const preview = previewImport(utf8(csv), 'recenti.csv', { account: 'conto-1' });
  assert.equal(preview.newestFirst, true);
  assert.deepEqual(
    preview.rows.map((row) => [row.line, row.transaction.description]),
    [
      [5, 'Bonifico Finto'],
      [4, 'Edicola Finta'],
      [3, 'Bar Fittizio'],
      [2, 'Forno Immaginario'],
    ],
  );
  // The same movements oldest-first give the same fingerprints.
  const oldestFirst = [
    'Data;Descrizione;Importo;Saldo',
    '01/01/2026;Bonifico Finto;100,00;100,00',
    '02/01/2026;Edicola Finta;-2,00;98,00',
    '02/01/2026;Bar Fittizio;-1,00;97,00',
    '03/01/2026;Forno Immaginario;-3,00;94,00',
  ].join('\n');
  const ascending = previewImport(utf8(oldestFirst), 'vecchi.csv', { account: 'conto-1' });
  assert.equal(ascending.newestFirst, false);
  assert.deepEqual(
    ascending.rows.map((row) => row.transaction.fingerprint),
    preview.rows.map((row) => row.transaction.fingerprint),
  );
});

test('a single-day statement is ordered by its balance', () => {
  const newest = ['Data;Descrizione;Importo;Saldo', '02/01/2026;Terzo Finto;-3,00;94,00', '02/01/2026;Secondo Finto;-2,00;97,00', '02/01/2026;Primo Finto;-1,00;99,00'].join('\n');
  const preview = previewImport(utf8(newest), 'giorno.csv', { account: 'conto-1' });
  assert.equal(preview.newestFirst, true);
  assert.deepEqual(
    preview.rows.map((row) => row.transaction.description),
    ['Primo Finto', 'Secondo Finto', 'Terzo Finto'],
  );
  const oldest = ['Data;Descrizione;Importo;Saldo', '02/01/2026;Primo Finto;-1,00;99,00', '02/01/2026;Secondo Finto;-2,00;97,00', '02/01/2026;Terzo Finto;-3,00;94,00'].join('\n');
  assert.equal(previewImport(utf8(oldest), 'giorno.csv', { account: 'conto-1' }).newestFirst, false);
});

test('rows out of order inside an ascending file are sorted by day, stable within the day', () => {
  const csv = ['Data;Descrizione;Importo', '01/01/2026;A Finto;-1,00', '03/01/2026;C Finto;-1,00', '02/01/2026;B1 Finto;-1,00', '02/01/2026;B2 Finto;-1,00', '04/01/2026;D Finto;-1,00'].join('\n');
  assert.deepEqual(
    previewImport(utf8(csv), 'x.csv', { account: 'conto-1' }).rows.map((row) => row.transaction.description),
    ['A Finto', 'B1 Finto', 'B2 Finto', 'C Finto', 'D Finto'],
  );
});

test('rejection messages carry line numbers, never the content', () => {
  const preview = previewImport(utf8(STATEMENT), 'gennaio.csv', { account: 'conto-1' });
  assert.ok(!JSON.stringify(preview.rejected).includes('Errore'));
});

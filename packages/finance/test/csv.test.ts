import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeText, FinanceImportError, readCsv } from '../src/index.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const cells = (bytes: Uint8Array): string[][] => readCsv(bytes).rows.map((row) => row.cells.map(String));

function rejects(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof FinanceImportError && error.code === code);
}

test('semicolon separator with Italian decimals is recognized over the comma', () => {
  const table = readCsv(utf8('Data;Descrizione;Importo\n02/01/2026;Bar Fittizio;-1,50\n03/01/2026;Forno Immaginario;-12,30\n'));
  assert.equal(table.separator, ';');
  assert.deepEqual(table.rows[1]?.cells, ['02/01/2026', 'Bar Fittizio', '-1,50']);
});

test('comma and tab separators are recognized', () => {
  assert.equal(readCsv(utf8('Date,Description,Amount\n2026-01-02,Fake Shop,-1.50\n2026-01-03,Pretend Cafe,-2.00\n')).separator, ',');
  assert.equal(readCsv(utf8('Data\tDescrizione\tImporto\n02/01/2026\tNegozio Finto\t-1,50\n')).separator, '\t');
});

test('a given separator skips the guess', () => {
  assert.equal(readCsv(utf8('a,b;c\n'), { separator: ',' }).rows[0]?.cells.length, 2);
});

test('quoted cells keep separators, doubled quotes and line breaks', () => {
  const rows = cells(utf8('Data;Descrizione;Importo\r\n02/01/2026;"Pizzeria ""Da Finto""; Roma";"-1.234,50"\r\n03/01/2026;"riga\r\ndue";-1,00\r\n'));
  assert.deepEqual(rows[1], ['02/01/2026', 'Pizzeria "Da Finto"; Roma', '-1.234,50']);
  assert.deepEqual(rows[2], ['03/01/2026', 'riga\r\ndue', '-1,00']);
});

test('line numbers count physical lines, also after a multi-line cell and blank lines', () => {
  const table = readCsv(utf8('A;B\n"x\ny";1\n\n\nC;2\n'));
  assert.deepEqual(
    table.rows.map((row) => row.line),
    [1, 2, 6],
  );
});

test('CR-only and LF line ends', () => {
  assert.equal(readCsv(utf8('A;B\r1;2\r3;4')).rows.length, 3);
  assert.equal(readCsv(utf8('A;B\n1;2\n3;4')).rows.length, 3);
});

test('a UTF-8 BOM is dropped', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Data;Importo\n01/01/2026;1,00\n')]);
  const table = readCsv(bytes);
  assert.equal(table.encoding, 'utf-8');
  assert.equal(table.rows[0]?.cells[0], 'Data');
});

test('invalid UTF-8 is read as Windows-1252 (accents and euro sign)', () => {
  // "Caffè €" in Windows-1252: è = 0xE8, € = 0x80.
  const bytes = new Uint8Array([...utf8('Descrizione;Importo\nCaff'), 0xe8, 0x20, 0x80, ...utf8(';-1,00\n')]);
  const decoded = decodeText(bytes);
  assert.equal(decoded.encoding, 'windows-1252');
  assert.equal(readCsv(bytes).rows[1]?.cells[0], 'Caffè €');
});

test('valid UTF-8 accents stay UTF-8', () => {
  const decoded = decodeText(utf8('Caffè €'));
  assert.equal(decoded.encoding, 'utf-8');
  assert.equal(decoded.text, 'Caffè €');
});

test('UTF-16 is refused', () => {
  rejects(() => readCsv(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), 'unsupported-encoding');
});

test('empty files and files of blank lines are refused', () => {
  rejects(() => readCsv(new Uint8Array()), 'empty');
  rejects(() => readCsv(utf8('\n ; \n\n')), 'empty');
});

test('an unterminated quote is an error with the line, not the content', () => {
  assert.throws(
    () => readCsv(utf8('A;B\n1;"segreto\n')),
    (error: unknown) => error instanceof FinanceImportError && error.code === 'unterminated-quote' && error.line === 2 && !error.message.includes('segreto'),
  );
});

test('size, row, column and cell limits', () => {
  rejects(() => readCsv(utf8('A;B\n1;2\n'), { limits: { maxFileBytes: 4 } }), 'too-large');
  rejects(() => readCsv(utf8('A;B\n1;2\n3;4\n'), { limits: { maxRows: 2 } }), 'too-many-rows');
  assert.equal(readCsv(utf8('A;B\n1;2\n'), { limits: { maxRows: 2 } }).rows.length, 2);
  rejects(() => readCsv(utf8('A;B;C\n'), { limits: { maxColumns: 2 } }), 'too-many-columns');
  rejects(() => readCsv(utf8(`A;${'x'.repeat(50)}\n`), { limits: { maxCellChars: 10 } }), 'cell-too-long');
});

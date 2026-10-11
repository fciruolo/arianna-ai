import assert from 'node:assert/strict';
import { test } from 'node:test';

import { excelSerialToDay, FinanceImportError, isDateFormatCode, readXlsx } from '../src/index.ts';
import { crc32 } from '../src/zip.ts';
import { xlsx, xlsxParts, zip } from './support/xlsx-writer.ts';

function rejects(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof FinanceImportError && error.code === code);
}

const statement = {
  sheets: [
    {
      name: 'Movimenti',
      rows: [
        ['Estratto conto finto', null, null],
        [],
        ['Data', 'Descrizione', 'Importo'],
        [{ serial: 46024 }, 'Bar Fittizio & Co <centro>', -1.5],
        [{ serial: 46025 }, 'Stipendio Ditta Inventata', 1234.56],
      ],
    },
    { name: 'Altro', rows: [['Solo', 'testo']] },
  ],
};

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('reads shared strings, numbers and date-styled serials', () => {
  const table = readXlsx(xlsx(statement));
  assert.equal(table.sheet, 'Movimenti');
  assert.deepEqual(table.sheets, ['Movimenti', 'Altro']);
  assert.deepEqual(
    table.rows.map((row) => row.line),
    [1, 3, 4, 5],
  );
  assert.deepEqual(table.rows[2]?.cells, [{ day: '2026-01-02' }, 'Bar Fittizio & Co <centro>', -1.5]);
  assert.deepEqual(table.rows[3]?.cells, [{ day: '2026-01-03' }, 'Stipendio Ditta Inventata', 1234.56]);
});

test('reads inline strings and a custom date format', () => {
  const table = readXlsx(xlsx({ ...statement, inline: true, customDateFormat: true }));
  assert.deepEqual(table.rows[2]?.cells, [{ day: '2026-01-02' }, 'Bar Fittizio & Co <centro>', -1.5]);
});

test('a sheet is chosen by name or position; a missing one is refused', () => {
  assert.equal(readXlsx(xlsx(statement), { sheet: 'Altro' }).rows[0]?.cells[0], 'Solo');
  assert.equal(readXlsx(xlsx(statement), { sheet: 1 }).sheet, 'Altro');
  rejects(() => readXlsx(xlsx(statement), { sheet: 'Nessuno' }), 'no-sheet');
});

test('the 1904 date system is honoured', () => {
  const table = readXlsx(xlsx({ sheets: [{ name: 'S', rows: [[{ serial: 0 }, { serial: 44562 }]] }], date1904: true }));
  assert.deepEqual(table.rows[0]?.cells, [{ day: '1904-01-01' }, { day: '2026-01-02' }]);
});

test('shared strings with several runs, entities and phonetic text', () => {
  const parts = xlsxParts({ sheets: [{ name: 'S', rows: [['x']] }] }).map((part) =>
    part.name === 'xl/sharedStrings.xml'
      ? { ...part, data: '<sst><si><r><t>Super</t></r><r><rPr><b/></rPr><t xml:space="preserve">mercato &quot;Finto&quot; &#8364;&#x21;</t></r><rPh><t>ignored</t></rPh></si></sst>' }
      : part,
  );
  assert.equal(readXlsx(zip(parts)).rows[0]?.cells[0], 'Supermercato "Finto" €!');
});

test('stored entries (method 0) are read too', () => {
  const parts = xlsxParts(statement).map((part) => ({ ...part, method: 0 as const }));
  assert.equal(readXlsx(zip(parts)).rows.length, 4);
});

test('Excel serial days, including the 1900 leap-year bug', () => {
  assert.equal(excelSerialToDay(1), '1900-01-01');
  assert.equal(excelSerialToDay(59), '1900-02-28');
  assert.equal(excelSerialToDay(60), null);
  assert.equal(excelSerialToDay(61), '1900-03-01');
  assert.equal(excelSerialToDay(46024.75), '2026-01-02');
  assert.equal(excelSerialToDay(0), null);
  assert.equal(excelSerialToDay(0, true), '1904-01-01');
  assert.equal(excelSerialToDay(Number.NaN), null);
});

test('date format codes', () => {
  assert.equal(isDateFormatCode('dd/mm/yyyy'), true);
  assert.equal(isDateFormatCode('[$-410]d mmmm yyyy'), true);
  assert.equal(isDateFormatCode('#,##0.00 "EUR"'), false);
  assert.equal(isDateFormatCode('"day" 0'), false);
  assert.equal(isDateFormatCode('General'), false);
});

test('a binary .xls is refused with the invitation to save it as .xlsx or CSV', () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  assert.throws(
    () => readXlsx(ole),
    (error: unknown) => error instanceof FinanceImportError && error.code === 'xls' && /\.xlsx or CSV/.test(error.message),
  );
});

test('a zip bomb is stopped by the decompressed size cap', () => {
  const bomb = '<sst>' + '<si><t>a</t></si>'.repeat(200_000) + '</sst>';
  const parts = xlsxParts(statement).map((part) => (part.name === 'xl/sharedStrings.xml' ? { ...part, data: bomb } : part));
  const bytes = zip(parts);
  assert.ok(bytes.length < 100_000);
  rejects(() => readXlsx(bytes, { limits: { maxUnzippedBytes: 1_000_000 } }), 'unzipped-too-large');
  // The header claims a tiny size: inflating stops at the cap all the same.
  const lying = xlsxParts(statement).map((part) => (part.name === 'xl/sharedStrings.xml' ? { ...part, data: bomb, declaredSize: 100 } : part));
  rejects(() => readXlsx(zip(lying), { limits: { maxUnzippedBytes: 1_000_000 } }), 'unzipped-too-large');
});

test('a part that lies about its size is refused, even when small', () => {
  const lying = xlsxParts(statement).map((part) => (part.name === 'xl/workbook.xml' ? { ...part, declaredSize: 10 } : part));
  rejects(() => readXlsx(zip(lying), { limits: { maxUnzippedBytes: 1_000_000 } }), 'bad-zip');
});

test('encrypted entries, odd paths and duplicates are refused', () => {
  const encrypted = xlsxParts(statement).map((part) => ({ ...part, flags: 0x1 }));
  rejects(() => readXlsx(zip(encrypted)), 'encrypted');
  rejects(() => readXlsx(zip([...xlsxParts(statement), { name: '../evil.xml', data: 'x' }])), 'bad-path');
  rejects(() => readXlsx(zip([...xlsxParts(statement), { name: '/abs.xml', data: 'x' }])), 'bad-path');
  rejects(() => readXlsx(zip([...xlsxParts(statement), { name: 'xl/workbook.xml', data: '<workbook/>' }])), 'bad-zip');
});

test('a DOCTYPE (entity expansion) is refused', () => {
  const parts = xlsxParts(statement).map((part) =>
    part.name === 'xl/sharedStrings.xml' ? { ...part, data: '<!DOCTYPE x [<!ENTITY a "aaaa">]><sst><si><t>&a;</t></si></sst>' } : part,
  );
  rejects(() => readXlsx(zip(parts)), 'bad-xml');
});

test('row and column limits', () => {
  rejects(() => readXlsx(xlsx(statement), { limits: { maxRows: 3 } }), 'too-many-rows');
  rejects(() => readXlsx(xlsx(statement), { limits: { maxColumns: 2 } }), 'too-many-columns');
});

test('not a zip, a truncated zip, a workbook without sheets', () => {
  rejects(() => readXlsx(new TextEncoder().encode('Data;Importo\n')), 'type-mismatch');
  const whole = xlsx(statement);
  rejects(() => readXlsx(whole.subarray(0, whole.length - 30)), 'bad-zip');
  rejects(() => readXlsx(zip([{ name: 'xl/workbook.xml', data: '<workbook><sheets/></workbook>' }])), 'no-sheet');
  rejects(() => readXlsx(zip([{ name: 'other.xml', data: '<x/>' }])), 'bad-xlsx');
});

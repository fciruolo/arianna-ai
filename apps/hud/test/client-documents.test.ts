// The documents of a client in the chat (I-16 tappa C2, D-171): chips,
// filters, due dates in words, the checks before sending. Invented data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { documentFileProblem, expiryText, filterDocuments, kindChips, sizeText, typeText, type ClientDocument } from '../src/lib/client-documents.ts';

function doc(id: string, kind: ClientDocument['kind'], name: string, extra: Partial<ClientDocument> = {}): ClientDocument {
  return { id, kind, otherType: null, name, project: null, documentOn: null, expiresOn: null, extension: 'pdf', mediaType: 'application/pdf', sizeBytes: 1000, preview: true, createdAt: '2026-10-10 10:00:00+00', archivedAt: null, ...extra };
}

const DOCS = [
  doc('1', 'contract', 'Contratto quadro 2026', { project: 'progetto-test' }),
  doc('2', 'signed_quote', 'Preventivo P-2026-03', { project: 'demo' }),
  doc('3', 'other', 'Schizzo vetrina', { otherType: 'materiali', extension: 'png' }),
  doc('4', 'contract', 'Contratto manutenzione 2025', { archivedAt: '2026-01-01 10:00:00+00' }),
];

test('chips count the documents in use by kind; the list filters by kind, words and archived', () => {
  assert.deepEqual(
    kindChips(DOCS).map((chip) => [chip.id, chip.text, chip.count]),
    [
      ['all', 'Tutti', 3],
      ['contract', 'Contratti', 1],
      ['signed_quote', 'Preventivi firmati', 1],
      ['other', 'Altri', 1],
    ],
  );
  assert.deepEqual(
    filterDocuments(DOCS, 'contract', '', false).map((item) => item.id),
    ['1'],
  );
  assert.deepEqual(
    filterDocuments(DOCS, 'all', 'materiali', false).map((item) => item.id),
    ['3'],
  );
  assert.deepEqual(
    filterDocuments(DOCS, 'all', 'demo preventivo', false).map((item) => item.id),
    ['2'],
  );
  assert.deepEqual(
    filterDocuments(DOCS, 'all', '', true).map((item) => item.id),
    ['4'],
  );
  assert.equal(typeText(DOCS[2] as ClientDocument), 'materiali');
  assert.equal(typeText(DOCS[1] as ClientDocument), 'Preventivo firmato');
});

test('due dates in words, sizes, and the files that may go', () => {
  assert.deepEqual(expiryText('2026-11-05', '2026-10-10'), { text: 'scade il 05/11/2026', past: false, soon: true });
  assert.deepEqual(expiryText('2026-12-31', '2026-10-10'), { text: 'scade il 31/12/2026', past: false, soon: false });
  assert.deepEqual(expiryText('2025-12-31', '2026-10-10'), { text: 'scaduto il 31/12/2025', past: true, soon: false });
  assert.equal(expiryText(null, '2026-10-10'), null);
  assert.equal(sizeText(472), '472 B');
  assert.equal(sizeText(412 * 1024), '412 KB');
  assert.equal(sizeText(1.2 * 1024 * 1024), '1,2 MB');
  assert.equal(documentFileProblem({ name: 'Contratto.PDF', size: 1000 }), null);
  assert.match(documentFileProblem({ name: 'pagina.html', size: 10 }) ?? '', /tipo di file/);
  assert.match(documentFileProblem({ name: 'grande.pdf', size: 26 * 1024 * 1024 }) ?? '', /25 MB/);
});

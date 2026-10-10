// The documents of a client (I-16 tappa C2, D-171) against PostgreSQL and
// the disk: written private and recorded with their hash, changed, archived,
// read and opened only while the bytes and the folders are those recorded,
// the guard of the table, the line of the morning once, events with ids
// only. Every client and file here is invented.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { addDocument, archiveDocument, listDocuments, openDocument, readDocument, takeExpiryLines, updateDocument } from '../src/client-documents.ts';
import { archiveClient, ClientError, createClient, linkProject } from '../src/clients.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const NAMES = { projects: ['demo', 'progetto-test'] };
const DIR = join(resolveHome({}), 'data', 'test-tmp', `client-documents-${randomUUID()}`);
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const PDF = Buffer.from('%PDF-1.7\nContratto finto');

async function rejectsWith(promise: Promise<unknown>, code: ClientError['code']): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof ClientError && error.code === code);
}

test('a document written private, recorded, listed, changed and archived; events with ids only', async () => {
  const { sql } = db();
  const { id } = await createClient(sql, { displayName: 'Documenti Finti Srl' });
  await linkProject(sql, id, 'demo', NAMES);
  const contract = await addDocument(sql, DIR, id, { name: 'Contratto quadro 2026.pdf', kind: 'contract', project: 'demo', documentOn: '2026-01-12', expiresOn: '2091-12-31', data: PDF.toString('base64') });
  assert.deepEqual(
    [contract.kind, contract.otherType, contract.project, contract.extension, contract.mediaType, contract.sizeBytes, contract.preview],
    ['contract', null, 'demo', 'pdf', 'application/pdf', PDF.length, true],
  );
  const path = join(DIR, id, 'documenti', `${contract.id}.pdf`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(DIR, id, 'documenti')).mode & 0o777, 0o700);
  assert.deepEqual((await readDocument(sql, DIR, id, contract.id)).bytes, PDF);

  // Refused: a project of nobody's, an other without its type, a type for a legal one, bytes that are not the extension, a bad date.
  await rejectsWith(addDocument(sql, DIR, id, { name: 'a.pdf', kind: 'contract', project: 'progetto-test', data: PDF.toString('base64') }), 'invalid');
  await rejectsWith(addDocument(sql, DIR, id, { name: 'a.pdf', kind: 'other', data: PDF.toString('base64') }), 'invalid');
  await rejectsWith(addDocument(sql, DIR, id, { name: 'a.pdf', kind: 'nda', otherType: 'x', data: PDF.toString('base64') }), 'invalid');
  await rejectsWith(addDocument(sql, DIR, id, { name: 'a.png', kind: 'nda', data: PDF.toString('base64') }), 'invalid');
  await rejectsWith(addDocument(sql, DIR, id, { name: 'a.pdf', kind: 'nda', expiresOn: '2026-02-30', data: PDF.toString('base64') }), 'invalid');
  // Nothing written for the refused ones.
  assert.equal(readdirSync(join(DIR, id, 'documenti')).length, 1);

  // The name shown without extension: the format comes from the name of the file.
  await rejectsWith(addDocument(sql, DIR, id, { name: 'Brochure', kind: 'other', otherType: 'brochure', data: Buffer.from('testo finto').toString('base64') }), 'invalid');
  const brochure = await addDocument(sql, DIR, id, { name: 'Brochure', fileName: 'Brochure.txt', kind: 'other', otherType: 'brochure', data: Buffer.from('testo finto').toString('base64') });
  assert.deepEqual([brochure.otherType, brochure.preview, brochure.mediaType], ['brochure', false, 'text/plain']);
  // A legal kind drops the free type; an other needs one.
  assert.equal((await updateDocument(sql, id, brochure.id, { kind: 'order' })).otherType, null);
  await rejectsWith(updateDocument(sql, id, brochure.id, { kind: 'other' }), 'invalid');
  const renamed = await updateDocument(sql, id, brochure.id, { kind: 'other', otherType: 'materiali', name: 'Materiali', project: 'demo' });
  assert.deepEqual([renamed.name, renamed.otherType, renamed.project], ['Materiali', 'materiali', 'demo']);
  await rejectsWith(updateDocument(sql, id, brochure.id, {}), 'invalid');

  assert.deepEqual(
    (await listDocuments(sql, id)).map((document) => document.id),
    [brochure.id, contract.id],
  );
  const archived = await archiveDocument(sql, id, brochure.id, true);
  assert.notEqual(archived.archivedAt, null);
  await rejectsWith(updateDocument(sql, id, brochure.id, { name: 'x' }), 'conflict');
  assert.equal((await archiveDocument(sql, id, brochure.id, false)).archivedAt, null);

  // The file never changes, the label never goes down, a row never goes away.
  await assert.rejects(sql`UPDATE client_documents SET sha256 = ${'0'.repeat(64)} WHERE id = ${contract.id}`, /its file never changes/);
  await assert.rejects(sql`UPDATE client_documents SET label = 'L1' WHERE id = ${contract.id}`);
  await rejectsWith(readDocument(sql, DIR, randomUUID(), contract.id), 'not-found');

  // An archived client takes no document.
  await archiveClient(sql, id, true);
  await rejectsWith(addDocument(sql, DIR, id, { name: 'b.pdf', kind: 'nda', data: PDF.toString('base64') }), 'conflict');
  await archiveClient(sql, id, false);

  const events = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind LIKE 'client.document.%' AND payload->>'clientId' = ${id}`;
  assert.ok(events.length >= 5);
  for (const { payload } of events) assert.doesNotMatch(JSON.stringify(payload), /Contratto|Brochure|Materiali|brochure|demo|2091/);
});

test('a document is read and opened only while its file is the one recorded and no link is on the way', async () => {
  const { sql } = db();
  const { id } = await createClient(sql, { displayName: 'Apri Finto Srl' });
  const document = await addDocument(sql, DIR, id, { name: 'NDA.pdf', kind: 'nda', data: PDF.toString('base64') });
  const opened: [string, boolean][] = [];
  const opener = (path: string, reveal: boolean): Promise<void> => {
    opened.push([path, reveal]);
    return Promise.resolve();
  };
  const path = join(DIR, id, 'documenti', `${document.id}.pdf`);
  await openDocument(sql, DIR, id, document.id, true, opener);
  assert.deepEqual(opened, [[path, true]]);

  // Changed on disk: refused, nothing opened.
  writeFileSync(path, '%PDF-1.7\naltro');
  await rejectsWith(readDocument(sql, DIR, id, document.id), 'conflict');
  await rejectsWith(openDocument(sql, DIR, id, document.id, false, opener), 'conflict');
  // A link in place of the file: refused.
  unlinkSync(path);
  const elsewhere = join(DIR, 'altrove.pdf');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(elsewhere, PDF);
  symlinkSync(elsewhere, path);
  await rejectsWith(readDocument(sql, DIR, id, document.id), 'not-found');
  await rejectsWith(openDocument(sql, DIR, id, document.id, false, opener), 'not-found');
  assert.equal(opened.length, 1);
});

test('a due date within 30 days is named once, in the morning message, by client and type', async () => {
  const { sql } = db();
  // Far in the future, so that other tests' documents never fall in the window.
  const { id } = await createClient(sql, { displayName: 'Scadenze Finte Srl' });
  const soon = await addDocument(sql, DIR, id, { name: 'Contratto segreto.pdf', kind: 'contract', expiresOn: '2091-03-20', data: PDF.toString('base64') });
  await addDocument(sql, DIR, id, { name: 'Lontano.pdf', kind: 'order', expiresOn: '2091-06-30', data: PDF.toString('base64') });
  const gone = await addDocument(sql, DIR, id, { name: 'Archiviato.pdf', kind: 'nda', expiresOn: '2091-03-10', data: PDF.toString('base64') });
  await archiveDocument(sql, id, gone.id, true);

  assert.deepEqual(await takeExpiryLines(sql, '2091-02-01'), []);
  assert.deepEqual(await takeExpiryLines(sql, '2091-02-18'), ['Il contratto di Scadenze Finte Srl scade il 20 marzo 2091.']);
  // Once.
  assert.deepEqual(await takeExpiryLines(sql, '2091-02-19'), []);
  // A new due date is reminded again.
  await updateDocument(sql, id, soon.id, { expiresOn: '2091-03-25' });
  assert.deepEqual(await takeExpiryLines(sql, '2091-03-01'), ['Il contratto di Scadenze Finte Srl scade il 25 marzo 2091.']);
});

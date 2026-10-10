// The clients (I-16, D-168, tappa C1) in the database: the registry checked
// and written, changes merged, archive and restore, contacts with one
// primary, projects of one client at most, the logo on the disk checked by
// its hash, the guards of the tables and events with ids only. Every client
// here is invented; the codes are generated to pass their check.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';

import {
  addContact,
  archiveClient,
  ClientError,
  clientOfProject,
  createClient,
  linkProject,
  listClients,
  readClient,
  readLogo,
  removeContact,
  removeLogo,
  setLogo,
  unlinkProject,
  updateClient,
  updateContact,
} from '../src/clients.ts';
import { startLiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { canaryPlaces, newCanary } from './support/canary.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const NAMES = { projects: ['demo', 'progetto-test', 'sito-rossi'] };
const DIR = join(resolveHome({}), 'data', 'test-tmp', `clients-${randomUUID()}`);
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

// Invented, generated with the check digit.
const PIVA = '12345678903';
const PIVA_2 = '98765432103';
const PIVA_3 = '05500000012';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('finto png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('finto jpeg')]);

async function rejectsWith(promise: Promise<unknown>, code: ClientError['code']): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ClientError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('it did not refuse');
}

test('a client written, read, changed in part and listed; events with ids only', async () => {
  const { sql } = db();
  const canary = newCanary();
  const { id } = await createClient(sql, {
    legalName: 'Rossi Srl',
    vatNumber: PIVA,
    sdiCode: 'abc1234',
    notes: `Cliente finto ${canary}`,
    registeredAddress: { street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'MI' },
    paymentMethod: 'bank_transfer',
    paymentDays: 30,
    paymentEndOfMonth: true,
    tags: ['web'],
  });
  const read = await readClient(sql, id, NAMES);
  assert.equal(read.displayName, 'Rossi Srl');
  assert.equal(read.status, 'active');
  assert.equal(read.area, 'IT');
  assert.equal(read.sdiEffective, 'ABC1234');
  assert.equal(read.label, 'L2');
  assert.deepEqual(read.registeredAddress, { street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
  assert.deepEqual(read.tags, ['web']);
  assert.equal(read.paymentDays, 30);

  const changed = await updateClient(sql, id, { vatRate: 22, phone: '+39 02 1234567' });
  assert.deepEqual(changed.changed, ['vatRate', 'phone']);
  const after = await readClient(sql, id);
  assert.equal(after.vatRate, 22);
  assert.equal(after.legalName, 'Rossi Srl');
  assert.deepEqual((await updateClient(sql, id, { vatRate: 22 })).changed, []);

  // Refused as a whole: a French client with an Italian partita IVA and SDI code, an unknown field.
  const refused = await rejectsWith(updateClient(sql, id, { country: 'FR' }), 'invalid');
  assert.deepEqual(refused.issues, [
    { field: 'vatNumber', code: 'not-allowed' },
    { field: 'sdiCode', code: 'not-allowed' },
  ]);
  await rejectsWith(updateClient(sql, id, { colore: 'blu' }), 'invalid');
  await rejectsWith(readClient(sql, randomUUID()), 'not-found');

  const listed = await listClients(sql);
  const summary = listed.find((client) => client.id === id);
  assert.equal(summary?.displayName, 'Rossi Srl');
  assert.equal(summary.area, 'IT');

  // The events: kinds and ids, never the data; the data only in clients.
  const events = await sql<{ kind: string; label: string; payload: Record<string, unknown> }[]>`
    SELECT kind, label, payload FROM events WHERE payload ->> 'clientId' = ${id} ORDER BY id`;
  assert.deepEqual(events.map((event) => event.kind), ['client.created', 'client.updated']);
  assert.ok(events.every((event) => event.label === 'L2'));
  assert.deepEqual(events[1]?.payload, { clientId: id, fields: ['vatRate', 'phone'] });
  assert.deepEqual(await canaryPlaces(db().owner, db().schema, canary), ['clients.notes']);
});

test('archive and restore; an archived client is not changed; one partita IVA among the clients not archived', async () => {
  const { sql } = db();
  const first = await createClient(sql, { displayName: 'Bianchi Spa', vatNumber: PIVA_2 });
  const twin = await rejectsWith(createClient(sql, { displayName: 'Bianchi doppio', vatNumber: PIVA_2 }), 'conflict');
  assert.deepEqual(twin.issues, [{ field: 'vatNumber', code: 'not-allowed' }]);

  assert.equal((await archiveClient(sql, first.id, true)).status, 'archived');
  assert.ok((await readClient(sql, first.id)).archivedAt !== null);
  await rejectsWith(updateClient(sql, first.id, { phone: '02 1234567' }), 'conflict');
  await rejectsWith(addContact(sql, first.id, { name: 'Anna' }), 'conflict');
  // Archived, its partita IVA is free; restored, the two would clash.
  const second = await createClient(sql, { displayName: 'Bianchi nuova', vatNumber: PIVA_2 });
  await rejectsWith(archiveClient(sql, first.id, false), 'conflict');
  await archiveClient(sql, second.id, true);
  assert.equal((await archiveClient(sql, first.id, false)).status, 'active');
  assert.equal((await readClient(sql, first.id)).archivedAt, null);
  // "status: archived" is not a field.
  await rejectsWith(updateClient(sql, first.id, { status: 'archived' }), 'invalid');
  assert.deepEqual((await updateClient(sql, first.id, { status: 'prospect' })).changed, ['status']);
});

test('contacts: one primary, changed in part, removed and never changed again', async () => {
  const { sql } = db();
  const { id } = await createClient(sql, { displayName: 'Verdi Snc' });
  const anna = await addContact(sql, id, { name: 'Anna Verdi', role: 'Amministrazione', email: 'Anna@verdi.example', primary: true });
  assert.equal(anna.email, 'anna@verdi.example');
  const luca = await addContact(sql, id, { name: 'Luca Neri', primary: true });
  let read = await readClient(sql, id);
  assert.deepEqual(read.contacts.map((contact) => [contact.name, contact.primary]), [['Luca Neri', true], ['Anna Verdi', false]]);

  const changed = await updateContact(sql, id, anna.id, { phone: '02 7654321', primary: true });
  assert.equal(changed.role, 'Amministrazione');
  assert.equal(changed.primary, true);
  read = await readClient(sql, id);
  assert.deepEqual(read.contacts.map((contact) => [contact.name, contact.primary]), [['Anna Verdi', true], ['Luca Neri', false]]);
  assert.equal((await listClients(sql)).find((client) => client.id === id)?.primaryContact?.name, 'Anna Verdi');

  await rejectsWith(updateContact(sql, id, anna.id, { email: 'anna' }), 'invalid');
  await removeContact(sql, id, luca.id);
  await rejectsWith(removeContact(sql, id, luca.id), 'not-found');
  await rejectsWith(updateContact(sql, id, luca.id, { name: 'Luca' }), 'not-found');
  assert.deepEqual((await readClient(sql, id)).contacts.map((contact) => contact.name), ['Anna Verdi']);
  await assert.rejects(db().owner`UPDATE client_contacts SET name = 'altro' WHERE id = ${luca.id}`, /removed, it never changes/);
  // Two primaries at once, below the core: refused by the index.
  await assert.rejects(sql`INSERT INTO client_contacts (client_id, name, is_primary) VALUES (${id}, 'Terzo', true)`, /client_contacts_one_primary/);
});

test('projects: only approved ones, one client each; unlinked, free again', async () => {
  const { sql } = db();
  const rossi = await createClient(sql, { displayName: 'Rossi progetti' });
  const neri = await createClient(sql, { displayName: 'Neri progetti' });
  await rejectsWith(linkProject(sql, rossi.id, 'non-approvato', NAMES), 'invalid');
  const link = await linkProject(sql, rossi.id, 'sito-rossi', NAMES);
  await linkProject(sql, rossi.id, 'demo', NAMES);
  await rejectsWith(linkProject(sql, neri.id, 'sito-rossi', NAMES), 'conflict');
  await rejectsWith(linkProject(sql, rossi.id, 'sito-rossi', NAMES), 'conflict');
  assert.deepEqual((await readClient(sql, rossi.id, { projects: ['sito-rossi'] })).projects.map((item) => [item.project, item.approved]), [['demo', false], ['sito-rossi', true]]);
  assert.deepEqual((await clientOfProject(sql, 'sito-rossi'))?.displayName, 'Rossi progetti');
  assert.deepEqual((await listClients(sql)).find((client) => client.id === rossi.id)?.projects, ['demo', 'sito-rossi']);

  await unlinkProject(sql, rossi.id, link.id);
  await rejectsWith(unlinkProject(sql, rossi.id, link.id), 'not-found');
  assert.equal(await clientOfProject(sql, 'sito-rossi'), null);
  await linkProject(sql, neri.id, 'sito-rossi', NAMES);
  assert.equal((await clientOfProject(sql, 'sito-rossi'))?.id, neri.id);
  await assert.rejects(db().owner`UPDATE client_projects SET project = 'altro' WHERE id = ${link.id}`, /only its removal/);
});

test('the logo: PNG, JPEG or WebP by its bytes, 0600, replaced, checked by its hash, never through a link', async () => {
  const { sql } = db();
  const { id } = await createClient(sql, { displayName: 'Logo Srl', vatNumber: PIVA_3 });
  const png = await setLogo(sql, DIR, id, { type: 'image/png', data: PNG.toString('base64') });
  assert.equal(png.type, 'image/png');
  const pngPath = join(DIR, id, 'logo.png');
  assert.equal(statSync(pngPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(DIR, id)).mode & 0o777, 0o700);
  assert.deepEqual((await readLogo(sql, DIR, id)).bytes, PNG);
  assert.deepEqual((await readClient(sql, id)).logo, png);

  await rejectsWith(setLogo(sql, DIR, id, { type: 'image/png', data: JPEG.toString('base64') }), 'invalid');
  await rejectsWith(setLogo(sql, DIR, id, { data: Buffer.from('<svg/>').toString('base64') }), 'invalid');

  const jpeg = await setLogo(sql, DIR, id, { data: JPEG.toString('base64') });
  assert.equal(jpeg.type, 'image/jpeg');
  assert.equal(existsSync(pngPath), false);
  assert.deepEqual((await readLogo(sql, DIR, id)).bytes, JPEG);

  // Changed on the disk: refused. A link in place of the file: not served.
  const jpegPath = join(DIR, id, 'logo.jpg');
  writeFileSync(jpegPath, Buffer.concat([JPEG, Buffer.from('x')]));
  await rejectsWith(readLogo(sql, DIR, id), 'conflict');
  unlinkSync(jpegPath);
  const elsewhere = join(DIR, 'altrove.jpg');
  writeFileSync(elsewhere, JPEG);
  symlinkSync(elsewhere, jpegPath);
  await rejectsWith(readLogo(sql, DIR, id), 'not-found');
  // A new logo replaces the link itself, never writing through it.
  await setLogo(sql, DIR, id, { data: JPEG.toString('base64') });
  assert.equal(statSync(jpegPath).isFile(), true);
  assert.deepEqual((await readLogo(sql, DIR, id)).bytes, JPEG);

  await removeLogo(sql, DIR, id);
  assert.equal(existsSync(jpegPath), false);
  assert.equal((await readClient(sql, id)).logo, null);
  await rejectsWith(readLogo(sql, DIR, id), 'not-found');
});

test('the tables: L2 at least, the label never down, never deleted by the core', async () => {
  const { sql, owner } = db();
  const { id } = await createClient(sql, { displayName: 'Guardia Srl' });
  await assert.rejects(sql`UPDATE clients SET label = 'L1' WHERE id = ${id}`, /violates check constraint|label cannot go down/);
  await sql`UPDATE clients SET label = 'L3' WHERE id = ${id}`;
  await assert.rejects(sql`UPDATE clients SET label = 'L2' WHERE id = ${id}`, /label cannot go down/);
  await assert.rejects(sql`DELETE FROM clients WHERE id = ${id}`, /permission denied/);
  await assert.rejects(sql`DELETE FROM client_contacts`, /permission denied/);
  await assert.rejects(sql`DELETE FROM client_projects`, /permission denied/);
  await assert.rejects(sql`INSERT INTO clients (display_name, label) VALUES ('Sotto', 'L1')`, /violates check constraint/);
  await assert.rejects(sql`UPDATE clients SET status = 'archived' WHERE id = ${id}`, /clients_archived/);
  await assert.rejects(owner`UPDATE clients SET created_at = now() - interval '1 day' WHERE id = ${id}`, /never change/);
});

test('the routes: written, listed, read, the logo served as an image with nosniff; refused fields with their issues', async () => {
  const live = await startLiveFeed(db().sql);
  const containers = NAMES.projects.map((name) => ({ name }) as Project);
  const dir = join(DIR, 'routes');
  mkdirSync(dir, { recursive: true });
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projectContainers: () => containers, clients: { dir } });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (method: string, path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await send('POST', '/api/clients', { kind: 'public_administration', displayName: 'Comune di Finta', ipaCode: 'uf1234', splitPayment: true });
    assert.equal(created.status, 201);
    const { client } = (await created.json()) as { client: { id: string } };

    const refused = await send('POST', `/api/clients/${client.id}`, { sdiCode: 'ABC1234' });
    assert.equal(refused.status, 400);
    assert.deepEqual(((await refused.json()) as { issues: unknown }).issues, [{ field: 'sdiCode', code: 'not-allowed' }]);

    assert.equal((await send('POST', `/api/clients/${client.id}/projects`, { project: 'progetto-test' })).status, 201);
    assert.equal((await send('POST', `/api/clients/${client.id}/contacts`, { name: 'Ufficio ragioneria', primary: true })).status, 201);
    const listed = (await (await fetch(`${base}/api/clients`)).json()) as { clients: { id: string; projects: string[]; primaryContact: { name: string } | null }[]; projects: string[] };
    assert.deepEqual(listed.projects, NAMES.projects);
    const row = listed.clients.find((item) => item.id === client.id);
    assert.deepEqual(row?.projects, ['progetto-test']);
    assert.equal(row.primaryContact?.name, 'Ufficio ragioneria');
    const read = (await (await fetch(`${base}/api/clients/${client.id}`)).json()) as { client: { sdiEffective: string; contacts: unknown[] } };
    assert.equal(read.client.sdiEffective, 'UF1234');
    const ofProject = (await (await fetch(`${base}/api/clients/of-project/progetto-test`)).json()) as { client: { id: string } | null };
    assert.equal(ofProject.client?.id, client.id);

    assert.equal((await send('POST', `/api/clients/${client.id}/logo`, { type: 'image/png', data: PNG.toString('base64') })).status, 200);
    const logo = await fetch(`${base}/api/clients/${client.id}/logo`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
    assert.match(logo.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), PNG);
    assert.equal((await send('DELETE', `/api/clients/${client.id}/logo`)).status, 200);
    assert.equal((await fetch(`${base}/api/clients/${client.id}/logo`)).status, 404);

    assert.equal((await send('POST', `/api/clients/${client.id}/archive`, { archived: true })).status, 200);
    assert.equal((await send('POST', `/api/clients/${client.id}`, { phone: '06 1234567' })).status, 409);
    assert.equal((await fetch(`${base}/api/clients/${randomUUID()}`)).status, 404);
  } finally {
    await server.close();
    await live.close();
  }
});

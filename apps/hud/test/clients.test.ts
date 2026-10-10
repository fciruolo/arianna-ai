// The page "Clienti" (I-16, D-168): the address, the fields each kind and
// country shows, the form as it is saved, the messages in Italian, what is
// missing for an invoice, the list filtered, the projects still free, the
// logo chosen. Every client here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reactive } from 'vue';

import { ApiError } from '../src/lib/api.ts';
import {
  addressText,
  billingGaps,
  clientErrorText,
  clientFromPath,
  clientPathFor,
  clientProblems,
  contactProblems,
  EMPTY_CONTACT,
  EMPTY_FORM,
  filterClients,
  formForSave,
  formOf,
  freeProjects,
  initialsOf,
  isClientsPath,
  issueText,
  logoFileProblem,
  logoUrl,
  numberField,
  parseTags,
  paymentText,
  problemsFromError,
  shownFields,
  type Client,
  type ClientForm,
  type ClientSummary,
} from '../src/lib/clients.ts';
import { projectFromSearch, projectsPathFor } from '../src/lib/projects.ts';

const ID = '7d9f1c2e-1111-4a5b-8c9d-0123456789ab';
const PIVA = '12345678903';

function form(extra: Partial<ClientForm>): ClientForm {
  return { ...EMPTY_FORM, tags: [], ...extra };
}

function summary(extra: Partial<ClientSummary>): ClientSummary {
  return { id: ID, kind: 'company', status: 'active', displayName: 'Rossi', legalName: null, country: 'IT', area: 'IT', vatNumber: null, email: null, tags: [], logo: null, projects: [], primaryContact: null, updatedAt: '2026-10-10T10:00:00Z', ...extra };
}

test('the address of the page: the list or one client', () => {
  assert.equal(isClientsPath('/clienti'), true);
  assert.equal(isClientsPath('/clienti/'), true);
  assert.equal(isClientsPath(`/clienti/${ID}`), true);
  assert.equal(isClientsPath('/clienti/altro'), false);
  assert.equal(isClientsPath('/progetti'), false);
  assert.equal(clientFromPath(`/clienti/${ID.toUpperCase()}`), ID);
  assert.equal(clientFromPath('/clienti'), undefined);
  assert.equal(clientFromPath('/clienti/non-un-id'), undefined);
  assert.equal(clientPathFor(null), '/clienti');
  assert.equal(clientPathFor(ID), `/clienti/${ID}`);
  // A project opened from its client.
  assert.equal(projectsPathFor('sito-rossi'), '/progetti?progetto=sito-rossi');
  assert.equal(projectsPathFor(), '/progetti');
  assert.equal(projectFromSearch('?progetto=sito-rossi'), 'sito-rossi');
  assert.equal(projectFromSearch(''), undefined);
});

test('the fields follow kind and country', () => {
  const company = shownFields('company', 'IT');
  assert.equal(company.sdiCode, true);
  assert.equal(company.pec, true);
  assert.equal(company.ipaCode, false);
  assert.equal(company.splitPayment, true);
  assert.equal(company.person, false);
  const pa = shownFields('public_administration', 'IT');
  assert.equal(pa.sdiCode, false);
  assert.equal(pa.ipaCode, true);
  assert.equal(pa.cig, true);
  const french = shownFields('company', 'FR');
  assert.equal(french.sdiCode, false);
  assert.equal(french.pec, false);
  assert.equal(french.vatNumber, false);
  assert.equal(french.euVatNumber, true);
  assert.equal(french.foreignTaxId, false);
  const swiss = shownFields('freelancer', 'CH');
  assert.equal(swiss.foreignTaxId, true);
  assert.equal(swiss.euVatNumber, false);
  assert.equal(swiss.person, true);
  assert.equal(shownFields('individual', 'IT').splitPayment, false);
});

test('saved, the hidden fields go empty and the office is in the client’s country', () => {
  const italian = form({ legalName: 'Rossi Srl', vatNumber: PIVA, pec: 'rossi@pec.example.it', sdiCode: 'ABC1234', withholdingAgent: true, firstName: 'Mario', registeredAddress: { street: 'Rue Finte', number: '1', postalCode: '75001', city: 'Paris', province: null, country: 'IT' } });
  const french = formForSave({ ...italian, country: 'FR' });
  assert.equal(french.vatNumber, null);
  assert.equal(french.pec, null);
  assert.equal(french.sdiCode, null);
  assert.equal(french.withholdingAgent, false);
  assert.equal(french.firstName, null);
  assert.equal(french.legalName, 'Rossi Srl');
  assert.equal(french.registeredAddress?.country, 'FR');
  const empty = formForSave(form({ displayName: 'Rossi', billingAddress: { street: ' ', number: null, postalCode: '', city: null, province: null, country: 'IT' } }));
  assert.equal(empty.billingAddress, null);
  // The chosen form is not changed.
  assert.equal(italian.vatNumber, PIVA);
});

test('the messages under the fields, in Italian', () => {
  const problems = clientProblems(form({ displayName: 'Rossi', vatNumber: '12345678901', sdiCode: 'ABC', registeredAddress: { street: null, number: null, postalCode: '123', city: null, province: 'Milano', country: 'IT' } }));
  assert.match(problems.vatNumber ?? '', /carattere di controllo non torna.*partita IVA/);
  assert.match(problems.sdiCode ?? '', /7 caratteri/);
  assert.match(problems['registeredAddress.postalCode'] ?? '', /CAP/);
  assert.match(problems['registeredAddress.province'] ?? '', /sigla di 2 lettere/);
  assert.deepEqual(clientProblems(form({ legalName: 'Rossi Srl', vatNumber: PIVA })), {});
  assert.match(clientProblems(form({})).displayName ?? '', /Serve un nome/);
  assert.match(clientProblems(form({ displayName: 'Dupont', country: 'FR', sdiCode: 'ABC1234' })).sdiCode ?? '', /XXXXXXX/);
  assert.match(issueText({ field: 'iban', code: 'checksum' }), /IBAN non torna/);
  assert.match(issueText({ field: 'vatRate', code: 'format' }), /da 0 a 100/);
  assert.match(issueText({ field: 'cig', code: 'not-allowed' }), /non si scrive il CIG/);
  assert.equal(clientProblems(form({ displayName: 'Rossi', vatRate: Number.NaN })).vatRate !== undefined, true);
  for (const rate of [1.1, 19.6, 0.07]) assert.equal(clientProblems(form({ displayName: 'Rossi', vatRate: rate })).vatRate, undefined, String(rate));
});

test('a contact: a name, e-mail and phones in their form', () => {
  assert.deepEqual(contactProblems({ ...EMPTY_CONTACT, name: 'Anna Verdi', email: 'anna@verdi.example', phone: '+39 02 1234567' }), {});
  const wrong = contactProblems({ ...EMPTY_CONTACT, name: ' ', email: 'anna', mobile: 'chiamami' });
  assert.deepEqual(Object.keys(wrong).sort(), ['email', 'mobile', 'name']);
});

test('what is missing to send an electronic invoice', () => {
  assert.deepEqual(billingGaps(form({ displayName: 'Rossi' })), ['partita IVA', 'codice SDI o PEC', 'ragione sociale', 'indirizzo della sede']);
  const ready = form({ legalName: 'Rossi Srl', vatNumber: PIVA, sdiCode: 'ABC1234', registeredAddress: { street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' } });
  assert.deepEqual(billingGaps(ready), []);
  assert.deepEqual(billingGaps({ ...ready, sdiCode: null, pec: 'rossi@pec.example.it' }), []);
  assert.deepEqual(billingGaps({ ...ready, vatRate: 0 }), ['natura IVA per l’aliquota 0']);
  assert.deepEqual(billingGaps({ ...ready, vatRate: 0, vatNature: 'N2.2' }), []);
  assert.deepEqual(billingGaps({ ...ready, vatRate: 22 }), []);
  assert.deepEqual(billingGaps(form({ kind: 'individual', firstName: 'Mario', lastName: 'Rossi' })), ['codice fiscale', 'indirizzo della sede']);
  assert.deepEqual(billingGaps(form({ kind: 'public_administration', legalName: 'Comune di Finta' })), ['codice IPA', 'codice fiscale', 'indirizzo della sede']);
  const french = form({ legalName: 'Dupont SARL', country: 'FR', registeredAddress: { street: 'Rue Finte', number: '1', postalCode: '75001', city: 'Paris', province: null, country: 'FR' } });
  assert.deepEqual(billingGaps(french), ['partita IVA UE']);
  assert.deepEqual(billingGaps({ ...french, country: 'US' }), []);
});

test('the list: archived out by default, search by name, partita IVA, contact, project, tag', () => {
  const list = [
    summary({ id: 'a', displayName: 'Rossi Srl', vatNumber: PIVA, projects: ['sito-rossi'] }),
    summary({ id: 'b', displayName: 'Bianchi', status: 'prospect', primaryContact: { name: 'Anna Verdi', email: null, phone: null }, tags: ['grafica'] }),
    summary({ id: 'c', displayName: 'Vecchio cliente', status: 'archived' }),
  ];
  assert.deepEqual(filterClients(list, 'current', '').map((item) => item.id), ['a', 'b']);
  assert.deepEqual(filterClients(list, 'archived', '').map((item) => item.id), ['c']);
  assert.deepEqual(filterClients(list, 'all', '').map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(filterClients(list, 'current', '12345').map((item) => item.id), ['a']);
  assert.deepEqual(filterClients(list, 'current', 'anna').map((item) => item.id), ['b']);
  assert.deepEqual(filterClients(list, 'current', 'SITO').map((item) => item.id), ['a']);
  assert.deepEqual(filterClients(list, 'current', 'grafica').map((item) => item.id), ['b']);
  assert.deepEqual(filterClients(list, 'prospect', 'rossi'), []);
});

test('the projects a client may still take', () => {
  const list = [summary({ id: 'a', projects: ['sito-rossi'] }), summary({ id: 'b', projects: ['demo'] })];
  assert.deepEqual(freeProjects(['demo', 'sito-rossi', 'progetto-test'], list, 'a'), ['progetto-test']);
  assert.deepEqual(freeProjects(['demo', 'sito-rossi'], [], 'nuovo'), ['demo', 'sito-rossi']);
});

test('words: payment, address, initials, tags, numbers', () => {
  assert.equal(paymentText('bank_transfer', 30, true), 'Bonifico · 30 gg fine mese');
  assert.equal(paymentText('riba', 60, false), 'RiBa · 60 gg data fattura');
  assert.equal(paymentText(null, 0, false), 'a vista');
  assert.equal(paymentText(null, null, false), null);
  assert.equal(addressText({ street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' }, 'IT'), 'Via Finta 1, 20100 Milano (MI)');
  assert.equal(addressText({ street: 'Rue Finte', number: '2', postalCode: '75001', city: 'Paris', province: null, country: 'FR' }, 'FR'), 'Rue Finte 2, 75001 Paris, Francia');
  assert.equal(addressText(null, 'IT'), null);
  assert.equal(initialsOf('Rossi Srl'), 'RO');
  assert.equal(initialsOf('Comune di Finta'), 'CD');
  assert.deepEqual(parseTags(' web, Grafica ,web,, '), ['web', 'Grafica']);
  assert.equal(numberField(''), null);
  assert.equal(numberField('22'), 22);
  assert.equal(numberField('22,5'), 22.5);
  assert.ok(Number.isNaN(numberField('ventidue')));
});

test('the logo: PNG, JPEG or WebP up to 1 MB; its address changes with its version', () => {
  assert.equal(logoFileProblem({ type: 'image/png', size: 1000 }), null);
  assert.match(logoFileProblem({ type: 'image/svg+xml', size: 1000 }) ?? '', /niente SVG/);
  assert.match(logoFileProblem({ type: 'image/png', size: 2 * 1024 * 1024 }) ?? '', /1 MB/);
  assert.match(logoFileProblem({ type: 'image/webp', size: 0 }) ?? '', /vuoto/);
  assert.equal(logoUrl(ID, { type: 'image/png', version: 'abc123' }), `/api/clients/${ID}/logo?v=abc123`);
  assert.equal(logoUrl(ID, null), null);
});

test('the answers of the core in Italian, with the problems of the fields', () => {
  const refused = new ApiError(400, 'invalid field(s): vatNumber (checksum)', { issues: [{ field: 'vatNumber', code: 'checksum' }, { field: 'registeredAddress.province', code: 'format' }] });
  const problems = problemsFromError(refused);
  assert.match(problems.vatNumber ?? '', /partita IVA/);
  assert.match(problems['registeredAddress.province'] ?? '', /sigla/);
  assert.deepEqual(problemsFromError(new Error('x')), {});
  assert.match(clientErrorText(refused), /campi non vanno/);
  assert.match(clientErrorText(new ApiError(409, 'the client is archived: restore it first')), /archiviato/);
  assert.match(clientErrorText(new ApiError(409, 'another client has this partita IVA')), /partita IVA/);
  assert.match(clientErrorText(new ApiError(409, 'the project belongs to another client')), /altro cliente/);
  assert.match(clientErrorText(new ApiError(404, 'no such client')), /non c’è più/);
});

test('the form of a client read from the core is a copy', () => {
  const client = { ...EMPTY_FORM, id: ID, status: 'archived', area: 'IT', sdiEffective: '0000000', logo: null, label: 'L2', contacts: [], projects: [], createdAt: '', updatedAt: '', archivedAt: '', displayName: 'Rossi', tags: ['web'], registeredAddress: { street: 'Via Finta', number: null, postalCode: null, city: null, province: null, country: 'IT' } } as Client;
  const copy = formOf(client);
  assert.equal(copy.status, 'active');
  copy.tags.push('altro');
  if (copy.registeredAddress !== null) copy.registeredAddress.street = 'Altra';
  assert.deepEqual(client.tags, ['web']);
  assert.equal(client.registeredAddress?.street, 'Via Finta');
  assert.deepEqual(formOf(null), { ...EMPTY_FORM, tags: [] });
});

test('the form of a client is made also from Vue reactive data (structuredClone refuses proxies)', () => {
  const client = reactive({ ...EMPTY_FORM, id: ID, status: 'active', area: 'IT', sdiEffective: '0000000', logo: null, label: 'L2', contacts: [], projects: [], createdAt: '', updatedAt: '', archivedAt: null, displayName: 'Rossi', tags: ['web'], registeredAddress: { street: 'Via Finta', number: null, postalCode: null, city: null, province: null, country: 'IT' } }) as unknown as Client;
  const copy = formOf(client);
  assert.deepEqual(copy.tags, ['web']);
  assert.equal(copy.registeredAddress?.street, 'Via Finta');
});

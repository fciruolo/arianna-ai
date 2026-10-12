// The clients as cards and the fields still missing for an electronic invoice
// (D-190). Every client here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardMoney, sortCards, type CardMoney } from '../src/lib/client-cards.ts';
import type { DashboardSummary } from '../src/lib/client-dashboard.ts';
import { billingGaps, EMPTY_FORM, gapFields, type ClientForm, type ClientSummary } from '../src/lib/clients.ts';

function form(extra: Partial<ClientForm>): ClientForm {
  return { ...EMPTY_FORM, tags: [], ...extra };
}

function summary(id: string, extra: Partial<ClientSummary> = {}): ClientSummary {
  return { id, kind: 'company', status: 'active', displayName: id, legalName: null, country: 'IT', area: 'IT', vatNumber: null, email: null, tags: [], logo: null, projects: [], primaryContact: null, updatedAt: '2026-10-10T10:00:00Z', ...extra };
}

function money(extra: Partial<CardMoney>): CardMoney {
  return { currency: 'EUR', earned: 0, closed: 0, toInvoice: 0, awaiting: 0, overdue: 0, ...extra };
}

test('cardMoney takes the three numbers of the year from the dashboard', () => {
  const dashboard = {
    earned: 99900,
    closed: 2,
    previous: 0,
    toInvoice: { cents: 0, ims: [] },
    awaiting: { cents: 54900, invoices: 1, overdue: 1, firstDue: '2026-10-09' },
    collected: { cents: 45000, lastPaid: '2026-10-10' },
    chart: [],
    projects: [],
    years: [],
    others: [],
    othersWaiting: [],
  } satisfies DashboardSummary;
  assert.deepEqual(cardMoney(dashboard, 'EUR'), { currency: 'EUR', earned: 99900, closed: 2, toInvoice: 0, awaiting: 54900, overdue: 1 });
});

test('sortCards: past due first, then what is still to cash; numbers not read go last', () => {
  const list = [summary('Bianchi'), summary('Rossi'), summary('Verdi'), summary('Gialli')];
  const read = new Map([
    ['Bianchi', money({ awaiting: 10000 })],
    ['Rossi', money({ awaiting: 5000, overdue: 1 })],
    ['Verdi', money({ toInvoice: 60000 })],
  ]);
  assert.deepEqual(sortCards(list, 'due', read).map((item) => item.id), ['Rossi', 'Verdi', 'Bianchi', 'Gialli']);
});

test('sortCards by name, by money earned and by the last change', () => {
  const list = [summary('rossi', { displayName: 'Rossi', updatedAt: '2026-10-01T00:00:00Z' }), summary('bianchi', { displayName: 'bianchi', updatedAt: '2026-10-11T00:00:00Z' }), summary('verdi', { displayName: 'Verdi' })];
  assert.deepEqual(sortCards(list, 'name', new Map()).map((item) => item.id), ['bianchi', 'rossi', 'verdi']);
  assert.deepEqual(sortCards(list, 'updated', new Map()).map((item) => item.id), ['bianchi', 'verdi', 'rossi']);
  const read = new Map([['rossi', money({ earned: 100 })], ['verdi', money({ earned: 240000 })]]);
  assert.deepEqual(sortCards(list, 'earned', read).map((item) => item.id), ['verdi', 'rossi', 'bianchi']);
});

test('gapFields marks the fields behind each gap of the electronic invoice', () => {
  assert.deepEqual(gapFields(form({ displayName: 'Rossi' })), ['legalName', 'vatNumber', 'sdiCode', 'pec', 'registeredAddress.street', 'registeredAddress.city', 'registeredAddress.postalCode', 'registeredAddress.province']);
  const ready = form({ legalName: 'Rossi Srl', vatNumber: '01234567897', sdiCode: 'ABC1234', registeredAddress: { street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' } });
  assert.deepEqual(gapFields(ready), []);
  assert.deepEqual(billingGaps(ready), []);
  assert.deepEqual(gapFields({ ...ready, sdiCode: null, pec: 'rossi@pec.example.it' }), []);
  assert.deepEqual(gapFields({ ...ready, vatRate: 0 }), ['vatNature']);
  assert.deepEqual(gapFields(form({ kind: 'individual', firstName: 'Mario', lastName: 'Rossi', registeredAddress: ready.registeredAddress })), ['taxCode']);
  assert.deepEqual(gapFields(form({ kind: 'freelancer', firstName: 'Mario', registeredAddress: ready.registeredAddress, vatNumber: '01234567897', pec: 'mario@pec.example.it' })), ['lastName']);
  const french = form({ legalName: 'Dupont SARL', country: 'FR', registeredAddress: { street: 'Rue Finte', number: '1', postalCode: null, city: 'Paris', province: null, country: 'FR' } });
  assert.deepEqual(gapFields(french), ['euVatNumber']);
});

test('gapFields and billingGaps agree on whether something is missing', () => {
  const office = { street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' };
  const abroad = { street: 'Main St', number: '1', postalCode: null, city: 'Boston', province: null, country: 'US' };
  const cases = [
    form({ displayName: 'Rossi' }),
    form({ kind: 'individual' }),
    form({ kind: 'public_administration', legalName: 'Comune di Finta' }),
    form({ kind: 'public_administration', legalName: 'Comune di Finta', ipaCode: 'ABC123', registeredAddress: office }),
    form({ kind: 'freelancer', firstName: 'Mario', vatNumber: '01234567897', pec: 'mario@pec.example.it', registeredAddress: office }),
    form({ kind: 'individual', country: 'DE', registeredAddress: { ...abroad, country: 'DE' } }),
    form({ kind: 'individual', country: 'US', registeredAddress: abroad }),
    form({ legalName: 'X', country: 'DE' }),
    form({ legalName: 'X', country: 'US', vatRate: 0, registeredAddress: abroad }),
    form({ legalName: 'X', country: 'US', registeredAddress: abroad }),
  ];
  for (const item of cases) assert.equal(gapFields(item).length === 0, billingGaps(item).length === 0, JSON.stringify(item.kind + item.country));
});

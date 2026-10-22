// The saved private values in memory (D-283): a load that fails forgets the
// old list (fail closed) instead of comparing with one that misses what just
// changed. Fake database and fake data only.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { Queryable } from '../src/db/client.ts';
import { knownPrivate, refreshSavedPrivate, resetSavedPrivate, useSavedValues } from '../src/saved-private.ts';

afterEach(() => {
  resetSavedPrivate();
});

const failing = (() => Promise.reject(new Error('database down'))) as unknown as Queryable;
const rows = (clients: unknown[]) => ((strings: TemplateStringsArray) => Promise.resolve(strings.join('?').includes('FROM clients WHERE') ? clients : [])) as unknown as Queryable;

test('a load that fails forgets the old values: nothing is compared until one succeeds', async () => {
  useSavedValues([{ ref: 'client:c1:name', value: 'Ferramenta Lunardi Srl' }]);
  assert.deepEqual(knownPrivate.find('Ferramenta Lunardi Srl'), ['client:c1:name']);
  await assert.rejects(refreshSavedPrivate(failing), /database down/);
  assert.throws(() => knownPrivate.find('Ferramenta Lunardi Srl'), /not loaded/);
  // The next load that succeeds brings them back.
  await refreshSavedPrivate(rows([{ id: 'c2', displayName: 'Officina Brenta', legalName: null, firstName: null, lastName: null, registered: null, billing: null, shipping: null, email: null, pec: null, billingEmail: null, phone: null, mobile: null, vatNumber: null, taxCode: null, iban: null }]));
  assert.deepEqual(knownPrivate.find('officina brenta'), ['client:c2:name']);
});

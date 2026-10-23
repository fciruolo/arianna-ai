// D-294: the filters of the cardwall on the phone, as a button, a row of chips and a sheet. Invented data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeFilters, chosenText, type FilterField, filtersButtonLabel, showCardsText, withFilter, withoutFilter } from '../src/lib/cardwall-filters.ts';
import { ALL_FILTERS, filtersActive } from '../src/lib/cardwall.ts';

const PROJECT: FilterField = {
  key: 'project',
  label: 'Progetto',
  icon: 'project',
  options: [
    { value: 'all', text: 'Tutti i progetti' },
    { value: 'p:negozio-finto', text: 'negozio-finto' },
  ],
};
const KIND: FilterField = {
  key: 'kind',
  label: 'Tipo',
  icon: 'card-body',
  options: [
    { value: 'all', text: 'Card e impegni' },
    { value: 'task', text: 'Card' },
  ],
};
const FIELDS: FilterField[] = [PROJECT, KIND, { key: 'priority', label: 'Priorità', icon: 'priority', options: [{ value: 'all', text: 'Ogni priorità' }] }];

test('no filter chosen: no chip, «Filtri» alone', () => {
  assert.deepEqual(activeFilters(FIELDS, ALL_FILTERS), []);
  assert.equal(filtersButtonLabel(0), 'Filtri');
});

test('the active filters as chips, in the order of the fields, with the text of the choice', () => {
  const filters = withFilter(withFilter(ALL_FILTERS, KIND, 'task'), PROJECT, 'p:negozio-finto');
  assert.deepEqual(activeFilters(FIELDS, filters), [
    { key: 'project', label: 'Progetto', value: 'p:negozio-finto', text: 'negozio-finto' },
    { key: 'kind', label: 'Tipo', value: 'task', text: 'Card' },
  ]);
  assert.equal(filtersButtonLabel(1), 'Filtri, 1 attivo');
  assert.equal(filtersButtonLabel(2), 'Filtri, 2 attivi');
});

test('a value no option has (a project gone) shows as it is', () => {
  assert.equal(chosenText(PROJECT, 'p:sparito'), 'sparito');
  assert.equal(chosenText(PROJECT, 'all'), 'Tutti i progetti');
});

test('the × of a chip puts that filter back to every one and leaves the others', () => {
  const filters = withFilter(withFilter(ALL_FILTERS, KIND, 'task'), PROJECT, 'p:negozio-finto');
  const less = withoutFilter(filters, 'project');
  assert.equal(less.project, 'all');
  assert.equal(less.kind, 'task');
  assert.equal(filtersActive(withoutFilter(less, 'kind')), false);
  // The originals are not touched.
  assert.equal(filters.project, 'p:negozio-finto');
  assert.equal(ALL_FILTERS.kind, 'all');
});

test('the button at the bottom of the sheet says how many cards are left', () => {
  assert.equal(showCardsText(12), 'Mostra 12 card');
  assert.equal(showCardsText(1), 'Mostra 1 card');
  assert.equal(showCardsText(0), 'Chiudi · nessuna card');
});

test('a value the field does not offer leaves the filters as they are', () => {
  assert.equal(withFilter(ALL_FILTERS, KIND, 'qualsiasi'), ALL_FILTERS);
  assert.equal(withFilter(ALL_FILTERS, PROJECT, 'p:sparito').project, 'all');
  assert.equal(filtersButtonLabel(-1), 'Filtri');
});

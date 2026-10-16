import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canSplit, paneId, paneOwnsKey, splitFits, splitFromSearch, splittable, SPLIT_MIN_PX, withSplit } from '../src/lib/split.ts';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('the conversation beside is read from the query, only as a uuid', () => {
  assert.equal(splitFromSearch(`?affianca=${B}`), B);
  assert.equal(splitFromSearch(`?affianca=${B.toUpperCase()}`), B);
  assert.equal(splitFromSearch(`?x=1&affianca=${B}`), B);
  assert.equal(splitFromSearch(''), undefined);
  assert.equal(splitFromSearch('?affianca='), undefined);
  assert.equal(splitFromSearch('?affianca=../etc'), undefined);
  assert.equal(splitFromSearch(`?altro=${B}`), undefined);
});

test('the address carries both conversations, or the path alone', () => {
  assert.equal(withSplit(`/c/${A}`, B), `/c/${A}?affianca=${B}`);
  assert.equal(withSplit(`/c/${A}`, null), `/c/${A}`);
  assert.equal(splitFromSearch(withSplit(`/c/${A}`, B).slice(`/c/${A}`.length)), B);
});

test('side by side only from the minimum width', () => {
  assert.equal(splitFits(SPLIT_MIN_PX), true);
  assert.equal(splitFits(1600), true);
  assert.equal(splitFits(SPLIT_MIN_PX - 1), false);
  assert.equal(splitFits(390), false);
});

test('incognito, secretary and side threads never stand beside another', () => {
  assert.equal(splittable({ id: A }), true);
  assert.equal(splittable({ id: A, incognito: false, secretary: false, sideOf: null }), true);
  assert.equal(splittable({ id: A, incognito: true }), false);
  assert.equal(splittable({ id: A, secretary: true }), false);
  assert.equal(splittable({ id: A, sideOf: B }), false);
  assert.equal(splittable(undefined), false);
});

test('«Affianca» needs another conversation open on the left', () => {
  assert.equal(canSplit({ id: A }, { id: B }), true);
  assert.equal(canSplit({ id: A }, { id: A }), false);
  assert.equal(canSplit(undefined, { id: B }), false);
  assert.equal(canSplit({ id: A, incognito: true }, { id: B }), false);
  assert.equal(canSplit({ id: A }, { id: B, secretary: true }), false);
});

test('a key outside the fields goes to the pane with the focus, else to the left one', () => {
  assert.equal(paneOwnsKey(undefined, null), true);
  assert.equal(paneOwnsKey(undefined, 'right'), true);
  assert.equal(paneOwnsKey('left', null), true);
  assert.equal(paneOwnsKey('right', null), false);
  assert.equal(paneOwnsKey('right', 'right'), true);
  assert.equal(paneOwnsKey('left', 'right'), false);
  assert.equal(paneOwnsKey('left', 'left'), true);
  // A narrow window showing the right one: the key is for it, never for the hidden one.
  assert.equal(paneOwnsKey('right', null, 'right'), true);
  assert.equal(paneOwnsKey('left', null, 'right'), false);
  assert.equal(paneOwnsKey('left', 'left', 'right'), true);
});

test('the ids of the right pane differ from those of the left one', () => {
  assert.equal(paneId(undefined, 'composer'), 'composer');
  assert.equal(paneId('left', 'composer'), 'composer');
  assert.equal(paneId('right', 'composer'), 'composer-right');
});

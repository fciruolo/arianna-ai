import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PANES_SIDE_BY_SIDE, panesStacked } from '../src/lib/project-panes.ts';

test('the panes are stacked on a phone', () => {
  assert.equal(panesStacked(390), true);
  assert.equal(panesStacked(PANES_SIDE_BY_SIDE - 1), true);
});

test('from md up the panes sit side by side', () => {
  assert.equal(panesStacked(PANES_SIDE_BY_SIDE), false);
  assert.equal(panesStacked(1440), false);
});

test('a width not measured never scrolls the page', () => {
  assert.equal(panesStacked(0), false);
  assert.equal(panesStacked(Number.NaN), false);
});

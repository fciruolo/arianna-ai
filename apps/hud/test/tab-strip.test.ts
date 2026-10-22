import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldedFilterCount, stripScrollFor } from '../src/lib/tab-strip.ts';

const view = { width: 360, scrollWidth: 600, scrollLeft: 0 };

test('a tab already whole in view leaves the row where it is', () => {
  assert.equal(stripScrollFor({ left: 100, width: 90 }, view), 0);
  assert.equal(stripScrollFor({ left: 300, width: 90 }, { ...view, scrollLeft: 100 }), 100);
});

test('a tab cut on the right comes to the middle', () => {
  // Centred it would be 340: past the end of the row, so its last 240.
  assert.equal(stripScrollFor({ left: 450, width: 140 }, view), 240);
  assert.equal(stripScrollFor({ left: 330, width: 80 }, view), 190);
});

test('a tab cut on the left comes back, never before the start', () => {
  assert.equal(stripScrollFor({ left: 20, width: 80 }, { ...view, scrollLeft: 200 }), 0);
  assert.equal(stripScrollFor({ left: 150, width: 60 }, { ...view, scrollLeft: 200 }), 0);
  assert.equal(stripScrollFor({ left: 200, width: 60 }, { ...view, scrollLeft: 240 }), 50);
});

test('the folded filters count what is set, category and "Senza categoria" as one', () => {
  const none = { account: '', from: '', to: '', category: '', uncategorized: false };
  assert.equal(foldedFilterCount(none), 0);
  assert.equal(foldedFilterCount({ ...none, account: 'a1', from: '2026-01-01' }), 2);
  assert.equal(foldedFilterCount({ ...none, category: 'k1', uncategorized: true }), 1);
  assert.equal(foldedFilterCount({ account: 'a', from: 'x', to: 'y', category: 'k', uncategorized: false }), 4);
});

test('a row that fits never scrolls', () => {
  assert.equal(stripScrollFor({ left: 500, width: 90 }, { width: 900, scrollWidth: 900, scrollLeft: 0 }), 0);
  assert.equal(stripScrollFor({ left: 500, width: 90 }, { width: 900, scrollWidth: 700, scrollLeft: 30 }), 0);
});

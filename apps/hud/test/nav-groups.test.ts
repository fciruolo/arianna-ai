import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_OPEN, NAV_GROUPS, groupOf, isOpen, parseOpen, toggle } from '../src/lib/nav-groups.ts';

test('every area belongs to exactly one group', () => {
  const areas = NAV_GROUPS.flatMap((group) => group.areas);
  assert.equal(new Set(areas).size, areas.length);
  assert.equal(areas.length, 11);
});

test('groupOf finds the group of an area and none for the chat', () => {
  assert.equal(groupOf('studio'), 'work');
  assert.equal(groupOf('finance'), 'personal');
  assert.equal(groupOf('settings'), 'system');
  assert.equal(groupOf(null), null);
});

test('a folded group opens while it holds the page in view', () => {
  assert.equal(isOpen('system', ['work'], 'settings'), true);
  assert.equal(isOpen('system', ['work'], 'studio'), false);
  assert.equal(isOpen('system', ['work'], null), false);
  assert.equal(isOpen('work', ['work'], null), true);
});

test('toggle folds and unfolds keeping the order of the groups', () => {
  assert.deepEqual(toggle(['work'], 'work'), []);
  assert.deepEqual(toggle(['system'], 'work'), ['work', 'system']);
  assert.deepEqual(toggle(['work', 'personal'], 'personal'), ['work']);
});

test('parseOpen accepts only known groups and falls back to the default', () => {
  assert.deepEqual(parseOpen(null), [...DEFAULT_OPEN]);
  assert.deepEqual(parseOpen('not json'), [...DEFAULT_OPEN]);
  assert.deepEqual(parseOpen('{"work":true}'), [...DEFAULT_OPEN]);
  assert.deepEqual(parseOpen('["system","nope","work"]'), ['work', 'system']);
  assert.deepEqual(parseOpen('[]'), []);
});

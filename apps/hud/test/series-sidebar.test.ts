import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldText, isSeriesOpen, parseOpenSeries, searchGroups, toggleSeries, withSeries } from '../src/lib/series-sidebar.ts';

const GROUPS = [
  { show: 'Scrubs', members: [{ id: 'cox', name: 'Dr. Cox' }, { id: 'elliot', name: 'Elliot' }] },
  { show: 'I Simpson', members: [{ id: 'homer', name: 'Homer' }, { id: 'burns', name: 'Mr. Burns' }] },
  { show: 'Prison Break', members: [{ id: 'scofield', name: 'Michael' }] },
];

test('the search finds by name, by id and by series, every word, whatever the case and the accents', () => {
  assert.equal(foldText('  Élliot   Reid '), 'elliot reid');
  assert.deepEqual(searchGroups(GROUPS, 'dr cox'), [{ show: 'Scrubs', members: [{ id: 'cox', name: 'Dr. Cox' }] }]);
  assert.deepEqual(searchGroups(GROUPS, 'burns').map((group) => group.members.map((person) => person.id)), [['burns']]);
  assert.deepEqual(searchGroups(GROUPS, 'ÉLLIOT').map((group) => group.members.map((person) => person.id)), [['elliot']]);
  assert.deepEqual(searchGroups(GROUPS, 'simpson').map((group) => group.show), ['I Simpson']);
  assert.deepEqual(searchGroups(GROUPS, 'simpson burns').map((group) => group.members.map((person) => person.id)), [['burns']]);
  assert.deepEqual(searchGroups(GROUPS, 'scofield').map((group) => group.members.map((person) => person.name)), [['Michael']]);
});

test('an empty search shows every group whole; a search without matches shows none', () => {
  assert.deepEqual(searchGroups(GROUPS, '   '), GROUPS);
  assert.deepEqual(searchGroups(GROUPS, 'kelso'), []);
  assert.deepEqual(searchGroups(GROUPS, 'homer cox'), [], 'every word in the same person');
});

test('a series is open when opened or during a search; the series in view opens once and folds like the others', () => {
  assert.equal(isSeriesOpen('Scrubs', [], false), false);
  assert.equal(isSeriesOpen('Scrubs', ['Scrubs'], false), true);
  assert.equal(isSeriesOpen('Scrubs', [], true), true);
  assert.deepEqual(toggleSeries(['Scrubs'], 'I Simpson'), ['Scrubs', 'I Simpson']);
  assert.deepEqual(toggleSeries(['Scrubs', 'I Simpson'], 'Scrubs'), ['I Simpson']);
  // The series of the chosen person opens; folded by the user, it stays folded.
  const opened = withSeries([], 'Scrubs');
  assert.deepEqual(opened, ['Scrubs']);
  const folded = toggleSeries(opened, 'Scrubs');
  assert.equal(isSeriesOpen('Scrubs', folded, false), false);
  assert.deepEqual(withSeries(['Scrubs'], 'Scrubs'), ['Scrubs']);
  assert.deepEqual(withSeries(['Scrubs'], null), ['Scrubs']);
});

test('what the browser kept: a list of names, anything else is nothing open', () => {
  assert.deepEqual(parseOpenSeries(null), []);
  assert.deepEqual(parseOpenSeries('not json'), []);
  assert.deepEqual(parseOpenSeries('{"a":1}'), []);
  assert.deepEqual(parseOpenSeries('["Scrubs", 3, "I Simpson"]'), ['Scrubs', 'I Simpson']);
  assert.equal(parseOpenSeries(JSON.stringify(Array.from({ length: 150 }, (_item, index) => `s${String(index)}`))).length, 100);
});

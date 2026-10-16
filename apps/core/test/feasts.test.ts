import assert from 'node:assert/strict';
import { test } from 'node:test';

import { easterSunday, inWindow, localDay, themeDay, windowLength } from '../src/feasts.ts';

const day = (year: number, month: number, date: number) => ({ year, month, day: date });

test('Easter Sunday by the computus, on years known (D-246)', () => {
  const known: [number, number, number][] = [
    [1818, 3, 22],
    [1943, 4, 25],
    [2008, 3, 23],
    [2019, 4, 21],
    [2024, 3, 31],
    [2025, 4, 20],
    [2026, 4, 5],
    [2027, 3, 28],
    [2038, 4, 25],
    [2285, 3, 22],
  ];
  for (const [year, month, date] of known) assert.deepEqual(easterSunday(year), day(year, month, date), String(year));
});

test('a window of month-days, ends included, across the new year when from comes after to', () => {
  const christmas = { from: '12-08', to: '01-06' };
  assert.equal(inWindow(christmas, day(2026, 12, 8)), true);
  assert.equal(inWindow(christmas, day(2027, 1, 6)), true);
  assert.equal(inWindow(christmas, day(2026, 12, 7)), false);
  assert.equal(inWindow(christmas, day(2027, 1, 7)), false);
  assert.equal(inWindow({ from: '08-01', to: '08-31' }, day(2026, 7, 31)), false);
  assert.equal(inWindow({ from: '03-17', to: '03-17' }, day(2026, 3, 17)), true);
  assert.equal(windowLength(christmas, day(2026, 12, 20)), 30);
  assert.equal(windowLength({ from: '03-17', to: '03-17' }, day(2026, 3, 17)), 1);
});

test('the movable feasts: Carnevale from giovedì to martedì grasso, Pasqua from Palm Sunday to Easter Monday', () => {
  // 2026: Easter on 5 April, martedì grasso on 17 February.
  assert.equal(inWindow({ feast: 'carnevale' }, day(2026, 2, 11)), false);
  assert.equal(inWindow({ feast: 'carnevale' }, day(2026, 2, 12)), true);
  assert.equal(inWindow({ feast: 'carnevale' }, day(2026, 2, 17)), true);
  assert.equal(inWindow({ feast: 'carnevale' }, day(2026, 2, 18)), false);
  assert.equal(inWindow({ feast: 'pasqua' }, day(2026, 3, 29)), true);
  assert.equal(inWindow({ feast: 'pasqua' }, day(2026, 4, 6)), true);
  assert.equal(inWindow({ feast: 'pasqua' }, day(2026, 4, 7)), false);
  // 2027: Easter on 28 March, a year earlier in the calendar.
  assert.equal(inWindow({ feast: 'pasqua' }, day(2027, 3, 21)), true);
  assert.equal(inWindow({ feast: 'pasqua' }, day(2027, 3, 20)), false);
  assert.equal(windowLength({ feast: 'carnevale' }, day(2027, 2, 5)), 6);
});

test('the day of the themes: the local one, or ARIANNA_TODAY in development when it is a real day', () => {
  const now = new Date(2026, 9, 16, 23, 30);
  assert.deepEqual(localDay(now), day(2026, 10, 16));
  assert.deepEqual(themeDay({}, now), day(2026, 10, 16));
  assert.deepEqual(themeDay({ ARIANNA_TODAY: '2026-12-24' }, now), day(2026, 12, 24));
  for (const wrong of ['2026-02-30', '24/12/2026', '2026-13-01', '', 'domani']) assert.deepEqual(themeDay({ ARIANNA_TODAY: wrong }, now), day(2026, 10, 16), wrong);
});

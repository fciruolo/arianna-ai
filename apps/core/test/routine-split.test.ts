// «Solo <giorno>» of the calendar (D-257) without the database: what the
// page may send, and the days the first routine keeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keptDays, parseSplitInput } from '../src/routine-split.ts';
import { RoutineError } from '../src/routines.ts';

const invalid = (error: unknown): boolean => error instanceof RoutineError && error.code === 'invalid';

test('the input: two ISO days and a clock; the day of arrival defaults to the day given up', () => {
  assert.deepEqual(parseSplitInput({ day: 3, to: 5, at: '07:45' }), { day: 3, to: 5, at: '07:45' });
  assert.deepEqual(parseSplitInput({ day: 3, at: '07:45' }), { day: 3, to: 3, at: '07:45' });
  assert.throws(() => parseSplitInput({ day: 0, at: '07:45' }), invalid);
  assert.throws(() => parseSplitInput({ day: 8, at: '07:45' }), invalid);
  assert.throws(() => parseSplitInput({ day: '3', at: '07:45' }), invalid);
  assert.throws(() => parseSplitInput({ day: 3, to: 9, at: '07:45' }), invalid);
  assert.throws(() => parseSplitInput({ day: 3, at: '24:00' }), invalid);
  assert.throws(() => parseSplitInput({ day: 3, at: '7:45' }), invalid);
  assert.throws(() => parseSplitInput({ day: 3, at: '07:45', title: 'altro' }), invalid);
});

test('the days kept: all but the one given up, which must be there and not alone', () => {
  assert.deepEqual(keptDays([1, 2, 3, 4, 5], 3), [1, 2, 4, 5]);
  assert.deepEqual(keptDays([6, 7], 7), [6]);
  assert.throws(() => keptDays([1, 2], 5), invalid);
  assert.throws(() => keptDays([4], 4), invalid);
});

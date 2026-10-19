// «Solo <giorno>» of the calendar (D-257) without the database: what the
// page may send, and the days the first routine keeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dueOrNext, type IsoDay } from '../src/routine-schedule.ts';
import { daysBack, keptDays, parseSplitInput, parseUnsplitInput } from '../src/routine-split.ts';
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

test('«Annulla» of a split: only the id comes from the page; the days given back come from the event', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(parseUnsplitInput({ created: id }), { created: id });
  assert.throws(() => parseUnsplitInput({ created: 'x' }), invalid);
  assert.throws(() => parseUnsplitInput({}), invalid);
  assert.throws(() => parseUnsplitInput({ created: id, days: [1, 3, 5] }), invalid);
  assert.throws(() => parseUnsplitInput({ created: id, at: '18:00' }), invalid);
  assert.deepEqual(daysBack([1, 5], [3]), [1, 3, 5]);
  assert.deepEqual(daysBack([1, 5], [5]), [1, 5]);
  assert.deepEqual(daysBack([2], [9, 'x', 4]), [2, 4]);
});

test('a run due and not yet taken stays when it is still a time of the new rule', () => {
  const rule = { days: [1, 2, 3, 4, 5, 6, 7] as IsoDay[], at: '18:00', timezone: 'UTC' };
  const due = new Date('2026-10-19T18:00:00Z'); // a Monday
  const now = new Date('2026-10-19T18:00:20Z');
  assert.equal(dueOrNext(rule, due, now)?.toISOString(), due.toISOString());
  // Monday is no longer a day of the rule: the next one.
  assert.equal(dueOrNext({ ...rule, days: [2, 3] }, due, now)?.toISOString(), '2026-10-20T18:00:00.000Z');
  // Another time: the next one.
  assert.equal(dueOrNext({ ...rule, at: '18:30' }, due, now)?.toISOString(), '2026-10-19T18:30:00.000Z');
  // Not due yet, or none: the next after now.
  assert.equal(dueOrNext(rule, new Date('2026-10-20T18:00:00Z'), now)?.toISOString(), '2026-10-20T18:00:00.000Z');
  assert.equal(dueOrNext(rule, null, now)?.toISOString(), '2026-10-20T18:00:00.000Z');
  // Due hours ago (the Mac was off): as before, the next one after now.
  assert.equal(dueOrNext(rule, due, new Date('2026-10-19T21:00:00Z'))?.toISOString(), '2026-10-20T18:00:00.000Z');
  // Within two hours it stays, for the ticker's late report.
  assert.equal(dueOrNext(rule, due, new Date('2026-10-19T19:59:00Z'))?.toISOString(), due.toISOString());
});

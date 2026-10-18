// When a routine runs (D-110 tappa A, D-254): nextRun and latestDue with
// time zones and the two changes of the clock, without the database.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { daysText, instantOf, isClock, isTimeZone, latestDue, nextRun, whenText, type RoutineRule } from '../src/routine-schedule.ts';

const ROME = 'Europe/Rome';
const iso = (text: string): Date => new Date(text);

test('the next run is later the same day, or the next listed day', () => {
  const rule: RoutineRule = { days: [1, 2, 3, 4, 5], at: '18:00', timezone: ROME };
  // Monday 19 October 2026, 10:00 in Rome (CEST, +2).
  assert.equal(nextRun(rule, iso('2026-10-19T08:00:00Z'))?.toISOString(), '2026-10-19T16:00:00.000Z');
  // Friday after 18:00: Monday.
  assert.equal(nextRun(rule, iso('2026-10-23T17:00:00Z'))?.toISOString(), '2026-10-26T17:00:00.000Z');
});

test('the next run is strictly after: at the exact minute it is the next one', () => {
  const rule: RoutineRule = { days: [1, 2, 3, 4, 5, 6, 7], at: '18:00', timezone: ROME };
  assert.equal(nextRun(rule, iso('2026-10-19T16:00:00Z'))?.toISOString(), '2026-10-20T16:00:00.000Z');
});

test('the time zone of the routine decides, not the one of the process', () => {
  const tokyo: RoutineRule = { days: [1], at: '09:00', timezone: 'Asia/Tokyo' };
  // Sunday 18 October 2026, 23:00 UTC = Monday 08:00 in Tokyo: 09:00 is an hour later.
  assert.equal(nextRun(tokyo, iso('2026-10-18T23:00:00Z'))?.toISOString(), '2026-10-19T00:00:00.000Z');
  const newYork: RoutineRule = { days: [1], at: '09:00', timezone: 'America/New_York' };
  assert.equal(nextRun(newYork, iso('2026-10-18T23:00:00Z'))?.toISOString(), '2026-10-19T13:00:00.000Z');
});

test('a time the spring change skips runs at the end of the gap, 03:00', () => {
  // Sunday 29 March 2026 in Rome: 02:00 becomes 03:00.
  const rule: RoutineRule = { days: [7], at: '02:30', timezone: ROME };
  const run = nextRun(rule, iso('2026-03-28T12:00:00Z'));
  assert.equal(run?.toISOString(), '2026-03-29T01:00:00.000Z');
  assert.equal(whenText(run, ROME), 'domenica 29 marzo alle 03:00');
});

test('a time the autumn change has twice runs once, the first time', () => {
  // Sunday 25 October 2026 in Rome: 03:00 goes back to 02:00, 02:30 comes twice.
  const rule: RoutineRule = { days: [1, 2, 3, 4, 5, 6, 7], at: '02:30', timezone: ROME };
  const first = nextRun(rule, iso('2026-10-24T12:00:00Z'));
  assert.equal(first?.toISOString(), '2026-10-25T00:30:00.000Z');
  // The second 02:30 (01:30 UTC) is not a run: the next one is Monday's.
  const second = nextRun(rule, first);
  assert.equal(second?.toISOString(), '2026-10-26T01:30:00.000Z');
});

test('a day across the change keeps the local time: 18:00 before and after', () => {
  const rule: RoutineRule = { days: [6, 7, 1], at: '18:00', timezone: ROME };
  assert.equal(nextRun(rule, iso('2026-10-24T12:00:00Z'))?.toISOString(), '2026-10-24T16:00:00.000Z');
  assert.equal(nextRun(rule, iso('2026-10-24T17:00:00Z'))?.toISOString(), '2026-10-25T17:00:00.000Z');
});

test('instantOf finds the same instant of a plain wall clock', () => {
  assert.equal(new Date(instantOf({ year: 2026, month: 7, day: 1, hour: 12, minute: 0 }, ROME)).toISOString(), '2026-07-01T10:00:00.000Z');
  assert.equal(new Date(instantOf({ year: 2026, month: 1, day: 1, hour: 12, minute: 0 }, 'UTC')).toISOString(), '2026-01-01T12:00:00.000Z');
});

test('a rule that cannot run has no next run', () => {
  assert.equal(nextRun({ days: [], at: '18:00', timezone: ROME }, iso('2026-10-19T08:00:00Z')), undefined);
  assert.equal(nextRun({ days: [1], at: '24:00', timezone: ROME }, iso('2026-10-19T08:00:00Z')), undefined);
  assert.equal(nextRun({ days: [1], at: '18:00', timezone: 'Mars/Olympus' }, iso('2026-10-19T08:00:00Z')), undefined);
});

test('latestDue gives the last run missed, never the days before', () => {
  const rule: RoutineRule = { days: [1, 2, 3, 4, 5, 6, 7], at: '18:00', timezone: ROME };
  // Off from Monday 18:00 until Thursday 19:00: only Thursday's 18:00 is due.
  const due = latestDue(rule, iso('2026-10-19T16:00:00Z'), iso('2026-10-22T17:00:00Z'));
  assert.equal(due?.toISOString(), '2026-10-22T16:00:00.000Z');
  // The run itself, at its minute, is due.
  assert.equal(latestDue(rule, iso('2026-10-19T16:00:00Z'), iso('2026-10-19T16:00:00Z'))?.toISOString(), '2026-10-19T16:00:00.000Z');
  // Not yet.
  assert.equal(latestDue(rule, iso('2026-10-19T16:00:00Z'), iso('2026-10-19T15:59:00Z')), undefined);
});

test('the checks of clock and zone', () => {
  assert.ok(isClock('07:05'));
  assert.ok(!isClock('7:05'));
  assert.ok(!isClock('18:60'));
  assert.ok(isTimeZone('Europe/Rome'));
  assert.ok(isTimeZone('UTC'));
  assert.ok(!isTimeZone('Europe/Nowhere'));
  assert.ok(!isTimeZone('../etc'));
});

test('the days in words', () => {
  assert.equal(daysText([1, 2, 3, 4, 5, 6, 7]), 'ogni giorno');
  assert.equal(daysText([5, 4, 3, 2, 1]), 'lun-ven');
  assert.equal(daysText([6, 7]), 'sab e dom');
  assert.equal(daysText([1, 3, 5]), 'lun, mer e ven');
  assert.equal(daysText([2]), 'ogni martedì');
});

// The calendar of the routines (D-257): the times of a week on the wall clock
// of the person who looks, from nextRun, with the changes of the clock of
// 2026 in Rome (29 March, 25 October) and routines in other zones.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CALENDAR_MAX_DAYS, calendarOf, occurrencesBetween, parseCalendarQuery, type CalendarRoutine, type CalendarRun } from '../src/routine-calendar.ts';
import { RoutineError } from '../src/routines.ts';

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
/** Before every week of these tests: all their times are still to come. */
const BEFORE = new Date('2026-01-02T00:00:00Z');

function routine(id: string, days: CalendarRoutine['rule']['days'], at: string, timezone = 'Europe/Rome', extra: Partial<CalendarRoutine> = {}): CalendarRoutine {
  return { id, rule: { days, at, timezone }, status: 'active', createdAt: LONG_AGO, ...extra };
}

const ROME_WEEK = { from: '2026-10-12', to: '2026-10-19', timezone: 'Europe/Rome' };

test('a normal week: the days Monday to Sunday and a routine lun-ven at 18:00', () => {
  const week = calendarOf(ROME_WEEK, [routine('a', [1, 2, 3, 4, 5], '18:00')], [], BEFORE);
  assert.deepEqual(
    week.days.map((day) => `${day.date}/${String(day.isoDay)}`),
    ['2026-10-12/1', '2026-10-13/2', '2026-10-14/3', '2026-10-15/4', '2026-10-16/5', '2026-10-17/6', '2026-10-18/7'],
  );
  assert.deepEqual(
    week.entries.map((entry) => `${entry.date} ${entry.time}`),
    ['2026-10-12 18:00', '2026-10-13 18:00', '2026-10-14 18:00', '2026-10-15 18:00', '2026-10-16 18:00'],
  );
  assert.equal(week.entries[0]?.minute, 18 * 60);
  assert.equal(week.entries[0].at.toISOString(), '2026-10-12T16:00:00.000Z');
  assert.ok(week.entries.every((entry) => entry.planned && entry.run === null));
});

test('a day not in the rule has nothing; a routine on Sunday only is on Sunday only', () => {
  const week = calendarOf(ROME_WEEK, [routine('a', [7], '09:15')], [], BEFORE);
  assert.deepEqual(
    week.entries.map((entry) => `${entry.date} ${entry.time}`),
    ['2026-10-18 09:15'],
  );
});

test('autumn change, 25 October 2026 in Rome: 02:30 once (the first), 18:00 one hour later in UTC', () => {
  const week = calendarOf({ from: '2026-10-19', to: '2026-10-26', timezone: 'Europe/Rome' }, [routine('night', [7], '02:30'), routine('evening', [6, 7], '18:00')], [], BEFORE);
  const night = week.entries.filter((entry) => entry.routineId === 'night');
  assert.equal(night.length, 1);
  assert.equal(night[0]?.date, '2026-10-25');
  assert.equal(night[0].time, '02:30');
  assert.equal(night[0].at.toISOString(), '2026-10-25T00:30:00.000Z');
  const evening = week.entries.filter((entry) => entry.routineId === 'evening');
  assert.deepEqual(
    evening.map((entry) => entry.at.toISOString()),
    ['2026-10-24T16:00:00.000Z', '2026-10-25T17:00:00.000Z'],
  );
  assert.ok(evening.every((entry) => entry.time === '18:00'));
});

test('autumn change: a window of the 25th alone, from local midnight to local midnight (25 hours)', () => {
  const week = calendarOf({ from: '2026-10-25', to: '2026-10-26', timezone: 'Europe/Rome' }, [routine('a', [1, 2, 3, 4, 5, 6, 7], '00:00'), routine('b', [1, 2, 3, 4, 5, 6, 7], '23:59')], [], BEFORE);
  assert.deepEqual(
    week.entries.map((entry) => `${entry.routineId} ${entry.date} ${entry.time}`),
    ['a 2026-10-25 00:00', 'b 2026-10-25 23:59'],
  );
});

test('spring change, 29 March 2026 in Rome: 02:30 does not exist and runs at 03:00', () => {
  const week = calendarOf({ from: '2026-03-23', to: '2026-03-30', timezone: 'Europe/Rome' }, [routine('a', [7], '02:30')], [], BEFORE);
  assert.equal(week.entries.length, 1);
  assert.equal(week.entries[0]?.date, '2026-03-29');
  assert.equal(week.entries[0].time, '03:00');
  assert.equal(week.entries[0].minute, 180);
  assert.equal(week.entries[0].at.toISOString(), '2026-03-29T01:00:00.000Z');
});

test('another zone: New York at 09:00 is 15:00 in Rome, 14:00 in the week the two clocks change apart', () => {
  const ny = routine('ny', [1], '09:00', 'America/New_York');
  assert.equal(calendarOf({ from: '2026-10-19', to: '2026-10-26', timezone: 'Europe/Rome' }, [ny], [], BEFORE).entries[0]?.time, '15:00');
  // Rome is back to CET on 25 October, New York stays on EDT until 1 November.
  assert.equal(calendarOf({ from: '2026-10-26', to: '2026-11-02', timezone: 'Europe/Rome' }, [ny], [], BEFORE).entries[0]?.time, '14:00');
});

test('another zone: Tokyo on Monday at 08:00 falls on Sunday night in Rome, in the right column', () => {
  const week = calendarOf({ from: '2026-10-12', to: '2026-10-19', timezone: 'Europe/Rome' }, [routine('tk', [1], '08:00', 'Asia/Tokyo')], [], BEFORE);
  // Monday 12 at 08:00 in Tokyo is Monday 12 at 01:00 in Rome; Monday 19 is outside the window.
  assert.deepEqual(
    week.entries.map((entry) => `${entry.date} ${entry.time}`),
    ['2026-10-12 01:00'],
  );
  const sunday = calendarOf({ from: '2026-10-12', to: '2026-10-19', timezone: 'Pacific/Honolulu' }, [routine('tk', [1], '08:00', 'Asia/Tokyo')], [], BEFORE);
  // In Honolulu (-10) it is Sunday 13:00.
  assert.deepEqual(
    sunday.entries.map((entry) => `${entry.date} ${entry.time}`),
    ['2026-10-18 13:00'],
  );
});

test('the runs written: matched to their time with the outcome; a «Prova adesso» stands apart', () => {
  const runs: CalendarRun[] = [
    { routineId: 'a', scheduledFor: new Date('2026-10-12T16:00:00Z'), trigger: 'schedule', status: 'done', reason: null },
    { routineId: 'a', scheduledFor: new Date('2026-10-13T16:00:00Z'), trigger: 'schedule', status: 'missed-offline', reason: null },
    { routineId: 'a', scheduledFor: new Date('2026-10-14T16:00:00Z'), trigger: 'schedule', status: 'failed', reason: 'error' },
    { routineId: 'a', scheduledFor: new Date('2026-10-14T08:12:00Z'), trigger: 'manual', status: 'done', reason: null },
    // A routine removed: its runs are not drawn.
    { routineId: 'gone', scheduledFor: new Date('2026-10-14T08:00:00Z'), trigger: 'schedule', status: 'done', reason: null },
  ];
  const week = calendarOf(ROME_WEEK, [routine('a', [1, 2, 3, 4, 5], '18:00'), routine('gone', [3], '10:00', 'Europe/Rome', { status: 'retired' })], runs, BEFORE);
  const states = week.entries.map((entry) => `${entry.date} ${entry.time} ${entry.planned ? 'plan' : 'extra'} ${entry.run?.status ?? '-'}`);
  assert.deepEqual(states, [
    '2026-10-12 18:00 plan done',
    '2026-10-13 18:00 plan missed-offline',
    '2026-10-14 10:12 extra done',
    '2026-10-14 18:00 plan failed',
    '2026-10-15 18:00 plan -',
    '2026-10-16 18:00 plan -',
  ]);
});

test('a routine shows only from its creation; a run of an old rule stays as an extra', () => {
  const late = routine('a', [1, 2, 3, 4, 5, 6, 7], '18:00', 'Europe/Rome', { createdAt: new Date('2026-10-15T17:00:00Z') });
  const old: CalendarRun = { routineId: 'a', scheduledFor: new Date('2026-10-15T07:00:00Z'), trigger: 'schedule', status: 'done', reason: null };
  const week = calendarOf(ROME_WEEK, [late], [old], BEFORE);
  assert.deepEqual(
    week.entries.map((entry) => `${entry.date} ${entry.time} ${String(entry.planned)}`),
    ['2026-10-15 09:00 false', '2026-10-16 18:00 true', '2026-10-17 18:00 true', '2026-10-18 18:00 true'],
  );
});

test('paused and proposed routines are in the calendar too (the page draws them apart)', () => {
  const week = calendarOf(ROME_WEEK, [routine('p', [1], '09:00', 'Europe/Rome', { status: 'paused' }), routine('q', [2], '09:00', 'Europe/Rome', { status: 'proposed' })], [], BEFORE);
  assert.deepEqual(
    week.entries.map((entry) => entry.routineId),
    ['p', 'q'],
  );
});

test('occurrencesBetween: from included, to excluded', () => {
  const rule = { days: [1, 2, 3, 4, 5, 6, 7] as const, at: '12:00', timezone: 'UTC' };
  const runs = occurrencesBetween({ ...rule, days: [...rule.days] }, new Date('2026-10-12T12:00:00Z'), new Date('2026-10-14T12:00:00Z'));
  assert.deepEqual(
    runs.map((run) => run.toISOString()),
    ['2026-10-12T12:00:00.000Z', '2026-10-13T12:00:00.000Z'],
  );
  assert.deepEqual(occurrencesBetween({ days: [], at: '12:00', timezone: 'UTC' }, new Date('2026-10-12T00:00:00Z'), new Date('2026-10-19T00:00:00Z')), []);
});

test('the query: two days and a zone; too long, reversed, impossible dates and unknown zones refused', () => {
  assert.deepEqual(parseCalendarQuery({ from: '2026-10-19', to: '2026-10-26', timezone: 'Europe/Rome' }), { from: '2026-10-19', to: '2026-10-26', timezone: 'Europe/Rome' });
  assert.equal(parseCalendarQuery({ from: '2026-10-19', to: '2026-11-02', timezone: 'UTC' }).to, '2026-11-02');
  assert.ok(parseCalendarQuery({ from: '2026-10-19', to: '2026-10-20', timezone: null }).timezone.length > 0);
  const refused = (from: string | null, to: string | null, timezone: string | null = 'UTC'): void => {
    assert.throws(() => parseCalendarQuery({ from, to, timezone }), (error: unknown) => error instanceof RoutineError && error.code === 'invalid');
  };
  refused('2026-10-19', '2026-11-03'); // 15 days
  assert.equal(CALENDAR_MAX_DAYS, 14);
  refused('2026-10-26', '2026-10-19');
  refused('2026-10-19', '2026-10-19');
  refused('2026-02-30', '2026-03-02');
  refused('19/10/2026', '2026-10-26');
  refused(null, '2026-10-26');
  refused('2026-10-19', '2026-10-26', 'Europe/Nowhere');
});

test('the past is what ran: a time gone by without a run is not drawn, one with its run stays', () => {
  const runs: CalendarRun[] = [{ routineId: 'a', scheduledFor: new Date('2026-10-13T16:00:00Z'), trigger: 'schedule', status: 'done', reason: null }];
  // Thursday 15 at noon in Rome: Monday 12 never ran (say the rule changed since), Tuesday 13 ran.
  const week = calendarOf(ROME_WEEK, [routine('a', [1, 2, 3, 4, 5], '18:00')], runs, new Date('2026-10-15T10:00:00Z'));
  assert.deepEqual(
    week.entries.map((entry) => `${entry.date} ${entry.run?.status ?? '-'}`),
    ['2026-10-13 done', '2026-10-15 -', '2026-10-16 -'],
  );
});

test('an active routine just due stays drawn for 5 minutes while the ticker writes its run; a paused one does not', () => {
  // Thursday 15 at 18:03 in Rome (16:03 UTC): the 18:00 of today has no run yet.
  const at = new Date('2026-10-15T16:03:00Z');
  const active = calendarOf(ROME_WEEK, [routine('a', [4], '18:00')], [], at);
  assert.deepEqual(
    active.entries.map((entry) => entry.date),
    ['2026-10-15'],
  );
  const later = calendarOf(ROME_WEEK, [routine('a', [4], '18:00')], [], new Date('2026-10-15T16:06:00Z'));
  assert.deepEqual(later.entries, []);
  const paused = calendarOf(ROME_WEEK, [routine('a', [4], '18:00', 'Europe/Rome', { status: 'paused' })], [], at);
  assert.deepEqual(paused.entries, []);
});

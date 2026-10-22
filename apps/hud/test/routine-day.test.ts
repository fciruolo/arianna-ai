// The day view of the routines on a phone (D-293) without a browser: the
// strip of the week, the title of the month, the line of one day.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CalendarDay, CalendarEntry } from '../src/lib/routine-calendar.ts';
import { dayItemText, dayLine, monthTitle, weekStrip } from '../src/lib/routine-day.ts';
import type { Routine } from '../src/lib/routines.ts';

/** One item of a list, which must be there. */
function at<T>(list: readonly T[], index: number): T {
  const item = list.at(index);
  assert.ok(item !== undefined);
  return item;
}

const WEEK: CalendarDay[] = [
  { date: '2026-10-19', isoDay: 1 },
  { date: '2026-10-20', isoDay: 2 },
  { date: '2026-10-21', isoDay: 3 },
  { date: '2026-10-22', isoDay: 4 },
  { date: '2026-10-23', isoDay: 5 },
  { date: '2026-10-24', isoDay: 6 },
  { date: '2026-10-25', isoDay: 7 },
];

function entry(routineId: string, date: string, time: string, run: CalendarEntry['run'] = null): CalendarEntry {
  const [hours, minutes] = time.split(':').map(Number);
  return { routineId, at: `${date}T${time}:00Z`, date, time, minute: (hours ?? 0) * 60 + (minutes ?? 0), run, planned: run === null };
}

function routine(id: string, title: string, status: Routine['status'] = 'active'): Routine {
  return {
    id, title, conversationId: `c-${id}`, days: [1], at: '07:30', timezone: 'UTC', sources: ['todo'], dashboardTiles: null, summary: false, channel: 'chat',
    voiceMaxLabel: 'L1', retryMinutes: null, status, pausedBy: null, nextRunAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    conversationArchived: false, lastRun: null,
  };
}

test('the strip marks the chosen day, today and the days with a routine', () => {
  const strip = weekStrip(WEEK, [entry('a', '2026-10-19', '07:30'), entry('a', '2026-10-22', '07:30')], '2026-10-22', '2026-10-21');
  assert.equal(strip.length, 7);
  assert.deepEqual(at(strip, 3), { date: '2026-10-22', name: 'GIO', number: '22', busy: true, chosen: true, today: false });
  assert.equal(at(strip, 0).busy, true);
  assert.equal(at(strip, 1).busy, false);
  assert.equal(at(strip, 2).today, true);
  assert.equal(at(strip, 2).chosen, false);
  assert.equal(at(strip, 6).name, 'DOM');
});

test('the month title names one month, two months or two years', () => {
  assert.equal(monthTitle('2026-10-19', '2026-10-25'), 'Ottobre 2026');
  assert.equal(monthTitle('2026-09-28', '2026-10-04'), 'Settembre - ottobre 2026');
  assert.equal(monthTitle('2025-12-29', '2026-01-04'), 'Dicembre 2025 - gennaio 2026');
  assert.throws(() => monthTitle('19/10/2026', '2026-10-25'));
});

test('the line of a day is in time order, with the outcome, the next run and the proposals', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  const routines = new Map([
    ['a', routine('a', 'Rassegna del mattino')],
    ['b', routine('b', 'Fatture arrivate')],
    ['c', routine('c', 'Riepilogo del cantiere', 'proposed')],
    ['d', routine('d', 'Promemoria spesa')],
    ['e', routine('e', 'In pausa', 'paused')],
  ]);
  const entries = [
    entry('d', '2026-10-22', '21:30'),
    entry('b', '2026-10-22', '13:00'),
    entry('a', '2026-10-22', '07:30', { status: 'done', reason: null, trigger: 'schedule' }),
    entry('c', '2026-10-22', '18:00'),
    entry('e', '2026-10-22', '20:00'),
    entry('a', '2026-10-23', '07:30'),
    entry('gone', '2026-10-22', '09:00'),
  ];
  const line = dayLine(entries, '2026-10-22', routines, now, '2026-10-22');
  assert.deepEqual(line.map((item) => [item.title, item.tone]), [
    ['Rassegna del mattino', 'done'],
    ['Fatture arrivate', 'next'],
    ['Riepilogo del cantiere', 'proposed'],
    ['In pausa', 'paused'],
    ['Promemoria spesa', 'planned'],
  ]);
  assert.equal(at(line, 0).state, 'fatta');
  assert.equal(at(line, 4).state, '');
  assert.equal(dayItemText(at(line, 0)), 'Rassegna del mattino, 07:30, fatta');
  assert.equal(dayItemText(at(line, 4)), 'Promemoria spesa, 21:30');
});

test('another day has no next run; a past run without outcome is missed; an empty day is empty', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  const routines = new Map([['a', routine('a', 'Rassegna')]]);
  const tomorrow = dayLine([entry('a', '2026-10-23', '07:30')], '2026-10-23', routines, now, '2026-10-22');
  assert.deepEqual(tomorrow.map((item) => item.tone), ['planned']);
  const yesterday = dayLine([entry('a', '2026-10-21', '07:30')], '2026-10-21', routines, now, '2026-10-22');
  assert.deepEqual(yesterday.map((item) => [item.tone, item.state]), [['missed', 'non eseguita']]);
  assert.deepEqual(dayLine([entry('a', '2026-10-21', '07:30')], '2026-10-24', routines, now, '2026-10-22'), []);
});

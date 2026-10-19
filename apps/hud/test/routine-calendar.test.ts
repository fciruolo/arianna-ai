// The view «Calendario» of the page «Routine» (D-257) without a browser: the
// week from Monday, the arrows (a week, or a day on a phone), the blocks of a
// day side by side, the outcome, the form from a free hour, the remembered view.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  BLOCK_MINUTES,
  blockLook,
  blockText,
  dayHead,
  dayTitle,
  focusEntry,
  formAt,
  hourFor,
  layoutDay,
  mondayOf,
  nowIn,
  nowLine,
  outcomeOf,
  readView,
  startHour,
  stepAnchor,
  VIEW_KEY,
  visibleDays,
  weekRange,
  weekTitle,
  writeView,
  type CalendarDay,
  type CalendarEntry,
} from '../src/lib/routine-calendar.ts';
import { allDaysText, canDrag, clockOf, DRAG_THRESHOLD, dragTarget, isClick, moveAllDays, movePlan, moveQuestion, onlyDayText } from '../src/lib/routine-calendar.ts';

test('a press that barely moves is a click; past the threshold it is a drag', () => {
  assert.equal(isClick(0, 0), true);
  assert.equal(isClick(2, 2), true);
  assert.equal(isClick(DRAG_THRESHOLD, 0), false);
  assert.equal(isClick(0, -10), false);
});

test('the drag lands in steps of 15 minutes, inside the day, on the nearest column', () => {
  const start = { column: 2, minute: 18 * 60 };
  // 44 px an hour: 11 px is 15 minutes.
  assert.deepEqual(dragTarget(start, 0, 11, 44, 120, 7), { column: 2, minute: 18 * 60 + 15 });
  assert.deepEqual(dragTarget(start, 0, 4, 44, 120, 7), { column: 2, minute: 18 * 60 });
  assert.deepEqual(dragTarget(start, 0, -44 * 3 - 6, 44, 120, 7), { column: 2, minute: 14 * 60 + 45 });
  assert.deepEqual(dragTarget(start, 130, 0, 44, 120, 7), { column: 3, minute: 18 * 60 });
  assert.deepEqual(dragTarget(start, -1000, 0, 44, 120, 7), { column: 0, minute: 18 * 60 });
  assert.deepEqual(dragTarget(start, 1000, 0, 44, 120, 7), { column: 6, minute: 18 * 60 });
  assert.deepEqual(dragTarget(start, 0, 5000, 44, 120, 7), { column: 2, minute: 23 * 60 + 45 });
  assert.deepEqual(dragTarget(start, 0, -5000, 44, 120, 7), { column: 2, minute: 0 });
  // One day on a phone: only up and down.
  assert.deepEqual(dragTarget({ column: 0, minute: 600 }, 300, 22, 44, 300, 1), { column: 0, minute: 630 });
  assert.equal(clockOf(7 * 60 + 45), '07:45');
  assert.equal(clockOf(0), '00:00');
});

test('what can be dragged: a time to come of an active or paused routine, in its zone', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const future = entry('a', '2026-10-21', '09:00');
  const zone = 'Europe/Rome';
  assert.equal(canDrag(future, { status: 'active', timezone: zone }, zone, now), true);
  assert.equal(canDrag(future, { status: 'paused', timezone: zone }, zone, now), true);
  assert.equal(canDrag(future, { status: 'proposed', timezone: zone }, zone, now), false);
  assert.equal(canDrag(future, undefined, zone, now), false);
  assert.equal(canDrag(future, { status: 'active', timezone: 'America/New_York' }, zone, now), false);
  assert.equal(canDrag(entry('a', '2026-10-19', '09:00'), { status: 'active', timezone: zone }, zone, now), false);
  assert.equal(canDrag({ ...future, run: { status: 'done', reason: null, trigger: 'manual' }, planned: false }, { status: 'active', timezone: zone }, zone, now), false);
});

test('after the drop: one day moves, more days ask; «Tutti i giorni» replaces the day and says when it merges', () => {
  assert.deepEqual(movePlan({ days: [3], at: '18:00' }, 3, 3, '18:00'), { kind: 'none' });
  assert.deepEqual(movePlan({ days: [3], at: '18:00' }, 3, 5, '07:45'), { kind: 'move', days: [5], at: '07:45' });
  assert.deepEqual(movePlan({ days: [1, 3, 5], at: '18:00' }, 3, 3, '19:00'), { kind: 'choose', from: 3, to: 3, at: '19:00', all: [1, 3, 5], merges: false });
  assert.deepEqual(movePlan({ days: [1, 3, 5], at: '18:00' }, 3, 4, '18:00'), { kind: 'choose', from: 3, to: 4, at: '18:00', all: [1, 4, 5], merges: false });
  assert.deepEqual(moveAllDays([1, 3, 5], 3, 5), { days: [1, 5], merges: true });
  assert.equal(allDaysText({ to: 4, merges: false }), 'Tutti i giorni');
  assert.equal(allDaysText({ to: 5, merges: true }), 'Tutti i giorni (venerdì c’è già: si unisce)');
  assert.equal(onlyDayText(4), 'Solo giovedì');
  assert.equal(moveQuestion({ to: 4, at: '07:45' }), 'Spostare alle 07:45 di giovedì:');
});

function entry(routineId: string, date: string, time: string, extra: Partial<CalendarEntry> = {}): CalendarEntry {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return { routineId, at: `${date}T${time}:00.000Z`, date, time, minute: hour * 60 + minute, run: null, planned: true, ...extra };
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

test('the week of a day starts on Monday, across months and years', () => {
  assert.equal(mondayOf('2026-10-18'), '2026-10-12'); // a Sunday
  assert.equal(mondayOf('2026-10-19'), '2026-10-19');
  assert.equal(mondayOf('2026-10-01'), '2026-09-28');
  assert.equal(mondayOf('2027-01-01'), '2026-12-28');
  assert.deepEqual(weekRange('2026-10-25'), { from: '2026-10-19', to: '2026-10-26' });
  assert.equal(addDays('2026-10-25', 1), '2026-10-26'); // the day of the change of the clock is a day like the others
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('the arrows: a week on a wide screen, a day on a phone', () => {
  assert.equal(stepAnchor('2026-10-21', 1, false), '2026-10-28');
  assert.equal(stepAnchor('2026-10-21', -1, false), '2026-10-14');
  assert.equal(stepAnchor('2026-10-25', 1, true), '2026-10-26');
  assert.equal(stepAnchor('2026-10-19', -1, true), '2026-10-18');
});

test('a phone draws only the day of the anchor; a wide screen the whole week', () => {
  assert.equal(visibleDays(WEEK, '2026-10-21', false).length, 7);
  assert.deepEqual(visibleDays(WEEK, '2026-10-21', true), [{ date: '2026-10-21', isoDay: 3 }]);
  // Before the week is read: the day alone, with its day of the week.
  assert.deepEqual(visibleDays([], '2026-10-25', true), [{ date: '2026-10-25', isoDay: 7 }]);
});

test('the titles: the week, the single day, the head of a column', () => {
  assert.equal(weekTitle('2026-10-19', '2026-10-26'), '19-25 ottobre 2026');
  assert.equal(weekTitle('2026-09-28', '2026-10-05'), '28 settembre - 4 ottobre 2026');
  assert.equal(weekTitle('2026-12-28', '2027-01-04'), '28 dicembre 2026 - 3 gennaio 2027');
  assert.equal(dayTitle('2026-10-25'), 'domenica 25 ottobre 2026');
  assert.equal(dayHead({ date: '2026-10-19', isoDay: 1 }), 'lun 19');
});

test('the blocks of a day: alone full width, side by side when they overlap', () => {
  const blocks = layoutDay(
    [entry('a', '2026-10-19', '18:00'), entry('b', '2026-10-19', '18:15'), entry('c', '2026-10-19', '09:00'), entry('d', '2026-10-19', '18:30'), entry('x', '2026-10-20', '18:00')],
    '2026-10-19',
  );
  const seen = blocks.map((block) => `${block.entry.routineId} ${String(block.start)} ${String(block.lane)}/${String(block.lanes)}`);
  // c alone; a and b overlap (15 minutes apart, blocks of 30); d starts when a ends, so it takes lane 0 again in the same group.
  assert.deepEqual(seen, ['c 540 0/1', 'a 1080 0/2', 'b 1095 1/2', 'd 1110 0/2']);
  assert.equal(BLOCK_MINUTES, 30);
});

test('a block late in the night stays inside the day', () => {
  const [block] = layoutDay([entry('a', '2026-10-25', '23:50')], '2026-10-25');
  assert.equal(block?.start, 24 * 60 - BLOCK_MINUTES);
});

test('the outcome of a run: fatta, saltata (Mac spento or skipped), fallita, nothing before it runs', () => {
  const run = (status: 'done' | 'missed-offline' | 'skipped' | 'failed'): CalendarEntry => entry('a', '2026-10-19', '18:00', { run: { status, reason: null, trigger: 'schedule' } });
  assert.equal(outcomeOf(run('done')), 'done');
  assert.equal(outcomeOf(run('missed-offline')), 'skipped');
  assert.equal(outcomeOf(run('skipped')), 'skipped');
  assert.equal(outcomeOf(run('failed')), 'failed');
  assert.equal(outcomeOf(entry('a', '2026-10-19', '18:00')), null);
});

test('the look and the words of a block: paused, proposed, past without a run, a trial', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const past = entry('a', '2026-10-19', '18:00');
  assert.equal(blockText(past, 'Sera', blockLook(past, { status: 'active' }, now)), 'Sera, 18:00, non eseguita');
  const future = entry('a', '2026-10-23', '18:00');
  assert.equal(blockText(future, 'Sera', blockLook(future, { status: 'paused' }, now)), 'Sera, 18:00, in pausa');
  assert.equal(blockText(future, 'Sera', blockLook(future, { status: 'proposed' }, now)), 'Sera, 18:00, proposta, da approvare');
  const trial = entry('a', '2026-10-20', '10:12', { planned: false, run: { status: 'done', reason: null, trigger: 'manual' } });
  const look = blockLook(trial, { status: 'active' }, now);
  assert.equal(look.trial, true);
  assert.equal(blockText(trial, 'Sera', look), 'Sera, 10:12, prova, fatta');
});

test('a free hour opens the form on that day of the week, at that hour', () => {
  const form = formAt('2026-10-25', 7);
  assert.deepEqual(form.days, [7]);
  assert.equal(form.at, '07:00');
  assert.equal(form.title, '');
  assert.equal(formAt('2026-10-19', 18).at, '18:00');
  assert.deepEqual(formAt('2026-10-19', 18).days, [1]);
});

test('the line of the current hour, only on the day drawn', () => {
  assert.deepEqual(nowLine(WEEK, { date: '2026-10-21', minute: 600 }), { column: 2, minute: 600 });
  assert.equal(nowLine(WEEK, { date: '2026-10-27', minute: 600 }), null);
  assert.deepEqual(nowLine([{ date: '2026-10-21', isoDay: 3 }], { date: '2026-10-21', minute: 5 }), { column: 0, minute: 5 });
  // The wall clock in a zone: after the change of 25 October Rome is UTC+1.
  assert.deepEqual(nowIn('Europe/Rome', new Date('2026-10-25T12:30:00Z')), { date: '2026-10-25', minute: 13 * 60 + 30 });
  assert.deepEqual(nowIn('Europe/Rome', new Date('2026-10-24T22:30:00Z')), { date: '2026-10-25', minute: 30 });
});

test('the view is remembered in the browser, and a broken storage falls back to the list', () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
  assert.equal(readView(storage), 'list');
  writeView(storage, 'calendar');
  assert.equal(kept.get(VIEW_KEY), 'calendar');
  assert.equal(readView(storage), 'calendar');
  const broken = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: (): void => {
      throw new Error('blocked');
    },
  };
  assert.equal(readView(broken), 'list');
  assert.doesNotThrow(() => {
    writeView(broken, 'calendar');
  });
  assert.equal(readView(undefined), 'list');
});

test('the hour the grid opens on: 06, earlier for the current hour or an early block, never before 00', () => {
  assert.equal(startHour(null, null), 6);
  assert.equal(startHour(14 * 60, 18 * 60), 6);
  // At 02:52 a routine at 02:49 (the trial of the user): both in sight.
  assert.equal(startHour(2 * 60 + 52, 2 * 60 + 49), 1);
  assert.equal(startHour(null, 4 * 60 + 30), 3);
  assert.equal(startHour(5 * 60 + 10, null), 4);
  assert.equal(startHour(0, 10), 0);
  assert.equal(hourFor(18 * 60), 17);
  assert.equal(hourFor(20), 0);
});

test('after a save the view goes to the next time of that routine, else to its first', () => {
  const list = [entry('a', '2026-10-19', '09:00'), entry('b', '2026-10-20', '07:00'), entry('a', '2026-10-21', '09:00')];
  assert.equal(focusEntry(list, 'a', new Date('2026-10-20T00:00:00Z'))?.date, '2026-10-21');
  assert.equal(focusEntry(list, 'a', new Date('2026-10-30T00:00:00Z'))?.date, '2026-10-19');
  assert.equal(focusEntry(list, 'c', new Date('2026-10-20T00:00:00Z')), undefined);
});

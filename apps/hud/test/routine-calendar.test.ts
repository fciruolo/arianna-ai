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

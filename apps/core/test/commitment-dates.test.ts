import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addDays, dayText, isDay, localDay, parseDay, parseRange, parseTime, relativeDayText } from '../src/commitment-dates.ts';

// Friday 9 October 2026.
const TODAY = '2026-10-09';

test('relative words become a day computed by the code', () => {
  assert.deepEqual(parseDay('oggi', TODAY), { day: '2026-10-09' });
  assert.deepEqual(parseDay('domani', TODAY), { day: '2026-10-10' });
  assert.deepEqual(parseDay('Dopodomani', TODAY), { day: '2026-10-11' });
  assert.deepEqual(parseDay('domani mattina', TODAY), { day: '2026-10-10' });
  assert.deepEqual(parseDay('tra tre giorni', TODAY), { day: '2026-10-12' });
  assert.deepEqual(parseDay('fra 10 giorni', TODAY), { day: '2026-10-19' });
  assert.deepEqual(parseDay('tra una settimana', TODAY), { day: '2026-10-16' });
  assert.deepEqual(parseDay('tra un mese', '2026-01-31'), { day: '2026-02-28' });
  assert.deepEqual(parseDay('la settimana prossima', TODAY), { day: '2026-10-12' });
});

test('a weekday is the next one after today, also with or without the accent', () => {
  assert.deepEqual(parseDay('giovedì', TODAY), { day: '2026-10-15' });
  assert.deepEqual(parseDay('giovedi dopo pranzo', TODAY), { day: '2026-10-15' });
  assert.deepEqual(parseDay('lunedì prossimo', TODAY), { day: '2026-10-12' });
  assert.deepEqual(parseDay('sabato', TODAY), { day: '2026-10-10' });
  // Said on a Friday, "venerdì" is the next week's.
  assert.deepEqual(parseDay('venerdì', TODAY), { day: '2026-10-16' });
});

test('dates with or without the year, never before today', () => {
  assert.deepEqual(parseDay('15 ottobre', TODAY), { day: '2026-10-15' });
  assert.deepEqual(parseDay('giovedì 15 ottobre 2026', TODAY), { day: '2026-10-15' });
  assert.deepEqual(parseDay('15/10', TODAY), { day: '2026-10-15' });
  assert.deepEqual(parseDay('15.10', TODAY), { day: '2026-10-15' });
  assert.deepEqual(parseDay('3/10', TODAY), { day: '2027-10-03' });
  assert.deepEqual(parseDay('2026-12-24', TODAY), { day: '2026-12-24' });
  assert.deepEqual(parseDay('il 20', TODAY), { day: '2026-10-20' });
  assert.deepEqual(parseDay('il 5', TODAY), { day: '2026-11-05' });
});

test('a clock in the same words is taken apart', () => {
  assert.deepEqual(parseDay('giovedì alle 15', TODAY), { day: '2026-10-15', time: '15:00' });
  assert.deepEqual(parseDay('domani ore 9.30', TODAY), { day: '2026-10-10', time: '09:30' });
  assert.deepEqual(parseDay('15/10 16:45', TODAY), { day: '2026-10-15', time: '16:45' });
  assert.equal(parseTime('15'), '15:00');
  assert.equal(parseTime('alle 9:05'), '09:05');
  assert.equal(parseTime('24:00'), undefined);
  assert.equal(parseTime('dopo pranzo'), undefined);
});

test('what the code cannot tell is refused, never guessed', () => {
  assert.equal(parseDay('quando posso', TODAY), undefined);
  assert.equal(parseDay('prima o poi', TODAY), undefined);
  assert.equal(parseDay('2026-10-01', TODAY), undefined);
  assert.equal(parseDay('2026-02-30', TODAY), undefined);
  assert.equal(parseDay('31/02', TODAY), undefined);
  assert.equal(parseDay('tra tanti giorni', TODAY), undefined);
  assert.equal(parseDay('', TODAY), undefined);
  // A clock it cannot read is refused with the day, never dropped.
  assert.equal(parseDay('domani alle 25', TODAY), undefined);
  assert.equal(parseDay('domani 26:00', TODAY), undefined);
});

test('a weekday of next week is that day, not next Monday', () => {
  assert.deepEqual(parseDay('giovedì della settimana prossima', TODAY), { day: '2026-10-15' });
  assert.deepEqual(parseDay('martedì settimana prossima', TODAY), { day: '2026-10-13' });
  assert.deepEqual(parseRange('giovedì della settimana prossima', TODAY), { from: '2026-10-15', to: '2026-10-15', text: 'giovedì 15 ottobre 2026' });
});

test('ranges of a question: one day, this week, next week', () => {
  assert.deepEqual(parseRange('domani', TODAY), { from: '2026-10-10', to: '2026-10-10', text: 'domani, sabato 10 ottobre 2026' });
  assert.deepEqual(parseRange('questa settimana', TODAY), { from: '2026-10-09', to: '2026-10-11', text: 'questa settimana' });
  assert.deepEqual(parseRange('la settimana prossima', TODAY), { from: '2026-10-12', to: '2026-10-18', text: 'la settimana prossima' });
  assert.equal(parseRange('tutti', TODAY), undefined);
});

test('ranges from today: the next days and weeks, this month and the next', () => {
  assert.deepEqual(parseRange('i prossimi 7 giorni', TODAY), { from: '2026-10-09', to: '2026-10-15', text: 'i prossimi 7 giorni' });
  assert.deepEqual(parseRange('nei prossimi tre giorni', TODAY), { from: '2026-10-09', to: '2026-10-11', text: 'i prossimi 3 giorni' });
  assert.deepEqual(parseRange('prossimi giorni', TODAY), { from: '2026-10-09', to: '2026-10-15', text: 'i prossimi 7 giorni' });
  assert.deepEqual(parseRange('le prossime due settimane', TODAY), { from: '2026-10-09', to: '2026-10-22', text: 'i prossimi 14 giorni' });
  assert.deepEqual(parseRange('questo mese', TODAY), { from: '2026-10-09', to: '2026-10-31', text: 'questo mese' });
  assert.deepEqual(parseRange('il mese prossimo', TODAY), { from: '2026-11-01', to: '2026-11-30', text: 'il mese prossimo' });
  assert.deepEqual(parseRange('il mese prossimo', '2026-12-20'), { from: '2027-01-01', to: '2027-01-31', text: 'il mese prossimo' });
  // A count the core cannot read, or out of bounds: the model asks.
  assert.equal(parseRange('i prossimi tanti giorni', TODAY), undefined);
  assert.equal(parseRange('i prossimi 0 giorni', TODAY), undefined);
  assert.equal(parseRange('i prossimi 400 giorni', TODAY), undefined);
  // A weekday named keeps the meaning of one day.
  assert.deepEqual(parseRange('giovedì prossimo', TODAY), parseRange('giovedì', TODAY));
});

test('calendar helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(dayText('2026-10-15'), 'giovedì 15 ottobre 2026');
  assert.equal(relativeDayText('2026-10-09', TODAY), 'oggi, venerdì 9 ottobre 2026');
  assert.equal(isDay('2028-02-29'), true);
  assert.equal(isDay('2027-02-29'), false);
  assert.equal(localDay(new Date(2026, 9, 9, 23, 59)), '2026-10-09');
});

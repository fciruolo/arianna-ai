import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOCK_SOURCE, clockPart, joinTrailer, nowText, withTrailer } from '../src/clock-part.ts';

test('the line of now (D-311): weekday, day, month and year in Italian, to the second, with the time zone', () => {
  assert.equal(nowText(new Date('2026-10-23T08:12:59Z'), 'Europe/Rome'), 'Adesso: venerdì 23 ottobre 2026, 10:12:59 (Europe/Rome).');
  // The day of the zone, not of UTC: past midnight in Rome it is already Saturday.
  assert.equal(nowText(new Date('2026-10-23T22:05:07Z'), 'Europe/Rome'), 'Adesso: sabato 24 ottobre 2026, 00:05:07 (Europe/Rome).');
  assert.equal(nowText(new Date('2026-10-23T22:05:00Z'), 'UTC'), 'Adesso: venerdì 23 ottobre 2026, 22:05:00 (UTC).');
  // After the change of the clocks: winter time, one hour from UTC.
  assert.equal(nowText(new Date('2026-10-26T08:00:00Z'), 'Europe/Rome'), 'Adesso: lunedì 26 ottobre 2026, 09:00:00 (Europe/Rome).');
  // Without a zone, the one of this Mac: still a whole line.
  assert.match(nowText(new Date()), /^Adesso: \S+ \d{1,2} \S+ \d{4}, \d{2}:\d{2}:\d{2} \([^)]+\)\.$/);
});

test('the part of now is L0, with a source of its own', () => {
  const part = clockPart(new Date('2026-10-23T08:12:00Z'), 'Europe/Rome');
  assert.deepEqual(part, { text: 'Adesso: venerdì 23 ottobre 2026, 10:12:00 (Europe/Rome).', label: 'L0', source: CLOCK_SOURCE });
  assert.notEqual(part.label, 'L1');
});

test('the trailer joins the lines and the time, leaving out the empty ones', () => {
  assert.equal(joinTrailer('<character_lines>x</character_lines>', 'Adesso: y.'), '<character_lines>x</character_lines>\n\nAdesso: y.');
  assert.equal(joinTrailer('', 'Adesso: y.'), 'Adesso: y.');
  assert.equal(joinTrailer('', ''), '');
});

test('the trailer goes after the last message only when it is the user\'s', () => {
  const system = { role: 'system', content: 'Regole.' };
  assert.deepEqual(withTrailer([system, { role: 'user', content: 'Che ore sono?' }], 'Adesso: y.'), [system, { role: 'user', content: 'Che ore sono?\n\nAdesso: y.' }]);
  // Never into the system message, nor after an answer of the model; nothing for an empty trailer.
  assert.deepEqual(withTrailer([system], 'Adesso: y.'), [system]);
  assert.deepEqual(withTrailer([system, { role: 'assistant', content: 'Ciao.' }], 'Adesso: y.'), [system, { role: 'assistant', content: 'Ciao.' }]);
  assert.deepEqual(withTrailer([system, { role: 'user', content: 'Ciao.' }], ''), [system, { role: 'user', content: 'Ciao.' }]);
});

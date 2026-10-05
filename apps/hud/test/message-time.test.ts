import assert from 'node:assert/strict';
import { test } from 'node:test';

import { messageTime } from '../src/lib/message-time.ts';

const now = new Date(2026, 9, 5, 9, 0);

test('a message of today shows only the time', () => {
  assert.equal(messageTime(new Date(2026, 9, 5, 7, 31, 51).toISOString(), now)?.text, '07:31');
  assert.equal(messageTime(new Date(2026, 9, 5, 0, 5).toISOString(), now)?.text, '00:05');
});

test('a message of yesterday says "ieri", by calendar day and not by 24 hours', () => {
  assert.equal(messageTime(new Date(2026, 9, 4, 23, 59).toISOString(), now)?.text, 'ieri 23:59');
  assert.equal(messageTime(new Date(2026, 9, 4, 8, 0).toISOString(), now)?.text, 'ieri 08:00');
  assert.equal(messageTime(new Date(2026, 9, 3, 23, 59).toISOString(), now)?.text, '3 ott 23:59');
});

test('"ieri" holds across a change of daylight saving time', () => {
  const afterChange = new Date(2026, 9, 26, 0, 30);
  assert.equal(messageTime(new Date(2026, 9, 25, 0, 30).toISOString(), afterChange)?.text, 'ieri 00:30');
});

test('a message dated a little after now, by a clock ahead of the browser, is shown as today', () => {
  assert.equal(messageTime(new Date(2026, 9, 6, 0, 0, 20).toISOString(), new Date(2026, 9, 5, 23, 59, 50))?.text, '00:00');
});

test('an older message of this year shows day and month', () => {
  assert.equal(messageTime(new Date(2026, 9, 3, 7, 31).toISOString(), now)?.text, '3 ott 07:31');
  assert.equal(messageTime(new Date(2026, 0, 12, 18, 4).toISOString(), now)?.text, '12 gen 18:04');
});

test('a message of another year shows the year too', () => {
  assert.equal(messageTime(new Date(2025, 11, 31, 22, 15).toISOString(), now)?.text, '31 dic 2025 22:15');
});

test('the full date, for the title, has weekday, year and seconds', () => {
  const full = messageTime(new Date(2026, 9, 5, 7, 31, 51).toISOString(), now)?.full ?? '';
  assert.match(full, /lunedì/);
  assert.match(full, /5 ottobre 2026/);
  assert.match(full, /07:31:51/);
});

test('a timestamp that is not a date shows nothing', () => {
  assert.equal(messageTime('', now), undefined);
  assert.equal(messageTime('not a date', now), undefined);
});

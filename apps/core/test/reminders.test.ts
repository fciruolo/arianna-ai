// The reminders of the secretary (I-12 S2, D-149): which moment is due at a
// local time (hours, days, recovery, change of day), the ticker on an
// injected clock, the text written by the code and the notice it becomes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_NOTIFICATIONS, DEFAULT_SECRETARY, type SecretaryConfig } from '@arianna/config';

import type { Commitment } from '../src/commitments.ts';
import { createDailyTicker, dueSlot } from '../src/daily-ticker.ts';
import { noticeAllowed, noticeOf } from '../src/notifications.ts';
import { reminderText, secretarySchedule } from '../src/reminders.ts';

const CONVERSATION = '11111111-2222-4333-8444-555555555555';
// 2026-10-08 is a Thursday, 2026-10-10 a Saturday, 2026-10-11 a Sunday.
const at = (day: string, clock: string): Date => {
  const [year = 0, month = 0, date = 0] = day.split('-').map(Number);
  const [hours = 0, minutes = 0] = clock.split(':').map(Number);
  return new Date(year, month - 1, date, hours, minutes, 0);
};
const schedule = (change: Partial<SecretaryConfig> = {}) => secretarySchedule({ ...DEFAULT_SECRETARY, ...change });

test('dueSlot: the moment whose time has come, until the next one begins', () => {
  assert.equal(dueSlot(schedule(), at('2026-10-08', '08:59')), undefined, 'before the morning nothing');
  assert.deepEqual(dueSlot(schedule(), at('2026-10-08', '09:00')), { day: '2026-10-08', key: 'morning' }, 'the minute itself');
  assert.deepEqual(dueSlot(schedule(), at('2026-10-08', '11:00')), { day: '2026-10-08', key: 'morning' }, 'started at 11: the morning is recovered');
  assert.deepEqual(dueSlot(schedule(), at('2026-10-08', '14:29')), { day: '2026-10-08', key: 'morning' });
  assert.deepEqual(dueSlot(schedule(), at('2026-10-08', '14:30')), { day: '2026-10-08', key: 'afternoon' });
  assert.deepEqual(dueSlot(schedule(), at('2026-10-08', '16:00')), { day: '2026-10-08', key: 'afternoon' }, 'started at 16: the morning is skipped');
  assert.deepEqual(dueSlot(schedule(), at('2026-10-08', '18:30')), { day: '2026-10-08', key: 'evening' });
  assert.deepEqual(dueSlot(schedule(), at('2026-10-08', '23:59')), { day: '2026-10-08', key: 'evening' }, 'the evening until the end of the day');
});

test('dueSlot: a new day starts from nothing, never with yesterday’s evening', () => {
  assert.equal(dueSlot(schedule(), at('2026-10-09', '00:00')), undefined);
  assert.equal(dueSlot(schedule(), at('2026-10-09', '08:00')), undefined);
  assert.deepEqual(dueSlot(schedule(), at('2026-10-09', '09:00')), { day: '2026-10-09', key: 'morning' });
});

test('dueSlot: off, or a day not listed, nothing; a listed day, the moment', () => {
  assert.equal(dueSlot(schedule({ enabled: false }), at('2026-10-08', '10:00')), undefined, 'off');
  const weekdays = schedule({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
  assert.equal(dueSlot(weekdays, at('2026-10-10', '10:00')), undefined, 'Saturday not listed');
  assert.equal(dueSlot(weekdays, at('2026-10-11', '19:00')), undefined, 'Sunday not listed');
  assert.deepEqual(dueSlot(weekdays, at('2026-10-08', '10:00')), { day: '2026-10-08', key: 'morning' }, 'Thursday listed');
  assert.deepEqual(dueSlot(schedule({ days: ['sun'] }), at('2026-10-11', '19:00')), { day: '2026-10-11', key: 'evening' }, 'Sunday listed');
});

test('dueSlot: the times of the settings, not the defaults', () => {
  const custom = schedule({ morning: '07:15', afternoon: '13:00', evening: '20:00' });
  assert.deepEqual(dueSlot(custom, at('2026-10-08', '07:15')), { day: '2026-10-08', key: 'morning' });
  assert.deepEqual(dueSlot(custom, at('2026-10-08', '19:59')), { day: '2026-10-08', key: 'afternoon' });
  assert.equal(dueSlot(custom, at('2026-10-08', '07:14')), undefined);
});

test('the ticker fires a moment once per day, follows the settings at each tick, and a new day again', async () => {
  let now = at('2026-10-08', '08:00');
  let config: SecretaryConfig = { ...DEFAULT_SECRETARY };
  const fired: string[] = [];
  const ticker = createDailyTicker({
    schedule: () => secretarySchedule(config),
    fire: (day, key) => {
      fired.push(`${day} ${key}`);
      return Promise.resolve();
    },
    now: () => now,
  });
  await ticker.tick();
  assert.deepEqual(fired, [], 'before the morning');
  now = at('2026-10-08', '09:00');
  await ticker.tick();
  await ticker.tick();
  assert.deepEqual(fired, ['2026-10-08 morning'], 'once, not at each tick');
  // The user moves the afternoon to 10:00 from the settings: it applies at the next tick.
  config = { ...config, afternoon: '10:00' };
  now = at('2026-10-08', '10:00');
  await ticker.tick();
  assert.deepEqual(fired, ['2026-10-08 morning', '2026-10-08 afternoon']);
  config = { ...config, enabled: false };
  now = at('2026-10-08', '18:30');
  await ticker.tick();
  assert.equal(fired.length, 2, 'turned off: the evening does not fire');
  config = { ...config, enabled: true };
  now = at('2026-10-09', '09:05');
  await ticker.tick();
  assert.deepEqual(fired, ['2026-10-08 morning', '2026-10-08 afternoon', '2026-10-09 morning'], 'the next day fires again');
});

test('the ticker never goes back to a moment left behind when the times change during the day', async () => {
  let config: SecretaryConfig = { ...DEFAULT_SECRETARY };
  let now = at('2026-10-08', '18:31');
  const fired: string[] = [];
  const ticker = createDailyTicker({
    schedule: () => secretarySchedule(config),
    fire: (day, key) => {
      fired.push(`${day} ${key}`);
      return Promise.resolve();
    },
    now: () => now,
  });
  await ticker.tick();
  assert.deepEqual(fired, ['2026-10-08 evening'], 'started at 18:31: the evening, the afternoon skipped');
  // The evening moved to 20:00: at 19:00 the afternoon is "due" again, but it comes before the evening already done.
  config = { ...config, evening: '20:00' };
  now = at('2026-10-08', '19:00');
  await ticker.tick();
  assert.deepEqual(fired, ['2026-10-08 evening']);
  now = at('2026-10-09', '14:40');
  await ticker.tick();
  assert.deepEqual(fired, ['2026-10-08 evening', '2026-10-09 afternoon'], 'a new day starts over');
});

test('the ticker retries a moment whose work failed, and reports the error', async () => {
  const errors: unknown[] = [];
  let fail = true;
  let calls = 0;
  const ticker = createDailyTicker({
    schedule: () => secretarySchedule(DEFAULT_SECRETARY),
    fire: () => {
      calls += 1;
      return fail ? Promise.reject(new Error('database down')) : Promise.resolve();
    },
    now: () => at('2026-10-08', '09:30'),
    onError: (error) => errors.push(error),
  });
  await ticker.tick();
  assert.equal(errors.length, 1);
  fail = false;
  await ticker.tick();
  await ticker.tick();
  assert.equal(calls, 2, 'retried once, then done');
});

const item = (body: string, day: string, time: string | null = null): Commitment => ({
  id: '00000000-0000-4000-8000-000000000001',
  body,
  day,
  time,
  status: 'open',
  reason: null,
  label: 'L2',
  conversationId: null,
  createdAt: new Date(),
  doneAt: null, rescheduledFrom: null, postponedFrom: null,
});

test('reminderText: written by the code, nothing when there is nothing to say', () => {
  const today = [item('Passare in banca per la fideiussione finta', '2026-10-08', '10:00')];
  const late = [item('Chiamare il cliente Rossi (finto)', '2026-10-06')];
  const morning = reminderText('morning', '2026-10-08', today, late) ?? '';
  assert.match(morning, /^Buongiorno\. Il promemoria di oggi, giovedì 8 ottobre 2026\./);
  assert.match(morning, /Da fare oggi:\n- 10:00 · Passare in banca per la fideiussione finta/);
  assert.match(morning, /Ancora da fare dai giorni scorsi:\n- martedì 6 ottobre 2026 · Chiamare il cliente Rossi \(finto\)/);
  assert.match(reminderText('afternoon', '2026-10-08', [], late) ?? '', /^Promemoria del pomeriggio\.\n\nAncora da fare dai giorni scorsi:/, 'only the late ones');
  const evening = reminderText('evening', '2026-10-08', today, late) ?? '';
  assert.match(evening, /^Resoconto di fine giornata/);
  assert.match(evening, /Di oggi non risultano fatti:\n- 10:00 · Passare in banca/);
  assert.match(evening, /fatto, non fatto o da rinviare \(a quale giorno\), e perché/);
  assert.doesNotMatch(evening, /Rossi/, 'the evening reports on the day only');
  assert.equal(reminderText('morning', '2026-10-08', [], []), undefined);
  assert.equal(reminderText('evening', '2026-10-08', [], late), undefined, 'evening with only late ones: nothing');
});

test('noticeOf and noticeAllowed: a reminder is its own kind, held back only by the quiet hours', () => {
  const reminder = { kind: 'message.created', taskId: null, payload: { conversationId: CONVERSATION, messageId: '9', role: 'assistant', reminder: 'morning' } };
  assert.deepEqual(noticeOf(reminder), { kind: 'reminder', conversationId: CONVERSATION });
  assert.deepEqual(noticeOf({ ...reminder, payload: { conversationId: CONVERSATION, messageId: '9', role: 'assistant' } }), { kind: 'reply', conversationId: CONVERSATION }, 'without the mark, a reply');
  const noon = new Date(2026, 9, 8, 12, 0);
  assert.equal(noticeAllowed('reminder', { ...DEFAULT_NOTIFICATIONS, replies: false, approvals: false, failures: false }, noon), 'yes');
  assert.equal(noticeAllowed('reminder', { ...DEFAULT_NOTIFICATIONS, quiet: { from: '11:00', to: '13:00' } }, noon), 'quiet');
});

test('reminderText (D-151): the morning starts from what was postponed to today, the others only mark it', () => {
  const bank = item('Passare in banca per la fideiussione finta', '2026-10-08', '10:00');
  const postponed = { ...item('Comprare il pane finto', '2026-10-08'), postponedFrom: '2026-10-07' };
  const morning = reminderText('morning', '2026-10-08', [bank, postponed], []) ?? '';
  assert.match(morning, /Rinviati a oggi:\n- Comprare il pane finto \(rinviato da mercoledì 7 ottobre 2026\)\n\nIl resto di oggi:\n- 10:00 · Passare in banca/);
  const afternoon = reminderText('afternoon', '2026-10-08', [bank, postponed], []) ?? '';
  assert.doesNotMatch(afternoon, /Rinviati a oggi/);
  assert.match(afternoon, /- Comprare il pane finto \(rinviato da mercoledì 7 ottobre 2026\)/);
  // Without a postponement the morning is as before.
  assert.match(reminderText('morning', '2026-10-08', [bank], []) ?? '', /\n\nDa fare oggi:\n/);
});

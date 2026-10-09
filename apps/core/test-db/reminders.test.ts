// The reminders of the secretary (I-12 S2, D-149) against PostgreSQL: a
// moment writes once per day (also across a restart and with two at once),
// nothing when the list is empty, in the secretary's conversation without
// opening a session, and its event becomes a notice of kind `reminder`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SECRETARY } from '@arianna/config';

import { noticeOf } from '../src/notifications.ts';
import { createSecretaryTicker, fireReminder } from '../src/reminders.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

async function secretaryMessages(): Promise<{ body: string; role: string; label: string; taskId: string | null }[]> {
  return db().sql<{ body: string; role: string; label: string; taskId: string | null }[]>`
    SELECT m.body, m.role, m.label::text AS label, m.task_id::text AS "taskId"
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.secretary ORDER BY m.id`;
}

async function fired(day: string): Promise<{ slot: string; written: boolean }[]> {
  const rows = await db().sql<{ payload: { slot: string; written: boolean } }[]>`
    SELECT payload FROM events WHERE kind = 'schedule.fired' AND payload ->> 'day' = ${day} ORDER BY id`;
  return rows.map((row) => ({ slot: row.payload.slot, written: row.payload.written }));
}

test('an empty list writes nothing, creates no conversation, and still counts as done for the day', async () => {
  assert.equal(await fireReminder(db().sql, '2026-10-01', 'morning'), 'empty');
  assert.equal(await fireReminder(db().sql, '2026-10-01', 'morning'), 'already');
  const [conversations] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM conversations WHERE secretary`;
  assert.equal(conversations?.count, 0);
  assert.deepEqual(await fired('2026-10-01'), [{ slot: 'morning', written: false }]);
  // A commitment added afterwards is not announced by a morning already done.
  await db().sql`INSERT INTO commitments (body, day) VALUES ('Rinnovare l’abbonamento finto', '2026-10-01'::date)`;
  assert.equal(await fireReminder(db().sql, '2026-10-01', 'morning'), 'already');
  assert.equal((await secretaryMessages()).length, 0);
});

test('a moment with commitments writes once, as Arianna in the secretary conversation, L2, without a new session', async () => {
  await db().sql`INSERT INTO commitments (body, day, at_time) VALUES ('Passare in banca per la fideiussione finta', '2026-10-08'::date, '10:00')`;
  const before = (await secretaryMessages()).length;
  assert.equal(await fireReminder(db().sql, '2026-10-08', 'morning'), 'written');
  assert.equal(await fireReminder(db().sql, '2026-10-08', 'morning'), 'already');
  const messages = (await secretaryMessages()).slice(before);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.ok(message !== undefined);
  assert.equal(message.role, 'assistant');
  assert.equal(message.label, 'L2');
  assert.equal(message.taskId, null);
  assert.match(message.body, /Da fare oggi:\n- 10:00 · Passare in banca per la fideiussione finta/);
  // The late one of 2026-10-01 is listed too.
  assert.match(message.body, /Ancora da fare dai giorni scorsi:\n- giovedì 1 ottobre 2026 · Rinnovare/);
  const [conversation] = await db().sql<{ title: string; sessionAt: Date | null; mode: string }[]>`
    SELECT title, secretary_session_at AS "sessionAt", mode FROM conversations WHERE secretary`;
  assert.deepEqual(conversation, { title: 'Segretaria', sessionAt: null, mode: 'private' });
  const [event] = await db().sql<{ kind: string; taskId: string | null; payload: Record<string, unknown> }[]>`
    SELECT kind, task_id::text AS "taskId", payload FROM events WHERE kind = 'message.created' ORDER BY id DESC LIMIT 1`;
  assert.ok(event !== undefined);
  assert.equal(event.payload.reminder, 'morning');
  assert.equal(noticeOf({ kind: event.kind, taskId: event.taskId, payload: { reminder: 'morning', role: 'assistant', conversationId: String(event.payload.conversationId) } })?.kind, 'reminder');
  // The events never carry the text of a commitment.
  const [leak] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM events WHERE payload::text LIKE '%fideiussione%'`;
  assert.equal(leak?.count, 0);
});

test('the afternoon lists only what is still open, the evening only the day', async () => {
  await db().sql`INSERT INTO commitments (body, day) VALUES ('Spedire il pacco finto', '2026-10-09'::date), ('Ritirare le chiavi finte', '2026-10-09'::date)`;
  await db().sql`UPDATE commitments SET status = 'done', done_at = now() WHERE body = 'Spedire il pacco finto'`;
  assert.equal(await fireReminder(db().sql, '2026-10-09', 'afternoon'), 'written');
  assert.equal(await fireReminder(db().sql, '2026-10-09', 'evening'), 'written');
  const [afternoon, evening] = (await secretaryMessages()).slice(-2);
  assert.match(afternoon?.body ?? '', /Di oggi ancora aperti:\n- Ritirare le chiavi finte/);
  assert.doesNotMatch(afternoon?.body ?? '', /Spedire/);
  assert.match(evening?.body ?? '', /Di oggi non risultano fatti:\n- Ritirare le chiavi finte/);
  assert.doesNotMatch(evening?.body ?? '', /fideiussione|Rinnovare/, 'the late ones are not in the report of the day');
});

test('two at once write once; a restarted ticker does not write again', async () => {
  await db().sql`INSERT INTO commitments (body, day) VALUES ('Firmare il modulo finto', '2026-10-12'::date)`;
  const before = (await secretaryMessages()).length;
  const outcomes = await Promise.all([fireReminder(db().sql, '2026-10-12', 'morning'), fireReminder(db().sql, '2026-10-12', 'morning')]);
  assert.deepEqual([...outcomes].sort(), ['already', 'written']);
  // 2026-10-12 is a Monday: a ticker started at 10:00 (the core restarted) finds the morning done.
  const now = (): Date => new Date(2026, 9, 12, 10, 0);
  const restarted = createSecretaryTicker({ sql: db().sql, settings: () => DEFAULT_SECRETARY, now });
  await restarted.tick();
  assert.equal((await secretaryMessages()).length, before + 1);
  // Turned off, or a day not listed: the afternoon does not run.
  const afternoon = (): Date => new Date(2026, 9, 12, 15, 0);
  await createSecretaryTicker({ sql: db().sql, settings: () => ({ ...DEFAULT_SECRETARY, enabled: false }), now: afternoon }).tick();
  await createSecretaryTicker({ sql: db().sql, settings: () => ({ ...DEFAULT_SECRETARY, days: ['sat', 'sun'] }), now: afternoon }).tick();
  assert.deepEqual(await fired('2026-10-12'), [{ slot: 'morning', written: true }]);
  // On, the afternoon runs.
  await createSecretaryTicker({ sql: db().sql, settings: () => DEFAULT_SECRETARY, now: afternoon }).tick();
  assert.deepEqual(await fired('2026-10-12'), [
    { slot: 'morning', written: true },
    { slot: 'afternoon', written: true },
  ]);
});

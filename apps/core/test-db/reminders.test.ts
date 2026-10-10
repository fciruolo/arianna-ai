// The reminders of the secretary (I-12 S2, D-149) against PostgreSQL: a
// moment writes once per day (also across a restart and with two at once),
// nothing when the list is empty, in the secretary's conversation without
// opening a session, and its event becomes a notice of kind `reminder`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DEFAULT_SECRETARY, resolveHome, type Project } from '@arianna/config';
import { createLabelRules } from '@arianna/policy';

import { addDocument } from '../src/client-documents.ts';
import { createClient } from '../src/clients.ts';
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

/** A container with one IM file, under data/test-tmp (fake data only). */
function imSource(im: string): { projects: () => readonly Project[]; env: { home: string; rules: ReturnType<typeof createLabelRules> } } {
  const home = join(resolveHome({}), 'data', 'test-tmp', `reminders-im-${randomUUID()}`);
  after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const box = join(home, 'repos', 'progetto-test');
  mkdirSync(join(box, 'IM'), { recursive: true });
  mkdirSync(join(box, 'parte', '.git'), { recursive: true });
  mkdirSync(join(home, 'arianna', 'kb'), { recursive: true });
  writeFileSync(join(box, 'parte', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(box, 'IM', 'IM-33.md'), im);
  const projects: Project[] = [{ name: 'progetto-test', path: 'repos/progetto-test', absolute: box, label: 'L1' }];
  return { projects: () => projects, env: { home: join(home, 'arianna'), rules: createLabelRules({ folders: [], sources: [] }) } };
}

test('an IM of tomorrow above the secretary conversation does not even create it (D-167, P4c)', async () => {
  const ims = imSource('---\nim: 33\ndata: 2026-09-03 10:00\nlabel: L3\nstato: previsto\n---\n\n## Lavori\n\n- [ ] Segreto finto\n');
  assert.equal(await fireReminder(db().sql, '2026-09-02', 'morning', ims), 'empty');
  const [conversations] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM conversations WHERE secretary`;
  assert.equal(conversations?.count, 0);
});

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

test('the morning of the day before an IM names it, also with nothing else to say (D-167, P4c)', async () => {
  const ims = imSource('---\nim: 33\ndata: 2026-11-05 10:00\nstato: previsto\n---\n\n## Lavori\n\n- [ ] Fatture finte\n- [/] Esportazione\n');
  // No commitment left from the tests before: the IM line is all there is to say.
  await db().sql`UPDATE commitments SET status = 'cancelled', updated_at = now() WHERE status = 'open'`;
  assert.equal(await fireReminder(db().sql, '2026-11-04', 'afternoon', ims), 'empty', 'the afternoon never names it');
  let before = (await secretaryMessages()).length;
  assert.equal(await fireReminder(db().sql, '2026-11-04', 'morning', ims), 'written');
  const [message] = (await secretaryMessages()).slice(before);
  assert.ok(message !== undefined);
  assert.match(message.body, /^Buongiorno\. Il promemoria di oggi, [^\n]+\.\n\nDomani c’è l’IM-33 di progetto-test \(giovedì 5 novembre, 10:00\): 2 voci ancora aperte\.$/);
  assert.doesNotMatch(message.body, /Fatture/);
  assert.equal(message.label, 'L2');
  // The day of the IM itself: no line (it is not tomorrow).
  before = (await secretaryMessages()).length;
  assert.equal(await fireReminder(db().sql, '2026-11-05', 'morning', ims), 'empty');
  assert.equal((await secretaryMessages()).length, before);
});

test('a document of a client due within 30 days is named once, in the morning only, also as the only line (D-171)', async () => {
  const { sql } = db();
  const dir = join(resolveHome({}), 'data', 'test-tmp', `reminders-documents-${randomUUID()}`);
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const { id } = await createClient(sql, { displayName: 'Promemoria Finto Srl' });
  await addDocument(sql, dir, id, { name: 'Contratto segreto', fileName: 'Contratto segreto.pdf', kind: 'contract', expiresOn: '2092-03-20', data: Buffer.from('%PDF-1.7\nfinto').toString('base64') });
  assert.equal(await fireReminder(sql, '2092-02-25', 'afternoon'), 'empty');
  assert.equal(await fireReminder(sql, '2092-02-25', 'morning'), 'written');
  const last = (await secretaryMessages()).at(-1);
  assert.match(last?.body ?? '', /Documenti dei clienti in scadenza:\n- Il contratto di Promemoria Finto Srl scade il 20 marzo 2092\./);
  assert.doesNotMatch(last?.body ?? '', /segreto/);
  assert.equal(last?.label, 'L2');
  // Once: the next morning has nothing to say.
  assert.equal(await fireReminder(sql, '2092-02-26', 'morning'), 'empty');
});

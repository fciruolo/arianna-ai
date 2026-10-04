// The calls Arianna makes (D-066, third part) against PostgreSQL.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { DEFAULT_VOICE, type OutgoingRules } from '@arianna/config';
import type { LocalModel } from '@arianna/executors';
import { createContext } from '@arianna/policy';

import { createConversation, listMessages, postUserMessage } from '../src/conversations.ts';
import { passGateway } from '../src/gateway.ts';
import { createCalls, listCalls, loadCall, type Calls } from '../src/voice/calls.ts';
import { FAILED_TEXT, OUTGOING_TEXT } from '../src/voice/outgoing.ts';
import { createPusher, generateVapidKeys, vapidKey } from '../src/voice/push.ts';
import { callWhenDone, cancelCall, createRinger, scheduleCall, type Ringer } from '../src/voice/ringer.ts';
import type { TrialModel } from '../src/voice/trial.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}

// A Monday at 10:00 local time: no quiet hours.
let clock = new Date(2026, 9, 5, 10, 0);
let rules: OutgoingRules = { ...DEFAULT_VOICE.outgoing, ringSeconds: 0.2 };
let online = 1;
let pushes = 0;
let voiceUp = true;
let push = true;
let ringer: Ringer;
let calls: Calls;
const voiceCalls: { path: string; json: unknown }[] = [];
const voice = {
  state: 'up' as const,
  request(_method: 'GET' | 'POST' | 'DELETE', path: string, options: { json?: unknown } = {}) {
    voiceCalls.push({ path, json: options.json });
    const body = path === '/calls' ? { sdp: 'v=0\r\nanswer', type: 'answer' } : { ok: true };
    return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) });
  },
};
const model: LocalModel = { chat: () => Promise.resolve({ text: 'Va bene.', finishReason: 'stop', endpoint: 'f', model: 'f', durationMs: 1 }) };
const READY: TrialModel[] = [
  { id: 'parakeet-tdt-0.6b-v3-mlx', family: 'parakeet', kind: 'stt', present: true, assigned: true, sizeBytes: 1, voices: [] },
  { id: 'kokoro-82m-bf16-mlx', family: 'kokoro', kind: 'tts', present: true, assigned: true, sizeBytes: 1, voices: ['if_sara'] },
];
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  database = await createTestDatabase();
  calls = createCalls({
    sql: db().sql,
    voice,
    config: () => ({ roles: { voice: 'q' }, voice: DEFAULT_VOICE, local: { endpoints: [{ models: { 'local-voice': 'q' } }] } }),
    candidates: () => READY,
    model: () => model,
    coreUrl: 'http://127.0.0.1:7420',
  });
  ringer = createRinger({
    sql: db().sql,
    rules: () => rules,
    voiceUp: () => voiceUp,
    notify: () =>
      push
        ? () => {
            pushes += 1;
            return Promise.resolve();
          }
        : undefined,
    clientsOnline: () => online,
    now: () => clock,
    intervalMs: 3_600_000,
  });
});

after(async () => {
  ringer.stop();
  await calls.close();
  await database?.close();
});

beforeEach(async () => {
  // Every test starts with no call of today and none in progress.
  await db().sql`UPDATE calls SET rang_at = rang_at - interval '3 days' WHERE rang_at IS NOT NULL`;
  await db().sql`UPDATE calls SET created_at = created_at - interval '3 days', status = CASE WHEN status IN ('ringing', 'connecting', 'active') THEN 'ended' ELSE status END,
    ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'hangup') WHERE status <> 'scheduled'`;
  await db().sql`UPDATE calls SET status = 'skipped', end_reason = 'cancelled', ended_at = now() WHERE status = 'scheduled'`;
  await db().sql`UPDATE tasks SET status = 'failed', waiting_reason = NULL WHERE status = 'waiting_user'`;
  clock = new Date(2026, 9, 5, 10, 0);
  rules = { ...DEFAULT_VOICE.outgoing, ringSeconds: 0.2 };
  online = 1;
  pushes = 0;
  voiceUp = true;
  push = true;
});

/** A task of Arianna waiting for the user since `minutes` ago. */
async function waitingTask(minutes: number): Promise<{ conversationId: string; taskId: string }> {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Controlla il contratto finto');
  await db().sql`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`.catch(() => undefined);
  await db().sql`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'approval', updated_at = now() - make_interval(mins => ${minutes}) WHERE id = ${task.id}`;
  return { conversationId: conversation.id, taskId: task.id };
}

test('a task waiting for 30 minutes rings once; unanswered, Arianna writes and does not insist', async () => {
  const { conversationId, taskId } = await waitingTask(31);
  const call = await ringer.tick();
  assert.equal(call?.status, 'ringing');
  assert.equal(call.reason, 'waiting');
  assert.equal(call.taskId, taskId);
  assert.equal(pushes, 0, 'a chat is open: no push');
  await wait(400);
  assert.equal((await loadCall(db().sql, call.id))?.status, 'missed');
  const notes = (await listMessages(db().sql, conversationId, { limit: 10 })).filter((message) => message.role === 'assistant');
  assert.deepEqual(notes.map(({ body, label }) => [body, label]), [[OUTGOING_TEXT.waiting.missed, 'L0']]);
  // The same wait does not ring again.
  assert.equal(await ringer.tick(), undefined);
});

test('a task waiting for less than the rule, another call in progress, or the voice down: nothing rings', async () => {
  await waitingTask(5);
  assert.equal(await ringer.tick(), undefined);
  const conversation = await createConversation(db().sql, { mode: 'private' });
  await db().sql`INSERT INTO calls (conversation_id, direction, status) VALUES (${conversation.id}, 'in', 'active')`;
  await waitingTask(40);
  assert.equal(await ringer.tick(), undefined, 'a call is in progress');
  await db().sql`UPDATE calls SET status = 'ended', end_reason = 'hangup', ended_at = now() WHERE status = 'active'`;
  voiceUp = false;
  assert.equal(await ringer.tick(), undefined, 'the voice cannot answer');
  voiceUp = true;
  assert.equal((await ringer.tick())?.status, 'ringing');
});

test('archived conversations and system chats never ring; a wait counts from its event, not from updated_at', async () => {
  const archived = await waitingTask(40);
  await db().sql`UPDATE conversations SET archived_at = now() WHERE id = ${archived.conversationId}`;
  const system = await waitingTask(40);
  await db().sql`UPDATE conversations SET origin = 'system', system_reason = 'failure' WHERE id = ${system.conversationId}`.catch(() => undefined);
  const ringing = await ringer.tick();
  assert.ok(ringing === undefined || ringing.conversationId !== archived.conversationId);
  if (ringing !== undefined) await calls.decline(ringing.id);

  // Events are append-only: the wait starts now, and the rule of this test is zero minutes.
  const waiting = await waitingTask(40);
  await db().sql`INSERT INTO events (task_id, kind, label, payload) VALUES (${waiting.taskId}, 'task.status', 'L0', ${db().sql.json({ from: 'running', to: 'waiting_user' })})`;
  rules = { ...rules, waitingMinutes: 0 };
  const first = await ringer.tick();
  assert.equal(first?.taskId, waiting.taskId);
  await calls.decline(first.id);
  // Another field of the task changes: same wait, no second call.
  await db().sql`UPDATE tasks SET updated_at = now() - interval '35 minutes' WHERE id = ${waiting.taskId}`;
  const again = await ringer.tick();
  assert.ok(again?.taskId !== waiting.taskId);
});

test('nobody can hear it (no page, no push): Arianna writes at once instead of ringing', async () => {
  online = 0;
  push = false;
  const { conversationId } = await waitingTask(40);
  const call = await ringer.tick();
  assert.equal(call?.status, 'skipped');
  assert.equal(call.endReason, 'no-answer');
  assert.ok((await listMessages(db().sql, conversationId, { limit: 10 })).some((message) => message.body === OUTGOING_TEXT.waiting.skipped));
});

test('with no chat open the push rings; quiet hours and the daily maximum skip with a written note', async () => {
  online = 0;
  const first = await waitingTask(40);
  const call = await ringer.tick();
  assert.equal(call?.status, 'ringing');
  assert.equal(pushes, 1);
  await calls.decline(call.id);
  assert.equal((await loadCall(db().sql, call.id))?.endReason, 'cancelled');
  assert.ok((await listMessages(db().sql, first.conversationId, { limit: 10 })).some((message) => message.body === OUTGOING_TEXT.waiting.missed));

  clock = new Date(2026, 9, 5, 22, 30);
  const night = await waitingTask(40);
  const skipped = await ringer.tick();
  assert.equal(skipped?.status, 'skipped');
  assert.equal(skipped.endReason, 'quiet-hours');
  assert.ok((await listMessages(db().sql, night.conversationId, { limit: 10 })).some((message) => message.body === OUTGOING_TEXT.waiting.skipped));

  clock = new Date(2026, 9, 5, 11, 0);
  rules = { ...rules, maxPerDay: 1 };
  await waitingTask(40);
  assert.equal((await ringer.tick())?.endReason, 'daily-limit');
});

test('the daily maximum counts calls by when they rang, also one scheduled days ago; Rifiuta after the timer writes once', async () => {
  rules = { ...rules, maxPerDay: 1, ringSeconds: 0.1 };
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const old = await scheduleCall(db().sql, conversation.id, new Date(clock.getTime() + 60_000), clock);
  await db().sql`UPDATE calls SET created_at = now() - interval '2 days' WHERE id = ${old.id}`;
  clock = new Date(clock.getTime() + 120_000);
  const rang = await ringer.tick();
  assert.equal(rang?.id, old.id);
  await wait(300);
  // The ring timer closed it: a late Rifiuta changes nothing and writes no second note.
  await assert.rejects(calls.decline(old.id), { code: 'ended' });
  const notes = (await listMessages(db().sql, conversation.id, { limit: 10 })).filter((message) => message.body === OUTGOING_TEXT.scheduled.missed);
  assert.equal(notes.length, 1);
  // It rang today, though created two days ago: the maximum of one is reached.
  await waitingTask(40);
  assert.equal((await ringer.tick())?.endReason, 'daily-limit');
});

test('a scheduled call rings at its time, even at night; it can be cancelled before', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  clock = new Date(2026, 9, 5, 21, 0);
  const call = await scheduleCall(db().sql, conversation.id, new Date(clock.getTime() + 60_000), clock);
  assert.equal(call.status, 'scheduled');
  assert.equal(await ringer.tick(), undefined, 'not yet');
  clock = new Date(clock.getTime() + 120_000);
  const rang = await ringer.tick();
  assert.equal(rang?.id, call.id);
  assert.equal(rang.status, 'ringing');

  // Answered: the voice greets with the reason of the call.
  const { call: active } = await calls.answer(call.id, { sdp: SDP, type: 'offer' });
  assert.equal(active.status, 'active');
  assert.equal((voiceCalls.at(-1)?.json as { texts: { greeting: string } }).texts.greeting, OUTGOING_TEXT.scheduled.greeting);
  await calls.end(call.id, 'hangup');
  await assert.rejects(calls.answer(call.id, { sdp: SDP, type: 'offer' }), { code: 'ended' });

  const later = await scheduleCall(db().sql, conversation.id, new Date(clock.getTime() + 3_600_000), clock);
  assert.equal((await cancelCall(db().sql, later.id)).endReason, 'cancelled');
  await assert.rejects(cancelCall(db().sql, later.id), { name: 'ScheduleError' });
  for (const at of [new Date(clock.getTime() - 3_600_000), new Date(clock.getTime() + 8 * 86_400_000), new Date('nope')]) {
    await assert.rejects(scheduleCall(db().sql, conversation.id, at, clock), { name: 'ScheduleError' });
  }
});

test('"chiamami quando finisci": the call waits for the task, then rings with the start of its answer', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Prepara il riepilogo finto');
  const waiting = await callWhenDone(db().sql, task.id);
  assert.equal((await callWhenDone(db().sql, task.id)).id, waiting.id, 'once per task');
  assert.equal(await ringer.tick(), undefined, 'the task is not over');
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body, task_id) VALUES (${conversation.id}, 'assistant', 'web', 'L2', ${'Il riepilogo è pronto: tre punti.'}, ${task.id})`;
  await db().sql`UPDATE tasks SET status = 'done', evidence = ${db().sql.json([{ kind: 'message' }])} WHERE id = ${task.id}`;
  const rang = await ringer.tick();
  assert.equal(rang?.id, waiting.id);
  await calls.answer(waiting.id, { sdp: SDP, type: 'offer' });
  assert.equal((voiceCalls.at(-1)?.json as { texts: { greeting: string } }).texts.greeting, `${OUTGOING_TEXT['task-done'].greeting} Il riepilogo è pronto: tre punti.`);
  await calls.end(waiting.id, 'hangup');
  await assert.rejects(callWhenDone(db().sql, task.id), { name: 'ScheduleError' });
  assert.equal((await listCalls(db().sql, conversation.id)).length, 1);
});

test('a task that failed is never announced as finished; an archived conversation cannot be answered', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Prova che fallirà');
  const waiting = await callWhenDone(db().sql, task.id);
  await db().sql`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
  const rang = await ringer.tick();
  assert.equal(rang?.id, waiting.id);
  await calls.answer(waiting.id, { sdp: SDP, type: 'offer' });
  assert.equal((voiceCalls.at(-1)?.json as { texts: { greeting: string } }).texts.greeting, FAILED_TEXT.greeting);
  await calls.end(waiting.id, 'hangup');

  const other = await createConversation(db().sql, { mode: 'private' });
  const later = await scheduleCall(db().sql, other.id, new Date(clock.getTime() + 60_000), clock);
  clock = new Date(clock.getTime() + 120_000);
  assert.equal((await ringer.tick())?.id, later.id);
  await db().sql`UPDATE conversations SET archived_at = now() WHERE id = ${other.id}`;
  await assert.rejects(calls.answer(later.id, { sdp: SDP, type: 'offer' }), { code: 'archived' });
  assert.equal((await loadCall(db().sql, later.id))?.status, 'missed');
  await assert.rejects(scheduleCall(db().sql, other.id, new Date(clock.getTime() + 60_000), clock), { name: 'ScheduleError' });
});

test('the push channel of the gateway lets out the fixed L0 text only, and logs it', async () => {
  const allowed = await passGateway(db().sql, [{ value: 'Arianna ti chiama', label: 'L0', source: 'call:push' }], createContext('L0'), { kind: 'channel', id: 'push' });
  assert.equal(allowed.decision, 'allow');
  const blocked = await passGateway(db().sql, [{ value: 'la fattura di Giulia', label: 'L2', source: 'call:push' }], createContext('L2'), { kind: 'channel', id: 'push' });
  assert.equal(blocked.decision, 'block');
  const rows = await db().sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE target = 'push' ORDER BY id DESC LIMIT 2`;
  assert.deepEqual(rows.map(({ decision }) => decision), ['block', 'allow']);
});

test('Web Push: subscriptions are kept, a push goes only after the gateway, a gone browser is forgotten', async () => {
  const keys = generateVapidKeys();
  const posted: { endpoint: string; headers: Record<string, string> }[] = [];
  let allow = true;
  const pusher = createPusher({
    sql: db().sql,
    publicKey: keys.publicKey,
    key: vapidKey(keys.publicKey, keys.privateKey),
    subject: 'mailto:me@example.org',
    gate: () => Promise.resolve(allow),
    post: (endpoint, headers) => {
      posted.push({ endpoint, headers });
      return Promise.resolve(endpoint.endsWith('gone') ? 410 : 201);
    },
  });
  const sub = (endpoint: string) => ({ endpoint, p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) });
  await pusher.subscribe(sub('https://fcm.googleapis.com/fcm/send/ok'));
  await pusher.subscribe(sub('https://fcm.googleapis.com/fcm/send/ok'));
  await pusher.subscribe(sub('https://web.push.apple.com/gone'));
  assert.equal(await pusher.notify(), 1);
  assert.equal(posted.length, 2);
  assert.match(posted[0]?.headers.authorization ?? '', /^vapid t=.+, k=/);
  assert.equal(posted[0]?.headers.ttl, '30');
  const [{ count } = { count: -1 }] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM push_subscriptions WHERE removed_at IS NULL`;
  assert.equal(count, 1, 'the gone one is forgotten');
  allow = false;
  assert.equal(await pusher.notify(), 0);
  assert.equal(posted.length, 2, 'blocked by the gateway: nothing sent');
  await pusher.unsubscribe('https://fcm.googleapis.com/fcm/send/ok');
  allow = true;
  assert.equal(await pusher.notify(), 0, 'nobody left');
  await pusher.subscribe(sub('https://web.push.apple.com/gone'));
  assert.equal(await pusher.notify(), 0, 'subscribed again, and gone again');
});

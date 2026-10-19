// Routines with a call (D-110 tappa B, D-259) against PostgreSQL: the run of a
// routine with the channel `call` queues a call of reason `routine`; the
// ringer rings it under [voice.outgoing] (the first ring skips quiet hours,
// the second ring and a late one keep them); unanswered, a note and, if the
// routine asks, one second ring; a call that waited too long is skipped with a
// note. Answered: the counts first, the titles only after a «sì», up to the
// routine's label, and the model of the call never reads the reports before
// it. Fake data and a fake voice only: no model, no audio.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { DEFAULT_VOICE, parseLabelRules, resolveHome, type OutgoingRules } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { listMessages } from '../src/conversations.ts';
import { createRoutine, routineCallScript, runDue, runNow, updateRoutine, type RoutineEnv, type RoutineInput, type RoutineSource } from '../src/routines.ts';
import { splitRoutine } from '../src/routine-split.ts';
import { createTask } from '../src/tasks.ts';
import { createCalls, loadCall, type Call, type Calls } from '../src/voice/calls.ts';
import { OUTGOING_TEXT, ROUTINE_NOTE_TEXT } from '../src/voice/outgoing.ts';
import { createRinger, ROUTINE_CALL_WAIT_MS, type Ringer } from '../src/voice/ringer.ts';
import { ROUTINE_CALL_TEXT } from '../src/voice/routine-call.ts';
import type { TrialModel } from '../src/voice/trial.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
const RULES = parseLabelRules('');
const scratch = join(resolveHome({}), 'data', 'test-tmp', `routine-call-${randomUUID()}`);
mkdirSync(join(scratch, 'kb'), { recursive: true });

const MINUTE = 60_000;
// A Monday at 10:00 local time: no quiet hours. Many calls ring in this file: no daily maximum in the way.
let clock = new Date(2026, 9, 5, 10, 0);
const rules: OutgoingRules = { ...DEFAULT_VOICE.outgoing, ringSeconds: 0.2, maxPerDay: 1000 };
let voiceUp = true;
let online = 1;
let ringer: Ringer;
let calls: Calls;
/** The same calls, with a script of the routine that fails: the call must still read nothing of the chat. */
let brokenCalls: Calls;
const voiceCalls: { path: string; json: unknown }[] = [];
const voice = {
  state: 'up' as const,
  request(_method: 'GET' | 'POST' | 'DELETE', path: string, options: { json?: unknown } = {}) {
    voiceCalls.push({ path, json: options.json });
    const body = path === '/calls' ? { sdp: 'v=0\r\nanswer', type: 'answer' } : { ok: true };
    return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) });
  },
};
const asked: ChatRequest[] = [];
const model: LocalModel = {
  chat: (request) => {
    asked.push(request);
    return Promise.resolve({ text: 'Va bene.', finishReason: 'stop', endpoint: 'f', model: 'f', durationMs: 1 });
  },
};
const READY: TrialModel[] = [
  { id: 'parakeet-tdt-0.6b-v3-mlx', family: 'parakeet', kind: 'stt', present: true, assigned: true, sizeBytes: 1, voices: [] },
  { id: 'kokoro-82m-bf16-mlx', family: 'kokoro', kind: 'tts', present: true, assigned: true, sizeBytes: 1, voices: ['if_sara'] },
];
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 250; tries += 1) {
    if (await check()) return;
    await wait(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function env(): RoutineEnv {
  return { sql: db().sql, home: scratch, rules: RULES };
}

before(async () => {
  database = await createTestDatabase();
  calls = createCalls({
    sql: db().sql,
    voice,
    config: () => ({ roles: { voice: 'q' }, voice: DEFAULT_VOICE, local: { endpoints: [{ models: { 'local-voice': 'q' } }] } }),
    candidates: () => READY,
    model: () => model,
    coreUrl: 'http://127.0.0.1:7420',
    routineScript: (callId) => routineCallScript(env(), callId),
    routineHangupMs: 200,
  });
  brokenCalls = createCalls({
    sql: db().sql,
    voice,
    config: () => ({ roles: { voice: 'q' }, voice: DEFAULT_VOICE, local: { endpoints: [{ models: { 'local-voice': 'q' } }] } }),
    candidates: () => READY,
    model: () => model,
    coreUrl: 'http://127.0.0.1:7420',
    routineScript: () => Promise.reject(new Error('the sources cannot be read')),
  });
  ringer = createRinger({ sql: db().sql, rules: () => rules, voiceUp: () => voiceUp, notify: () => undefined, clientsOnline: () => online, now: () => clock, intervalMs: 3_600_000 });
});
after(async () => {
  ringer.stop();
  await calls.close();
  await brokenCalls.close();
  await database?.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A routine every day in UTC whose time was `minutesAgo` minutes ago, with that run still to do. */
async function dueRoutine(minutesAgo: number, sources: RoutineSource[], extra: Partial<RoutineInput> = {}): Promise<{ id: string; conversationId: string }> {
  const at = new Date(Math.floor((Date.now() - minutesAgo * MINUTE) / MINUTE) * MINUTE);
  const clockText = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  const routine = await createRoutine(db().sql, { title: 'Mattina finta', days: [1, 2, 3, 4, 5, 6, 7], at: clockText, timezone: 'UTC', sources, summary: false, channel: 'call', ...extra });
  await db().sql`UPDATE routines SET next_run_at = ${at} WHERE id = ${routine.id}`;
  return { id: routine.id, conversationId: routine.conversationId };
}

async function callsOf(conversationId: string): Promise<Call[]> {
  const rows = await db().sql<{ id: string }[]>`SELECT id::text FROM calls WHERE conversation_id = ${conversationId} ORDER BY created_at, id`;
  const found: Call[] = [];
  for (const row of rows) {
    const call = await loadCall(db().sql, row.id);
    if (call !== undefined) found.push(call);
  }
  return found;
}

async function bodies(conversationId: string): Promise<string[]> {
  return (await listMessages(db().sql, conversationId, { limit: 50 })).map((message) => message.body);
}

/** No call of an earlier test left to ring: each test starts with the ringer idle. */
async function settle(): Promise<void> {
  await db().sql`UPDATE calls SET status = 'skipped', end_reason = 'cancelled', ended_at = now() WHERE status = 'scheduled'`;
  await db().sql`UPDATE calls SET status = 'ended', end_reason = 'hangup', ended_at = now() WHERE status IN ('ringing', 'connecting', 'active')`;
  clock = new Date(2026, 9, 5, 10, 0);
  voiceUp = true;
  online = 1;
}

test('a run of a routine with the call queues one call of reason routine; the chat, a trial and a missed run do not', async () => {
  await settle();
  const routine = await dueRoutine(1, ['todo']);
  const outcome = await runDue(env(), routine.id);
  assert.equal(outcome.kind, 'done');
  const [call] = await callsOf(routine.conversationId);
  assert.ok(call !== undefined);
  assert.equal(call.reason, 'routine');
  assert.equal(call.status, 'scheduled');
  assert.equal(call.routineAttempt, 1);
  assert.equal(outcome.callId, call.id);
  const [run] = await db().sql<{ id: string }[]>`SELECT id::text FROM routine_runs WHERE routine_id = ${routine.id}`;
  assert.equal(call.routineRunId, run?.id);
  // The event names ids and codes only, never the title.
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'call.scheduled' AND payload ->> 'callId' = ${call.id}`;
  assert.equal(event?.payload.reason, 'routine');
  assert.ok(!JSON.stringify(event.payload).includes('Mattina finta'));

  const chat = await dueRoutine(1, ['todo'], { channel: 'chat' });
  await runDue(env(), chat.id);
  assert.equal((await callsOf(chat.conversationId)).length, 0);
  const trial = await createRoutine(db().sql, { title: 'Prova finta', days: [1], at: '07:00', timezone: 'UTC', sources: ['todo'], channel: 'call' });
  await runNow(env(), trial.id);
  assert.equal((await callsOf(trial.conversationId)).length, 0);
  const missed = await dueRoutine(180, ['todo']);
  assert.equal((await runDue(env(), missed.id)).kind, 'missed');
  assert.equal((await callsOf(missed.conversationId)).length, 0);
  await settle();
});

test('the first ring skips quiet hours and the weekend; a late one keeps the quiet hours and writes why', async () => {
  await settle();
  // Saturday at 23:00: quiet hours and weekend, the routine rings all the same (its days are the user's).
  clock = new Date(2026, 9, 3, 23, 0);
  const onTime = await dueRoutine(1, ['todo']);
  await runDue(env(), onTime.id);
  const rang = await ringer.tick();
  assert.equal(rang?.status, 'ringing');
  assert.equal(rang.reason, 'routine');
  await until('the ring to end', async () => (await loadCall(db().sql, rang.id))?.status === 'missed');
  await settle();

  clock = new Date(2026, 9, 5, 22, 0);
  const late = await dueRoutine(40, ['todo']);
  await runDue(env(), late.id);
  const skipped = await ringer.tick();
  assert.equal(skipped?.status, 'skipped');
  assert.equal(skipped.endReason, 'quiet-hours');
  assert.ok((await bodies(late.conversationId)).includes(ROUTINE_NOTE_TEXT.quiet));
  // Outside the quiet hours the late one rings, and its greeting says sorry.
  clock = new Date(2026, 9, 5, 10, 0);
  const lateDay = await dueRoutine(40, ['todo']);
  await runDue(env(), lateDay.id);
  const ringing = await ringer.tick();
  assert.equal(ringing?.status, 'ringing');
  const script = await routineCallScript(env(), ringing.id);
  assert.match(script?.greeting.text ?? '', /Scusa il ritardo: la routine era per le /);
  await settle();
});

test('unanswered: a note; with retry_minutes one second ring, which keeps the quiet hours, and never a third', async () => {
  await settle();
  const once = await dueRoutine(1, ['todo']);
  await runDue(env(), once.id);
  const first = await ringer.tick();
  assert.ok(first !== undefined);
  await until('the note', async () => (await bodies(once.conversationId)).includes(OUTGOING_TEXT.routine.missed));
  assert.equal((await callsOf(once.conversationId)).length, 1);

  const twice = await dueRoutine(1, ['todo'], { retryMinutes: 15 });
  await runDue(env(), twice.id);
  const ring = await ringer.tick();
  assert.ok(ring !== undefined);
  await until('the note of the retry', async () => (await bodies(twice.conversationId)).includes(ROUTINE_NOTE_TEXT.retry(15)));
  const [, retry] = await callsOf(twice.conversationId);
  assert.ok(retry !== undefined);
  assert.equal(retry.status, 'scheduled');
  assert.equal(retry.routineAttempt, 2);
  assert.equal(retry.routineRunId, ring.routineRunId);
  const delay = (retry.scheduledAt?.getTime() ?? 0) - Date.now();
  assert.ok(delay > 14 * MINUTE && delay <= 15 * MINUTE, String(delay));
  // Not yet due: nothing rings.
  assert.equal(await ringer.tick(), undefined);
  // Due now, missed again: one note, no third ring.
  await db().sql`UPDATE calls SET scheduled_at = now() WHERE id = ${retry.id}`;
  const second = await ringer.tick();
  assert.equal(second?.id, retry.id);
  await until('the note of the second ring', async () => (await bodies(twice.conversationId)).includes(ROUTINE_NOTE_TEXT.retryMissed));
  assert.equal((await callsOf(twice.conversationId)).length, 2);
  // A second ring in the quiet hours does not ring: only the note.
  const quiet = await dueRoutine(1, ['todo'], { retryMinutes: 10 });
  await runDue(env(), quiet.id);
  const quietFirst = await ringer.tick();
  assert.ok(quietFirst !== undefined);
  await until('the retry', async () => (await callsOf(quiet.conversationId)).length === 2);
  await db().sql`UPDATE calls SET scheduled_at = now() WHERE conversation_id = ${quiet.conversationId} AND status = 'scheduled'`;
  clock = new Date(2026, 9, 5, 22, 0);
  const quietSecond = await ringer.tick();
  assert.equal(quietSecond?.endReason, 'quiet-hours');
  assert.ok((await bodies(quiet.conversationId)).includes(ROUTINE_NOTE_TEXT.quiet));
  await settle();
});

test('declined with «Rifiuta»: the note, and no second ring', async () => {
  await settle();
  const routine = await dueRoutine(1, ['todo'], { retryMinutes: 15 });
  await runDue(env(), routine.id);
  const ring = await ringer.tick();
  assert.ok(ring !== undefined);
  await calls.decline(ring.id);
  assert.ok((await bodies(routine.conversationId)).includes(ROUTINE_NOTE_TEXT.declined));
  assert.ok(!(await bodies(routine.conversationId)).includes(OUTGOING_TEXT.routine.missed));
  await wait(400);
  assert.equal((await callsOf(routine.conversationId)).length, 1);
  await settle();
});

test('a call that waited too long (the voice not ready) is skipped with a note; one of a paused routine is cancelled without', async () => {
  await settle();
  voiceUp = false;
  const routine = await dueRoutine(1, ['todo']);
  await runDue(env(), routine.id);
  assert.equal(await ringer.tick(), undefined);
  const [waiting] = await callsOf(routine.conversationId);
  assert.equal(waiting?.status, 'scheduled');
  await db().sql`UPDATE calls SET scheduled_at = now() - make_interval(secs => ${ROUTINE_CALL_WAIT_MS / 1000 + 60}) WHERE id = ${waiting.id}`;
  await ringer.tick();
  const expired = await loadCall(db().sql, waiting.id);
  assert.equal(expired?.status, 'skipped');
  assert.equal(expired.endReason, 'expired');
  assert.ok((await bodies(routine.conversationId)).includes(ROUTINE_NOTE_TEXT.expired));

  voiceUp = true;
  const paused = await dueRoutine(1, ['todo']);
  await runDue(env(), paused.id);
  await db().sql`UPDATE routines SET status = 'paused', paused_by = 'user', next_run_at = NULL WHERE id = ${paused.id}`;
  assert.equal(await ringer.tick(), undefined);
  const [cancelled] = await callsOf(paused.conversationId);
  assert.equal(cancelled?.status, 'skipped');
  assert.equal(cancelled.endReason, 'cancelled');
  assert.ok(!(await bodies(paused.conversationId)).includes(ROUTINE_NOTE_TEXT.expired));
  await settle();
});

/** Rings the routine's call and answers it: the greeting the voice was given and the token of the call. */
async function answered(conversationId: string, through: Calls = calls): Promise<{ call: Call; greeting: string; token: string }> {
  const ring = await ringer.tick();
  assert.ok(ring !== undefined && ring.conversationId === conversationId);
  voiceCalls.length = 0;
  const { call } = await through.answer(ring.id, { sdp: SDP, type: 'offer' });
  const opened = voiceCalls.find((item) => item.path === '/calls')?.json as { token: string; texts: { greeting: string } };
  return { call, greeting: opened.texts.greeting, token: opened.token };
}

test('answered: the counts first, the titles only after the «sì», up to the label of the routine', async () => {
  await settle();
  await createTask(db().sql, { title: 'Bolletta interna finta', assignee: 'user', status: 'inbox', label: 'L1' });
  await createTask(db().sql, { title: 'Visita privata finta', assignee: 'user', status: 'inbox', label: 'L2' });
  await createTask(db().sql, { title: 'Contratto segreto finto', assignee: 'user', status: 'inbox', label: 'L3' });
  const routine = await dueRoutine(1, ['todo'], { voiceMaxLabel: 'L1' });
  await runDue(env(), routine.id);
  const { call, greeting, token } = await answered(routine.conversationId);
  assert.match(greeting, /sono Arianna\. È l’ora della tua routine\. Hai \d+ cose da fare\. Vuoi che ti legga i titoli\? Rispondimi: sì grazie, oppure no grazie\.$/);
  for (const title of ['Bolletta', 'Visita', 'Contratto']) assert.ok(!greeting.includes(title), title);
  // The greeting said is in the chat of the routine too, as a message of the call (the captions come from there).
  const greeted = (await listMessages(db().sql, routine.conversationId, { limit: 50 })).filter((message) => message.channel === 'voice');
  assert.deepEqual(greeted.map((message) => [message.role, message.body, message.label]), [['assistant', greeting, 'L2']]);

  // An unclear answer asks again; then «sì» reads the titles up to Interno, the others counted.
  assert.equal((await calls.turn(call.id, token, 'come stai')).say, ROUTINE_CALL_TEXT.again);
  const yes = await calls.turn(call.id, token, 'Sì, grazie');
  assert.match(yes.say, /Bolletta interna finta/);
  assert.ok(!yes.say.includes('Visita privata finta'));
  assert.ok(!yes.say.includes('Contratto segreto finto'));
  assert.match(yes.say, /riservat/);
  // What was said is in the chat of the routine, as messages of the call.
  const said = await listMessages(db().sql, routine.conversationId, { limit: 50 });
  assert.ok(said.some((message) => message.channel === 'voice' && message.role === 'user' && message.body === 'Sì, grazie'));
  assert.ok(said.some((message) => message.channel === 'voice' && message.role === 'assistant' && message.body.includes('Bolletta interna finta')));
  await calls.end(call.id, 'hangup');
  await settle();
});

test('a lone «sì» as Parakeet writes it («See ya.») reads the titles at once, and both stay in the chat', async () => {
  await settle();
  await createTask(db().sql, { title: 'Lettera pubblica finta', assignee: 'user', status: 'inbox', label: 'L0' });
  const routine = await dueRoutine(1, ['todo']);
  await runDue(env(), routine.id);
  const { call, token } = await answered(routine.conversationId);
  const yes = await calls.turn(call.id, token, 'See ya.');
  assert.match(yes.say, /Lettera pubblica finta/);
  const said = (await listMessages(db().sql, routine.conversationId, { limit: 50 })).filter((message) => message.channel === 'voice');
  assert.deepEqual(
    said.map((message) => message.role),
    ['assistant', 'user', 'assistant'],
  );
  assert.equal(said[1]?.body, 'See ya.');
  await calls.end(call.id, 'hangup');
  await settle();
});

test('«no»: nothing read, «Trovi tutto in chat», and the call hangs up (D-110 f)', async () => {
  await settle();
  asked.length = 0;
  await createTask(db().sql, { title: 'Spesa nascosta finta', assignee: 'user', status: 'inbox', label: 'L0' });
  const routine = await dueRoutine(1, ['todo']);
  await runDue(env(), routine.id);
  const { call, token } = await answered(routine.conversationId);
  voiceCalls.length = 0;
  const no = await calls.turn(call.id, token, 'no grazie');
  assert.equal(no.say, ROUTINE_CALL_TEXT.no);
  // The «no» is answered by code: no turn of the model (the warm-up asks one token at most), nothing of the report.
  assert.ok(asked.every((request) => request.maxTokens === 1));
  for (const read of asked) assert.ok(!JSON.stringify(read.messages).includes('Spesa nascosta finta'));
  // Then the core hangs up, once the voice had time to say it.
  await until('the hang-up', async () => (await loadCall(db().sql, call.id))?.status === 'ended');
  const ended = await loadCall(db().sql, call.id);
  assert.equal(ended?.endReason, 'hangup');
  assert.ok(voiceCalls.some((item) => item.path === `/calls/${call.id}`));
  asked.length = 0;
  await settle();
});

test('a routine\'s call ringing when the core restarts: missed, with the note, never a second ring', async () => {
  await settle();
  const routine = await dueRoutine(1, ['todo'], { retryMinutes: 15 });
  await runDue(env(), routine.id);
  const ring = await ringer.tick();
  assert.equal(ring?.status, 'ringing');
  await calls.closeLeftovers();
  const closed = await loadCall(db().sql, ring.id);
  assert.deepEqual([closed?.status, closed?.endReason], ['missed', 'core-restart']);
  assert.ok((await bodies(routine.conversationId)).includes(OUTGOING_TEXT.routine.missed));
  await wait(400);
  assert.equal((await callsOf(routine.conversationId)).length, 1);
  await settle();
});

/** A message written in the routine's chat, as an earlier call or a summary would leave it. */
async function written(conversationId: string, channel: 'voice' | 'web', body: string): Promise<void> {
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body) VALUES (${conversationId}, 'assistant', ${channel}, 'L2', ${body})`;
}

test('the model reads only this call: never an earlier call, a summary written meanwhile, nor titles above the ceiling after the «sì»', async () => {
  await settle();
  asked.length = 0;
  await createTask(db().sql, { title: 'Pane pubblico finto', assignee: 'user', status: 'inbox', label: 'L0' });
  await createTask(db().sql, { title: 'Visita riservata finta', assignee: 'user', status: 'inbox', label: 'L2' });
  const routine = await dueRoutine(1, ['todo'], { voiceMaxLabel: 'L0' });
  await runDue(env(), routine.id);
  await written(routine.conversationId, 'voice', 'Ieri ti ho letto: Visita riservata finta.');
  const { call, token } = await answered(routine.conversationId);
  // The unclear answer and the question again stay in the chat.
  assert.equal((await calls.turn(call.id, token, 'aspetta un attimo che prendo la penna')).say, ROUTINE_CALL_TEXT.again);
  assert.ok((await bodies(routine.conversationId)).includes('aspetta un attimo che prendo la penna'));
  assert.ok((await bodies(routine.conversationId)).includes(ROUTINE_CALL_TEXT.again));
  const yes = await calls.turn(call.id, token, 'sì');
  assert.match(yes.say, /Pane pubblico finto/);
  assert.ok(!yes.say.includes('Visita riservata finta'));
  // A summary written during the call, with the private title.
  await written(routine.conversationId, 'web', 'Sintesi finta: la Visita riservata finta scade.');
  await calls.turn(call.id, token, 'quali sono quelle riservate?');
  assert.ok(asked.some((request) => request.maxTokens !== 1));
  for (const read of asked) {
    const text = JSON.stringify(read.messages);
    assert.ok(!text.includes('Visita riservata finta'), 'the model read a private title');
    assert.ok(!text.includes('Resoconto di'));
  }
  // What the code said after the «sì» is in what the model reads: only the public title; and the greeting with its question.
  assert.ok(asked.some((request) => JSON.stringify(request.messages).includes('Pane pubblico finto')));
  assert.ok(asked.some((request) => JSON.stringify(request.messages).includes('Vuoi che ti legga i titoli?')));
  await calls.end(call.id, 'hangup');
  asked.length = 0;
  await settle();
});

test('the sources cannot be read when answering: the fixed greeting, no question, and still nothing of the chat to the model', async () => {
  await settle();
  asked.length = 0;
  await createTask(db().sql, { title: 'Bolletta nascosta finta', assignee: 'user', status: 'inbox', label: 'L0' });
  const routine = await dueRoutine(1, ['todo']);
  await runDue(env(), routine.id);
  const { call, greeting, token } = await answered(routine.conversationId, brokenCalls);
  assert.equal(greeting, OUTGOING_TEXT.routine.greeting);
  await brokenCalls.turn(call.id, token, 'sì');
  assert.ok(asked.some((request) => request.maxTokens !== 1));
  for (const read of asked) assert.ok(!JSON.stringify(read.messages).includes('Bolletta nascosta finta'));
  await brokenCalls.end(call.id, 'hangup');
  asked.length = 0;
  await settle();
});

test('a call in the queue of a routine moved to «In chat», or a second ring no longer asked, is cancelled', async () => {
  await settle();
  voiceUp = false;
  const moved = await dueRoutine(1, ['todo']);
  await runDue(env(), moved.id);
  await updateRoutine(db().sql, moved.id, { channel: 'chat' });
  voiceUp = true;
  assert.equal(await ringer.tick(), undefined);
  const [cancelled] = await callsOf(moved.conversationId);
  assert.deepEqual([cancelled?.status, cancelled?.endReason], ['skipped', 'cancelled']);

  const retry = await dueRoutine(1, ['todo'], { retryMinutes: 15 });
  await runDue(env(), retry.id);
  const ring = await ringer.tick();
  assert.ok(ring !== undefined);
  await until('the retry', async () => (await callsOf(retry.conversationId)).length === 2);
  await updateRoutine(db().sql, retry.id, { retryMinutes: null });
  await db().sql`UPDATE calls SET scheduled_at = now() WHERE conversation_id = ${retry.conversationId} AND status = 'scheduled'`;
  assert.equal(await ringer.tick(), undefined);
  const [, second] = await callsOf(retry.conversationId);
  assert.deepEqual([second?.status, second?.endReason], ['skipped', 'cancelled']);
  await settle();
});

test('nobody to hear it ring (no page, no push): missed at once, with the second ring the routine asks for', async () => {
  await settle();
  online = 0;
  const routine = await dueRoutine(1, ['todo'], { retryMinutes: 10 });
  await runDue(env(), routine.id);
  const skipped = await ringer.tick();
  assert.equal(skipped?.endReason, 'no-answer');
  assert.ok((await bodies(routine.conversationId)).includes(ROUTINE_NOTE_TEXT.retry(10)));
  const [, retry] = await callsOf(routine.conversationId);
  assert.deepEqual([retry?.status, retry?.routineAttempt], ['scheduled', 2]);
  await settle();
});

test('the database keeps the channel, the ceiling of the voice and the second ring within their rules', async () => {
  const routine = await createRoutine(db().sql, { title: 'Vincoli finti', days: [1], at: '07:00', timezone: 'UTC', sources: ['todo'] });
  assert.equal(routine.channel, 'chat');
  assert.equal(routine.voiceMaxLabel, 'L2');
  assert.equal(routine.retryMinutes, null);
  await assert.rejects(db().sql`UPDATE routines SET voice_max_label = 'L3' WHERE id = ${routine.id}`);
  await assert.rejects(db().sql`UPDATE routines SET retry_minutes = 4 WHERE id = ${routine.id}`);
  await assert.rejects(db().sql`UPDATE routines SET channel = 'telegram' WHERE id = ${routine.id}`);
  const changed = await updateRoutine(db().sql, routine.id, { channel: 'call', voiceMaxLabel: 'L0', retryMinutes: 30 });
  assert.deepEqual([changed.channel, changed.voiceMaxLabel, changed.retryMinutes], ['call', 'L0', 30]);
  assert.equal((await updateRoutine(db().sql, routine.id, { retryMinutes: null })).retryMinutes, null);
  // A call of reason routine names its run; no other call does, a call of the user (no reason) neither.
  await assert.rejects(db().sql`INSERT INTO calls (conversation_id, direction, reason, status, scheduled_at) VALUES (${routine.conversationId}, 'out', 'routine', 'scheduled', now())`);
  const [anyRun] = await db().sql<{ id: string }[]>`SELECT id::text FROM routine_runs LIMIT 1`;
  assert.ok(anyRun !== undefined);
  await assert.rejects(
    db().sql`INSERT INTO calls (conversation_id, direction, status, routine_run_id, routine_attempt) VALUES (${routine.conversationId}, 'in', 'connecting', ${anyRun.id}, 1)`,
    /calls_routine_fields/,
  );
  await assert.rejects(
    db().sql`INSERT INTO calls (conversation_id, direction, reason, status, scheduled_at, routine_run_id, routine_attempt) VALUES (${routine.conversationId}, 'out', 'scheduled', 'scheduled', now(), ${anyRun.id}, 1)`,
    /calls_routine_fields/,
  );
  // «Solo <giorno>» of the calendar (D-257): the new routine calls as the first one did.
  const twoDays = await createRoutine(db().sql, { title: 'Due giorni finti', days: [1, 3], at: '07:00', timezone: 'UTC', sources: ['todo'], channel: 'call', voiceMaxLabel: 'L1', retryMinutes: 10 });
  const { created } = await splitRoutine(db().sql, twoDays.id, { day: 3, to: 4, at: '08:00' });
  assert.deepEqual([created.channel, created.voiceMaxLabel, created.retryMinutes], ['call', 'L1', 10]);
  // A retired routine stays as it was, its call fields too.
  await db().sql`UPDATE routines SET status = 'retired', next_run_at = NULL WHERE id = ${routine.id}`;
  await assert.rejects(db().sql`UPDATE routines SET retry_minutes = 10 WHERE id = ${routine.id}`);
});

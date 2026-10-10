// Calls from the chat (D-066) against PostgreSQL, with a fake voice and a fake model.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { request as httpRequest } from 'node:http';

import type { LoadedAgent } from '@arianna/agents';
import { DEFAULT_VOICE } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { archiveConversation, ChatError, createConversation, listMessages } from '../src/conversations.ts';
import { startLiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { createCalls, liveCall, listCalls, loadCall, type Calls } from '../src/voice/calls.ts';
import { AGENT_OFF_TEXT } from '../src/voice/outgoing.ts';
import type { TrialModel } from '../src/voice/trial.ts';
import { callWhenDone, scheduleCall } from '../src/voice/ringer.ts';
import { AGENT_VOICE_FRAME, agentCallText, CALL_TEXT, HISTORY_MESSAGES, VOICE_SYSTEM_PROMPT } from '../src/voice/turns.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const READY: TrialModel[] = [
  { id: 'parakeet-tdt-0.6b-v3-mlx', family: 'parakeet', kind: 'stt', present: true, assigned: true, sizeBytes: 1, voices: [] },
  { id: 'kokoro-82m-bf16-mlx', family: 'kokoro', kind: 'tts', present: true, assigned: true, sizeBytes: 1, voices: ['if_sara'] },
];

/** What the voice was asked, and what it answers. */
const voiceCalls: { method: string; path: string; json: unknown }[] = [];
let voiceState: 'up' | 'down' = 'up';
const voice = {
  get state() {
    return voiceState;
  },
  request(method: 'GET' | 'POST' | 'DELETE', path: string, options: { json?: unknown } = {}) {
    voiceCalls.push({ method, path, json: options.json });
    const body = path === '/calls' ? { sdp: 'v=0\r\nanswer', type: 'answer' } : { ok: true };
    return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) });
  },
};

/** The model: what it read, and the reply it gives (or an error, or a wait). */
let nextReply = 'Ciao! Tutto bene.';
let modelDown = false;
let modelGate: Promise<void> | undefined;
/** Streamed word by word to `onText` (D-070), with a pause between words; `stopped` when the signal ended it. */
let streaming = false;
let stopped = false;
/** Streamed: fails after this many words. */
let failAfter: number | undefined;
const asked: ChatRequest[] = [];
/** Aliases the core asked to unload (D-074). */
const unloaded: string[] = [];
let unloadFails = false;
/** Held open until released: the next call must wait for it. */
let unloadGate: Promise<void> | undefined;
const errors: unknown[] = [];
const model: LocalModel = {
  async unload(alias) {
    unloaded.push(alias);
    if (unloadGate !== undefined) await unloadGate;
    if (unloadFails) throw new Error('unload down');
    return true;
  },
  async chat(request) {
    asked.push(request);
    if (modelGate !== undefined) await modelGate;
    if (modelDown) throw new Error('down');
    if (streaming && request.onText !== undefined) {
      for (const piece of nextReply.match(/\S+\s*/g) ?? []) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (request.signal?.aborted === true) {
          stopped = true;
          throw new Error('cancelled');
        }
        request.onText(piece);
        if (failAfter !== undefined && --failAfter <= 0) throw new Error('down');
      }
    }
    return { text: nextReply, finishReason: 'stop', endpoint: 'fake', model: 'fake', durationMs: 1 };
  },
};
const ENDPOINTS = { endpoints: [{ models: { 'local-voice': 'qwen3-4b-instruct-2507-4bit' } as Record<string, string> }] };
let local = ENDPOINTS;

let calls: Calls;
let roles: { voice?: string } = { voice: 'qwen3-4b-instruct-2507-4bit' };

before(async () => {
  database = await createTestDatabase();
  calls = createCalls({
    sql: db().sql,
    voice,
    config: () => ({ roles, voice: { ...DEFAULT_VOICE, limits: { ...DEFAULT_VOICE.limits, delegations: 1, delegationSeconds: 1 } }, local }),
    candidates: () => READY,
    model: () => model,
    coreUrl: 'http://127.0.0.1:7420',
    pollMs: 20,
    onError: (error) => errors.push(error),
  });
});

after(async () => {
  await calls.close();
  await database?.close();
});

/** What the voice was told to say outside a turn. */
const said = (callId: string) => voiceCalls.filter((item) => item.path === `/calls/${callId}/say`).map((item) => (item.json as { text: string }).text);
const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};

function tokenOf(callId: string): string {
  const open = voiceCalls.findLast((item) => item.path === '/calls' && (item.json as { callId: string }).callId === callId);
  return (open?.json as { token: string }).token;
}

test('the user calls from a conversation: the voice gets the offer, the models and a token; the call is active', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call, answer } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  assert.equal(answer.type, 'answer');
  assert.equal(call.status, 'active');
  const sent = voiceCalls.at(-1)?.json as Record<string, unknown>;
  assert.deepEqual(sent.stt, { id: 'parakeet-tdt-0.6b-v3-mlx', family: 'parakeet' });
  assert.equal(sent.coreUrl, 'http://127.0.0.1:7420');
  assert.ok(typeof sent.token === 'string' && sent.token.length >= 32);
  assert.deepEqual(sent.limits, { callSeconds: 900, warnSeconds: 60 });
  assert.equal((await liveCall(db().sql))?.id, call.id);

  // One call at a time.
  const other = await createConversation(db().sql, { mode: 'private' });
  await assert.rejects(calls.start(other.id, { sdp: SDP, type: 'offer' }), { name: 'CallError', code: 'busy' });

  // A turn: the words and the reply go into the conversation, on the voice channel.
  const reply = await calls.turn(call.id, tokenOf(call.id), 'Ciao Arianna, come va?');
  assert.deepEqual(reply, { say: 'Ciao! Tutto bene.' });
  const messages = await listMessages(db().sql, conversation.id, { limit: 10 });
  assert.deepEqual(messages.map(({ role, channel, body, label }) => [role, channel, body, label]), [
    ['user', 'voice', 'Ciao Arianna, come va?', 'L2'],
    ['assistant', 'voice', 'Ciao! Tutto bene.', 'L2'],
  ]);
  assert.equal(asked.at(-1)?.model, 'local-voice');
  assert.equal(asked.at(-1)?.messages.at(-1)?.content, 'Ciao Arianna, come va?');

  // Without the right token nothing passes.
  await assert.rejects(calls.turn(call.id, 'x'.repeat(43), 'ciao'), { code: 'unauthorized' });
  await assert.rejects(calls.turn(call.id, undefined, 'ciao'), { code: 'unauthorized' });

  // Hanging up closes it on both sides; the receipt stays.
  const ended = await calls.end(call.id, 'hangup');
  assert.equal(ended.status, 'ended');
  assert.equal(ended.endReason, 'hangup');
  assert.ok(voiceCalls.some((item) => item.method === 'DELETE' && item.path === `/calls/${call.id}`));
  await assert.rejects(calls.turn(call.id, tokenOf(call.id), 'ancora'), { code: 'unauthorized' });
  assert.equal((await listCalls(db().sql, conversation.id)).length, 1);
  assert.equal(await liveCall(db().sql), undefined);
});

/** The latest request to the model. */
function lastAsked(): ChatRequest {
  const request = asked.at(-1);
  assert.ok(request !== undefined, 'the model was not asked');
  return request;
}

test('the window is read while the greeting is said, then each turn extends the same prompt (D-072)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  for (let index = 0; index < 12; index += 1) {
    await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body) VALUES (${conversation.id}, ${index % 2 === 0 ? 'user' : 'assistant'}, 'web', 'L1', ${`scritto ${String(index)}`})`;
  }
  const allowedReads = async () =>
    (await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM gateway_log WHERE target_kind = 'executor' AND target = 'local' AND decision = 'allow'`)[0]?.count ?? 0;
  const readsBefore = await allowedReads();
  const before = asked.length;
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  await until(() => asked.length > before);
  const warm = lastAsked();
  assert.equal(warm.maxTokens, 1);
  assert.equal(warm.onText, undefined);
  // The system prompt and the latest messages, through the gateway like a turn.
  assert.equal(warm.messages.length, HISTORY_MESSAGES + 1);
  assert.equal(warm.messages.at(-1)?.content, 'scritto 11');
  assert.equal(await allowedReads(), readsBefore + 1);

  await calls.turn(call.id, tokenOf(call.id), 'Primo turno');
  const first = lastAsked();
  assert.deepEqual(first.messages.slice(0, warm.messages.length), warm.messages);
  for (const words of ['Secondo turno', 'Terzo turno', 'Quarto turno', 'Quinto turno']) await calls.turn(call.id, tokenOf(call.id), words);
  // Ten messages more than the window at the start: none of the first ones dropped.
  const fifth = lastAsked();
  assert.equal(fifth.messages.length, HISTORY_MESSAGES + 1 + 10 - 1);
  assert.deepEqual(fifth.messages.slice(0, warm.messages.length), warm.messages);
  await calls.end(call.id, 'hangup');
});

test('the first turn stops a warm-up still at work', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  let open: () => void = () => undefined;
  modelGate = new Promise((resolve) => {
    open = resolve;
  });
  const before = asked.length;
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  await until(() => asked.length > before);
  const warm = lastAsked();
  assert.equal(warm.maxTokens, 1);
  const turn = calls.turn(call.id, tokenOf(call.id), 'Ci sei?');
  await until(() => warm.signal?.aborted === true);
  assert.equal(warm.signal?.aborted, true);
  open();
  modelGate = undefined;
  assert.deepEqual(await turn, { say: 'Ciao! Tutto bene.' });
  await calls.end(call.id, 'hangup');
});

test('hanging up during the greeting stops the warm-up', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  let open: () => void = () => undefined;
  modelGate = new Promise((resolve) => {
    open = resolve;
  });
  const before = asked.length;
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  await until(() => asked.length > before);
  const warm = lastAsked();
  assert.equal(warm.maxTokens, 1);
  await calls.end(call.id, 'hangup');
  assert.equal(warm.signal?.aborted, true);
  open();
  modelGate = undefined;
});

test('a delegation becomes a task of Arianna in the same conversation; past the limit the call says so', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  nextReply = 'DELEGA: controlla le fatture di settembre';
  const reply = await calls.turn(call.id, tokenOf(call.id), 'Mi controlli le fatture di settembre?');
  assert.deepEqual(reply, { say: CALL_TEXT.delegated });
  const messages = await listMessages(db().sql, conversation.id, { limit: 10 });
  const delegated = messages.find((item) => item.body === 'controlla le fatture di settembre');
  assert.ok(delegated !== undefined && delegated.taskId !== null && delegated.channel === 'voice');
  assert.equal((await loadCall(db().sql, call.id))?.delegations, 1);

  // The task finishes within the time: the start of its answer is said in the call.
  const taskId = delegated.taskId;
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body, task_id) VALUES (${conversation.id}, 'assistant', 'web', 'L2', ${'Ho trovato **tre** fatture.'}, ${taskId})`;
  await db().sql`UPDATE tasks SET status = 'done', evidence = ${db().sql.json([{ kind: 'message' }])} WHERE id = ${taskId}`;
  await until(() => said(call.id).length > 0);
  assert.deepEqual(said(call.id), ['Ho trovato tre fatture.']);

  // The limit of this test is one delegation per call.
  const second = await calls.turn(call.id, tokenOf(call.id), 'E anche quelle di ottobre?');
  assert.deepEqual(second, { say: CALL_TEXT.tooMany });
  assert.equal((await loadCall(db().sql, call.id))?.delegations, 1);
  await calls.end(call.id, 'hangup');
  nextReply = 'Ciao! Tutto bene.';
});

test('a delegation that does not finish in time, or the model down, are said, not hidden', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  nextReply = 'DELEGA: prepara un riassunto lungo';
  await calls.turn(call.id, tokenOf(call.id), 'Mi prepari un riassunto?');
  await until(() => said(call.id).length > 0, 4000);
  assert.deepEqual(said(call.id), [CALL_TEXT.stillWorking]);
  nextReply = 'Ciao! Tutto bene.';
  modelDown = true;
  assert.deepEqual(await calls.turn(call.id, tokenOf(call.id), 'Ci sei?'), { say: CALL_TEXT.modelDown });
  modelDown = false;
  await calls.end(call.id, 'hangup');
});

test('turns run in order; a reply overtaken by newer words is dropped, not said', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  let open: () => void = () => undefined;
  modelGate = new Promise((resolve) => {
    open = resolve;
  });
  const first = calls.turn(call.id, tokenOf(call.id), 'Prima frase');
  const second = calls.turn(call.id, tokenOf(call.id), 'Anzi, seconda frase');
  await until(() => asked.at(-1)?.messages.at(-1)?.content === 'Prima frase');
  open();
  modelGate = undefined;
  assert.deepEqual(await first, { say: '' });
  assert.deepEqual(await second, { say: 'Ciao! Tutto bene.' });
  const bodies = (await listMessages(db().sql, conversation.id, { limit: 10 })).map(({ role, body }) => `${role}:${body}`);
  assert.deepEqual(bodies, ['user:Prima frase', 'user:Anzi, seconda frase', 'assistant:Ciao! Tutto bene.']);
  // Only control characters: nothing to store.
  await assert.rejects(calls.turn(call.id, tokenOf(call.id), '\u0000\u0001'), { code: 'invalid' });
  await assert.rejects(calls.end(call.id, 'disconnected', 'y'.repeat(43)), { code: 'unauthorized' });
  await calls.end(call.id, 'hangup');
});

test('a work conversation refuses private data said aloud; an archived one cannot be called; missing models or voice say why', async () => {
  const work = await createConversation(db().sql, { mode: 'work' });
  const { call } = await calls.start(work.id, { sdp: SDP, type: 'offer' });
  const reply = await calls.turn(call.id, tokenOf(call.id), 'Il mio IBAN è IT60X0542811101000000123456');
  assert.deepEqual(reply, { say: CALL_TEXT.privateInWork });
  assert.deepEqual(await listMessages(db().sql, work.id, { limit: 10 }), []);
  await calls.end(call.id, 'disconnected', tokenOf(call.id));
  assert.equal((await loadCall(db().sql, call.id))?.endReason, 'disconnected');

  const archived = await createConversation(db().sql, { mode: 'private' });
  await archiveConversation(db().sql, archived.id, true);
  await assert.rejects(calls.start(archived.id, { sdp: SDP, type: 'offer' }), { code: 'archived' });

  const fresh = await createConversation(db().sql, { mode: 'private' });
  roles = {};
  await assert.rejects(calls.start(fresh.id, { sdp: SDP, type: 'offer' }), { code: 'not-ready' });
  roles = { voice: 'qwen3-4b-instruct-2507-4bit' };
  // A local server with a models table written by hand that does not serve the voice alias.
  local = { endpoints: [{ models: { 'local-large': 'big' } }] };
  await assert.rejects(calls.start(fresh.id, { sdp: SDP, type: 'offer' }), { code: 'not-ready' });
  local = ENDPOINTS;
  voiceState = 'down';
  await assert.rejects(calls.start(fresh.id, { sdp: SDP, type: 'offer' }), { code: 'voice-off' });
  voiceState = 'up';
  await assert.rejects(calls.start(fresh.id, { sdp: 'nope', type: 'answer' }), { code: 'invalid' });
});

test('a call left open by a core that stopped is closed at start, a ringing one as missed', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  await db().sql`INSERT INTO calls (conversation_id, direction, reason, status) VALUES (${conversation.id}, 'out', 'waiting', 'ringing')`;
  assert.equal(await calls.closeLeftovers(), 1);
  const [left] = await listCalls(db().sql, conversation.id);
  assert.ok(left !== undefined);
  assert.equal(left.endReason, 'core-restart');
  assert.equal(left.status, 'missed');
  const [event] = await db().sql<{ payload: { status: string } }[]>`SELECT payload FROM events WHERE kind = 'call.ended' ORDER BY id DESC LIMIT 1`;
  assert.equal(event?.payload.status, 'missed');
});

test('the routes of the voice want the token of the call; the others JSON from the same origin', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, calls });
  const origin = `http://127.0.0.1:${String(server.port)}`;
  const send = (path: string, body: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${origin}${path}`, { method: 'POST', agent: false, headers: { 'content-length': String(Buffer.byteLength(body)), ...headers } }, (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  try {
    const conversation = await createConversation(db().sql, { mode: 'private' });
    const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
    const json = { 'content-type': 'application/json' };
    const bearer = `Bearer ${tokenOf(call.id)}`;
    assert.equal(await send(`/api/calls/${call.id}/turn`, '{"text":"ciao"}', json), 401);
    assert.equal(await send(`/api/calls/${call.id}/turn`, '{"text":"ciao"}', { ...json, authorization: 'Bearer wrong' }), 401);
    assert.equal(await send(`/api/calls/${call.id}/turn`, '{"text":"ciao"}', { authorization: bearer, 'content-type': 'text/plain' }), 415);
    assert.equal(await send(`/api/calls/${call.id}/turn`, '{"text":"ciao"}', { ...json, authorization: bearer, host: 'evil.example:80' }), 403);
    assert.equal(await send(`/api/calls/${call.id}/ended`, '{"reason":"core-restart"}', { ...json, authorization: bearer }), 400);
    assert.equal(await send(`/api/calls/${call.id}/turn`, '{"text":"ciao"}', { ...json, authorization: bearer }), 200);
    // The answer is one JSON line per sentence (D-070).
    const lines = await new Promise<{ type: string | undefined; body: string }>((resolve, reject) => {
      const body = '{"text":"ancora ciao"}';
      const req = httpRequest(`${origin}/api/calls/${call.id}/turn`, { method: 'POST', agent: false, headers: { ...json, authorization: bearer, 'content-length': String(body.length) } }, (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        res.on('end', () => {
          resolve({ type: res.headers['content-type'], body: text });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(lines.type, 'application/x-ndjson; charset=utf-8');
    assert.deepEqual(lines.body.trimEnd().split('\n').map((line) => JSON.parse(line) as unknown), [{ say: 'Ciao!' }, { say: 'Tutto bene.' }]);
    assert.equal(await send('/api/calls', JSON.stringify({ conversationId: conversation.id, sdp: SDP, type: 'offer' }), { ...json, origin: 'http://evil.example' }), 403);
    assert.equal(await send(`/api/calls/${call.id}/ended`, '{"reason":"disconnected"}', { ...json, authorization: bearer }), 200);
  } finally {
    await server.close();
    await live.close();
  }
});

test('a streamed reply is said one sentence at a time, each through the gateway, and stored whole (D-070)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  streaming = true;
  nextReply = 'Ciao! Tutto bene. Tu come stai?';
  const before = (await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_log WHERE target_kind = 'channel' AND target = 'voice'`)[0]?.n ?? 0;
  const said: string[] = [];
  for await (const { say } of calls.turnStream(call.id, tokenOf(call.id), 'Come va?')) said.push(say);
  assert.deepEqual(said, ['Ciao!', 'Tutto bene.', 'Tu come stai?']);
  const after = (await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_log WHERE target_kind = 'channel' AND target = 'voice'`)[0]?.n ?? 0;
  assert.equal(after - before, 3);
  const bodies = (await listMessages(db().sql, conversation.id, { limit: 10 })).map(({ role, body }) => `${role}:${body}`);
  assert.deepEqual(bodies, ['user:Come va?', 'assistant:Ciao! Tutto bene. Tu come stai?']);

  // A delegation after a sentence: the sentence is said, the DELEGA line never is.
  nextReply = 'Va bene, ci penso io.\nDELEGA: cerca le fatture di ottobre';
  const second: string[] = [];
  for await (const { say } of calls.turnStream(call.id, tokenOf(call.id), 'Cerchi le fatture?')) second.push(say);
  assert.deepEqual(second, ['Va bene, ci penso io.', CALL_TEXT.delegated]);
  const after2 = (await listMessages(db().sql, conversation.id, { limit: 10 })).map(({ role, body }) => `${role}:${body}`);
  assert.ok(after2.includes('assistant:Va bene, ci penso io.'));
  assert.ok(after2.includes('user:cerca le fatture di ottobre'));
  assert.ok(!after2.some((body) => body.includes('DELEGA')));
  await calls.end(call.id, 'hangup');
  streaming = false;
  nextReply = 'Ciao! Tutto bene.';
});

test('a turn whose reader goes away stops the model and keeps what was said', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  streaming = true;
  stopped = false;
  nextReply = `Prima frase. ${Array.from({ length: 60 }, (_, index) => `parola${String(index)}`).join(' ')}.`;
  const lines = calls.turnStream(call.id, tokenOf(call.id), 'Raccontami');
  const first = await lines.next();
  assert.deepEqual(first, { done: false, value: { say: 'Prima frase.' } });
  await lines.return?.();
  await until(() => stopped);
  // The next turn waits for this one: once it ran, the history is written.
  nextReply = 'Ok.';
  streaming = false;
  assert.deepEqual(await calls.turn(call.id, tokenOf(call.id), 'Basta così'), { say: 'Ok.' });
  const bodies = (await listMessages(db().sql, conversation.id, { limit: 10 })).map(({ role, body }) => `${role}:${body}`);
  assert.deepEqual(bodies, ['user:Raccontami', 'assistant:Prima frase.', 'user:Basta così', 'assistant:Ok.']);
  await calls.end(call.id, 'hangup');
  nextReply = 'Ciao! Tutto bene.';
});

test('newer words stop the model of the turn at work', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  streaming = true;
  stopped = false;
  nextReply = Array.from({ length: 80 }, (_, index) => `parola${String(index)}`).join(' ');
  const first = calls.turn(call.id, tokenOf(call.id), 'Parlami a lungo');
  await until(() => asked.at(-1)?.messages.at(-1)?.content === 'Parlami a lungo');
  nextReply = 'Certo.';
  const second = calls.turn(call.id, tokenOf(call.id), 'Anzi no');
  assert.deepEqual(await first, { say: '' });
  assert.ok(stopped);
  assert.deepEqual(await second, { say: 'Certo.' });
  await calls.end(call.id, 'hangup');
  streaming = false;
  nextReply = 'Ciao! Tutto bene.';
});

test('a delegation written in markdown or after a sentence on the same line is never said and still starts', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  streaming = true;
  nextReply = 'Ok. **DELEGA:** cerca le fatture di novembre';
  const said: string[] = [];
  for await (const { say } of calls.turnStream(call.id, tokenOf(call.id), 'Cerchi le fatture?')) said.push(say);
  assert.deepEqual(said, ['Ok.', CALL_TEXT.delegated]);
  const bodies = (await listMessages(db().sql, conversation.id, { limit: 10 })).map(({ role, body }) => `${role}:${body}`);
  assert.ok(bodies.includes('user:cerca le fatture di novembre'));
  assert.ok(!bodies.some((body) => body.includes('DELEGA')));
  await calls.end(call.id, 'hangup');
  streaming = false;
  nextReply = 'Ciao! Tutto bene.';
});

test('a model that falls after some sentences keeps them and does not say it is down', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  streaming = true;
  failAfter = 3;
  nextReply = 'Prima frase. Seconda frase lunga lunga.';
  assert.deepEqual(await calls.turn(call.id, tokenOf(call.id), 'Dimmi'), { say: 'Prima frase.' });
  failAfter = undefined;
  const bodies = (await listMessages(db().sql, conversation.id, { limit: 10 })).map(({ role, body }) => `${role}:${body}`);
  assert.deepEqual(bodies, ['user:Dimmi', 'assistant:Prima frase.']);
  await calls.end(call.id, 'hangup');
  streaming = false;
  nextReply = 'Ciao! Tutto bene.';
});


test('the end of the last call unloads the model of the calls (D-074)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const before = unloaded.length;
  const { call } = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  assert.equal(unloaded.length, before);
  await calls.end(call.id, 'hangup');
  await until(() => unloaded.length > before);
  assert.deepEqual(unloaded.slice(before), ['local-voice']);
  // Ending it again finds no session: nothing more to unload.
  await calls.end(call.id, 'hangup');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(unloaded.length, before + 1);
});

test('an unload that fails does not stop the end of the call; a call that starts meanwhile waits for it (D-074)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  unloadFails = true;
  const first = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  const ended = await calls.end(first.call.id, 'hangup');
  assert.equal(ended.status, 'ended');
  await until(() => errors.some((error) => error instanceof Error && error.message === 'unload down'));
  unloadFails = false;

  // An unload still in flight: the turn of the next call asks the model only after it.
  let release = (): void => undefined;
  unloadGate = new Promise((resolve) => {
    release = resolve;
  });
  const second = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  const before = unloaded.length;
  await calls.end(second.call.id, 'hangup');
  await until(() => unloaded.length > before);
  const third = await calls.start(conversation.id, { sdp: SDP, type: 'offer' });
  const asking = asked.length;
  const turn = calls.turn(third.call.id, tokenOf(third.call.id), 'Ci sei?');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(asked.length, asking, 'the model waits for the unload');
  release();
  unloadGate = undefined;
  assert.deepEqual(await turn, { say: nextReply });
  await calls.end(third.call.id, 'hangup');
});

// D-158: calls in a direct chat. A local agent answers on its own model; the Coder through a bridge.

/** A user agent that only answers on the local model, reading up to `maxLabel`. */
function localAgent(maxLabel: 'L1' | 'L2'): LoadedAgent {
  return {
    card: { name: 'traduttore', description: 'Agente traduttore di prova', maxLabel, executors: ['local'], tools: [], limits: { maxSteps: 5, maxMinutes: 5, maxCost: 0 } },
    prompt: 'Traduci in inglese il testo che ricevi.',
    origin: 'user',
  } as unknown as LoadedAgent;
}
const CODER_AGENT = {
  card: { name: 'coder', description: 'Il Coder di prova', maxLabel: 'L1', cloudMaxLabel: 'L1', executors: ['claude'], tools: ['repo.read', 'repo.write'], limits: { maxSteps: 5, maxMinutes: 5, maxCost: 0 } },
  prompt: 'Scrivi codice.',
} as unknown as LoadedAgent;

const directAgents = new Map<string, LoadedAgent>([
  ['traduttore', localAgent('L2')],
  ['coder', CODER_AGENT],
]);
let claudeOn = true;
let agentModelOf: string | undefined = 'local-large';
let direct: Calls | undefined;
function directCalls(): Calls {
  direct ??= createCalls({
    sql: db().sql,
    voice,
    config: () => ({ roles, voice: { ...DEFAULT_VOICE, limits: { ...DEFAULT_VOICE.limits, delegations: 3, delegationSeconds: 2 } }, local }),
    candidates: () => READY,
    model: () => model,
    coreUrl: 'http://127.0.0.1:7420',
    pollMs: 20,
    onError: (error) => errors.push(error),
    agents: () => directAgents,
    cloud: () => ({ claude: claudeOn, codex: false }),
    agentModel: () => Promise.resolve(agentModelOf),
  });
  return direct;
}
after(async () => {
  await direct?.close();
});

const TRANSLATOR = { name: 'traduttore', modes: ['private', 'work'] as const, project: false };
const CODER = { name: 'coder', modes: ['work'] as const, project: true };
const greetingSent = (callId: string) => (voiceCalls.findLast((item) => item.path === '/calls' && (item.json as { callId: string }).callId === callId)?.json as { texts: { greeting: string } }).texts.greeting;

test('a call in a direct chat with a local agent: it answers on its own model, with its card and the direct chat (D-158)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private', agent: TRANSLATOR });
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body) VALUES (${conversation.id}, 'user', 'web', 'L2', 'Scritto prima in chat')`;
  const before = asked.length;
  const unloadedBefore = unloaded.length;
  const { call } = await directCalls().start(conversation.id, { sdp: SDP, type: 'offer' });
  assert.equal(call.agent, 'traduttore');
  assert.equal((await liveCall(db().sql))?.agent, 'traduttore');
  assert.equal(greetingSent(call.id), 'Ciao, sono traduttore. Dimmi pure.');
  // The warm-up reads the agent's prompt on its model, never the voice role.
  await until(() => asked.length > before);
  assert.equal(lastAsked().model, 'local-large');
  assert.equal(lastAsked().maxTokens, 1);

  nextReply = 'Cat si dice gatto.';
  assert.deepEqual(await directCalls().turn(call.id, tokenOf(call.id), 'Come si dice gatto?'), { say: 'Cat si dice gatto.' });
  const turn = lastAsked();
  assert.equal(turn.model, 'local-large');
  const system = turn.messages[0]?.content ?? '';
  assert.ok(system.startsWith(AGENT_VOICE_FRAME) && system.endsWith('Traduci in inglese il testo che ricevi.'));
  assert.ok(!system.includes(VOICE_SYSTEM_PROMPT));
  assert.deepEqual(turn.messages.slice(1).map(({ content }) => content), ['Scritto prima in chat', 'Come si dice gatto?']);
  // A line of the agent that looks like Arianna's delegation is only words: a local agent starts no task from a call.
  nextReply = 'DELEGA: cerca qualcosa';
  await directCalls().turn(call.id, tokenOf(call.id), 'Cerca qualcosa');
  const [{ count } = { count: -1 }] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM tasks WHERE conversation_id = ${conversation.id}`;
  assert.equal(count, 0);
  const messages = await listMessages(db().sql, conversation.id, { limit: 10 });
  assert.deepEqual(messages.slice(1, 3).map(({ role, channel, label }) => [role, channel, label]), [
    ['user', 'voice', 'L2'],
    ['assistant', 'voice', 'L2'],
  ]);
  await directCalls().end(call.id, 'hangup');
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Its model is the one of its delegations: the end of the call does not unload it.
  assert.equal(unloaded.length, unloadedBefore);
  nextReply = 'Ciao! Tutto bene.';
});

test('a direct chat refuses the call when its agent cannot answer: card off, mode it does not read, no local model, or a core without agents', async () => {
  // A card that reads only L1 does not answer a private conversation.
  const conversation = await createConversation(db().sql, { mode: 'private', agent: TRANSLATOR });
  directAgents.set('traduttore', localAgent('L1'));
  await assert.rejects(directCalls().start(conversation.id, { sdp: SDP, type: 'offer' }), { name: 'CallError', code: 'agent-off' });
  directAgents.set('traduttore', localAgent('L2'));
  // No local model for it just now: passing, not a refusal of the agent.
  agentModelOf = undefined;
  await assert.rejects(directCalls().start(conversation.id, { sdp: SDP, type: 'offer' }), { name: 'CallError', code: 'not-ready' });
  agentModelOf = 'local-large';
  directAgents.delete('traduttore');
  await assert.rejects(directCalls().start(conversation.id, { sdp: SDP, type: 'offer' }), { name: 'CallError', code: 'agent-off' });
  directAgents.set('traduttore', localAgent('L2'));
  // A core that does not pass its agents: no calls in a direct chat.
  await assert.rejects(calls.start(conversation.id, { sdp: SDP, type: 'offer' }), { name: 'CallError', code: 'agent-off' });
  // The Coder with Claude off.
  const coder = await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'], agent: CODER });
  claudeOn = false;
  await assert.rejects(directCalls().start(coder.id, { sdp: SDP, type: 'offer' }), { name: 'CallError', code: 'agent-off' });
  claudeOn = true;
  // Never incognito: a direct chat has no incognito form.
  await assert.rejects(createConversation(db().sql, { mode: 'private', agent: TRANSLATOR, incognito: true }), (error: unknown) => error instanceof ChatError);
  assert.equal(await liveCall(db().sql), undefined);
  // The same rules for a call scheduled or "when done".
  await assert.rejects(scheduleCall(db().sql, coder.id, new Date(Date.now() + 3_600_000), new Date(), (id) => calls.check(id)), { name: 'CallError', code: 'agent-off' });
  const scheduled = await scheduleCall(db().sql, coder.id, new Date(Date.now() + 3_600_000), new Date(), (id) => directCalls().check(id));
  assert.equal(scheduled.agent, 'coder');
  claudeOn = false;
  await assert.rejects(scheduleCall(db().sql, coder.id, new Date(Date.now() + 3_600_000), new Date(), (id) => directCalls().check(id)), { code: 'agent-off' });
  claudeOn = true;
  await db().sql`UPDATE calls SET status = 'skipped', end_reason = 'cancelled', ended_at = now() WHERE id = ${scheduled.id}`;
});

test('the Coder in a call: a bridge passes the words on as its message, says so at once and reads the answer when it comes (D-158)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'], agent: CODER });
  const before = asked.length;
  const { call } = await directCalls().start(conversation.id, { sdp: SDP, type: 'offer' });
  assert.equal(call.agent, 'coder');
  assert.equal(greetingSent(call.id), 'Ciao, sono la linea del Coder: quello che mi dici lo passo al Coder. Dimmi pure.');
  const texts = agentCallText('Coder');

  // Private data said aloud in its work chat: refused, nothing stored, nothing passed.
  assert.deepEqual(await directCalls().turn(call.id, tokenOf(call.id), 'Il mio IBAN è IT60X0542811101000000123456'), { say: CALL_TEXT.privateInWork });
  assert.equal((await listMessages(db().sql, conversation.id, { limit: 10 })).length, 0);

  assert.deepEqual(await directCalls().turn(call.id, tokenOf(call.id), 'Aggiungi un test al login'), { say: texts.bridged });
  const [task] = await db().sql<{ id: string; assignee: string }[]>`SELECT id::text, assignee FROM tasks WHERE conversation_id = ${conversation.id}`;
  assert.ok(task !== undefined);
  assert.equal(task.assignee, 'coder');
  const [delegation] = await db().sql<{ agent: string; brief: string }[]>`SELECT d.agent, d.brief FROM task_delegations d WHERE d.task_id = ${task.id}`;
  assert.deepEqual({ ...delegation }, { agent: 'coder', brief: 'Aggiungi un test al login' });
  const spoken = await listMessages(db().sql, conversation.id, { limit: 10 });
  assert.deepEqual(spoken.map(({ role, channel, body }) => [role, channel, body]), [
    ['user', 'voice', 'Aggiungi un test al login'],
    ['assistant', 'voice', texts.bridged],
  ]);
  // One job at a time: while the Coder works the call says so.
  assert.deepEqual(await directCalls().turn(call.id, tokenOf(call.id), 'E poi anche il logout'), { say: texts.busy });

  // Its answer comes: the start of it is said in the call.
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body, task_id, agent) VALUES (${conversation.id}, 'assistant', 'web', 'L1', ${'Fatto: ho aggiunto **un** test.'}, ${task.id}, 'coder')`;
  await db().sql`UPDATE tasks SET status = 'done', evidence = ${db().sql.json([{ kind: 'message' }])} WHERE id = ${task.id}`;
  await until(() => said(call.id).length > 0);
  assert.deepEqual(said(call.id), ['Fatto: ho aggiunto un test.']);
  // No model ever answered for the Coder.
  assert.equal(asked.length, before);
  assert.equal((await loadCall(db().sql, call.id))?.delegations, 1);
  await directCalls().end(call.id, 'hangup');
});

test('the Coder still at work when the time is over: the call says it, and "chiamami quando finisci" calls back in its name (D-158)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'], agent: CODER });
  const { call } = await directCalls().start(conversation.id, { sdp: SDP, type: 'offer' });
  await directCalls().turn(call.id, tokenOf(call.id), 'Rifai il menu');
  await until(() => said(call.id).length > 0, 5000);
  assert.deepEqual(said(call.id), [agentCallText('Coder').stillWorking]);
  await directCalls().end(call.id, 'hangup');

  const [task] = await db().sql<{ id: string }[]>`SELECT id::text FROM tasks WHERE conversation_id = ${conversation.id}`;
  const later = await callWhenDone(db().sql, task?.id ?? '', (id) => directCalls().check(id));
  assert.equal(later.agent, 'coder');
  // It rings (as the ringer makes it), and the greeting is the Coder's line.
  await db().sql`UPDATE tasks SET status = 'done', evidence = ${db().sql.json([{ kind: 'message' }])} WHERE id = ${task?.id ?? ''}`;
  await db().sql`UPDATE calls SET status = 'ringing', rang_at = now() WHERE id = ${later.id}`;
  const answered = await directCalls().answer(later.id, { sdp: SDP, type: 'offer' });
  assert.equal(answered.call.agent, 'coder');
  assert.ok(greetingSent(later.id).startsWith('Ciao, sono la linea del Coder'));
  assert.ok(!greetingSent(later.id).includes('Arianna'));
  await directCalls().end(later.id, 'hangup');

  // An agent that cannot answer any more: the ringing call ends unanswered with the refusal.
  const [again] = await db().sql<{ id: string }[]>`INSERT INTO calls (conversation_id, direction, reason, status, rang_at) VALUES (${conversation.id}, 'out', 'scheduled', 'ringing', now()) RETURNING id::text`;
  claudeOn = false;
  await assert.rejects(directCalls().answer(again?.id ?? '', { sdp: SDP, type: 'offer' }), { code: 'agent-off' });
  claudeOn = true;
  const missed = await loadCall(db().sql, again?.id ?? '');
  assert.deepEqual([missed?.status, missed?.endReason], ['missed', 'agent-off']);
  const notes = (await listMessages(db().sql, conversation.id, { limit: 50 })).filter((message) => message.body === AGENT_OFF_TEXT);
  assert.deepEqual(notes.map(({ label }) => label), ['L0']);
});

test('a local agent in a call never reads above its card: what it may not read stays out, a turn above it is refused, an agent gone says so (D-158)', async () => {
  // A card that reads only Pubblico, in a work chat (Interno): its written history stays out of the prompt.
  // A card of agents/ (its prompt L0) that reads only Pubblico.
  directAgents.set('traduttore', { card: { ...localAgent('L1').card, maxLabel: 'L0' }, prompt: 'Traduci.' });
  const conversation = await createConversation(db().sql, { mode: 'work', agent: { name: 'traduttore', modes: ['work'], project: false } });
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body) VALUES (${conversation.id}, 'user', 'web', 'L1', 'Riga interna scritta prima')`;
  const before = asked.length;
  const { call } = await directCalls().start(conversation.id, { sdp: SDP, type: 'offer' });
  await until(() => asked.length > before);
  const warm = lastAsked();
  assert.equal(warm.messages.length, 1, 'only its system prompt');
  assert.ok(!warm.messages.some((message) => message.content.includes('Riga interna')));
  // The user's words in this chat are Interno, above the card: refused, never stored nor read.
  const texts = agentCallText('traduttore');
  const asking = asked.length;
  assert.deepEqual(await directCalls().turn(call.id, tokenOf(call.id), 'Mi senti?'), { say: texts.cannotRead });
  assert.equal(asked.length, asking);
  assert.ok(!(await listMessages(db().sql, conversation.id, { limit: 10 })).some((message) => message.body === 'Mi senti?'));
  // Deactivated during the call: the voice says so.
  directAgents.delete('traduttore');
  assert.deepEqual(await directCalls().turn(call.id, tokenOf(call.id), 'Ci sei?'), { say: texts.gone });
  assert.equal(asked.length, asking);
  directAgents.set('traduttore', localAgent('L2'));
  await directCalls().end(call.id, 'hangup');
});

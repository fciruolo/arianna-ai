// The trial chat of a local model (D-142): an incognito private conversation
// where every message goes to one catalog model, without Arianna's prompt,
// her tools or the archive.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { ChatError, createConversation, loadConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { closeIncognito } from '../src/incognito.ts';
import { startLiveFeed } from '../src/live.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { trialHistory } from '../src/orchestrator/trial-chat.ts';
import { startApiServer } from '../src/server/http.ts';
import { loadTask } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `trial-chat-${randomUUID()}`);
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const MODEL = 'qwen3-0.6b-4bit';

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** A local model that answers `text` in two pieces and records what it was asked. */
function answering(text: string): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const half = Math.floor(text.length / 2);
      request.onText?.(text.slice(0, half));
      request.onText?.(text.slice(half));
      return Promise.resolve({ text, finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 5 }, endpoint: 'test', model: MODEL, durationMs: 1 });
    },
  };
}

/** A local model that must never be called: Arianna's model in a trial chat. */
function untouched(): LocalModel {
  return { chat: () => Promise.reject(new Error('Arianna was called in a trial chat')) };
}

function orchestrator(trial: ((id: string) => LocalModel) | undefined): StepExecutor {
  const settings = () => ({ ...BASE, home: HOME, paths: { data: join(HOME, 'data') }, cloud: { executors: [], models: defaultCloudModels() }, projects: [] });
  return createOrchestrator({
    sql: db().sql,
    agents: committedAgents(ROOT),
    kb: createKb({ home: HOME, rules: RULES }),
    model: untouched,
    settings,
    rules: RULES,
    ...(trial === undefined ? {} : { trialModel: trial }),
  });
}

async function drain(taskId: string, executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 100; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (job.payload.taskId !== taskId) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

function trialChat() {
  return createConversation(db().sql, { mode: 'private', incognito: true, trialModel: MODEL });
}

test('a trial chat is an incognito private conversation, and its model never changes (D-142)', async () => {
  await assert.rejects(createConversation(db().sql, { mode: 'private', trialModel: MODEL }), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(createConversation(db().sql, { mode: 'work', incognito: true, trialModel: MODEL }), /incognito private/);
  const chat = await trialChat();
  assert.deepEqual([chat.trialModel, chat.incognito, chat.mode, chat.agent], [MODEL, true, 'private', null]);
  const plain = await createConversation(db().sql, { mode: 'private' });
  assert.equal(plain.trialModel, null);
  // The database holds the same rules, whatever the core does.
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, trial_model) VALUES ('private', 'L2', ${MODEL})`, /conversations_trial_fields/);
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, incognito, trial_model) VALUES ('private', 'L2', true, 'Not An Id')`, /check constraint/);
  await assert.rejects(db().sql`UPDATE conversations SET trial_model = 'altro-modello' WHERE id = ${chat.id}`, /chosen at creation and never changes/);
  await assert.rejects(db().sql`UPDATE conversations SET trial_model = ${MODEL} WHERE id = ${plain.id}`, /chosen at creation and never changes/);
});

test('the model under trial answers alone: the messages of the chat, no prompt of Arianna, no tools, streamed', async () => {
  const chat = await trialChat();
  const model = answering('Ciao, sono il modello in prova.');
  const asked: string[] = [];
  const executor = orchestrator((id) => {
    asked.push(id);
    return model;
  });
  const first = await postUserMessage(db().sql, chat.id, 'Ciao, chi sei?');
  await drain(first.task.id, executor);
  assert.equal((await loadTask(db().sql, first.task.id))?.status, 'done');
  const second = await postUserMessage(db().sql, chat.id, 'E cosa sai fare?');
  await drain(second.task.id, executor);

  assert.deepEqual(asked, [MODEL, MODEL]);
  assert.equal(model.requests.length, 2);
  const [, last] = model.requests;
  assert.ok(last !== undefined);
  assert.equal(last.model, 'local-large');
  assert.equal(last.schema, undefined);
  assert.deepEqual(last.messages, [
    { role: 'user', content: 'Ciao, chi sei?' },
    { role: 'assistant', content: 'Ciao, sono il modello in prova.' },
    { role: 'user', content: 'E cosa sai fare?' },
  ]);
  const rows = await db().sql<{ role: string; body: string; label: string; model: string | null }[]>`
    SELECT role, body, label, model FROM messages WHERE conversation_id = ${chat.id} ORDER BY ts, id`;
  assert.deepEqual(
    rows.map((row) => [row.role, row.label, row.model]),
    [['user', 'L2', null], ['assistant', 'L2', null], ['user', 'L2', null], ['assistant', 'L2', null]],
  );
  // The run says which model ran, locally.
  const [run] = await db().sql<{ executor: string; model: string | null; locality: string }[]>`
    SELECT executor, model, locality FROM runs WHERE task_id = ${second.task.id}`;
  assert.deepEqual(run, { executor: 'local', model: MODEL, locality: 'local' });
});

test('without the trial model in the core the task waits for the user, Arianna never answers', async () => {
  const chat = await trialChat();
  const sent = await postUserMessage(db().sql, chat.id, 'Ci sei?');
  await drain(sent.task.id, orchestrator(undefined));
  const task = await loadTask(db().sql, sent.task.id);
  assert.equal(task?.status, 'waiting_user');
  assert.match(task.waitingReason ?? '', /not available/);
  assert.equal((await loadConversation(db().sql, chat.id))?.trialModel, MODEL);
});

test('the route opens a trial chat only incognito and private, for a model the core accepts', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    projects: () => [],
    trialRefusal: (id) => (id === MODEL ? undefined : 'the model is not in the catalog'),
  });
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${String(server.port)}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const made = await post({ mode: 'private', incognito: true, trialModel: MODEL });
    assert.equal(made.status, 201);
    assert.equal(((await made.json()) as { conversation: { trialModel: string } }).conversation.trialModel, MODEL);
    assert.equal((await post({ mode: 'private', incognito: true, trialModel: 'sconosciuto' })).status, 409);
    assert.equal((await post({ mode: 'private', trialModel: MODEL })).status, 400);
    assert.equal((await post({ mode: 'work', incognito: true, trialModel: MODEL })).status, 400);
    assert.equal((await post({ mode: 'private', incognito: true, trialModel: 7 })).status, 400);
  } finally {
    await server.close();
    await live.close();
  }
  // A core without the check opens none.
  const bare = await startLiveFeed(db().sql);
  const plain = await startApiServer({ sql: db().sql, live: bare, host: '127.0.0.1', port: 0, projects: () => [] });
  try {
    const refused = await fetch(`http://127.0.0.1:${String(plain.port)}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'private', incognito: true, trialModel: MODEL }),
    });
    assert.equal(refused.status, 409);
  } finally {
    await plain.close();
    await bare.close();
  }
});

/** An answer of the model written straight into the conversation, as an earlier turn. */
async function answer(conversationId: string, body: string): Promise<void> {
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body) VALUES (${conversationId}, 'assistant', 'web', 'L2', ${body})`;
}

test('the history: up to the task message, the last 40, the same role joined, long messages cut, an answer never first', async () => {
  const chat = await trialChat();
  // 43 messages before the task: the last 40 with it start with an answer, which goes.
  for (let index = 0; index < 20; index += 1) {
    await postUserMessage(db().sql, chat.id, `domanda ${String(index)}`);
    await answer(chat.id, `risposta ${String(index)}`);
  }
  await answer(chat.id, 'una seconda risposta di fila');
  await answer(chat.id, 'e una terza');
  const long = 'x'.repeat(9_000);
  const sent = await postUserMessage(db().sql, chat.id, long);
  // A message of the user written after the task's: another task reads it.
  await postUserMessage(db().sql, chat.id, 'dopo');

  const { messages, label } = await trialHistory(db().sql, chat.id, sent.task.id);
  assert.equal(label, 'L2');
  assert.equal(messages[0]?.role, 'user');
  assert.ok(messages.every((message, index) => index === 0 || message.role !== messages[index - 1]?.role), 'roles alternate');
  assert.ok(!messages.some((message) => message.content.includes('dopo')));
  const last = messages.at(-1);
  assert.equal(last?.role, 'user');
  assert.match(last.content, /\[cut at 8000 characters\]$/);
  assert.equal(last.content.startsWith('x'.repeat(8_000)), true);
  // The two answers in a row are one message; the oldest kept starts after the cut.
  assert.ok(messages.some((message) => message.content === 'risposta 19\n\nuna seconda risposta di fila\n\ne una terza'));
  assert.equal(messages[0].content, 'domanda 2');
  assert.equal(messages.length, 37);
});

test('a model that fails or says nothing: the task waits for the user with why', async () => {
  const cases: [LocalModel, RegExp][] = [
    [{ chat: () => Promise.reject(new LocalModelError('no-endpoint', 'none')) }, /no local server/],
    [{ chat: () => Promise.reject(new LocalModelError('bad-response', 'garbage')) }, /cannot read/],
    [answering('   '), /gave no answer/],
  ];
  for (const [model, why] of cases) {
    const chat = await trialChat();
    const sent = await postUserMessage(db().sql, chat.id, 'Ci sei?');
    await drain(sent.task.id, orchestrator(() => model));
    const task = await loadTask(db().sql, sent.task.id);
    assert.equal(task?.status, 'waiting_user');
    assert.match(task.waitingReason ?? '', why);
  }
});

test('"Termina" deletes the texts of a trial chat like any incognito; the model id stays, L0', async () => {
  const chat = await trialChat();
  const sent = await postUserMessage(db().sql, chat.id, 'Un segreto da dimenticare');
  await drain(sent.task.id, orchestrator(() => answering('Dimenticato.')));
  const receipt = await closeIncognito(db().sql, chat.id, 'user');
  assert.equal(receipt.deleted.messages, 2);
  const [row] = await db().sql<{ purged: boolean; trialModel: string | null }[]>`
    SELECT purged_at IS NOT NULL AS purged, trial_model AS "trialModel" FROM conversations WHERE id = ${chat.id}`;
  assert.deepEqual(row, { purged: true, trialModel: MODEL });
  const [left] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE conversation_id = ${chat.id}`;
  assert.equal(left?.count, 0);
});

// Sessions of the secretary (I-12, D-146): each click on the "Segretaria"
// button opens a new session; the model reads only its messages, and no
// summary of the older ones. The other conversations keep D-077.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { localDay } from '../src/commitment-dates.ts';
import { openSecretary } from '../src/commitments.ts';
import { createConversation, loadConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { conversationView } from '../src/orchestrator/summaries.ts';
import { fireReminder } from '../src/reminders.ts';
import { startApiServer } from '../src/server/http.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOME = resolveHome({});
const agents = committedAgents(HOME);
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const kb = createKb({ home: HOME, rules: RULES });

/** A local model that answers each call with the next scripted answer, and records the requests. */
function scripted(answers: Answer[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = JSON.stringify(request.schema?.schema).includes('"thought"') ? { thought: 'Ragiono.', ...next } : next;
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

async function drain(taskId: string, model: LocalModel): Promise<string[]> {
  const executor = createOrchestrator({ sql: db().sql, agents, kb, model: () => model, settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() } }), rules: RULES });
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
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

/** Earlier messages of a conversation, written straight in the table. */
async function seed(conversationId: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await db().owner`
      INSERT INTO messages (conversation_id, role, label, body)
      VALUES (${conversationId}, ${index % 2 === 1 ? 'user' : 'assistant'}, 'L1', ${`Messaggio ${String(index)}`})`;
  }
}

/** The texts the model read, without the system prompt. */
const read = (request: ChatRequest | undefined) => (request?.messages ?? []).slice(1).map((message) => message.content).join('\n');

/** Asks one question in the conversation and returns what the model read for it. */
async function ask(conversationId: string, question: string, reply: string): Promise<string> {
  const { task } = await postUserMessage(db().sql, conversationId, question);
  const model = scripted([{ action: 'reply', text: reply }]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  // One request only: the answer, never a summary first.
  assert.equal(model.requests.length, 1);
  return read(model.requests[0]);
}

test('the secretary never summarizes: a long session drops what the anchor leaves, and old pieces are not read', async () => {
  // Created before this migration, never clicked since: no session, the whole conversation counts, still without summaries.
  const [secretary] = await db().owner<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, title, secretary) VALUES ('private', 'L2', 'Segretaria', true) RETURNING id::text`;
  assert.ok(secretary !== undefined);
  await seed(secretary.id, 30);
  const { task } = await postUserMessage(db().sql, secretary.id, 'Domanda lunga');
  const model = scripted([{ action: 'reply', text: 'Risposta.' }]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.equal(model.requests.length, 1);
  const text = read(model.requests[0]);
  assert.ok(!text.split('\n').includes('Messaggio 1'));
  assert.doesNotMatch(text, /Riassunto/);
  assert.match(text, /Messaggio 30/);
  const [{ count } = { count: -1 }] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM conversation_summaries WHERE conversation_id = ${secretary.id}`;
  assert.equal(count, 0);

  // A piece written before (by an older core) is never read.
  const [run] = await db().owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, effective_label)
    VALUES (${task.id}, 50, 'arianna', 'local', 'local', 'L2') RETURNING id::text`;
  const ids = await db().sql<{ id: string }[]>`SELECT id::text FROM messages WHERE conversation_id = ${secretary.id} ORDER BY id LIMIT 2`;
  await db().owner`
    INSERT INTO conversation_summaries (conversation_id, first_message_id, last_message_id, label, body, model, task_id, run_id)
    VALUES (${secretary.id}, ${ids[0]?.id ?? ''}::bigint, ${ids[1]?.id ?? ''}::bigint, 'L2', 'Riassunto vecchio.', 'local-large', ${task.id}, ${run?.id ?? ''})`;
  const view = await conversationView(db().sql, secretary.id, task.id, 10_000);
  assert.deepEqual([view.pieces, view.missing], [[], []]);
});

test('a click on the button opens a session: the model reads only what follows, and within it the history stays', async () => {
  const first = await openSecretary(db().sql);
  await seed(first.id, 4);
  const before = await ask(first.id, 'Cosa ho mercoledì?', 'Mercoledì niente.');
  // Before the new click the older messages count (same session).
  assert.match(before, /Messaggio 1/);

  const again = await openSecretary(db().sql);
  assert.equal(again.id, first.id);
  assert.ok(first.secretarySessionAt !== null && again.secretarySessionAt !== null);
  assert.ok(again.secretarySessionAt > first.secretarySessionAt);

  const thursday = await ask(first.id, 'Cosa ho giovedì?', 'Giovedì hai la banca.');
  assert.doesNotMatch(thursday, /Messaggio|mercoledì|Mercoledì/);
  assert.match(thursday, /Cosa ho giovedì\?/);

  // "E venerdì?" in the same session: the question before is still read.
  const friday = await ask(first.id, 'E venerdì?', 'Venerdì niente.');
  assert.match(friday, /Cosa ho giovedì\?[\s\S]*Giovedì hai la banca\.[\s\S]*E venerdì\?/);
  assert.doesNotMatch(friday, /Messaggio|mercoledì/);
});

test('a task begun before a click keeps its session: a later click changes nothing of what it reads', async () => {
  const secretary = await openSecretary(db().sql);
  await seed(secretary.id, 2);
  const { task } = await postUserMessage(db().sql, secretary.id, 'Cosa ho giovedì?');
  const before = await conversationView(db().sql, secretary.id, task.id, 10_000);
  // The user clicks again while the task is at work, or waits for a confirmation.
  await openSecretary(db().sql);
  const after = await conversationView(db().sql, secretary.id, task.id, 10_000);
  assert.deepEqual(after, before);
  assert.deepEqual(after.messages.map((row) => row.body), ['Messaggio 1', 'Messaggio 2', 'Cosa ho giovedì?']);
  // A session never goes back nor is cleared.
  await assert.rejects(db().sql`UPDATE conversations SET secretary_session_at = NULL WHERE id = ${secretary.id}`, /only goes forward/);
  await assert.rejects(db().sql`UPDATE conversations SET secretary_session_at = secretary_session_at - interval '1 hour' WHERE id = ${secretary.id}`, /only goes forward/);
  // Out of the way of the next tests: the conversation is free again.
  await db().owner`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
});

test('the other conversations are unchanged: every message counts and the anchor leaves messages to summarize', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  assert.equal(conversation.secretarySessionAt, null);
  await seed(conversation.id, 30);
  const { task } = await postUserMessage(db().sql, conversation.id, 'Domanda lunga');
  const view = await conversationView(db().sql, conversation.id, task.id, 10_000);
  assert.equal(view.missing.length, 21);
  assert.equal(view.messages.at(-1)?.body, 'Domanda lunga');
  // Only the secretary's conversation has a session.
  await assert.rejects(db().sql`UPDATE conversations SET secretary_session_at = now() WHERE id = ${conversation.id}`, /conversations_secretary_session/);
});

test('only the button opens a session: reading the conversation or writing in it does not', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [] });
  const base = `http://127.0.0.1:${String(server.port)}`;
  try {
    const opened = (await (await fetch(`${base}/api/secretary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as {
      conversation: { id: string; secretarySessionAt: string };
    };
    const at = opened.conversation.secretarySessionAt;
    assert.equal(typeof at, 'string');
    const fetched = (await (await fetch(`${base}/api/conversations/${opened.conversation.id}`)).json()) as { conversation: { secretarySessionAt: string } };
    assert.equal(fetched.conversation.secretarySessionAt, at);
    await postUserMessage(db().sql, opened.conversation.id, 'Domani devo chiamare il notaio');
    assert.equal((await loadConversation(db().sql, opened.conversation.id))?.secretarySessionAt?.toISOString(), at);

    const clicked = (await (await fetch(`${base}/api/secretary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as {
      conversation: { secretarySessionAt: string };
    };
    assert.ok(Date.parse(clicked.conversation.secretarySessionAt) > Date.parse(at));
  } finally {
    await server.close();
    await live.close();
  }
});

test('a click after a reminder not answered yet starts the session at the reminder (D-151): the model reads the report it answers', async () => {
  const conversation = await openSecretary(db().sql);
  const today = localDay();
  await db().sql`INSERT INTO commitments (body, day) VALUES ('Portare la bici finta dal meccanico', ${today}::date)`;
  // An assistant message without task that is not a reminder does not count.
  await seed(conversation.id, 2);
  assert.equal(await fireReminder(db().sql, today, 'evening'), 'written');
  const reminder = await db().sql<{ ts: Date }[]>`SELECT ts FROM messages WHERE conversation_id = ${conversation.id} AND body LIKE 'Resoconto di fine giornata%'`;
  const clicked = await openSecretary(db().sql);
  assert.equal(clicked.secretarySessionAt?.getTime(), reminder[0]?.ts.getTime());
  const answered = await ask(conversation.id, 'La bici non l’ho portata', 'Perché?');
  assert.match(answered, /Resoconto di fine giornata[\s\S]*Portare la bici finta[\s\S]*La bici non l’ho portata/);
  assert.doesNotMatch(answered, /Messaggio/);
  // Once answered, the next click starts from itself: the report is behind.
  const later = await openSecretary(db().sql);
  assert.ok(later.secretarySessionAt !== null && clicked.secretarySessionAt !== null && later.secretarySessionAt > clicked.secretarySessionAt);
  assert.doesNotMatch(await ask(conversation.id, 'Cosa ho domani?', 'Niente.'), /Resoconto|bici/);
});

test('the session never goes back (D-151): a click after a later one keeps it; the model reads from the "from" of the click', async () => {
  const conversation = await openSecretary(db().sql);
  const today = localDay();
  await db().sql`INSERT INTO commitments (body, day) VALUES ('Ritirare le scarpe finte dal calzolaio', ${today}::date)`;
  assert.equal(await fireReminder(db().sql, today, 'afternoon'), 'written');
  const atReminder = await openSecretary(db().sql);
  // A second click, still unanswered: the same start, never earlier.
  const again = await openSecretary(db().sql);
  assert.equal(again.secretarySessionAt?.getTime(), atReminder.secretarySessionAt?.getTime());
  // The event of the click says where the session starts, and the model reads from there.
  const [event] = await db().sql<{ from: Date | null }[]>`
    SELECT (payload ->> 'from')::timestamptz AS "from" FROM events WHERE kind = 'secretary.session' AND payload ->> 'conversationId' = ${conversation.id} ORDER BY id DESC LIMIT 1`;
  assert.ok(event?.from !== null && event?.from !== undefined);
  assert.equal(event.from.getTime(), atReminder.secretarySessionAt?.getTime());
  assert.match(await ask(conversation.id, 'Le scarpe le ho ritirate', 'Bene.'), /Promemoria del pomeriggio[\s\S]*scarpe finte/);
});

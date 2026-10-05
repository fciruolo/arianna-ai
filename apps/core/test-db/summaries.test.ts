// The anchored history of the orchestrator and its summary (D-077): the
// anchor computed from the database, the pieces written by the local model
// when it jumps, their labels, the guards of conversation_summaries and the purge.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';
import type { Label } from '@arianna/policy';
import { Secret } from '@arianna/vault';

import { archiveConversation, createConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import {
  conversationView,
  HISTORY_LIMITS,
  MAX_PIECES_PER_STEP,
  MAX_SUMMARY,
  PLACEHOLDER_PIECE,
  SUMMARY_MARK,
  SUMMARY_SCHEMA,
  SUMMARY_SCHEMA_NAME,
  SUMMARY_TIMEOUT_MS,
  writeMissingSummaries,
} from '../src/orchestrator/summaries.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const HOME = resolveHome({});
const agents = committedAgents(HOME);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = {
  allowedActions: () => agents.get('arianna')?.card.approvals ?? [],
  agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }),
};
const kb = createKb({ home: HOME, rules: RULES });

/** A scripted summary: the text of {"summary": ...}, an error, a raw answer of the model, or "hang". */
type Summary = string | LocalModelError | { text: string; value?: unknown; finishReason?: string };
const HANG = 'hang';

/**
 * A local model: requests with the summary schema are the summarizer's,
 * answered with the next scripted summary (default "Riassunto N."); the
 * others are the orchestrator's, answered with the next scripted answer.
 * "hang" answers only when the signal aborts, as the adapter does.
 */
function fake(answers: Answer[], summaries: Summary[] = [], onSummary?: () => Promise<void>) {
  const requests: ChatRequest[] = [];
  const summaryRequests: ChatRequest[] = [];
  const answerRequests: ChatRequest[] = [];
  const model: LocalModel = {
    chat(request) {
      requests.push(request);
      const reply = (text: string, value?: unknown, finishReason = 'stop') =>
        Promise.resolve({ text, ...(value === undefined ? {} : { value }), finishReason, usage: { promptTokens: 7, completionTokens: 3 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
      if (request.schema?.name === SUMMARY_SCHEMA_NAME) {
        summaryRequests.push(request);
        const next = summaries[summaryRequests.length - 1] ?? `Riassunto ${String(summaryRequests.length)}.`;
        const before = onSummary === undefined ? Promise.resolve() : onSummary();
        return before.then(() => {
          if (next instanceof LocalModelError) return Promise.reject(next);
          if (next === HANG) {
            return new Promise<never>((_, reject) => {
              request.signal?.addEventListener('abort', () => {
                reject(new LocalModelError('cancelled', 'stub: aborted', { endpoint: 'stub' }));
              });
            });
          }
          if (typeof next === 'string') return reply(JSON.stringify({ summary: next }), { summary: next });
          return reply(next.text, next.value, next.finishReason);
        });
      }
      if (request.schema === undefined) return Promise.reject(new Error('the orchestrator always asks a schema'));
      answerRequests.push(request);
      const next = answers[answerRequests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = JSON.stringify(request.schema.schema).includes('"thought"') ? { thought: 'Ragiono.', ...next } : next;
      return reply(JSON.stringify(value), value);
    },
  };
  return { model, requests, summaryRequests, answerRequests };
}

function orchestrator(model: LocalModel) {
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb,
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() } }),
    rules: RULES,
  });
}

async function drain(taskId: string, model: LocalModel): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const executor = orchestrator(model);
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

/** `count` earlier messages, user and assistant in turn, written as the owner; `labels` overrides the label of some (1-based). */
async function seed(conversationId: string, count: number, from = 1, labels: Record<number, Label> = {}, base: Label = 'L1'): Promise<void> {
  for (let index = from; index < from + count; index += 1) {
    const role = index % 2 === 1 ? 'user' : 'assistant';
    await db().owner`
      INSERT INTO messages (conversation_id, role, label, body)
      VALUES (${conversationId}, ${role}, ${labels[index] ?? base}, ${`Messaggio ${String(index)}`})`;
  }
}

async function pieces(conversationId: string) {
  return [...await db().sql<{ first: string; last: string; label: Label; body: string; model: string }[]>`
    SELECT f.body AS first, l.body AS last, s.label, s.body, s.model
    FROM conversation_summaries s JOIN messages f ON f.id = s.first_message_id JOIN messages l ON l.id = s.last_message_id
    WHERE s.conversation_id = ${conversationId} ORDER BY s.id`];
}

/** The reasons of the events summary.degraded of a task, in order. */
async function degraded(taskId: string): Promise<string[]> {
  const rows = await db().sql<{ reason: string; label: string; keys: string }[]>`
    SELECT payload ->> 'reason' AS reason, label, (SELECT string_agg(key, ',' ORDER BY key) FROM jsonb_object_keys(payload) key) AS keys
    FROM events WHERE kind = 'summary.degraded' AND task_id = ${taskId} ORDER BY id`;
  // No text of the messages: only the conversation and a reason from a closed list.
  for (const row of rows) assert.deepEqual([row.label, row.keys], ['L0', 'conversationId,reason']);
  return rows.map((row) => row.reason);
}

const contents = (request: ChatRequest | undefined) => (request?.messages ?? []).map((message) => message.content);

test('a short conversation is read whole, without a summary', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  await seed(conversation.id, 5);
  const { task } = await postUserMessage(db().sql, conversation.id, 'Domanda breve');
  const fakeModel = fake([{ action: 'reply', text: 'Risposta.' }]);
  assert.deepEqual(await drain(task.id, fakeModel.model), ['answered']);
  assert.equal(fakeModel.summaryRequests.length, 0);
  assert.deepEqual(await pieces(conversation.id), []);
  const read = contents(fakeModel.answerRequests[0]).slice(1);
  // Two user messages in a row reach the model as one (D-092).
  assert.deepEqual(read, ['Messaggio 1', 'Messaggio 2', 'Messaggio 3', 'Messaggio 4', 'Messaggio 5\n\nDomanda breve']);
});

test('past the maximum the anchor jumps: the local model summarizes what it left, with the highest label', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  // 30 earlier messages and the question: 31 > 30, the anchor leaves the newest 10.
  await seed(conversation.id, 30, 1, { 7: 'L2' }, 'L0');
  const { task } = await postUserMessage(db().sql, conversation.id, 'Domanda lunga');
  const fakeModel = fake([{ action: 'reply', text: 'Risposta.' }]);
  assert.deepEqual(await drain(task.id, fakeModel.model), ['answered']);

  // One piece, written by the orchestrator's model before the answer, over messages 1-21.
  assert.equal(fakeModel.summaryRequests.length, 1);
  assert.equal(fakeModel.requests[0], fakeModel.summaryRequests[0]);
  assert.equal(fakeModel.summaryRequests[0]?.model, 'local-large');
  // Constrained to {"summary": string}: no free text where a reasoning model writes its reasoning.
  assert.deepEqual(fakeModel.summaryRequests[0].schema, { name: SUMMARY_SCHEMA_NAME, schema: SUMMARY_SCHEMA });
  assert.deepEqual(SUMMARY_SCHEMA, {
    type: 'object',
    properties: { summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY } },
    required: ['summary'],
    additionalProperties: false,
  });
  assert.equal(fakeModel.summaryRequests[0].timeoutMs, SUMMARY_TIMEOUT_MS);
  assert.equal(SUMMARY_TIMEOUT_MS, 90_000);
  const input = contents(fakeModel.summaryRequests[0])[1] ?? '';
  assert.equal(input.split('\n').length, 21);
  assert.deepEqual(JSON.parse(input.split('\n')[0] ?? ''), { role: 'user', text: 'Messaggio 1' });
  assert.deepEqual(JSON.parse(input.split('\n')[20] ?? ''), { role: 'user', text: 'Messaggio 21' });
  assert.deepEqual(await pieces(conversation.id), [{ first: 'Messaggio 1', last: 'Messaggio 21', label: 'L2', body: 'Riassunto 1.', model: 'local-large' }]);

  // The answer reads the summary first, then the newest 10 messages.
  const read = contents(fakeModel.answerRequests[0]).slice(1);
  assert.equal(read.length, 1 + HISTORY_LIMITS.keepCount);
  assert.equal(read[0], `${SUMMARY_MARK}\n\nRiassunto 1.`);
  assert.equal(read[1], 'Messaggio 22');
  assert.equal(read.at(-1), 'Domanda lunga');

  // The summary passed the gateway towards the local model with its label; the task read L2.
  const log = await db().sql<{ target: string; label: string }[]>`
    SELECT target, label FROM gateway_log WHERE task_id = ${task.id} ORDER BY id`;
  assert.deepEqual([...log].map((row) => [row.target, row.label]).slice(0, 2), [
    ['local', 'L2'],
    ['local', 'L2'],
  ]);
  assert.equal((await loadTask(db().sql, task.id))?.effectiveLabel, 'L2');
  // The summarizer's tokens count in the run.
  const [usage] = await db().sql<{ tokens: string }[]>`SELECT sum(tokens_in)::text AS tokens FROM runs WHERE task_id = ${task.id}`;
  assert.equal(usage?.tokens, '14');
});

test('a piece over messages up to L1 is L1, not more', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  await seed(conversation.id, 30);
  const { task } = await postUserMessage(db().sql, conversation.id, 'Domanda');
  const fakeModel = fake([{ action: 'reply', text: 'Risposta.' }]);
  assert.deepEqual(await drain(task.id, fakeModel.model), ['answered']);
  assert.deepEqual((await pieces(conversation.id)).map((piece) => [piece.label, piece.model]), [['L1', 'local-large']]);
});

test('the prefix stays the same between the steps of a task and between tasks, until the next jump appends a piece', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 30);
  const first = await postUserMessage(sql, conversation.id, 'Prima domanda');
  const firstModel = fake([
    { action: 'call', tool: 'kb.search', arguments: { query: 'contratto' } },
    { action: 'reply', text: 'Prima risposta.' },
  ]);
  assert.deepEqual(await drain(first.task.id, firstModel.model), ['continued', 'answered']);
  // One summary for the task; both steps read the same conversation, the turns after it.
  assert.equal(firstModel.summaryRequests.length, 1);
  const prefix = contents(firstModel.answerRequests[0]).slice(0, 2 + HISTORY_LIMITS.keepCount);
  assert.deepEqual(contents(firstModel.answerRequests[1]).slice(0, prefix.length), prefix);

  // The next task: no new summary, same summary and anchor, its own messages after them.
  const second = await postUserMessage(sql, conversation.id, 'Seconda domanda');
  const secondModel = fake([{ action: 'reply', text: 'Seconda risposta.' }]);
  assert.deepEqual(await drain(second.task.id, secondModel.model), ['answered']);
  assert.equal(secondModel.summaryRequests.length, 0);
  const read = contents(secondModel.answerRequests[0]);
  assert.deepEqual(read.slice(0, prefix.length), prefix);
  assert.deepEqual(read.slice(prefix.length), ['Prima risposta.', 'Seconda domanda']);

  // 13 messages after the anchor; 17 more and a question make 31: the anchor jumps again.
  await seed(conversation.id, 17, 100);
  const third = await postUserMessage(sql, conversation.id, 'Terza domanda');
  const thirdModel = fake([{ action: 'reply', text: 'Terza risposta.' }], ['Secondo riassunto.']);
  assert.deepEqual(await drain(third.task.id, thirdModel.model), ['answered']);
  assert.equal(thirdModel.summaryRequests.length, 1);
  const all = await pieces(conversation.id);
  assert.deepEqual(all.map((piece) => [piece.first, piece.last, piece.body]), [
    ['Messaggio 1', 'Messaggio 21', 'Riassunto 1.'],
    ['Messaggio 22', 'Messaggio 107', 'Secondo riassunto.'],
  ]);
  // The summary grew at its end only: the text read before is the start of the new one.
  const summary = contents(thirdModel.answerRequests[0])[1] ?? '';
  assert.ok(summary.startsWith(prefix[1] ?? '-'));
  assert.equal(summary, `${SUMMARY_MARK}\n\nRiassunto 1.\n\nSecondo riassunto.`);
  assert.equal(contents(thirdModel.answerRequests[0]).length, 2 + HISTORY_LIMITS.keepCount);
});

test('when the summary fails the task still answers, with the anchored window and no summary; the next task writes it', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 30);
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda');
  const broken = fake(
    [
      { action: 'call', tool: 'kb.search', arguments: { query: 'contratto' } },
      { action: 'reply', text: 'Risposta.' },
    ],
    [new LocalModelError('unavailable', 'stub: down', { endpoint: 'stub' })],
  );
  assert.deepEqual(await drain(task.id, broken.model), ['continued', 'answered']);
  assert.deepEqual(await pieces(conversation.id), []);
  // Only the first step of the task tries: the second one reads the same window.
  assert.equal(broken.summaryRequests.length, 1);
  assert.deepEqual(await degraded(task.id), ['model-error']);
  const read = contents(broken.answerRequests[0]).slice(1);
  assert.equal(read[0], 'Messaggio 22');
  assert.equal(read.length, HISTORY_LIMITS.keepCount);
  assert.ok(!read.some((content) => content.startsWith(SUMMARY_MARK)));

  // An empty summary is no summary either.
  const next = await postUserMessage(sql, conversation.id, 'Altra domanda');
  const empty = fake([{ action: 'reply', text: 'Risposta.' }], ['   ']);
  assert.deepEqual(await drain(next.task.id, empty.model), ['answered']);
  assert.deepEqual(await pieces(conversation.id), []);
  assert.deepEqual(await degraded(next.task.id), ['empty-summary']);

  const last = await postUserMessage(sql, conversation.id, 'Ultima domanda');
  const working = fake([{ action: 'reply', text: 'Risposta.' }]);
  assert.deepEqual(await drain(last.task.id, working.model), ['answered']);
  assert.deepEqual((await pieces(conversation.id)).map((piece) => [piece.first, piece.last]), [['Messaggio 1', 'Messaggio 21']]);
});

/** A task of the conversation with a running run of `locality`, as the engine opens it. */
async function taskWithRun(conversationId: string, locality: 'local' | 'cloud' = 'local'): Promise<{ taskId: string; runId: string }> {
  const { task } = await postUserMessage(db().sql, conversationId, 'Domanda del test');
  const [run] = await db().owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, effective_label)
    VALUES (${task.id}, 1, 'arianna', ${locality === 'local' ? 'local' : 'claude'}, ${locality}, 'L1') RETURNING id::text`;
  if (run === undefined) throw new Error('no run');
  return { taskId: task.id, runId: run.id };
}

async function messageIds(conversationId: string): Promise<string[]> {
  const rows = await db().sql<{ id: string }[]>`SELECT id::text FROM messages WHERE conversation_id = ${conversationId} ORDER BY messages.id`;
  return rows.map((row) => row.id);
}

function insertPiece(values: { conversationId: string; first: string; last: string; label: Label; taskId: string; runId: string; model?: string }) {
  return db().sql`
    INSERT INTO conversation_summaries (conversation_id, first_message_id, last_message_id, label, body, model, task_id, run_id)
    VALUES (${values.conversationId}, ${values.first}::bigint, ${values.last}::bigint, ${values.label}::privacy_label, 'Riassunto.',
      ${values.model ?? 'local-large'}, ${values.taskId}, ${values.runId})`;
}

test('conversation_summaries: from a running local run, at least the label of its messages, appended after the last piece', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 6, 1, { 3: 'L2' }, 'L0');
  const { taskId, runId } = await taskWithRun(conversation.id);
  const [m1, , m3, m4, m5, m6] = await messageIds(conversation.id);
  const base = { conversationId: conversation.id, taskId, runId };

  await assert.rejects(insertPiece({ ...base, first: m1 ?? '', last: m4 ?? '', label: 'L1' }), /below the label L2/);
  await assert.rejects(insertPiece({ ...base, first: m1 ?? '', last: m4 ?? '', label: 'L2', model: 'claude' }), /check constraint/);
  await assert.rejects(insertPiece({ ...base, first: m1 ?? '', last: m4 ?? '', label: 'L2', model: 'local-small' }), /check constraint/);
  // The first piece starts at the first message: none is left out.
  await assert.rejects(insertPiece({ ...base, first: m3 ?? '', last: m4 ?? '', label: 'L2' }), /leaving no message out/);
  await insertPiece({ ...base, first: m1 ?? '', last: m4 ?? '', label: 'L2' });
  assert.equal((await loadTask(sql, taskId))?.effectiveLabel, 'L2');
  // Overlapping or before the last piece: refused. After it, any label at least the messages'.
  await assert.rejects(insertPiece({ ...base, first: m3 ?? '', last: m5 ?? '', label: 'L2' }), /appended after the last one/);
  await assert.rejects(insertPiece({ ...base, first: m6 ?? '', last: m6 ?? '', label: 'L0' }), /leaving no message out/);
  await insertPiece({ ...base, first: m5 ?? '', last: m6 ?? '', label: 'L0' });

  // Append-only, even for the owner.
  await assert.rejects(owner`UPDATE conversation_summaries SET body = 'altro' WHERE conversation_id = ${conversation.id}`, /append-only/);
  await assert.rejects(owner`DELETE FROM conversation_summaries WHERE conversation_id = ${conversation.id}`, /append-only/);
  // The core has no DELETE at all.
  await assert.rejects(sql`DELETE FROM conversation_summaries WHERE conversation_id = ${conversation.id}`, /permission denied/);
});

test('conversation_summaries: never from a cloud run, a stopped run, another conversation, or above the clearance', async () => {
  const { sql, owner } = db();
  const work = await createConversation(sql, { mode: 'work', project: 'demo', projects: ['demo'] });
  await seed(work.id, 4);
  const [w1, , , w4] = await messageIds(work.id);
  const cloud = await taskWithRun(work.id, 'cloud');
  await assert.rejects(insertPiece({ conversationId: work.id, first: w1 ?? '', last: w4 ?? '', label: 'L1', ...cloud }), /only the local model/);

  const local = await taskWithRun(work.id);
  // A work conversation holds at most L1: a piece above it is refused, so Claude never meets one.
  await assert.rejects(insertPiece({ conversationId: work.id, first: w1 ?? '', last: w4 ?? '', label: 'L2', ...local }), /above the clearance/);

  const other = await createConversation(sql, { mode: 'private' });
  await seed(other.id, 2);
  const [o1, o2] = await messageIds(other.id);
  await assert.rejects(insertPiece({ conversationId: work.id, first: o1 ?? '', last: o2 ?? '', label: 'L1', ...local }), /not of conversation/);
  await assert.rejects(insertPiece({ conversationId: other.id, first: o1 ?? '', last: o2 ?? '', label: 'L1', ...local }), /does not belong/);

  await owner`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${local.runId}`;
  await assert.rejects(insertPiece({ conversationId: work.id, first: w1 ?? '', last: w4 ?? '', label: 'L1', ...local }), /not a running run/);
});

test('deleting a conversation deletes its summary; other conversations keep theirs', async () => {
  const { sql, owner } = db();
  const kept = await createConversation(sql, { mode: 'private' });
  await seed(kept.id, 30);
  const keptTask = await postUserMessage(sql, kept.id, 'Resta');
  assert.deepEqual(await drain(keptTask.task.id, fake([{ action: 'reply', text: 'Ok.' }]).model), ['answered']);

  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 30);
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda');
  assert.deepEqual(await drain(task.id, fake([{ action: 'reply', text: 'Risposta.' }]).model), ['answered']);
  assert.equal((await pieces(conversation.id)).length, 1);

  await archiveConversation(sql, conversation.id, true);
  await purgeConversation(sql, conversation.id);
  const left = await owner`SELECT 1 FROM conversation_summaries WHERE conversation_id = ${conversation.id}`;
  assert.equal(left.length, 0);
  assert.equal((await pieces(kept.id)).length, 1);
  // The guard is on again after the purge.
  await assert.rejects(owner`DELETE FROM conversation_summaries WHERE conversation_id = ${kept.id}`, /append-only/);
});

test('a range the gateway blocks becomes a placeholder piece, without content and once', async () => {
  const { sql } = db();
  const secret = new Secret('vault://summary-test', 'fake-summary-secret-abcdef0123456789');
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 4);
  await db().owner`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversation.id}, 'assistant', 'L1', ${`la chiave è ${secret.reveal()}`})`;
  await seed(conversation.id, 25, 6);
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda');
  const fakeModel = fake([{ action: 'reply', text: 'Risposta.' }]);
  assert.deepEqual(await drain(task.id, fakeModel.model), ['answered']);
  // The model never read the range; the placeholder carries its label and moves the base on.
  assert.equal(fakeModel.summaryRequests.length, 0);
  assert.deepEqual((await pieces(conversation.id)).map((piece) => [piece.first, piece.last, piece.label, piece.body]), [
    ['Messaggio 1', 'Messaggio 21', 'L1', PLACEHOLDER_PIECE],
  ]);
  assert.equal(contents(fakeModel.answerRequests[0])[1], `${SUMMARY_MARK}\n\n${PLACEHOLDER_PIECE}`);
  assert.ok(!contents(fakeModel.answerRequests[0]).some((content) => content.includes(secret.reveal())));
  const blocks = async () => (await sql`SELECT 1 FROM gateway_log WHERE decision = 'block' AND task_id IN (SELECT id FROM tasks WHERE conversation_id = ${conversation.id})`).length;
  assert.equal(await blocks(), 1);

  // The next task finds the range covered: no second block.
  const next = await postUserMessage(sql, conversation.id, 'Altra domanda');
  assert.deepEqual(await drain(next.task.id, fake([{ action: 'reply', text: 'Ok.' }]).model), ['answered']);
  assert.equal(await blocks(), 1);
});

test('a range above the clearance of the task gets no piece and no gateway row', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 30, 1, { 3: 'L2' });
  const { taskId, runId } = await taskWithRun(conversation.id);
  const loaded = await loadTask(sql, taskId);
  assert.ok(loaded !== undefined);
  const task = { ...loaded, clearance: 'L1' as const };
  const fakeModel = fake([]);
  const view = await conversationView(sql, conversation.id, taskId, 8_000);
  assert.ok(view.missing.length > 0);
  const outcome = await writeMissingSummaries({ sql, model: () => fakeModel.model }, task, { runId, signal: new AbortController().signal }, view);
  assert.deepEqual([outcome.written, outcome.degraded], [0, 'above-clearance']);
  assert.equal(fakeModel.requests.length, 0);
  assert.deepEqual(await pieces(conversation.id), []);
  assert.equal((await sql`SELECT 1 FROM gateway_log WHERE run_id = ${runId}`).length, 0);
  assert.deepEqual(await degraded(taskId), ['above-clearance']);
});

test('a piece another task appended first is the one the history reads', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 30);
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda');
  const [m1, m21] = (await messageIds(conversation.id)).filter((_, index) => index === 0 || index === 20);
  // While the model summarizes, another task of the conversation appends the same range.
  const other = async () => {
    const { taskId, runId } = await taskWithRun(conversation.id);
    await owner`
      INSERT INTO conversation_summaries (conversation_id, first_message_id, last_message_id, label, body, model, task_id, run_id)
      VALUES (${conversation.id}, ${m1 ?? ''}::bigint, ${m21 ?? ''}::bigint, 'L1', 'Riassunto dell’altro task.', 'local-large', ${taskId}, ${runId})`;
  };
  const fakeModel = fake([{ action: 'reply', text: 'Risposta.' }], [], other);
  assert.deepEqual(await drain(task.id, fakeModel.model), ['answered']);
  assert.deepEqual((await pieces(conversation.id)).map((piece) => piece.body), ['Riassunto dell’altro task.']);
  assert.equal(contents(fakeModel.answerRequests[0])[1], `${SUMMARY_MARK}\n\nRiassunto dell’altro task.`);
  assert.deepEqual(await degraded(task.id), ['conflict']);
});

test('a cancelled step stops with its error, without a piece or an event', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 30);
  const { taskId, runId } = await taskWithRun(conversation.id);
  const task = await loadTask(sql, taskId);
  assert.ok(task !== undefined);
  const controller = new AbortController();
  controller.abort();
  const cancelled = fake([], [new LocalModelError('cancelled', 'stub: cancelled', { endpoint: 'stub' })]);
  const view = await conversationView(sql, conversation.id, taskId, 8_000);
  await assert.rejects(
    writeMissingSummaries({ sql, model: () => cancelled.model }, task, { runId, signal: controller.signal }, view),
    (error: unknown) => error instanceof LocalModelError && error.kind === 'cancelled',
  );
  assert.deepEqual(await pieces(conversation.id), []);
  assert.deepEqual(await degraded(taskId), []);
});

test('one piece per step before the answer; the first step of the next task goes on', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await owner`
    INSERT INTO messages (conversation_id, role, label, body)
    SELECT ${conversation.id}, CASE WHEN n % 2 = 1 THEN 'user' ELSE 'assistant' END, 'L1', 'Messaggio ' || n
    FROM generate_series(1, 120) n`;
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda');
  assert.equal(MAX_PIECES_PER_STEP, 1);
  const first = fake([{ action: 'reply', text: 'Risposta.' }]);
  assert.deepEqual(await drain(task.id, first.model), ['answered']);
  assert.equal(first.summaryRequests.length, 1);
  assert.equal((await pieces(conversation.id)).length, 1);
  assert.deepEqual(await degraded(task.id), ['piece-limit']);

  const next = await postUserMessage(sql, conversation.id, 'Altra domanda');
  assert.deepEqual(await drain(next.task.id, fake([{ action: 'reply', text: 'Ok.' }]).model), ['answered']);
  const all = await pieces(conversation.id);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((piece) => piece.first), ['Messaggio 1', 'Messaggio 31']);
  assert.deepEqual(await degraded(next.task.id), ['piece-limit']);
});

/** A task over 30 earlier messages, its view, and what the summarizer did with `summary`. */
async function summarizeOnce(summary: Summary, timeoutMs?: number) {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await seed(conversation.id, 30);
  const { taskId, runId } = await taskWithRun(conversation.id);
  const task = await loadTask(sql, taskId);
  assert.ok(task !== undefined);
  const model = fake([], [summary]);
  const view = await conversationView(sql, conversation.id, taskId, 8_000);
  assert.ok(view.missing.length > 0);
  const env = timeoutMs === undefined ? { sql, model: () => model.model } : { sql, model: () => model.model, timeoutMs };
  const outcome = await writeMissingSummaries(env, task, { runId, signal: new AbortController().signal }, view);
  return { outcome, model, pieces: await pieces(conversation.id), events: await degraded(taskId) };
}

test('free reasoning instead of the JSON summary gives no piece, only an event', async () => {
  const reasoning = 'We need to summarize the conversation. Let\'s parse conversation: {"role": "user", "text": "Messaggio 1"}';
  // The adapter refuses an answer that is not JSON when a schema was asked.
  const notJson = await summarizeOnce(new LocalModelError('bad-response', 'stub: content is not JSON', { endpoint: 'stub' }));
  assert.deepEqual([notJson.outcome.written, notJson.outcome.degraded, notJson.pieces, notJson.events], [0, 'bad-response', [], ['bad-response']]);
  // JSON of another shape, or a summary with control characters or too long, is not a summary either.
  const wrongValues: unknown[] = [
    { thought: reasoning },
    { summary: reasoning, extra: 1 },
    { summary: 42 },
    ['Riassunto'],
    { summary: 'Riassunto\u0007.' },
    { summary: 'a'.repeat(MAX_SUMMARY + 1) },
  ];
  for (const value of wrongValues) {
    const wrong = await summarizeOnce({ text: JSON.stringify(value), value });
    assert.deepEqual([wrong.outcome.written, wrong.pieces, wrong.events], [0, [], ['bad-response']], JSON.stringify(value).slice(0, 60));
  }
  const empty = await summarizeOnce({ text: '{"summary": "  "}', value: { summary: '  ' } });
  assert.deepEqual([empty.pieces, empty.events], [[], ['empty-summary']]);
  // A summary on more lines is fine.
  const good = await summarizeOnce({ text: '', value: { summary: ' Prima riga.\nSeconda riga. ' } });
  assert.deepEqual([good.outcome.written, good.pieces.map((piece) => piece.body), good.events], [1, ['Prima riga.\nSeconda riga.'], []]);
});

test('a summary stopped by the token limit gives no piece, only an event', async () => {
  const value = { summary: 'Il riassunto si ferma a metà' };
  const truncated = await summarizeOnce({ text: JSON.stringify(value), value, finishReason: 'length' });
  assert.deepEqual([truncated.outcome.written, truncated.outcome.degraded, truncated.pieces, truncated.events], [0, 'truncated', [], ['truncated']]);
  // The tokens it spent still count.
  assert.deepEqual([truncated.outcome.tokensIn, truncated.outcome.tokensOut], [7, 3]);
});

test('a summary past its timeout gives no piece, only an event, and the step is not cancelled', async () => {
  const slow = await summarizeOnce(HANG, 50);
  assert.deepEqual([slow.outcome.written, slow.outcome.degraded, slow.pieces, slow.events], [0, 'timeout', [], ['timeout']]);
  assert.equal(slow.model.summaryRequests[0]?.timeoutMs, 50);
  // The adapter's own timeout is a timeout too.
  const adapter = await summarizeOnce(new LocalModelError('timeout', 'stub: timed out', { endpoint: 'stub' }));
  assert.deepEqual([adapter.outcome.degraded, adapter.events], ['timeout', ['timeout']]);
});

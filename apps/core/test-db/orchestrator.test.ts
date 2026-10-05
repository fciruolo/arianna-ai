import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer, type Autonomy } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { createContext } from '@arianna/policy';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, resumeTask, scheduleTask, STEP_QUEUE, submitTask, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { hasOpenCards, updateCard } from '../src/orchestrator/cards.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { recordFailure } from '../src/failures.ts';
import { createOrchestrator, SYSTEM_MESSAGE_MARK } from '../src/orchestrator/orchestrator.ts';
import { openFailureChat } from '../src/system-chats.ts';
import { loadTurns } from '../src/orchestrator/turns.ts';
import { openReply } from '../src/reply.ts';
import { loadTask, moveTask, type Task } from '../src/tasks.ts';
import { listWaitingTasks } from '../src/waiting.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const HOME = resolveHome({});
const agents = committedAgents(HOME);
const OPTIONS = {
  allowedActions: () => agents.get('arianna')?.card.approvals ?? [],
  agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }),
};

const scratch = join(HOME, 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fakeKb() {
  const page = (path: string, text: string) => {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), text);
  };
  page('kb/work/rossi.md', '---\ntitle: Rossi Srl\n---\n\nIl contratto di assistenza scade il 31 marzo 2027.');
  page('kb/private/affitto.md', "---\ntitle: Affitto via Roma\n---\n\nLa caparra del contratto d'affitto è di tre mensilità.");
  const rules = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n\n[[folder]]\npath = "kb/private"\nlabel = "L2"\n');
  return createKb({ home: scratch, rules });
}
const kb = fakeKb();
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
/** An orchestrator without delegation: no cloud executor. */
const orchestrator = (model: LocalModel) =>
  createOrchestrator({ sql: db().sql, agents, kb, model: () => model, settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() } }), rules: RULES });

type Scripted = (Answer & { thought?: string }) | LocalModelError | 'not-json';

/** A local model that answers each call with the next scripted answer, and records the requests. */
function scripted(answers: Scripted[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      if (next instanceof LocalModelError) return Promise.reject(next);
      if (next === 'not-json') return Promise.reject(new LocalModelError('bad-response', 'stub: content is not JSON', { endpoint: 'stub' }));
      // The thought comes first, as under the schema; the fallback has none.
      const value = request.schema?.schema !== undefined && JSON.stringify(request.schema.schema).includes('"thought"') ? { thought: 'Ragiono.', ...next } : next;
      return Promise.resolve({
        text: JSON.stringify(value),
        value,
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 20 },
        endpoint: 'stub',
        model: 'stub',
        durationMs: 1,
      });
    },
  };
}

/** Runs the steps of `taskId` until none is left. Jobs of other tasks are leftovers of earlier tests: closed. */
async function drain(taskId: string, model: LocalModel, executor: StepExecutor = orchestrator(model)): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 40; guard += 1) {
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

async function ask(mode: 'work' | 'private', body: string) {
  const conversation =
    mode === 'work'
      ? await createConversation(db().sql, { mode, project: 'demo', projects: ['demo'] })
      : await createConversation(db().sql, { mode });
  return postUserMessage(db().sql, conversation.id, body);
}

async function assistantMessages(taskId: string) {
  return db().sql<{ id: string; body: string; label: string }[]>`
    SELECT id::text, body, label FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id`;
}

test('a multi-step task: search, read, answer in the chat', async () => {
  const { task } = await ask('private', "Cosa dice il contratto d'affitto sulla caparra?");
  const model = scripted([
    { action: 'call', tool: 'kb.search', arguments: { query: 'caparra affitto' } },
    { action: 'call', tool: 'kb.read', arguments: { path: 'kb/private/affitto.md' } },
    { action: 'reply', text: 'La caparra è di tre mensilità.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);

  const done = await loadTask(db().sql, task.id);
  const [message] = await assistantMessages(task.id);
  assert.deepEqual([done?.status, done?.effectiveLabel], ['done', 'L2']);
  assert.deepEqual(done?.evidence, [{ kind: 'message', ref: message?.id }]);
  assert.deepEqual([message?.body, message?.label], ['La caparra è di tre mensilità.', 'L2']);

  // The model saw the search result before reading, and the page before answering, as data.
  const [first, second, third] = model.requests;
  assert.ok(first !== undefined);
  assert.equal(first.model, 'local-large');
  assert.equal(first.messages.at(-1)?.content, "Cosa dice il contratto d'affitto sulla caparra?");
  assert.match(second?.messages.at(-1)?.content ?? '', /^<tool_result>\n1\. kb\/private\/affitto\.md/);
  assert.match(third?.messages.at(-1)?.content ?? '', /tre mensilità/);
  // Past answers come back without their thought.
  assert.equal(third?.messages.at(-2)?.content, JSON.stringify({ action: 'call', tool: 'kb.read', arguments: { path: 'kb/private/affitto.md' } }));
  assert.ok(model.requests.every((request) => request.messages.every((m) => !m.content.includes('Ragiono'))));

  const turns = await loadTurns(db().sql, task.id);
  assert.deepEqual(
    turns.map((turn) => [turn.step, turn.answer.action, turn.label, turn.thought]),
    [
      [1, 'call', 'L2', 'Ragiono.'],
      [2, 'call', 'L2', 'Ragiono.'],
      [3, 'reply', 'L2', 'Ragiono.'],
    ],
  );
  assert.equal(turns[2]?.messageId, message?.id);

  // Every model call and the answer passed the gateway.
  const log = await db().sql<{ target: string; decision: string; label: string }[]>`
    SELECT target, decision, label FROM gateway_log WHERE task_id = ${task.id} ORDER BY id`;
  assert.deepEqual(
    log.map((row) => [row.target, row.decision]),
    [
      ['local', 'allow'],
      ['local', 'allow'],
      ['local', 'allow'],
      ['web', 'allow'],
    ],
  );
  const [usage] = await db().sql<{ steps: number; tokens: string }[]>`
    SELECT sum(steps_used)::int AS steps, sum(tokens_in)::text AS tokens FROM runs WHERE task_id = ${task.id}`;
  assert.deepEqual(usage, { steps: 3, tokens: '300' });
});

test('in a work conversation a private page is refused and the label stays L1', async () => {
  const { task } = await ask('work', "Leggi kb/private/affitto.md e dimmi quant'è la caparra.");
  const model = scripted([
    { action: 'call', tool: 'kb.read', arguments: { path: 'kb/private/affitto.md' } },
    { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } },
    { action: 'reply', text: 'Non posso leggerla qui: apri una conversazione privata.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: kb\.read: page kb\/private\/affitto\.md is above what this conversation may read/);
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', /no pages match 'caparra'\nPrivate pages were not searched/);
  assert.doesNotMatch(model.requests[2]?.messages.map((m) => m.content).join('\n') ?? '', /tre mensilità/);
  const done = await loadTask(db().sql, task.id);
  assert.deepEqual([done?.status, done?.effectiveLabel], ['done', 'L1']);
  assert.deepEqual((await loadTurns(db().sql, task.id)).map((turn) => turn.label), ['L1', 'L1', 'L1']);
});

test('a work page read raises the task only to L1, a private one to L2', async () => {
  const { task } = await ask('work', 'Quando scade il contratto Rossi?');
  const model = scripted([
    { action: 'call', tool: 'kb.read', arguments: { path: 'kb/work/rossi.md' } },
    { action: 'reply', text: 'Il 31 marzo 2027.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'answered']);
  assert.equal((await assistantMessages(task.id))[0]?.label, 'L1');
});

test('a plan continues the task and is followed by its first step', async () => {
  const { task } = await ask('private', 'Organizza il trasloco: preventivi, utenze, residenza.');
  const model = scripted([
    { action: 'plan', steps: ['Chiedere tre preventivi', 'Disdire le utenze', 'Cambiare la residenza'] },
    { action: 'call', tool: 'task.create', arguments: { title: 'Chiedere tre preventivi per il trasloco' } },
    { action: 'reply', text: 'Ho creato la prima carta nella Inbox.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /Plan noted/);
  const cards = await db().sql<{ title: string; status: string; label: string; assignee: string }[]>`
    SELECT title, status, label, assignee FROM tasks WHERE parent_id = ${task.id}`;
  assert.deepEqual([...cards], [{ title: 'Chiedere tre preventivi per il trasloco', status: 'inbox', label: 'L2', assignee: 'user' }]);
});

test('a question to the user ends the task with a message', async () => {
  const { task } = await ask('private', 'Mandalo a lui.');
  const model = scripted([{ action: 'call', tool: 'user.ask', arguments: { question: 'A chi e cosa devo mandare?' } }]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.equal((await assistantMessages(task.id))[0]?.body, 'A chi e cosa devo mandare?');
});

test('a refusal is written in the chat', async () => {
  const { task } = await ask('private', 'Paga la bolletta della luce.');
  assert.deepEqual(await drain(task.id, scripted([{ action: 'refuse', reason: 'Non posso fare pagamenti.' }])), ['answered']);
  assert.equal((await assistantMessages(task.id))[0]?.body, 'Non posso fare pagamenti.');
});

test('an answer that is not JSON is asked again without the thought', async () => {
  const { task } = await ask('private', 'Ciao');
  const model = scripted(['not-json', { action: 'reply', text: 'Ciao!' }]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.match(JSON.stringify(model.requests[0]?.schema?.schema), /"thought"/);
  assert.doesNotMatch(JSON.stringify(model.requests[1]?.schema?.schema), /"thought"/);
  assert.equal((await loadTurns(db().sql, task.id))[0]?.thought, null);
});

test('the same call again is not run: the model reads an error and takes another step (D-076)', async () => {
  const { task } = await ask('private', "Cosa dice il contratto d'affitto sulla caparra?");
  const model = scripted([
    { action: 'call', tool: 'kb.search', arguments: { query: 'caparra affitto', limit: 3 } },
    { action: 'call', tool: 'kb.search', arguments: { limit: 3, query: 'caparra affitto' } },
    { action: 'call', tool: 'kb.read', arguments: { path: 'kb/private/affitto.md' } },
    { action: 'reply', text: 'La caparra è di tre mensilità.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'continued', 'answered']);
  const turns = await loadTurns(db().sql, task.id);
  assert.match(turns[1]?.result ?? '', /^error: kb\.search: the same call as step 1, not run again/);
  // The model read the error as a tool result at the next step.
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', /<tool_result>\nerror: kb\.search: the same call as step 1/);
});

test('at the third repeated call the task waits for the user; resumed, it goes on (D-076)', async () => {
  const { task } = await ask('private', 'Quanto è la caparra?');
  const search = { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } } as const;
  assert.deepEqual(await drain(task.id, scripted([search, search, search, search])), ['continued', 'continued', 'continued', 'waiting-user']);
  const waiting = await loadTask(db().sql, task.id);
  assert.deepEqual([waiting?.status, waiting?.waitingReason], ['waiting_user', 'the local model keeps repeating the same call']);
  const turns = await loadTurns(db().sql, task.id);
  assert.equal(turns.length, 4);
  // The model reads that the task waits: after the user resumes it, the count starts again.
  assert.match(turns[3]?.result ?? '', /The task now waits for the user\.$/);
  await resumeTask(db().sql, task.id);
  const resumed = scripted([search, { action: 'reply', text: 'Non trovo la caparra.' }]);
  assert.deepEqual(await drain(task.id, resumed), ['continued', 'answered']);
  assert.match(resumed.requests[1]?.messages.at(-1)?.content ?? '', /not run again: its result is above\. Take a different step/);
});

test('the same card asked twice is created once (D-076)', async () => {
  const { task } = await ask('private', 'Ricordami di rinnovare il passaporto');
  const card = { action: 'call', tool: 'task.create', arguments: { title: 'Rinnovare il passaporto' } } as const;
  assert.deepEqual(await drain(task.id, scripted([card, card, { action: 'reply', text: 'Fatto.' }])), ['continued', 'continued', 'answered']);
  const children = await db().sql`SELECT id FROM tasks WHERE parent_id = ${task.id}`;
  assert.equal(children.length, 1);
});

test('two invalid answers leave the task waiting for the user', async () => {
  const { task } = await ask('private', 'Ciao');
  assert.deepEqual(await drain(task.id, scripted(['not-json', 'not-json'])), ['waiting-user']);
  const waiting = await loadTask(db().sql, task.id);
  assert.deepEqual([waiting?.status, waiting?.waitingReason], ['waiting_user', 'the local model did not give a valid answer']);
});

test('without a local model for the role the task waits, with what to do', async () => {
  const { task } = await ask('private', 'Ciao');
  assert.deepEqual(await drain(task.id, scripted([new LocalModelError('no-endpoint', 'no local endpoint serves local-large')])), ['waiting-user']);
  assert.match((await loadTask(db().sql, task.id))?.waitingReason ?? '', /pnpm arianna:init/);
});

test('a step that already has its turn does not call the model again', async () => {
  const { task } = await ask('private', 'Cerca la caparra.');
  await drain(task.id, scripted([{ action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } }, new LocalModelError('no-endpoint', 'stub')]));
  const [turn] = await loadTurns(db().sql, task.id);
  assert.ok(turn !== undefined);
  const model = scripted([]);
  const executor = orchestrator(model);
  const current = await loadTask(db().sql, task.id);
  assert.ok(current !== undefined);
  const outcome = await executor.run({
    task: current,
    step: 1,
    runId: turn.runId,
    signal: new AbortController().signal,
    setSessionRef: () => Promise.resolve(),
  });
  assert.deepEqual(outcome, { kind: 'continue', usage: { steps: 0 } });
  assert.equal(model.requests.length, 0);
});

/** A run left running for step `step`, as the engine opens it before calling the executor. */
async function runningRun(taskId: string, step: number, locality: 'local' | 'cloud' = 'local'): Promise<string> {
  const [run] = await db().sql<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, effective_label)
    VALUES (${taskId}, ${step}, 'arianna', ${locality === 'local' ? 'local' : 'claude'}, ${locality}, 'L1')
    RETURNING id::text`;
  if (run === undefined) throw new Error('no run');
  return run.id;
}

test('task_turns: from the running local run of the task, within the clearance, append-only', async () => {
  const { sql, owner } = db();
  const { task } = await ask('work', 'Ciao');
  const other = await ask('work', 'Altro');
  const run = await runningRun(task.id, 1);
  const answer = sql.json({ action: 'reply', text: 'x' });
  const insert = (step: number, runId: string, label: string, messageId: string | null = null) =>
    sql`INSERT INTO task_turns (task_id, step, run_id, label, answer, message_id)
        VALUES (${task.id}, ${step}, ${runId}, ${label}::privacy_label, ${answer}, ${messageId}::bigint)`;
  await assert.rejects(insert(2, run, 'L1'), /is not step 2/);
  await assert.rejects(insert(1, run, 'L2'), /above the clearance/);
  // The user's message of another task is not an answer of this one.
  await assert.rejects(insert(1, run, 'L1', other.message.id), /is not an answer of task/);
  await insert(1, run, 'L1');
  await assert.rejects(insert(1, run, 'L1'), /task_turns_one_per_step/);
  await assert.rejects(sql`UPDATE task_turns SET result = 'changed'`, /permission denied/);
  await assert.rejects(sql`DELETE FROM task_turns`, /permission denied/);
  await assert.rejects(owner`UPDATE task_turns SET result = 'changed'`, /append-only/);

  // A closed run, and a cloud one, get no turn.
  await sql`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${run}`;
  await assert.rejects(insert(2, await runningRun(task.id, 2, 'cloud'), 'L1'), /local model only/);
  await sql`UPDATE runs SET status = 'ok', ended_at = now() WHERE task_id = ${task.id}`;
  const closed = await runningRun(task.id, 3);
  await sql`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${closed}`;
  await assert.rejects(insert(3, closed, 'L1'), /is not running/);
});

test("a task's effective label goes up, never down", async () => {
  const { task } = await ask('private', 'Ciao');
  await db().sql`UPDATE tasks SET effective_label = 'L2' WHERE id = ${task.id}`;
  await assert.rejects(db().sql`UPDATE tasks SET effective_label = 'L1' WHERE id = ${task.id}`, /cannot go down/);
  assert.equal((await loadTask(db().sql, task.id))?.effectiveLabel, 'L2');
});

test('a step that finds the answer already written does not call the model', async () => {
  const { task } = await ask('private', 'Ciao');
  const reply = await openReply(db().sql, task.id);
  const written = await reply.finish('Ciao!', 'L2');
  assert.ok(written.stored);
  const model = scripted([]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.equal(model.requests.length, 0);
  assert.deepEqual((await loadTask(db().sql, task.id))?.evidence, [{ kind: 'message', ref: written.message.id }]);
});

test('a step whose answer was not delivered waits again for the user, without calling the model', async () => {
  const { task } = await ask('private', 'Ciao');
  const run = await runningRun(task.id, 1);
  await db().sql`
    INSERT INTO task_turns (task_id, step, run_id, label, answer, result)
    VALUES (${task.id}, 1, ${run}, 'L2', ${db().sql.json({ action: 'reply', text: 'x' })}, 'error: the answer was not delivered (blocked)')`;
  const current = await loadTask(db().sql, task.id);
  assert.ok(current !== undefined);
  const model = scripted([]);
  const executor = orchestrator(model);
  const outcome = await executor.run({ task: current, step: 1, runId: run, signal: new AbortController().signal, setSessionRef: () => Promise.resolve() });
  assert.deepEqual(outcome, { kind: 'wait-user', reason: 'the gateway blocked the answer', usage: { steps: 0 } });
  assert.equal(model.requests.length, 0);
});

test('the engine refuses an answer whose message is not the task’s', async () => {
  const { task } = await ask('private', 'Ciao');
  const other = await ask('private', 'Altro');
  const forged = { plan: () => ({ agent: 'arianna', executor: 'local', locality: 'local' as const }), run: () => Promise.resolve({ kind: 'answered' as const, messageId: other.message.id }) };
  const results = await drain(task.id, scripted([]), forged);
  assert.deepEqual(results, ['waiting-user']);
  const waiting = await loadTask(db().sql, task.id);
  assert.deepEqual([waiting?.status, waiting?.waitingReason], ['waiting_user', 'finished without evidence']);
});

test('a task without a conversation keeps its answer in the turn and goes to verify', async () => {
  const task = await submitTask(db().sql, { title: 'Cerca la data di scadenza Rossi', assignee: 'arianna', label: 'L1', clearance: 'L1', effectiveLabel: 'L1' });
  const model = scripted([{ action: 'reply', text: 'Il 31 marzo 2027.' }]);
  assert.deepEqual(await drain(task.id, model), ['to-verify']);
  assert.equal(model.requests[0]?.messages.at(-1)?.content, 'Cerca la data di scadenza Rossi');
  const [turn] = await loadTurns(db().sql, task.id);
  assert.deepEqual([turn?.answer, turn?.messageId], [{ action: 'reply', text: 'Il 31 marzo 2027.' }, null]);
  assert.deepEqual((await loadTask(db().sql, task.id))?.evidence, [{ kind: 'turn', ref: '1' }]);
});

test('kb.write through the orchestrator writes in the inbox with the task as source', async () => {
  const { task } = await ask('work', 'Salva una nota sulla caldaia.');
  const model = scripted([
    { action: 'call', tool: 'kb.write', arguments: { path: 'kb/work/nota.md', content: 'Revisione a novembre.' } },
    { action: 'call', tool: 'kb.write', arguments: { path: 'kb/inbox/caldaia.md', content: 'Revisione a novembre.' } },
    { action: 'reply', text: 'Salvata in kb/inbox/caldaia.md.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: kb\.write: with autonomy A1 pages can only be written under kb\/inbox\//);
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', /written kb\/inbox\/caldaia\.md/);
  assert.match(readFileSync(join(scratch, 'kb', 'inbox', 'caldaia.md'), 'utf8'), new RegExp(`^---\\nlabel: L2\\nsource: task:${task.id}\\n`));
});

test('the steps show in the chat as activity, never stored', async () => {
  const { task } = await ask('private', 'Cerca la caparra.');
  const live = await startLiveFeed(db().sql);
  const received: LiveMessage[] = [];
  const stop = await live.subscribe({ send: (message) => received.push(message) });
  try {
    const model = scripted([
      { action: 'call', tool: 'kb.read', arguments: { path: 'kb/private/nessuna.md' } },
      { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } },
      { action: 'reply', text: 'Tre mensilità.' },
    ]);
    await drain(task.id, model);
    // Notifications arrive after the commit: give the listener a moment.
    for (let wait = 0; wait < 50 && received.filter((m) => m.type === 'activity').length < 5; wait += 1) await new Promise((r) => setTimeout(r, 20));
  } finally {
    stop();
    await live.close();
  }
  const lines = received.flatMap((m) => (m.type === 'activity' && m.taskId === task.id ? [[m.step, m.kind, m.detail]] : []));
  assert.deepEqual(lines, [
    [1, 'thinking', ''],
    [1, 'error', 'page kb/private/nessuna.md not found'],
    [2, 'thinking', ''],
    [2, 'search', 'caparra'],
    [3, 'thinking', ''],
  ]);
});

test('in a system chat the model reads the messages of the system, marked, before the user question', async () => {
  const { sql } = db();
  const failed = await ask('private', 'Domanda finita male');
  await db().owner`UPDATE tasks SET status = 'failed' WHERE id = ${failed.task.id}`;
  await db().owner`UPDATE jobs SET status = 'failed' WHERE key = ${`task:${failed.task.id}`}`;
  await recordFailure(sql, failed.task.id, { origin: 'local-model', code: 'local-model.unavailable', details: { endpoint: 'omlx', port: 7001 } });
  const chat = await openFailureChat(sql, failed.task.id);
  const { task } = await postUserMessage(sql, chat.id, 'Cosa è successo?');
  const model = scripted([{ action: 'reply', text: 'Il modello locale era spento.' }]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  const messages = model.requests[0]?.messages ?? [];
  const system = messages.find((message) => message.content.startsWith(SYSTEM_MESSAGE_MARK));
  assert.ok(system !== undefined);
  assert.equal(system.role, 'user');
  assert.match(system.content, /local-model\.unavailable/);
  assert.doesNotMatch(messages.map((message) => message.content).join('\n'), /Domanda finita male/, 'the question is not attached');
  // The system message and the question are both the user's: one message, in order (D-092).
  assert.equal(messages.at(-1), system);
  assert.ok(system.content.endsWith('\n\nCosa è successo?'));
  assert.ok(messages.slice(1).every((message, index, all) => index === 0 || message.role !== all[index - 1]?.role), 'user and assistant alternate');
});

// task.update (task 1.10, D-101): the orchestrator moves a card of the conversation and writes a note on it.

/** The tools a request offered, from its response schema. */
function offered(request: ChatRequest | undefined): string[] {
  const found = JSON.stringify(request?.schema?.schema ?? {}).match(/"(kb|task|user)\.[a-z]+"/g) ?? [];
  return [...new Set(found.map((name) => name.slice(1, -1)))].sort();
}

/** A card made by the first task of a new conversation, and that conversation. */
async function cardIn(mode: 'work' | 'private', title: string): Promise<{ cardId: string; conversationId: string; parentId: string }> {
  const { task } = await ask(mode, `Ricordami: ${title}`);
  const model = scripted([
    { action: 'call', tool: 'task.create', arguments: { title } },
    { action: 'reply', text: 'Carta creata.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'answered']);
  // No card when the task started: not offered, not even after the card exists (fixed for the task).
  assert.ok(model.requests.every((request) => !offered(request).includes('task.update')));
  const [card] = await db().sql<{ id: string }[]>`SELECT id::text FROM tasks WHERE parent_id = ${task.id}`;
  assert.ok(card !== undefined && task.conversationId !== null);
  return { cardId: card.id, conversationId: task.conversationId, parentId: task.id };
}

/** `task.update` run directly, as the orchestrator runs it, in its own transaction. */
async function update(task: Task, args: Record<string, unknown>, autonomy: Autonomy = 'A1', context = createContext(task.clearance, task.clearance)) {
  return db().sql.begin((tx) => updateCard(args, { sql: tx, task, context, autonomy }));
}

async function taskOf(id: string): Promise<Task> {
  const task = await loadTask(db().sql, id);
  assert.ok(task !== undefined);
  return task;
}

test('task.update: the model finds the card in the list, puts it on hold with a note, and later back in ready', async () => {
  const { cardId, conversationId } = await cardIn('work', 'Chiedere il preventivo al fabbro');
  const { task } = await postUserMessage(db().sql, conversationId, 'Il fabbro non risponde: segnala che aspetto la sua chiamata.');
  const model = scripted([
    // The model has never seen the id: it tries a name, reads the open cards, takes the right one.
    { action: 'call', tool: 'task.update', arguments: { task_id: 'preventivo-fabbro', status: 'waiting_user', note: 'Aspetto la chiamata del fabbro.' } },
    { action: 'call', tool: 'task.update', arguments: { task_id: cardId.slice(0, 8), status: 'waiting_user', note: 'Aspetto la chiamata del fabbro.' } },
    { action: 'reply', text: 'Segnata in attesa.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);
  assert.ok(model.requests.every((request) => offered(request).includes('task.update')));
  assert.equal(
    model.requests[1]?.messages.at(-1)?.content,
    `<tool_result>\nerror: task.update: no open card 'preventivo-fabbro' in this conversation. Open cards:\n- ${cardId} (inbox): Chiedere il preventivo al fabbro\n</tool_result>`,
  );
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', new RegExp(`updated card ${cardId}: inbox → waiting_user, note saved`));
  // The offer is decided once per task, in the log.
  const offers = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'task.offer'`;
  assert.deepEqual(offers.map((row) => row.payload), [{ update: true }]);

  const card = await taskOf(cardId);
  assert.deepEqual(
    [card.status, card.waitingReason, card.note, card.label, card.effectiveLabel],
    ['waiting_user', 'Aspetto la chiamata del fabbro.', 'Aspetto la chiamata del fabbro.', 'L1', 'L1'],
  );
  // In the chain: the move, with its cause, and the update, without the note's text.
  const events = await db().sql<{ kind: string; label: string; payload: Record<string, unknown> }[]>`
    SELECT kind, label, payload FROM events WHERE task_id = ${cardId} AND kind IN ('task.status', 'task.updated') ORDER BY id`;
  assert.deepEqual(
    events.map((event) => [event.kind, event.label, event.payload]),
    [
      ['task.status', 'L2', { from: 'inbox', to: 'waiting_user', cause: 'agent' }],
      ['task.updated', 'L1', { by: task.id, from: 'inbox', to: 'waiting_user', note: true }],
    ],
  );
  assert.ok(events.every((event) => !JSON.stringify(event.payload).includes('fabbro')));

  // It shows in the "Decisioni in attesa" window (D-091), with the note as the reason.
  const waiting = (await listWaitingTasks(db().sql)).tasks.find((entry) => entry.id === cardId);
  assert.deepEqual([waiting?.conversationId, waiting?.reason, waiting?.waitingReason], [null, 'other', 'Aspetto la chiamata del fabbro.']);

  // A1 closes a wait it opened itself.
  const { task: next } = await postUserMessage(db().sql, conversationId, 'Il fabbro ha chiamato, rimettila tra i pronti.');
  const back = scripted([
    { action: 'call', tool: 'task.update', arguments: { task_id: cardId, status: 'ready' } },
    { action: 'reply', text: 'Fatto.' },
  ]);
  assert.deepEqual(await drain(next.id, back), ['continued', 'answered']);
  const ready = await taskOf(cardId);
  // The note stays; the waiting reason goes with the wait. No job: a card in Pronti does not run by itself.
  assert.deepEqual([ready.status, ready.waitingReason, ready.note], ['ready', null, 'Aspetto la chiamata del fabbro.']);
  assert.equal((await db().sql`SELECT FROM jobs WHERE key = ${`task:${cardId}`}`).length, 0);
  assert.equal((await listWaitingTasks(db().sql)).tasks.find((entry) => entry.id === cardId), undefined);
});

test('task.update refuses what it may not do, as results the model reads', async () => {
  const { cardId, conversationId } = await cardIn('private', 'Rinnovare la carta d’identità');
  const other = await cardIn('private', 'Pagare il bollo');
  const { task } = await postUserMessage(db().sql, conversationId, 'Aggiorna le carte.');
  const model = scripted([
    // A card of another conversation reads as one that does not exist, with the open cards listed.
    { action: 'call', tool: 'task.update', arguments: { task_id: other.cardId, status: 'waiting_user', note: 'x' } },
    { action: 'call', tool: 'task.update', arguments: { task_id: '00000000-0000-0000-0000-000000000000', status: 'ready' } },
    // With autonomy A1 a card goes to Pronti only through the user.
    { action: 'call', tool: 'task.update', arguments: { task_id: cardId, status: 'ready' } },
    { action: 'call', tool: 'task.update', arguments: { task_id: cardId, status: 'to_verify' } },
    { action: 'call', tool: 'task.update', arguments: { task_id: cardId, status: 'waiting_user' } },
    { action: 'call', tool: 'task.update', arguments: { task_id: task.id, status: 'waiting_user', note: 'Attendo.' } },
    { action: 'call', tool: 'task.update', arguments: { task_id: task.id.slice(0, 8), status: 'waiting_user', note: 'Attendo.' } },
    { action: 'reply', text: 'Non posso.' },
  ]);
  assert.deepEqual(await drain(task.id, model), [...Array<string>(7).fill('continued'), 'answered']);
  const results = model.requests.slice(1).map((request) => request.messages.at(-1)?.content ?? '');
  const notFound = (id: string) =>
    `<tool_result>\nerror: task.update: no open card '${id}' in this conversation. Open cards:\n- ${cardId} (inbox): Rinnovare la carta d’identità\n</tool_result>`;
  assert.equal(results[0], notFound(other.cardId));
  assert.equal(results[1], notFound('00000000-0000-0000-0000-000000000000'));
  assert.match(results[2] ?? '', /error: task\.update: with autonomy A1 a card goes to ready only through the user/);
  assert.match(results[3] ?? '', /error: task\.update: a card goes to to_verify only from work, and this one is inbox/);
  assert.match(results[4] ?? '', /error: task\.update: waiting_user needs a note/);
  assert.match(results[5] ?? '', /error: task\.update: that is the task you are working on/);
  assert.match(results[6] ?? '', /error: task\.update: that is the task you are working on/);
  // Nothing moved, here or in the other conversation.
  assert.equal((await taskOf(cardId)).status, 'inbox');
  assert.equal((await taskOf(other.cardId)).status, 'inbox');
  assert.equal((await taskOf(task.id)).status, 'done');
});

test('task.update and autonomy: A0 moves nothing, A1 never closes a wait it did not open, A2 triages', async () => {
  const { cardId, conversationId } = await cardIn('work', 'Prenotare la revisione dell’auto');
  const { task } = await postUserMessage(db().sql, conversationId, 'Aggiorna la carta.');
  assert.match((await update(task, { task_id: cardId, status: 'waiting_user', note: 'Attendo.' }, 'A0')).text, /with autonomy A0 an agent only proposes/);
  // A wait the user opened stays the user's.
  await db().sql.begin((tx) => moveTask(tx, cardId, 'waiting_user', { reason: 'Decido io.', cause: 'user' }));
  assert.match((await update(task, { task_id: cardId, status: 'ready' })).text, /only the user moves it back to ready/);
  // The same status with a new note: only the note changes.
  assert.match((await update(task, { task_id: cardId, status: 'waiting_user', note: 'Chiamare l’officina.' })).text, /still waiting_user, note saved/);
  const noted = await taskOf(cardId);
  assert.deepEqual([noted.status, noted.waitingReason, noted.note], ['waiting_user', 'Chiamare l’officina.', 'Chiamare l’officina.']);
  // A2 may triage: from the inbox to Pronti.
  const second = await cardIn('work', 'Cambiare le gomme');
  const { task: other } = await postUserMessage(db().sql, second.conversationId, 'Aggiorna la carta.');
  assert.match((await update(other, { task_id: second.cardId, status: 'ready' }, 'A2')).text, /inbox → ready/);
  assert.equal((await taskOf(second.cardId)).status, 'ready');
});

test('task.update: cards in work, waiting for an approval, closed, or named by a short or ambiguous prefix', async () => {
  const { cardId, conversationId, parentId } = await cardIn('work', 'Rinnovare il dominio');
  const { task } = await postUserMessage(db().sql, conversationId, 'Aggiorna la carta.');
  const args = (id: string) => ({ task_id: id, status: 'waiting_user', note: 'Attendo.' });

  // In work: a step job is active.
  await scheduleTask(db().sql, cardId);
  assert.equal(await hasOpenCards(db().sql, task), false);
  assert.match((await update(task, args(cardId))).text, /is being worked on/);
  await db().sql`UPDATE jobs SET status = 'done' WHERE key = ${`task:${cardId}`} AND status = 'queued'`;
  assert.equal(await hasOpenCards(db().sql, task), true);

  // Waiting for an approval: the user decides it, and the card is not listed.
  const [approval] = await db().sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail) VALUES (${cardId}, 'action', 'delete', '{}') RETURNING id::text`;
  await db().sql`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'approval', waiting_approval_id = ${approval?.id ?? null}::uuid WHERE id = ${cardId}`;
  assert.equal(await hasOpenCards(db().sql, task), false);
  assert.match((await update(task, args(cardId))).text, /waits for an approval: the user decides it/);
  assert.equal((await update(task, args('ffffffff'))).text, "error: task.update: no open card 'ffffffff' in this conversation; there is no open card in this conversation");
  await db().sql`UPDATE tasks SET status = 'inbox', waiting_reason = NULL, waiting_approval_id = NULL WHERE id = ${cardId}`;

  // A prefix shorter than 8 characters names nothing; one that names two cards names none.
  assert.match((await update(task, args(cardId.slice(0, 7)))).text, /no open card/);
  const twin = `${cardId.slice(0, 9)}${cardId.slice(9, 10) === 'a' ? 'b' : 'a'}${cardId.slice(10)}`;
  await db().sql`INSERT INTO tasks (id, title, parent_id, label, clearance, effective_label, status) VALUES (${twin}, 'Gemella', ${parentId}, 'L1', 'L1', 'L1', 'inbox')`;
  assert.match((await update(task, args(cardId.slice(0, 8)))).text, /'[0-9a-f]{8}' names more than one card\. Open cards:/);
  assert.match((await update(task, args(cardId))).text, /updated card/);

  // Closed cards are not open: failed and done.
  await db().sql.begin((tx) => moveTask(tx, twin, 'failed', { cause: 'user' }));
  assert.match((await update(task, { task_id: twin, status: 'ready' })).text, /no open card/);
  await db().sql`UPDATE tasks SET status = 'done' WHERE id = ${twin}`;
  assert.match((await update(task, { task_id: twin, status: 'ready' })).text, /no open card/);
});

test('task.update: the note carries the step’s label, within the card’s clearance', async () => {
  const { conversationId, parentId } = await cardIn('work', 'Chiamare il commercialista');
  const { task } = await postUserMessage(db().sql, conversationId, 'Aggiorna la carta.');
  // A card labeled L0: the note, written from an L1 context, raises it.
  const [low] = await db().sql<{ id: string }[]>`
    INSERT INTO tasks (title, parent_id, label, clearance, effective_label, status) VALUES ('Pubblica', ${parentId}, 'L0', 'L1', 'L0', 'inbox') RETURNING id::text`;
  assert.ok(low !== undefined);
  assert.match((await update(task, { task_id: low.id, status: 'waiting_user', note: 'Attendo il commercialista.' }, 'A1', createContext('L1', 'L1'))).text, /note saved/);
  const raised = await taskOf(low.id);
  assert.deepEqual([raised.label, raised.effectiveLabel], ['L1', 'L1']);
  // A context above the card (L1): only a forged one gets here, the conversation stops at L1.
  const result = await update(task, { task_id: low.id, status: 'waiting_user', note: 'Segreto.' }, 'A1', createContext('L2', 'L2'));
  assert.equal(result.text, `error: task.update: the note is above what card ${low.id} may hold`);
  assert.equal((await taskOf(low.id)).note, 'Attendo il commercialista.');
});

test('tasks.note: on cards only, from 1 to 500 characters', async () => {
  const { cardId, conversationId } = await cardIn('work', 'Leggere il contratto');
  const { task } = await postUserMessage(db().sql, conversationId, 'Ciao.');
  await assert.rejects(db().sql`UPDATE tasks SET note = 'x' WHERE id = ${task.id}`, /tasks_note_only_cards/);
  await assert.rejects(db().sql`UPDATE tasks SET note = '' WHERE id = ${cardId}`, /tasks_note_length/);
  await assert.rejects(db().sql`UPDATE tasks SET note = ${'x'.repeat(501)} WHERE id = ${cardId}`, /tasks_note_length/);
  await db().sql`UPDATE tasks SET note = ${'è'.repeat(500)} WHERE id = ${cardId}`;
  assert.equal((await taskOf(cardId)).note?.length, 500);
});

test('task.update in a task without a conversation: its own cards only, and an error that says so', async () => {
  const task = await submitTask(db().sql, { title: 'Riordina le carte', assignee: 'arianna', label: 'L1', clearance: 'L1', effectiveLabel: 'L1' });
  assert.equal(
    (await update(task, { task_id: 'abcdefab', status: 'ready' })).text,
    "error: task.update: no open card 'abcdefab' among the cards of this task; there is no open card among the cards of this task",
  );
});

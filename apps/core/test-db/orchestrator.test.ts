import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { AGENTS_DIR, loadAgents, type Answer } from '@arianna/agents';
import { parseLabelRules, resolveHome } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, submitTask, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTurns } from '../src/orchestrator/turns.ts';
import { openReply } from '../src/reply.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOME = resolveHome({});
const agents = loadAgents(join(HOME, AGENTS_DIR));
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
async function drain(taskId: string, model: LocalModel, executor: StepExecutor = createOrchestrator({ sql: db().sql, agents, kb, model: () => model })): Promise<string[]> {
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
      ? await createConversation(db().sql, { mode, workspace: 'repos/demo', allowlist: ['repos/demo'] })
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
  const orchestrator = createOrchestrator({ sql: db().sql, agents, kb, model: () => model });
  const current = await loadTask(db().sql, task.id);
  assert.ok(current !== undefined);
  const outcome = await orchestrator.run({
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
  const orchestrator = createOrchestrator({ sql: db().sql, agents, kb, model: () => model });
  const outcome = await orchestrator.run({ task: current, step: 1, runId: run, signal: new AbortController().signal, setSessionRef: () => Promise.resolve() });
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

// A step delegated to an agent of the user that only answers (D-119, tappa
// T3): one call to the local model with the agent's prompt and the brief,
// after the user's declassification when the brief is above what the agent
// may read (L1: its prompt is the user's own). The report comes back as the
// agent's message and as the result of the call.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadAgent, userCard, userPresets, type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { createDelegation, updateDelegation } from '../src/orchestrator/delegations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { LOCAL_FRAME, LOCAL_REPORT_SCHEMA_NAME } from '../src/orchestrator/delegate.ts';
import { ENTRY_TEXT } from '../src/participants.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask, type Task } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `local-delegation-${randomUUID()}`);
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const loaded = committedAgents(ROOT);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/**
 * A user's agent written by the page from a starting point (tappa T3b),
 * loaded as the core does; `web` stands for a card with the web tools, which
 * the page cannot make yet and no delegation runs.
 */
function userAgent(name: string, preset: 'code' | 'answer' | 'web', prompt: string): LoadedAgent {
  const dir = join(HOME, 'cards');
  mkdirSync(dir, { recursive: true });
  const permissions = userPresets().find(({ id }) => id === (preset === 'web' ? 'answer' : preset))?.permissions;
  const files = userCard({ name, description: `Agente ${name} di prova`, permissions, prompt });
  writeFileSync(join(dir, `${name}.yaml`), files.yaml);
  writeFileSync(join(dir, `${name}.md`), files.md);
  const agent: LoadedAgent = { ...loadAgent(dir, name), origin: 'user' };
  return preset === 'web' ? { ...agent, card: { ...agent.card, maxLabel: 'L0', tools: ['web.search', 'web.fetch'] } } : agent;
}

/**
 * The local model: Arianna's steps take the next scripted answer, the
 * agent's call the next report. Each request is kept.
 */
function scripted(answers: Answer[], reports: unknown[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let answered = 0;
  let reported = 0;
  return {
    requests,
    chat(request) {
      requests.push(request);
      const local = request.schema?.name === LOCAL_REPORT_SCHEMA_NAME;
      const next: unknown = local ? reports[reported++] : answers[answered++];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = local ? next : { thought: 'Ragiono.', ...(next as Answer) };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

function orchestrator(model: LocalModel, extra: LoadedAgent[], skills?: (agent: string, maxBytes: number) => string | undefined): StepExecutor {
  const agents = new Map<string, LoadedAgent>(loaded);
  for (const agent of extra) agents.set(agent.card.name, agent);
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    // Claude off: the agents that only answer work without it.
    cloud: { executors: [], models: defaultCloudModels() },
    projects: [{ name: 'site', path: 'repos/site', absolute: join(HOME, 'repos', 'site'), label: 'L1' } satisfies Project],
  });
  return createOrchestrator({ sql: db().sql, agents, kb: createKb({ home: HOME, rules: RULES }), model: () => model, settings, rules: RULES, ...(skills === undefined ? {} : { skills }) });
}

async function drain(taskId: string, executor: StepExecutor): Promise<string[]> {
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

/** A work conversation (L1) by default; a private one (L2) when asked. */
async function ask(body: string, mode: 'work' | 'private' = 'work'): Promise<{ task: Task }> {
  const conversation =
    mode === 'work' ? await createConversation(db().sql, { mode, project: 'site', projects: ['site'] }) : await createConversation(db().sql, { mode });
  return postUserMessage(db().sql, conversation.id, body);
}

async function waitingFor(taskId: string): Promise<string> {
  const task = await loadTask(db().sql, taskId);
  assert.ok(task !== undefined && task.status === 'waiting_user' && task.waitingApprovalId !== null);
  return task.waitingApprovalId;
}

const translator = (): LoadedAgent => userAgent('traduttore', 'answer', 'Traduci in inglese il testo che ricevi.');
const DELEGATE: Answer = { action: 'call', tool: 'task.delegate', arguments: { agent: 'traduttore', reason: 'per la traduzione', brief: 'Traduci: buongiorno a tutti.' } };
const REPLY: Answer = { action: 'reply', text: 'Ecco la traduzione: good morning everyone.' };

test('Arianna offers the agents that can work now: an answering agent without Claude, never a web one', async () => {
  const { task } = await ask('Traduci: buongiorno a tutti.');
  const model = scripted([REPLY], []);
  assert.deepEqual(await drain(task.id, orchestrator(model, [translator(), userAgent('cercatore', 'web', 'Cerca.')])), ['answered']);
  const system = model.requests[0]?.messages[0]?.content ?? '';
  assert.match(system, /task\.delegate: .*traduttore, "Agente traduttore di prova"/);
  assert.match(system, /"enum":\["traduttore"\]/);
  assert.doesNotMatch(system, /cercatore/);

  // With nobody to take a step, no task.delegate at all.
  const { task: alone } = await ask('Ciao.');
  const nobody = scripted([REPLY], []);
  assert.deepEqual(await drain(alone.id, orchestrator(nobody, [])), ['answered']);
  assert.doesNotMatch(nobody.requests[0]?.messages[0]?.content ?? '', /^- task\.delegate:/m);
});

test('an L1 brief goes to the agent at once, and it answers on the local model', async () => {
  const { task } = await ask('Traduci: buongiorno a tutti.');
  const model = scripted([DELEGATE, REPLY], [{ report: 'Good morning everyone.' }]);
  const executor = orchestrator(model, [translator()]);
  assert.deepEqual(await drain(task.id, executor), ['continued', 'continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual(
    [delegation?.status, delegation?.executor, delegation?.model, delegation?.label, delegation?.result, delegation?.resultLabel, delegation?.repo],
    ['ok', 'local', 'local-large', 'L1', 'Good morning everyone.', 'L1', null],
  );

  // The agent read the frame, its own prompt and the brief; nothing else of the chat.
  const call = model.requests.find((request) => request.schema?.name === LOCAL_REPORT_SCHEMA_NAME);
  assert.ok(call !== undefined);
  // Its first delegation in this conversation: it also reads how to enter it (D-125).
  assert.equal(call.messages[0]?.content, `${LOCAL_FRAME}\nTraduci in inglese il testo che ricevi.\n\n\n${ENTRY_TEXT}`);
  assert.deepEqual(call.messages.slice(1), [{ role: 'user', content: 'Traduci: buongiorno a tutti.' }]);

  // The report is in the chat as the agent's message, and Arianna read it as the result of her call.
  const messages = await db().sql<{ agent: string | null; body: string }[]>`SELECT agent, body FROM messages WHERE task_id = ${task.id} AND role = 'assistant' ORDER BY id`;
  assert.deepEqual(
    messages.map((row) => [row.agent, row.body]),
    [
      ['traduttore', 'Good morning everyone.'],
      [null, 'Ecco la traduzione: good morning everyone.'],
    ],
  );
  const last = model.requests.at(-1)?.messages.at(-1)?.content ?? '';
  assert.match(last, /traduttore \(local\/local-large\) reported:\nGood morning everyone\./);

  // Every run stayed local, and the router logged the agent's decision.
  const runs = await db().sql<{ step: number; locality: string; agent: string }[]>`SELECT step, locality, agent FROM runs WHERE task_id = ${task.id} ORDER BY step`;
  assert.deepEqual(
    runs.map((run) => [run.step, run.locality, run.agent]),
    [
      [1, 'local', 'arianna'],
      [2, 'local', 'traduttore'],
      [3, 'local', 'arianna'],
    ],
  );
  const [decision] = await db().sql<{ executor: string; step: number }[]>`SELECT executor, step FROM router_decisions WHERE task_id = ${task.id}`;
  assert.deepEqual(decision, { executor: 'local', step: 2 });
});

test('an L2 brief from a private conversation waits for the declassification to L1', async () => {
  const { task } = await ask('Traduci: ciao.', 'private');
  const model = scripted([DELEGATE, REPLY], [{ report: 'Hi.' }]);
  const executor = orchestrator(model, [translator()]);
  assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
  const approval = await waitingFor(task.id);
  const [asked] = await db().sql<{ kind: string; detail: { to: string } }[]>`SELECT kind, detail FROM approvals WHERE id = ${approval}`;
  assert.deepEqual([asked?.kind, asked?.detail.to], ['declassify', 'L1']);
  await recordDecision(db().sql, approval, 'approved', 'web');
  assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([delegation?.status, delegation?.label, delegation?.resultLabel], ['ok', 'L1', 'L1']);
});

test('after a crash, the declassification asked again is to the agent\'s ceiling', async () => {
  const { task } = await ask('Traduci: ciao.', 'private');
  const executor = orchestrator(scripted([DELEGATE, REPLY], []), [translator()]);
  assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
  // The step that wrote the call runs again, as after a crash before its outcome was recorded.
  const loaded = await loadTask(db().sql, task.id);
  assert.ok(loaded !== undefined);
  const again = await executor.run({ task: loaded, step: 1, runId: randomUUID(), signal: new AbortController().signal } as never);
  assert.deepEqual(again, { kind: 'declassify', text: 'Traduci: buongiorno a tutti.', from: 'L2', to: 'L1', usage: { steps: 0 } });
});

test('the guard of task_delegations: a local run only for executor local, a cloud run for the others (migration 0025)', async () => {
  const { task } = await ask('Vincolo.');
  const sql = db().sql;
  const run = async (step: number, locality: 'local' | 'cloud') => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label, status, ended_at)
      VALUES (${task.id}, ${step}, 'traduttore', ${locality === 'local' ? 'local' : 'claude'}, 'm', ${locality}, 'L1', 'ok', now()) RETURNING id::text`;
    assert.ok(row !== undefined);
    return row.id;
  };
  const delegation = async (step: number) => sql.begin((tx) => createDelegation(tx, { taskId: task.id, step, agent: 'traduttore', brief: 'x', label: 'L1' }));
  const local = await run(2, 'local');
  const cloud = await run(3, 'cloud');
  const first = await delegation(1);
  const second = await delegation(4);
  await assert.rejects(updateDelegation(sql, first.id, { executor: 'claude', runId: local }), /is not a cloud run/);
  await assert.rejects(updateDelegation(sql, second.id, { executor: 'local', runId: cloud }), /is not a local run/);
  await updateDelegation(sql, first.id, { executor: 'local', runId: local });
  await updateDelegation(sql, second.id, { executor: 'claude', runId: cloud });
});

test('a rejected declassification, an empty report or a deactivated agent: the delegation fails, the task goes on', async () => {
  const rejected = await ask('Traduci: ciao.', 'private');
  const first = scripted([DELEGATE, REPLY], []);
  const executor = orchestrator(first, [translator()]);
  assert.deepEqual(await drain(rejected.task.id, executor), ['waiting-approval']);
  await recordDecision(db().sql, await waitingFor(rejected.task.id), 'rejected', 'web');
  assert.deepEqual(await drain(rejected.task.id, executor), ['answered']);
  assert.equal((await loadDelegations(db().sql, rejected.task.id))[0]?.status, 'refused');
  assert.match(first.requests.at(-1)?.messages.at(-1)?.content ?? '', /the user did not approve sending the brief to traduttore/);
  assert.equal(first.requests.filter((request) => request.schema?.name === LOCAL_REPORT_SCHEMA_NAME).length, 0);

  const empty = await ask('Traduci: ciao.');
  const second = scripted([DELEGATE, REPLY], [{ report: '   ' }]);
  const run = orchestrator(second, [translator()]);
  assert.deepEqual(await drain(empty.task.id, run), ['continued', 'continued', 'answered']);
  const [failed] = await loadDelegations(db().sql, empty.task.id);
  assert.deepEqual([failed?.status, failed?.result], ['failed', 'error: task.delegate: traduttore gave no report']);

  // Taken off between the call and its step: the next step reads why.
  const gone = await ask('Traduci: ciao.', 'private');
  const third = scripted([DELEGATE, REPLY], [{ report: 'Hi.' }]);
  const agents = [translator()];
  const before = orchestrator(third, agents);
  assert.deepEqual(await drain(gone.task.id, before), ['waiting-approval']);
  await recordDecision(db().sql, await waitingFor(gone.task.id), 'approved', 'web');
  assert.deepEqual(await drain(gone.task.id, orchestrator(third, [])), ['answered']);
  assert.match((await loadDelegations(db().sql, gone.task.id))[0]?.result ?? '', /no agent card for traduttore/);
});

test('the skills of an agent on the local model join its instructions, within the smaller limit (D-161)', async () => {
  const { task } = await ask('Traduci: buongiorno a tutti.');
  const model = scripted([DELEGATE, REPLY], [{ report: 'Good morning everyone.' }]);
  const asked: [string, number][] = [];
  const skills = (agent: string, maxBytes: number): string => {
    asked.push([agent, maxBytes]);
    return '----- BEGIN SKILL acme/skills/tone [0123456789abcdef] -----\nInvented tone.\n----- END SKILL acme/skills/tone [0123456789abcdef] -----';
  };
  assert.deepEqual(await drain(task.id, orchestrator(model, [translator()], skills)), ['continued', 'continued', 'answered']);
  assert.deepEqual(asked, [['traduttore', 16 * 1024]]);
  const call = model.requests.find((request) => request.schema?.name === LOCAL_REPORT_SCHEMA_NAME);
  assert.equal(
    call?.messages[0]?.content,
    `${LOCAL_FRAME}\nTraduci in inglese il testo che ricevi.\n\n\n----- BEGIN SKILL acme/skills/tone [0123456789abcdef] -----\nInvented tone.\n----- END SKILL acme/skills/tone [0123456789abcdef] -----\n\n${ENTRY_TEXT}`,
  );
  assert.deepEqual(call.messages.slice(1), [{ role: 'user', content: 'Traduci: buongiorno a tutti.' }], 'the brief stays the last turn');
});

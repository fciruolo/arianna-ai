// The cardwall, tappa C3 (I-13, D-159), with the database: Arianna's plan
// approved in the chat, the cards of the agents that run (the Designer asks
// where), the report in the card, "Avvia", "Riprendi" and "Riprova".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import { createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { ApprovalChoiceError, listApprovals, loadApproval } from '../src/approvals.ts';
import { cardDetail } from '../src/card-details.ts';
import { CardError, createCard, listCards, moveCard, resumeCard, retryCard, startCard, updateCard } from '../src/cardwall.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { requestExecutor } from '../src/orchestrator/card-run.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { startApiServer } from '../src/server/http.ts';
import { createTask, loadTask, moveTask, type Task } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `card-plans-${randomUUID()}`);
const REPO = join(HOME, 'repos', 'site');
const FIXTURES = join(ROOT, 'packages', 'executors', 'test', 'fixtures');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const BASE = loadConfig();
const PROJECTS = ['site'];
const agents = new Map<string, LoadedAgent>(committedAgents(ROOT));
const OPTIONS = {
  allowedActions: () => [] as readonly string[],
  agentLimits: (task: Task) => {
    const limits = agents.get(task.assignee)?.card.limits;
    return { maxSteps: limits?.maxSteps ?? 30, maxMinutes: limits?.maxMinutes ?? 20 };
  },
};
const NAMES = { projects: PROJECTS, agents: ['coder', 'designer', 'reviewer'] };

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-claude.ts')] }, home: ROOT, killGraceMs: 200 });

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

before(() => {
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, 'README.md'), '# Fake site\n');
  writeFileSync(join(REPO, '.gitignore'), '.fake-claude.json\n');
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** A local model answering each call with the next scripted answer. */
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

function orchestrator(model: LocalModel, cloud: 'claude'[] = []): StepExecutor {
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: cloud, models: defaultCloudModels() },
    projects: PROJECTS.map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1' })),
  });
  return createOrchestrator({ sql: db().sql, agents, kb: createKb({ home: HOME, rules: RULES }), model: () => model, settings, rules: RULES, ...(cloud.length > 0 ? { claude } : {}) });
}

async function drain(taskIds: readonly string[], executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 30; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (typeof job.payload.taskId !== 'string' || !taskIds.includes(job.payload.taskId)) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

const PLAN: Answer = {
  action: 'call',
  tool: 'task.plan',
  arguments: {
    title: 'Landing del sito',
    cards: [
      { title: 'Grafica della landing', goal: 'Due varianti della landing.', assignee: 'designer', blocked_by: [] },
      { title: 'Codice della landing', goal: 'La landing dalla variante scelta.', assignee: 'coder', blocked_by: [1] },
      { title: 'Testi della landing', goal: 'I testi delle sezioni.', assignee: 'user', blocked_by: [] },
    ],
  },
};

async function waitingApproval(taskId: string) {
  const task = await loadTask(db().sql, taskId);
  assert.equal(task?.status, 'waiting_user');
  assert.ok(task.waitingApprovalId !== null);
  const approval = await loadApproval(db().sql, task.waitingApprovalId);
  assert.ok(approval !== undefined);
  return approval;
}

async function childrenOf(taskId: string) {
  return [
    ...(await db().sql<{ id: string; title: string; assignee: string; status: string; label: string; project: string | null; queued: boolean }[]>`
    SELECT id::text, title, assignee, status, label, project,
      EXISTS (SELECT FROM jobs j WHERE j.key = 'task:' || t.id::text) AS queued
    FROM tasks t WHERE parent_id = ${taskId} ORDER BY title`),
  ];
}

test('a plan approved in the chat: the cards and their dependencies with the decision, the agents’ ones queued, the answer without the model (D-159)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Facciamo la landing del sito: grafica, codice e testi.');
  const model = scripted([PLAN]);
  const executor = orchestrator(model, ['claude']);
  assert.deepEqual(await drain([task.id], executor), ['waiting-approval']);
  // The model was offered the plan with the agents that can work now.
  assert.match(JSON.stringify(model.requests[0]?.schema?.schema), /"enum":\["user","coder","designer","reviewer"\]/);

  const approval = await waitingApproval(task.id);
  assert.deepEqual([approval.kind, approval.action, approval.label], ['plan', 'task.plan', 'L1']);
  assert.equal((approval.detail.cards as unknown[]).length, 3);
  assert.deepEqual(await childrenOf(task.id), [], 'nothing is created before the user approves');
  // The events never carry the plan's text.
  const events = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE task_id = ${task.id}`;
  assert.ok(events.every((event) => !JSON.stringify(event.payload).includes('landing')));
  // Only the web chat decides it.
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'telegram'), /approvals_plan_executor_via_web/);
  await recordDecision(db().sql, approval.id, 'approved', 'web');

  const cards = await childrenOf(task.id);
  assert.deepEqual(
    cards.map((card) => [card.title, card.assignee, card.status, card.label, card.project, card.queued]),
    [
      ['Codice della landing', 'coder', 'ready', 'L1', 'site', true],
      ['Grafica della landing', 'designer', 'ready', 'L1', 'site', true],
      ['Testi della landing', 'user', 'inbox', 'L1', 'site', false],
    ],
  );
  const [code, design] = cards;
  const deps = await db().sql<{ task: string; on: string }[]>`
    SELECT task_id::text AS task, depends_on::text AS on FROM task_dependencies WHERE task_id = ANY (${cards.map((card) => card.id)}::uuid[]) AND removed_at IS NULL`;
  assert.deepEqual([...deps], [{ task: code?.id, on: design?.id }]);
  // On the wall the code waits for the design.
  const wall = await listCards(db().sql);
  assert.equal(wall.find((card) => card.id === code?.id)?.column, 'waiting');

  // The chat task answers without calling the model again; the Designer's card asks where it runs, the Coder's is held back.
  const results = await drain([task.id, design?.id ?? '', code?.id ?? ''], executor);
  assert.deepEqual(results.sort(), ['answered', 'blocked', 'waiting-approval']);
  assert.equal(model.requests.length, 1);
  const [reply] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.match(reply?.body ?? '', /^Ho creato 3 card per «Landing del sito»:\n\n1\. Grafica della landing — Designer\n2\. Codice della landing — Coder, aspetta la 1\n3\. Testi della landing — tu/);

  // The choice shows under the plan's message, in that conversation.
  const choice = await waitingApproval(design?.id ?? '');
  assert.deepEqual([choice.kind, choice.action, choice.label, choice.conversationId, choice.chatTaskId], ['executor', 'card.executor', 'L1', conversation.id, task.id]);
  assert.deepEqual(choice.detail.options, ['claude', 'local']);
  assert.deepEqual(choice.detail.excluded, [{ executor: 'codex', reason: 'off' }]);
  assert.ok((await listApprovals(db().sql, 'pending', 100, { conversationId: conversation.id })).some((item) => item.id === choice.id));
});

test('a rejected plan creates no card, and a plan the code refuses is an error the model reads', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Organizza il lavoro del sito.');
  const lonely: Answer = { action: 'call', tool: 'task.plan', arguments: { title: 'Sito', cards: [{ title: 'Una', goal: 'Tutto.', assignee: 'user', blocked_by: [] }, { title: 'Due', goal: 'Altro.', assignee: 'user', blocked_by: [2] }] } };
  const mine: Answer = { action: 'call', tool: 'task.plan', arguments: { title: 'Sito', cards: [{ title: 'Una', goal: 'Tutto.', assignee: 'user', blocked_by: [] }, { title: 'Due', goal: 'Altro.', assignee: 'user', blocked_by: [1] }] } };
  const model = scripted([lonely, mine]);
  const executor = orchestrator(model);
  assert.deepEqual(await drain([task.id], executor), ['continued', 'waiting-approval']);
  const [turn] = await db().sql<{ result: string }[]>`SELECT result FROM task_turns WHERE task_id = ${task.id} ORDER BY step LIMIT 1`;
  assert.match(turn?.result ?? '', /^error: task\.plan: card 2: "blocked_by" may name only earlier cards/);
  // Without Claude the agents in the cloud do not take a plan's card: only the user.
  assert.match(JSON.stringify(model.requests[0]?.schema?.schema), /"enum":\["user"\]/);
  const approval = await waitingApproval(task.id);
  await recordDecision(db().sql, approval.id, 'rejected', 'web');
  assert.deepEqual(await childrenOf(task.id), []);
  assert.deepEqual(await drain([task.id], executor), ['answered']);
  const [reply] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.equal(reply?.body, 'Va bene, non ho creato nessuna card.');
});

test('"Avvia" on a Designer card written by hand: the user chooses among the allowed ways, the local model works, the report is in the card (D-159)', async () => {
  const created = await createCard(db().sql, { title: 'Grafica della pagina contatti', assignee: 'designer', project: 'site', goal: 'Una pagina semplice.' }, NAMES);
  // A card of the user's does not start; an agent's not twice.
  const mine = await createCard(db().sql, { title: 'Chiamare il grafico' }, NAMES);
  await assert.rejects(startCard(db().sql, mine.id), CardError);
  assert.equal((await startCard(db().sql, created.id)).status, 'ready');
  await assert.rejects(startCard(db().sql, created.id), /already/);

  const model = scripted([{ action: 'reply', text: 'Proposta: intestazione, modulo e mappa in due varianti.' }]);
  const executor = orchestrator(model, ['claude']);
  assert.deepEqual(await drain([created.id], executor), ['waiting-approval']);
  const approval = await waitingApproval(created.id);
  // Written by hand, the card is L2: the cloud never reads it.
  assert.deepEqual(approval.detail.options, ['local']);
  assert.deepEqual(approval.detail.excluded, [
    { executor: 'claude', reason: 'label' },
    { executor: 'codex', reason: 'label' },
  ]);
  assert.deepEqual([approval.label, approval.conversationId, approval.chatTaskId], ['L2', null, null]);
  // The choice is one of the options, given only with an approval.
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'web'), ApprovalChoiceError);
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'web', 'claude'), ApprovalChoiceError);
  await assert.rejects(recordDecision(db().sql, approval.id, 'rejected', 'web', 'local'), ApprovalChoiceError);
  // The database keeps the choice to approved executor approvals.
  await assert.rejects(db().sql`UPDATE approvals SET choice = 'local' WHERE id = ${approval.id}`, /approvals_choice/);
  const decided = await recordDecision(db().sql, approval.id, 'approved', 'web', 'local');
  assert.equal(decided.choice, 'local');

  assert.deepEqual(await drain([created.id], executor), ['to-verify']);
  assert.equal(model.requests.length, 1);
  assert.match(String(model.requests[0]?.messages[0]?.content), /^You are the Designer/);
  // Here it writes no file: it reads so, and describes the proposal.
  assert.match(JSON.stringify(model.requests[0]?.messages.slice(1)), /cannot write or read files/);
  const detail = await cardDetail(db().sql, created.id);
  assert.equal(detail.executor, 'local');
  assert.deepEqual([detail.report?.text, detail.report?.executor, detail.report?.label], ['Proposta: intestazione, modulo e mappa in due varianti.', 'local', 'L2']);
});

test('a Designer card from a work conversation runs on Claude when the user chooses it: the project folder, the report in the card (D-159)', async () => {
  const parent = await createTask(db().sql, { title: 'Piano', label: 'L1', clearance: 'L1', status: 'inbox' });
  const card = await createTask(db().sql, {
    title: 'Grafica della landing',
    goal: 'Due varianti.',
    parentId: parent.id,
    label: 'L1',
    clearance: 'L1',
    effectiveLabel: 'L1',
    assignee: 'designer',
    project: 'site',
    status: 'inbox',
  });
  try {
    await startCard(db().sql, card.id);
    const executor = orchestrator(scripted([]), ['claude']);
    assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
    const approval = await waitingApproval(card.id);
    assert.deepEqual(approval.detail.options, ['claude', 'local']);
    await recordDecision(db().sql, approval.id, 'approved', 'web', 'claude');
    assert.deepEqual(await drain([card.id], executor), ['continued', 'to-verify']);
    const [delegation] = await loadDelegations(db().sql, card.id);
    assert.deepEqual([delegation?.agent, delegation?.executor, delegation?.repo, delegation?.status], ['designer', 'claude', 'site', 'ok']);
    assert.match(delegation?.brief ?? '', /^Card: Grafica della landing\n\nProject: site\n\nWhat to do:\nDue varianti\.$/);
    const log = await db().sql<{ target: string; decision: string; label: string }[]>`
      SELECT target, decision, label FROM gateway_log WHERE task_id = ${card.id} AND target = 'claude'`;
    assert.deepEqual([...log], [{ target: 'claude', decision: 'allow', label: 'L1' }]);
    const task = await loadTask(db().sql, card.id);
    assert.deepEqual(task?.evidence, [{ kind: 'delegation', ref: delegation?.id }]);
    const detail = await cardDetail(db().sql, card.id);
    assert.deepEqual([detail.executor, detail.report?.executor, detail.report?.text.startsWith('ok')], ['claude', 'claude', true]);
  } finally {
    execFileSync('git', ['-C', REPO, 'clean', '--quiet', '-fd']);
  }
});

test('"Riprendi" and "Riprova": a card the engine stopped goes on, from the detail or dragged to Da fare; refused for the others (D-159)', async () => {
  const card = await createTask(db().sql, { title: 'Grafica', label: 'L2', clearance: 'L2', assignee: 'designer', status: 'inbox' });
  // Never started: nothing to resume or retry.
  await assert.rejects(resumeCard(db().sql, card.id), CardError);
  await startCard(db().sql, card.id);
  const executor = orchestrator(scripted([]), []);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  const asked = await waitingApproval(card.id);
  // Waiting for a decision: decided first.
  await assert.rejects(resumeCard(db().sql, card.id), /waits for a decision/);
  await recordDecision(db().sql, asked.id, 'rejected', 'web');
  assert.deepEqual(await drain([card.id], executor), ['waiting-user']);
  assert.match((await loadTask(db().sql, card.id))?.waitingReason ?? '', /did not choose/);
  // Riprendi: asked again.
  assert.equal((await resumeCard(db().sql, card.id)).status, 'ready');
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  const again = await waitingApproval(card.id);
  assert.notEqual(again.id, asked.id);
  await recordDecision(db().sql, again.id, 'rejected', 'web');
  assert.deepEqual(await drain([card.id], executor), ['waiting-user']);
  // Dragged to Da fare: the same as Riprendi.
  assert.equal((await moveCard(db().sql, card.id, 'ready')).status, 'ready');
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  const third = await waitingApproval(card.id);
  assert.equal((await loadApproval(db().sql, again.id))?.state, 'rejected');
  await recordDecision(db().sql, third.id, 'rejected', 'web');
  assert.deepEqual(await drain([card.id], executor), ['waiting-user']);

  // Riprova: only a failed card.
  await assert.rejects(retryCard(db().sql, card.id), /only a failed card/);
  await db().sql.begin((tx) => moveTask(tx, card.id, 'failed', { cause: 'executor' }));
  await assert.rejects(resumeCard(db().sql, card.id), /only a card in Aspetta/);
  assert.equal((await retryCard(db().sql, card.id)).status, 'ready');
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
});

/** A Designer card from a plan (L1, in the project), started: the user is asked where it runs. */
async function askedCard(title: string, executor: StepExecutor) {
  const parent = await createTask(db().sql, { title: 'Piano', label: 'L1', clearance: 'L1', status: 'inbox' });
  const card = await createTask(db().sql, {
    title,
    goal: 'Due varianti.',
    parentId: parent.id,
    label: 'L1',
    clearance: 'L1',
    effectiveLabel: 'L1',
    assignee: 'designer',
    project: 'site',
    status: 'inbox',
  });
  await startCard(db().sql, card.id);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  return { card, approval: await waitingApproval(card.id) };
}

async function nothingSentToClaude(taskId: string): Promise<void> {
  assert.deepEqual(await loadDelegations(db().sql, taskId), [], 'no delegation');
  const log = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${taskId} AND target = 'claude'`;
  assert.equal(log.length, 0, 'nothing went to Claude');
}

test('the choice is checked again when the card runs: a card now private, or Claude off, waits for the user and nothing leaves (D-159)', async () => {
  const executor = orchestrator(scripted([]), ['claude']);
  // The user writes on the card after choosing Claude: the card is L2 now.
  const written = await askedCard('Grafica scritta dopo', executor);
  assert.deepEqual(written.approval.detail.options, ['claude', 'local']);
  await recordDecision(db().sql, written.approval.id, 'approved', 'web', 'claude');
  assert.equal((await updateCard(db().sql, written.card.id, { goal: 'Il listino finto del cliente.' }, NAMES)).label, 'L2');
  assert.deepEqual(await drain([written.card.id], executor), ['waiting-user']);
  assert.match((await loadTask(db().sql, written.card.id))?.waitingReason ?? '', /^claude can no longer take this card/);
  await nothingSentToClaude(written.card.id);

  // Claude turned off between the choice and the step.
  const off = await askedCard('Grafica senza Claude', executor);
  await recordDecision(db().sql, off.approval.id, 'approved', 'web', 'claude');
  assert.deepEqual(await drain([off.card.id], orchestrator(scripted([]), [])), ['waiting-user']);
  assert.match((await loadTask(db().sql, off.card.id))?.waitingReason ?? '', /^claude can no longer take this card/);
  await nothingSentToClaude(off.card.id);

  // The local model chosen, then the card goes above what the Designer may read (L2): the model is never called.
  const model = scripted([{ action: 'reply', text: 'Mai.' }]);
  const local = await askedCard('Grafica troppo privata', orchestrator(model, ['claude']));
  await recordDecision(db().sql, local.approval.id, 'approved', 'web', 'local');
  await db().sql`UPDATE tasks SET label = 'L3' WHERE id = ${local.card.id}`;
  assert.deepEqual(await drain([local.card.id], orchestrator(model, ['claude'])), ['waiting-user']);
  assert.match((await loadTask(db().sql, local.card.id))?.waitingReason ?? '', /^local can no longer take this card/);
  assert.equal(model.requests.length, 0);
});

test('the local model keeps to the agent’s max_label: a card above it offers no way and runs nowhere; one within it runs (D-159)', async () => {
  const model = scripted([{ action: 'reply', text: 'Il rapporto del Coder in locale.' }]);
  const executor = orchestrator(model, ['claude']);
  // The Designer asks: nothing to offer, the card waits with why, no approval asked.
  const secret = await createTask(db().sql, { title: 'Grafica segreta', label: 'L3', clearance: 'L2', assignee: 'designer', project: 'site', status: 'inbox' });
  await startCard(db().sql, secret.id);
  assert.deepEqual(await drain([secret.id], executor), ['waiting-user']);
  assert.match((await loadTask(db().sql, secret.id))?.waitingReason ?? '', /local: the card is above what designer may read there \(L2\)/);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${secret.id}`).length, 0);
  // The Coder does not ask: without Claude, an L3 card has no way; an L2 one runs on the local model.
  const local = orchestrator(model, []);
  const above = await createTask(db().sql, { title: 'Codice segreto', label: 'L3', clearance: 'L2', assignee: 'coder', project: 'site', status: 'inbox' });
  await startCard(db().sql, above.id);
  assert.deepEqual(await drain([above.id], local), ['waiting-user']);
  assert.match((await loadTask(db().sql, above.id))?.waitingReason ?? '', /local: the card is above what coder may read there \(L2\)/);
  assert.equal(model.requests.length, 0);
  const within = await createTask(db().sql, { title: 'Codice privato', label: 'L2', clearance: 'L2', assignee: 'coder', project: 'site', status: 'inbox' });
  await startCard(db().sql, within.id);
  assert.deepEqual(await drain([within.id], local), ['to-verify']);
  assert.equal(model.requests.length, 1);
});

test('a plan step replayed after a crash: the same approval while pending, the answer once decided meanwhile (D-159)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Dividi il lavoro del sito.');
  const model = scripted([PLAN]);
  const executor = orchestrator(model, ['claude']);
  assert.deepEqual(await drain([task.id], executor), ['waiting-approval']);
  const approval = await waitingApproval(task.id);
  const [turn] = await db().sql<{ step: number }[]>`SELECT step FROM task_turns WHERE task_id = ${task.id} ORDER BY step DESC LIMIT 1`;
  const [run] = await db().sql<{ id: string }[]>`SELECT id::text FROM runs WHERE task_id = ${task.id} ORDER BY id DESC LIMIT 1`;
  assert.ok(turn !== undefined && run !== undefined);
  // The step runs again as after a crash before the engine recorded it: no new approval, no model call.
  const replay = async () =>
    executor.run({ task: (await loadTask(db().sql, task.id)) as Task, step: turn.step, runId: run.id, signal: new AbortController().signal, setSessionRef: () => Promise.resolve() });
  const pending = await replay();
  assert.deepEqual([pending.kind, pending.kind === 'confirm' ? pending.approvalId : undefined], ['confirm', approval.id]);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${task.id}`).length, 1);
  // Decided meanwhile: the replayed step writes the answer, without the model and without new cards.
  await recordDecision(db().sql, approval.id, 'approved', 'web');
  const answered = await replay();
  assert.equal(answered.kind, 'answered');
  assert.equal(model.requests.length, 1);
  assert.equal((await childrenOf(task.id)).length, 3);
  const [reply] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.match(reply?.body ?? '', /^Ho creato 3 card per «Landing del sito»/);
});

test('"Riprendi" locks the card’s pending approvals before the card, as a decision does: no deadlock (D-159)', async () => {
  const card = await createTask(db().sql, { title: 'Grafica da riprendere', label: 'L2', clearance: 'L2', assignee: 'designer', status: 'inbox' });
  await startCard(db().sql, card.id);
  const executor = orchestrator(scripted([]), []);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  await recordDecision(db().sql, (await waitingApproval(card.id)).id, 'rejected', 'web');
  assert.deepEqual(await drain([card.id], executor), ['waiting-user']);
  // A pending approval the card does not wait for (another tab asked meanwhile).
  const waiting = (await loadTask(db().sql, card.id)) as Task;
  const pending = await requestExecutor(db().sql, waiting, 9, 'designer', { options: ['local'], excluded: [] });

  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = (): void => undefined;
  const holding = new Promise<void>((resolve) => (held = resolve));
  // A decision at work on that approval holds its row.
  const decision = db().sql.begin(async (tx) => {
    await tx`SELECT id FROM approvals WHERE id = ${pending} FOR UPDATE`;
    held();
    await gate;
  });
  await holding;
  const resumed = resumeCard(db().sql, card.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    // "Riprendi" waits on the approvals and has not locked the card yet.
    await db().sql.begin((tx) => tx`SELECT id FROM tasks WHERE id = ${card.id} FOR UPDATE NOWAIT`);
  } finally {
    release();
    await decision;
  }
  assert.equal((await resumed).status, 'ready');
  assert.equal((await loadApproval(db().sql, pending))?.state, 'expired');
});

test('the routes: a choice outside the options or of a stranger is a 400; "Avvia" of Arianna’s card or of an agent gone is a 409 (D-159)', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [], agents: () => ['arianna', 'coder'] });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const card = await createTask(db().sql, { title: 'Grafica privata', label: 'L2', clearance: 'L2', assignee: 'designer', status: 'inbox' });
    await startCard(db().sql, card.id);
    assert.deepEqual(await drain([card.id], orchestrator(scripted([]), ['claude'])), ['waiting-approval']);
    const approval = await waitingApproval(card.id);
    assert.equal((await send(`/api/approvals/${approval.id}/decision`, { state: 'approved', choice: 'gemini' })).status, 400);
    assert.equal((await send(`/api/approvals/${approval.id}/decision`, { state: 'approved', choice: 'claude' })).status, 400, 'not among the options');
    assert.equal((await send(`/api/approvals/${approval.id}/decision`, { state: 'approved' })).status, 400, 'no choice');
    assert.equal((await loadApproval(db().sql, approval.id))?.state, 'pending');
    assert.equal((await send(`/api/approvals/${approval.id}/decision`, { state: 'approved', choice: 'local' })).status, 200);

    const hers = await createTask(db().sql, { title: 'Di Arianna', label: 'L2', clearance: 'L2', assignee: 'arianna', status: 'inbox' });
    const started = await send(`/api/cards/${hers.id}/start`);
    assert.equal(started.status, 409);
    assert.match(((await started.json()) as { error: string }).error, /Arianna does not work on cards/);
    // The Designer is not among the agents of this server: its card does not start.
    const gone = await createTask(db().sql, { title: 'Di un agente tolto', label: 'L2', clearance: 'L2', assignee: 'designer', status: 'inbox' });
    const refused = await send(`/api/cards/${gone.id}/start`);
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /no longer exists/);
    assert.equal((await loadTask(db().sql, gone.id))?.status, 'inbox');
  } finally {
    await server.close();
    await live.close();
  }
});

// The bug found trying the branch: a delegation of the chat to the Designer left on Claude without asking (D-159).
const LANDING = 'Mi serve una landing page nuova per il sito della pasticceria';
const TO_DESIGNER: Answer = {
  action: 'call',
  tool: 'task.delegate',
  arguments: { agent: 'designer', brief: 'Una landing page nuova per il sito della pasticceria, in due varianti.', reason: 'Serve la grafica della landing.' },
};

/** A chat task that delegated to the Designer and waits for the user's choice. */
async function askedDelegation(executor: StepExecutor, mode: 'work' | 'private' = 'work') {
  const conversation = await createConversation(db().sql, mode === 'work' ? { mode, project: 'site', projects: PROJECTS } : { mode });
  const { task } = await postUserMessage(db().sql, conversation.id, LANDING);
  assert.deepEqual(await drain([task.id], executor), ['waiting-approval']);
  const approval = await waitingApproval(task.id);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.ok(delegation !== undefined);
  assert.equal(delegation.status, 'pending');
  await nothingLeft(task.id);
  return { conversation, task, approval, delegation };
}

async function nothingLeft(taskId: string): Promise<void> {
  const log = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${taskId} AND locality = 'cloud'`;
  assert.equal(log.length, 0, 'nothing went to the cloud');
}

test('a delegation of the chat to the Designer asks where it works first, under the message; Claude chosen, only Claude works (D-159)', async () => {
  const model = scripted([TO_DESIGNER, { action: 'reply', text: 'Il Designer ha preparato la landing.' }]);
  const executor = orchestrator(model, ['claude']);
  const { conversation, task, approval, delegation } = await askedDelegation(executor);
  assert.deepEqual([approval.kind, approval.action, approval.label, approval.conversationId, approval.chatTaskId, approval.taskId], ['executor', 'card.executor', 'L1', conversation.id, null, task.id]);
  assert.deepEqual(approval.detail.options, ['claude', 'local']);
  assert.deepEqual(approval.detail.excluded, [{ executor: 'codex', reason: 'off' }]);
  assert.deepEqual([approval.detail.agent, approval.detail.delegation], ['designer', delegation.id]);
  assert.ok((await listApprovals(db().sql, 'pending', 100, { conversationId: conversation.id })).some((item) => item.id === approval.id));
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'telegram', 'claude'), /approvals_plan_executor_via_web/);
  try {
    await recordDecision(db().sql, approval.id, 'approved', 'web', 'claude');
    assert.deepEqual(await drain([task.id], executor), ['continued', 'answered']);
    const [done] = await loadDelegations(db().sql, task.id);
    assert.deepEqual([done?.executor, done?.repo, done?.status], ['claude', 'site', 'ok']);
    // The router read the Designer with Claude alone.
    const [decision] = await db().sql<{ executor: string }[]>`SELECT executor FROM router_decisions WHERE task_id = ${task.id} ORDER BY id DESC LIMIT 1`;
    assert.equal(decision?.executor, 'claude');
    const log = await db().sql<{ target: string; decision: string; label: string }[]>`
      SELECT target, decision, label FROM gateway_log WHERE task_id = ${task.id} AND locality = 'cloud'`;
    assert.deepEqual([...log], [{ target: 'claude', decision: 'allow', label: 'L1' }]);
    assert.equal(model.requests.length, 2);
  } finally {
    execFileSync('git', ['-C', REPO, 'clean', '--quiet', '-fd']);
  }
});

test('a delegation to the Designer on the local model when the user chooses it: no file tools, nothing leaves (D-159)', async () => {
  const report = { report: 'Proposta: intestazione con le torte, listino, contatti.' } as unknown as Answer;
  const model = scripted([TO_DESIGNER, report, { action: 'reply', text: 'Ecco la proposta del Designer.' }]);
  const executor = orchestrator(model, ['claude']);
  const { task, approval } = await askedDelegation(executor);
  await recordDecision(db().sql, approval.id, 'approved', 'web', 'local');
  assert.deepEqual(await drain([task.id], executor), ['continued', 'answered']);
  const [done] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([done?.executor, done?.status, done?.result], ['local', 'ok', 'Proposta: intestazione con le torte, listino, contatti.']);
  assert.match(String(model.requests[1]?.messages[0]?.content), /cannot write or read files/);
  await nothingLeft(task.id);
});

test('"Non ora" on the choice: Arianna says she did not start the work, without the model; nothing leaves (D-159)', async () => {
  const model = scripted([TO_DESIGNER]);
  const executor = orchestrator(model, ['claude']);
  const { task, approval } = await askedDelegation(executor);
  await recordDecision(db().sql, approval.id, 'rejected', 'web');
  assert.deepEqual(await drain([task.id], executor), ['answered']);
  assert.equal(model.requests.length, 1);
  const [reply] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'assistant' AND agent IS NULL`;
  assert.equal(reply?.body, 'Va bene, non ho avviato il lavoro di Designer. Quando vuoi, chiedimelo di nuovo e scegli con chi farlo.');
  const [done] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([done?.status, done?.executor], ['refused', null]);
  await nothingLeft(task.id);
});

test('the delegation step replayed after a crash waits for the same choice; the choice is checked again when the step runs (D-159)', async () => {
  const model = scripted([TO_DESIGNER, { action: 'reply', text: 'Claude ora è spento: il lavoro non è partito.' }]);
  const executor = orchestrator(model, ['claude']);
  const { task, approval } = await askedDelegation(executor);
  const [turn] = await db().sql<{ step: number }[]>`SELECT step FROM task_turns WHERE task_id = ${task.id} ORDER BY step DESC LIMIT 1`;
  const [run] = await db().sql<{ id: string }[]>`SELECT id::text FROM runs WHERE task_id = ${task.id} ORDER BY id DESC LIMIT 1`;
  assert.ok(turn !== undefined && run !== undefined);
  const replayed = await executor.run({ task: (await loadTask(db().sql, task.id)) as Task, step: turn.step, runId: run.id, signal: new AbortController().signal, setSessionRef: () => Promise.resolve() });
  assert.deepEqual([replayed.kind, replayed.kind === 'confirm' ? replayed.approvalId : undefined], ['confirm', approval.id]);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${task.id}`).length, 1);
  // Claude chosen, then turned off before the step: the delegation closes, Arianna tells the user, nothing leaves.
  await recordDecision(db().sql, approval.id, 'approved', 'web', 'claude');
  assert.deepEqual(await drain([task.id], orchestrator(model, [])), ['answered']);
  const [done] = await loadDelegations(db().sql, task.id);
  assert.equal(done?.status, 'refused');
  assert.match(done.result ?? '', /^error: task\.delegate: claude can no longer take this work/);
  await nothingLeft(task.id);
});

test('a private conversation offers the Designer only the local model (D-159)', async () => {
  const model = scripted([TO_DESIGNER]);
  const { approval } = await askedDelegation(orchestrator(model, ['claude']), 'private');
  assert.deepEqual(approval.detail.options, ['local']);
  assert.deepEqual(approval.detail.excluded, [
    { executor: 'claude', reason: 'label' },
    { executor: 'codex', reason: 'label' },
  ]);
  assert.equal(approval.label, 'L2');
});

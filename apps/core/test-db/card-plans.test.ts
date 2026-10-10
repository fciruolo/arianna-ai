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
import { CardError, createCard, listCards, moveCard, resumeCard, retryCard, startCard } from '../src/cardwall.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
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

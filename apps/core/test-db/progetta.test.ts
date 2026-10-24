// The cardwall, tappa C5 (I-13, D-235), with the database: «/progetta» puts a
// card «Piano» on the wall, which plans on the local model or on Claude as the
// conversation and the project say; the plan waits in the chat and on the
// card, may be edited before the decision, and the decision creates the cards
// in the inbox, starting only the rows «Avvia subito».
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project, type ProjectPlanner } from '@arianna/config';
import { createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { listApprovals, loadApproval } from '../src/approvals.ts';
import { editPlan, PlanError, requestPlan } from '../src/card-plans.ts';
import { listCards } from '../src/cardwall.ts';
import { archiveConversation, ChatError, createConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { eraseConversation } from '../src/erase.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { conversationOfTask } from '../src/notifications.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { startApiServer } from '../src/server/http.ts';
import { loadTask, type Task } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `progetta-${randomUUID()}`);
const FIXTURES = join(ROOT, 'packages', 'executors', 'test', 'fixtures');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const BASE = loadConfig();
const PROJECTS = ['site'];
const MENTIONABLE = { mentionable: ['coder', 'designer'] };
const agents = new Map<string, LoadedAgent>(committedAgents(ROOT));
const OPTIONS = {
  allowedActions: () => [] as readonly string[],
  agentLimits: (task: Task) => {
    const limits = agents.get(task.assignee)?.card.limits;
    return { maxSteps: limits?.maxSteps ?? 30, maxMinutes: limits?.maxMinutes ?? 20 };
  },
};

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-claude.ts')] }, home: ROOT, killGraceMs: 200 });

before(() => {
  mkdirSync(join(HOME, 'repos', 'site'), { recursive: true });
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const row = (title: string, assignee: string, blocked_by: number[], complexity = 'M') => ({
  title,
  goal: `Fare: ${title}.`,
  assignee,
  blocked_by,
  criteria: `${title}: fatto e controllato.`,
  complexity,
});

/** A plan of the user's only: what the local model may propose without Claude (the agents in the cloud are not ready). */
const MINE = { title: 'Landing della pasticceria', cards: [row('Testi', 'user', []), row('Foto', 'user', [1], 'S')] };
/** A plan with the agents: the design, the code after it, the texts, the checks. */
const AGENTS = {
  title: 'Landing del sito',
  cards: [row('Grafica', 'designer', []), row('Codice', 'coder', [1], 'L'), row('Testi', 'user', [], 'S'), row('Controlli', 'coder', [])],
};
/** The fake `claude -p` answers with AGENTS. */
const PLANNER = `scenario: answer\nanswer: ${JSON.stringify(AGENTS)}`;

/** A local model answering each call with the next value. */
function scripted(values: unknown[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const value = values[requests.length - 1];
      if (value === undefined) return Promise.reject(new Error('no answer scripted'));
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

function orchestrator(model: LocalModel, cloud: 'claude'[], planner?: ProjectPlanner, models = defaultCloudModels()): StepExecutor {
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: cloud, models },
    projects: PROJECTS.map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1', ...(planner === undefined ? {} : { planner }) })),
  });
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings,
    rules: RULES,
    ...(cloud.length > 0 ? { claude, plannerPrompt: PLANNER } : {}),
  });
}

/** Runs the queued steps of `taskIds` (and of their cards «Piano»), at most `max`; the others' jobs are completed unrun. */
async function drain(taskIds: readonly string[], executor: StepExecutor, max = 30): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 30 && results.length < max; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    const id = job.payload.taskId;
    // The card «Piano» of a request drained is drained with it: its id is not known before.
    const child = typeof id === 'string' && (await db().sql`SELECT 1 FROM tasks WHERE id = ${id} AND planning = 'card' AND parent_id = ANY (${[...taskIds]}::uuid[])`).length > 0;
    if (typeof id !== 'string' || (!taskIds.includes(id) && !child)) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  if (results.length >= max) return results;
  throw new Error('drain did not end');
}

interface Row {
  id: string;
  title: string;
  assignee: string;
  status: string;
  label: string;
  project: string | null;
  queued: boolean;
  complexity: string | null;
  criteria: string | null;
  plan: string | null;
}

async function cardsOf(parentId: string): Promise<Row[]> {
  return [
    ...(await db().sql<Row[]>`
      SELECT id::text, title, assignee, status, label, project, complexity, done_criteria AS criteria, plan_approval_id::text AS plan,
        EXISTS (SELECT FROM jobs j WHERE j.key = 'task:' || t.id::text AND j.status IN ('queued', 'running')) AS queued
      FROM tasks t WHERE parent_id = ${parentId} AND planning IS NULL ORDER BY title`),
  ];
}

async function planCardOf(taskId: string): Promise<Task> {
  const [found] = await db().sql<{ id: string }[]>`SELECT id::text FROM tasks WHERE parent_id = ${taskId} AND planning = 'card'`;
  assert.ok(found !== undefined, 'the card «Piano» is on the wall');
  const card = await loadTask(db().sql, found.id);
  assert.ok(card !== undefined);
  return card;
}

async function reply(taskId: string): Promise<string | undefined> {
  const [message] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id LIMIT 1`;
  return message?.body;
}

test('«/progetta» in a private conversation: Arianna answers without a model, the card «Piano» plans on the local model, the plan waits in the chat and on the card (D-235)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, '/progetta la landing della pasticceria', MENTIONABLE);
  // Claude on and a project that would ask for Opus: a private conversation plans here all the same.
  const model = scripted([MINE]);
  const executor = orchestrator(model, ['claude'], 'opus');
  assert.deepEqual(await drain([task.id], executor, 1), ['answered']);
  assert.equal(await reply(task.id), 'Ho messo la pianificazione sul cardwall: card «Piano: la landing della pasticceria». Ti avviso quando è pronta.');
  assert.equal(model.requests.length, 0, 'the answer is written by the code');

  const card = await planCardOf(task.id);
  assert.deepEqual([card.title, card.assignee, card.status, card.label, card.conversationId, card.project, card.goal], [
    'Piano: la landing della pasticceria',
    'arianna',
    'ready',
    'L2',
    null,
    null,
    'la landing della pasticceria',
  ]);
  assert.equal((await listCards(db().sql)).find((item) => item.id === card.id)?.column, 'ready');

  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  assert.equal(model.requests.length, 1);
  assert.match(JSON.stringify(model.requests[0]?.schema?.schema), /"required":\["title","goal","assignee","blocked_by","criteria","complexity"\]/);
  const claudeLog = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${card.id} AND target = 'claude'`;
  assert.equal(claudeLog.length, 0, 'nothing left for Claude');

  const waiting = await loadTask(db().sql, card.id);
  assert.equal(waiting?.status, 'waiting_user');
  assert.equal(waiting.waitingReason, 'approval needed: task.plan');
  const approval = await loadApproval(db().sql, waiting.waitingApprovalId ?? '');
  assert.ok(approval !== undefined);
  // In the chat of «/progetta», under its message, and on the card; the notice leads to that chat.
  assert.deepEqual([approval.kind, approval.label, approval.taskId, approval.conversationId, approval.chatTaskId], ['plan', 'L2', card.id, conversation.id, task.id]);
  assert.ok((await listApprovals(db().sql, 'pending', 100, { conversationId: conversation.id })).some((item) => item.id === approval.id));
  assert.equal(await conversationOfTask(db().sql, card.id), conversation.id);
  const requested = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE task_id = ${card.id} AND kind = 'approval.requested'`;
  assert.equal(requested.length, 1);
  assert.ok(!JSON.stringify(requested[0]?.payload).includes('pasticceria'), 'the events carry no text of the plan');

  // Approved: all the cards in the inbox, none started (no agent's card here); the card «Piano» closes in Fatto.
  await recordDecision(db().sql, approval.id, 'approved', 'web');
  const cards = await cardsOf(task.id);
  assert.deepEqual(
    cards.map((item) => [item.title, item.assignee, item.status, item.label, item.project, item.queued, item.complexity, item.criteria, item.plan]),
    [
      ['Foto', 'user', 'inbox', 'L2', null, false, 'S', 'Foto: fatto e controllato.', approval.id],
      ['Testi', 'user', 'inbox', 'L2', null, false, 'M', 'Testi: fatto e controllato.', approval.id],
    ],
  );
  const closed = await loadTask(db().sql, card.id);
  assert.deepEqual([closed?.status, closed?.evidence, closed?.note], ['done', [{ kind: 'approval', ref: approval.id }], 'Piano approvato: 2 card create in Inbox.']);
  assert.deepEqual(await drain([card.id], executor), [], 'nothing more runs for the card «Piano»');
  // Arianna says it in the conversation, written by the code, at the plan's label (D-235).
  const [said] = await db().sql<{ body: string; label: string; role: string }[]>`
    SELECT body, label, role FROM messages WHERE conversation_id = ${conversation.id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([said?.role, said?.label], ['assistant', 'L2']);
  assert.match(said?.body ?? '', /^Ho creato 2 card per «.+», tutte in Inbox sul cardwall:/);
});

test('«/progetta» in a work conversation: Claude writes the plan as the project says, the plan is edited and checked, only the rows «Avvia subito» start (D-235)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, '/progetta la landing del sito', MENTIONABLE);
  const model = scripted([]);
  const executor = orchestrator(model, ['claude'], 'opus');
  assert.deepEqual(await drain([task.id], executor, 1), ['answered']);
  const card = await planCardOf(task.id);
  assert.deepEqual([card.label, card.project], ['L1', 'site']);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  assert.equal(model.requests.length, 0, 'the planner is called directly, never the local model');
  const log = await db().sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE task_id = ${card.id} AND target = 'claude'`;
  assert.deepEqual(
    log.map((entry) => entry.decision),
    ['allow'],
  );
  const asked = await loadTask(db().sql, card.id);
  const approval = await loadApproval(db().sql, asked?.waitingApprovalId ?? '');
  assert.ok(approval !== undefined);
  assert.deepEqual([approval.label, (approval.detail.cards as unknown[]).length], ['L1', 4]);
  // Opus asked and on: no note of a fallback, on the card or in the plan.
  assert.deepEqual([asked?.note, approval.detail.writtenBy], [null, undefined]);

  // Edited before the decision: checked again, at the privacy of the conversation.
  const assignees = ['user', 'coder', 'designer'];
  await assert.rejects(editPlan(db().sql, approval.id, { title: 'Landing', cards: [row('A', 'user', [2]), row('B', 'user', [1])] }, assignees), /only earlier cards/);
  await assert.rejects(editPlan(db().sql, approval.id, { title: 'Landing', cards: [row('A', 'reviewer', []), row('B', 'user', [])] }, assignees), /"assignee" must be one of/);
  await assert.rejects(
    editPlan(db().sql, approval.id, { title: 'Landing', cards: [{ ...row('A', 'user', []), goal: 'Pagare su IT60X0542811101000000123456' }, row('B', 'user', [])] }, assignees),
    (error: unknown) => error instanceof PlanError && /a work conversation cannot hold this plan \(iban\)/.test(error.message),
  );
  const edited = await editPlan(
    db().sql,
    approval.id,
    { title: 'Landing del sito', cards: [...AGENTS.cards, row('Rifiniture', 'coder', [1], 'S')] },
    assignees,
  );
  assert.deepEqual([edited.state, edited.label, (edited.detail.cards as unknown[]).length, edited.detail.edited, edited.detail.revision], ['pending', 'L1', 5, true, 1]);
  const editedEvents = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE kind = 'approval.edited' AND payload ->> 'approvalId' = ${approval.id}`;
  assert.deepEqual(editedEvents.map((event) => event.payload), [{ approvalId: approval.id, cards: 5 }]);

  // «Avvia subito»: never the user's card; an agent's card that waits may start, held back by the engine.
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'web', undefined, { starts: [3] }), PlanError);
  // A card of the chat still showing the plan as the planner wrote it: nothing starts unseen.
  await assert.rejects(
    recordDecision(db().sql, approval.id, 'approved', 'web', undefined, { starts: [1], revision: 0 }),
    (error: unknown) => error instanceof PlanError && error.code === 'conflict',
  );
  assert.equal((await loadApproval(db().sql, approval.id))?.state, 'pending');
  await recordDecision(db().sql, approval.id, 'approved', 'web', undefined, { starts: [1, 5], revision: 1 });
  const cards = await cardsOf(task.id);
  assert.deepEqual(
    cards.map((item) => [item.title, item.assignee, item.status, item.queued, item.project, item.label]),
    [
      ['Codice', 'coder', 'inbox', false, 'site', 'L1'],
      ['Controlli', 'coder', 'inbox', false, 'site', 'L1'],
      ['Grafica', 'designer', 'ready', true, 'site', 'L1'],
      ['Rifiniture', 'coder', 'ready', true, 'site', 'L1'],
      ['Testi', 'user', 'inbox', false, 'site', 'L1'],
    ],
  );
  assert.deepEqual((await loadApproval(db().sql, approval.id))?.detail.starts, [1, 5]);
  // The cardwall shows each card's size (S/M/L) as the plan said it.
  const wall = await listCards(db().sql);
  assert.deepEqual(
    cards.map((item) => [item.title, wall.find((shown) => shown.id === item.id)?.complexity]),
    [
      ['Codice', 'L'],
      ['Controlli', 'M'],
      ['Grafica', 'M'],
      ['Rifiniture', 'S'],
      ['Testi', 'S'],
    ],
  );
  assert.equal(wall.find((shown) => shown.id === card.id)?.complexity, null, 'the card «Piano» has no size');
  // The card that waits for the design is held back, not run.
  const finishing = cards.find((item) => item.title === 'Rifiniture')?.id ?? '';
  assert.deepEqual(await drain([finishing], executor), ['blocked']);
  assert.equal((await loadTask(db().sql, card.id))?.status, 'done');
  await assert.rejects(editPlan(db().sql, approval.id, { title: 'Tardi', cards: [row('A', 'user', []), row('B', 'user', [])] }, assignees), /already approved/);
});

test('«/progetta» with `planner = "opus"` and Opus off: Sonnet writes the plan, and the card «Piano» and the plan say so, before and after the decision (D-235)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, '/progetta la landing del sito', MENTIONABLE);
  const model = scripted([]);
  const executor = orchestrator(model, ['claude'], 'opus', { ...defaultCloudModels(), opus: { enabled: false } });
  assert.deepEqual(await drain([task.id], executor, 1), ['answered']);
  const card = await planCardOf(task.id);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  assert.equal(model.requests.length, 0, 'Claude writes it, not the local model');
  const asked = await loadTask(db().sql, card.id);
  assert.equal(asked?.note, 'Scritto da Sonnet: Opus è spento');
  const approval = await loadApproval(db().sql, asked.waitingApprovalId ?? '');
  assert.ok(approval !== undefined);
  assert.equal(approval.detail.writtenBy, 'Scritto da Sonnet: Opus è spento');
  // An edit keeps it.
  const edited = await editPlan(db().sql, approval.id, { title: 'Landing', cards: [row('A', 'user', []), row('B', 'user', [1])] }, ['user', 'coder', 'designer']);
  assert.equal(edited.detail.writtenBy, 'Scritto da Sonnet: Opus è spento');
  await recordDecision(db().sql, approval.id, 'rejected', 'web', undefined, { revision: 1 });
  const closed = await loadTask(db().sql, card.id);
  assert.deepEqual([closed?.status, closed?.note], ['done', 'Piano non approvato: nessuna card creata.\nScritto da Sonnet: Opus è spento.']);
});

test('«/progetta» with `planner = "local"`: a work conversation plans on the local model; a rejected plan closes the card with no card created (D-235)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, '/progetta il sito', MENTIONABLE);
  const model = scripted([AGENTS]);
  const executor = orchestrator(model, ['claude'], 'local');
  assert.deepEqual(await drain([task.id], executor, 1), ['answered']);
  const card = await planCardOf(task.id);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  assert.equal(model.requests.length, 1);
  const claudeLog = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${card.id} AND target = 'claude'`;
  assert.equal(claudeLog.length, 0);
  const approval = await loadApproval(db().sql, (await loadTask(db().sql, card.id))?.waitingApprovalId ?? '');
  assert.ok(approval !== undefined);
  await recordDecision(db().sql, approval.id, 'rejected', 'web');
  assert.deepEqual(await cardsOf(task.id), []);
  const closed = await loadTask(db().sql, card.id);
  assert.deepEqual([closed?.status, closed?.note], ['done', 'Piano non approvato: nessuna card creata.']);
  const [said] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE conversation_id = ${conversation.id} ORDER BY id DESC LIMIT 1`;
  assert.equal(said?.body, 'Va bene, non ho creato nessuna card.');
});

test('«/progetta» is refused without text, in a work conversation without a project, in incognito; without the web chat it is an ordinary message (D-235)', async () => {
  const work = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  await assert.rejects(postUserMessage(db().sql, work.id, '/progetta   ', MENTIONABLE), (error: unknown) => error instanceof ChatError && /write after \/progetta/.test(error.message));
  const bare = await createConversation(db().sql, { mode: 'work' });
  await assert.rejects(postUserMessage(db().sql, bare.id, '/progetta il sito', MENTIONABLE), /needs a work conversation with a project/);
  const incognito = await createConversation(db().sql, { mode: 'private', incognito: true });
  await assert.rejects(postUserMessage(db().sql, incognito.id, '/progetta il sito', MENTIONABLE), /does not work in incognito/);
  const { task } = await postUserMessage(db().sql, work.id, '/progetta il sito');
  const [plain] = await db().sql<{ planning: string | null }[]>`SELECT planning FROM tasks WHERE id = ${task.id}`;
  assert.equal(plain?.planning, null);
});

test('the database keeps «/progetta» and the plans in shape: a card «Piano» is Arianna’s, a request has a conversation, the size only on a card, a decided plan never changes (D-235)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'ciao');
  await assert.rejects(db().sql`UPDATE tasks SET complexity = 'M' WHERE id = ${task.id}`, /tasks_complexity_only_cards/);
  await assert.rejects(db().sql`UPDATE tasks SET complexity = 'XL' WHERE id = ${task.id}`, /complexity_check/);
  await assert.rejects(db().sql`UPDATE tasks SET planning = 'card' WHERE id = ${task.id}`, /tasks_planning_fields/);
  const [orphan] = await db().sql<{ id: string }[]>`INSERT INTO tasks (title, assignee, status) VALUES ('Piano: x', 'coder', 'inbox') RETURNING id::text`;
  await assert.rejects(db().sql`UPDATE tasks SET planning = 'card' WHERE id = ${orphan?.id ?? ''}`, /tasks_planning_fields/);
  await assert.rejects(db().sql`UPDATE tasks SET planning = 'request' WHERE id = ${orphan?.id ?? ''}`, /tasks_planning_fields/);
  // A pending plan's detail may change, nothing else of it; decided, nothing.
  const [plan] = await db().sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'plan', 'task.plan', ${db().sql.json(MINE)}, 'L2') RETURNING id::text`;
  const id = plan?.id ?? '';
  await db().sql`UPDATE approvals SET detail = ${db().sql.json({ ...MINE, title: 'Altro' })} WHERE id = ${id}`;
  await assert.rejects(db().sql`UPDATE approvals SET action = 'x' WHERE id = ${id}`, /only the decision can change/);
  await recordDecision(db().sql, id, 'rejected', 'web');
  await assert.rejects(db().sql`UPDATE approvals SET detail = ${db().sql.json(MINE)} WHERE id = ${id}`, /already rejected/);
  // Another kind's detail never changes while pending.
  const [action] = await db().sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'action', 'send_external', '{}', 'L2') RETURNING id::text`;
  await assert.rejects(db().sql`UPDATE approvals SET detail = '{"x":1}' WHERE id = ${action?.id ?? ''}`, /only the decision can change/);
});

test('the routes: PUT /api/approvals/:id/plan edits a pending plan, 400 for a plan that does not hold; «starts» goes with the decision (D-235)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'organizza');
  const [plan] = await db().sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'plan', 'task.plan', ${db().sql.json({ ...MINE, step: 1 })}, 'L2') RETURNING id::text`;
  const id = plan?.id ?? '';
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [], agents: () => ['arianna', 'coder'], mentionable: () => ['coder'] });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const call = (method: string, path: string, body: unknown) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await call('PUT', `/api/approvals/${id}/plan`, { title: 'X', cards: [row('A', 'user', [1]), row('B', 'user', [])] })).status, 400);
    assert.equal((await call('PUT', `/api/approvals/${id}/plan`, { title: 'X', cards: [row('A', 'designer', []), row('B', 'user', [])] })).status, 400, 'not an agent Arianna calls');
    assert.equal((await call('PUT', `/api/approvals/${id}/plan`, { title: 'X', cards: [], other: 1 })).status, 400);
    assert.equal((await call('PUT', `/api/approvals/${randomUUID()}/plan`, { title: 'X', cards: [] })).status, 404);
    // Private: an IBAN may be written in the plan of a private conversation.
    const ok = await call('PUT', `/api/approvals/${id}/plan`, { title: 'Nuovo', cards: [row('A', 'coder', []), { ...row('B', 'user', [1]), goal: 'Bonifico su IT60X0542811101000000123456' }] });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { approval: { detail: { title: string; step: number } } };
    assert.deepEqual([body.approval.detail.title, body.approval.detail.step], ['Nuovo', 1]);
    assert.equal((await call('POST', `/api/approvals/${id}/decision`, { state: 'approved', starts: [2] })).status, 400, 'the user’s card does not start');
    assert.equal((await call('POST', `/api/approvals/${id}/decision`, { state: 'approved', starts: 'tutte' })).status, 400);
    assert.equal((await call('POST', `/api/approvals/${id}/decision`, { state: 'approved', starts: [1], revision: 0 })).status, 409, 'an older version of the plan');
    assert.equal((await call('POST', `/api/approvals/${id}/decision`, { state: 'approved', starts: [1], revision: 1 })).status, 200);
    assert.equal((await call('PUT', `/api/approvals/${id}/plan`, { title: 'X', cards: [row('A', 'user', []), row('B', 'user', [])] })).status, 409);
    const cards = await cardsOf(task.id);
    assert.deepEqual(
      cards.map((item) => [item.title, item.status, item.queued]),
      [
        ['A', 'ready', true],
        ['B', 'inbox', false],
      ],
    );
  } finally {
    await server.close();
    await live.close();
  }
});

/** A conversation with «/progetta» whose card «Piano» waits for its plan; `decide` approves it first. */
async function waitingPlan(mode: 'work' | 'private', decide: boolean): Promise<{ conversationId: string; task: Task; card: Task; approvalId: string }> {
  const conversation = mode === 'work' ? await createConversation(db().sql, { mode, project: 'site', projects: PROJECTS }) : await createConversation(db().sql, { mode });
  const { task } = await postUserMessage(db().sql, conversation.id, '/progetta il trasloco dello studio', MENTIONABLE);
  const executor = orchestrator(scripted([MINE]), []);
  assert.deepEqual(await drain([task.id], executor), ['answered', 'waiting-approval']);
  const card = await planCardOf(task.id);
  const approvalId = (await loadTask(db().sql, card.id))?.waitingApprovalId ?? '';
  if (decide) await recordDecision(db().sql, approvalId, 'approved', 'web', undefined, { starts: [] });
  return { conversationId: conversation.id, task, card, approvalId };
}

test('the user decides in the moment between the plan written and the card waiting: the card «Piano» still closes in Fatto (D-235)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, '/progetta la cantina', MENTIONABLE);
  assert.deepEqual(await drain([task.id], orchestrator(scripted([]), []), 1), ['answered']);
  const card = await planCardOf(task.id);
  // The step writes the plan and the user approves it before the step ends.
  const racing: StepExecutor = {
    plan: (planned) => Promise.resolve({ agent: planned.assignee, executor: 'local', locality: 'local' }),
    async run(ctx) {
      const approvalId = await db().sql.begin((tx) => requestPlan(tx, { taskId: ctx.task.id, step: ctx.step, label: 'L2', plan: { title: 'Cantina', cards: MINE.cards.map((item) => ({ title: item.title, goal: item.goal, assignee: 'user', blockedBy: item.blocked_by, criteria: item.criteria, complexity: 'M' })) } }));
      await recordDecision(db().sql, approvalId, 'approved', 'web');
      return { kind: 'confirm', approvalId, usage: { steps: 0 } };
    },
  };
  assert.deepEqual(await drain([card.id], racing), ['answered']);
  const closed = await loadTask(db().sql, card.id);
  assert.deepEqual([closed?.status, closed?.note], ['done', 'Piano approvato: 2 card create in Inbox.']);
  assert.equal((await cardsOf(task.id)).length, 2);
  assert.deepEqual(await drain([card.id], racing), [], 'nothing queued again');
});

test('one card «Piano» per request: a second one is refused by the database (D-235)', async () => {
  const { task } = await waitingPlan('private', false);
  await assert.rejects(
    db().sql`INSERT INTO tasks (title, assignee, status, parent_id, planning) VALUES ('Piano: altro', 'arianna', 'ready', ${task.id}, 'card')`,
    /tasks_planning_card_one/,
  );
});

test('«Elimina per sempre» erases the card «Piano» with the conversation; the cards of the plan stay, without the link (D-235, D-157)', async () => {
  const { conversationId, card, approvalId } = await waitingPlan('private', true);
  const [created] = await db().sql<{ id: string }[]>`SELECT id::text FROM tasks WHERE plan_approval_id = ${approvalId} ORDER BY title LIMIT 1`;
  assert.ok(created !== undefined);
  await eraseConversation(db().sql, conversationId);
  assert.equal((await db().sql`SELECT 1 FROM tasks WHERE id = ${card.id}`).length, 0, 'the request word for word is gone');
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE id = ${approvalId}`).length, 0, 'the plan is gone');
  const [kept] = await db().sql<{ plan: string | null; parent: string | null }[]>`SELECT plan_approval_id::text AS plan, parent_id::text AS parent FROM tasks WHERE id = ${created.id}`;
  assert.deepEqual(kept, { plan: null, parent: null });
});

test('«Elimina» purges the card «Piano» with the conversation: the request and a pending plan emptied, the card closed (D-235)', async () => {
  const { conversationId, card, approvalId } = await waitingPlan('private', false);
  await archiveConversation(db().sql, conversationId, true);
  await purgeConversation(db().sql, conversationId);
  const purged = await loadTask(db().sql, card.id);
  assert.deepEqual([purged?.status, purged?.title, purged?.goal], ['failed', 'Conversazione eliminata', null]);
  const plan = await loadApproval(db().sql, approvalId);
  assert.deepEqual([plan?.state, plan?.detail], ['expired', { purged: true }]);
});

/** «/progetta <brief>» planned on the local model and waiting: the chat task, the card «Piano» and its approval. */
async function plannedWith(brief: string, mode: 'work' | 'private'): Promise<{ conversationId: string; task: Task; approvalId: string }> {
  const conversation = mode === 'work' ? await createConversation(db().sql, { mode, project: 'site', projects: PROJECTS }) : await createConversation(db().sql, { mode });
  const { task } = await postUserMessage(db().sql, conversation.id, `/progetta ${brief}`, MENTIONABLE);
  const executor = orchestrator(scripted([MINE]), [], 'local');
  assert.deepEqual(await drain([task.id], executor), ['answered', 'waiting-approval']);
  const card = await planCardOf(task.id);
  return { conversationId: conversation.id, task, approvalId: (await loadTask(db().sql, card.id))?.waitingApprovalId ?? '' };
}

async function lastSaid(conversationId: string): Promise<string | undefined> {
  const [said] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE conversation_id = ${conversationId} ORDER BY id DESC LIMIT 1`;
  return said?.body;
}

test('«/progetta la milestone …»: the plan shows the milestone, the approval creates it with the cards in it, the same name gets them, «Non ora» and no project make none (D-313, seguito 3)', async () => {
  const name = `Accessi ${randomUUID().slice(0, 8)}`;
  const first = await plannedWith(`la milestone «${name}» entro fine novembre che deve fare testi e foto`, 'work');
  const approval = await loadApproval(db().sql, first.approvalId);
  assert.equal((approval?.detail.milestone as { title?: string } | undefined)?.title, name);
  assert.match((approval?.detail.milestone as { due?: string } | undefined)?.due ?? '', /^\d{4}-11-30$/);
  await recordDecision(db().sql, first.approvalId, 'approved', 'web', undefined, { starts: [] });
  const milestones = await db().sql<{ id: string; due: string; label: string; approval: string }[]>`
    SELECT id::text, to_char(due_on, 'MM-DD') AS due, label, approval_id::text AS approval FROM milestones WHERE project = 'site' AND title = ${name}`;
  assert.deepEqual(milestones.map((row) => [row.due, row.label, row.approval]), [['11-30', 'L2', first.approvalId]]);
  const inside = await db().sql<{ title: string }[]>`SELECT title FROM tasks WHERE milestone_id = ${milestones[0]?.id ?? ''}::uuid ORDER BY title`;
  assert.deepEqual(inside.map((row) => row.title), ['Foto', 'Testi']);
  assert.match((await lastSaid(first.conversationId)) ?? '', new RegExp(`\\n\\nSono nella milestone «${name}» di site, che scade lunedì 30 novembre \\d{4}\\.$`));

  // The same name, in another case: the cards go in the open milestone, never a second one.
  const second = await plannedWith(`la milestone ${name.toLowerCase()}: testi e foto della seconda pagina`, 'work');
  await recordDecision(db().sql, second.approvalId, 'approved', 'web', undefined, { starts: [] });
  const [count] = await db().sql<{ milestones: number; cards: number }[]>`
    SELECT count(DISTINCT m.id)::int AS milestones, count(t.id)::int AS cards FROM milestones m LEFT JOIN tasks t ON t.milestone_id = m.id WHERE m.project = 'site' AND lower(m.title) = lower(${name})`;
  assert.deepEqual([count?.milestones, count?.cards], [1, 4]);

  // «Non ora»: no milestone, no card.
  const other = `Pagamenti ${randomUUID().slice(0, 8)}`;
  const rejected = await plannedWith(`la milestone «${other}» con carrello e checkout`, 'work');
  await recordDecision(db().sql, rejected.approvalId, 'rejected', 'web');
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE title = ${other}`).length, 0);
  assert.deepEqual(await cardsOf(rejected.task.id), []);

  // A private conversation has no project: the plan names no milestone, so the card promises none.
  const alone = `Trasloco ${randomUUID().slice(0, 8)}`;
  const privately = await plannedWith(`la milestone «${alone}» con scatoloni e furgone`, 'private');
  assert.equal((await loadApproval(db().sql, privately.approvalId))?.detail.milestone, undefined);
  await recordDecision(db().sql, privately.approvalId, 'approved', 'web', undefined, { starts: [] });
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE title = ${alone}`).length, 0);
  assert.equal((await cardsOf(privately.task.id)).length, 2);
  assert.doesNotMatch((await lastSaid(privately.conversationId)) ?? '', /milestone/);

  // The plan edited before the decision keeps its milestone.
  const kept = `Ordini ${randomUUID().slice(0, 8)}`;
  const edited = await plannedWith(`la milestone «${kept}» con lista e dettaglio`, 'work');
  await editPlan(db().sql, edited.approvalId, { title: 'Ordini', cards: [row('Lista', 'user', []), row('Dettaglio', 'user', [1])] }, ['user']);
  assert.equal(((await loadApproval(db().sql, edited.approvalId))?.detail.milestone as { title?: string } | undefined)?.title, kept);

  // A plan without a milestone has none in its detail.
  const plain = await plannedWith('il sito della pasticceria', 'work');
  assert.equal((await loadApproval(db().sql, plain.approvalId))?.detail.milestone, undefined);
});

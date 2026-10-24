// Milestones proposed in the chat (D-313, seguito 2): milestone.propose writes
// an approval of kind `milestone_plan`; nothing is created until the user
// approves it in the web chat, then the milestone and its cards in the inbox.
// A positive and a negative case for the proposal, «Crea la milestone»,
// «Non ora», the fields refused and the database. Fake data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { secretaryConversationId } from '../src/commitments.ts';
import { archiveConversation, createConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, submitTask } from '../src/engine.ts';
import { eraseConversation } from '../src/erase.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createMilestone, MAX_OPEN_MILESTONES } from '../src/milestones.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask, type Task } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `milestone-propose-${randomUUID()}`);
const agents = committedAgents(ROOT);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
// Each run its own project: the open milestones of another run never get in the way.
const PROJECT = `panificio-${randomUUID().slice(0, 8)}`;
const PROJECTS: Project[] = [
  { name: PROJECT, path: `repos/${PROJECT}`, absolute: join(HOME, PROJECT), label: 'L1' },
  { name: 'demo', path: 'repos/demo', absolute: join(HOME, 'demo'), label: 'L1' },
];

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function scripted(answers: Answer[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = { thought: 'Ragiono.', ...next };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

const orchestrator = (model: LocalModel) =>
  createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...CONFIG, projects: PROJECTS, cloud: { executors: [], models: defaultCloudModels() }, personas: {} }),
    rules: RULES,
  });

async function drain(taskId: string, model: LocalModel): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const executor = orchestrator(model);
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

const REQUEST = `Crea la milestone Accessi su ${PROJECT} con design, database e implementazione, entro venerdì.`;
const propose = (title: string, extra: Record<string, unknown> = {}): Answer => ({
  action: 'call',
  tool: 'milestone.propose',
  arguments: { title, project: PROJECT, due: 'venerdì', cards: ['Design', 'Database', 'Implementazione'], ...extra },
});

async function ask(mode: 'work' | 'private', body = REQUEST, extra: { incognito?: boolean } = {}) {
  const conversation =
    mode === 'work' ? await createConversation(db().sql, { mode, project: 'demo', projects: ['demo'] }) : await createConversation(db().sql, { mode, ...extra });
  return postUserMessage(db().sql, conversation.id, body);
}

async function waitingApproval(taskId: string): Promise<string> {
  const task = await loadTask(db().sql, taskId);
  assert.ok(task?.status === 'waiting_user' && task.waitingApprovalId !== null);
  return task.waitingApprovalId;
}

async function lastReply(taskId: string): Promise<{ body: string; label: string } | undefined> {
  const [row] = await db().sql<{ body: string; label: string }[]>`
    SELECT body, label FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id DESC LIMIT 1`;
  return row;
}

const offersMilestone = (request: ChatRequest | undefined) => /^- milestone\.propose:/m.test(request?.messages[0]?.content ?? '');

test('milestone.propose: nothing before the decision; «Crea la milestone» in the chat writes it with its cards in the inbox, and Arianna answers by code', async () => {
  const title = `Accessi ${randomUUID().slice(0, 6)}`;
  const { task } = await ask('private');
  const model = scripted([propose(title)]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  assert.ok(offersMilestone(model.requests[0]));
  const approvalId = await waitingApproval(task.id);
  const [approval] = await db().sql<{ kind: string; action: string; label: string; detail: Record<string, unknown> }[]>`
    SELECT kind, action, label::text, detail FROM approvals WHERE id = ${approvalId}`;
  assert.ok(approval !== undefined);
  assert.deepEqual([approval.kind, approval.action, approval.label, approval.detail.title, approval.detail.project], ['milestone_plan', 'milestone.propose', 'L2', title, PROJECT]);
  assert.deepEqual(approval.detail.cards, ['Design', 'Database', 'Implementazione']);
  assert.match(String(approval.detail.due), /^\d{4}-\d{2}-\d{2}$/);
  // Nothing written yet.
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE project = ${PROJECT} AND title = ${title}`).length, 0);
  // Decided in the web chat only.
  await assert.rejects(recordDecision(db().sql, approvalId, 'approved', 'telegram'));
  await recordDecision(db().sql, approvalId, 'approved', 'web');
  const [milestone] = await db().sql<{ id: string; label: string; status: string; due: string }[]>`
    SELECT id::text, label::text, status, due_on::text AS due FROM milestones WHERE approval_id = ${approvalId}`;
  assert.ok(milestone !== undefined);
  assert.deepEqual([milestone.label, milestone.status, milestone.due], ['L2', 'open', approval.detail.due]);
  const cards = await db().sql<{ title: string; status: string; assignee: string; project: string; parent: string; milestone: string; label: string }[]>`
    SELECT title, status, assignee, project, parent_id::text AS parent, milestone_id::text AS milestone, label::text FROM tasks
    WHERE milestone_id = ${milestone.id} ORDER BY title`;
  assert.deepEqual(
    cards.map((card) => [card.title, card.status, card.assignee, card.project, card.parent, card.milestone, card.label]),
    ['Database', 'Design', 'Implementazione'].map((name) => [name, 'inbox', 'user', PROJECT, task.id, milestone.id, 'L2']),
  );
  // The events name ids only, never the title.
  const events = await db().sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE payload ->> 'milestoneId' = ${milestone.id}`;
  assert.ok(events.length >= 4);
  assert.doesNotMatch(JSON.stringify(events), /Accessi|Design/);
  // The next step answers without the model.
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  const reply = await lastReply(task.id);
  assert.match(reply?.body ?? '', new RegExp(`^Ho creato la milestone «${title}» di ${PROJECT}, scade venerdì .*, con 3 card in Inbox`));
  assert.equal(reply?.label, 'L2');
  // A second decision changes nothing: one milestone per approval.
  await assert.rejects(recordDecision(db().sql, approvalId, 'approved', 'web'));
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE approval_id = ${approvalId}`).length, 1);
});

test('«Non ora»: no milestone, no card; and in a work conversation the project is its own, at its label', async () => {
  const title = `Sezione dashboard ${randomUUID().slice(0, 6)}`;
  const { task } = await ask('work', `Crea la milestone ${title} con design e implementazione.`);
  const model = scripted([{ action: 'call', tool: 'milestone.propose', arguments: { title, cards: ['Design', 'Implementazione'] } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  assert.ok(offersMilestone(model.requests[0]));
  const approvalId = await waitingApproval(task.id);
  const [approval] = await db().sql<{ label: string; detail: Record<string, unknown> }[]>`SELECT label::text, detail FROM approvals WHERE id = ${approvalId}`;
  assert.deepEqual([approval?.detail.project, approval?.label], ['demo', 'L1']);
  await recordDecision(db().sql, approvalId, 'rejected', 'web');
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE title = ${title}`).length, 0);
  assert.equal((await db().sql`SELECT 1 FROM tasks WHERE parent_id = ${task.id}`).length, 0);
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  assert.match((await lastReply(task.id))?.body ?? '', /^Va bene: non ho creato la milestone/);
});

test('refused by code: an unknown project, another project in a work conversation, a title already open; the model reads why, nothing is written', async () => {
  const title = `Pagamenti ${randomUUID().slice(0, 6)}`;
  await createMilestone(db().sql, { project: PROJECT, title }, { projects: PROJECTS });
  const { task } = await ask('private', `Crea la milestone ${title}.`);
  const model = scripted([
    propose('Accessi', { project: 'forno-bianchi' }),
    propose(title.toUpperCase()),
    { action: 'reply', text: 'C’è già una milestone con questo nome.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: milestone\.propose: no project 'forno-bianchi'/);
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', /error: milestone\.propose: .* already has an open milestone with this title/);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${task.id}`).length, 0);

  const work = await ask('work', 'Crea una milestone su un altro progetto.');
  const atWork = scripted([propose('Accessi'), { action: 'reply', text: 'Va chiesta nella sua conversazione.' }]);
  assert.deepEqual(await drain(work.task.id, atWork), ['continued', 'answered']);
  assert.match(atWork.requests[1]?.messages.at(-1)?.content ?? '', /error: milestone\.propose: this conversation is of the project demo/);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${work.task.id}`).length, 0);
});

test('an incognito conversation does not offer it', async () => {
  const incognito = await ask('private', REQUEST, { incognito: true });
  const quiet = scripted([{ action: 'reply', text: 'Ok.' }]);
  await drain(incognito.task.id, quiet);
  assert.ok(quiet.requests.length > 0);
  assert.ok(!offersMilestone(quiet.requests[0]));
});

test('the database: a milestone_plan approval only with its fields, a task and at most Privato; one milestone per approval', async () => {
  const { sql } = db();
  const task = await submitTask(sql, { title: 'Prova', assignee: 'arianna', label: 'L1', clearance: 'L2', effectiveLabel: 'L1' });
  const detail = { project: PROJECT, title: 'Finta', cards: [] };
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'milestone_plan', 'milestone.propose', ${sql.json({ title: 'x' })}, 'L2')`);
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (NULL, 'milestone_plan', 'milestone.propose', ${sql.json(detail)}, 'L2')`);
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'milestone_plan', 'milestone.close', ${sql.json(detail)}, 'L2')`);
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'milestone_plan', 'milestone.propose', ${sql.json(detail)}, 'L3')`);
  const [approval] = await sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'milestone_plan', 'milestone.propose', ${sql.json(detail)}, 'L2') RETURNING id::text`;
  assert.ok(approval !== undefined);
  await sql`INSERT INTO milestones (project, title, approval_id) VALUES (${PROJECT}, ${`Finta ${randomUUID().slice(0, 6)}`}, ${approval.id})`;
  await assert.rejects(sql`INSERT INTO milestones (project, title, approval_id) VALUES (${PROJECT}, ${`Finta ${randomUUID().slice(0, 6)}`}, ${approval.id})`);
});

test('the decision checks again: a title opened meanwhile, a full project; the answer says why, nothing is created', async () => {
  const title = `Doppia ${randomUUID().slice(0, 6)}`;
  const { task } = await ask('private', `Crea la milestone ${title}.`);
  await drain(task.id, scripted([propose(title)]));
  const approvalId = await waitingApproval(task.id);
  // Written on the wall while the card waited.
  await createMilestone(db().sql, { project: PROJECT, title }, { projects: PROJECTS });
  await recordDecision(db().sql, approvalId, 'approved', 'web');
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE approval_id = ${approvalId}`).length, 0);
  assert.equal((await db().sql`SELECT 1 FROM tasks WHERE parent_id = ${task.id}`).length, 0);
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  assert.match((await lastReply(task.id))?.body ?? '', /ne ha già una aperta con questo nome/);

  // A project of its own, filled up to the limit.
  const full = `pieno-${randomUUID().slice(0, 8)}`;
  const projects: Project[] = [...PROJECTS, { name: full, path: `repos/${full}`, absolute: join(HOME, full), label: 'L1' }];
  for (let index = 0; index < MAX_OPEN_MILESTONES; index += 1) await db().sql`INSERT INTO milestones (project, title, position) VALUES (${full}, ${`M${String(index)}`}, ${index})`;
  const second = await ask('private', 'Crea la milestone Ultima.');
  const model = scripted([propose('Ultima', { project: full })]);
  const executor = createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...CONFIG, projects, cloud: { executors: [], models: defaultCloudModels() }, personas: {} }),
    rules: RULES,
  });
  const queue = createJobQueue(db().sql);
  for (let guard = 0; guard < 10; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) break;
    if (job.payload.taskId !== second.task.id) await completeJob(db().sql, job.id, 'test-worker');
    else await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS);
  }
  const fullApproval = await waitingApproval(second.task.id);
  await recordDecision(db().sql, fullApproval, 'approved', 'web');
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE approval_id = ${fullApproval}`).length, 0);
  assert.deepEqual(await drain(second.task.id, scripted([])), ['answered']);
  assert.match((await lastReply(second.task.id))?.body ?? '', /già 50 milestone aperte/);
});

test('a step replayed after a crash: the same approval while pending, the answer once decided meanwhile', async () => {
  const title = `Replay ${randomUUID().slice(0, 6)}`;
  const { task } = await ask('private', `Crea la milestone ${title}.`);
  const model = scripted([propose(title)]);
  const executor = orchestrator(model);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approvalId = await waitingApproval(task.id);
  const [turn] = await db().sql<{ step: number }[]>`SELECT step FROM task_turns WHERE task_id = ${task.id} ORDER BY step DESC LIMIT 1`;
  const [run] = await db().sql<{ id: string }[]>`SELECT id::text FROM runs WHERE task_id = ${task.id} ORDER BY id DESC LIMIT 1`;
  assert.ok(turn !== undefined && run !== undefined);
  const replay = async () =>
    executor.run({ task: (await loadTask(db().sql, task.id)) as Task, step: turn.step, runId: run.id, signal: new AbortController().signal, setSessionRef: () => Promise.resolve() });
  const pending = await replay();
  assert.deepEqual([pending.kind, pending.kind === 'confirm' ? pending.approvalId : undefined], ['confirm', approvalId]);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${task.id}`).length, 1);
  await recordDecision(db().sql, approvalId, 'approved', 'web');
  assert.equal((await replay()).kind, 'answered');
  assert.equal(model.requests.length, 1);
  assert.equal((await db().sql`SELECT 1 FROM milestones WHERE approval_id = ${approvalId}`).length, 1);
  assert.match((await lastReply(task.id))?.body ?? '', new RegExp(`^Ho creato la milestone «${title}»`));
});

test('the secretary does not offer it', async () => {
  const secretary = await secretaryConversationId(db().sql);
  const { task } = await postUserMessage(db().sql, secretary, REQUEST);
  const quiet = scripted([{ action: 'reply', text: 'Ok.' }]);
  await drain(task.id, quiet);
  assert.ok(quiet.requests.length > 0);
  assert.ok(!offersMilestone(quiet.requests[0]));
});

test('purged, the approval keeps only {"purged": true}; erased, the milestone and its cards stay on the wall without it', async () => {
  const purgedTitle = `Purga ${randomUUID().slice(0, 6)}`;
  const purged = await ask('private', `Crea la milestone ${purgedTitle}.`);
  await drain(purged.task.id, scripted([propose(purgedTitle)]));
  const pendingId = await waitingApproval(purged.task.id);
  const purgedConversation = (await loadTask(db().sql, purged.task.id))?.conversationId ?? '';
  await archiveConversation(db().sql, purgedConversation, true);
  await purgeConversation(db().sql, purgedConversation);
  const [row] = await db().sql<{ state: string; detail: unknown }[]>`SELECT state, detail FROM approvals WHERE id = ${pendingId}`;
  assert.deepEqual([row?.state, row?.detail], ['expired', { purged: true }]);

  const title = `Cancella ${randomUUID().slice(0, 6)}`;
  const { task } = await ask('private', `Crea la milestone ${title}.`);
  await drain(task.id, scripted([propose(title, { cards: ['Design'] })]));
  const approvalId = await waitingApproval(task.id);
  await recordDecision(db().sql, approvalId, 'approved', 'web');
  await drain(task.id, scripted([]));
  const [made] = await db().sql<{ id: string }[]>`SELECT id::text FROM milestones WHERE approval_id = ${approvalId}`;
  assert.ok(made !== undefined);
  // Set once: never another approval.
  await assert.rejects(db().owner`UPDATE milestones SET approval_id = ${randomUUID()} WHERE id = ${made.id}`, /set once/);
  const conversationId = (await loadTask(db().sql, task.id))?.conversationId ?? '';
  await archiveConversation(db().sql, conversationId, true);
  await eraseConversation(db().sql, conversationId);
  const [kept] = await db().sql<{ approval: string | null; status: string }[]>`SELECT approval_id::text AS approval, status FROM milestones WHERE id = ${made.id}`;
  assert.deepEqual([kept?.approval, kept?.status], [null, 'open']);
  assert.equal((await db().sql`SELECT 1 FROM tasks WHERE milestone_id = ${made.id}`).length, 1);
});

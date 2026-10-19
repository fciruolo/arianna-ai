// Routines proposed in the chat (D-110, tappa A2; D-256): routine.propose
// writes a routine `proposed`, off, with an approval the user decides in the
// web chat or on the page «Routine». A positive and a negative case for the
// proposal, «Attiva», «Scarta» and the fields refused. Fake data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { createConversation, listConversations, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, submitTask } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createRoutine, createRoutineService, decideRoutine, listRoutines, loadRoutine, pauseRoutine, retireRoutine, runNow, updateRoutine } from '../src/routines.ts';
import { startApiServer } from '../src/server/http.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `routine-propose-${randomUUID()}`);
const agents = committedAgents(ROOT);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };

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
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() }, personas: {} }),
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

const REQUEST = 'Ogni lunedì e giovedì alle 9 fammi il resoconto di cosa ho da fare e cosa aspetta me.';
const TITLE = 'Resoconto finto del lunedì e giovedì';
const PROPOSE: Answer = { action: 'call', tool: 'routine.propose', arguments: { title: TITLE, days: [1, 4], at: '09:00', sources: ['todo', 'waiting'] } };

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

async function routineOf(approvalId: string): Promise<string> {
  const [row] = await db().sql<{ id: string }[]>`SELECT detail ->> 'routineId' AS id FROM approvals WHERE id = ${approvalId}`;
  assert.ok(row?.id !== undefined);
  return row.id;
}

async function lastReply(taskId: string): Promise<{ body: string; label: string } | undefined> {
  const [row] = await db().sql<{ body: string; label: string }[]>`
    SELECT body, label FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id DESC LIMIT 1`;
  return row;
}

const offersRoutine = (request: ChatRequest | undefined) => /^- routine\.propose:/m.test(request?.messages[0]?.content ?? '');

test('routine.propose: a routine proposed, off and hidden; «Attiva» in the chat makes it active, and Arianna answers by code', async () => {
  const { task } = await ask('private');
  const model = scripted([PROPOSE]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  assert.ok(offersRoutine(model.requests[0]));
  const approvalId = await waitingApproval(task.id);
  const [approval] = await db().sql<{ kind: string; action: string; label: string; detail: Record<string, unknown> }[]>`
    SELECT kind, action, label::text, detail FROM approvals WHERE id = ${approvalId}`;
  assert.deepEqual([approval?.kind, approval?.action, approval?.label, approval?.detail.title, approval?.detail.at], ['routine', 'routine.propose', 'L2', TITLE, '09:00']);
  assert.deepEqual(approval?.detail.days, [1, 4]);
  assert.deepEqual(approval.detail.sources, ['todo', 'waiting']);
  const id = await routineOf(approvalId);
  const proposed = await loadRoutine(db().sql, id);
  assert.deepEqual([proposed?.status, proposed?.nextRunAt, proposed?.title], ['proposed', null, TITLE]);
  // Its chat is not in the list before «Attiva»; the page shows the proposal first.
  assert.ok(!(await listConversations(db().sql)).some((item) => item.id === proposed?.conversationId));
  assert.equal((await listRoutines(db().sql))[0]?.id, id);
  // The events name ids only, never the title.
  const [event] = await db().sql<{ payload: Record<string, unknown>; label: string }[]>`
    SELECT payload, label::text FROM events WHERE kind = 'routine.proposed' AND payload ->> 'routineId' = ${id}`;
  assert.equal(event?.label, 'L0');
  assert.doesNotMatch(JSON.stringify(event.payload), /Resoconto/);
  // Decided in the web chat only.
  await assert.rejects(recordDecision(db().sql, approvalId, 'approved', 'telegram'));
  await recordDecision(db().sql, approvalId, 'approved', 'web');
  const active = await loadRoutine(db().sql, id);
  assert.equal(active?.status, 'active');
  assert.ok(active.nextRunAt !== null && active.nextRunAt.getTime() > Date.now());
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: active.timezone, weekday: 'short' }).format(active.nextRunAt);
  assert.ok(['Mon', 'Thu'].includes(weekday), weekday);
  assert.ok((await listConversations(db().sql)).some((item) => item.id === active.conversationId));
  const approved = await db().sql`SELECT 1 FROM events WHERE kind = 'routine.approved' AND payload ->> 'routineId' = ${id}`;
  assert.equal(approved.length, 1);
  // The next step answers without the model.
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  assert.match((await lastReply(task.id))?.body ?? '', new RegExp(`^Fatto: la routine «${TITLE}» è attiva, lun e gio alle 09:00\\. Il primo resoconto arriva (lunedì|giovedì) `));
});

test('«Scarta» in the chat: the routine is retired and never shows; nothing runs', async () => {
  const { task } = await ask('private');
  assert.deepEqual(await drain(task.id, scripted([PROPOSE])), ['waiting-approval']);
  const approvalId = await waitingApproval(task.id);
  const id = await routineOf(approvalId);
  await recordDecision(db().sql, approvalId, 'rejected', 'web');
  const gone = await loadRoutine(db().sql, id);
  assert.deepEqual([gone?.status, gone?.nextRunAt], ['retired', null]);
  assert.ok(!(await listRoutines(db().sql)).some((item) => item.id === id));
  assert.ok(!(await listConversations(db().sql)).some((item) => item.id === gone?.conversationId));
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  assert.match((await lastReply(task.id))?.body ?? '', /^Va bene: la routine non parte/);
});

test('from the page: «Attiva» and «Scarta» decide the card of the chat too; a routine already decided is refused', async () => {
  const first = await ask('private');
  await drain(first.task.id, scripted([PROPOSE]));
  const firstApproval = await waitingApproval(first.task.id);
  const id = await routineOf(firstApproval);
  // A proposal is not changed, tried, paused or decided twice.
  await assert.rejects(updateRoutine(db().sql, id, { at: '10:00' }), /approved or discarded first/);
  await assert.rejects(runNow({ sql: db().sql, home: HOME, rules: RULES }, id), /approved first/);
  await assert.rejects(pauseRoutine(db().sql, id), /only an active routine pauses/);
  const routine = await decideRoutine(db().sql, id, 'approved');
  assert.equal(routine.status, 'active');
  const [decided] = await db().sql<{ state: string; via: string }[]>`SELECT state, decided_via AS via FROM approvals WHERE id = ${firstApproval}`;
  assert.deepEqual([decided?.state, decided?.via], ['approved', 'web']);
  assert.deepEqual(await drain(first.task.id, scripted([])), ['answered']);
  assert.match((await lastReply(first.task.id))?.body ?? '', /^Fatto: la routine/);
  await assert.rejects(decideRoutine(db().sql, id, 'rejected'), /only a proposed routine/);

  // «Togli» of a proposal discards it, the card of the chat too.
  const second = await ask('private');
  await drain(second.task.id, scripted([PROPOSE]));
  const secondApproval = await waitingApproval(second.task.id);
  const other = await routineOf(secondApproval);
  await retireRoutine(db().sql, other);
  assert.equal((await loadRoutine(db().sql, other))?.status, 'retired');
  const [rejected] = await db().sql<{ state: string }[]>`SELECT state FROM approvals WHERE id = ${secondApproval}`;
  assert.equal(rejected?.state, 'rejected');
});

test('a proposal whose approval expired is still decided from the page, alone', async () => {
  const { task } = await ask('private');
  await drain(task.id, scripted([PROPOSE]));
  const approvalId = await waitingApproval(task.id);
  const id = await routineOf(approvalId);
  await db().sql`UPDATE approvals SET state = 'expired', decided_at = now() WHERE id = ${approvalId}`;
  assert.equal((await decideRoutine(db().sql, id, 'rejected')).status, 'retired');
});

test('the routes of the page: approve and discard a proposal; 409 for a routine not proposed', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [], routines: createRoutineService({ sql: db().sql, home: HOME, rules: RULES }) });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const { task } = await ask('private');
    await drain(task.id, scripted([PROPOSE]));
    const id = await routineOf(await waitingApproval(task.id));
    const listed = (await (await fetch(`${base}/api/routines`)).json()) as { routines: { id: string; status: string }[] };
    assert.equal(listed.routines.find((item) => item.id === id)?.status, 'proposed');
    assert.equal((await send(`/api/routines/${id}/approve`, { prompt: 'x' })).status, 400);
    const approved = await send(`/api/routines/${id}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as { routine: { status: string } }).routine.status, 'active');
    assert.equal((await send(`/api/routines/${id}/discard`)).status, 409);
    const page = await createRoutine(db().sql, { title: 'Dalla pagina', days: [1], at: '09:00', timezone: 'UTC', sources: ['todo'] });
    assert.equal((await send(`/api/routines/${page.id}/approve`)).status, 409);
  } finally {
    await server.close();
    await live.close();
  }
});

test('fields refused by code: the model reads the error, nothing is written', async () => {
  const { task } = await ask('private', 'Ogni mattina alle 25 scrivimi una poesia.');
  const model = scripted([
    { action: 'call', tool: 'routine.propose', arguments: { title: 'Poesia', days: [1], at: '25:00', sources: ['todo'] } },
    { action: 'call', tool: 'routine.propose', arguments: { title: '   ', days: [1], at: '09:00', sources: ['todo'] } },
    { action: 'reply', text: 'Posso proporti solo un resoconto con le fonti della pagina Routine.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: routine\.propose: at must be a time HH:MM/);
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', /error: routine\.propose: the title is empty/);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${task.id}`).length, 0);
  assert.equal((await db().sql`SELECT 1 FROM routines WHERE title = 'Poesia'`).length, 0);
});

test('a work conversation offers it (the same prompt) but nothing is written there; an incognito one does not offer it', async () => {
  const work = await ask('work');
  const atWork = scripted([PROPOSE, { action: 'reply', text: 'Le routine si chiedono in una conversazione privata.' }]);
  assert.deepEqual(await drain(work.task.id, atWork), ['continued', 'answered']);
  assert.ok(offersRoutine(atWork.requests[0]));
  assert.match(atWork.requests[1]?.messages.at(-1)?.content ?? '', /error: routine\.propose: a routine is proposed only in a private conversation/);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${work.task.id}`).length, 0);
  assert.equal((await db().sql`SELECT 1 FROM events WHERE kind = 'routine.proposed' AND task_id = ${work.task.id}`).length, 0);
  const incognito = await ask('private', REQUEST, { incognito: true });
  const quiet = scripted([{ action: 'reply', text: 'Ok.' }]);
  await drain(incognito.task.id, quiet);
  assert.ok(quiet.requests.length > 0);
  assert.ok(!offersRoutine(quiet.requests[0]));
});

test('the database: a routine approval only with its fields; a proposal is approved or discarded, never back to proposed', async () => {
  const { sql } = db();
  const task = await submitTask(sql, { title: 'Prova', assignee: 'arianna', label: 'L1', clearance: 'L2', effectiveLabel: 'L1' });
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'routine', 'routine.propose', ${sql.json({ title: 'x' })}, 'L2')`);
  await assert.rejects(
    sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'routine', 'routine.propose', ${sql.json({ routineId: randomUUID(), title: 'x' })}, 'L1')`,
  );
  const [conversation] = await sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance) VALUES ('private', 'L2') RETURNING id::text`;
  assert.ok(conversation !== undefined);
  await assert.rejects(sql`
    INSERT INTO routines (title, conversation_id, days, at, timezone, sources, status, approved_at)
    VALUES ('Finta', ${conversation.id}, '{1}', '09:00', 'UTC', '{todo}', 'proposed', now())`);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO routines (title, conversation_id, days, at, timezone, sources, status)
    VALUES ('Finta', ${conversation.id}, '{1}', '09:00', 'UTC', '{todo}', 'proposed') RETURNING id::text`;
  assert.ok(row !== undefined);
  await assert.rejects(sql`UPDATE routines SET at = '10:00' WHERE id = ${row.id}`, /stays as the user saw it/);
  await assert.rejects(sql`UPDATE routines SET status = 'paused', paused_by = 'user' WHERE id = ${row.id}`);
  await sql`UPDATE routines SET status = 'active', next_run_at = now() + interval '1 day', approved_at = now() WHERE id = ${row.id}`;
  await assert.rejects(sql`UPDATE routines SET status = 'proposed', next_run_at = NULL WHERE id = ${row.id}`, /back to proposed/);
});

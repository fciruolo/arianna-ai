// The secretary (I-12, D-144, tappa S1): its conversation, the commitments
// and their confirmation, written by the code; nothing of a commitment
// leaves this machine.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { loadApproval } from '../src/approvals.ts';
import { dayText, localDay, parseDay } from '../src/commitment-dates.ts';
import { CommitmentError, listCommitments, loadCommitment, markDone, openSecretary, requestCommitment } from '../src/commitments.ts';
import { archiveConversation, ChatError, createConversation, listConversations, loadConversation, pinConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { noticeOf } from '../src/notifications.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { startApiServer } from '../src/server/http.ts';
import { loadTask } from '../src/tasks.ts';
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

async function answers(taskId: string): Promise<{ body: string; label: string }[]> {
  return db().sql<{ body: string; label: string }[]>`SELECT body, label FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id`;
}

async function pendingOf(taskId: string) {
  const task = await loadTask(db().sql, taskId);
  assert.equal(task?.status, 'waiting_user');
  assert.ok(task.waitingApprovalId !== null);
  const approval = await loadApproval(db().sql, task.waitingApprovalId);
  assert.ok(approval !== undefined);
  return approval;
}

test('one secretary conversation: private, titled, never listed, archived nor pinned, always the same', async () => {
  const first = await openSecretary(db().sql);
  const again = await openSecretary(db().sql);
  assert.equal(again.id, first.id);
  assert.deepEqual([first.secretary, first.mode, first.clearance, first.title, first.agent, first.incognito], [true, 'private', 'L2', 'Segretaria', null, false]);
  assert.ok(!(await listConversations(db().sql)).some((item) => item.id === first.id));
  await assert.rejects(archiveConversation(db().sql, first.id, true), ChatError);
  await assert.rejects(pinConversation(db().sql, first.id, true), ChatError);
  // The database refuses it as well: a second one, archiving, unmarking.
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, secretary) VALUES ('private', 'L2', true)`, /conversations_one_secretary/);
  await assert.rejects(db().sql`UPDATE conversations SET archived_at = now() WHERE id = ${first.id}`, /conversations_secretary_fields/);
  await assert.rejects(db().sql`UPDATE conversations SET secretary = false WHERE id = ${first.id}`, /never changes/);
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, secretary) VALUES ('work', 'L1', true)`, /conversations_secretary_fields/);
  // An ordinary conversation is not one.
  assert.equal((await createConversation(db().sql, { mode: 'private' })).secretary, false);
});

test('"giovedì alle 15 devo andare in banca": the day computed by the code, saved only after the confirmation', async () => {
  const secretary = await openSecretary(db().sql);
  const { task } = await postUserMessage(db().sql, secretary.id, 'Giovedì alle 15 devo andare in banca per la fideiussione');
  const model = scripted([{ action: 'call', tool: 'commitment.add', arguments: { text: 'Andare in banca per la fideiussione', day: 'giovedì', time: '15' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  // The model was offered the commitments and no delegation.
  const offered = JSON.stringify(model.requests[0]?.schema?.schema);
  assert.match(offered, /commitment\.add/);
  assert.doesNotMatch(offered, /task\.delegate/);

  const expected = parseDay('giovedì', localDay())?.day;
  const approval = await pendingOf(task.id);
  assert.deepEqual([approval.kind, approval.action, approval.label], ['commitment', 'commitment.add', 'L2']);
  assert.deepEqual(approval.detail, { op: 'add', text: 'Andare in banca per la fideiussione', day: expected, time: '15:00', dayText: dayText(expected ?? ''), step: 1 });
  assert.ok(!(await listCommitments(db().sql)).some((item) => item.body === 'Andare in banca per la fideiussione'));

  // The notice of the waiting approval says a kind and a task, never the text.
  const events = await db().sql<{ kind: string; payload: unknown }[]>`SELECT kind, payload FROM events WHERE task_id = ${task.id}`;
  assert.ok(events.every((event) => !JSON.stringify(event.payload).includes('banca')));
  const requested = events.find((event) => event.kind === 'approval.requested');
  assert.deepEqual(noticeOf({ kind: 'approval.requested', taskId: task.id, payload: (requested?.payload ?? {}) as Record<string, never> }), { kind: 'approval', taskId: task.id });

  // Only the web chat decides it: the text is private.
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'telegram'), /approvals_commitment_via_web/);
  await recordDecision(db().sql, approval.id, 'approved', 'web');
  const saved = (await listCommitments(db().sql)).find((item) => item.body === 'Andare in banca per la fideiussione');
  assert.deepEqual([saved?.day, saved?.time, saved?.status, saved?.label, saved?.conversationId], [expected, '15:00', 'open', 'L2', secretary.id]);

  // The answer is written by the code: the model is not called again.
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.equal(model.requests.length, 1);
  const [reply] = await answers(task.id);
  assert.match(reply?.body ?? '', /^Segnato per .*alle 15:00: Andare in banca per la fideiussione\.$/);
  assert.equal(reply?.label, 'L2');
  // The same approval never notes it twice.
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'web'));
});

test('a rejected confirmation saves nothing, and a day the code cannot compute is an error the model reads', async () => {
  const secretary = await openSecretary(db().sql);
  const { task } = await postUserMessage(db().sql, secretary.id, 'Prima o poi devo chiamare il dentista');
  const model = scripted([
    { action: 'call', tool: 'commitment.add', arguments: { text: 'Chiamare il dentista', day: 'prima o poi' } },
    { action: 'call', tool: 'commitment.add', arguments: { text: 'Chiamare il dentista', day: 'domani' } },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'waiting-approval']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /not one the core can compute/);
  const approval = await pendingOf(task.id);
  await recordDecision(db().sql, approval.id, 'rejected', 'web');
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.match((await answers(task.id))[0]?.body ?? '', /non l’ho segnato/);
  assert.ok(!(await listCommitments(db().sql)).some((item) => item.body === 'Chiamare il dentista'));
});

test('"cosa ho domani?": the list is written by the code from SQL, and ends the task', async () => {
  const secretary = await openSecretary(db().sql);
  const tomorrow = parseDay('domani', localDay())?.day ?? '';
  await db().sql`INSERT INTO commitments (body, day, at_time) VALUES ('Ritirare il pacco', ${tomorrow}::date, '10:00'), ('Rilascio della funzionalità X', ${tomorrow}::date, NULL)`;
  const { task } = await postUserMessage(db().sql, secretary.id, 'Cosa ho domani?');
  const model = scripted([{ action: 'call', tool: 'commitment.list', arguments: { day: 'domani' } }]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  const [reply] = await answers(task.id);
  assert.ok(reply !== undefined);
  assert.equal(reply.label, 'L2');
  assert.ok(reply.body.startsWith(`Domani, ${dayText(tomorrow)}:\n`));
  assert.match(reply.body, /- 10:00 · Ritirare il pacco\n- Rilascio della funzionalità X/);
});

test('"il pacco l’ho ritirato": the commitment found by its words, marked done after the confirmation', async () => {
  const secretary = await openSecretary(db().sql);
  const [row] = await db().sql<{ id: string }[]>`INSERT INTO commitments (body, day) VALUES ('Portare la macchina dal meccanico', ${localDay()}::date) RETURNING id::text`;
  const { task } = await postUserMessage(db().sql, secretary.id, 'La macchina l’ho portata dal meccanico');
  const model = scripted([{ action: 'call', tool: 'commitment.done', arguments: { which: 'macchina meccanico' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approval = await pendingOf(task.id);
  assert.deepEqual([approval.action, approval.detail.commitmentId], ['commitment.done', row?.id]);
  assert.equal((await loadCommitment(db().sql, row?.id ?? ''))?.status, 'open');
  await recordDecision(db().sql, approval.id, 'approved', 'web');
  const done = await loadCommitment(db().sql, row?.id ?? '');
  assert.equal(done?.status, 'done');
  assert.ok(done.doneAt !== null);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.equal((await answers(task.id))[0]?.body, 'Segnato come fatto: Portare la macchina dal meccanico.');
});

test('commitment.done with words that match several: the model reads the open ones with their ids', async () => {
  const secretary = await openSecretary(db().sql);
  await db().sql`INSERT INTO commitments (body, day) VALUES ('Telefonare a Giulia per il regalo', ${localDay()}::date), ('Telefonare a Marco per il regalo', ${localDay()}::date)`;
  const { task } = await postUserMessage(db().sql, secretary.id, 'Ho telefonato per il regalo');
  const model = scripted([
    { action: 'call', tool: 'commitment.done', arguments: { which: 'telefonare regalo' } },
    { action: 'call', tool: 'user.ask', arguments: { question: 'A chi hai telefonato, Giulia o Marco?' } },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'answered']);
  const result = model.requests[1]?.messages.at(-1)?.content ?? '';
  assert.match(result, /more than one open commitment matches/);
  assert.match(result, /\[[0-9a-f]{8}\] .* Telefonare a Giulia per il regalo/);
});

test('"Fatto": the button marks an open commitment done once; the label of a commitment never below L2', async () => {
  const [row] = await db().sql<{ id: string }[]>`INSERT INTO commitments (body, day) VALUES ('Comprare il latte', ${localDay()}::date) RETURNING id::text`;
  const done = await markDone(db().sql, row?.id ?? '');
  assert.equal(done.status, 'done');
  await assert.rejects(markDone(db().sql, row?.id ?? ''), (error: unknown) => error instanceof CommitmentError && error.code === 'closed');
  await assert.rejects(markDone(db().sql, '00000000-0000-4000-8000-000000000000'), (error: unknown) => error instanceof CommitmentError && error.code === 'not-found');
  await assert.rejects(db().sql`INSERT INTO commitments (body, day, label) VALUES ('x', ${localDay()}::date, 'L1')`, /commitments_label_check/);
  await assert.rejects(db().sql`UPDATE commitments SET body = 'altro' WHERE id = ${row?.id ?? ''}`, /never change/);
  await assert.rejects(db().sql`DELETE FROM commitments WHERE id = ${row?.id ?? ''}`, /permission denied/);
});

test('outside the secretary’s conversation the commitments are not offered: a private or a work conversation', async () => {
  for (const mode of ['private', 'work'] as const) {
    const conversation = mode === 'work' ? await createConversation(db().sql, { mode, project: 'demo', projects: ['demo'] }) : await createConversation(db().sql, { mode });
    const { task } = await postUserMessage(db().sql, conversation.id, 'Cosa ho domani?');
    // Out of the schema: refused, asked again without the thought, refused again.
    const call: Answer = { action: 'call', tool: 'commitment.list', arguments: { day: 'domani' } };
    const model = scripted([call, call]);
    assert.deepEqual(await drain(task.id, model), ['waiting-user']);
    assert.doesNotMatch(JSON.stringify(model.requests[0]?.schema?.schema), /commitment\./);
    assert.doesNotMatch(model.requests[0]?.messages[0]?.content ?? '', /commitment\./);
    assert.match((await loadTask(db().sql, task.id))?.waitingReason ?? '', /valid answer/);
    assert.equal((await answers(task.id)).length, 0);
  }
});

test('the routes: the button opens the one conversation; the list and "Fatto"', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [] });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const opened = (await (await post('/api/secretary')).json()) as { conversation: { id: string; secretary: boolean } };
    assert.equal(opened.conversation.id, (await openSecretary(db().sql)).id);
    assert.equal(opened.conversation.secretary, true);
    assert.equal((await post('/api/secretary', { other: 1 })).status, 400);

    const [row] = await db().sql<{ id: string }[]>`INSERT INTO commitments (body, day, at_time) VALUES ('Firmare il modulo', ${localDay()}::date, '11:00') RETURNING id::text`;
    const listed = (await (await fetch(`${base}/api/commitments`)).json()) as { today: string; commitments: { id: string; body: string; time: string; status: string }[] };
    assert.equal(listed.today, localDay());
    assert.deepEqual(
      listed.commitments.filter((item) => item.id === row?.id).map(({ body, time, status }) => ({ body, time, status })),
      [{ body: 'Firmare il modulo', time: '11:00', status: 'open' }],
    );
    const done = await post(`/api/commitments/${row?.id ?? ''}/done`);
    assert.equal(done.status, 200);
    assert.equal(((await done.json()) as { commitment: { status: string } }).commitment.status, 'done');
    assert.equal((await post(`/api/commitments/${row?.id ?? ''}/done`)).status, 409);
    assert.equal((await post('/api/commitments/00000000-0000-4000-8000-000000000000/done')).status, 404);
    // Done today, it stays in the list of today with its status.
    const after = (await (await fetch(`${base}/api/commitments`)).json()) as { commitments: { id: string; status: string }[] };
    assert.equal(after.commitments.find((item) => item.id === row?.id)?.status, 'done');
    // The secretary's conversation is read like any other, by id.
    assert.equal((await loadConversation(db().sql, opened.conversation.id))?.secretary, true);
  } finally {
    await server.close();
    await live.close();
  }
});

/** Runs the steps of `taskId` with `executor` until none is left. */
async function drainWith(taskId: string, executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 10; guard += 1) {
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

const LOCAL_SPEC = { agent: 'arianna', executor: 'local', locality: 'local' as const };
const PROPOSAL = { op: 'add' as const, text: 'Innaffiare le piante', day: '2030-01-01', time: null, dayText: 'martedì 1 gennaio 2030' };

test('the engine: a confirmation decided before the task waited for it resumes the task with the decision', async () => {
  const secretary = await openSecretary(db().sql);
  const { task } = await postUserMessage(db().sql, secretary.id, 'Il primo gennaio innaffio le piante');
  const seen: string[] = [];
  const executor: StepExecutor = {
    plan: () => LOCAL_SPEC,
    async run(ctx) {
      if (ctx.approval !== undefined) {
        seen.push(ctx.approval.state);
        return { kind: 'wait-user', reason: 'read the decision' };
      }
      const approvalId = await requestCommitment(db().sql, { taskId: ctx.task.id, step: ctx.step, label: 'L2', proposal: PROPOSAL });
      // The user is quick: decided before the engine records the outcome.
      await recordDecision(db().sql, approvalId, 'approved', 'web');
      return { kind: 'confirm', approvalId };
    },
  };
  assert.deepEqual(await drainWith(task.id, executor), ['continued', 'waiting-user']);
  assert.deepEqual(seen, ['approved']);
  assert.ok((await listCommitments(db().sql)).some((item) => item.body === 'Innaffiare le piante'));
});

test('the engine: a confirmation that is not a pending one of this task is refused', async () => {
  const secretary = await openSecretary(db().sql);
  const other = await postUserMessage(db().sql, secretary.id, 'Un altro task');
  const otherApproval = await requestCommitment(db().sql, { taskId: other.task.id, step: 1, label: 'L2', proposal: PROPOSAL });
  for (const approvalId of ['00000000-0000-4000-8000-000000000000', otherApproval]) {
    const { task } = await postUserMessage(db().sql, secretary.id, 'Prova');
    const executor: StepExecutor = { plan: () => LOCAL_SPEC, run: () => Promise.resolve({ kind: 'confirm', approvalId }) };
    assert.deepEqual(await drainWith(task.id, executor), ['waiting-user']);
    const waiting = await loadTask(db().sql, task.id);
    assert.equal(waiting?.waitingReason, 'the agent asked for an invalid confirmation');
    assert.equal(waiting.waitingApprovalId, null);
  }
});

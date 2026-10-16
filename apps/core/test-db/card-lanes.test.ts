// The cards on workers of their own (D-235): the lanes of the step queue, one
// card at work per project, a drag into "In corso" that starts a card once,
// and "Ferma" of a card.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listTaskActivities } from '../src/activities.ts';
import { createCard, listCards, runCard, startCard, stopCard } from '../src/cardwall.ts';
import { stopTaskByUser } from '../src/chat-stop.ts';
import { createConversation } from '../src/conversations.ts';
import { scheduleTask, STEP_QUEUE, submitTask } from '../src/engine.ts';
import { claimStep, completeJob, failJob } from '../src/jobs.ts';
import { activitiesSaved, postCardActivity } from '../src/reply.ts';
import { createTask, loadTask, moveTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const NAMES = { projects: ['demo', 'altro'], agents: ['coder', 'designer'] };

async function agentCard(title: string, project: string | null, assignee = 'coder'): Promise<string> {
  const card = await createCard(db().sql, { title, assignee, ...(project === null ? {} : { project }) }, NAMES);
  await startCard(db().sql, card.id);
  return card.id;
}

async function clearQueue(): Promise<void> {
  await db().sql`UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE status IN ('queued', 'running')`;
}

function taskOf(job: { payload: { [key: string]: unknown } } | undefined): unknown {
  return job?.payload.taskId;
}

test('the lanes: the chat worker takes the steps of the chat, the card workers those of the cards', async () => {
  const { sql } = db();
  await clearQueue();
  const conversation = await createConversation(sql, { mode: 'private' });
  const chat = await submitTask(sql, { title: 'Una risposta', conversationId: conversation.id });
  const card = await agentCard('Codice della landing', 'demo');

  const forCards = await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards');
  assert.equal(taskOf(forCards), card);
  assert.equal(await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards'), undefined);
  const forChat = await claimStep(sql, STEP_QUEUE, 'chat', 'chat');
  assert.equal(taskOf(forChat), chat.id);
  assert.equal(await claimStep(sql, STEP_QUEUE, 'chat', 'chat'), undefined);
});

test('one card at work per project: the second waits for its turn, another project and the planner do not', async () => {
  const { sql } = db();
  await clearQueue();
  const first = await agentCard('Grafica', 'demo', 'designer');
  const second = await agentCard('Codice', 'demo');
  const elsewhere = await agentCard('Altro lavoro', 'altro');
  const planner = await createTask(sql, { title: 'Piano: landing', assignee: 'arianna', project: 'demo', status: 'ready' });
  await scheduleTask(sql, planner.id);

  const taken = await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards');
  assert.equal(taskOf(taken), first);
  // The second card of demo waits; the other project and the planner go.
  const next = [taskOf(await claimStep(sql, STEP_QUEUE, 'cards-2', 'cards')), taskOf(await claimStep(sql, STEP_QUEUE, 'cards-3', 'cards'))];
  assert.deepEqual(new Set(next), new Set([elsewhere, planner.id]));
  assert.equal(await claimStep(sql, STEP_QUEUE, 'cards-4', 'cards'), undefined);

  // Between two steps the first card is still at work (running, its next step queued): the second still waits.
  await moveTask(sql, first, 'running');
  if (taken !== undefined) await completeJob(sql, taken.id, 'cards-1');
  await scheduleTask(sql, first);
  const wall = await listCards(sql);
  assert.equal(wall.find((card) => card.id === second)?.turn, 1);
  assert.equal(wall.find((card) => card.id === first)?.turn, null);
  assert.equal(wall.find((card) => card.id === second)?.queued, true);
  assert.equal(taskOf(await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards')), first);
  assert.equal(await claimStep(sql, STEP_QUEUE, 'cards-2', 'cards'), undefined);

  // The first is done: the second's turn comes.
  await sql`UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE key = ${`task:${first}`}`;
  await moveTask(sql, first, 'to_verify', { evidence: [{ kind: 'test', ref: 'x' }], cause: 'executor' });
  assert.equal(taskOf(await claimStep(sql, STEP_QUEUE, 'cards-2', 'cards')), second);
});

test('a drag into "In corso": starts a card once; again it does nothing; a failed card is retried', async () => {
  const { sql } = db();
  await clearQueue();
  const card = await createCard(sql, { title: 'Hero della landing', assignee: 'coder', project: 'demo' }, NAMES);
  assert.equal((await runCard(sql, card.id, NAMES.agents)).status, 'ready');
  assert.equal((await runCard(sql, card.id, NAMES.agents)).status, 'ready');
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE key = ${`task:${card.id}`}`;
  assert.equal(count?.n, 1);

  const mine = await createCard(sql, { title: 'Da fare io' }, NAMES);
  await assert.rejects(runCard(sql, mine.id, NAMES.agents), /only the card of an agent/);

  // Failed after a run: back at work as "Riprova".
  const job = await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards');
  assert.equal(taskOf(job), card.id);
  if (job !== undefined) await failJob(sql, job.id, 'cards-1', 'test', null);
  await moveTask(sql, card.id, 'failed', { cause: 'error' });
  assert.equal((await runCard(sql, card.id, NAMES.agents)).status, 'ready');
});

test('"Ferma" of a card: a queued step fails with it; one at work stops through its worker; one never started is left', async () => {
  const { sql } = db();
  await clearQueue();
  const queued = await agentCard('In coda', 'demo');
  assert.deepEqual(await stopCard(sql, queued, { stopTask: () => false }), { stopped: true, left: false });
  assert.equal((await loadTask(sql, queued))?.status, 'failed');
  const [failure] = await sql<{ code: string }[]>`SELECT code FROM task_errors WHERE task_id = ${queued} ORDER BY id DESC LIMIT 1`;
  assert.equal(failure?.code, 'engine.user-stopped');

  const busy = await agentCard('Al lavoro', 'demo');
  const job = await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards');
  assert.equal(taskOf(job), busy);
  await moveTask(sql, busy, 'running');
  let asked = 0;
  // The worker stops the step: its job fails without another attempt and the card fails (engine.ts, haltedForGood).
  const stopTask = (taskId: string): boolean => {
    asked += 1;
    if (job === undefined) return false;
    void sql.begin(async (tx) => {
      await failJob(tx, job.id, 'cards-1', 'user', null);
      await stopTaskByUser(tx, taskId);
    });
    return true;
  };
  assert.deepEqual(await stopCard(sql, busy, { stopTask, pollMs: 20 }), { stopped: true, left: false });
  assert.equal(asked >= 1, true);
  assert.equal((await loadTask(sql, busy))?.status, 'failed');
  // The history says «Fermata da te» also when its worker stopped it.
  const stopped = await sql`SELECT 1 FROM events WHERE task_id = ${busy} AND kind = 'card.changed' AND payload ->> 'stopped' = 'true'`;
  assert.equal(stopped.length, 1);

  const idle = await createCard(sql, { title: 'Mai partita', assignee: 'coder' }, NAMES);
  assert.deepEqual(await stopCard(sql, idle.id, { stopTask: () => false }), { stopped: false, left: false });
  assert.equal((await loadTask(sql, idle.id))?.status, 'inbox');
});

test('two card workers claiming at once start one card of a project; cards without a project never wait (D-235)', async () => {
  const { sql } = db();
  await clearQueue();
  const first = await agentCard('Grafica', 'demo', 'designer');
  const second = await agentCard('Codice', 'demo');
  const taken = await Promise.all([claimStep(sql, STEP_QUEUE, 'cards-1', 'cards'), claimStep(sql, STEP_QUEUE, 'cards-2', 'cards')]);
  assert.deepEqual(
    taken.map(taskOf).filter((id) => id !== undefined),
    [first],
  );
  assert.equal((await listCards(sql)).find((card) => card.id === second)?.turn, null);
  await clearQueue();
  const loose = [await agentCard('Senza progetto 1', null), await agentCard('Senza progetto 2', null)];
  const both = [taskOf(await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards')), taskOf(await claimStep(sql, STEP_QUEUE, 'cards-2', 'cards'))];
  assert.deepEqual(new Set(both), new Set(loose));
});

test('a delegation of the chat at work in the project folder holds the cards of that project (D-235)', async () => {
  const { sql } = db();
  await clearQueue();
  const conversation = await createConversation(sql, { mode: 'work' });
  const chat = await createTask(sql, { title: 'Una risposta', conversationId: conversation.id, label: 'L1', clearance: 'L1' });
  await sql`INSERT INTO task_delegations (task_id, step, agent, brief, label, repo, status) VALUES (${chat.id}, 1, 'coder', 'Il bottone', 'L1', 'demo', 'running')`;
  const card = await agentCard('Codice', 'demo');
  const elsewhere = await agentCard('Altro', 'altro');
  assert.equal(taskOf(await claimStep(sql, STEP_QUEUE, 'cards-1', 'cards')), elsewhere);
  assert.equal(await claimStep(sql, STEP_QUEUE, 'cards-2', 'cards'), undefined);
  await sql`UPDATE task_delegations SET status = 'ok', result = 'fatto', result_label = 'L1', ended_at = now() WHERE task_id = ${chat.id}`;
  assert.equal(taskOf(await claimStep(sql, STEP_QUEUE, 'cards-2', 'cards')), card);
});

test('a drag into "In corso" of a card in Aspetta resumes it; one waiting for a decision or to verify is refused (D-235)', async () => {
  const { sql } = db();
  await clearQueue();
  const card = await agentCard('Hero', 'demo');
  await clearQueue();
  await moveTask(sql, card, 'running');
  await moveTask(sql, card, 'waiting_user', { reason: 'Messa in attesa a mano.' });
  assert.equal((await runCard(sql, card, NAMES.agents)).status, 'ready');
  const [queued] = await sql`SELECT 1 FROM jobs WHERE key = ${`task:${card}`} AND status = 'queued'`;
  assert.ok(queued !== undefined);
  // An agent gone: refused, as "Avvia" refuses it.
  await clearQueue();
  await moveTask(sql, card, 'running');
  await moveTask(sql, card, 'waiting_user', { reason: 'Messa in attesa a mano.' });
  await assert.rejects(runCard(sql, card, ['designer']), /no longer exists/);

  await moveTask(sql, card, 'ready', { cause: 'user' });
  await moveTask(sql, card, 'running');
  await moveTask(sql, card, 'to_verify', { evidence: [{ kind: 'test', ref: 'x' }], cause: 'executor' });
  await assert.rejects(runCard(sql, card, NAMES.agents), /to verify/);

  const asking = await agentCard('Grafica', 'demo', 'designer');
  await clearQueue();
  await moveTask(sql, asking, 'running');
  const [approval] = await sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${asking}, 'executor', 'card.executor', ${sql.json({ options: ['local'], excluded: [] })}, 'L2') RETURNING id::text`;
  await moveTask(sql, asking, 'waiting_user', { reason: 'approval needed: card.executor', cause: 'approval', approvalId: approval?.id ?? '' });
  await assert.rejects(runCard(sql, asking, NAMES.agents), /waits for a decision/);
});

test('"Ferma" of a card left at work with no job: it stops, so it no longer holds its project (D-235)', async () => {
  const { sql } = db();
  await clearQueue();
  const card = await agentCard('Orfana', 'demo');
  await clearQueue();
  await moveTask(sql, card, 'running');
  assert.deepEqual(await stopCard(sql, card, { stopTask: () => false }), { stopped: true, left: false });
  assert.equal((await loadTask(sql, card))?.status, 'failed');
});

test('the steps of a card at work are saved for its detail, within the card’s clearance (D-235)', async () => {
  const { sql } = db();
  const card = await createCard(sql, { title: 'Grafica', assignee: 'designer', project: 'demo' }, NAMES);
  await postCardActivity(sql, { taskId: card.id, step: 1, kind: 'delegate', detail: 'designer' });
  await postCardActivity(sql, { taskId: card.id, step: 1, kind: 'delegate', detail: 'designer' });
  await postCardActivity(sql, { taskId: card.id, step: 2, kind: 'thinking', detail: '' });
  await activitiesSaved();
  const lines = await listTaskActivities(sql, card.id);
  assert.deepEqual(
    lines?.map(({ step, kind, detail, label }) => ({ step, kind, detail, label })),
    [{ step: 1, kind: 'delegate', detail: 'designer', label: 'L2' }],
  );
  // Above the card's clearance: the database refuses it.
  const open = await createTask(sql, { title: 'Pubblica', label: 'L1', clearance: 'L1', effectiveLabel: 'L1', project: 'demo' });
  await assert.rejects(sql`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${open.id}, 1, 'read', 'x', 'L2')`, /clearance of card|permission/);
});

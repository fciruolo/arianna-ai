// Facts Arianna proposes (D-114, tappa D; D-213): written "Solo in casa"
// only once the user confirms them in the web chat. Invented facts only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';
import { sha256Hex } from '@arianna/policy';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, submitTask } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `profile-propose-${randomUUID()}`);
const agents = committedAgents(ROOT);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// Every test starts from an empty profile.
afterEach(async () => {
  await db().sql`SELECT user_fact_delete(id) FROM user_facts`;
});

async function fact(topic: string, text: string, label: 'L1' | 'L2'): Promise<void> {
  await db().sql`INSERT INTO user_facts (topic, text, label) VALUES (${topic}, ${text}, ${label}::privacy_label)`;
}

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

async function ask(mode: 'work' | 'private', body: string) {
  const conversation =
    mode === 'work' ? await createConversation(db().sql, { mode, project: 'demo', projects: ['demo'] }) : await createConversation(db().sql, { mode });
  return postUserMessage(db().sql, conversation.id, body);
}

const PROPOSE: Answer = { action: 'call', tool: 'profile.propose', arguments: { topic: 'città', text: 'Vive a Borgo Torinese' } };

async function profile(): Promise<{ topic: string; text: string; label: string }[]> {
  return [...(await db().sql<{ topic: string; text: string; label: string }[]>`SELECT topic, text, label::text FROM user_facts ORDER BY topic`)];
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

test('profile.propose: nothing is written until the user confirms; confirmed, the fact is "Solo in casa"', async () => {
  const { task } = await ask('work', 'Mi sono trasferito a Borgo Torinese.');
  assert.deepEqual(await drain(task.id, scripted([PROPOSE])), ['waiting-approval']);
  const id = await waitingApproval(task.id);
  const [approval] = await db().sql<{ kind: string; action: string; label: string; detail: Record<string, unknown> }[]>`
    SELECT kind, action, label, detail FROM approvals WHERE id = ${id}`;
  assert.deepEqual(
    [approval?.kind, approval?.action, approval?.label, approval?.detail.topic, approval?.detail.text, approval?.detail.replaces],
    ['fact', 'profile.propose', 'L2', 'città', 'Vive a Borgo Torinese', false],
  );
  assert.deepEqual(await profile(), []);
  // Decided in the web chat only.
  await assert.rejects(recordDecision(db().sql, id, 'approved', 'telegram'));
  await recordDecision(db().sql, id, 'approved', 'web');
  assert.deepEqual(await profile(), [{ topic: 'città', text: 'Vive a Borgo Torinese', label: 'L2' }]);
  // The next step answers without the model, never repeating the text; the reply stays at the conversation's label.
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  const reply = await lastReply(task.id);
  assert.match(reply?.body ?? '', /^Fatto: in «Su di te» ricordo «città», solo in casa/);
  assert.doesNotMatch(reply?.body ?? '', /Borgo/);
  assert.equal(reply?.label, 'L1');
  const events = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE kind = 'user_fact.created' ORDER BY id DESC LIMIT 1`;
  assert.doesNotMatch(JSON.stringify(events[0]?.payload), /Borgo/);
});

test('profile.propose refused: nothing written', async () => {
  const { task } = await ask('private', 'Mi sono trasferito a Borgo Torinese.');
  assert.deepEqual(await drain(task.id, scripted([PROPOSE])), ['waiting-approval']);
  await recordDecision(db().sql, await waitingApproval(task.id), 'rejected', 'web');
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  assert.deepEqual(await profile(), []);
  assert.equal((await lastReply(task.id))?.body, 'Va bene, non lo ricordo.');
});

test('profile.propose over a shareable fact replaces its text and makes it "Solo in casa" again, never shareable', async () => {
  await fact('città', 'Vive a Borgo Finto', 'L1');
  const { task } = await ask('private', 'Ora vivo a Borgo Torinese.');
  assert.deepEqual(await drain(task.id, scripted([PROPOSE])), ['waiting-approval']);
  const id = await waitingApproval(task.id);
  const [approval] = await db().sql<{ detail: Record<string, unknown> }[]>`SELECT detail FROM approvals WHERE id = ${id}`;
  assert.equal(approval?.detail.replaces, true);
  await recordDecision(db().sql, id, 'approved', 'web');
  assert.deepEqual(await profile(), [{ topic: 'città', text: 'Vive a Borgo Torinese', label: 'L2' }]);
});

test('profile.propose: a topic that looks like personal data or the same fact again open nothing; never offered in incognito', async () => {
  await fact('città', 'Vive a Borgo Torinese', 'L2');
  const { task } = await ask('private', 'Ricordati queste cose.');
  const model = scripted([
    { action: 'call', tool: 'profile.propose', arguments: { topic: 'IT60X0542811101000000123456', text: 'il mio conto' } },
    PROPOSE,
    { action: 'reply', text: 'Va bene.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: profile\.propose: topic looks like personal data or a secret/);
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', /already holds 'città' with this text/);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${task.id}`).length, 0);

  const incognito = await createConversation(db().sql, { mode: 'private', incognito: true });
  const posted = await postUserMessage(db().sql, incognito.id, 'Mi sono trasferito.');
  const quiet = scripted([{ action: 'reply', text: 'Ok.' }]);
  await drain(posted.task.id, quiet);
  assert.ok(quiet.requests.length > 0);
  assert.doesNotMatch(quiet.requests[0]?.messages[0]?.content ?? '', /profile\.propose|profile\.share/);
});

test('the database: a fact approval only with its fields; a share binds to a delegation only with its lowering', async () => {
  const task = await submitTask(db().sql, { title: 'Prova', assignee: 'arianna', label: 'L1', clearance: 'L2', effectiveLabel: 'L1' });
  const { sql } = db();
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'fact', 'profile.propose', ${sql.json({ topic: 'x' })}, 'L2')`);
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'fact', 'profile.propose', ${sql.json({ topic: 'x', text: 'y' })}, 'L1')`);
  await assert.rejects(sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'declassify', 'share_fact', ${sql.json({ text: 'y' })}, 'L2')`);
  // A share approved but never lowered cannot be bound to a delegation.
  const [share] = await sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label, state, decided_at, decided_via)
    VALUES (${task.id}, 'declassify', 'share_fact', ${sql.json({ text: 'y', sha256: sha256Hex('y'), from: 'L2', to: 'L1', topic: 'x', agent: 'coder', reason: 'r' })}, 'L2', 'approved', now(), 'web')
    RETURNING id::text`;
  const [delegation] = await sql<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label) VALUES (${task.id}, 1, 'coder', 'b', 'L1') RETURNING id::text`;
  await assert.rejects(sql`INSERT INTO delegation_facts (delegation_id, approval_id) VALUES (${delegation?.id ?? ''}, ${share?.id ?? ''}::uuid)`);
  // Lowered in this transaction, but for another agent or another task: refused too; for its own, taken.
  const [other] = await sql<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label) VALUES (${task.id}, 2, 'reviewer', 'b', 'L1') RETURNING id::text`;
  const elsewhere = await submitTask(sql, { title: 'Altro', assignee: 'arianna', label: 'L1', clearance: 'L2', effectiveLabel: 'L1' });
  const [foreign] = await sql<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label) VALUES (${elsewhere.id}, 1, 'coder', 'b', 'L1') RETURNING id::text`;
  const lowered = (delegationId: string) =>
    sql.begin(async (tx) => {
      await tx`INSERT INTO label_changes (subject, from_label, to_label, approval_id) VALUES (${`content:${sha256Hex('y')}`}, 'L2', 'L1', ${share?.id ?? ''}::uuid)`;
      await tx`INSERT INTO delegation_facts (delegation_id, approval_id) VALUES (${delegationId}, ${share?.id ?? ''}::uuid)`;
    });
  await assert.rejects(lowered(other?.id ?? ''), /not an approved share/);
  await assert.rejects(lowered(foreign?.id ?? ''), /not an approved share/);
  await lowered(delegation?.id ?? '');
});

test('the database: a share of a fact to an agent never makes the fact shareable (only the declassification of the page does)', async () => {
  const { sql } = db();
  await fact('città', 'Vive a Borgo Finto', 'L2');
  const task = await submitTask(sql, { title: 'Prova', assignee: 'arianna', label: 'L1', clearance: 'L2', effectiveLabel: 'L1' });
  const text = 'Vive a Borgo Finto';
  const [share] = await sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label, state, decided_at, decided_via)
    VALUES (${task.id}, 'declassify', 'share_fact', ${sql.json({ text, sha256: sha256Hex(text), from: 'L2', to: 'L1', topic: 'città', agent: 'coder', reason: 'r' })}, 'L2', 'approved', now(), 'web')
    RETURNING id::text`;
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`INSERT INTO label_changes (subject, from_label, to_label, approval_id) VALUES (${`content:${sha256Hex(text)}`}, 'L2', 'L1', ${share?.id ?? ''}::uuid)`;
      await tx`UPDATE user_facts SET label = 'L1' WHERE topic = 'città'`;
    }),
    /lowering to L1 needs an approved declassification/,
  );
  // The same with the declassification of the page: allowed.
  const [page] = await sql<{ id: string }[]>`
    INSERT INTO approvals (kind, action, detail, label, state, decided_at, decided_via)
    VALUES ('declassify', 'declassify', ${sql.json({ text, sha256: sha256Hex(text), from: 'L2', to: 'L1' })}, 'L2', 'approved', now(), 'web')
    RETURNING id::text`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO label_changes (subject, from_label, to_label, approval_id) VALUES (${`content:${sha256Hex(text)}`}, 'L2', 'L1', ${page?.id ?? ''}::uuid)`;
    await tx`UPDATE user_facts SET label = 'L1' WHERE topic = 'città'`;
  });
});

test('profile.propose shown as new does not overwrite a fact the user wrote meanwhile with that topic', async () => {
  const { task } = await ask('private', 'Mi sono trasferito a Borgo Torinese.');
  assert.deepEqual(await drain(task.id, scripted([PROPOSE])), ['waiting-approval']);
  await fact('città', 'Scritto da me', 'L1');
  await recordDecision(db().sql, await waitingApproval(task.id), 'approved', 'web');
  assert.deepEqual(await profile(), [{ topic: 'città', text: 'Scritto da me', label: 'L1' }]);
  assert.deepEqual(await drain(task.id, scripted([])), ['answered']);
  assert.match((await lastReply(task.id))?.body ?? '', /^Non sono riuscita a ricordare «città»/);
});

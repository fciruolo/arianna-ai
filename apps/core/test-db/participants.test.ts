// The agents that join a conversation as colleagues (D-125, migration 0026):
// the first delegation brings the agent in with two lines of the chat and the
// entry text, the second does not; the user takes it out and the next
// delegation brings it back; Arianna reads who is there; the guards, the
// grants and the purge of conversation_participants; the routes of the chat.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadAgent, userCard, userPresets, type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { archiveConversation, createConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { LOCAL_REPORT_SCHEMA_NAME } from '../src/orchestrator/delegate.ts';
import { createDelegation } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { activeParticipants, ENTRY_TEXT, farewellLine, FAREWELLS, removeParticipant } from '../src/participants.ts';
import { startApiServer } from '../src/server/http.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `participants-${randomUUID()}`);
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const loaded = committedAgents(ROOT);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** An agent of the user that only answers, written as the Agents page writes it. */
function translator(): LoadedAgent {
  const dir = join(HOME, 'cards');
  mkdirSync(dir, { recursive: true });
  const permissions = userPresets().find(({ id }) => id === 'answer')?.permissions;
  const files = userCard({ name: 'traduttore', description: 'Agente traduttore di prova', permissions, prompt: 'Traduci in inglese il testo che ricevi.' });
  writeFileSync(join(dir, 'traduttore.yaml'), files.yaml);
  writeFileSync(join(dir, 'traduttore.md'), files.md);
  return { ...loadAgent(dir, 'traduttore'), origin: 'user' };
}

/** Arianna's steps take the next scripted answer, the agent's call the next report; each request is kept. */
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

function orchestrator(model: LocalModel): StepExecutor {
  const agents = new Map<string, LoadedAgent>(loaded);
  agents.set('traduttore', translator());
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: [], models: defaultCloudModels() },
    projects: [{ name: 'site', path: 'repos/site', absolute: join(HOME, 'repos', 'site'), label: 'L1' } satisfies Project],
  });
  return createOrchestrator({ sql: db().sql, agents, kb: createKb({ home: HOME, rules: RULES }), model: () => model, settings, rules: RULES });
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

const DELEGATE: Answer = { action: 'call', tool: 'task.delegate', arguments: { agent: 'traduttore', reason: 'per la traduzione', brief: 'Traduci: buongiorno.' } };
const REPLY: Answer = { action: 'reply', text: 'Ecco fatto.' };

/** One task of `conversationId` that delegates to the translator once; the local model's requests. */
async function delegatingTask(conversationId: string, body: string): Promise<{ taskId: string; model: LocalModel & { requests: ChatRequest[] } }> {
  const { task } = await postUserMessage(db().sql, conversationId, body);
  const model = scripted([DELEGATE, REPLY], [{ report: 'Ciao a tutti! Good morning.' }]);
  assert.deepEqual(await drain(task.id, orchestrator(model)), ['continued', 'continued', 'answered']);
  return { taskId: task.id, model };
}

async function linesOf(taskId: string): Promise<[string, string][]> {
  const rows = await db().sql<{ body: string; label: string }[]>`
    SELECT body, label FROM messages WHERE task_id = ${taskId} AND role = 'system' ORDER BY id`;
  return rows.map((row) => [row.body, row.label]);
}

function agentCall(model: { requests: ChatRequest[] }): ChatRequest {
  const call = model.requests.find((request) => request.schema?.name === LOCAL_REPORT_SCHEMA_NAME);
  assert.ok(call !== undefined);
  return call;
}

/** All Arianna read at the first step of a task: the joined texts of her first request. */
function firstRead(model: { requests: ChatRequest[] }): string {
  return (model.requests[0]?.messages ?? []).map((message) => message.content).join('\n');
}

test('the first delegation brings the agent in with two lines and the entry text; the second does not', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'] });
  const first = await delegatingTask(conversation.id, 'Traduci: buongiorno.');

  const present = await activeParticipants(db().sql, conversation.id);
  assert.deepEqual(present.map((row) => [row.agent, row.addedBy]), [['traduttore', 'arianna']]);
  assert.deepEqual(await linesOf(first.taskId), [
    ['Arianna aggiunge traduttore: per la traduzione', 'L1'],
    ['traduttore è stato aggiunto', 'L1'],
  ]);
  assert.ok(agentCall(first.model).messages[0]?.content.includes(ENTRY_TEXT));
  // Nobody was there when the first task began: Arianna read no list.
  assert.doesNotMatch(firstRead(first.model), /In this conversation:/);
  const events = await db().sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE kind = 'participant.added' AND payload ->> 'conversationId' = ${conversation.id}`;
  assert.equal(events.length, 1);
  const [added] = events;
  assert.ok(added !== undefined);
  assert.deepEqual([added.label, added.payload.agent], ['L1', 'traduttore']);
  // The reason reached the chat through the gateway, towards the web chat.
  const logged = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${first.taskId} AND target_kind = 'channel' AND target = 'web' AND decision = 'allow'`;
  assert.ok(logged.length >= 2);

  const second = await delegatingTask(conversation.id, 'Ora: buonanotte.');
  assert.deepEqual(await linesOf(second.taskId), []);
  assert.equal(agentCall(second.model).messages[0]?.content.includes(ENTRY_TEXT), false);
  assert.match(firstRead(second.model), /In this conversation: traduttore\./);
  assert.equal((await activeParticipants(db().sql, conversation.id)).length, 1);
  // The lines are for the user only: Arianna never read them as chat.
  assert.doesNotMatch(firstRead(second.model), /Arianna aggiunge|è stato aggiunto/);
});

test('taken out by the user, the agent comes back with the next delegation, with the same lines', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'] });
  const first = await delegatingTask(conversation.id, 'Traduci: ciao.');
  await removeParticipant(db().sql, conversation.id, 'traduttore', 'L1');
  assert.deepEqual(await activeParticipants(db().sql, conversation.id), []);
  assert.deepEqual((await linesOf(first.taskId)).at(-1), ['Hai tolto traduttore', 'L1']);
  const [removed] = await db().sql<{ label: string }[]>`
    SELECT label FROM events WHERE kind = 'participant.removed' AND payload ->> 'conversationId' = ${conversation.id}`;
  assert.equal(removed?.label, 'L1');
  // Not there any more: taking it out again is refused, as for an agent never there.
  await assert.rejects(removeParticipant(db().sql, conversation.id, 'traduttore', 'L1'), /not in this conversation/);
  await assert.rejects(removeParticipant(db().sql, conversation.id, 'coder', 'L0'), /not in this conversation/);

  const again = await delegatingTask(conversation.id, 'Traduci: arrivederci.');
  assert.deepEqual(await linesOf(again.taskId), [
    ['Arianna aggiunge traduttore: per la traduzione', 'L1'],
    ['traduttore è stato aggiunto', 'L1'],
  ]);
  assert.ok(agentCall(again.model).messages[0]?.content.includes(ENTRY_TEXT));
  // Out when the task began: Arianna did not read it among those present.
  assert.doesNotMatch(firstRead(again.model), /In this conversation:/);
  const [rows] = await db().owner<{ all: number; active: number }[]>`
    SELECT count(*)::int AS all, count(*) FILTER (WHERE removed_at IS NULL)::int AS active
    FROM conversation_participants WHERE conversation_id = ${conversation.id}`;
  assert.deepEqual(rows, { all: 2, active: 1 });
});

test('a private conversation: the reason line carries what the step read (L2), the name line the name (L1)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Traduci: ciao.');
  const model = scripted([DELEGATE, REPLY], [{ report: 'Ciao! Hi.' }]);
  const executor = orchestrator(model);
  assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
  // The agent is in from the call; the brief still waits for the user's declassification.
  assert.deepEqual(await linesOf(task.id), [
    ['Arianna aggiunge traduttore: per la traduzione', 'L2'],
    ['traduttore è stato aggiunto', 'L1'],
  ]);
  const waiting = await loadTask(db().sql, task.id);
  assert.ok(waiting?.waitingApprovalId !== null && waiting?.waitingApprovalId !== undefined);
  await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
  assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  assert.ok(agentCall(model).messages[0]?.content.includes(ENTRY_TEXT));
});

test('a delegation that never ran leaves the greeting to the next one that does', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const refused = await postUserMessage(db().sql, conversation.id, 'Traduci: ciao.');
  const first = scripted([DELEGATE, REPLY], []);
  assert.deepEqual(await drain(refused.task.id, orchestrator(first)), ['waiting-approval']);
  const waiting = await loadTask(db().sql, refused.task.id);
  assert.ok(waiting?.waitingApprovalId !== null && waiting?.waitingApprovalId !== undefined);
  await recordDecision(db().sql, waiting.waitingApprovalId, 'rejected', 'web');
  assert.deepEqual(await drain(refused.task.id, orchestrator(first)), ['answered']);
  assert.equal(first.requests.filter((request) => request.schema?.name === LOCAL_REPORT_SCHEMA_NAME).length, 0);

  // Already in (the lines were written with the call), so no new lines; but its first real work greets.
  const { task } = await postUserMessage(db().sql, conversation.id, 'Traduci: buonasera.');
  const second = scripted([DELEGATE, REPLY], [{ report: 'Eccomi! Good evening.' }]);
  const executor = orchestrator(second);
  assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
  assert.deepEqual(await linesOf(task.id), []);
  const again = await loadTask(db().sql, task.id);
  assert.ok(again?.waitingApprovalId !== null && again?.waitingApprovalId !== undefined);
  await recordDecision(db().sql, again.waitingApprovalId, 'approved', 'web');
  assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  assert.ok(agentCall(second).messages[0]?.content.includes(ENTRY_TEXT));
});

test('the guard of conversation_participants: only removed_at changes, once; never deleted; the grants', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'work', project: 'site', projects: ['site'] });
  const { task } = await postUserMessage(sql, conversation.id, 'Vincolo.');
  const delegation = await sql.begin((tx) => createDelegation(tx, { taskId: task.id, step: 1, agent: 'coder', brief: 'x', label: 'L1' }));
  const insert = (agent: string, delegationId: string | null, by = 'arianna') => sql<{ id: string }[]>`
    INSERT INTO conversation_participants (conversation_id, agent, added_by, task_id, delegation_id)
    VALUES (${conversation.id}, ${agent}, ${by}, ${task.id}, ${delegationId}::bigint) RETURNING id::text`;

  // A delegation to another agent, or none for Arianna's own addition: refused.
  await assert.rejects(insert('revisore', delegation.id), /is not a delegation/);
  await assert.rejects(insert('coder', null), /conversation_participants_by_arianna/);
  // Arianna is always there: never a participant.
  await assert.rejects(insert('arianna', null, 'user'), /check constraint/);
  const [row] = await insert('coder', delegation.id);
  assert.ok(row !== undefined);
  // One active row per agent and conversation.
  await assert.rejects(insert('coder', delegation.id), /duplicate key/);
  await assert.rejects(sql`
    INSERT INTO conversation_participants (conversation_id, agent, added_by, removed_at) VALUES (${conversation.id}, 'revisore', 'user', now())`, /joins active/);

  await assert.rejects(sql`UPDATE conversation_participants SET agent = 'revisore' WHERE id = ${row.id}`, /only removed_at can change/);
  await sql`UPDATE conversation_participants SET removed_at = now() WHERE id = ${row.id}`;
  await assert.rejects(sql`UPDATE conversation_participants SET removed_at = now() WHERE id = ${row.id}`, /only be taken out once/);
  await assert.rejects(sql`DELETE FROM conversation_participants WHERE id = ${row.id}`, /permission denied/);
  await assert.rejects(owner`DELETE FROM conversation_participants WHERE id = ${row.id}`, /never deleted/);
  await assert.rejects(owner`TRUNCATE conversation_participants`, /not allowed/);

  const [grants] = await owner<{ select: boolean; insert: boolean; update: boolean; delete: boolean }[]>`
    SELECT has_table_privilege('arianna_app', 'conversation_participants', 'SELECT') AS select,
           has_table_privilege('arianna_app', 'conversation_participants', 'INSERT') AS insert,
           has_table_privilege('arianna_app', 'conversation_participants', 'UPDATE') AS update,
           has_table_privilege('arianna_app', 'conversation_participants', 'DELETE') AS delete`;
  assert.deepEqual(grants, { select: true, insert: true, update: true, delete: false });
});

test('the purge deletes the participants; a deleted conversation takes none', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Da eliminare.');
  const delegation = await sql.begin((tx) => createDelegation(tx, { taskId: task.id, step: 1, agent: 'coder', brief: 'x', label: 'L2' }));
  await sql`
    INSERT INTO conversation_participants (conversation_id, agent, added_by, task_id, delegation_id)
    VALUES (${conversation.id}, 'coder', 'arianna', ${task.id}, ${delegation.id}::bigint)`;
  await owner`UPDATE tasks SET status = 'done', evidence = '[{"kind":"message","ref":"1"}]' WHERE id = ${task.id}`;
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  await archiveConversation(sql, conversation.id, true);
  await purgeConversation(sql, conversation.id);
  assert.equal((await owner`SELECT 1 FROM conversation_participants WHERE conversation_id = ${conversation.id}`).length, 0);
  await assert.rejects(
    owner`INSERT INTO conversation_participants (conversation_id, agent, added_by) VALUES (${conversation.id}, 'coder', 'user')`,
    /was deleted/,
  );
  await assert.rejects(removeParticipant(sql, conversation.id, 'coder', 'L0'), /conversation not found/);
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function call(port: number, method: 'GET' | 'POST', path: string): Promise<Reply> {
  const origin = `http://127.0.0.1:${String(port)}`;
  const payload = method === 'POST' ? '{}' : undefined;
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      {
        method,
        agent: false,
        headers: payload === undefined ? {} : { origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

test('the routes of the chat: the participants with where they run, and the user takes one out', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'] });
  const first = await delegatingTask(conversation.id, 'Traduci: buongiorno.');
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    participantAgent: (agent) => (agent === 'traduttore' ? { executor: 'local', nameLabel: 'L1' } : undefined),
  });
  try {
    const listed = await call(server.port, 'GET', `/api/conversations/${conversation.id}/participants`);
    assert.equal(listed.status, 200);
    const participants = listed.body.participants as { agent: string; addedBy: string; executor: string | null }[];
    assert.deepEqual(participants.map((row) => [row.agent, row.addedBy, row.executor]), [['traduttore', 'arianna', 'local']]);

    assert.equal((await call(server.port, 'POST', `/api/conversations/${conversation.id}/participants/coder/remove`)).status, 404);
    assert.equal((await call(server.port, 'POST', `/api/conversations/${conversation.id}/participants/Not%20an%20id/remove`)).status, 404);
    assert.equal((await call(server.port, 'GET', `/api/conversations/${randomUUID()}/participants`)).status, 404);
    const removed = await call(server.port, 'POST', `/api/conversations/${conversation.id}/participants/traduttore/remove`);
    assert.deepEqual([removed.status, removed.body.removed], [200, 'traduttore']);
    assert.deepEqual((await call(server.port, 'GET', `/api/conversations/${conversation.id}/participants`)).body.participants, []);
    assert.deepEqual((await linesOf(first.taskId)).at(-1), ['Hai tolto traduttore', 'L1']);
  } finally {
    await server.close();
    await live.close();
  }
});

test('I-8 (D-130): after N messages of the user with no delegation an agent says goodbye and leaves; the Coder stays', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work', project: 'site', projects: ['site'] });
  for (const agent of ['revisore', 'traduttore', 'coder']) {
    await sql`INSERT INTO conversation_participants (conversation_id, agent, added_by) VALUES (${conversation.id}, ${agent}, 'user')`;
  }
  const leave = { after: 3, nameLabel: () => 'L1' as const, random: () => 0 };
  const post = (body: string, rule = leave) => postUserMessage(sql, conversation.id, body, { leave: rule });
  await post('Uno.');
  const second = await post('Due.');
  // A delegation to the translator: its count starts again from here. Ended, so that it does not hold it here.
  const delegation = await sql.begin((tx) => createDelegation(tx, { taskId: second.task.id, step: 1, agent: 'traduttore', brief: 'x', label: 'L1' }));
  await sql`UPDATE task_delegations SET status = 'refused', result = 'x', result_label = 'L1', ended_at = now() WHERE id = ${delegation.id}::bigint`;
  // Never with the rule off.
  await post('Tre, senza regola.', { ...leave, after: 0 });
  assert.deepEqual((await activeParticipants(sql, conversation.id)).map((row) => row.agent).sort(), ['coder', 'revisore', 'traduttore']);

  const fourth = await post('Quattro.');
  assert.deepEqual((await activeParticipants(sql, conversation.id)).map((row) => row.agent).sort(), ['coder', 'traduttore']);
  assert.deepEqual(await linesOf(fourth.task.id), [[`revisore: ${FAREWELLS[0] ?? ''}`, 'L1']]);
  const [event] = await sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE kind = 'participant.removed' AND payload ->> 'conversationId' = ${conversation.id} ORDER BY id`;
  assert.deepEqual([event?.label, event?.payload.agent, event?.payload.reason], ['L1', 'revisore', 'idle']);

  // The translator's count started at its delegation: two more messages and it leaves too.
  await post('Cinque.');
  assert.deepEqual((await activeParticipants(sql, conversation.id)).map((row) => row.agent).sort(), ['coder']);
  // The Coder never leaves by itself.
  for (const body of ['Sei.', 'Sette.', 'Otto.']) await post(body);
  assert.deepEqual((await activeParticipants(sql, conversation.id)).map((row) => row.agent), ['coder']);
});

test('the goodbyes: twenty fixed sentences, one at random, after the name', () => {
  assert.equal(FAREWELLS.length, 20);
  assert.equal(new Set(FAREWELLS).size, 20);
  assert.equal(farewellLine('coder', () => 0), `Coder: ${FAREWELLS[0] ?? ''}`);
  assert.equal(farewellLine('revisore', () => 0.9999), `revisore: ${FAREWELLS[19] ?? ''}`);
  for (const phrase of FAREWELLS) assert.ok(phrase.length > 5 && phrase.length < 80, phrase);
});

test('I-8: an agent with a delegation still waiting or at work here never leaves', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work', project: 'site', projects: ['site'] });
  await sql`INSERT INTO conversation_participants (conversation_id, agent, added_by) VALUES (${conversation.id}, 'revisore', 'user')`;
  const leave = { after: 1, nameLabel: () => 'L1' as const };
  const first = await postUserMessage(sql, conversation.id, 'Uno.');
  await sql.begin((tx) => createDelegation(tx, { taskId: first.task.id, step: 1, agent: 'revisore', brief: 'x', label: 'L1' }));
  await postUserMessage(sql, conversation.id, 'Due.', { leave });
  assert.deepEqual((await activeParticipants(sql, conversation.id)).map((row) => row.agent), ['revisore']);
});

test('I-8 through the route of the chat: the rule of the core makes an idle agent leave; without it nobody leaves', async () => {
  const { sql } = db();
  const live = await startLiveFeed(sql);
  for (const rule of [undefined, { after: 1, nameLabel: () => 'L1' as const }]) {
    const conversation = await createConversation(sql, { mode: 'work', project: 'site', projects: ['site'] });
    await sql`INSERT INTO conversation_participants (conversation_id, agent, added_by) VALUES (${conversation.id}, 'revisore', 'user')`;
    const server = await startApiServer({ sql, live, host: '127.0.0.1', port: 0, ...(rule === undefined ? {} : { leaveRule: () => rule }) });
    try {
      const sent = await fetch(`http://127.0.0.1:${String(server.port)}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Ciao.' }),
      });
      assert.equal(sent.status, 201);
      const left = (await activeParticipants(sql, conversation.id)).length === 0;
      assert.equal(left, rule !== undefined);
    } finally {
      await server.close();
    }
  }
  await live.close();
});

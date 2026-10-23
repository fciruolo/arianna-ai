// «@name» and «/giro» (D-107, tappa B2, D-219): a message the user addresses
// to the agents. The core writes each delegation as Arianna's model would,
// with every rule of a delegation, and the task answers with the reports;
// Arianna's model is never called. The caps of one message hold for Arianna too.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadAgent, userCard, userPresets, type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { ChatError, createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { LOCAL_REPORT_SCHEMA_NAME } from '../src/orchestrator/delegate.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { chatBrief } from '../src/delegation-view.ts';
import { openSecretary } from '../src/commitments.ts';
import { listQueue, postOrQueue } from '../src/message-queue.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { BRIEF_MARK, CHAT_WINDOW_MARK, windowLine } from '../src/orchestrator/chat-window.ts';
import { configWithLocalModel } from './support/config.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `addressed-${randomUUID()}`);
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = configWithLocalModel();
const loaded = committedAgents(ROOT);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function userAgent(name: string, prompt: string): LoadedAgent {
  const dir = join(HOME, 'cards');
  mkdirSync(dir, { recursive: true });
  const permissions = userPresets().find(({ id }) => id === 'answer')?.permissions;
  const files = userCard({ name, description: `Agente ${name} di prova`, permissions, prompt });
  writeFileSync(join(dir, `${name}.yaml`), files.yaml);
  writeFileSync(join(dir, `${name}.md`), files.md);
  return { ...loadAgent(dir, name), origin: 'user' };
}

const translator = userAgent('traduttore', 'Traduci in inglese il testo che ricevi.');
const critic = userAgent('critico', 'Dai un parere breve.');
const third = userAgent('terzo', 'Rispondi.');
const fourth = userAgent('quarto', 'Rispondi.');
const MENTIONABLE = ['critico', 'quarto', 'terzo', 'traduttore'];

/** Arianna's steps take the next scripted answer, an agent's call the next report; each request is kept. */
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
  for (const agent of [translator, critic, third, fourth]) agents.set(agent.card.name, agent);
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: [], models: defaultCloudModels() },
    projects: [{ name: 'site', path: 'repos/site', absolute: join(HOME, 'repos', 'site'), label: 'L1' } satisfies Project],
    personas: {},
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

async function work(): Promise<string> {
  return (await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'] })).id;
}

async function reports(taskId: string): Promise<[string | null, string][]> {
  const rows = await db().sql<{ agent: string | null; body: string }[]>`
    SELECT agent, body FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id`;
  return rows.map((row) => [row.agent, row.body]);
}

test('«@traduttore …» goes to that agent with the text after its name; the task answers with its report, Arianna\'s model never called', async () => {
  const id = await work();
  const { task } = await postUserMessage(db().sql, id, '@traduttore buongiorno a tutti', { mentionable: MENTIONABLE });
  const [row] = await db().sql<{ addressed: string; agents: string[] }[]>`SELECT addressed, addressed_agents AS agents FROM tasks WHERE id = ${task.id}`;
  assert.deepEqual([row?.addressed, [...(row?.agents ?? [])]], ['mention', ['traduttore']]);
  const model = scripted([], [{ report: 'Good morning everyone.' }]);
  assert.deepEqual(await drain(task.id, orchestrator(model)), ['continued', 'continued', 'answered']);
  // Only the agent's call reached the model, with the brief alone as the user's part.
  assert.equal(model.requests.length, 1);
  const [call] = model.requests;
  assert.ok(call !== undefined);
  assert.equal(call.schema?.name, LOCAL_REPORT_SCHEMA_NAME);
  // In a work conversation it reads the chat up to the message too (D-220), then the text after its name.
  assert.deepEqual(call.messages.slice(1), [{ role: 'user', content: `${CHAT_WINDOW_MARK}\n${windowLine('Utente', '@traduttore buongiorno a tutti')}\n\n${BRIEF_MARK}\nbuongiorno a tutti` }]);
  assert.deepEqual(await reports(task.id), [['traduttore', 'Good morning everyone.']]);
  assert.equal((await loadTask(db().sql, task.id))?.status, 'done');
  // It joined the chat called by the user, not by Arianna.
  const lines = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE conversation_id = ${id} AND role = 'system' ORDER BY id`;
  assert.deepEqual(lines.map((line) => line.body), ['Hai chiamato traduttore', 'traduttore è stato aggiunto']);
  const [joined] = await db().sql<{ by: string }[]>`SELECT added_by AS by FROM conversation_participants WHERE conversation_id = ${id} AND agent = 'traduttore'`;
  assert.equal(joined?.by, 'user');
  // «Ha visto solo il brief»: the text of the request, for the page of this conversation only.
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual(await chatBrief(db().sql, id, delegation?.id ?? ''), { agent: 'traduttore', brief: 'buongiorno a tutti', label: 'L1' });
  const other = await work();
  assert.equal(await chatBrief(db().sql, other, delegation?.id ?? ''), undefined);
  // The text the chat showed was logged by the gateway towards the web chat.
  const [logged] = await db().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_log WHERE task_id = ${task.id} AND target_kind = 'channel' AND target = 'web'`;
  assert.ok((logged?.n ?? 0) > 0);
});

test('«@Traduttore, …» with a capital letter goes to that agent too, never to Arianna to choose another', async () => {
  const id = await work();
  const { task } = await postUserMessage(db().sql, id, '@Traduttore, buongiorno a tutti', { mentionable: MENTIONABLE });
  const [row] = await db().sql<{ addressed: string; agents: string[] }[]>`SELECT addressed, addressed_agents AS agents FROM tasks WHERE id = ${task.id}`;
  assert.deepEqual([row?.addressed, [...(row?.agents ?? [])]], ['mention', ['traduttore']]);
  await db().owner`UPDATE tasks SET status = 'done', assignee = 'user' WHERE id = ${task.id}`;
  await db().owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
});

test('an «@» that names nobody Arianna may call, or without the list, is a message for Arianna', async () => {
  const id = await work();
  for (const [body, options] of [
    ['@ciao come va?', { mentionable: MENTIONABLE }],
    ['@traduttore buongiorno', {}],
  ] as const) {
    const { task } = await postUserMessage(db().sql, id, body, options);
    const [row] = await db().sql<{ addressed: string | null }[]>`SELECT addressed FROM tasks WHERE id = ${task.id}`;
    assert.equal(row?.addressed, null, body);
    await db().owner`UPDATE tasks SET status = 'done', assignee = 'user' WHERE id = ${task.id}`;
    await db().owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  }
});

test('«@name» without a text and «/giro» with nobody in the conversation are refused, never sent', async () => {
  const id = await work();
  await assert.rejects(postUserMessage(db().sql, id, '@traduttore', { mentionable: MENTIONABLE }), (error) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(postUserMessage(db().sql, id, '/giro', { mentionable: MENTIONABLE }), (error) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(postUserMessage(db().sql, id, '/giro opinioni?', { mentionable: MENTIONABLE }), (error) => error instanceof ChatError && error.code === 'invalid');
  const [count] = await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${id}`;
  assert.equal(count?.n, 0);
});

test('«/giro …» asks every agent of the conversation once, in the order they joined, then answers with the last report', async () => {
  const id = await work();
  // Both already in the conversation: the critic first.
  await db().owner`INSERT INTO conversation_participants (conversation_id, agent, added_by, added_at) VALUES
    (${id}, 'critico', 'user', now() - interval '2 minutes'), (${id}, 'traduttore', 'user', now() - interval '1 minute')`;
  const { task } = await postUserMessage(db().sql, id, '/giro cosa ne pensate del titolo «Arianna»?', { mentionable: MENTIONABLE });
  const model = scripted([], [{ report: 'Mi piace.' }, { report: 'Nice title.' }]);
  assert.deepEqual(await drain(task.id, orchestrator(model)), ['continued', 'continued', 'continued', 'continued', 'answered']);
  assert.deepEqual(await reports(task.id), [
    ['critico', 'Mi piace.'],
    ['traduttore', 'Nice title.'],
  ]);
  assert.ok(model.requests.every((request) => request.schema?.name === LOCAL_REPORT_SCHEMA_NAME));
  // Each reads the chat up to the message (D-220), never the reports of the same round: the second one does not see the first.
  const heard = model.requests.map((request) => request.messages.at(-1)?.content ?? '');
  assert.equal(heard.length, 2);
  for (const content of heard) {
    assert.ok(content.includes(windowLine('Utente', '/giro cosa ne pensate del titolo «Arianna»?')));
    assert.doesNotMatch(content, /Mi piace/);
  }
  const [line] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'system' ORDER BY id LIMIT 1`;
  assert.equal(line?.body, 'Giro con critico e traduttore, uno alla volta.');
  assert.deepEqual(
    (await loadDelegations(db().sql, task.id)).map((delegation) => [delegation.agent, delegation.brief]),
    [
      ['critico', 'cosa ne pensate del titolo «Arianna»?'],
      ['traduttore', 'cosa ne pensate del titolo «Arianna»?'],
    ],
  );
});

test('in a private conversation the brief of «@name» leaves only as the text the user approves, as Arianna\'s', async () => {
  const id = (await createConversation(db().sql, { mode: 'private' })).id;
  const { task } = await postUserMessage(db().sql, id, '@traduttore ciao a tutti', { mentionable: MENTIONABLE });
  const model = scripted([], [{ report: 'Hi everyone.' }]);
  const executor = orchestrator(model);
  assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
  const approval = (await loadTask(db().sql, task.id))?.waitingApprovalId ?? '';
  const [asked] = await db().sql<{ kind: string; detail: { to: string } }[]>`SELECT kind, detail FROM approvals WHERE id = ${approval}`;
  assert.deepEqual([asked?.kind, asked?.detail.to], ['declassify', 'L1']);
  assert.equal(model.requests.length, 0);
  await recordDecision(db().sql, approval, 'approved', 'web');
  assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  assert.deepEqual(await reports(task.id), [['traduttore', 'Hi everyone.']]);
});

test('Arianna cannot have the same agent work more than twice for one message: the third call is an error she reads', async () => {
  const id = await work();
  const { task } = await postUserMessage(db().sql, id, 'Traduci tre frasi, una alla volta.');
  const delegate = (brief: string): Answer => ({ action: 'call', tool: 'task.delegate', arguments: { agent: 'traduttore', reason: 'traduzione', brief } });
  const model = scripted([delegate('Uno.'), delegate('Due.'), delegate('Tre.'), { action: 'reply', text: 'Ne ho tradotte due.' }], [{ report: 'One.' }, { report: 'Two.' }]);
  assert.deepEqual(await drain(task.id, orchestrator(model)), ['continued', 'continued', 'continued', 'continued', 'continued', 'answered']);
  assert.equal((await loadDelegations(db().sql, task.id)).length, 2);
  const [third] = await db().sql<{ result: string }[]>`SELECT result FROM task_turns WHERE task_id = ${task.id} AND step = 5`;
  assert.match(third?.result ?? '', /traduttore already worked 2 times for this message/);
});

test('Arianna cannot have more than 6 agents work for one message: the seventh call is an error she reads', async () => {
  const id = await work();
  const { task } = await postUserMessage(db().sql, id, 'Fai lavorare tutti.');
  const delegate = (agent: string): Answer => ({ action: 'call', tool: 'task.delegate', arguments: { agent, reason: 'parere', brief: 'Un parere.' } });
  const calls = ['traduttore', 'traduttore', 'critico', 'critico', 'terzo', 'terzo', 'quarto'].map(delegate);
  const model = scripted([...calls, { action: 'reply', text: 'Fatto.' }], Array.from({ length: 6 }, (_, index) => ({ report: `Parere ${String(index + 1)}.` })));
  const results = await drain(task.id, orchestrator(model));
  assert.equal(results.at(-1), 'answered');
  assert.equal((await loadDelegations(db().sql, task.id)).length, 6);
  const [seventh] = await db().sql<{ result: string }[]>`SELECT result FROM task_turns WHERE task_id = ${task.id} AND answer -> 'arguments' ->> 'agent' = 'quarto'`;
  assert.match(seventh?.result ?? '', /6 agents already worked for this message/);
});

test('in the conversation of the secretary «@» and «/giro» are ordinary messages', async () => {
  const secretary = await openSecretary(db().sql);
  const { task } = await postUserMessage(db().sql, secretary.id, '@traduttore buongiorno', { mentionable: MENTIONABLE });
  const [row] = await db().sql<{ addressed: string | null }[]>`SELECT addressed FROM tasks WHERE id = ${task.id}`;
  assert.equal(row?.addressed, null);
  await db().owner`UPDATE tasks SET status = 'done', assignee = 'user' WHERE id = ${task.id}`;
  await db().owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
});

test('a queued «@name» without a text, or «/giro» with nobody here, is refused when it enters the queue (D-218)', async () => {
  const id = await work();
  await postOrQueue(db().sql, id, 'Prima domanda');
  await assert.rejects(postOrQueue(db().sql, id, '@traduttore', { mentionable: MENTIONABLE }), (error) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(postOrQueue(db().sql, id, '/giro opinioni?', { mentionable: MENTIONABLE }), (error) => error instanceof ChatError && error.code === 'invalid');
  const queued = await postOrQueue(db().sql, id, '@traduttore poi traduci questo', { mentionable: MENTIONABLE });
  assert.ok('queued' in queued);
  assert.equal((await listQueue(db().sql, id)).messages.length, 1);
});

test('an agent called by the message never says goodbye with it, even when idle long enough', async () => {
  const id = await work();
  await db().owner`INSERT INTO conversation_participants (conversation_id, agent, added_by, added_at) VALUES (${id}, 'traduttore', 'user', now() - interval '1 hour')`;
  const leave = { after: 1, nameLabel: () => 'L0' as const };
  // A message of the user since it came in: idle for the rule.
  await db().owner`INSERT INTO messages (conversation_id, role, label, body) VALUES (${id}, 'user', 'L1', 'prima')`;
  const { task } = await postUserMessage(db().sql, id, '@traduttore buongiorno', { mentionable: MENTIONABLE, leave });
  const [still] = await db().sql<{ removed: boolean }[]>`
    SELECT removed_at IS NOT NULL AS removed FROM conversation_participants WHERE conversation_id = ${id} AND agent = 'traduttore'`;
  assert.equal(still?.removed, false);
  await db().owner`UPDATE tasks SET status = 'done', assignee = 'user' WHERE id = ${task.id}`;
  await db().owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
});

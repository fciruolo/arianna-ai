// The profile «Su di te» in the prompt of the local steps (D-114, tappa B):
// a labeled piece at the end of the system prompt, within the clearance of
// the step, counting in its label; profile.read when only the topics fit.
// Invented facts only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, submitTask } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTurns } from '../src/orchestrator/turns.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `profile-prompt-${randomUUID()}`);
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

const HEADER = 'Facts the user wrote about themselves';
const CITY = 'Vive a Borgo Finto';
const JOB = 'Sviluppatore web freelance';

async function fact(topic: string, text: string, label: 'L1' | 'L2'): Promise<void> {
  await db().sql`INSERT INTO user_facts (topic, text, label) VALUES (${topic}, ${text}, ${label}::privacy_label)`;
}

async function twoFacts(): Promise<void> {
  await fact('città', CITY, 'L2');
  await fact('lavoro', JOB, 'L1');
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

// The clock of the line of now at the end of each request (D-311): fixed, so that the last message is known to the letter.
const NOW_LINE = 'Adesso: venerdì 23 ottobre 2026, 10:12 (Europe/Rome).';
const CLOCK = { now: () => new Date('2026-10-23T08:12:30Z'), timeZone: 'Europe/Rome' };
const orchestrator = (model: LocalModel) =>
  createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() }, personas: {} }),
    rules: RULES,
    ...CLOCK,
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

const systemOf = (request: ChatRequest | undefined): string => request?.messages[0]?.content ?? '';
const everything = (model: { requests: ChatRequest[] }): string => model.requests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');

async function replyLabel(taskId: string): Promise<string | undefined> {
  const [row] = await db().sql<{ label: string }[]>`SELECT label FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id LIMIT 1`;
  return row?.label;
}

const REPLY: Answer = { action: 'reply', text: 'Va bene.' };

test('a private conversation: topics and texts of every fact, before the thought rule; the reply is L2', async () => {
  await twoFacts();
  const { task } = await ask('private', 'Ciao!');
  const model = scripted([REPLY]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  const system = systemOf(model.requests[0]);
  const block = system.indexOf(HEADER);
  assert.ok(block > system.indexOf('Example 10.'), 'after the examples');
  assert.ok(block < system.indexOf('Every answer starts with "thought"'), 'before the thought rule');
  assert.ok(system.includes(`- città: ${CITY}\n- lavoro: ${JOB}\n\nEvery answer starts`));
  assert.equal(await replyLabel(task.id), 'L2');
  // Not offered: the texts are all there.
  assert.doesNotMatch(system, /^- profile\.read:/m);
  // The gateway judged the step on this machine at L2.
  const log = await db().sql<{ label: string; locality: string }[]>`SELECT label, locality FROM gateway_log WHERE task_id = ${task.id} AND target_kind = 'executor'`;
  assert.deepEqual([...log].map((row) => [row.label, row.locality]), [['L2', 'local']]);
});

test('a work conversation: the L1 texts and the L2 topics, never an L2 text; the reply stays L1', async () => {
  await twoFacts();
  const { task } = await ask('work', 'Ciao!');
  const model = scripted([REPLY]);
  assert.deepEqual(await drain(task.id, model), ['answered']);
  const system = systemOf(model.requests[0]);
  assert.match(system, /- città: \[private: not available in this conversation\]/);
  assert.ok(system.includes(`- lavoro: ${JOB}`));
  assert.ok(!everything(model).includes('Borgo Finto'), 'no L2 text anywhere in the request');
  assert.equal(await replyLabel(task.id), 'L1');
});

test('an L0 task reads nothing of the profile, and its label stays L0', async () => {
  await twoFacts();
  const task = await submitTask(db().sql, { title: 'Saluta', assignee: 'arianna', label: 'L0', clearance: 'L0', effectiveLabel: 'L0' });
  const model = scripted([REPLY]);
  await drain(task.id, model);
  assert.ok(!everything(model).includes(HEADER));
  assert.ok(!everything(model).includes('città'));
  assert.equal((await loadTurns(db().sql, task.id))[0]?.label, 'L0');
});

test('without facts the prompt is the same as before: no block, no profile.read', async () => {
  const { task } = await ask('private', 'Ciao!');
  const model = scripted([REPLY]);
  await drain(task.id, model);
  const system = systemOf(model.requests[0]);
  assert.ok(!system.includes(HEADER));
  assert.doesNotMatch(system, /profile\.read/);
});

test('the block counts in the label of the step: an L2 text lifts an L1 task to L2, L1 texts alone do not', async () => {
  await fact('lavoro', JOB, 'L1');
  const lower = await submitTask(db().sql, { title: 'Riassumi la giornata', assignee: 'arianna', label: 'L1', clearance: 'L2', effectiveLabel: 'L1' });
  const first = scripted([REPLY]);
  await drain(lower.id, first);
  assert.equal((await loadTurns(db().sql, lower.id))[0]?.label, 'L1');

  await fact('città', CITY, 'L2');
  const upper = await submitTask(db().sql, { title: 'Riassumi la giornata', assignee: 'arianna', label: 'L1', clearance: 'L2', effectiveLabel: 'L1' });
  const second = scripted([REPLY]);
  await drain(upper.id, second);
  assert.ok(everything(second).includes(CITY));
  // Whatever the step writes or hands over afterwards carries L2: a brief to the cloud would need the user's declassification.
  assert.equal((await loadTurns(db().sql, upper.id))[0]?.label, 'L2');
});

/** Facts too long to show whole: the block shows the topics alone. */
async function longProfile(): Promise<void> {
  await fact('città', CITY, 'L2');
  await fact('lavoro', JOB, 'L1');
  for (let index = 0; index < 6; index += 1) await fact(`nota ${String(index)}`, `Nota finta ${String(index)} ${'z'.repeat(280)}`, 'L1');
}

test('past the limit: the topics alone (L1) and profile.read, which reads an L2 text in a private conversation', async () => {
  await longProfile();
  const { task } = await ask('private', 'Dove vivo?');
  const model = scripted([{ action: 'call', tool: 'profile.read', arguments: { topic: 'Città' } }, { action: 'reply', text: 'A Borgo Finto.' }]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'answered']);
  const system = systemOf(model.requests[0]);
  assert.match(system, /^- profile\.read:/m);
  assert.match(system, /only their topics/);
  assert.ok(!system.includes(CITY) && !system.includes('z'.repeat(50)), 'no text in the block');
  // The text reaches the model as the result of its call, with the label of the fact.
  assert.equal(model.requests[1]?.messages.at(-1)?.content, `<tool_result>\ncittà: ${CITY}\n</tool_result>\n\n${NOW_LINE}`);
  const turns = await loadTurns(db().sql, task.id);
  assert.deepEqual(turns.map((turn) => turn.label), ['L2', 'L2']);
});

test('past the limit in a work conversation: profile.read reads an L1 text, an L2 one is private, never its text', async () => {
  await longProfile();
  const { task } = await ask('work', 'Che lavoro faccio e dove vivo?');
  const model = scripted([
    { action: 'call', tool: 'profile.read', arguments: { topic: 'lavoro' } },
    { action: 'call', tool: 'profile.read', arguments: { topic: 'città' } },
    { action: 'call', tool: 'profile.read', arguments: { topic: 'figli' } },
    { action: 'reply', text: 'Sei uno sviluppatore web; la città non la so.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'continued', 'continued', 'answered']);
  assert.equal(model.requests[1]?.messages.at(-1)?.content, `<tool_result>\nlavoro: ${JOB}\n</tool_result>\n\n${NOW_LINE}`);
  assert.match(model.requests[2]?.messages.at(-1)?.content ?? '', /the text of 'città' is private and not available in this conversation/);
  assert.match(model.requests[3]?.messages.at(-1)?.content ?? '', /no fact 'figli'; the topics are: città, lavoro, nota 0/);
  assert.ok(!everything(model).includes('Borgo Finto'));
  const turns = await loadTurns(db().sql, task.id);
  assert.deepEqual(turns.map((turn) => turn.label), ['L1', 'L1', 'L1', 'L1']);
  assert.equal(await replyLabel(task.id), 'L1');
});

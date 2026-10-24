// The warm-up of the local model (D-316): the request is the first step of
// Arianna in a new private conversation, byte for byte up to the end of the
// examples (what oMLX keeps in its blocks), with the same schema (the grammar
// it compiles), and never a word of the user's. Invented facts only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import type { MacEnv } from '../src/mac-files.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator, WARMUP_MESSAGE } from '../src/orchestrator/orchestrator.ts';
import { createRoutine, routineDueSoon, ROUTINE_SOON_MS } from '../src/routines.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `warmup-prompt-${randomUUID()}`);
const agents = committedAgents(ROOT);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const CITY = 'Vive a Borgo Finto';

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
afterEach(async () => {
  await db().sql`SELECT user_fact_delete(id) FROM user_facts`;
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

const orchestrator = (model: LocalModel, mac?: MacEnv) =>
  createOrchestrator({
    ...(mac === undefined ? {} : { mac }),
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() }, personas: {} }),
    rules: RULES,
  });

/** The request of the first step of Arianna in a new private conversation, as the engine sends it. */
async function realFirstStep(text: string, mac?: MacEnv, mode: 'private' | 'work' = 'private'): Promise<ChatRequest> {
  const conversation = await createConversation(db().sql, { mode });
  const { task } = await postUserMessage(db().sql, conversation.id, text);
  const model = scripted([{ action: 'reply', text: 'Va bene.' }]);
  const queue = createJobQueue(db().sql);
  const executor = orchestrator(model, mac);
  for (let guard = 0; guard < 40 && model.requests.length === 0; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) break;
    if (job.payload.taskId !== task.id) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS);
  }
  const first = model.requests[0];
  if (first === undefined) throw new Error('the step asked no model');
  return first;
}

const systemOf = (request: ChatRequest | undefined): string => request?.messages[0]?.content ?? '';

/** The warm-up request of one part (D-316 with D-314): the private conversation or the work one. */
async function warmOf(executor: ReturnType<typeof orchestrator>, part: 'private' | 'work'): Promise<ChatRequest | undefined> {
  return (await executor.warmupRequests()).find((item) => item.part === part)?.request;
}

test('two warm-ups, private then work, in this order', async () => {
  assert.deepEqual((await orchestrator(scripted([])).warmupRequests()).map((item) => item.part), ['private', 'work']);
});

test('the work warm-up: the same system prompt and schema as the first step of a new work conversation without a project, with or without the Mac', async () => {
  const mac: MacEnv = { home: join(HOME, 'casa-finta'), excluded: [] };
  for (const env of [undefined, mac]) {
    const real = await realFirstStep('Come imposto i test del progetto?', env, 'work');
    assert.doesNotMatch(systemOf(real), /^- mac\.list:/m);
    assert.match(systemOf(real), /^- web\.fetch:/m);
    const warm = await warmOf(orchestrator(scripted([]), env), 'work');
    assert.ok(warm !== undefined);
    assert.equal(systemOf(warm), systemOf(real));
    assert.deepEqual(warm.schema, real.schema);
    assert.equal(warm.maxTokens, 1);
    assert.deepEqual(warm.messages.slice(1), [{ role: 'user', content: WARMUP_MESSAGE }]);
  }
  // The two prompts part from the list of tools on: the reason of the second warm-up.
  const work = await warmOf(orchestrator(scripted([]), mac), 'work');
  const own = await warmOf(orchestrator(scripted([]), mac), 'private');
  assert.notEqual(systemOf(work), systemOf(own));
});

test('without a profile: the same system prompt byte for byte and the same schema as the real first step, one token, a fixed message', async () => {
  const real = await realFirstStep('Quanto pago di condominio?');
  const warm = await warmOf(orchestrator(scripted([])), 'private');
  assert.ok(warm !== undefined);
  assert.equal(systemOf(warm), systemOf(real));
  assert.deepEqual(warm.schema, real.schema);
  assert.equal(warm.model, real.model);
  assert.equal(warm.maxTokens, 1);
  assert.equal(warm.temperature, 0);
  assert.deepEqual(warm.messages.slice(1), [{ role: 'user', content: WARMUP_MESSAGE }]);
});

test('with the folders of the Mac (D-314): the warm-up offers the same mac tools as the real first step', async () => {
  const mac: MacEnv = { home: join(HOME, 'casa-finta'), excluded: [] };
  const real = await realFirstStep('Che file ho sulla Scrivania?', mac);
  assert.match(systemOf(real), /^- mac\.list:/m);
  const warm = await warmOf(orchestrator(scripted([]), mac), 'private');
  assert.ok(warm !== undefined);
  assert.equal(systemOf(warm), systemOf(real));
  assert.deepEqual(warm.schema, real.schema);
});

test('with a profile «Su di te»: the same prompt up to the end of the examples and the same schema, never a fact', async () => {
  await db().sql`INSERT INTO user_facts (topic, text, label) VALUES ('città', ${CITY}, 'L2'::privacy_label)`;
  const real = await realFirstStep('Ciao!');
  assert.ok(systemOf(real).includes(CITY), 'the real step reads the profile');
  const warm = await warmOf(orchestrator(scripted([])), 'private');
  assert.ok(warm !== undefined);
  const examplesEnd = systemOf(real).indexOf('</examples>');
  assert.ok(examplesEnd > 0);
  assert.equal(systemOf(warm).slice(0, examplesEnd), systemOf(real).slice(0, examplesEnd));
  assert.deepEqual(warm.schema, real.schema);
  assert.ok(!JSON.stringify(warm).includes('Borgo Finto'), 'no text of the profile in the warm-up');
});

test('the warm-up writes nothing: no task, no message, no gateway row', async () => {
  const count = async (): Promise<number[]> => {
    const [row] = await db().sql<{ tasks: number; messages: number; gateway: number }[]>`
      SELECT (SELECT count(*) FROM tasks)::int AS tasks, (SELECT count(*) FROM messages)::int AS messages, (SELECT count(*) FROM gateway_log)::int AS gateway`;
    return [row?.tasks ?? -1, row?.messages ?? -1, row?.gateway ?? -1];
  };
  const before = await count();
  assert.equal((await orchestrator(scripted([])).warmupRequests()).length, 2);
  assert.deepEqual(await count(), before);
});

test('routineDueSoon (D-316): an active routine due within the time, or late, keeps the models; a later or paused one does not', async () => {
  const routine = await createRoutine(db().sql, { title: 'Resoconto finto', days: [1, 2, 3, 4, 5, 6, 7], at: '09:00', timezone: 'UTC', sources: ['todo'], summary: false });
  const at = async (offsetMs: number): Promise<void> => {
    await db().sql`UPDATE routines SET next_run_at = now() + make_interval(secs => ${offsetMs / 1000}) WHERE id = ${routine.id}`;
  };
  await at(2 * 60_000);
  assert.equal(await routineDueSoon(db().sql, ROUTINE_SOON_MS), true);
  await at(-60_000);
  assert.equal(await routineDueSoon(db().sql, ROUTINE_SOON_MS), true);
  await at(60 * 60_000);
  assert.equal(await routineDueSoon(db().sql, ROUTINE_SOON_MS), false);
  // Late by more than two hours it is missed, not run: it no longer holds the models.
  await at(-3 * 60 * 60_000);
  assert.equal(await routineDueSoon(db().sql, ROUTINE_SOON_MS), false);
  await at(60_000);
  await db().sql`UPDATE routines SET status = 'paused', paused_by = 'user', next_run_at = NULL WHERE id = ${routine.id}`;
  assert.equal(await routineDueSoon(db().sql, ROUTINE_SOON_MS), false);
});

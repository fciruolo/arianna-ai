// Claude answering a system chat directly (D-064, second part), against the
// fake binary of @arianna/executors: only in a work system chat where the
// user chose Sonnet or Opus, without tools, in an empty folder removed after
// the run, with the conversation through the gateway towards the cloud.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AGENTS_DIR, loadAgents, type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { createClaudeExecutor, LocalModelError, WORKTREES_DIR, type ChatRequest, type LocalModel } from '@arianna/executors';

import { ChatError, createConversation, postUserMessage, setConversationModel, type Conversation } from '../src/conversations.ts';
import { createWorker, processStepJob, STEP_QUEUE, type StepExecutor, type StepOutcome } from '../src/engine.ts';
import { loadFailure } from '../src/failures.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { openFailureChat } from '../src/system-chats.ts';
import { loadTask, type Task } from '../src/tasks.ts';
import { Secret } from '@arianna/vault';

import { appendEvent } from '../src/events.ts';
import { runDirect } from '../src/orchestrator/claude-direct.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `claude-direct-${randomUUID()}`);
const DATA = join(HOME, 'data');
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const SELECTABLE = ['sonnet', 'opus', 'fable'];

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });
const agents = loadAgents(join(ROOT, AGENTS_DIR));

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** Arianna's local model, answering each call with the next scripted answer. */
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

interface Setup {
  model: LocalModel;
  /** The first line picks the scenario of the fake binary. */
  prompt?: string;
  executors?: 'claude'[];
}

function orchestrator(setup: Setup): StepExecutor {
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => setup.model,
    settings: () => ({ ...BASE, home: HOME, paths: { data: DATA }, cloud: { executors: setup.executors ?? ['claude'], models: defaultCloudModels() }, projects: [] }),
    rules: RULES,
    claude,
    directPrompt: setup.prompt ?? 'scenario: ok',
  });
}

/** Runs the queued steps of `taskId` until none is due now. */
async function drain(taskId: string, executor: StepExecutor): Promise<string[]> {
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

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

/** A message whose task fails because the local model is down, or (`engine`) because the step failed. */
async function failedTask(mode: 'work' | 'private', cause: 'local-model' | 'engine' = 'local-model'): Promise<Task> {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode });
  const { task } = await postUserMessage(sql, conversation.id, 'Riassumi il README.');
  const run = (): Promise<StepOutcome> => {
    if (cause === 'engine') return Promise.resolve({ kind: 'failed', reason: 'broken' });
    throw new LocalModelError('unavailable', 'no local endpoint answered', { endpoint: 'omlx' });
  };
  const executor: StepExecutor = { plan: () => ({ agent: 'arianna', executor: 'local', locality: 'local' }), run: () => run() };
  const worker = createWorker({ sql, executor, ...OPTIONS, pollMs: 10, retryAfterMs: 0 });
  await worker.start();
  try {
    await waitFor(async () => (await loadTask(sql, task.id))?.status === 'failed');
  } finally {
    await worker.stop();
  }
  return task;
}

/** The system chat of a failure of the local model in a work conversation, with Claude Sonnet answering. */
async function directChat(): Promise<Conversation> {
  const task = await failedTask('work');
  const chat = await openFailureChat(db().sql, task.id, { directModel: 'sonnet' });
  assert.equal(chat.model, 'sonnet');
  return chat;
}

function worktrees(): string[] {
  const folder = join(DATA, WORKTREES_DIR);
  return existsSync(folder) ? readdirSync(folder) : [];
}

test('in a work system chat with Claude chosen, Claude answers without tools and the local model is not called', async () => {
  const { sql } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  const local = scripted([]);
  assert.deepEqual(await drain(task.id, orchestrator({ model: local })), ['answered']);
  assert.equal(local.requests.length, 0);

  const messages = await sql<{ role: string; agent: string | null; model: string | null; body: string; label: string }[]>`
    SELECT role, agent, model, body, label FROM messages WHERE task_id = ${task.id} ORDER BY id`;
  assert.deepEqual(
    [...messages].map((row) => [row.role, row.agent, row.model, row.body, row.label]),
    [
      ['user', null, null, 'Cosa devo controllare?', 'L1'],
      ['assistant', null, 'sonnet', 'ok', 'L1'],
    ],
  );
  assert.equal((await loadTask(sql, task.id))?.status, 'done');

  // The run is a cloud run of Claude, and the conversation left through the gateway, towards Claude.
  // Its label is what Claude read: the chat (L1), not only the task.
  const runs = await sql<{ executor: string; locality: string; model: string | null; label: string }[]>`
    SELECT executor, locality, model, effective_label AS label FROM runs WHERE task_id = ${task.id}`;
  assert.deepEqual([...runs].map((run) => [run.executor, run.locality, run.model, run.label]), [['claude', 'cloud', 'sonnet', 'L1']]);
  const gateway = await sql<{ target: string; locality: string; decision: string; label: string }[]>`
    SELECT target, locality, decision, label FROM gateway_log WHERE task_id = ${task.id} AND target_kind = 'executor'`;
  assert.deepEqual([...gateway].map((row) => [row.target, row.locality, row.decision, row.label]), [['claude', 'cloud', 'allow', 'L1']]);
  // The empty folder of the run is gone.
  assert.deepEqual(worktrees(), []);
});

test('what left for Claude is logged in gateway_log with a summary and no content', async () => {
  const { sql } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Che vuol dire?');
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([]) })), ['answered']);
  // What left is summarized in gateway_log without content.
  const [row] = await sql<{ summary: string | null; bytes: number }[]>`
    SELECT summary, bytes_out AS bytes FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.ok(row !== undefined);
  assert.equal(row.summary, 'system chat answered by claude/sonnet');
  assert.ok(row.bytes > 0);
});

test('with Arianna chosen (no model), the local model answers the system chat', async () => {
  const { sql } = db();
  const chat = await directChat();
  await setConversationModel(sql, chat.id, null, SELECTABLE);
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  const local = scripted([{ action: 'reply', text: 'Controlla oMLX.' }]);
  assert.deepEqual(await drain(task.id, orchestrator({ model: local })), ['answered']);
  assert.equal(local.requests.length, 1);
  const [answer] = await sql<{ model: string | null; body: string }[]>`
    SELECT model, body FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.deepEqual([answer?.model, answer?.body], [null, 'Controlla oMLX.']);
  const runs = await sql<{ locality: string }[]>`SELECT locality FROM runs WHERE task_id = ${task.id}`;
  assert.deepEqual([...runs].map((run) => run.locality), ['local']);
});

test('with Claude chosen but no longer enabled, Arianna answers on the local model', async () => {
  const { sql } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  const local = scripted([{ action: 'reply', text: 'Controlla oMLX.' }]);
  assert.deepEqual(await drain(task.id, orchestrator({ model: local, executors: [] })), ['answered']);
  assert.equal(local.requests.length, 1);
});

test('Claude never answers a user conversation, even a work one with a model chosen for the Coder', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work' });
  await setConversationModel(sql, conversation.id, 'sonnet', SELECTABLE);
  const { task } = await postUserMessage(sql, conversation.id, 'Ciao');
  const local = scripted([{ action: 'reply', text: 'Ciao!' }]);
  assert.deepEqual(await drain(task.id, orchestrator({ model: local })), ['answered']);
  assert.equal(local.requests.length, 1);
});

test('a private system chat cannot choose Claude, neither through the core nor in the database', async () => {
  const { sql, owner } = db();
  const task = await failedTask('private');
  // The default does not apply: the chat is private.
  const chat = await openFailureChat(sql, task.id, { directModel: 'sonnet' });
  assert.equal(chat.model, null);
  await assert.rejects(setConversationModel(sql, chat.id, 'sonnet', SELECTABLE), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(owner`UPDATE conversations SET model = 'sonnet' WHERE id = ${chat.id}`, /conversations_model_only_work/);
});

test('a system chat takes Sonnet or Opus, never Fable', async () => {
  const { sql, owner } = db();
  const chat = await directChat();
  assert.equal((await setConversationModel(sql, chat.id, 'opus', SELECTABLE)).model, 'opus');
  await assert.rejects(setConversationModel(sql, chat.id, 'fable', SELECTABLE), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(owner`UPDATE conversations SET model = 'fable' WHERE id = ${chat.id}`, /conversations_system_model/);
  // A user's work conversation still takes Fable for the Coder.
  const work = await createConversation(sql, { mode: 'work' });
  assert.equal((await setConversationModel(sql, work.id, 'fable', SELECTABLE)).model, 'fable');
});

test('the chat starts with Claude only for a failure of the local model, when Claude is there', async () => {
  const { sql } = db();
  const engine = await failedTask('work', 'engine');
  assert.equal((await openFailureChat(sql, engine.id, { directModel: 'sonnet' })).model, null, 'Arianna can answer about an engine failure');
  const local = await failedTask('work');
  assert.equal((await openFailureChat(sql, local.id)).model, null, 'no Claude in this installation');
});

test('a message of a cloud model is refused by the database outside a work conversation', async () => {
  const { owner } = db();
  const task = await failedTask('private');
  const chat = await openFailureChat(db().sql, task.id);
  await assert.rejects(
    owner`INSERT INTO messages (conversation_id, role, label, body, model) VALUES (${chat.id}, 'assistant', 'L1', 'x', 'sonnet')`,
    /a cloud model writes only in a work conversation/,
  );
  const work = await directChat();
  await assert.rejects(owner`INSERT INTO messages (conversation_id, role, label, body, model) VALUES (${work.id}, 'user', 'L1', 'x', 'sonnet')`, /messages_model_only_assistant/);
  await owner`INSERT INTO messages (conversation_id, role, label, body, model) VALUES (${work.id}, 'assistant', 'L1', 'x', 'sonnet')`;
});

test('a quota refusal waits and runs the same step again, without failing the task', async () => {
  const { sql } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  const results = await drain(task.id, orchestrator({ model: scripted([]), prompt: 'scenario: quota' }));
  assert.equal(results.length, 1);
  const current = await loadTask(sql, task.id);
  assert.notEqual(current?.status, 'failed');
  const quota = await sql`SELECT 1 FROM events WHERE task_id = ${task.id} AND kind = 'executor.quota'`;
  assert.equal(quota.length, 1);
  // Nothing was written in the chat, and the empty folder is gone.
  const [message] = await sql`SELECT 1 FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.equal(message, undefined);
  assert.deepEqual(worktrees(), []);
});

test('a failed run of Claude fails the task with a readable error of origin claude', async () => {
  const { sql } = db();
  // The fake binary reports a reset time already past: no refusal of another test blocks this run.
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([]), prompt: 'scenario: error' })), ['failed']);
  const failure = await loadFailure(sql, task.id);
  assert.equal(failure?.origin, 'claude');
  assert.match(failure.code, /^claude\./);
  assert.deepEqual(worktrees(), []);
});

test('an answer already in the chat closes the step without a second run of Claude', async () => {
  const { sql, owner } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  await owner`INSERT INTO messages (conversation_id, role, label, body, task_id, model) VALUES (${chat.id}, 'assistant', 'L1', 'già risposto', ${task.id}, 'sonnet')`;
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([]) })), ['answered']);
  const gateway = await sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.equal(gateway.length, 0);
});

test('a chat holding a value of the vault is refused by the gateway: nothing reaches Claude', async () => {
  const { sql, owner } = db();
  const secret = new Secret('vault://direct-test', 'fake-direct-secret-0123456789abcdef');
  const chat = await directChat();
  await owner`INSERT INTO messages (conversation_id, role, label, body) VALUES (${chat.id}, 'system', 'L1', ${`chiave ${secret.reveal()}`})`;
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([]) })), ['waiting-user']);
  const gateway = await sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.deepEqual([...gateway].map((row) => row.decision), ['block']);
  const answers = await sql`SELECT 1 FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.equal(answers.length, 0);
  assert.deepEqual(worktrees(), []);
});

test('the summary of the chat is part of what Claude reads, through the gateway, and never above L1 (D-077)', async () => {
  const { sql, owner } = db();
  const secret = new Secret('vault://direct-summary-test', 'fake-summary-secret-0123456789abcdef');
  const chat = await directChat();
  // A piece written by a local step of an earlier task of the chat, over its first message.
  const earlier = await postUserMessage(sql, chat.id, 'Prima domanda');
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, effective_label)
    VALUES (${earlier.task.id}, 1, 'arianna', 'local', 'local', 'L1') RETURNING id::text`;
  const [first] = await sql<{ id: string }[]>`SELECT min(id)::text AS id FROM messages WHERE conversation_id = ${chat.id}`;
  const piece = (label: string, body: string) => sql`
    INSERT INTO conversation_summaries (conversation_id, first_message_id, last_message_id, label, body, model, task_id, run_id)
    VALUES (${chat.id}, ${first?.id ?? ''}::bigint, ${first?.id ?? ''}::bigint, ${label}::privacy_label, ${body}, 'local-large', ${earlier.task.id}, ${run?.id ?? ''})`;
  // A work chat holds at most L1: a piece above it does not exist.
  await assert.rejects(piece('L2', 'riassunto privato'), /above the clearance/);
  await piece('L1', `riassunto con la chiave ${secret.reveal()}`);
  await owner`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${run?.id ?? ''}`;

  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([]) })), ['waiting-user']);
  // The secret was only in the summary: the gateway saw it in the brief for Claude and blocked it.
  const gateway = await sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.deepEqual([...gateway].map((row) => row.decision), ['block']);
  assert.deepEqual(worktrees(), []);
});

/** The settings of the orchestrator, for calling runDirect itself. */
function directEnv() {
  return {
    sql: db().sql,
    agents,
    settings: () => ({ ...BASE, home: HOME, paths: { data: DATA }, cloud: { executors: ['claude' as const], models: defaultCloudModels() }, projects: [] }),
    rules: RULES,
    claude,
    directPrompt: 'scenario: ok',
  };
}

test('a resumed step starts a new session and removes the empty folder of the interrupted run', async () => {
  const { sql } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  const current = await loadTask(sql, task.id);
  assert.ok(current !== undefined);
  const interrupted = randomUUID();
  mkdirSync(join(DATA, WORKTREES_DIR, interrupted), { recursive: true });
  const history = [{ value: { role: 'user' as const, content: 'Cosa devo controllare?' }, label: 'L1' as const, source: 'test' }];
  const outcome = await runDirect(
    directEnv(),
    {
      task: current,
      step: 1,
      runId: randomUUID(),
      resume: { runId: interrupted, sessionRef: '00000000-0000-4000-8000-000000000009' },
      signal: new AbortController().signal,
      setSessionRef: () => Promise.resolve(),
    },
    'sonnet',
    history,
  );
  assert.equal(outcome.kind, 'answered');
  // The fake binary answers "resumed" when it gets --resume.
  const [answer] = await sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.equal(answer?.body, 'ok');
  assert.deepEqual(worktrees(), []);
});

test('runDirect refuses what is above L1 before anything is launched', async () => {
  const { sql } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  const current = await loadTask(sql, task.id);
  assert.ok(current !== undefined);
  const history = [{ value: { role: 'user' as const, content: 'dato privato' }, label: 'L2' as const, source: 'test' }];
  const outcome = await runDirect(
    directEnv(),
    { task: current, step: 1, runId: randomUUID(), signal: new AbortController().signal, setSessionRef: () => Promise.resolve() },
    'sonnet',
    history,
  );
  assert.equal(outcome.kind, 'wait-user');
  const gateway = await sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.equal(gateway.length, 0);
  assert.deepEqual(worktrees(), []);
});

// Last: the quota block it writes would hold for the tests after it.
test('a quota block known before the launch makes the step wait, without launching Claude', async () => {
  const { sql } = db();
  const chat = await directChat();
  const { task } = await postUserMessage(sql, chat.id, 'Cosa devo controllare?');
  const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await appendEvent(sql, { kind: 'executor.quota', label: 'L0', payload: { executor: 'claude', resetsAt, overage: false } });
  const results = await drain(task.id, orchestrator({ model: scripted([]) }));
  assert.equal(results.length, 1);
  assert.notEqual((await loadTask(sql, task.id))?.status, 'failed');
  const gateway = await sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.equal(gateway.length, 0);
  assert.deepEqual(worktrees(), []);
});

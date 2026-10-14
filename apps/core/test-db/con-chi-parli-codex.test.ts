// ChatGPT without a project (D-212, the rest of D-111 tappa B): the plain
// chat on `codex exec`, against the fake binary of @arianna/executors, and the
// context indicator of the plain chats (migration 0064). The same chain as
// the plain chat with Claude: the gateway towards codex, the folder of the
// conversation (an empty repository, opened read only), the session of the
// latest answer resumed, one new start when it is gone.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { conversationWorkspacePath, createClaudeExecutor, createCodexExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { ChatError, createConversation, loadConversation, postUserMessage, setConversationModel, type Conversation } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `con-chi-parli-codex-${randomUUID()}`);
const DATA = join(HOME, 'data');
const FAKE_CODEX = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-codex.ts');
const FAKE_CLAUDE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 8, maxMinutes: 10 }) };
const BASE = loadConfig();
const SELECTABLE = ['sonnet', 'opus', 'fable', 'luna', 'sol', 'astra'];
/** What the fake binary reports at the end of its turn: input and output of the recorded run. */
const RECORDED_CONTEXT = 28879 + 156;

const codex = createCodexExecutor({
  enabled: ['codex'],
  command: { file: process.execPath, args: [FAKE_CODEX] },
  home: ROOT,
  killGraceMs: 200,
  modelName: (model) => `gpt-6.1-${model}`,
});
const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE_CLAUDE] }, home: ROOT, killGraceMs: 200 });
const agents = committedAgents(ROOT);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** A local model that must never be asked: nobody answers in place of ChatGPT. */
function untouched(): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      return Promise.reject(new Error('the local model was asked'));
    },
  };
}

function orchestrator(model: LocalModel, executors: ('claude' | 'codex')[] = ['codex', 'claude'], scenario = 'ok'): StepExecutor {
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...BASE, home: HOME, paths: { data: DATA }, cloud: { executors, models: defaultCloudModels() }, projects: [] }),
    rules: RULES,
    claude,
    codex,
    // The first line picks the scenario of the fake binaries.
    chatPrompt: 'scenario: ok',
    codexChatPrompt: `scenario: ${scenario}`,
  });
}

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

const CODEX = { name: 'codex', modes: ['work'] as const, project: false };
const CLAUDE = { name: 'claude', modes: ['work'] as const, project: false };

function codexChat(model?: string): Promise<Conversation> {
  return createConversation(db().sql, { mode: 'work', agent: { ...CODEX, modes: ['work'] }, ...(model === undefined ? {} : { model }) });
}

/** What the fake binary received in the folder of the conversation, at its latest run. */
function lastLaunch(conversationId: string): { argv: string[]; prompt: string } {
  return JSON.parse(readFileSync(join(conversationWorkspacePath({ data: DATA, conversationId }), '.fake-codex.json'), 'utf8')) as { argv: string[]; prompt: string };
}

test('the plain chat with ChatGPT takes a model of Codex only, in the core and in the database (migration 0064)', async () => {
  const { sql, owner } = db();
  const invalid = (error: unknown) => error instanceof ChatError && error.code === 'invalid';
  await assert.rejects(codexChat('sonnet'), invalid);
  await assert.rejects(createConversation(sql, { mode: 'private', agent: { ...CODEX, modes: ['private', 'work'] } }), invalid);
  const chat = await codexChat('astra');
  assert.deepEqual([chat.agent, chat.mode, chat.clearance, chat.workspace, chat.model], ['codex', 'work', 'L1', null, 'astra']);
  assert.equal((await setConversationModel(sql, chat.id, 'luna', SELECTABLE)).model, 'luna');
  assert.equal((await setConversationModel(sql, chat.id, null, SELECTABLE)).model, null);
  await assert.rejects(setConversationModel(sql, chat.id, 'opus', SELECTABLE), invalid);
  // The database, whatever the core does.
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent, model) VALUES ('work', 'L1', 'codex', 'sonnet')`, /conversations_agent_codex_model/);
  await owner`INSERT INTO conversations (mode, clearance, agent, model) VALUES ('work', 'L1', 'codex', 'sol')`;
  // A context of a run is a number in range, or nothing.
  const [run] = await owner<{ id: string }[]>`SELECT id::text FROM runs LIMIT 1`;
  if (run !== undefined) await assert.rejects(owner`UPDATE runs SET context_tokens = -1 WHERE id = ${run.id}`, /runs_context_tokens/);
});

test('ChatGPT without a project answers through the gateway in the folder of the conversation, read only, then resumes its session', async () => {
  const { sql } = db();
  const chat = await codexChat();
  const first = await postUserMessage(sql, chat.id, 'Come funziona un indice in PostgreSQL?');
  assert.equal(first.task.assignee, 'codex');
  const local = untouched();
  assert.deepEqual(await drain(first.task.id, orchestrator(local)), ['answered']);
  assert.equal(local.requests.length, 0, 'the local model never answers in its place');
  const folder = conversationWorkspacePath({ data: DATA, conversationId: chat.id });
  assert.ok(existsSync(join(folder, '.git')), 'codex runs inside an empty repository of its own');
  const opening = lastLaunch(chat.id);
  assert.ok(!opening.argv.includes('resume'));
  assert.equal(opening.argv[opening.argv.indexOf('--model') + 1], 'gpt-6.1-sol', 'Sol when no model is chosen');
  assert.ok(opening.argv.some((arg) => arg.includes(`"${folder}"="read"`)), 'the folder is opened read only');
  assert.ok(!opening.argv.some((arg) => arg.includes(`"${folder}"="write"`)));
  assert.match(opening.prompt, /^scenario: ok/);
  assert.match(opening.prompt, /indice in PostgreSQL/);
  const [answer] = await sql<{ body: string; model: string | null; label: string }[]>`SELECT body, model, label FROM messages WHERE task_id = ${first.task.id} AND role = 'assistant'`;
  assert.deepEqual([answer?.body, answer?.model, answer?.label], ['ok', 'sol', 'L1']);
  const gateway = await sql<{ target: string; decision: string; label: string; summary: string | null }[]>`
    SELECT target, decision, label, summary FROM gateway_log WHERE task_id = ${first.task.id} AND target_kind = 'executor'`;
  assert.deepEqual([...gateway].map((row) => [row.target, row.decision, row.label, row.summary]), [['codex', 'allow', 'L1', 'plain chat answered by codex/sol']]);
  // The context indicator: how full the session is after the answer, a number only.
  assert.equal((await loadConversation(sql, chat.id))?.contextTokens, RECORDED_CONTEXT);

  // The second message resumes the session: only the new message leaves.
  const second = await postUserMessage(sql, chat.id, 'E un indice parziale?');
  assert.deepEqual(await drain(second.task.id, orchestrator(local)), ['answered']);
  const resumed = lastLaunch(chat.id);
  assert.ok(resumed.argv.includes('resume'));
  assert.match(resumed.prompt, /indice parziale/);
  assert.doesNotMatch(resumed.prompt, /scenario: ok|indice in PostgreSQL/);
  const [again] = await sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${second.task.id} AND role = 'assistant'`;
  assert.equal(again?.body, 'resumed');
});

test('when the session of ChatGPT is gone, one new start carries the whole conversation', async () => {
  const { sql } = db();
  const chat = await codexChat();
  const first = await postUserMessage(sql, chat.id, 'Prima domanda');
  assert.deepEqual(await drain(first.task.id, orchestrator(untouched())), ['answered']);
  // The resumed run reads only this message: its first line makes the fake binary answer from another session.
  const second = await postUserMessage(sql, chat.id, 'scenario: new-session\nSeconda domanda');
  assert.deepEqual(await drain(second.task.id, orchestrator(untouched())), ['answered']);
  const restarted = lastLaunch(chat.id);
  assert.ok(!restarted.argv.includes('resume'));
  assert.match(restarted.prompt, /^scenario: ok/);
  assert.match(restarted.prompt, /Prima domanda/);
  assert.match(restarted.prompt, /Seconda domanda/);
  const gateway = await sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE task_id = ${second.task.id} AND target = 'codex'`;
  assert.deepEqual([...gateway].map((row) => row.decision), ['allow', 'allow']);
});

test('ChatGPT that runs commands is stopped after CODEX_CHAT_COMMANDS: no answer is written', async () => {
  const { sql } = db();
  const chat = await codexChat();
  const { task } = await postUserMessage(sql, chat.id, 'Elenca i file');
  const results = await drain(task.id, orchestrator(untouched(), ['codex'], 'many-tools'));
  assert.notEqual(results.at(-1), 'answered');
  const answers = await sql`SELECT 1 FROM messages WHERE task_id = ${task.id} AND role = 'assistant' AND model IS NOT NULL`;
  assert.equal(answers.length, 0);
  assert.equal((await loadConversation(sql, chat.id))?.contextTokens, null, 'no answer, no context');
});

test('with Codex off the plain chat with ChatGPT waits for the user: neither Claude nor the local model answers in its place', async () => {
  const { sql } = db();
  const chat = await codexChat();
  const { task } = await postUserMessage(sql, chat.id, 'Ciao');
  const local = untouched();
  assert.deepEqual(await drain(task.id, orchestrator(local, ['claude'])), ['waiting-user']);
  assert.equal(local.requests.length, 0);
  assert.equal((await loadTask(sql, task.id))?.status, 'waiting_user');
  const launched = await sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target_kind = 'executor'`;
  assert.equal(launched.length, 0);
});

test('the plain chat with ChatGPT refuses a message the scanner flags: it never reaches Codex', async () => {
  const { sql } = db();
  const chat = await codexChat();
  await assert.rejects(postUserMessage(sql, chat.id, 'Il mio IBAN è IT60X0542811101000000123456'), (error: unknown) => error instanceof ChatError && error.code === 'scanner');
});

test('the plain chat with Claude shows its context too (D-212), and a work conversation with Arianna none', async () => {
  const { sql } = db();
  const chat = await createConversation(sql, { mode: 'work', agent: { ...CLAUDE, modes: ['work'] } });
  assert.equal(chat.contextTokens, null, 'nothing before the first answer');
  const { task } = await postUserMessage(sql, chat.id, 'Spiegami le promise');
  assert.deepEqual(await drain(task.id, orchestrator(untouched())), ['answered']);
  const after = await loadConversation(sql, chat.id);
  assert.ok(after?.contextTokens !== null && after?.contextTokens !== undefined && after.contextTokens > 0, 'the run of the answer recorded how full the session is');
  const arianna = await createConversation(sql, { mode: 'work' });
  assert.equal(arianna.contextTokens, null);
});

// «Con chi parli» (D-111, tappa B): the local model with the knowledge base
// read only, and the plain chat with Claude without a project, against the
// fake binary of @arianna/executors. The mode follows who answers, in the
// core and in the database (migration 0063); a private conversation never
// has an interlocutor on the cloud.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { conversationWorkspacePath, createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { ChatError, createConversation, postUserMessage, setConversationModel, type Conversation } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `con-chi-parli-${randomUUID()}`);
const DATA = join(HOME, 'data');
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 8, maxMinutes: 10 }) };
const BASE = loadConfig();
const SELECTABLE = ['sonnet', 'opus', 'fable'];

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });
const agents = committedAgents(ROOT);

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
      const value = JSON.stringify(request.schema?.schema).includes('"thought"') ? { thought: 'Ragiono.', ...next } : next;
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

function orchestrator(model: LocalModel, executors: 'claude'[] = ['claude']): StepExecutor {
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...BASE, home: HOME, paths: { data: DATA }, cloud: { executors, models: defaultCloudModels() }, projects: [] }),
    rules: RULES,
    claude,
    // The first line picks the scenario of the fake binary.
    chatPrompt: 'scenario: ok',
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

const LOCAL = { name: 'local-chat', modes: ['private'] as const, project: false };
const CLAUDE = { name: 'claude', modes: ['work'] as const, project: false };

function plainChat(): Promise<Conversation> {
  return createConversation(db().sql, { mode: 'work', agent: { ...CLAUDE, modes: ['work'] } });
}

/** What the fake binary received in the folder of the conversation, at its latest run. */
function lastLaunch(conversationId: string): { argv: string[]; prompt: string } {
  return JSON.parse(readFileSync(join(conversationWorkspacePath({ data: DATA, conversationId }), '.fake-claude.json'), 'utf8')) as { argv: string[]; prompt: string };
}

test('the mode follows who answers, in the core and in the database (migration 0063)', async () => {
  const { sql, owner } = db();
  const invalid = (error: unknown) => error instanceof ChatError && error.code === 'invalid';
  // The core: the local model only in private, Claude only at work and without a project.
  await assert.rejects(createConversation(sql, { mode: 'work', agent: { ...LOCAL, modes: ['private', 'work'] } }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'private', agent: { ...CLAUDE, modes: ['private', 'work'] } }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'work', project: 'demo', projects: ['demo'], agent: { ...CLAUDE, modes: ['work'] } }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'work', model: 'fable', agent: { ...CLAUDE, modes: ['work'] } }), invalid);
  const local = await createConversation(sql, { mode: 'private', agent: { ...LOCAL, modes: ['private'] } });
  assert.deepEqual([local.agent, local.mode, local.clearance], ['local-chat', 'private', 'L2']);
  const chat = await plainChat();
  assert.deepEqual([chat.agent, chat.mode, chat.clearance, chat.workspace], ['claude', 'work', 'L1', null]);

  // The database, whatever the core does.
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent) VALUES ('work', 'L1', 'local-chat')`, /conversations_agent_local_chat/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent) VALUES ('private', 'L2', 'claude')`, /conversations_agent_cloud_chat/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent) VALUES ('private', 'L2', 'codex')`, /conversations_agent_cloud_chat/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent, workspace) VALUES ('work', 'L1', 'claude', 'demo')`, /conversations_agent_cloud_chat/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent) VALUES ('private', 'L2', 'coder')`, /conversations_agent_coder_project/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent, model) VALUES ('work', 'L1', 'claude', 'fable')`, /conversations_agent_claude_model/);
  await owner`INSERT INTO conversations (mode, clearance, agent, model) VALUES ('work', 'L1', 'claude', 'opus')`;
  await owner`INSERT INTO conversations (mode, clearance, agent, workspace) VALUES ('work', 'L1', 'coder', 'demo')`;

  // Chosen at creation, never changed.
  await assert.rejects(owner`UPDATE conversations SET agent = NULL WHERE id = ${chat.id}`, /chosen at creation/);
  await assert.rejects(owner`UPDATE conversations SET agent = 'claude' WHERE id = ${local.id}`, /chosen at creation/);
  // The model of the plain chat: Sonnet or Opus, never Fable.
  assert.equal((await setConversationModel(sql, chat.id, 'opus', SELECTABLE)).model, 'opus');
  await assert.rejects(setConversationModel(sql, chat.id, 'fable', SELECTABLE), invalid);
});

test('the local model answers with kb.search and kb.read only, on this machine, without a delegation', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private', agent: { ...LOCAL, modes: ['private'] } });
  const { task } = await postUserMessage(sql, conversation.id, 'Cosa ho scritto sul viaggio?');
  assert.equal(task.assignee, 'local-chat');
  const local = scripted([{ action: 'reply', text: 'Non trovo note sul viaggio.' }]);
  assert.deepEqual(await drain(task.id, orchestrator(local)), ['answered']);
  const offered = JSON.stringify(local.requests[0]?.schema?.schema);
  assert.match(offered, /kb\.search/);
  assert.match(offered, /kb\.read/);
  assert.doesNotMatch(offered, /kb\.write|task\.create|task\.delegate|task\.plan|user\.ask|commitment\./);
  const delegations = await sql`SELECT 1 FROM task_delegations WHERE task_id = ${task.id}`;
  assert.equal(delegations.length, 0);
  // Nothing went towards the cloud: only the local executor in the gateway.
  const targets = await sql<{ locality: string }[]>`SELECT DISTINCT locality FROM gateway_log WHERE task_id = ${task.id} AND target_kind = 'executor'`;
  assert.deepEqual([...targets].map((row) => row.locality), ['local']);
  const [answer] = await sql<{ body: string; model: string | null }[]>`SELECT body, model FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.deepEqual([answer?.body, answer?.model], ['Non trovo note sul viaggio.', null]);
});

test('an answer of the local model with a tool outside its two is refused: nothing is written', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private', agent: { ...LOCAL, modes: ['private'] } });
  const { task } = await postUserMessage(sql, conversation.id, 'Crea una carta per il viaggio.');
  const local = scripted([
    { action: 'call', tool: 'task.create', arguments: { title: 'Viaggio' } },
    { action: 'call', tool: 'task.create', arguments: { title: 'Viaggio' } },
  ] as unknown as Answer[]);
  assert.deepEqual(await drain(task.id, orchestrator(local)), ['waiting-user']);
  const cards = await sql`SELECT 1 FROM tasks WHERE title = 'Viaggio'`;
  assert.equal(cards.length, 0);
  assert.equal((await loadTask(sql, task.id))?.status, 'waiting_user');
});

test('Claude without a project answers through the gateway in the folder of the conversation, then resumes its session', async () => {
  const { sql } = db();
  const chat = await plainChat();
  const first = await postUserMessage(sql, chat.id, 'Spiegami le promise in JavaScript.');
  assert.equal(first.task.assignee, 'claude');
  const local = scripted([]);
  assert.deepEqual(await drain(first.task.id, orchestrator(local)), ['answered']);
  assert.equal(local.requests.length, 0, 'the local model never answers in its place');
  const folder = conversationWorkspacePath({ data: DATA, conversationId: chat.id });
  assert.ok(existsSync(folder), 'the folder stays for the next message');
  const opening = lastLaunch(chat.id);
  assert.ok(!opening.argv.includes('--resume'));
  assert.match(opening.prompt, /^scenario: ok/);
  assert.match(opening.prompt, /Spiegami le promise/);
  const [answer] = await sql<{ body: string; model: string | null; label: string }[]>`SELECT body, model, label FROM messages WHERE task_id = ${first.task.id} AND role = 'assistant'`;
  assert.deepEqual([answer?.body, answer?.model, answer?.label], ['ok', 'sonnet', 'L1']);
  const gateway = await sql<{ target: string; decision: string; label: string; summary: string | null }[]>`
    SELECT target, decision, label, summary FROM gateway_log WHERE task_id = ${first.task.id} AND target_kind = 'executor'`;
  assert.deepEqual([...gateway].map((row) => [row.target, row.decision, row.label, row.summary]), [['claude', 'allow', 'L1', 'plain chat answered by claude/sonnet']]);

  // The second message resumes the session: only the new message leaves.
  const second = await postUserMessage(sql, chat.id, 'E async/await?');
  assert.deepEqual(await drain(second.task.id, orchestrator(local)), ['answered']);
  const resumed = lastLaunch(chat.id);
  assert.ok(resumed.argv.includes('--resume'));
  assert.match(resumed.prompt, /E async\/await\?/);
  assert.doesNotMatch(resumed.prompt, /scenario: ok|Spiegami le promise/);
  const [again] = await sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${second.task.id} AND role = 'assistant'`;
  assert.equal(again?.body, 'resumed');
});

test('when the session of the plain chat is gone, one new start carries the whole conversation', async () => {
  const { sql } = db();
  const chat = await plainChat();
  const first = await postUserMessage(sql, chat.id, 'Prima domanda');
  assert.deepEqual(await drain(first.task.id, orchestrator(scripted([]))), ['answered']);
  // The resumed run reads only this message: its first line makes the fake binary lose the session.
  const second = await postUserMessage(sql, chat.id, 'scenario: no-session\nSeconda domanda');
  assert.deepEqual(await drain(second.task.id, orchestrator(scripted([]))), ['answered']);
  const restarted = lastLaunch(chat.id);
  assert.ok(!restarted.argv.includes('--resume'));
  assert.match(restarted.prompt, /^scenario: ok/);
  assert.match(restarted.prompt, /Prima domanda/);
  assert.match(restarted.prompt, /Seconda domanda/);
  // Two passages through the gateway, both towards Claude, both allowed.
  const gateway = await sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE task_id = ${second.task.id} AND target = 'claude'`;
  assert.deepEqual([...gateway].map((row) => row.decision), ['allow', 'allow']);
});

test('with Claude off the plain chat waits for the user: the local model never answers in its place', async () => {
  const { sql } = db();
  const chat = await plainChat();
  const { task } = await postUserMessage(sql, chat.id, 'Ciao');
  const local = scripted([{ action: 'reply', text: 'Ciao!' }]);
  assert.deepEqual(await drain(task.id, orchestrator(local, [])), ['waiting-user']);
  assert.equal(local.requests.length, 0);
  const answers = await sql`SELECT 1 FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.equal(answers.length, 0);
});

test('the plain chat refuses a message the scanner flags: it never reaches Claude', async () => {
  const { sql } = db();
  const chat = await plainChat();
  await assert.rejects(postUserMessage(sql, chat.id, 'Il mio IBAN è IT60X0542811101000000123456'), (error: unknown) => error instanceof ChatError && error.code === 'scanner');
});

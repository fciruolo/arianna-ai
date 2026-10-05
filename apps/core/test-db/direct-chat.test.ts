// The direct chat with the Coder (D-111, tappa A): a work conversation on a
// project where every message of the user goes as it is to the Coder on
// claude -p, against the fake binary of @arianna/executors, with no local
// step before or after it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import { createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { ChatError, createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { DIRECT_CHAT_TEXT } from '../src/orchestrator/delegate.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `direct-chat-${randomUUID()}`);
const REPO = join(HOME, 'repos', 'site');
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const PROJECTS = ['site'];

const claude = createClaudeExecutor({
  enabled: ['claude'],
  command: { file: process.execPath, args: [FAKE] },
  home: ROOT,
  killGraceMs: 200,
  modelName: (model) => defaultCloudModels()[model].name,
});
const loaded = committedAgents(ROOT);

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

/** Back to the commit of the fixture, nothing left over. */
function restoreRepo(): void {
  git('checkout', '--quiet', '--', '.');
  git('clean', '--quiet', '-fd');
}

before(() => {
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, 'README.md'), '# Fake site\n');
  writeFileSync(join(REPO, '.gitignore'), '.fake-claude.json\n');
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** A local model that must never be called in the direct chat. */
function untouched(): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      return Promise.reject(new Error('the local model was called in the direct chat'));
    },
  };
}

function orchestrator(model: LocalModel, coderPrompt?: string): StepExecutor {
  const coder = loaded.get('coder');
  assert.ok(coder !== undefined);
  const agents = new Map<string, LoadedAgent>(loaded);
  if (coderPrompt !== undefined) agents.set('coder', { card: coder.card, prompt: coderPrompt });
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: ['claude' as const], models: defaultCloudModels() },
    projects: PROJECTS.map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1' })),
  });
  return createOrchestrator({ sql: db().sql, agents, kb: createKb({ home: HOME, rules: RULES }), model: () => model, settings, rules: RULES, claude });
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

function directChat() {
  return createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: 'coder' });
}

function received(): { prompt: string } {
  return JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { prompt: string };
}

test('a direct chat needs a work conversation on a project: private or without project is refused (D-111)', async () => {
  await assert.rejects(createConversation(db().sql, { mode: 'private', agent: 'coder' }), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(createConversation(db().sql, { mode: 'work', projects: PROJECTS, agent: 'coder' }), /needs a project/);
  await assert.rejects(createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: 'designer' as 'coder' }), /agent must be coder/);
  // The database says the same, whatever the code does.
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, agent) VALUES ('private', 'L2', 'coder')`, /conversations_agent_work_project/);
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, workspace, agent) VALUES ('work', 'L1', 'site', 'designer')`, /conversations_agent_known/);
  const plain = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  assert.equal(plain.agent, null);
  const direct = await directChat();
  assert.deepEqual([direct.agent, direct.mode, direct.clearance, direct.workspace], ['coder', 'work', 'L1', 'site']);
});

test('who answers never changes after creation: the trigger refuses it both ways', async () => {
  const direct = await directChat();
  await assert.rejects(db().sql`UPDATE conversations SET agent = NULL WHERE id = ${direct.id}`, /chosen at creation and never changes/);
  const plain = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  await assert.rejects(db().sql`UPDATE conversations SET agent = 'coder' WHERE id = ${plain.id}`, /chosen at creation and never changes/);
  // The other columns still change as before.
  await db().sql`UPDATE conversations SET title = 'Rinominata' WHERE id = ${direct.id}`;
});

test('a message the scanner flags is refused at save, before any task or delegation', async () => {
  const direct = await directChat();
  await assert.rejects(postUserMessage(db().sql, direct.id, 'Paga su IT60X0542811101000000123456'), (error: unknown) => error instanceof ChatError && error.code === 'scanner');
  assert.equal((await db().sql`SELECT 1 FROM tasks WHERE conversation_id = ${direct.id}`).length, 0);
});

test('a message goes as it is to the Coder, with no local step, and the task ends with its answer', async () => {
  const direct = await directChat();
  const body = 'Aggiungi una riga al README.';
  const { task, message } = await postUserMessage(db().sql, direct.id, body);
  assert.equal(task.assignee, 'coder');
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([delegation?.step, delegation?.agent, delegation?.brief, delegation?.label, delegation?.repo, delegation?.status], [1, 'coder', body, 'L1', 'site', 'pending']);

  const model = untouched();
  try {
    assert.deepEqual(await drain(task.id, orchestrator(model)), ['answered']);
    assert.equal(model.requests.length, 0);
    const prompt = received().prompt;
    assert.ok(prompt.includes(DIRECT_CHAT_TEXT) && prompt.endsWith(body), prompt);
    const done = await loadTask(db().sql, task.id);
    assert.equal(done?.status, 'done');
    const answers = await db().sql<{ id: string; agent: string | null }[]>`
      SELECT id::text, agent FROM messages WHERE conversation_id = ${direct.id} AND role = 'assistant'`;
    assert.deepEqual(answers.map((row) => row.agent), ['coder']);
    assert.deepEqual(done.evidence, [{ kind: 'message', ref: answers[0]?.id }]);
    // The brief went through the gateway towards claude, the user's message included.
    const [logged] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
    assert.ok((logged?.count ?? 0) > 0);
    assert.ok(message.id !== '');
  } finally {
    restoreRepo();
  }
});

test('one Coder at a time: a second message while the first is at work is refused', async () => {
  const direct = await directChat();
  const { task } = await postUserMessage(db().sql, direct.id, 'Primo.');
  await assert.rejects(postUserMessage(db().sql, direct.id, 'Secondo.'), (error: unknown) => error instanceof ChatError && error.code === 'busy');
  try {
    assert.deepEqual(await drain(task.id, orchestrator(untouched())), ['answered']);
    // Answered: the next message goes.
    const next = await postUserMessage(db().sql, direct.id, 'Secondo.');
    assert.deepEqual(await drain(next.task.id, orchestrator(untouched())), ['answered']);
  } finally {
    restoreRepo();
  }
});

test('the consent on the folder is for the conversation: the Coder\'s own files are covered, another file is asked', async () => {
  const direct = await directChat();
  const edit = orchestrator(untouched(), 'scenario: edit-files\nYou are the Coder.');
  try {
    const first = await postUserMessage(db().sql, direct.id, 'Scrivi una pagina.');
    assert.deepEqual(await drain(first.task.id, edit), ['answered']);
    const [made] = await loadDelegations(db().sql, first.task.id);
    assert.deepEqual(made?.files?.map((item) => item.path), ['README.md', 'docs/hello.md']);

    // The folder is dirty of the Coder's files only: no approval.
    const second = await postUserMessage(db().sql, direct.id, 'Ancora.');
    assert.deepEqual(await drain(second.task.id, orchestrator(untouched())), ['answered']);

    // A file of the user's: asked, naming the dirty files.
    writeFileSync(join(REPO, 'notes.txt'), 'mine\n');
    const third = await postUserMessage(db().sql, direct.id, 'E ora?');
    assert.deepEqual(await drain(third.task.id, orchestrator(untouched())), ['waiting-approval']);
    const waiting = await loadTask(db().sql, third.task.id);
    assert.ok(waiting?.waitingApprovalId !== null && waiting?.waitingApprovalId !== undefined);
    const [approval] = await db().sql<{ kind: string; detail: { files: string[] } }[]>`SELECT kind, detail FROM approvals WHERE id = ${waiting.waitingApprovalId}`;
    assert.equal(approval?.kind, 'workspace');
    assert.ok(approval.detail.files.includes('notes.txt'));
    // While the approval waits, the chat takes no other message.
    await assert.rejects(postUserMessage(db().sql, direct.id, 'Altro.'), (error: unknown) => error instanceof ChatError && error.code === 'busy');
    await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
    assert.deepEqual(await drain(third.task.id, orchestrator(untouched())), ['answered']);

    // Approved once in this conversation: the next message does not ask for notes.txt again.
    const fourth = await postUserMessage(db().sql, direct.id, 'Ultimo.');
    assert.deepEqual(await drain(fourth.task.id, orchestrator(untouched())), ['answered']);
  } finally {
    restoreRepo();
  }
});

test('the consent is for one conversation: another direct chat on the same folder asks again', async () => {
  // Another conversation on the same folder, dirty of a file the first one had approved.
  const direct = await directChat();
  writeFileSync(join(REPO, 'notes.txt'), 'mine\n');
  try {
    const first = await postUserMessage(db().sql, direct.id, 'Con le mie note.');
    assert.deepEqual(await drain(first.task.id, orchestrator(untouched())), ['waiting-approval']);
    const waiting = await loadTask(db().sql, first.task.id);
    assert.ok(waiting?.waitingApprovalId !== null && waiting?.waitingApprovalId !== undefined);
    await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
    assert.deepEqual(await drain(first.task.id, orchestrator(untouched())), ['answered']);

    const other = await directChat();
    const next = await postUserMessage(db().sql, other.id, 'Nuova chat, stessa cartella.');
    assert.deepEqual(await drain(next.task.id, orchestrator(untouched())), ['waiting-approval']);
  } finally {
    restoreRepo();
  }
});

test('a conversation of Arianna keeps the consent per delegation: approved once, asked again at the next task', async () => {
  const delegate: Answer = { action: 'call', tool: 'task.delegate', arguments: { agent: 'coder', reason: 'per il README', brief: 'Add a line to README.md.' } };
  const reply: Answer = { action: 'reply', text: 'Fatto.' };
  const answers = [delegate, reply, delegate];
  const requests: ChatRequest[] = [];
  const model: LocalModel = {
    chat(request) {
      requests.push(request);
      const value = { thought: 'Ragiono.', ...answers[requests.length - 1] };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
  const plain = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  writeFileSync(join(REPO, 'notes.txt'), 'mine\n');
  try {
    const first = await postUserMessage(db().sql, plain.id, 'Primo.');
    assert.deepEqual(await drain(first.task.id, orchestrator(model)), ['continued', 'waiting-approval']);
    const waiting = await loadTask(db().sql, first.task.id);
    assert.ok(waiting?.waitingApprovalId !== null && waiting?.waitingApprovalId !== undefined);
    await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
    assert.deepEqual(await drain(first.task.id, orchestrator(model)), ['continued', 'answered']);
    const second = await postUserMessage(db().sql, plain.id, 'Secondo.');
    assert.deepEqual(await drain(second.task.id, orchestrator(model)), ['continued', 'waiting-approval']);
  } finally {
    restoreRepo();
  }
});

test('a run that fails leaves the task waiting for the user with why, and the local model never runs', async () => {
  const direct = await directChat();
  const model = untouched();
  const { task } = await postUserMessage(db().sql, direct.id, 'Fallisci.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator(model, 'scenario: error\nYou are the Coder.')), ['waiting-user']);
    assert.equal(model.requests.length, 0);
    const waiting = await loadTask(db().sql, task.id);
    assert.equal(waiting?.status, 'waiting_user');
    assert.match(waiting.waitingReason ?? '', /^coder could not answer: /);
    // Waiting without an approval: the next message closes it and goes on (D-109).
    const next = await postUserMessage(db().sql, direct.id, 'Riprova.');
    assert.equal((await loadTask(db().sql, task.id))?.status, 'done');
    assert.deepEqual(await drain(next.task.id, orchestrator(untouched())), ['answered']);
  } finally {
    restoreRepo();
  }
});

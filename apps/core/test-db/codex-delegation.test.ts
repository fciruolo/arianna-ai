// Codex next to Claude (D-140, D-111 tappa C), against the fake binaries of
// @arianna/executors: a step delegated by Arianna runs on codex when the
// router picks it, the Reviewer reads the project without writing, and the
// direct chat resumes a session only on the executor that started it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import { createClaudeExecutor, createCodexExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage, setConversationModel } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { DIRECT_HISTORY_TEXT } from '../src/orchestrator/delegate.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `codex-delegation-${randomUUID()}`);
const REPO = join(HOME, 'repos', 'site');
const FIXTURES = join(ROOT, 'packages', 'executors', 'test', 'fixtures');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const PROJECTS = ['site'];
const THREAD = '01a114e7-94d7-77c2-bb06-60bdefff158e';

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-claude.ts')] }, home: ROOT, killGraceMs: 200 });
const codex = createCodexExecutor({ enabled: ['codex'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-codex.ts')] }, home: ROOT, killGraceMs: 200 });
const loaded = committedAgents(ROOT);

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

function restoreRepo(): void {
  git('checkout', '--quiet', '--', '.');
  git('clean', '--quiet', '-fd');
}

before(() => {
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, 'README.md'), '# Fake site\n');
  // What the fake binaries write is ignored: it is not a change of the user's.
  writeFileSync(join(REPO, '.gitignore'), '.fake-claude.json\n.fake-codex.json\n');
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** Arianna's local model, answering each call with the next scripted answer; none for the direct chat. */
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

function orchestrator(model: LocalModel, executors: ('claude' | 'codex')[], adapters: { claude?: boolean; codex?: boolean } = { claude: true, codex: true }): StepExecutor {
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors, models: defaultCloudModels() },
    projects: PROJECTS.map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1' })),
  });
  return createOrchestrator({
    sql: db().sql,
    agents: new Map<string, LoadedAgent>(loaded),
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings,
    rules: RULES,
    ...(adapters.claude === true ? { claude } : {}),
    ...(adapters.codex === true ? { codex } : {}),
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

/** What the fake codex received, written in the project folder itself. */
function codexGot(): { argv: string[]; prompt: string } {
  return JSON.parse(readFileSync(join(REPO, '.fake-codex.json'), 'utf8')) as { argv: string[]; prompt: string };
}

function claudeGot(): { argv: string[]; prompt: string } {
  return JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { argv: string[]; prompt: string };
}

/** The permission profile passed to codex: the access of the project folder. */
function projectAccess(argv: readonly string[]): string | undefined {
  const table = argv.find((arg) => arg.includes('permissions.arianna.filesystem='));
  return table === undefined ? undefined : new RegExp(`"${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"="(\\w+)"`).exec(table)?.[1];
}

const delegate = (agent: string): Answer => ({ action: 'call', tool: 'task.delegate', arguments: { agent, reason: 'per il passo nel progetto', brief: 'Look at README.md and report.' } });
const REPLY: Answer = { action: 'reply', text: 'Fatto.' };

test('with only Codex on, a step delegated to the Coder runs on codex, through the gateway towards codex (D-140)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Guarda il README.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator(scripted([delegate('coder'), REPLY]), ['codex'])), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.deepEqual([delegation?.status, delegation?.executor, delegation?.model, delegation?.result, delegation?.sessionRef], ['ok', 'codex', 'codex', 'ok', THREAD]);

    const runs = await db().sql<{ step: number; executor: string; locality: string; model: string | null }[]>`
      SELECT step, executor, locality, model FROM runs WHERE task_id = ${task.id} ORDER BY step`;
    assert.deepEqual([...runs].map((run) => [run.step, run.executor, run.locality, run.model]), [
      [1, 'local', 'local', 'local-large'],
      [2, 'codex', 'cloud', 'codex'],
      [3, 'local', 'local', 'local-large'],
    ]);
    const log = await db().sql<{ target: string; decision: string; label: string }[]>`
      SELECT target, decision, label FROM gateway_log WHERE task_id = ${task.id} AND target IN ('claude', 'codex')`;
    assert.deepEqual([...log], [{ target: 'codex', decision: 'allow', label: 'L1' }]);

    // The Coder writes: the project folder is open for writing, its .git read only (D-138).
    const { argv, prompt } = codexGot();
    assert.equal(projectAccess(argv), 'write');
    assert.match(prompt, /^You are the Coder/);
    assert.match(prompt, /Look at README\.md and report\.$/);
    const messages = await db().sql<{ agent: string | null; body: string }[]>`
      SELECT agent, body FROM messages WHERE task_id = ${task.id} AND role = 'assistant' ORDER BY id`;
    assert.deepEqual([...messages].map((row) => [row.agent, row.body]), [['coder', 'ok'], [null, 'Fatto.']]);
  } finally {
    restoreRepo();
  }
});

test('Codex enabled but its adapter refused on this machine: the step stays on Claude (D-140)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Guarda il README.');
  try {
    await setConversationModel(db().sql, conversation.id, 'codex', ['codex']);
    assert.deepEqual(await drain(task.id, orchestrator(scripted([delegate('coder'), REPLY]), ['claude', 'codex'], { claude: true })), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.deepEqual([delegation?.status, delegation?.executor], ['ok', 'claude']);
  } finally {
    restoreRepo();
  }
});

test('the Reviewer runs on Codex first and reads the project without writing (D-140)', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Rivedi le modifiche.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator(scripted([delegate('reviewer'), REPLY]), ['claude', 'codex'])), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.deepEqual([delegation?.agent, delegation?.status, delegation?.executor], ['reviewer', 'ok', 'codex']);
    const [decision] = await db().sql<{ executor: string; model: string }[]>`SELECT executor, model FROM router_decisions WHERE task_id = ${task.id}`;
    assert.deepEqual(decision, { executor: 'codex', model: 'codex' });
    const { argv, prompt } = codexGot();
    assert.equal(projectAccess(argv), 'read');
    assert.match(prompt, /^You are the Reviewer/);
  } finally {
    restoreRepo();
  }
});

const CODER = { name: 'coder', modes: ['work'] as const, project: true };

test('the direct chat on Codex resumes its session; a change to Claude starts one with the latest exchanges (D-140)', async () => {
  const direct = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: CODER });
  await setConversationModel(db().sql, direct.id, 'codex', ['codex', 'sonnet']);
  try {
    const first = await postUserMessage(db().sql, direct.id, 'Primo messaggio.');
    assert.deepEqual(await drain(first.task.id, orchestrator(scripted([]), ['claude', 'codex'])), ['answered']);
    assert.equal(codexGot().argv.includes('resume'), false);
    const [made] = await loadDelegations(db().sql, first.task.id);
    assert.deepEqual([made?.executor, made?.sessionRef], ['codex', THREAD]);

    const second = await postUserMessage(db().sql, direct.id, 'Secondo messaggio.');
    assert.deepEqual(await drain(second.task.id, orchestrator(scripted([]), ['claude', 'codex'])), ['answered']);
    const resumed = codexGot();
    assert.equal(resumed.argv[resumed.argv.indexOf('resume') + 1], THREAD);
    assert.equal(resumed.prompt, 'Secondo messaggio.');

    // To Claude: the session of Codex is not one of Claude; the new start reads the conversation so far.
    await setConversationModel(db().sql, direct.id, 'sonnet', ['codex', 'sonnet']);
    const third = await postUserMessage(db().sql, direct.id, 'Terzo messaggio.');
    assert.deepEqual(await drain(third.task.id, orchestrator(scripted([]), ['claude', 'codex'])), ['answered']);
    const moved = claudeGot();
    assert.equal(moved.argv.includes('--resume'), false);
    assert.ok(moved.prompt.includes(DIRECT_HISTORY_TEXT));
    assert.ok(moved.prompt.includes('[earlier message of the user]\nSecondo messaggio.'));
    assert.ok(moved.prompt.endsWith('Terzo messaggio.'));
    const [last] = await loadDelegations(db().sql, third.task.id);
    assert.equal(last?.executor, 'claude');
    assert.equal((await loadTask(db().sql, third.task.id))?.status, 'done');
  } finally {
    restoreRepo();
  }
});

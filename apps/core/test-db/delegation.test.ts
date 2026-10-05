// A step delegated to the Coder on claude -p (task 1.10, second part, D-055),
// against the fake binary of @arianna/executors: the orchestrator hands over,
// the cloud step runs in a workspace of the conversation's repository, the
// report comes back as the result of the call and is streamed to the chat.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { AGENTS_DIR, loadAgents, type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type CloudConfig, type Project } from '@arianna/config';
import { createClaudeExecutor, LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { Secret } from '@arianna/vault';

import { archiveConversation, createConversation, postUserMessage, setConversationModel } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { activitiesSaved, openReply } from '../src/reply.ts';
import { MAX_QUOTA_RETRIES } from '../src/orchestrator/delegate.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createDelegation, loadDelegations, updateDelegation } from '../src/orchestrator/delegations.ts';
import { listCredits } from '../src/delegation-view.ts';
import { startApiServer } from '../src/server/http.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask, type Task } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `delegation-${randomUUID()}`);
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();

// `[cloud.models]` of the test that runs: the exact names reach `--model` (D-071).
let cloudModels: CloudConfig['models'] = defaultCloudModels();
const claude = createClaudeExecutor({
  enabled: ['claude'],
  command: { file: process.execPath, args: [FAKE] },
  home: ROOT,
  killGraceMs: 200,
  modelName: (model) => cloudModels[model].name,
});
const loaded = loadAgents(join(ROOT, AGENTS_DIR));

/** Git in a test repository, without the user's configuration. */
function gitIn(repo: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

before(() => {
  const repo = join(HOME, 'repos', 'site');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Fake site\n');
  // What the fake binary writes is ignored: it is not a change of the user's.
  writeFileSync(join(repo, '.gitignore'), '.fake-claude.json\n.env\n');
  writeFileSync(join(repo, '.env'), 'TOKEN=fake-ignored-secret-0123456789abcdef\n');
  const git = (...args: string[]) => gitIn(repo, ...args);
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

type Scripted = Answer | LocalModelError;

/** Arianna's local model, answering each call with the next scripted answer. */
function scripted(answers: Scripted[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      if (next instanceof LocalModelError) return Promise.reject(next);
      const value = { thought: 'Ragiono.', ...next };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

interface Setup {
  model: LocalModel;
  /** The Coder's prompt: its first line picks the scenario of the fake binary. */
  coderPrompt?: string;
  /** Names of the approved projects, folders under repos/ of the scratch home; `site` by default. */
  projects?: string[];
  /** Approved projects as they are, for folders elsewhere. */
  extraProjects?: Project[];
  executors?: ('claude' | 'codex')[];
  /** `[cloud.models]`; every alias on by default. */
  models?: CloudConfig['models'];
  withClaude?: boolean;
}

function orchestrator(setup: Setup): StepExecutor {
  const coder = loaded.get('coder');
  assert.ok(coder !== undefined);
  const agents = new Map<string, LoadedAgent>(loaded);
  if (setup.coderPrompt !== undefined) agents.set('coder', { card: coder.card, prompt: setup.coderPrompt });
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: setup.executors ?? ['claude'], models: setup.models ?? defaultCloudModels() },
    projects: [
      ...(setup.projects ?? ['site']).map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1' })),
      ...(setup.extraProjects ?? []),
    ],
  });
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => setup.model,
    settings,
    rules: RULES,
    ...(setup.withClaude === false ? {} : { claude }),
  });
}

/** Runs the queued steps of `taskId` until none is due now, or `max` steps. */
async function drain(taskId: string, executor: StepExecutor, max = 40): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < max; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (job.payload.taskId !== taskId) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  if (max >= 40) throw new Error('drain did not end');
  return results;
}

async function ask(mode: 'work' | 'private', body: string, project?: string, projects: string[] = ['site']) {
  const conversation =
    mode === 'work'
      ? await createConversation(db().sql, { mode, ...(project === undefined ? {} : { project }), projects })
      : await createConversation(db().sql, { mode });
  return { conversation, ...(await postUserMessage(db().sql, conversation.id, body)) };
}

const DELEGATE: Answer = { action: 'call', tool: 'task.delegate', arguments: { agent: 'coder', brief: 'Add a line to README.md saying hello.' } };
const REPLY: Answer = { action: 'reply', text: 'Fatto: il Coder ha aggiunto la riga.' };

/** The task, which must be waiting for an approval. */
async function waitingFor(taskId: string): Promise<Task & { waitingApprovalId: string }> {
  const task = await loadTask(db().sql, taskId);
  assert.ok(task !== undefined && task.status === 'waiting_user' && task.waitingApprovalId !== null);
  return { ...task, waitingApprovalId: task.waitingApprovalId };
}

const REPO = join(HOME, 'repos', 'site');

/** What the fake binary received, written in the project folder itself (D-056). */
function received(): { argv: string[]; prompt: string } {
  return JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { argv: string[]; prompt: string };
}

function gitStatus(): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' });
}

test('a work conversation: the step runs on claude, streams to the chat, and its report comes back to Arianna', async () => {
  const live = await startLiveFeed(db().sql);
  const seen: LiveMessage[] = [];
  const stop = await live.subscribe({ send: (message) => seen.push(message) });
  try {
    const { task } = await ask('work', 'Aggiungi una riga al README.', 'site');
    const model = scripted([DELEGATE, REPLY]);
    assert.deepEqual(await drain(task.id, orchestrator({ model })), ['continued', 'continued', 'answered']);

    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.deepEqual(
      [delegation.step, delegation.status, delegation.executor, delegation.model, delegation.label, delegation.result, delegation.resultLabel, delegation.repo],
      [1, 'ok', 'claude', 'sonnet', 'L1', 'ok', 'L1', 'site'],
    );
    assert.ok(delegation.messageId !== null && delegation.sessionRef !== null);
    // Nothing was copied: the run worked in the folder itself, which is still clean for git.
    assert.equal(delegation.workspaceRun, null);
    assert.equal(gitStatus(), '');

    // The Coder's report is in the chat, marked as its; Arianna's answer closes the task.
    const messages = await db().sql<{ role: string; agent: string | null; body: string; label: string }[]>`
      SELECT role, agent, body, label FROM messages WHERE task_id = ${task.id} ORDER BY id`;
    assert.deepEqual(
      [...messages].map((row) => [row.role, row.agent, row.body, row.label]),
      [
        ['user', null, 'Aggiungi una riga al README.', 'L1'],
        ['assistant', 'coder', 'ok', 'L1'],
        ['assistant', null, 'Fatto: il Coder ha aggiunto la riga.', 'L1'],
      ],
    );
    assert.equal((await loadTask(db().sql, task.id))?.status, 'done');

    // Arianna read the report as the result of her call, and the Coder's message was not read as chat history.
    const last = model.requests[1]?.messages.at(-1)?.content ?? '';
    assert.match(last, /^<tool_result>\ncoder \(claude\/sonnet\) reported:\nok\n<\/tool_result>$/);
    assert.equal(model.requests[1]?.messages.filter((m) => m.content === 'ok').length, 0);

    // The binary got the Coder's prompt and the brief, the model and the tools of the card.
    const { argv, prompt } = received();
    assert.match(prompt, /^You are the Coder/);
    assert.match(prompt, /Add a line to README\.md saying hello\.$/);
    assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');

    // The runs: local, cloud, local; the decision and the brief are logged.
    const runs = await db().sql<{ step: number; executor: string; locality: string; model: string | null; status: string }[]>`
      SELECT step, executor, locality, model, status FROM runs WHERE task_id = ${task.id} ORDER BY step`;
    assert.deepEqual(
      [...runs].map((run) => [run.step, run.executor, run.locality, run.model, run.status]),
      [
        [1, 'local', 'local', 'local-large', 'ok'],
        [2, 'claude', 'cloud', 'sonnet', 'ok'],
        [3, 'local', 'local', 'local-large', 'ok'],
      ],
    );
    const [decision] = await db().sql<{ decision: string; executor: string; model: string; step: number }[]>`
      SELECT decision, executor, model, step FROM router_decisions WHERE task_id = ${task.id}`;
    assert.deepEqual(decision, { decision: 'route', executor: 'claude', model: 'sonnet', step: 2 });
    const log = await db().sql<{ target: string; decision: string; label: string }[]>`
      SELECT target, decision, label FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
    assert.deepEqual([...log], [{ target: 'claude', decision: 'allow', label: 'L1' }]);

    // The chat saw the hand-over, the Coder's text as it came, and the message that settled it.
    const activity = seen.filter((m) => m.type === 'activity' && m.taskId === task.id).map((m) => (m.type === 'activity' ? `${m.kind}:${m.detail}` : ''));
    assert.deepEqual(activity.slice(0, 3), ['thinking:', 'delegate:coder', 'delegate:coder · claude/sonnet']);
    const deltas = seen.filter((m) => m.type === 'delta' && m.taskId === task.id);
    assert.deepEqual(deltas.map((m) => (m.type === 'delta' ? m.text : '')), ['ok']);
  } finally {
    stop();
    await live.close();
  }
});

test('the model chosen for the conversation is the one the step runs on', async () => {
  const { conversation, task } = await ask('work', 'Rinomina una variabile.', 'site');
  await setConversationModel(db().sql, conversation.id, 'opus', ['sonnet', 'opus', 'fable']);
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([DELEGATE, REPLY]) })), ['continued', 'continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.ok(delegation !== undefined);
  assert.equal(delegation.model, 'opus');
  assert.equal(received().argv.includes('opus'), true);
  const [decision] = await db().sql<{ reason: string }[]>`SELECT reason FROM router_decisions WHERE task_id = ${task.id}`;
  assert.match(decision?.reason ?? '', /chosen by the user/);
});

test('a model turned off in [cloud.models] is never run: the router chooses instead of it (D-071)', async () => {
  const { conversation, task } = await ask('work', 'Rinomina una variabile.', 'site');
  await setConversationModel(db().sql, conversation.id, 'opus', ['sonnet', 'opus', 'fable']);
  const models = { ...defaultCloudModels(), opus: { enabled: false } };
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([DELEGATE, REPLY]), models })), ['continued', 'continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.equal(delegation?.model, 'sonnet');
  assert.equal(received().argv.includes('opus'), false);
  const [decision] = await db().sql<{ reason: string }[]>`SELECT reason FROM router_decisions WHERE task_id = ${task.id}`;
  assert.match(decision?.reason ?? '', /preferred opus not installed/);
});

test('the exact name of [cloud.models] goes to --model; the run keeps the alias (D-071)', async () => {
  const { conversation, task } = await ask('work', 'Rinomina una variabile.', 'site');
  await setConversationModel(db().sql, conversation.id, 'opus', ['sonnet', 'opus', 'fable']);
  cloudModels = { ...defaultCloudModels(), opus: { enabled: true, name: 'claude-opus-5-5' } };
  try {
    assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([DELEGATE, REPLY]) })), ['continued', 'continued', 'answered']);
  } finally {
    cloudModels = defaultCloudModels();
  }
  const { argv } = received();
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.equal(delegation?.model, 'opus');
});

test('a private conversation: the brief leaves only after the user approves it from the chat', async () => {
  const { task } = await ask('private', 'Fai aggiungere una riga al README dal Coder.');
  const executor = orchestrator({ model: scripted([DELEGATE, REPLY]) });
  assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
  const waiting = await waitingFor(task.id);
  const [approval] = await db().sql<{ kind: string; detail: { text: string; from: string; to: string } }[]>`
    SELECT kind, detail FROM approvals WHERE id = ${waiting.waitingApprovalId}`;
  assert.deepEqual([approval?.kind, approval?.detail.text, approval?.detail.from, approval?.detail.to], ['declassify', 'Add a line to README.md saying hello.', 'L2', 'L1']);
  // Nothing left before the decision.
  assert.equal((await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`).length, 0);

  await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
  assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([delegation?.status, delegation?.label, delegation?.resultLabel], ['ok', 'L1', 'L1']);
  const [change] = await db().sql<{ from: string; to: string }[]>`
    SELECT from_label AS "from", to_label AS "to" FROM label_changes WHERE approval_id = ${waiting.waitingApprovalId}`;
  assert.deepEqual(change, { from: 'L2', to: 'L1' });
  const log = await db().sql<{ label: string; decision: string }[]>`SELECT label, decision FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.deepEqual([...log], [{ label: 'L1', decision: 'allow' }]);
  // The task stays private: the Coder's report is stored at the task's label.
  const [report] = await db().sql<{ label: string }[]>`SELECT label FROM messages WHERE task_id = ${task.id} AND agent = 'coder'`;
  assert.equal(report?.label, 'L2');
});

test('a refused declassification keeps the brief local, and Arianna hears it', async () => {
  const { task } = await ask('private', 'Fai lavorare il Coder.');
  const model = scripted([DELEGATE, { action: 'reply', text: 'Va bene, resto qui.' }]);
  const executor = orchestrator({ model });
  assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
  const waiting = await waitingFor(task.id);
  await recordDecision(db().sql, waiting.waitingApprovalId, 'rejected', 'web');
  assert.deepEqual(await drain(task.id, executor), ['answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.equal(delegation?.status, 'refused');
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: task\.delegate: the user did not approve sending the brief to the cloud/);
  assert.equal((await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`).length, 0);
  assert.equal((await db().sql`SELECT 1 FROM runs WHERE task_id = ${task.id} AND locality = 'cloud'`).length, 0);
});

test('a quota refusal schedules the same step again, later', async () => {
  const { task } = await ask('work', 'Prova la quota.', 'site');
  const executor = orchestrator({ model: scripted([DELEGATE]), coderPrompt: 'scenario: quota\nYou are the Coder.' });
  assert.deepEqual(await drain(task.id, executor), ['continued', 'continued']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.equal(delegation?.status, 'pending');
  const [job] = await db().sql<{ status: string; later: boolean }[]>`
    SELECT status, run_at > now() + interval '1 minute' AS later FROM jobs WHERE payload ->> 'taskId' = ${task.id} AND status = 'queued'`;
  assert.deepEqual(job, { status: 'queued', later: true });
  const [run] = await db().sql<{ status: string }[]>`SELECT status FROM runs WHERE task_id = ${task.id} AND step = 2`;
  assert.equal(run?.status, 'failed');
  assert.equal((await loadTask(db().sql, task.id))?.status, 'running');
  const events = await db().sql<{ kind: string }[]>`SELECT kind FROM events WHERE task_id = ${task.id} AND kind IN ('executor.quota', 'task.retry') ORDER BY id`;
  assert.deepEqual([...events].map((row) => row.kind), ['executor.quota', 'task.retry']);
});

test('fable chosen by the user waits for the budget approval, then runs', async () => {
  const { conversation, task } = await ask('work', 'Un lavoro difficile.', 'site');
  await setConversationModel(db().sql, conversation.id, 'fable', ['sonnet', 'opus', 'fable']);
  const executor = orchestrator({ model: scripted([DELEGATE, REPLY]) });
  assert.deepEqual(await drain(task.id, executor), ['continued', 'waiting-approval']);
  const waiting = await waitingFor(task.id);
  assert.equal(waiting.waitingReason, 'approval needed: budget');
  const [approval] = await db().sql<{ kind: string; detail: { model: string; step: number } }[]>`
    SELECT kind, detail FROM approvals WHERE id = ${waiting.waitingApprovalId}`;
  assert.deepEqual([approval?.kind, approval?.detail.model, approval?.detail.step], ['budget', 'fable', 1]);
  await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
  assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([delegation?.status, delegation?.model], ['ok', 'fable']);
});

test('without a repository, or without a cloud executor, the call fails as a tool error', async () => {
  const noRepo = await ask('work', 'Senza repository.');
  const model = scripted([DELEGATE, REPLY]);
  assert.deepEqual(await drain(noRepo.task.id, orchestrator({ model, projects: ['site', 'other'] })), ['continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: task\.delegate: no project for the Coder/);
  assert.equal((await loadDelegations(db().sql, noRepo.task.id)).length, 0);

  // No cloud executor: task.delegate is not even offered.
  const offline = await ask('work', 'Senza cloud.', 'site');
  const local = scripted([REPLY]);
  assert.deepEqual(await drain(offline.task.id, orchestrator({ model: local, executors: [] })), ['answered']);
  assert.equal(JSON.stringify(local.requests[0]?.schema?.schema).includes('task.delegate'), false);
});

test('a report stored before a crash is not produced twice: the run is not launched again', async () => {
  const { task } = await ask('work', 'Crash dopo il rapporto.', 'site');
  const executor = orchestrator({ model: scripted([DELEGATE, REPLY]) });
  assert.deepEqual(await drain(task.id, executor, 1), ['continued']);
  // As if the cloud step had stored the report and died before closing the delegation.
  const earlier = await openReply(db().sql, task.id, { agent: 'coder' });
  const saved = await earlier.finish('report from the first attempt', 'L1');
  assert.ok(saved.stored);
  assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([delegation?.status, delegation?.result, delegation?.messageId], ['ok', 'report from the first attempt', saved.message.id]);
  assert.equal(existsSync(join(REPO, '.fake-claude.json')) && readFileSync(join(REPO, '.fake-claude.json'), 'utf8').includes('Crash dopo il rapporto'), false);
  const reports = await db().sql`SELECT 1 FROM messages WHERE task_id = ${task.id} AND agent = 'coder'`;
  assert.equal(reports.length, 1);
});

test('after too many quota refusals the delegation fails, and Arianna reads why', async () => {
  const { task } = await ask('work', 'Quota esaurita a lungo.', 'site');
  const model = scripted([DELEGATE, REPLY]);
  const executor = orchestrator({ model, coderPrompt: 'scenario: quota\nYou are the Coder.' });
  assert.deepEqual(await drain(task.id, executor, 1), ['continued']);
  for (let attempt = 0; attempt < MAX_QUOTA_RETRIES; attempt += 1) {
    await db().sql`
      INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label, status, ended_at)
      VALUES (${task.id}, 2, 'coder', 'claude', 'sonnet', 'cloud', 'L1', 'failed', now())`;
  }
  assert.deepEqual(await drain(task.id, executor), ['answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.equal(delegation?.status, 'failed');
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /5 attempts refused by the executor/);
});

test('uncommitted changes in the folder: the user approves first; the changed files reach Arianna', async () => {
  writeFileSync(join(REPO, 'notes.txt'), 'work in progress\n');
  try {
    const { task } = await ask('work', 'Con modifiche mie.', 'site');
    const model = scripted([DELEGATE, REPLY]);
    const executor = orchestrator({ model, coderPrompt: 'scenario: leak-to-file\nfile: ' + join(REPO, 'README.md') + '\nYou are the Coder.' });
    assert.deepEqual(await drain(task.id, executor), ['continued', 'waiting-approval']);
    const waiting = await waitingFor(task.id);
    assert.equal(waiting.waitingReason, 'approval needed: workspace');
    const [approval] = await db().sql<{ kind: string; action: string; detail: { repo: string; files: string[]; step: number } }[]>`
      SELECT kind, action, detail FROM approvals WHERE id = ${waiting.waitingApprovalId}`;
    assert.deepEqual([approval?.kind, approval?.action, approval?.detail.repo, approval?.detail.files, approval?.detail.step], ['workspace', 'dirty-workspace', 'site', ['notes.txt'], 1]);
    assert.equal((await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`).length, 0);

    await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
    assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.equal(delegation.status, 'ok');
    // The scenario copied README.md to copy.txt: a new file of the Coder's, told apart from the user's notes.txt.
    assert.match(delegation.result ?? '', /Files changed in the project site \(uncommitted, on branch main\): copy\.txt$/);
    assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /copy\.txt/);
  } finally {
    unlinkSync(join(REPO, 'notes.txt'));
    rmSync(join(REPO, 'copy.txt'), { force: true });
  }
});

test('a file the user had already changed and the Coder changes again is listed, with its diff from the last commit (D-117)', async () => {
  writeFileSync(join(REPO, 'README.md'), '# Fake site\nMine.\n');
  try {
    const { task } = await ask('work', 'Ancora sul README.', 'site');
    const executor = orchestrator({ model: scripted([DELEGATE, REPLY]), coderPrompt: 'scenario: edit-files\nYou are the Coder.' });
    assert.deepEqual(await drain(task.id, executor), ['continued', 'waiting-approval']);
    await recordDecision(db().sql, (await waitingFor(task.id)).waitingApprovalId, 'approved', 'web');
    assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.deepEqual(delegation.files, [
      { path: 'README.md', change: 'modified' },
      { path: 'docs/hello.md', change: 'added' },
    ]);
    await withApi(() => [SITE], async (port) => {
      const diff = (await get(port, `/api/delegations/${delegation.id}/diff`)).body.diff as { files: Record<string, unknown>[] };
      // Against the last commit: the user's line and the Coder's.
      assert.deepEqual([diff.files[0]?.added, diff.files[0]?.removed], [2, 0]);
    });
  } finally {
    restoreRepo();
  }
});

test('uncommitted changes refused: the delegation ends and Arianna hears it', async () => {
  writeFileSync(join(REPO, 'notes.txt'), 'work in progress\n');
  try {
    const { task } = await ask('work', 'Rifiuto.', 'site');
    const model = scripted([DELEGATE, { action: 'reply', text: 'Aspetto che tu committi.' }]);
    const executor = orchestrator({ model });
    assert.deepEqual(await drain(task.id, executor), ['continued', 'waiting-approval']);
    const waiting = await waitingFor(task.id);
    await recordDecision(db().sql, waiting.waitingApprovalId, 'rejected', 'web');
    assert.deepEqual(await drain(task.id, executor), ['answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.equal(delegation?.status, 'refused');
    assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /did not want the Coder to work over uncommitted changes/);
    assert.equal((await db().sql`SELECT 1 FROM runs WHERE task_id = ${task.id} AND locality = 'cloud'`).length, 0);
  } finally {
    unlinkSync(join(REPO, 'notes.txt'));
  }
});

test('the consent covers the files it named: a path dirtied after it is asked again', async () => {
  writeFileSync(join(REPO, 'notes.txt'), 'work in progress\n');
  try {
    const { task } = await ask('work', 'Consenso sui file.', 'site');
    const executor = orchestrator({ model: scripted([DELEGATE, REPLY]) });
    assert.deepEqual(await drain(task.id, executor), ['continued', 'waiting-approval']);
    const first = await waitingFor(task.id);
    await recordDecision(db().sql, first.waitingApprovalId, 'approved', 'web');
    // Another file changed between the consent and the run.
    writeFileSync(join(REPO, 'more.txt'), 'also mine\n');
    assert.deepEqual(await drain(task.id, executor), ['waiting-approval']);
    const second = await waitingFor(task.id);
    assert.notEqual(second.waitingApprovalId, first.waitingApprovalId);
    const [approval] = await db().sql<{ detail: { files: string[] } }[]>`SELECT detail FROM approvals WHERE id = ${second.waitingApprovalId}`;
    assert.deepEqual(approval?.detail.files, ['more.txt', 'notes.txt']);
    await recordDecision(db().sql, second.waitingApprovalId, 'approved', 'web');
    assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
  } finally {
    unlinkSync(join(REPO, 'notes.txt'));
    unlinkSync(join(REPO, 'more.txt'));
  }
});

test('a run that rewrites the git configuration of the folder fails the delegation, and no git runs there', async () => {
  const config = readFileSync(join(REPO, '.git', 'config'), 'utf8');
  try {
    const { task } = await ask('work', 'Configurazione git.', 'site');
    const model = scripted([DELEGATE, REPLY]);
    assert.deepEqual(await drain(task.id, orchestrator({ model, coderPrompt: 'scenario: git-config\nYou are the Coder.' })), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.equal(delegation.status, 'failed');
    assert.match(delegation.result ?? '', /changed the git configuration of the project site/);
    assert.equal(existsSync(join(REPO, 'evil-ran')), false);
  } finally {
    writeFileSync(join(REPO, '.git', 'config'), config);
    rmSync(join(REPO, '.gitattributes'), { force: true });
    rmSync(join(REPO, 'evil-ran'), { force: true });
  }
});

test('tool configuration the Coder leaves, ignored by git, reaches Arianna with a warning', async () => {
  const exclude = join(REPO, '.git', 'info', 'exclude');
  const excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  mkdirSync(join(REPO, '.git', 'info'), { recursive: true });
  writeFileSync(exclude, `${excluded}.claude/\n`);
  try {
    const { task } = await ask('work', 'Configurazione strumenti.', 'site');
    const model = scripted([DELEGATE, REPLY]);
    assert.deepEqual(await drain(task.id, orchestrator({ model, coderPrompt: 'scenario: tool-config\nYou are the Coder.' })), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.equal(delegation.status, 'ok');
    const read = model.requests[1]?.messages.at(-1)?.content ?? '';
    assert.match(read, /Tool configuration changed by the Coder in site, .*: \.claude\/settings\.local\.json/);
    // Ignored by git: not among the files changed.
    assert.doesNotMatch(read, /Files changed in the project/);
    assert.equal(existsSync(join(REPO, 'hook-ran')), false);
  } finally {
    writeFileSync(exclude, excluded);
    rmSync(join(REPO, '.claude'), { recursive: true, force: true });
  }
});

test('a tracked secret file blocks the launch; an ignored .env does not', async () => {
  writeFileSync(join(REPO, 'keys.pem'), 'not really a key\n');
  try {
    const { task } = await ask('work', 'Segreto tracciato.', 'site');
    const model = scripted([DELEGATE, REPLY]);
    // The blocked scan closes the delegation and the local step goes on at once.
    assert.deepEqual(await drain(task.id, orchestrator({ model })), ['continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.equal(delegation.status, 'failed');
    assert.match(delegation.result ?? '', /cannot go to the cloud .*secret-file/);
  } finally {
    unlinkSync(join(REPO, 'keys.pem'));
  }
});

test('task_delegations: within the clearance, cloud runs of the same task only, never deleted', async () => {
  const { sql, owner } = db();
  const { task } = await ask('work', 'Vincoli.', 'site');
  await assert.rejects(
    sql`INSERT INTO task_delegations (task_id, step, agent, brief, label) VALUES (${task.id}, 1, 'coder', 'x', 'L2')`,
    /above the clearance/,
  );
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label) VALUES (${task.id}, 1, 'coder', 'x', 'L1') RETURNING id::text`;
  const [localRun] = await sql<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, effective_label) VALUES (${task.id}, 2, 'coder', 'local', 'local', 'L1') RETURNING id::text`;
  await assert.rejects(sql`UPDATE task_delegations SET run_id = ${localRun?.id ?? ''} WHERE id = ${row?.id ?? ''}::bigint`, /not a cloud run/);
  await assert.rejects(sql`UPDATE task_delegations SET brief = 'y' WHERE id = ${row?.id ?? ''}::bigint`, /cannot change/);
  await assert.rejects(sql`UPDATE task_delegations SET status = 'ok' WHERE id = ${row?.id ?? ''}::bigint`, /task_delegations_ended/);
  await assert.rejects(sql`UPDATE task_delegations SET status = 'ok', ended_at = now() WHERE id = ${row?.id ?? ''}::bigint`, /task_delegations_result/);
  await sql`UPDATE task_delegations SET status = 'failed', result = 'error', result_label = 'L1', ended_at = now() WHERE id = ${row?.id ?? ''}::bigint`;
  await assert.rejects(sql`UPDATE task_delegations SET status = 'pending' WHERE id = ${row?.id ?? ''}::bigint`, /has ended/);
  await assert.rejects(sql`DELETE FROM task_delegations`, /permission denied/);
  await assert.rejects(owner`DELETE FROM task_delegations`, /append-only/);
});

test('a project outside ARIANNA_HOME (D-058): the Coder works in the approved folder itself', async () => {
  // A sibling of the scratch home stands for a folder under the user's home.
  const user = `${HOME}-user`;
  const outer = join(user, 'Projects', 'outer');
  mkdirSync(outer, { recursive: true });
  try {
    writeFileSync(join(outer, 'index.html'), '<h1>Fake landing</h1>\n');
    writeFileSync(join(outer, '.gitignore'), '.fake-claude.json\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', outer, ...args], {
        env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    git('init', '--quiet', '--initial-branch=main');
    git('add', '--all');
    git('commit', '--quiet', '--message', 'fixture');
    const extraProjects: Project[] = [{ name: 'outer', path: 'outside', absolute: outer, label: 'L1' }];
    const { task } = await ask('work', 'Fai la landing page.', 'outer', ['site', 'outer']);
    assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([DELEGATE, REPLY]), extraProjects })), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.deepEqual([delegation?.status, delegation?.repo], ['ok', 'outer']);
    // The fake binary wrote its trace in the folder it ran in: the approved one.
    assert.ok(existsSync(join(outer, '.fake-claude.json')));
  } finally {
    rmSync(user, { recursive: true, force: true });
  }
});

test('a project taken off the list: the delegation ends with an error Arianna reads', async () => {
  const { task } = await ask('work', 'Progetto tolto.', 'site');
  const model = scripted([DELEGATE, REPLY]);
  assert.deepEqual(await drain(task.id, orchestrator({ model, projects: [] })), ['continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.ok(delegation !== undefined);
  assert.equal(delegation.status, 'failed');
  assert.match(delegation.result ?? '', /no longer among the projects the user approved/);
});

test('a conversation from before D-058 names repos/site: it reads as the project site', async () => {
  const [row] = await db().sql<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, workspace) VALUES ('work', 'L1', 'repos/site') RETURNING id::text`;
  assert.ok(row !== undefined);
  const { task } = await postUserMessage(db().sql, row.id, 'Conversazione vecchia.');
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([DELEGATE, REPLY]) })), ['continued', 'continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([delegation?.status, delegation?.repo], ['ok', 'site']);
});

// ---------------------------------------------------------------------------
// "Who did what" and "Files changed" (D-082).
// ---------------------------------------------------------------------------

interface HttpReply {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

/** node:http, not fetch (NODE_USE_ENV_PROXY would send loopback requests to a proxy). */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpReply> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(`http://127.0.0.1:${String(port)}${path}`, { method: 'GET', agent: false, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown>, text });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function withApi<T>(projects: () => readonly Project[], body: (port: number) => Promise<T>): Promise<T> {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, approvedProjects: projects });
  try {
    return await body(server.port);
  } finally {
    await server.close();
    await live.close();
  }
}

const SITE: Project = { name: 'site', path: 'repos/site', absolute: REPO, label: 'L1' };

function restoreRepo(): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  execFileSync('git', ['-C', REPO, 'checkout', '--quiet', '--', 'README.md'], { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  rmSync(join(REPO, 'docs'), { recursive: true, force: true });
}

test('the changes of a run reach the chat live as diffs, only inside the project and never stored (D-117)', async () => {
  const live = await startLiveFeed(db().sql);
  const seen: LiveMessage[] = [];
  const stop = await live.subscribe({ send: (message) => seen.push(message) });
  try {
    const { task } = await ask('work', 'Modifiche dal vivo.', 'site');
    const executor = orchestrator({ model: scripted([DELEGATE, REPLY]), coderPrompt: 'scenario: live-edits\nYou are the Coder.' });
    assert.deepEqual(await drain(task.id, executor), ['continued', 'continued', 'answered']);
    const pieces = seen.flatMap((m) => (m.type === 'edit' && m.taskId === task.id ? [m] : []));
    const byEdit = new Map<string, typeof pieces>();
    for (const piece of pieces) byEdit.set(piece.editId, [...(byEdit.get(piece.editId) ?? []), piece]);
    const edits = [...byEdit.values()].map((list) => {
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      const first = sorted[0];
      assert.ok(first !== undefined && sorted.length === first.total);
      return { path: first.path, tool: first.tool, label: first.label, added: first.added, removed: first.removed, text: sorted.map((item) => item.text).join('') };
    });
    // The file outside the project and the hook under .git are not shown at all.
    assert.deepEqual(edits, [
      { path: 'README.md', tool: 'Edit', label: 'L1', added: 1, removed: 0, text: ' # Fake site\n+Hello.' },
      { path: 'docs/new.md', tool: 'Write', label: 'L1', added: 1, removed: 0, text: '+# New' },
    ]);
    assert.ok(!JSON.stringify(seen).includes('outside'));
    assert.ok(!JSON.stringify(seen).includes('echo hook'));
    // Live only: no saved activity line, event or message holds the text of a change.
    await activitiesSaved();
    const [stored] = await db().sql<{ count: number }[]>`
      SELECT ((SELECT count(*) FROM task_activities WHERE task_id = ${task.id} AND detail LIKE '%Hello.%')
        + (SELECT count(*) FROM events WHERE task_id = ${task.id} AND payload::text LIKE '%Hello.%')
        + (SELECT count(*) FROM messages WHERE task_id = ${task.id} AND body LIKE '%Hello.%'))::int AS count`;
    assert.equal(stored?.count, 0);
  } finally {
    stop();
    await live.close();
  }
});

test('the files a run changed are saved with the delegation, credited under the report, and shown read only', async () => {
  try {
    const { task, conversation } = await ask('work', 'Modifica dei file.', 'site');
    const executor = orchestrator({ model: scripted([DELEGATE, REPLY]), coderPrompt: 'scenario: edit-files\nYou are the Coder.' });
    assert.deepEqual(await drain(task.id, executor), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.deepEqual(delegation.files, [
      { path: 'README.md', change: 'modified' },
      { path: 'docs/hello.md', change: 'added' },
    ]);
    assert.match(delegation.result ?? '', /Files changed in the project site \(uncommitted, on branch main\): README\.md, docs\/hello\.md/);
    // Written once.
    await assert.rejects(updateDelegation(db().sql, delegation.id, { files: [] }), /written once/);

    await withApi(() => [SITE], async (port) => {
      const credits = (await get(port, `/api/conversations/${conversation.id}/credits`)).body.credits as Record<string, unknown>[];
      assert.equal(credits.length, 1);
      const [credit] = credits;
      assert.ok(credit !== undefined);
      assert.deepEqual(
        [credit.messageId, credit.delegationId, credit.agent, credit.executor, credit.alias, credit.repo],
        [delegation.messageId, delegation.id, 'coder', 'claude', 'sonnet', 'site'],
      );
      assert.equal(typeof credit.model, 'string');
      assert.equal(typeof credit.durationMs, 'number');
      assert.equal(credit.cost, null);
      assert.deepEqual(credit.files, delegation.files);

      // The list: metadata only, never the brief or the report.
      const listed = await get(port, '/api/delegations?limit=5');
      const rows = listed.body.delegations as Record<string, unknown>[];
      const row = rows.find((item) => item.id === delegation.id);
      assert.ok(row !== undefined);
      assert.deepEqual(
        Object.keys(row).sort(),
        ['agent', 'alias', 'conversationId', 'conversationTitle', 'cost', 'createdAt', 'durationMs', 'executor', 'files', 'id', 'model', 'repo', 'status'],
      );
      assert.deepEqual([row.conversationId, row.status, row.files, row.executor, row.alias], [conversation.id, 'ok', 2, 'claude', 'sonnet']);
      assert.doesNotMatch(listed.text, /Add a line to README/);
      assert.doesNotMatch(listed.text, /Files changed/);

      const preview = await get(port, `/api/delegations/${delegation.id}/files/0`);
      assert.equal(preview.status, 200);
      const file = preview.body.file as Record<string, unknown>;
      assert.deepEqual([file.path, file.change, file.repo], ['README.md', 'modified', 'site']);
      assert.match(String(file.text), /# Fake site\nHello\.\n/);
      assert.equal((await get(port, `/api/delegations/${delegation.id}/files/2`)).status, 404);
      assert.equal((await get(port, `/api/delegations/${delegation.id}/files/x`)).status, 404);
      assert.equal((await get(port, `/api/delegations/0/files/0`)).status, 404);

      // D-117: the diff of each file against the commit the changes were listed against.
      assert.equal(delegation.baseCommit, gitIn(REPO, 'rev-parse', 'HEAD').trim());
      const diffReply = await get(port, `/api/delegations/${delegation.id}/diff`);
      assert.equal(diffReply.status, 200);
      const diff = diffReply.body.diff as { repo: string; baseCommit: string; files: Record<string, unknown>[] };
      assert.deepEqual([diff.repo, diff.baseCommit], ['site', delegation.baseCommit]);
      const [readme, hello] = diff.files;
      assert.deepEqual([readme?.index, readme?.path, readme?.change, readme?.added, readme?.removed], [0, 'README.md', 'modified', 1, 0]);
      assert.deepEqual(readme?.hunks, [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'context', text: '# Fake site' },
            { kind: 'added', text: 'Hello.' },
          ],
        },
      ]);
      assert.deepEqual([hello?.path, hello?.change, hello?.added, hello?.removed], ['docs/hello.md', 'added', 3, 0]);
      assert.equal((await get(port, `/api/delegations/0/diff`)).status, 404);
      assert.equal((await get(port, `/api/delegations/${delegation.id}/diff`, { origin: 'http://evil.example' })).status, 403);
    });
    // The project taken off the list: no preview.
    await withApi(() => [], async (port) => {
      const refused = await get(port, `/api/delegations/${delegation.id}/files/0`);
      assert.equal(refused.status, 403);
      assert.match(String(refused.body.error), /no longer among the approved projects/);
      assert.equal((await get(port, `/api/delegations/${delegation.id}/diff`)).status, 403);
    });
  } finally {
    restoreRepo();
  }
});

/** A delegation of a run on `site` whose files are written as given (the run itself is not needed here). */
async function delegationWith(files: unknown, baseCommit: string | null = null): Promise<string> {
  const { task } = await ask('work', 'File preparati.', 'site');
  const delegation = await createDelegation(db().sql, { taskId: task.id, step: 1, agent: 'coder', brief: 'x', label: 'L1', repo: 'site' });
  const [run] = await db().sql<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label) VALUES (${task.id}, 2, 'coder', 'claude', 'sonnet', 'cloud', 'L1') RETURNING id::text`;
  assert.ok(run !== undefined);
  await updateDelegation(db().sql, delegation.id, { runId: run.id, executor: 'claude', model: 'sonnet' });
  await db().sql`UPDATE task_delegations SET files = ${JSON.stringify(files)}::text::jsonb, base_commit = ${baseCommit} WHERE id = ${delegation.id}::bigint`;
  return delegation.id;
}

test('the diff: deleted and renamed files from the base commit, the others said why (D-117)', async () => {
  const head = gitIn(REPO, 'rev-parse', 'HEAD').trim();
  // The run, as the fake binary would leave it: README renamed and changed, .gitignore deleted, a binary added.
  gitIn(REPO, 'mv', 'README.md', 'INDEX.md');
  writeFileSync(join(REPO, 'INDEX.md'), '# Fake site, renamed\n');
  rmSync(join(REPO, '.gitignore'));
  writeFileSync(join(REPO, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  try {
    const files = [
      { path: '.gitignore', change: 'deleted' },
      { path: 'INDEX.md', change: 'renamed', from: 'README.md' },
      { path: 'bin.dat', change: 'added' },
      { path: 'never.md', change: 'modified' },
    ];
    const id = await delegationWith(files, head);
    // From before D-117: no base commit, only added files have a diff.
    const old = await delegationWith(files);
    await withApi(() => [SITE], async (port) => {
      const diff = (await get(port, `/api/delegations/${id}/diff`)).body.diff as { files: Record<string, unknown>[] };
      const [gone, renamed, binary, never] = diff.files;
      assert.deepEqual([gone?.change, gone?.added, gone?.removed], ['deleted', 0, 2]);
      assert.deepEqual([renamed?.from, renamed?.added, renamed?.removed], ['README.md', 1, 1]);
      assert.deepEqual(
        (renamed?.hunks as { lines: unknown[] }[] | undefined)?.[0]?.lines,
        [
          { kind: 'removed', text: '# Fake site' },
          { kind: 'added', text: '# Fake site, renamed' },
        ],
      );
      assert.deepEqual([binary?.path, binary?.error, binary?.hunks], ['bin.dat', 'binary', undefined]);
      assert.deepEqual([never?.path, never?.error], ['never.md', 'no-base']);
      const before = (await get(port, `/api/delegations/${old}/diff`)).body.diff as { baseCommit: unknown; files: Record<string, unknown>[] };
      assert.equal(before.baseCommit, null);
      assert.deepEqual(
        before.files.map((file) => file.error ?? 'ok'),
        ['no-base', 'no-base', 'binary', 'no-base'],
      );
    });
  } finally {
    gitIn(REPO, 'reset', '--quiet', '--hard', head);
    rmSync(join(REPO, 'bin.dat'), { force: true });
  }
});

test('the diff refuses an old version with a vault value or too large, stops at 100 files, waits for a running Coder and an archived chat (D-117)', async () => {
  const origin = gitIn(REPO, 'rev-parse', 'HEAD').trim();
  const secret = new Secret('vault://test-diff', 'fake-vault-value-diff-0123456789abcdef');
  writeFileSync(join(REPO, 'leak-old.txt'), `token: ${secret.reveal()}\n`);
  writeFileSync(join(REPO, 'big-old.txt'), 'x'.repeat(256 * 1024 + 1));
  gitIn(REPO, 'add', 'leak-old.txt', 'big-old.txt');
  gitIn(REPO, 'commit', '--quiet', '--message', 'old versions');
  const base = gitIn(REPO, 'rev-parse', 'HEAD').trim();
  // The run made both clean and small: only the old side is refused.
  writeFileSync(join(REPO, 'leak-old.txt'), 'token: gone\n');
  writeFileSync(join(REPO, 'big-old.txt'), 'small\n');
  try {
    const id = await delegationWith(
      [
        { path: 'leak-old.txt', change: 'modified' },
        { path: 'big-old.txt', change: 'modified' },
      ],
      base,
    );
    const many = await delegationWith(
      Array.from({ length: 101 }, (_value, index) => ({ path: `many/${String(index)}.md`, change: 'added' })),
      base,
    );
    await withApi(() => [SITE], async (port) => {
      const diff = (await get(port, `/api/delegations/${id}/diff`)).body.diff as { files: Record<string, unknown>[] };
      assert.deepEqual(
        diff.files.map((file) => file.error),
        ['refused', 'too-large'],
      );
      assert.doesNotMatch(JSON.stringify(diff), /fake-vault-value-diff/);
      const listed = (await get(port, `/api/delegations/${many}/diff`)).body.diff as { files: Record<string, unknown>[] };
      assert.equal(listed.files.length, 101);
      assert.equal(listed.files[99]?.error, 'deleted');
      assert.equal(listed.files[100]?.error, 'too-many');

      // A Coder at work on the same project: git is not run there until it ends.
      const { task } = await ask('work', 'Al lavoro.', 'site');
      const running = await createDelegation(db().sql, { taskId: task.id, step: 1, agent: 'coder', brief: 'x', label: 'L1', repo: 'site' });
      await updateDelegation(db().sql, running.id, { status: 'running' });
      const busy = await get(port, `/api/delegations/${id}/diff`);
      assert.equal(busy.status, 409);
      assert.match(String(busy.body.error), /is working on site/);
      await updateDelegation(db().sql, running.id, { status: 'failed', result: 'error', resultLabel: 'L1' });
      assert.equal((await get(port, `/api/delegations/${id}/diff`)).status, 200);
    });
    const [row] = await db().sql<{ conversationId: string }[]>`
      SELECT t.conversation_id::text AS "conversationId" FROM task_delegations d JOIN tasks t ON t.id = d.task_id WHERE d.id = ${id}::bigint`;
    assert.ok(row !== undefined);
    await archiveConversation(db().sql, row.conversationId, true);
    await withApi(() => [SITE], async (port) => {
      assert.equal((await get(port, `/api/delegations/${id}/diff`)).status, 409);
    });
  } finally {
    gitIn(REPO, 'reset', '--quiet', '--hard', origin);
  }
});

test('task_delegations.base_commit: a commit id, written once with the files (migration 0024)', async () => {
  const { sql } = db();
  const commit = 'a'.repeat(40);
  await assert.rejects(delegationWith([], 'HEAD'), /task_delegations_base_commit/);
  await assert.rejects(delegationWith([], 'A'.repeat(40)), /task_delegations_base_commit/);
  const id = await delegationWith([], commit);
  assert.equal((await sql<{ base: string }[]>`SELECT base_commit AS base FROM task_delegations WHERE id = ${id}::bigint`)[0]?.base, commit);
  await assert.rejects(sql`UPDATE task_delegations SET base_commit = ${'b'.repeat(40)} WHERE id = ${id}::bigint`, /written once, with the files/);
  await assert.rejects(sql`UPDATE task_delegations SET base_commit = NULL WHERE id = ${id}::bigint`, /written once, with the files/);
  // Files already written without a commit: it cannot be added afterwards.
  const later = await delegationWith([]);
  await assert.rejects(sql`UPDATE task_delegations SET base_commit = ${commit} WHERE id = ${later}::bigint`, /written once, with the files/);
  // Not without the files, nor on a new row.
  const { task } = await ask('work', 'Commit senza file.', 'site');
  const plain = await createDelegation(sql, { taskId: task.id, step: 1, agent: 'coder', brief: 'x', label: 'L1', repo: 'site' });
  await assert.rejects(sql`UPDATE task_delegations SET base_commit = ${commit} WHERE id = ${plain.id}::bigint`, /written once, with the files/);
  await assert.rejects(
    sql`INSERT INTO task_delegations (task_id, step, agent, brief, label, base_commit) VALUES (${task.id}, 2, 'coder', 'x', 'L1', ${commit})`,
    /not with the delegation/,
  );
});

test('the preview refuses links out of the project, .git, large, binary and deleted files', async () => {
  const outside = join(HOME, 'outside-secret.txt');
  writeFileSync(outside, 'not of the project\n');
  symlinkSync(outside, join(REPO, 'out.md'));
  symlinkSync('README.md', join(REPO, 'in.md'));
  writeFileSync(join(REPO, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
  writeFileSync(join(REPO, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(join(REPO, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe8]));
  try {
    const id = await delegationWith([
      { path: 'out.md', change: 'added' },
      { path: '.git/config', change: 'modified' },
      { path: 'big.txt', change: 'added' },
      { path: 'bin.dat', change: 'added' },
      { path: 'gone.txt', change: 'deleted' },
      { path: 'missing.txt', change: 'added' },
      { path: 'in.md', change: 'added' },
      { path: 'latin1.txt', change: 'added' },
    ]);
    await withApi(() => [SITE], async (port) => {
      const status = async (index: number) => (await get(port, `/api/delegations/${id}/files/${String(index)}`)).status;
      assert.deepEqual(await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(status)), [403, 403, 413, 415, 410, 410, 200, 415]);
      // A project whose folder is reached through a link is not the approved path.
      const linked = join(HOME, 'repos', 'site-link');
      symlinkSync(REPO, linked);
      try {
        const viaLink = await withApi(() => [{ ...SITE, absolute: linked }], (other) => get(other, `/api/delegations/${id}/files/6`));
        assert.equal(viaLink.status, 403);
      } finally {
        unlinkSync(linked);
      }
      // Same-origin only, as every route (D-039).
      assert.equal((await get(port, `/api/delegations/${id}/files/6`, { host: 'evil.example' })).status, 403);
      assert.equal((await get(port, '/api/delegations', { origin: 'http://evil.example' })).status, 403);
      assert.equal((await get(port, `/api/delegations/${id}/files/6`, { origin: 'http://evil.example' })).status, 403);
    });
  } finally {
    for (const name of ['out.md', 'in.md', 'big.txt', 'bin.dat', 'latin1.txt']) rmSync(join(REPO, name), { force: true });
    rmSync(outside, { force: true });
  }
});

test('task_delegations.files: paths and kinds only, written once, by a run on a project (migration 0020)', async () => {
  const { sql } = db();
  for (const bad of [
    [{ path: '../escape.txt', change: 'added' }],
    [{ path: '/etc/hosts', change: 'modified' }],
    [{ path: 'a/../../b', change: 'added' }],
    [{ path: 'a.txt', change: 'copied' }],
    [{ path: 'a.txt', change: 'added', content: 'secret' }],
    [{ path: 'a.txt', change: 'renamed' }],
    [{ path: 'a.txt', change: 'added', from: 'b.txt' }],
    [{ path: 'a\nb', change: 'added' }],
    [{ path: '', change: 'added' }],
    [{ path: 7, change: 'added' }],
    ['a.txt'],
    { path: 'a.txt' },
  ]) {
    await assert.rejects(delegationWith(bad), /task_delegations_files/, JSON.stringify(bad));
  }
  const id = await delegationWith([{ path: 'docs/new.md', change: 'renamed', from: 'docs/old.md' }]);
  await assert.rejects(sql`UPDATE task_delegations SET files = '[]'::jsonb WHERE id = ${id}::bigint`, /written once/);
  const { task } = await ask('work', 'Senza run.', 'site');
  const plain = await createDelegation(sql, { taskId: task.id, step: 1, agent: 'coder', brief: 'x', label: 'L1', repo: 'site' });
  await assert.rejects(sql`UPDATE task_delegations SET files = '[]'::jsonb WHERE id = ${plain.id}::bigint`, /files only for a run on a project/);
  await assert.rejects(
    sql`INSERT INTO task_delegations (task_id, step, agent, brief, label, files) VALUES (${task.id}, 2, 'coder', 'x', 'L1', '[]'::jsonb)`,
    /not with the delegation/,
  );
});

test('Claude answering directly is credited from the run of its message', async () => {
  const { conversation, task } = await ask('work', 'Risposta diretta.', 'site');
  const [run] = await db().sql<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label) VALUES (${task.id}, 1, 'arianna', 'claude', 'opus', 'cloud', 'L1') RETURNING id::text`;
  assert.ok(run !== undefined);
  await db().sql`INSERT INTO events (task_id, run_id, kind, label, payload) VALUES (${task.id}, ${run.id}, 'executor.model', 'L0', ${JSON.stringify({ executor: 'claude', alias: 'opus', model: 'claude-opus-fake-1' })}::text::jsonb)`;
  const reply = await openReply(db().sql, task.id, { runId: run.id, model: 'opus' });
  const saved = await reply.finish('Risposta di Claude.', 'L1');
  assert.ok(saved.stored);
  await db().sql`UPDATE runs SET status = 'ok', ended_at = started_at + interval '2 seconds', cost_estimate = 0.25 WHERE id = ${run.id}`;
  const credits = await listCredits(db().sql, conversation.id);
  assert.deepEqual(credits, [
    { messageId: saved.message.id, delegationId: null, agent: null, executor: 'claude', alias: 'opus', model: 'claude-opus-fake-1', durationMs: 2000, cost: 0.25, repo: null, files: null },
  ]);
});

test('the preview refuses a fifo, .git in any case, a vault value, a project above L1 and an archived conversation', async (t) => {
  const fifo = join(REPO, 'pipe.txt');
  let fifoMade = true;
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    fifoMade = false;
  }
  symlinkSync('.GIT/config', join(REPO, 'upper-git.md'));
  const secret = new Secret('vault://test-preview', 'fake-vault-value-preview-0123456789abcdef');
  writeFileSync(join(REPO, 'leak.txt'), `token: ${secret.reveal()}\n`);
  try {
    const id = await delegationWith([
      { path: 'upper-git.md', change: 'added' },
      { path: '.GIT/config', change: 'modified' },
      { path: 'leak.txt', change: 'added' },
      { path: 'pipe.txt', change: 'added' },
      { path: 'README.md', change: 'modified' },
    ]);
    await withApi(() => [SITE], async (port) => {
      const status = async (index: number) => (await get(port, `/api/delegations/${id}/files/${String(index)}`)).status;
      assert.deepEqual(await Promise.all([0, 1, 2].map(status)), [403, 403, 403]);
      if (fifoMade) assert.equal(await status(3), 403);
      else t.diagnostic('mkfifo is not available: the fifo case is skipped');
      assert.equal(await status(4), 200);
    });
    // A project now above L1 (a configuration written by hand): no preview.
    await withApi(() => [{ ...SITE, label: 'L2' } as unknown as Project], async (port) => {
      assert.equal((await get(port, `/api/delegations/${id}/files/4`)).status, 403);
    });
    // An archived conversation is history: restored first, as for a retry (D-064).
    const [row] = await db().sql<{ conversationId: string }[]>`
      SELECT t.conversation_id::text AS "conversationId" FROM task_delegations d JOIN tasks t ON t.id = d.task_id WHERE d.id = ${id}::bigint`;
    assert.ok(row !== undefined);
    await archiveConversation(db().sql, row.conversationId, true);
    await withApi(() => [SITE], async (port) => {
      const archived = await get(port, `/api/delegations/${id}/files/4`);
      assert.equal(archived.status, 409);
      assert.match(String(archived.body.error), /archived/);
    });
  } finally {
    for (const name of ['pipe.txt', 'upper-git.md', 'leak.txt']) rmSync(join(REPO, name), { force: true });
  }
});

test('a delegation above L1: no preview, and its credit shows neither project nor files', async () => {
  const { sql } = db();
  const { conversation, task } = await ask('private', 'Delega privata.');
  const delegation = await createDelegation(sql, { taskId: task.id, step: 1, agent: 'coder', brief: 'x', label: 'L1', repo: 'site' });
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label) VALUES (${task.id}, 2, 'coder', 'claude', 'sonnet', 'cloud', 'L1') RETURNING id::text`;
  assert.ok(run !== undefined);
  await updateDelegation(sql, delegation.id, { runId: run.id, executor: 'claude', model: 'sonnet', files: [{ path: 'README.md', change: 'modified' }] });
  const [message] = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id, agent) VALUES (${conversation.id}, 'assistant', 'L2', 'rapporto', ${task.id}, 'coder') RETURNING id::text`;
  assert.ok(message !== undefined);
  await updateDelegation(sql, delegation.id, { status: 'failed', result: 'error', resultLabel: 'L2', messageId: message.id });
  const [credit] = await listCredits(sql, conversation.id);
  assert.deepEqual([credit?.delegationId, credit?.repo, credit?.files], [delegation.id, null, null]);
  await withApi(() => [SITE], async (port) => {
    assert.equal((await get(port, `/api/delegations/${delegation.id}/files/0`)).status, 404);
    assert.equal((await get(port, `/api/delegations/${delegation.id}/diff`)).status, 404);
    const rows = (await get(port, '/api/delegations?limit=200')).body.delegations as { id: string }[];
    assert.equal(rows.some((item) => item.id === delegation.id), false);
  });
});

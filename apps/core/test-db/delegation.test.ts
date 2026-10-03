// A step delegated to the Coder on claude -p (task 1.10, second part, D-055),
// against the fake binary of @arianna/executors: the orchestrator hands over,
// the cloud step runs in a workspace of the conversation's repository, the
// report comes back as the result of the call and is streamed to the chat.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { AGENTS_DIR, loadAgents, type Answer, type LoadedAgent } from '@arianna/agents';
import { loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { createClaudeExecutor, LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage, setConversationModel } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { openReply } from '../src/reply.ts';
import { MAX_QUOTA_RETRIES } from '../src/orchestrator/delegate.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
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

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });
const loaded = loadAgents(join(ROOT, AGENTS_DIR));

before(() => {
  const repo = join(HOME, 'repos', 'site');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Fake site\n');
  // What the fake binary writes is ignored: it is not a change of the user's.
  writeFileSync(join(repo, '.gitignore'), '.fake-claude.json\n.env\n');
  writeFileSync(join(repo, '.env'), 'TOKEN=fake-ignored-secret-0123456789abcdef\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
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
  allowlist?: string[];
  executors?: ('claude' | 'codex')[];
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
    cloud: { executors: setup.executors ?? ['claude'], allowlist: setup.allowlist ?? ['repos/site'] },
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

async function ask(mode: 'work' | 'private', body: string, workspace?: string) {
  const conversation =
    mode === 'work'
      ? await createConversation(db().sql, { mode, ...(workspace === undefined ? {} : { workspace }), allowlist: ['repos/site'] })
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
    const { task } = await ask('work', 'Aggiungi una riga al README.', 'repos/site');
    const model = scripted([DELEGATE, REPLY]);
    assert.deepEqual(await drain(task.id, orchestrator({ model })), ['continued', 'continued', 'answered']);

    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.deepEqual(
      [delegation.step, delegation.status, delegation.executor, delegation.model, delegation.label, delegation.result, delegation.resultLabel, delegation.repo],
      [1, 'ok', 'claude', 'sonnet', 'L1', 'ok', 'L1', 'repos/site'],
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
  const { conversation, task } = await ask('work', 'Rinomina una variabile.', 'repos/site');
  await setConversationModel(db().sql, conversation.id, 'opus', ['sonnet', 'opus', 'fable']);
  assert.deepEqual(await drain(task.id, orchestrator({ model: scripted([DELEGATE, REPLY]) })), ['continued', 'continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.ok(delegation !== undefined);
  assert.equal(delegation.model, 'opus');
  assert.equal(received().argv.includes('opus'), true);
  const [decision] = await db().sql<{ reason: string }[]>`SELECT reason FROM router_decisions WHERE task_id = ${task.id}`;
  assert.match(decision?.reason ?? '', /chosen by the user/);
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
  const { task } = await ask('work', 'Prova la quota.', 'repos/site');
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
  const { conversation, task } = await ask('work', 'Un lavoro difficile.', 'repos/site');
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
  assert.deepEqual(await drain(noRepo.task.id, orchestrator({ model, allowlist: ['repos/site', 'repos/other'] })), ['continued', 'answered']);
  assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /error: task\.delegate: no repository for the Coder/);
  assert.equal((await loadDelegations(db().sql, noRepo.task.id)).length, 0);

  // No cloud executor: task.delegate is not even offered.
  const offline = await ask('work', 'Senza cloud.', 'repos/site');
  const local = scripted([REPLY]);
  assert.deepEqual(await drain(offline.task.id, orchestrator({ model: local, executors: [] })), ['answered']);
  assert.equal(JSON.stringify(local.requests[0]?.schema?.schema).includes('task.delegate'), false);
});

test('a report stored before a crash is not produced twice: the run is not launched again', async () => {
  const { task } = await ask('work', 'Crash dopo il rapporto.', 'repos/site');
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
  const { task } = await ask('work', 'Quota esaurita a lungo.', 'repos/site');
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
    const { task } = await ask('work', 'Con modifiche mie.', 'repos/site');
    const model = scripted([DELEGATE, REPLY]);
    const executor = orchestrator({ model, coderPrompt: 'scenario: leak-to-file\nfile: ' + join(REPO, 'README.md') + '\nYou are the Coder.' });
    assert.deepEqual(await drain(task.id, executor), ['continued', 'waiting-approval']);
    const waiting = await waitingFor(task.id);
    assert.equal(waiting.waitingReason, 'approval needed: workspace');
    const [approval] = await db().sql<{ kind: string; action: string; detail: { repo: string; files: string[]; step: number } }[]>`
      SELECT kind, action, detail FROM approvals WHERE id = ${waiting.waitingApprovalId}`;
    assert.deepEqual([approval?.kind, approval?.action, approval?.detail.repo, approval?.detail.files, approval?.detail.step], ['workspace', 'dirty-workspace', 'repos/site', ['notes.txt'], 1]);
    assert.equal((await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`).length, 0);

    await recordDecision(db().sql, waiting.waitingApprovalId, 'approved', 'web');
    assert.deepEqual(await drain(task.id, executor), ['continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.ok(delegation !== undefined);
    assert.equal(delegation.status, 'ok');
    // The scenario copied README.md to copy.txt: a new file of the Coder's, told apart from the user's notes.txt.
    assert.match(delegation.result ?? '', /Files changed in repos\/site \(uncommitted, on branch main\): copy\.txt$/);
    assert.match(model.requests[1]?.messages.at(-1)?.content ?? '', /copy\.txt/);
  } finally {
    unlinkSync(join(REPO, 'notes.txt'));
    rmSync(join(REPO, 'copy.txt'), { force: true });
  }
});

test('uncommitted changes refused: the delegation ends and Arianna hears it', async () => {
  writeFileSync(join(REPO, 'notes.txt'), 'work in progress\n');
  try {
    const { task } = await ask('work', 'Rifiuto.', 'repos/site');
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

test('a tracked secret file blocks the launch; an ignored .env does not', async () => {
  writeFileSync(join(REPO, 'keys.pem'), 'not really a key\n');
  try {
    const { task } = await ask('work', 'Segreto tracciato.', 'repos/site');
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
  const { task } = await ask('work', 'Vincoli.', 'repos/site');
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

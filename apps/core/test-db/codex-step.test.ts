// One step on codex exec (D-140), against the fake binary of @arianna/executors
// that replays a recorded real stream: the same chain as runClaudeStep.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createCodexExecutor, prepareWorkspace, type PreparedWorkspace } from '@arianna/executors';
import { createContext, createLabelRules, type Label } from '@arianna/policy';

import { runCodexStep, type CodexStepResult } from '../src/codex-step.ts';
import { processStepJob, STEP_QUEUE, submitTask, type StepContext, type StepExecutor } from '../src/engine.ts';
import { createJobQueue } from '../src/jobs.ts';
import type { TaskLimits } from '../src/limits.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `codex-step-${randomUUID()}`);
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-codex.ts');
const THREAD = '01a114e7-94d7-77c2-bb06-60bdefff158e';
const RULES = createLabelRules({ folders: [{ path: 'repos', label: 'L1' }], sources: [] });
const OPTIONS = { allowedActions: (): readonly string[] => [], agentLimits: (): TaskLimits => ({ maxSteps: 10, maxMinutes: 10 }) };

const codex = createCodexExecutor({ enabled: ['codex'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });

before(() => {
  const repo = join(HOME, 'repos', 'site');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Fake site\n');
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

async function workspace(): Promise<PreparedWorkspace> {
  const prepared = await prepareWorkspace({ home: HOME, data: join(HOME, 'data'), repo: 'repos/site', runId: randomUUID(), allowlist: ['repos/site'], rules: RULES });
  assert.ok(prepared.path !== undefined);
  return prepared;
}

/** One codex step per task: the answer becomes the evidence. */
function onCodex(text: string, label: Label, seen: CodexStepResult[], prepared: () => Promise<PreparedWorkspace> = workspace, access: 'read' | 'write' = 'read'): StepExecutor {
  return {
    plan: () => ({ agent: 'coder', executor: 'codex', locality: 'cloud', model: 'codex' }),
    async run(ctx) {
      const result = await runCodexStep(db().sql, codex, ctx, {
        context: createContext('L1'),
        brief: [{ text, label, source: `task:${ctx.task.id}` }],
        workspace: await prepared(),
        model: 'codex',
        access,
        summary: 'trivial fake task',
      });
      seen.push(result);
      switch (result.kind) {
        case 'answer':
          return { kind: 'done', evidence: [{ kind: 'codex', session: result.result.sessionRef }], usage: result.usage };
        case 'blocked':
          return { kind: 'wait-user', reason: result.decision.reason };
        case 'quota':
          return { kind: 'wait-user', reason: 'quota', usage: result.usage };
        case 'failed':
          return { kind: 'failed', reason: result.reason, usage: result.usage };
      }
    },
  };
}

async function step(executor: StepExecutor): Promise<string> {
  const job = await createJobQueue(db().sql).claim(STEP_QUEUE, 'test-worker');
  assert.ok(job !== undefined);
  return processStepJob(db().sql, executor, job, 'test-worker', OPTIONS);
}

test('a trivial task runs on codex and is logged: run, session, gateway row towards codex, model event', async () => {
  const task = await submitTask(db().sql, { title: 'Fake trivial task', assignee: 'coder' });
  const seen: CodexStepResult[] = [];
  assert.equal(await step(onCodex('scenario: ok\nReply with exactly: ok', 'L1', seen)), 'to-verify');
  assert.equal(seen[0]?.kind === 'answer' && seen[0].result.text, 'ok');
  const [run] = await db().sql<{ id: string; executor: string; model: string; locality: string; session_ref: string; status: string }[]>`
    SELECT id::text, executor, model, locality, session_ref, status FROM runs WHERE task_id = ${task.id}`;
  assert.deepEqual({ ...run, id: undefined }, { id: undefined, executor: 'codex', model: 'codex', locality: 'cloud', session_ref: THREAD, status: 'ok' });
  const gateway = await db().sql<{ target: string; decision: string; label: string }[]>`
    SELECT target, decision, label::text FROM gateway_log WHERE task_id = ${task.id}`;
  assert.deepEqual([...gateway], [{ target: 'codex', decision: 'allow', label: 'L1' }]);
  const [model] = await db().sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label::text, payload FROM events WHERE task_id = ${task.id} AND kind = 'executor.model'`;
  assert.deepEqual([model?.label, model?.payload], ['L0', { executor: 'codex', alias: 'codex', model: null }]);
});

test('an L2 brief never launches codex: one blocked gateway row, the task waits for the user', async () => {
  const task = await submitTask(db().sql, { title: 'Fake private task', assignee: 'coder' });
  const seen: CodexStepResult[] = [];
  const paths: string[] = [];
  const executor = onCodex('scenario: ok\nfake private text', 'L2', seen, async () => {
    const prepared = await workspace();
    paths.push(prepared.path ?? '');
    return prepared;
  });
  assert.equal(await step(executor), 'waiting-user');
  assert.equal(seen[0]?.kind, 'blocked');
  assert.throws(() => readFileSync(join(paths[0] ?? '', '.fake-codex.json')), 'nothing ran in the workspace');
  const rows = await db().sql<{ target: string; decision: string; rule: string }[]>`SELECT target, decision, rule FROM gateway_log WHERE task_id = ${task.id}`;
  assert.deepEqual([...rows], [{ target: 'codex', decision: 'block', rule: 'cloud-label' }]);
});

test('a quota refusal is an event without a reset time: the router waits an hour', async () => {
  const task = await submitTask(db().sql, { title: 'Fake task over quota', assignee: 'coder' });
  const seen: CodexStepResult[] = [];
  assert.equal(await step(onCodex('scenario: quota\nfake', 'L1', seen)), 'waiting-user');
  assert.equal(seen[0]?.kind, 'quota');
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'executor.quota'`;
  assert.deepEqual(event?.payload, { executor: 'codex', resetsAt: null, overage: false });
});

test('a run that breaks the profile fails, and logs only the kind of error', async () => {
  const task = await submitTask(db().sql, { title: 'Fake task with an MCP call', assignee: 'coder' });
  assert.equal(await step(onCodex('scenario: mcp\nfake', 'L1', [])), 'failed');
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'executor.failed'`;
  assert.deepEqual([event?.payload.executor, event?.payload.error], ['codex', 'profile']);
});

test('options codex would refuse fail the step before the gateway: no allow is logged', async () => {
  const task = await submitTask(db().sql, { title: 'Fake task with a bad access', assignee: 'coder' });
  assert.equal(await step(onCodex('scenario: ok', 'L1', [], workspace, 'everything' as never)), 'failed');
  const rows = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id}`;
  assert.equal(rows.length, 0);
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'executor.failed'`;
  assert.equal(event?.payload.error, 'invalid-options');
});

test('an interrupted run resumes its codex session', async () => {
  const task = await submitTask(db().sql, { title: 'Fake resumed task', assignee: 'coder' });
  const prepared = await workspace();
  await step(onCodex('scenario: ok\nfirst', 'L1', [], () => Promise.resolve(prepared)));
  const [run] = await db().sql<{ id: string }[]>`SELECT id::text FROM runs WHERE task_id = ${task.id}`;
  assert.ok(run !== undefined);
  const ctx: StepContext = {
    task,
    step: 2,
    runId: run.id,
    resume: { runId: run.id, sessionRef: THREAD, executor: 'codex' },
    signal: new AbortController().signal,
    setSessionRef: () => Promise.resolve(),
  };
  const result = await runCodexStep(db().sql, codex, ctx, {
    context: createContext('L1'),
    brief: [{ text: 'scenario: ok\nagain', label: 'L1', source: 'test' }],
    workspace: prepared,
    model: 'codex',
    access: 'read',
  });
  assert.equal(result.kind === 'answer' && result.result.text, 'resumed');
  const argv = (JSON.parse(readFileSync(join(prepared.path ?? '', '.fake-codex.json'), 'utf8')) as { argv: string[] }).argv;
  assert.equal(argv[argv.indexOf('resume') + 1], THREAD);
});

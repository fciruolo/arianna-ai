// A trivial task on claude -p, executed and logged (task 1.5), against the fake
// binary of @arianna/executors that replays a recorded real stream.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createClaudeExecutor, prepareWorkspace, type PreparedWorkspace } from '@arianna/executors';
import { createContext, createLabelRules, type Label } from '@arianna/policy';

import { runClaudeStep, type ClaudeStepResult } from '../src/claude-step.ts';
import { processStepJob, STEP_QUEUE, submitTask, type StepContext, type StepExecutor } from '../src/engine.ts';
import { createJobQueue } from '../src/jobs.ts';
import type { TaskLimits } from '../src/limits.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `claude-step-${randomUUID()}`);
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const SESSION = '00000000-0000-4000-8000-000000000001';
const RULES = createLabelRules({ folders: [{ path: 'repos', label: 'L1' }], sources: [] });
const OPTIONS = { allowedActions: (): readonly string[] => [], agentLimits: (): TaskLimits => ({ maxSteps: 10, maxMinutes: 10 }) };

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });

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

/** One claude step per task: the answer becomes the evidence. */
function onClaude(text: string, label: Label, seen: ClaudeStepResult[], prepared: () => Promise<PreparedWorkspace> = workspace): StepExecutor {
  return {
    plan: () => ({ agent: 'coder', executor: 'claude', locality: 'cloud', model: 'sonnet' }),
    async run(ctx) {
      const result = await runClaudeStep(db().sql, claude, ctx, {
        context: createContext('L1'),
        brief: [{ text, label, source: `task:${ctx.task.id}` }],
        workspace: await prepared(),
        model: 'sonnet',
        tools: ['Read'],
        summary: 'trivial fake task',
      });
      seen.push(result);
      switch (result.kind) {
        case 'answer':
          return { kind: 'done', evidence: [{ kind: 'claude', session: result.result.sessionRef }], usage: result.usage };
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

test('a trivial task runs on claude and is logged: run, session, usage, gateway row, rate limit', async () => {
  const task = await submitTask(db().sql, { title: 'Fake trivial task', assignee: 'coder' });
  const seen: ClaudeStepResult[] = [];
  assert.equal(await step(onClaude('scenario: ok\nReply with exactly: ok', 'L1', seen)), 'to-verify');
  assert.equal(seen[0]?.kind === 'answer' && seen[0].result.text, 'ok');

  const [run] = await db().sql<{ id: string; executor: string; model: string; locality: string; session_ref: string; status: string; steps_used: number; tokens_in: string; tokens_out: string }[]>`
    SELECT id::text, executor, model, locality, session_ref, status, steps_used, tokens_in::text, tokens_out::text FROM runs WHERE task_id = ${task.id}`;
  assert.deepEqual(
    { ...run, id: undefined },
    { id: undefined, executor: 'claude', model: 'sonnet', locality: 'cloud', session_ref: SESSION, status: 'ok', steps_used: 1, tokens_in: '3125', tokens_out: '4' },
  );

  const gateway = await db().sql<{ target: string; decision: string; rule: string; label: string; run_id: string; summary: string }[]>`
    SELECT target, decision, rule, label::text, run_id::text, summary FROM gateway_log WHERE task_id = ${task.id}`;
  assert.deepEqual([...gateway], [{ target: 'claude', decision: 'allow', rule: 'cloud', label: 'L1', run_id: run?.id, summary: 'trivial fake task' }]);

  const [limit] = await db().sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label::text, payload FROM events WHERE task_id = ${task.id} AND kind = 'executor.rate_limit'`;
  assert.equal(limit?.label, 'L0');
  assert.deepEqual(limit.payload, { executor: 'claude', status: 'allowed', window: 'five_hour', resetsAt: '2026-10-02T22:20:00.000Z', utilization: 0.25, overage: false });
});

test('an L2 brief never launches claude: one blocked gateway row, the task waits for the user', async () => {
  const task = await submitTask(db().sql, { title: 'Fake private task', assignee: 'coder' });
  const seen: ClaudeStepResult[] = [];
  const paths: string[] = [];
  const executor = onClaude('scenario: ok\nfake private text', 'L2', seen, async () => {
    const prepared = await workspace();
    paths.push(prepared.path ?? '');
    return prepared;
  });
  assert.equal(await step(executor), 'waiting-user');
  assert.equal(seen[0]?.kind, 'blocked');
  assert.equal(paths.length, 1);
  assert.throws(() => readFileSync(join(paths[0] ?? '', '.fake-claude.json')), 'nothing ran in the workspace');
  const rows = await db().sql<{ decision: string; rule: string }[]>`SELECT decision, rule FROM gateway_log WHERE task_id = ${task.id}`;
  assert.deepEqual([...rows], [{ decision: 'block', rule: 'cloud-label' }]);
});

test('a quota refusal is an event with the time the subscription comes back', async () => {
  const task = await submitTask(db().sql, { title: 'Fake task over quota', assignee: 'coder' });
  const seen: ClaudeStepResult[] = [];
  assert.equal(await step(onClaude('scenario: quota\nfake', 'L1', seen)), 'waiting-user');
  assert.equal(seen[0]?.kind, 'quota');
  const kinds = await db().sql<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM events WHERE task_id = ${task.id} AND kind LIKE 'executor.%' ORDER BY id`;
  assert.deepEqual(
    kinds.map((event) => event.kind),
    ['executor.rate_limit', 'executor.quota'],
  );
  assert.deepEqual(kinds[1]?.payload, { executor: 'claude', resetsAt: '2026-10-02T22:20:00.000Z', overage: false });
});

test('a failed run keeps its usage and logs only the kind of error', async () => {
  const task = await submitTask(db().sql, { title: 'Fake failing task', assignee: 'coder' });
  assert.equal(await step(onClaude('scenario: extra-tool\nfake', 'L1', [])), 'failed');
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'executor.failed'`;
  assert.deepEqual(event?.payload, { executor: 'claude', error: 'profile', violations: ['tools'], exitCode: null, apiStatus: null });
});

test('an interrupted run resumes its claude session', async () => {
  const task = await submitTask(db().sql, { title: 'Fake resumed task', assignee: 'coder' });
  const prepared = await workspace();
  const seen: ClaudeStepResult[] = [];
  await step(onClaude('scenario: ok\nfirst', 'L1', seen, () => Promise.resolve(prepared)));
  const [run] = await db().sql<{ id: string }[]>`SELECT id::text FROM runs WHERE task_id = ${task.id}`;
  assert.ok(run !== undefined);
  const ctx: StepContext = {
    task,
    step: 2,
    runId: run.id,
    resume: { runId: run.id, sessionRef: SESSION },
    signal: new AbortController().signal,
    setSessionRef: () => Promise.resolve(),
  };
  const result = await runClaudeStep(db().sql, claude, ctx, {
    context: createContext('L1'),
    brief: [{ text: 'scenario: ok\nagain', label: 'L1', source: 'test' }],
    workspace: prepared,
    model: 'sonnet',
    tools: ['Read'],
  });
  assert.equal(result.kind === 'answer' && result.result.text, 'resumed');
  const argv = (JSON.parse(readFileSync(join(prepared.path ?? '', '.fake-claude.json'), 'utf8')) as { argv: string[] }).argv;
  assert.deepEqual(argv.slice(-2), ['--resume', SESSION]);
});

test('options claude would refuse fail the step before the gateway: no allow is logged for a run that never starts', async () => {
  const task = await submitTask(db().sql, { title: 'Fake task with a bad tool', assignee: 'coder' });
  const executor: StepExecutor = {
    plan: () => ({ agent: 'coder', executor: 'claude', locality: 'cloud', model: 'sonnet' }),
    async run(ctx) {
      const result = await runClaudeStep(db().sql, claude, ctx, {
        context: createContext('L1'),
        brief: [{ text: 'scenario: ok', label: 'L1', source: 'test' }],
        workspace: await workspace(),
        model: 'sonnet',
        tools: ['WebSearch' as never],
      });
      return result.kind === 'failed' ? { kind: 'failed', reason: result.reason } : { kind: 'done', evidence: [] };
    },
  };
  assert.equal(await step(executor), 'failed');
  const rows = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id}`;
  assert.equal(rows.length, 0);
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'executor.failed'`;
  assert.equal(event?.payload.error, 'invalid-options');
});

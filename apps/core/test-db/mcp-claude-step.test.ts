// The session of Arianna's MCP server around one claude step (D-261), against
// the fake binary: a run stopped by its signal still loses its token and its
// file; a step that continues a session opens a new session of the server,
// and the token of the earlier one is refused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createClaudeExecutor, prepareWorkspace, type PreparedWorkspace } from '@arianna/executors';
import { createContext, createLabelRules } from '@arianna/policy';

import { runClaudeStep, type ClaudeStepMcp } from '../src/claude-step.ts';
import { processStepJob, STEP_QUEUE, submitTask, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import type { TaskLimits } from '../src/limits.ts';
import { createMcpServer, type McpServer } from '../src/mcp/server.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `mcp-claude-step-${randomUUID()}`);
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = createLabelRules({ folders: [{ path: 'repos', label: 'L1' }], sources: [] });
const OPTIONS = { allowedActions: (): readonly string[] => [], agentLimits: (): TaskLimits => ({ maxSteps: 10, maxMinutes: 10 }) };
const CONFIG_DIR = join(HOME, 'data', 'mcp');

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });
let server: McpServer;
let url: string;
const tokens: string[] = [];
const revoked: string[] = [];

before(async () => {
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
  server = createMcpServer({
    kb: { search: () => [], load: () => { throw new Error('no pages'); } } as never,
    skills: { list: () => ({ skills: [] }), text: () => { throw new Error('no skills'); }, assigned: () => [], refusal: () => null },
    gate: () => Promise.reject(new Error('no call expected')),
    event: () => Promise.resolve(),
    version: '0.0.0-test',
  });
  url = (await server.start()).url;
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
});

async function workspace(): Promise<PreparedWorkspace> {
  const prepared = await prepareWorkspace({ home: HOME, data: join(HOME, 'data'), repo: 'repos/site', runId: randomUUID(), allowlist: ['repos/site'], rules: RULES });
  assert.ok(prepared.path !== undefined);
  return prepared;
}

function mcp(): ClaudeStepMcp {
  return {
    server: {
      open(input) {
        const session = server.open(input);
        tokens.push(session.token);
        return session;
      },
      revoke(runId) {
        revoked.push(runId);
        server.revoke(runId);
      },
    },
    url,
    dir: CONFIG_DIR,
    managed: () => false,
    agent: 'coder',
    clearance: 'L1',
    tools: ['kb_search', 'kb_read'],
  };
}

async function status(token: string | undefined): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token ?? ''}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return response.status;
}

/** The step of `taskId`: the jobs of earlier tests' tasks (a retry) are set aside. */
async function step(taskId: string, executor: StepExecutor): Promise<string> {
  const queue = createJobQueue(db().sql);
  for (let guard = 0; guard < 10; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    assert.ok(job !== undefined);
    if (job.payload.taskId === taskId) return processStepJob(db().sql, executor, job, 'test-worker', OPTIONS);
    await completeJob(db().sql, job.id, 'test-worker');
  }
  throw new Error('no job for the task');
}

const configOf = (runId: string): string => join(CONFIG_DIR, `${runId}.mcp.json`);

test('a run stopped by its signal: the token was good while it ran, then revoked, and the file is gone', async () => {
  tokens.length = 0;
  revoked.length = 0;
  const task = await submitTask(db().sql, { title: 'Fake task stopped', assignee: 'coder' });
  let during = 0;
  let fileDuring = false;
  let runId = '';
  let stopped = false;
  const executor: StepExecutor = {
    plan: () => ({ agent: 'coder', executor: 'claude', locality: 'cloud', model: 'sonnet' }),
    async run(ctx) {
      runId = ctx.runId;
      const controller = new AbortController();
      const prepared = await workspace();
      // Stopped once the binary has started: its record of the launch is there.
      const watch = setInterval(() => {
        if (!existsSync(join(prepared.path ?? '', '.fake-claude.json'))) return;
        clearInterval(watch);
        fileDuring = existsSync(configOf(ctx.runId));
        void status(tokens[0]).then((code) => {
          during = code;
          controller.abort();
        });
      }, 20);
      try {
        await runClaudeStep(db().sql, claude, { ...ctx, signal: controller.signal }, {
          context: createContext('L1'),
          brief: [{ text: 'scenario: hang', label: 'L1', source: 'test' }],
          workspace: prepared,
          model: 'sonnet',
          tools: ['Read'],
          mcp: mcp(),
        });
      } catch {
        stopped = true;
      } finally {
        clearInterval(watch);
      }
      return { kind: 'failed', reason: 'stopped' };
    },
  };
  assert.equal(await step(task.id, executor), 'failed');
  assert.ok(stopped);
  assert.equal(during, 200);
  assert.ok(fileDuring);
  assert.deepEqual(revoked, [runId]);
  assert.equal(existsSync(configOf(runId)), false);
  assert.equal(await status(tokens[0]), 401);
});

test('a step that continues a session opens a session of the server of its own: the earlier token is refused', async () => {
  tokens.length = 0;
  revoked.length = 0;
  const task = await submitTask(db().sql, { title: 'Fake task resumed', assignee: 'coder' });
  let runId = '';
  const texts: string[] = [];
  let firstAfter = 0;
  const executor: StepExecutor = {
    plan: () => ({ agent: 'coder', executor: 'claude', locality: 'cloud', model: 'sonnet' }),
    async run(ctx) {
      runId = ctx.runId;
      const prepared = await workspace();
      const input = { context: createContext('L1'), workspace: prepared, model: 'sonnet' as const, tools: ['Read' as const] };
      const first = await runClaudeStep(db().sql, claude, ctx, { ...input, brief: [{ text: 'scenario: ok', label: 'L1', source: 'test' }], mcp: mcp() });
      assert.ok(first.kind === 'answer');
      texts.push(first.result.text);
      firstAfter = await status(tokens[0]);
      const second = await runClaudeStep(db().sql, claude, ctx, { ...input, brief: [{ text: 'scenario: ok', label: 'L1', source: 'test' }], sessionRef: first.result.sessionRef, mcp: mcp() });
      assert.ok(second.kind === 'answer');
      texts.push(second.result.text);
      return { kind: 'done', evidence: [{ kind: 'claude' }] };
    },
  };
  assert.equal(await step(task.id, executor), 'to-verify');
  assert.deepEqual(texts, ['ok', 'resumed']);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.equal(firstAfter, 401);
  assert.deepEqual(revoked, [runId, runId]);
  assert.equal(await status(tokens[1]), 401);
  assert.equal(existsSync(configOf(runId)), false);
});

test('managed settings of Claude Code on this machine: the run goes without the server, revoked nothing, with the reason', async () => {
  tokens.length = 0;
  revoked.length = 0;
  const task = await submitTask(db().sql, { title: 'Fake task managed', assignee: 'coder' });
  const executor: StepExecutor = {
    plan: () => ({ agent: 'coder', executor: 'claude', locality: 'cloud', model: 'sonnet' }),
    async run(ctx) {
      const result = await runClaudeStep(db().sql, claude, ctx, {
        context: createContext('L1'),
        brief: [{ text: 'scenario: ok', label: 'L1', source: 'test' }],
        workspace: await workspace(),
        model: 'sonnet',
        tools: ['Read'],
        mcp: { ...mcp(), managed: () => true },
      });
      assert.ok(result.kind === 'answer');
      return { kind: 'done', evidence: [{ kind: 'claude' }] };
    },
  };
  assert.equal(await step(task.id, executor), 'to-verify');
  assert.deepEqual([tokens.length, revoked.length], [0, 0]);
  const events = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'mcp.unavailable'`;
  assert.deepEqual([...events].map((row) => row.payload), [{ executor: 'claude', reason: 'managed' }]);
});

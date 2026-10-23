// The Designer on a project outside ARIANNA_HOME (D-058, D-228), with the
// database: the project written `~/Sites/<name>` in arianna.toml, a work
// conversation on it, Arianna delegates to the Designer, the user chooses
// Claude (approval `card.executor`, D-159: here the Designer asks every time,
// the folder is the subject; the committed one asks only when Claude cannot
// take the work, D-298, card-plans.test.ts) and the run starts in the folder
// where it is. A folder that git knows but without a first commit is a
// repository like any other; a folder that is not a repository closes the
// delegation with a line the user can act on, never a failed task.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, parseProjects, resolveHome } from '@arianna/config';
import { createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { loadApproval } from '../src/approvals.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask, type Task } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const SCRATCH = join(ROOT, 'data', 'test-tmp', `designer-outside-${randomUUID()}`);
// ARIANNA_HOME and the user's home side by side: the project is under the home, outside ARIANNA_HOME.
const HOME = join(SCRATCH, 'arianna');
const USER_HOME = join(SCRATCH, 'user');
const FIXTURES = join(ROOT, 'packages', 'executors', 'test', 'fixtures');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const BASE = loadConfig();
// The Designer asks before every work (`executor_choice: ask`, D-159): the folder, not the choice, is under test.
const agents = new Map<string, LoadedAgent>(
  [...committedAgents(ROOT)].map(([name, agent]): [string, LoadedAgent] => [name, name === 'designer' ? { ...agent, card: { ...agent.card, executorChoice: 'ask' } } : agent]),
);
const OPTIONS = {
  allowedActions: () => [] as readonly string[],
  agentLimits: (task: Task) => {
    const limits = agents.get(task.assignee)?.card.limits;
    return { maxSteps: limits?.maxSteps ?? 30, maxMinutes: limits?.maxMinutes ?? 20 };
  },
};

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-claude.ts')] }, home: ROOT, killGraceMs: 200 });

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

/** `~/Sites/<name>` as the user creates it for a new site: `git init` and nothing else, or a plain folder. */
function userFolder(name: string, kind: 'fresh-repository' | 'plain'): string {
  const dir = join(USER_HOME, 'Sites', name);
  mkdirSync(dir, { recursive: true });
  if (kind === 'fresh-repository') git(dir, 'init', '--quiet', '--initial-branch=main');
  mkdirSync(join(HOME, 'data'), { recursive: true });
  return dir;
}

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

function orchestrator(model: LocalModel, name: string): StepExecutor {
  // As arianna.toml writes it (D-228): `~/Sites/<name>`, resolved against the user's home.
  const projects = parseProjects([{ name, path: `~/Sites/${name}`, label: 'L1' }], HOME, USER_HOME);
  const settings = () => ({ ...BASE, home: HOME, paths: { data: join(HOME, 'data') }, cloud: { executors: ['claude' as const], models: defaultCloudModels() }, projects });
  return createOrchestrator({ sql: db().sql, agents, kb: createKb({ home: HOME, rules: RULES }), model: () => model, settings, rules: RULES, claude });
}

async function drain(taskIds: readonly string[], executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 30; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (typeof job.payload.taskId !== 'string' || !taskIds.includes(job.payload.taskId)) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

const DELEGATE: Answer = {
  action: 'call',
  tool: 'task.delegate',
  arguments: { agent: 'designer', brief: 'Una landing page per una pasticceria inventata, in un file HTML.', reason: 'Serve la grafica della landing.' },
};

/** The work conversation on the project, Arianna delegates to the Designer: the choice of where it works, still pending. */
async function askedFor(name: string, model: LocalModel & { requests: ChatRequest[] }) {
  const conversation = await createConversation(db().sql, { mode: 'work', project: name, projects: [name] });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Fammi una landing page per una pasticceria inventata.');
  const executor = orchestrator(model, name);
  assert.deepEqual(await drain([task.id], executor), ['waiting-approval']);
  const waiting = await loadTask(db().sql, task.id);
  assert.ok(waiting?.waitingApprovalId != null);
  const approval = await loadApproval(db().sql, waiting.waitingApprovalId);
  assert.ok(approval !== undefined);
  assert.deepEqual([approval.kind, approval.action], ['executor', 'card.executor']);
  return { task, executor, approval };
}

/** The codes of why the task failed, if it did. */
async function errorsOf(taskId: string): Promise<string[]> {
  return (await db().sql<{ code: string }[]>`SELECT code FROM task_errors WHERE task_id = ${taskId}`).map((row) => row.code);
}

test('a folder under the home just made with `git init`, no commit yet: the Designer works there after the choice (D-058)', async () => {
  const dir = userFolder('negozio-finto', 'fresh-repository');
  const model = scripted([DELEGATE, { action: 'reply', text: 'Ecco la landing della pasticceria.' }]);
  const { task, executor, approval } = await askedFor('negozio-finto', model);
  assert.deepEqual(approval.detail.options, ['claude', 'local']);
  await recordDecision(db().sql, approval.id, 'approved', 'web', 'claude');
  const results = await drain([task.id], executor);
  // Before the fix: `git rev-parse --abbrev-ref HEAD` failed in the folder, three attempts and engine.unknown.
  assert.deepEqual(await errorsOf(task.id), []);
  assert.ok(!results.includes('failed'), results.join(', '));
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.deepEqual([delegation?.agent, delegation?.repo, delegation?.status, delegation?.executor], ['designer', 'negozio-finto', 'ok', 'claude']);
  // The fake claude ran in the folder itself, where it is.
  assert.ok(existsSync(join(dir, '.fake-claude.json')));
  assert.equal((await loadTask(db().sql, task.id))?.status, 'done');
});

test('a project folder gone after the choice: the delegation closes with why, Arianna answers, the task does not fail (D-058)', async () => {
  const dir = userFolder('negozio-spostato', 'fresh-repository');
  const model = scripted([DELEGATE, { action: 'reply', text: 'La cartella del progetto non si trova più.' }]);
  const { task, executor, approval } = await askedFor('negozio-spostato', model);
  rmSync(dir, { recursive: true, force: true });
  await recordDecision(db().sql, approval.id, 'approved', 'web', 'claude');
  const results = await drain([task.id], executor);
  assert.ok(!results.includes('failed'), results.join(', '));
  assert.deepEqual(await errorsOf(task.id), []);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.equal(delegation?.status, 'failed');
  assert.match(delegation.result ?? '', /the folder of negozio-spostato cannot be opened: .*does not exist/);
  assert.equal((await loadTask(db().sql, task.id))?.status, 'done');
});

test('a plain folder under the home, not a git repository: Claude is not offered, nothing runs there (D-058, D-145)', async () => {
  const dir = userFolder('negozio-senza-git', 'plain');
  const { approval } = await askedFor('negozio-senza-git', scripted([DELEGATE]));
  // A folder without git is a container whose parts are its git subfolders (D-145): none here, no approved folder for the cloud.
  assert.deepEqual(approval.detail.options, ['local']);
  assert.deepEqual(approval.detail.excluded, [
    { executor: 'claude', reason: 'project' },
    { executor: 'codex', reason: 'project' },
  ]);
  assert.equal(existsSync(join(dir, '.fake-claude.json')), false);
});

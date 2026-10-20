// Arianna's MCP server in a delegation to the Coder on claude -p (D-261, task
// 1.10), against the fake binary of @arianna/executors: a session is opened
// for the run, its token works while the run lasts, and when the step ends
// the token is revoked and the configuration file is gone. Without the
// server the run goes as before, with an event that says so.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { Answer, LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { createClaudeExecutor, type LocalModel } from '@arianna/executors';

import { MCP_UNAVAILABLE_EVENT } from '../src/claude-step.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { appendEvent } from '../src/events.ts';
import { passGateway } from '../src/gateway.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { mcpToolsText } from '../src/mcp/run-tools.ts';
import { createMcpServer, type McpServer } from '../src/mcp/server.ts';
import type { McpSessionInput } from '../src/mcp/tools.ts';
import { userAddressesOf } from '../src/mcp/web-fetch.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `mcp-delegation-${randomUUID()}`);
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n\n[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const REPO = join(HOME, 'repos', 'site');
const CONFIG_DIR = join(HOME, 'data', 'mcp');

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });
const loaded = committedAgents(ROOT);
const kb = createKb({ home: HOME, rules: RULES });

let server: McpServer;
let url: string;
const opened: { input: McpSessionInput; token: string }[] = [];
const revoked: string[] = [];
/** The server as the orchestrator sees it, telling the test what it opened and revoked. */
const watched: Pick<McpServer, 'open' | 'revoke'> = {
  open(input) {
    const session = server.open(input);
    opened.push({ input, token: session.token });
    return session;
  },
  revoke(runId) {
    revoked.push(runId);
    server.revoke(runId);
  },
};

function gitIn(repo: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

before(async () => {
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, 'README.md'), '# Fake site\n');
  writeFileSync(join(REPO, '.gitignore'), '.fake-claude.json\n.fake-claude-mcp.json\n');
  gitIn(REPO, 'init', '--quiet', '--initial-branch=main');
  gitIn(REPO, 'add', '--all');
  gitIn(REPO, 'commit', '--quiet', '--message', 'fixture');
  mkdirSync(join(HOME, 'kb', 'work'), { recursive: true });
  writeFileSync(join(HOME, 'kb', 'work', 'router.md'), '---\ntitle: Router finto\n---\nIl router sceglie l’esecutore in base all’etichetta.\n');
  server = createMcpServer({
    kb,
    skills: { list: () => ({ skills: [] }), text: () => { throw new Error('no skills'); }, assigned: () => [], refusal: () => null },
    gate: (payload, context, executor, meta) => passGateway(db().sql, payload, context, { kind: 'executor', id: executor, locality: 'cloud' }, meta),
    event: async ({ runId, taskId, agent, tool, decision, bytes }) => {
      await appendEvent(db().sql, { kind: 'mcp.call', label: 'L0', runId, taskId, agent, payload: { runId, tool, decision, bytes } });
    },
    version: '0.0.0-test',
  });
  url = (await server.start()).url;
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
});

/** Arianna's local model, answering each call with the next scripted answer. */
function scripted(answers: Answer[]): LocalModel {
  let calls = 0;
  return {
    chat() {
      const next = answers[calls];
      calls += 1;
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = { thought: 'Ragiono.', ...next };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

interface Mcp {
  url: string | undefined;
  /** The server the orchestrator opens sessions on; the watched one by default. */
  server?: Pick<McpServer, 'open' | 'revoke'>;
  dir?: string;
  scenario?: string;
  incognito?: boolean;
  /** The user's message; a fixed question by default. */
  message?: string;
  /** Arianna's delegation; DELEGATE by default. */
  delegation?: Answer;
}

function orchestrator(model: LocalModel, mcp: Mcp): StepExecutor {
  const coder = loaded.get('coder');
  assert.ok(coder !== undefined);
  const agents = new Map<string, LoadedAgent>(loaded);
  // The first line of the prompt picks the scenario of the fake binary.
  agents.set('coder', { card: coder.card, prompt: `scenario: ${mcp.scenario ?? 'arianna-mcp-live'}\nYou are the Coder.` });
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: ['claude' as const], models: defaultCloudModels() },
    projects: [{ name: 'site', path: 'repos/site', absolute: REPO, label: 'L1' as const }],
    projectRules: { projects: {} },
    personas: {},
    // No skills assigned: the Coder's tools are those of its card alone.
    agents: {},
  });
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb,
    model: () => model,
    settings,
    rules: RULES,
    claude,
    mcp: { server: mcp.server ?? watched, url: mcp.url, dir: mcp.dir ?? CONFIG_DIR, managed: () => false },
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

const DELEGATE: Answer = { action: 'call', tool: 'task.delegate', arguments: { agent: 'coder', reason: 'per leggere il router', brief: 'Read how the router works and say it.' } };
const REPLY: Answer = { action: 'reply', text: 'Fatto.' };

async function delegate(setup: Mcp, status = 'ok'): Promise<{ taskId: string; runId: string; argv: string[]; prompt: string; mcp: { status: number; names: string[] } }> {
  rmSync(join(REPO, '.fake-claude-mcp.json'), { force: true });
  writeFileSync(join(REPO, '.fake-claude-mcp.json'), JSON.stringify({ status: 0, names: [] }));
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: ['site'], ...(setup.incognito === true ? { incognito: true } : {}) });
  const { task } = await postUserMessage(db().sql, conversation.id, setup.message ?? 'Come funziona il router?');
  assert.deepEqual(await drain(task.id, orchestrator(scripted([setup.delegation ?? DELEGATE, REPLY]), setup)), ['continued', 'continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.ok(delegation?.runId !== undefined && delegation.runId !== null);
  assert.equal(delegation.status, status);
  const { argv, prompt } = JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { argv: string[]; prompt: string };
  const mcp = JSON.parse(readFileSync(join(REPO, '.fake-claude-mcp.json'), 'utf8')) as { status: number; names: string[] };
  return { taskId: task.id, runId: delegation.runId, argv, prompt, mcp };
}

test('the Coder on claude: a session for the run, its token good while it runs, revoked and the file gone after', async () => {
  opened.length = 0;
  revoked.length = 0;
  const { runId, argv, prompt, mcp } = await delegate({ url });
  // The brief tells the tools of the open session, at its end, and nothing of the skills it does not have.
  assert.ok(prompt.endsWith(mcpToolsText(['kb_search', 'kb_read', 'web_fetch'])));
  assert.ok(!prompt.includes('mcp__arianna__list_skills'));

  // One session for the run, at most L1, with the tools of the card's cloud_tools alone.
  assert.equal(opened.length, 1);
  const [session] = opened;
  assert.ok(session !== undefined);
  assert.deepEqual([session.input.runId, session.input.agent, session.input.executor, session.input.clearance], [runId, 'coder', 'claude', 'L1']);
  assert.deepEqual(session.input.tools, ['kb_search', 'kb_read', 'web_fetch']);
  // No address in the user's message: web_fetch reads only the sites of the list (D-262).
  assert.deepEqual(session.input.userAddresses, []);
  assert.ok(session.input.expiresAt.getTime() > Date.now());

  // While the run lasted, the binary reached the server with its token and saw those tools.
  assert.deepEqual(mcp, { status: 200, names: ['kb_search', 'kb_read', 'web_fetch'] });
  const config = argv[argv.indexOf('--mcp-config') + 1];
  assert.equal(config, join(CONFIG_DIR, `${runId}.mcp.json`));
  assert.ok(!argv.includes('--safe-mode'));
  assert.ok(argv[argv.indexOf('--allowedTools') + 1]?.split(',').includes('mcp__arianna__kb_read'));

  // After it: revoked, the file removed, and the token refused.
  assert.deepEqual(revoked, [runId]);
  assert.equal(existsSync(config), false);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 401);
});

test('without the server the Coder runs as before, with --safe-mode, and an event says why', async () => {
  opened.length = 0;
  revoked.length = 0;
  const { taskId, runId, argv, prompt, mcp } = await delegate({ url: undefined });
  // No session, no line on the tools.
  assert.ok(!prompt.includes('mcp__arianna__'));
  assert.equal(opened.length, 0);
  assert.deepEqual(revoked, []);
  assert.deepEqual(mcp, { status: 0, names: [] });
  assert.ok(!argv.includes('--mcp-config') || !argv[argv.indexOf('--mcp-config') + 1]?.endsWith('.mcp.json'));
  assert.ok(argv.includes('--safe-mode'));
  const events = await db().sql<{ run_id: string; label: string; payload: unknown }[]>`
    SELECT run_id::text, label, payload FROM events WHERE task_id = ${taskId} AND kind = ${MCP_UNAVAILABLE_EVENT}`;
  assert.deepEqual(
    [...events].map((row) => [row.run_id, row.label, row.payload]),
    [[runId, 'L0', { executor: 'claude', reason: 'server' }]],
  );
});

async function unavailable(taskId: string): Promise<unknown[]> {
  const events = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE task_id = ${taskId} AND kind = ${MCP_UNAVAILABLE_EVENT}`;
  return [...events].map((row) => row.payload);
}

test('a run that fails still loses its token and its file', async () => {
  opened.length = 0;
  revoked.length = 0;
  // The binary says the server failed: the adapter stops the run as a profile violation.
  const { runId, argv } = await delegate({ url, scenario: 'arianna-mcp-failed' }, 'failed');
  const [session] = opened;
  assert.ok(session !== undefined);
  assert.deepEqual(revoked, [runId]);
  assert.equal(existsSync(argv[argv.indexOf('--mcp-config') + 1] ?? ''), false);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 401);
});

test('a session the server refuses, or a file that cannot be written: the run goes without, revoked, with the reason', async () => {
  // A server that never started refuses every session.
  const stopped = createMcpServer({
    kb,
    skills: { list: () => ({ skills: [] }), text: () => { throw new Error('no skills'); }, assigned: () => [], refusal: () => null },
    gate: () => Promise.reject(new Error('never called')),
    event: () => Promise.resolve(),
    version: '0.0.0-test',
  });
  const refused = await delegate({ url, server: stopped });
  assert.ok(refused.argv.includes('--safe-mode'));
  assert.ok(!refused.prompt.includes('mcp__arianna__'));
  assert.deepEqual(await unavailable(refused.taskId), [{ executor: 'claude', reason: 'session' }]);

  // The folder of the file is a file: the session opened is revoked at once.
  opened.length = 0;
  revoked.length = 0;
  const blocker = join(HOME, 'data', 'not-a-folder');
  mkdirSync(join(HOME, 'data'), { recursive: true });
  writeFileSync(blocker, '');
  const unwritable = await delegate({ url, dir: blocker });
  assert.ok(unwritable.argv.includes('--safe-mode'));
  assert.ok(!unwritable.prompt.includes('mcp__arianna__'));
  assert.deepEqual(await unavailable(unwritable.taskId), [{ executor: 'claude', reason: 'config' }]);
  assert.equal(opened.length, 1);
  assert.deepEqual(revoked, [unwritable.runId]);
});

test('incognito (D-136): no session of the server, no file, no event, the run as before', async () => {
  opened.length = 0;
  revoked.length = 0;
  const { taskId, argv, prompt, mcp } = await delegate({ url, incognito: true });
  assert.deepEqual([opened.length, revoked.length], [0, 0]);
  assert.deepEqual(mcp, { status: 0, names: [] });
  assert.ok(argv.includes('--safe-mode'));
  assert.ok(!prompt.includes('mcp__arianna__'));
  assert.deepEqual(await unavailable(taskId), []);
});

test('web_fetch (D-262): the session has the addresses of the user\'s message, never those of the brief Arianna\'s model wrote', async () => {
  opened.length = 0;
  revoked.length = 0;
  const delegation: Answer = {
    action: 'call',
    tool: 'task.delegate',
    arguments: { agent: 'coder', reason: 'per leggere la pagina', brief: 'Read https://example.com/docs and https://model.example/invented?d=1 then say it.' },
  };
  const { prompt } = await delegate({ url, message: 'Leggi https://example.com/docs. e dimmi cosa dice', delegation });
  assert.ok(prompt.includes('https://model.example/invented'));
  const [session] = opened;
  assert.deepEqual(session?.input.userAddresses, ['https://example.com/docs']);
});

test('userAddressesOf (D-262): the direct chat\'s message is the request; a message above the clearance does not count', async () => {
  const sql = db().sql;
  const direct = await createConversation(sql, { mode: 'work', project: 'site', projects: ['site'], agent: { name: 'coder', modes: ['work'], project: true } });
  const { message, task } = await postUserMessage(sql, direct.id, 'Correggi come in https://nodejs.org/api/fs.html#fs_fs_readfile e https://example.org/a');
  assert.deepEqual(await userAddressesOf(sql, task.id, 'L1'), ['https://nodejs.org/api/fs.html#fs_fs_readfile', 'https://example.org/a']);
  // Only the user's own messages of the task: an answer of the agent with an address is not the user's.
  await sql`INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${direct.id}, 'assistant', 'L1', 'See https://agent.example/x', ${task.id})`;
  assert.deepEqual(await userAddressesOf(sql, task.id, 'L1'), ['https://nodejs.org/api/fs.html#fs_fs_readfile', 'https://example.org/a']);
  // A run at L0 does not take the addresses of an L1 message.
  const [row] = await sql<{ label: string }[]>`SELECT label::text AS label FROM messages WHERE id = ${message.id}`;
  assert.equal(row?.label, 'L1');
  assert.deepEqual(await userAddressesOf(sql, task.id, 'L0'), []);
});

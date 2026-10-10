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

import { loadAgent, userCard, userPresets, type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import { ClaudeError, createClaudeExecutor, type ChatRequest, type ClaudeErrorKind, type LocalModel } from '@arianna/executors';

import { ChatError, createConversation, loadConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { DIRECT_CHAT_TEXT, DIRECT_LOCAL_TEXT, LOCAL_REPORT_SCHEMA_NAME, DIRECT_HISTORY_CHARS, DIRECT_HISTORY_EXCHANGES, DIRECT_HISTORY_TEXT, localAgentModel, sessionLost } from '../src/orchestrator/delegate.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { startLiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
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

/** A user agent that only answers, on the local model (the template `answer`, D-119). */
function translator(): LoadedAgent {
  const dir = join(HOME, 'cards');
  mkdirSync(dir, { recursive: true });
  const permissions = userPresets().find(({ id }) => id === 'answer')?.permissions;
  const files = userCard({ name: 'traduttore', description: 'Agente traduttore di prova', permissions, prompt: 'Traduci in inglese il testo che ricevi.' });
  writeFileSync(join(dir, 'traduttore.yaml'), files.yaml);
  writeFileSync(join(dir, 'traduttore.md'), files.md);
  return { ...loadAgent(dir, 'traduttore'), origin: 'user' };
}

function orchestrator(model: LocalModel, coderPrompt?: string, translatorReads: 'L1' | 'L2' = 'L1'): StepExecutor {
  const coder = loaded.get('coder');
  assert.ok(coder !== undefined);
  const agents = new Map<string, LoadedAgent>(loaded);
  const local = translator();
  agents.set('traduttore', { ...local, card: { ...local.card, maxLabel: translatorReads } });
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

/** The Coder as direct-chat.ts reads its card: Claude, a work conversation on a project. */
const CODER = { name: 'coder', modes: ['work'] as const, project: true };

function directChat() {
  return createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: CODER });
}

function received(): { prompt: string } {
  return JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { prompt: string };
}

/** Agent and `direct` of the assistant messages of a conversation, as their events say. */
async function answerEvents(conversationId: string): Promise<{ agent: string | null; direct: boolean | null }[]> {
  const rows = await db().sql<{ agent: string | null; direct: boolean | null }[]>`
    SELECT payload ->> 'agent' AS agent, (payload ->> 'direct')::boolean AS direct FROM events
     WHERE kind = 'message.created' AND payload ->> 'conversationId' = ${conversationId} AND payload ->> 'role' = 'assistant'
     ORDER BY id`;
  return rows.map((row) => ({ agent: row.agent, direct: row.direct }));
}

test('a direct chat follows the card: mode and project as it allows, never Arianna (D-111d)', async () => {
  await assert.rejects(createConversation(db().sql, { mode: 'private', agent: CODER }), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(createConversation(db().sql, { mode: 'work', projects: PROJECTS, agent: CODER }), /needs a project/);
  await assert.rejects(createConversation(db().sql, { mode: 'work', agent: { name: 'arianna', modes: ['work'], project: false } }), /not one the user may talk with/);
  // A local agent that may read L2: a private conversation, no project.
  const local = await createConversation(db().sql, { mode: 'private', agent: { name: 'traduttore', modes: ['private', 'work'], project: false } });
  assert.deepEqual([local.agent, local.mode, local.workspace], ['traduttore', 'private', null]);
  await assert.rejects(createConversation(db().sql, { mode: 'private', agent: { name: 'revisore', modes: ['work'], project: false } }), /does not answer a private/);
  // The database keeps an agent id, never Arianna, only in a conversation of the user.
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, agent) VALUES ('private', 'L2', 'arianna')`, /conversations_agent_known/);
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, agent) VALUES ('private', 'L2', 'Bad Name')`, /conversations_agent_known/);
  await assert.rejects(db().sql`INSERT INTO conversations (mode, clearance, agent, origin, system_reason) VALUES ('private', 'L2', 'coder', 'system', 'failure')`, /conversations_agent_user|check constraint/);
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
    // The answer of the direct chat's own agent carries `direct`: it notifies as Arianna's does (D-126).
    assert.deepEqual(await answerEvents(direct.id), [{ agent: 'coder', direct: true }]);
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
    // The Coder's report in Arianna's conversation is not a direct answer: no `direct`, no notice.
    assert.deepEqual((await answerEvents(plain.id)).filter((event) => event.agent === 'coder'), [{ agent: 'coder', direct: null }]);
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

function receivedArgv(): string[] {
  return (JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { argv: string[] }).argv;
}

const FIRST_SESSION = '00000000-0000-4000-8000-000000000001';

test('the next message resumes the session of the latest answer: only the new message leaves (D-111, tappa A2)', async () => {
  const direct = await directChat();
  try {
    const first = await postUserMessage(db().sql, direct.id, 'Primo messaggio.');
    assert.deepEqual(await drain(first.task.id, orchestrator(untouched())), ['answered']);
    assert.equal(receivedArgv().includes('--resume'), false);
    const [made] = await loadDelegations(db().sql, first.task.id);
    assert.equal(made?.sessionRef, FIRST_SESSION);
    // How full the session is, for the indicator: a number of tokens, only on the direct chat.
    assert.equal((await directChat()).contextTokens, null);
    const context = (await loadConversation(db().sql, direct.id))?.contextTokens;
    assert.ok(typeof context === 'number' && context > 0 && context === made.contextTokens, String(context));

    const second = await postUserMessage(db().sql, direct.id, 'Secondo messaggio.');
    assert.deepEqual(await drain(second.task.id, orchestrator(untouched())), ['answered']);
    const argv = receivedArgv();
    assert.equal(argv[argv.indexOf('--resume') + 1], FIRST_SESSION);
    // The prompt and the fixed text are already in the session: they do not leave again.
    assert.equal(received().prompt, 'Secondo messaggio.');
    const [resumed] = await loadDelegations(db().sql, second.task.id);
    assert.deepEqual([resumed?.status, resumed?.sessionRef], ['ok', FIRST_SESSION]);
  } finally {
    restoreRepo();
  }
});

test('another direct chat on the same project starts its own session', async () => {
  const direct = await directChat();
  const other = await directChat();
  try {
    const first = await postUserMessage(db().sql, direct.id, 'Nella prima.');
    assert.deepEqual(await drain(first.task.id, orchestrator(untouched())), ['answered']);
    // Another conversation on the same project starts its own session.
    const elsewhere = await postUserMessage(db().sql, other.id, 'Nella seconda.');
    assert.deepEqual(await drain(elsewhere.task.id, orchestrator(untouched())), ['answered']);
    assert.equal(receivedArgv().includes('--resume'), false);
    assert.ok(received().prompt.includes(DIRECT_CHAT_TEXT));
  } finally {
    restoreRepo();
  }
});

for (const scenario of ['no-session', 'new-session', 'before-init']) {
  test(`a session that cannot be resumed (${scenario}): one new start with the latest exchanges, the failed ones left out`, async () => {
    const direct = await directChat();
    try {
      // A first message that fails: it never got an answer and is not sent again.
      const failed = await postUserMessage(db().sql, direct.id, 'Messaggio fallito.');
      assert.deepEqual(await drain(failed.task.id, orchestrator(untouched(), 'scenario: error\nYou are the Coder.')), ['waiting-user']);
      const first = await postUserMessage(db().sql, direct.id, 'Primo messaggio.');
      assert.deepEqual(await drain(first.task.id, orchestrator(untouched())), ['answered']);

      const body = `scenario: ${scenario}\nSecondo messaggio.`;
      const second = await postUserMessage(db().sql, direct.id, body);
      assert.deepEqual(await drain(second.task.id, orchestrator(untouched())), ['answered']);
      assert.equal(receivedArgv().includes('--resume'), false);
      const prompt = received().prompt;
      assert.ok(prompt.includes(DIRECT_CHAT_TEXT) && prompt.includes(DIRECT_HISTORY_TEXT), prompt);
      assert.ok(prompt.includes('Primo messaggio.') && prompt.includes('[your earlier answer]\nok'), prompt);
      assert.equal(prompt.includes('Messaggio fallito.'), false);
      assert.ok(prompt.endsWith(body), prompt);
      // Both attempts went through the gateway.
      const [logged] = await db().sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM gateway_log WHERE task_id = ${second.task.id} AND target = 'claude' AND decision = 'allow'`;
      assert.equal(logged?.count, 2);
    } finally {
      restoreRepo();
    }
  });
}

test('the fallback history keeps the newest exchanges within the cap of characters', async () => {
  const direct = await directChat();
  try {
    const long = 'x'.repeat(DIRECT_HISTORY_CHARS - 20);
    for (const body of [`Vecchio ${long}`, 'Recente.']) {
      const { task } = await postUserMessage(db().sql, direct.id, body);
      assert.deepEqual(await drain(task.id, orchestrator(untouched())), ['answered']);
    }
    const last = await postUserMessage(db().sql, direct.id, 'scenario: no-session\nUltimo.');
    assert.deepEqual(await drain(last.task.id, orchestrator(untouched())), ['answered']);
    const prompt = received().prompt;
    assert.ok(prompt.includes('Recente.'), prompt);
    assert.equal(prompt.includes('Vecchio'), false);
  } finally {
    restoreRepo();
  }
});

test('sessionLost: only a resume that ended before its first message, or on another session', () => {
  const lost = (kind: ClaudeErrorKind, details: { sessionRef?: string; violations?: string[] } = {}) => sessionLost(new ClaudeError(kind, kind, details));
  assert.equal(lost('exit'), true);
  assert.equal(lost('bad-output'), true);
  assert.equal(lost('execution'), false);
  assert.equal(lost('profile', { sessionRef: FIRST_SESSION, violations: ['session'] }), true);
  // Another session and a broken profile: never started again.
  assert.equal(lost('profile', { sessionRef: FIRST_SESSION, violations: ['session', 'tools'] }), false);
  assert.equal(lost('exit', { sessionRef: FIRST_SESSION }), false);
  assert.equal(lost('profile', { violations: ['tools'] }), false);
  assert.equal(lost('quota'), false);
  assert.equal(lost('timeout'), false);
  assert.equal(lost('cancelled'), false);
});

test('a resume that fails after its start does not fall back: the task waits for the user, one brief out', async () => {
  const direct = await directChat();
  try {
    const first = await postUserMessage(db().sql, direct.id, 'Primo messaggio.');
    assert.deepEqual(await drain(first.task.id, orchestrator(untouched())), ['answered']);
    const second = await postUserMessage(db().sql, direct.id, 'scenario: error\nSecondo.');
    assert.deepEqual(await drain(second.task.id, orchestrator(untouched())), ['waiting-user']);
    const argv = receivedArgv();
    assert.equal(argv[argv.indexOf('--resume') + 1], FIRST_SESSION);
    const [logged] = await db().sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM gateway_log WHERE task_id = ${second.task.id} AND target = 'claude' AND decision = 'allow'`;
    assert.equal(logged?.count, 1);
  } finally {
    restoreRepo();
  }
});

test('the fallback history: at most the latest exchanges, never those of another direct chat', async () => {
  const direct = await directChat();
  const other = await directChat();
  try {
    const elsewhere = await postUserMessage(db().sql, other.id, 'Messaggio altrove.');
    assert.deepEqual(await drain(elsewhere.task.id, orchestrator(untouched())), ['answered']);
    for (let index = 0; index <= DIRECT_HISTORY_EXCHANGES; index += 1) {
      const { task } = await postUserMessage(db().sql, direct.id, `Scambio numero ${String(index)}.`);
      assert.deepEqual(await drain(task.id, orchestrator(untouched())), ['answered']);
    }
    const last = await postUserMessage(db().sql, direct.id, 'scenario: no-session\nUltimo.');
    assert.deepEqual(await drain(last.task.id, orchestrator(untouched())), ['answered']);
    const prompt = received().prompt;
    assert.equal(prompt.includes('Scambio numero 0.'), false);
    assert.ok(prompt.includes('Scambio numero 1.') && prompt.includes(`Scambio numero ${String(DIRECT_HISTORY_EXCHANGES)}.`), prompt);
    assert.equal(prompt.includes('Messaggio altrove.'), false);
  } finally {
    restoreRepo();
  }
});

test('a latest exchange above the cap alone is cut, not left out', async () => {
  const direct = await directChat();
  try {
    const { task } = await postUserMessage(db().sql, direct.id, `Inizio ${'y'.repeat(DIRECT_HISTORY_CHARS)}`);
    assert.deepEqual(await drain(task.id, orchestrator(untouched())), ['answered']);
    const last = await postUserMessage(db().sql, direct.id, 'scenario: no-session\nUltimo.');
    assert.deepEqual(await drain(last.task.id, orchestrator(untouched())), ['answered']);
    const prompt = received().prompt;
    assert.ok(prompt.includes('[earlier message of the user]\nInizio') && prompt.includes('[…]'), prompt.slice(0, 200));
    assert.ok(prompt.length < DIRECT_HISTORY_CHARS + 6000, String(prompt.length));
  } finally {
    restoreRepo();
  }
});

/** The local model answering as the translator: each report in turn, every request kept. */
function reporting(reports: string[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const report = reports[requests.length - 1];
      if (report === undefined || request.schema?.name !== LOCAL_REPORT_SCHEMA_NAME) return Promise.reject(new Error('not an answer of the agent'));
      const value = { report };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

test('a direct chat with a local agent (D-111d): no project, its answer closes the task, the next message reads the earlier turns', async () => {
  const direct = await createConversation(db().sql, { mode: 'work', agent: { name: 'traduttore', modes: ['work'], project: false } });
  const model = reporting(['Good morning.', 'Good night.']);
  const first = await postUserMessage(db().sql, direct.id, 'Buongiorno.');
  assert.deepEqual(await drain(first.task.id, orchestrator(model)), ['answered']);
  const second = await postUserMessage(db().sql, direct.id, 'Buonanotte.');
  assert.deepEqual(await drain(second.task.id, orchestrator(model)), ['answered']);
  const answers = await db().sql<{ agent: string | null; body: string }[]>`
    SELECT agent, body FROM messages WHERE conversation_id = ${direct.id} AND role = 'assistant' ORDER BY id`;
  assert.deepEqual(answers.map((row) => [row.agent, row.body]), [['traduttore', 'Good morning.'], ['traduttore', 'Good night.']]);
  const [, later] = model.requests;
  assert.ok(later !== undefined);
  assert.match(String(later.messages[0]?.content), new RegExp(DIRECT_LOCAL_TEXT.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(later.messages.slice(1).map((message) => [message.role, message.content]), [
    ['user', 'Buongiorno.'],
    ['assistant', 'Good morning.'],
    ['user', 'Buonanotte.'],
  ]);
});

test('a private direct chat with a local agent that may read Privato: the brief and the answer stay L2, nothing to Claude', async () => {
  const direct = await createConversation(db().sql, { mode: 'private', agent: { name: 'traduttore', modes: ['private', 'work'], project: false } });
  const model = reporting(['Good morning, privately.']);
  const { task } = await postUserMessage(db().sql, direct.id, 'Buongiorno, in privato.');
  assert.deepEqual(await drain(task.id, orchestrator(model, undefined, 'L2')), ['answered']);
  const [answer] = await db().sql<{ label: string }[]>`SELECT label FROM messages WHERE conversation_id = ${direct.id} AND role = 'assistant'`;
  assert.equal(answer?.label, 'L2');
  const cloud = await db().sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.equal(cloud.length, 0);
  // The same card lowered to Interno: a private message is above what it may read, nothing reaches the local model.
  const lowered = reporting(['mai']);
  const next = await postUserMessage(db().sql, direct.id, 'Ancora.');
  await drain(next.task.id, orchestrator(lowered, undefined, 'L1'));
  assert.equal(lowered.requests.length, 0);
});

test('the routes (D-111d): the list of who answers, and a conversation only with an agent and a mode it allows', async () => {
  const live = await startLiveFeed(db().sql);
  const agents = [{ agent: 'traduttore', description: 'Traduce', cloud: false, executors: [], modes: ['work' as const], project: false }];
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, directAgents: () => agents, projects: () => [] });
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${String(server.port)}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const listed = await fetch(`http://127.0.0.1:${String(server.port)}/api/direct-agents`);
    assert.deepEqual(await listed.json(), { agents });
    const made = await post({ mode: 'work', agent: 'traduttore' });
    assert.equal(made.status, 201);
    assert.equal(((await made.json()) as { conversation: { agent: string } }).conversation.agent, 'traduttore');
    // An agent not in the list, Arianna, or a mode its card does not allow: refused, whatever the page sends.
    assert.equal((await post({ mode: 'work', agent: 'coder' })).status, 400);
    assert.equal((await post({ mode: 'work', agent: 'arianna' })).status, 400);
    assert.equal((await post({ mode: 'private', agent: 'traduttore' })).status, 400);
  } finally {
    await server.close();
    await live.close();
  }
});

test('a call of a direct chat (D-158): a local agent answers on the local model the router gives it; a cloud one, or no local model, has none', async () => {
  const settings = () => ({ ...BASE, home: HOME, paths: { data: join(HOME, 'data') }, cloud: { executors: ['claude' as const], models: defaultCloudModels() } });
  const local = translator();
  const env = { sql: db().sql, settings, claude, model: () => untouched() };
  const model = await localAgentModel(env, { ...local.card, maxLabel: 'L2' }, 'L2', 'L2');
  assert.ok(typeof model === 'string' && model.startsWith('local-'), `a local model, not ${String(model)}`);
  // Above what its card reads, the router keeps it from answering.
  assert.equal(await localAgentModel(env, { ...local.card, maxLabel: 'L1' }, 'L2', 'L2'), undefined);
  const coder = loaded.get('coder');
  assert.ok(coder !== undefined);
  assert.equal(await localAgentModel(env, coder.card, 'L1', 'L1'), undefined);
  assert.equal(await localAgentModel({ sql: db().sql, settings, claude }, local.card, 'L1', 'L1'), undefined);
});

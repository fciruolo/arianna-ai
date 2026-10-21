// The chat with a person of the series on Claude (D-225, tappa B), against the
// fake binary of @arianna/executors: the plain chat with Claude with
// conversations.series_character (migration 0070), its short prompt and the
// block of the character in a new start, the real lines after every message
// (also when the session resumes), and the names of its series that are no
// person for the second scanner in its briefs only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { conversationWorkspacePath, createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';
import { piiReport } from '@arianna/policy';

import { ChatError, createConversation, loadConversation, postUserMessage, type Conversation } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { configurePiiGuard, type PiiGuard } from '../src/pii-guard.ts';
import { configureSeriesLines } from '../src/prompt-tail.ts';
import { startApiServer } from '../src/server/http.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `character-chat-${randomUUID()}`);
const DATA = join(HOME, 'data');
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 8, maxMinutes: 10 }) };
const BASE = loadConfig();

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, home: ROOT, killGraceMs: 200 });
const agents = committedAgents(ROOT);

/** A second scanner that takes these names for a person wherever they are, unless the fragment says they are none. */
const PEOPLE = ['Turk', 'Pam', 'Carla Bianchi'];
function namesGuard(): PiiGuard & { asked: (readonly (readonly string[] | undefined)[])[] } {
  const asked: (readonly (readonly string[] | undefined)[])[] = [];
  return {
    asked,
    state: 'ready', warm: () => Promise.resolve(true),
    scan: (texts, fragmentNames = []) => {
      asked.push(fragmentNames);
      const entities = texts.map((text) =>
        PEOPLE.flatMap((name) => [...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].map((match) => ({ kind: 'FULLNAME', start: match.index, end: match.index + name.length, score: 0.99 }))),
      );
      return Promise.resolve(piiReport(texts, entities, [], fragmentNames));
    },
    stop: () => Promise.resolve(),
  };
}

/** The archive of real lines (D-224): a different line at each draw, so a test sees which one left. */
let drawn = 0;
configureSeriesLines({
  has: (character) => character === 'jd',
  draw: () => {
    drawn += 1;
    return [`Battuta numero ${String(drawn)}.`];
  },
});
configurePiiGuard(namesGuard());

after(() => {
  configureSeriesLines(undefined);
  configurePiiGuard({ state: 'ready', warm: () => Promise.resolve(true), scan: (texts) => Promise.resolve(piiReport(texts, texts.map(() => []))), stop: () => Promise.resolve() });
  rmSync(HOME, { recursive: true, force: true });
});

function untouched(): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      return Promise.reject(new Error('the local model never answers here'));
    },
  };
}

function orchestrator(model: LocalModel, executors: 'claude'[] = ['claude']): StepExecutor {
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...BASE, home: HOME, paths: { data: DATA }, cloud: { executors, models: defaultCloudModels() }, projects: [], series: {} }),
    rules: RULES,
    claude,
    // The first line picks the scenario of the fake binary.
    chatPrompt: 'scenario: ok',
    characterChatPrompt: 'scenario: ok\nROLE-PLAY PROMPT',
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

const CLAUDE = { name: 'claude', modes: ['work'] as const, project: false };

function characterChat(character = 'jd'): Promise<Conversation> {
  return createConversation(db().sql, { mode: 'work', agent: { ...CLAUDE, modes: ['work'] }, seriesCharacter: character });
}

function lastLaunch(conversationId: string): { argv: string[]; prompt: string } {
  return JSON.parse(readFileSync(join(conversationWorkspacePath({ data: DATA, conversationId }), '.fake-claude.json'), 'utf8')) as { argv: string[]; prompt: string };
}

test('a character only in the plain chat with Claude, chosen at creation and never changed, in the core and in the database (migration 0070)', async () => {
  const { sql, owner } = db();
  const invalid = (error: unknown) => error instanceof ChatError && error.code === 'invalid';
  await assert.rejects(createConversation(sql, { mode: 'work', seriesCharacter: 'jd' }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'private', agent: { name: 'local-chat', modes: ['private'], project: false }, seriesCharacter: 'jd' }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'work', agent: { name: 'codex', modes: ['work'], project: false }, seriesCharacter: 'jd' }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'work', agent: { ...CLAUDE, modes: ['work'] }, seriesCharacter: 'J.D.' }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'work', incognito: true, seriesCharacter: 'jd' }), invalid);
  await assert.rejects(createConversation(sql, { mode: 'work', project: 'demo', projects: ['demo'], agent: { ...CLAUDE, modes: ['work'] }, seriesCharacter: 'jd' }), invalid);
  const chat = await characterChat();
  assert.deepEqual([chat.agent, chat.mode, chat.clearance, chat.workspace, chat.seriesCharacter, chat.model], ['claude', 'work', 'L1', null, 'jd', null]);
  assert.equal((await createConversation(sql, { mode: 'work', agent: { ...CLAUDE, modes: ['work'] } })).seriesCharacter, null);
  // The event of creation: L0, ids only.
  const [event] = await sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE kind = 'conversation.created' AND payload->>'conversationId' = ${chat.id}`;
  assert.deepEqual([event?.label, event?.payload], ['L0', { conversationId: chat.id, mode: 'work', agent: 'claude', character: 'jd' }]);

  // The database, whatever the core does.
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, series_character) VALUES ('work', 'L1', 'jd')`, /conversations_series_character_claude/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent, series_character) VALUES ('work', 'L1', 'codex', 'jd')`, /conversations_series_character_claude/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent, workspace, series_character) VALUES ('work', 'L1', 'coder', 'demo', 'jd')`, /conversations_series_character_claude/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent, series_character) VALUES ('work', 'L1', 'claude', 'J.D.')`, /conversations_series_character_id/);
  // Each part of the rule alone: a private conversation, a system chat, an incognito one.
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, series_character, origin, system_reason) VALUES ('work', 'L1', 'jd', 'system', 'failure')`, /conversations_series_character_claude/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, agent, incognito, series_character) VALUES ('work', 'L1', 'claude', true, 'jd')`, /conversations_series_character_claude|conversations_incognito_fields/);
  await assert.rejects(owner`INSERT INTO conversations (mode, clearance, series_character) VALUES ('private', 'L2', 'jd')`, /conversations_series_character_claude/);
  await owner`INSERT INTO conversations (mode, clearance, agent, series_character) VALUES ('work', 'L1', 'claude', 'turk')`;
  await assert.rejects(owner`UPDATE conversations SET series_character = 'turk' WHERE id = ${chat.id}`, /character is chosen at creation/);
  await assert.rejects(owner`UPDATE conversations SET series_character = NULL WHERE id = ${chat.id}`, /character is chosen at creation/);
  // Everything else of the conversation still changes as before.
  await sql`UPDATE conversations SET title = 'Con J.D.' WHERE id = ${chat.id}`;
  assert.equal((await loadConversation(sql, chat.id))?.title, 'Con J.D.');
});

test('Claude plays the character: prompt, block and lines in a new start, the new message and new lines when resumed', async () => {
  const { sql } = db();
  const chat = await characterChat();
  const first = await postUserMessage(sql, chat.id, 'Ciao, come va in corsia?');
  assert.equal(first.task.assignee, 'claude');
  const local = untouched();
  assert.deepEqual(await drain(first.task.id, orchestrator(local)), ['answered']);
  assert.equal(local.requests.length, 0, 'the local model never answers in its place');
  const opening = lastLaunch(chat.id);
  assert.ok(!opening.argv.includes('--resume'));
  assert.match(opening.prompt, /^scenario: ok\nROLE-PLAY PROMPT/);
  assert.match(opening.prompt, /You are J\.D\. of Scrubs/);
  assert.match(opening.prompt, /<scene>/);
  // The block before the message, the lines after it.
  const block = opening.prompt.indexOf('You are J.D.');
  const message = opening.prompt.indexOf('Ciao, come va in corsia?');
  const lines = opening.prompt.indexOf('<character_lines>');
  assert.ok(block > 0 && block < message && message < lines, 'prompt, block, message, lines');
  const firstLine = /Battuta numero (\d+)\./.exec(opening.prompt)?.[1];
  assert.ok(firstLine !== undefined);
  // Not the prompt of the plain chat, nor the catchphrases fixed in the block (the lines come apart).
  assert.doesNotMatch(opening.prompt, /Aquilaaa!/);
  const [answer] = await sql<{ body: string; model: string | null; label: string }[]>`SELECT body, model, label FROM messages WHERE task_id = ${first.task.id} AND role = 'assistant'`;
  assert.deepEqual([answer?.body, answer?.model, answer?.label], ['ok', 'sonnet', 'L1']);
  const gateway = await sql<{ decision: string; label: string; summary: string | null }[]>`
    SELECT decision, label, summary FROM gateway_log WHERE task_id = ${first.task.id} AND target_kind = 'executor'`;
  assert.deepEqual([...gateway].map((row) => [row.decision, row.label, row.summary]), [['allow', 'L1', 'character chat answered by claude/sonnet']]);

  const second = await postUserMessage(sql, chat.id, 'E Turk dov’è?');
  assert.deepEqual(await drain(second.task.id, orchestrator(local)), ['answered']);
  const resumed = lastLaunch(chat.id);
  assert.ok(resumed.argv.includes('--resume'));
  assert.match(resumed.prompt, /E Turk dov’è\?/);
  assert.match(resumed.prompt, /<character_lines>/);
  assert.doesNotMatch(resumed.prompt, /ROLE-PLAY PROMPT|You are J\.D\.|Ciao, come va/);
  const secondLine = /Battuta numero (\d+)\./.exec(resumed.prompt)?.[1];
  assert.ok(secondLine !== undefined && secondLine !== firstLine, 'new lines at every message');
});

test('the names of its series are no person in the briefs of the chat with the character only, whole, never another series', async () => {
  const { sql } = db();
  // In the chat with J.D. «Turk» is a character: it goes.
  const chat = await characterChat();
  const named = await postUserMessage(sql, chat.id, 'Saluta Turk da parte mia.');
  assert.deepEqual(await drain(named.task.id, orchestrator(untouched())), ['answered']);
  // A longer name, or one of another series, is still a person: the gateway stops it and the task waits.
  for (const text of ['Saluta Carla Bianchi.', 'Saluta Pam da parte mia.']) {
    const other = await characterChat();
    const { task } = await postUserMessage(sql, other.id, text);
    assert.deepEqual(await drain(task.id, orchestrator(untouched())), ['waiting-user'], text);
    assert.match((await loadTask(sql, task.id))?.waitingReason ?? '', /gateway refused/);
    const answers = await sql`SELECT 1 FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
    assert.equal(answers.length, 0);
  }
  // The plain chat with Claude, without a character: «Turk» is a person there.
  const plain = await createConversation(sql, { mode: 'work', agent: { ...CLAUDE, modes: ['work'] } });
  const { task } = await postUserMessage(sql, plain.id, 'Saluta Turk da parte mia.');
  assert.deepEqual(await drain(task.id, orchestrator(untouched())), ['waiting-user']);
  const [row] = await sql<{ decision: string; rule: string }[]>`SELECT decision, rule FROM gateway_log WHERE task_id = ${task.id} AND target_kind = 'executor'`;
  assert.deepEqual([row?.decision, row?.rule], ['block', 'pii']);
});

test('with Claude off the chat with the character waits for the user, and nothing leaves', async () => {
  const { sql } = db();
  const chat = await characterChat();
  const { task } = await postUserMessage(sql, chat.id, 'Ciao');
  const local = untouched();
  assert.deepEqual(await drain(task.id, orchestrator(local, [])), ['waiting-user']);
  assert.equal(local.requests.length, 0);
  const gateway = await sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude'`;
  assert.equal(gateway.length, 0);
});

test('the routes: the characters listed with who answers, a conversation with one only as the plain chat with Claude', async () => {
  const live = await startLiveFeed(db().sql);
  const plainClaude = { agent: 'claude', description: 'Chat semplice con Claude', cloud: true, executors: ['claude' as const], modes: ['work' as const], project: false, interlocutor: true as const };
  const coder = { agent: 'coder', description: 'Coder', cloud: true, executors: ['claude' as const], modes: ['work' as const], project: true };
  const characters = [{ id: 'jd', name: 'J.D.', show: 'Scrubs', rows: 4 as const }];
  const server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    directAgents: () => [plainClaude, coder],
    chatCharacters: () => characters,
    projects: () => [{ name: 'demo', path: 'repos/demo', label: 'L1' }],
    defaultModel: () => 'opus',
  });
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${String(server.port)}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const listed = (await (await fetch(`http://127.0.0.1:${String(server.port)}/api/direct-agents`)).json()) as { characters: unknown };
    assert.deepEqual(listed.characters, characters);
    const made = await post({ mode: 'work', agent: 'claude', character: 'jd' });
    assert.equal(made.status, 201);
    const { conversation } = (await made.json()) as { conversation: { agent: string; seriesCharacter: string; model: string | null } };
    // Sonnet unless the user chooses Opus in the chat: not the default model of the work agent.
    assert.deepEqual([conversation.agent, conversation.seriesCharacter, conversation.model], ['claude', 'jd', null]);
    // A character not listed, another agent, a private conversation, a project, or no agent: refused.
    assert.equal((await post({ mode: 'work', agent: 'claude', character: 'pam' })).status, 400);
    assert.equal((await post({ mode: 'work', agent: 'claude', character: 7 })).status, 400);
    assert.equal((await post({ mode: 'work', agent: 'coder', project: 'demo', character: 'jd' })).status, 400);
    assert.equal((await post({ mode: 'private', agent: 'claude', character: 'jd' })).status, 400);
    assert.equal((await post({ mode: 'work', agent: 'claude', project: 'demo', character: 'jd' })).status, 400);
    assert.equal((await post({ mode: 'work', character: 'jd' })).status, 400);
  } finally {
    await server.close();
    await live.close();
  }
});

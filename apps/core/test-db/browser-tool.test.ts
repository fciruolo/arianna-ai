// The browser tools of Arianna in the chat (D-264, passo 3), through the
// orchestrator: the consent of each action (Public: any public page;
// Internal: the addresses the user wrote and those approved from a card), the
// card «Apri / No» for a link to another site, the events without addresses,
// 20 actions per answer, never in a private or incognito context, the line of
// a browser taken by another chat. The browser is a fake with the shape of
// AgentBrowser.act: nothing starts, nothing leaves this machine.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';
import { createContext, type PageConsent } from '@arianna/policy';

import type { ActionResult, AgentBrowser, BrowserAction, BrowserScope } from '../src/browser/agent-browser.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { appendEvent } from '../src/events.ts';
import { processStepJob, recordDecision, STEP_QUEUE, submitTask } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import {
  approvedAddresses,
  BROWSER_ACTION_EVENT,
  browserConsent,
  CLOSED_BY_USER_TEXT,
  browserResultText,
  browserTool,
  MAX_ACTIONS_PER_TASK,
  NOT_HERE,
  TAKEN_TEXT,
  TASK_LIMIT,
  WAITING_BROWSER,
  writeClosedByUserLine,
  writeControlLine,
  writeTakenLine,
  CONTROL_TEXT,
} from '../src/orchestrator/browser-tool.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask, type Task } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `browser-tool-${randomUUID()}`);
const agents = committedAgents(ROOT);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const CATALOGO = 'https://example.com/catalogo';
const ALTRO = 'https://altro.example/pagina';

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

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

/** A fake browser with the shape the orchestrator uses: act, holder, release. */
interface FakeBrowser {
  calls: { scope: BrowserScope; action: BrowserAction }[];
  results: ActionResult[];
  holder: string | null;
  act: (scope: BrowserScope, action: BrowserAction) => Promise<ActionResult>;
  release: (conversationId: string) => Promise<void>;
}

const PAGE: ActionResult = { ok: true, page: { url: CATALOGO, site: 'example.com', title: 'Catalogo finto' } };

function fakeBrowser(results: ActionResult[] = []): FakeBrowser {
  const fake: FakeBrowser = {
    calls: [],
    results,
    holder: null,
    act(scope, action) {
      fake.calls.push({ scope, action });
      fake.holder = scope.conversationId;
      return Promise.resolve(fake.results.shift() ?? PAGE);
    },
    release(conversationId) {
      if (fake.holder === conversationId) fake.holder = null;
      return Promise.resolve();
    },
  };
  return fake;
}

async function drain(taskId: string, model: LocalModel, browser: FakeBrowser): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const executor = createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() }, personas: {} }),
    rules: RULES,
    browser: { agent: browser as unknown as AgentBrowser, installed: () => true },
  });
  const results: string[] = [];
  for (let guard = 0; guard < 40; guard += 1) {
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

const offersBrowser = (request: ChatRequest | undefined) => /^- browser\.open:/m.test(request?.messages[0]?.content ?? '');
const OPEN = (url: string): Answer => ({ action: 'call', tool: 'browser.open', arguments: { url } });
const READ: Answer = { action: 'call', tool: 'browser.read', arguments: {} };
const CLICK = (ref: number): Answer => ({ action: 'call', tool: 'browser.click', arguments: { ref } });
const REPLY = (text: string): Answer => ({ action: 'reply', text });

async function turnResult(taskId: string, step: number): Promise<string | null> {
  const [row] = await db().sql<{ result: string | null }[]>`SELECT result FROM task_turns WHERE task_id = ${taskId} AND step = ${step}`;
  return row?.result ?? null;
}

async function mustLoad(taskId: string): Promise<Task> {
  const task = await loadTask(db().sql, taskId);
  assert.ok(task !== undefined);
  return task;
}

async function workConversation(): Promise<string> {
  return (await createConversation(db().sql, { mode: 'work' })).id;
}

const sawText = (request: ChatRequest | undefined, text: string) => request?.messages.some((part) => part.content.includes(text)) === true;

test('Public context: browser.open with the public consent; an event with action and outcome, never the address', async () => {
  // The chat writes every user message at the clearance of the conversation (L1 in a work one):
  // a Public step is built by hand, as a task that has read only a public message.
  const conversationId = await workConversation();
  const task = await submitTask(db().sql, { title: 'Pagina pubblica', conversationId, label: 'L0', clearance: 'L1', effectiveLabel: 'L0', assignee: 'arianna' });
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body, task_id) VALUES (${conversationId}, 'user', 'web', 'L0', 'Apri il catalogo di example.com e dimmi il titolo.', ${task.id})`;
  const browser = fakeBrowser();
  const model = scripted([OPEN(CATALOGO), REPLY('Il titolo è «Catalogo finto».')]);
  const outcomes = await drain(task.id, model, browser);
  assert.equal(outcomes.at(-1), 'answered');
  assert.ok(offersBrowser(model.requests[0]));
  assert.equal(browser.calls.length, 1);
  assert.deepEqual(browser.calls[0]?.action, { kind: 'open', url: CATALOGO });
  assert.deepEqual(browser.calls[0].scope.consent, { from: 'public' } satisfies PageConsent);
  assert.equal(browser.calls[0].scope.context.effective, 'L0');
  assert.equal(await turnResult(task.id, 1), 'Browser on «Catalogo finto» (example.com). Call browser.read to see the page.');
  const events = await db().sql<{ label: string; payload: Record<string, unknown> }[]>`SELECT label::text, payload FROM events WHERE task_id = ${task.id} AND kind = ${BROWSER_ACTION_EVENT}`;
  assert.deepEqual([...events], [{ label: 'L0', payload: { conversationId, action: 'open', outcome: 'ok' } }]);
  assert.doesNotMatch(JSON.stringify(events), /example\.com/);
});

test('Internal context: the user consent; a link to another site waits for «Apri», then the address counts as written', async () => {
  const conversationId = await workConversation();
  const { task } = await postUserMessage(db().sql, conversationId, `Apri ${CATALOGO} e segui il link alla scheda.`);
  const browser = fakeBrowser([PAGE, { ok: false, reason: 'confirm', url: ALTRO, site: 'altro.example' }, { ok: true, page: { url: ALTRO, site: 'altro.example', title: 'Scheda finta' } }]);
  const model = scripted([OPEN(CATALOGO), CLICK(3), CLICK(3), REPLY('Ecco la scheda.')]);
  const first = await drain(task.id, model, browser);
  assert.equal(first.at(-1), 'waiting-approval');
  assert.deepEqual(browser.calls[0]?.scope.consent, { from: 'user', addresses: [CATALOGO] } satisfies PageConsent);
  assert.equal(await turnResult(task.id, 2), WAITING_BROWSER);
  const [approval] = await db().sql<{ id: string; kind: string; action: string; label: string; detail: Record<string, unknown> }[]>`
    SELECT id::text, kind, action, label::text, detail FROM approvals WHERE task_id = ${task.id}`;
  assert.deepEqual([approval?.kind, approval?.action, approval?.label], ['browser', 'browser.click', 'L1']);
  assert.deepEqual(approval?.detail, { url: ALTRO, site: 'altro.example', step: 2 });
  const waiting = await mustLoad(task.id);
  assert.deepEqual([waiting.status, waiting.waitingApprovalId], ['waiting_user', approval.id]);
  assert.deepEqual(await approvedAddresses(db().sql, waiting), []);

  await recordDecision(db().sql, approval.id, 'approved', 'web');
  const second = await drain(task.id, model, browser);
  assert.equal(second.at(-1), 'answered');
  const approved = browserResultText('approved', 'altro.example');
  // The step after the decision reads the decision in place of the waiting result.
  assert.ok(sawText(model.requests[2], approved));
  assert.ok(!sawText(model.requests[2], WAITING_BROWSER));
  assert.equal(browser.calls.length, 3);
  const done = await mustLoad(task.id);
  assert.deepEqual(await approvedAddresses(db().sql, done), [ALTRO]);
  assert.deepEqual(await browserConsent(db().sql, done, createContext('L1', 'L1')), { from: 'user', addresses: [CATALOGO, ALTRO] });
  // The second click ran with the approved address in the consent.
  assert.deepEqual(browser.calls[2]?.scope.consent, { from: 'user', addresses: [CATALOGO, ALTRO] });
  const outcomes = await db().sql<{ outcome: string }[]>`SELECT payload ->> 'outcome' AS outcome FROM events WHERE task_id = ${task.id} AND kind = ${BROWSER_ACTION_EVENT} ORDER BY id`;
  assert.deepEqual(outcomes.map((row) => row.outcome), ['ok', 'confirm', 'ok']);
});

test('Internal context: a refused link gives the model the refusal, and its address is never approved', async () => {
  const conversationId = await workConversation();
  const { task } = await postUserMessage(db().sql, conversationId, `Apri ${CATALOGO}.`);
  const browser = fakeBrowser([PAGE, { ok: false, reason: 'confirm', url: ALTRO, site: 'altro.example' }]);
  const model = scripted([OPEN(CATALOGO), CLICK(2), REPLY('Va bene, non apro quel sito.')]);
  assert.equal((await drain(task.id, model, browser)).at(-1), 'waiting-approval');
  const [approval] = await db().sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${task.id} AND kind = 'browser'`;
  await recordDecision(db().sql, approval?.id ?? '', 'rejected', 'web');
  assert.equal((await drain(task.id, model, browser)).at(-1), 'answered');
  assert.ok(sawText(model.requests[2], browserResultText('rejected', 'altro.example')));
  assert.deepEqual(await approvedAddresses(db().sql, await mustLoad(task.id)), []);
});

test('0084: an approval of kind browser only at most Internal, with url, site and step', async () => {
  const conversationId = await workConversation();
  const { task } = await postUserMessage(db().sql, conversationId, 'Una richiesta qualsiasi.');
  const insert = (label: string, detail: { [key: string]: string | number }) =>
    db().sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'browser', 'browser.click', ${db().sql.json(detail)}, ${label}::privacy_label)`;
  await assert.rejects(insert('L2', { url: ALTRO, site: 'altro.example', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L1', { site: 'altro.example', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(
    db().sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'browser', 'browser.open', ${db().sql.json({ url: ALTRO, site: 'altro.example', step: 1 })}, 'L1')`,
    /approvals_browser_fields/,
  );
  await insert('L1', { url: ALTRO, site: 'altro.example', step: 1 });
});

test(`${String(MAX_ACTIONS_PER_TASK)} actions per answer: the next one is refused without touching the browser`, async () => {
  const conversationId = await workConversation();
  const { task } = await postUserMessage(db().sql, conversationId, `Apri ${CATALOGO} e leggi tutto.`);
  for (let index = 0; index < MAX_ACTIONS_PER_TASK; index += 1) {
    await appendEvent(db().sql, { kind: BROWSER_ACTION_EVENT, label: 'L1', taskId: task.id, payload: { conversationId, action: 'read', outcome: 'ok' } });
  }
  const browser = fakeBrowser();
  await drain(task.id, scripted([READ, REPLY('Ho letto abbastanza.')]), browser);
  assert.equal(await turnResult(task.id, 1), `error: browser.read: ${TASK_LIMIT}`);
  assert.equal(browser.calls.length, 0);
  // browser.close is never refused by the limit.
  const closed = await browserTool('browser.close', {}, { task: await mustLoad(task.id), context: createContext('L1', 'L1'), browser: { browser: browser as unknown as AgentBrowser, sql: db().sql } });
  assert.equal(closed.text, 'Browser closed.');
  assert.equal(browser.calls.length, 1);
});

test('private data or incognito: the tools are not offered, and browserTool refuses them', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, `Apri ${CATALOGO}`);
  const browser = fakeBrowser();
  const model = scripted([REPLY('In una conversazione privata non uso il browser.')]);
  await drain(task.id, model, browser);
  assert.ok(model.requests[0] !== undefined && !offersBrowser(model.requests[0]));
  const env = { browser: browser as unknown as AgentBrowser, sql: db().sql };
  const loaded = await mustLoad(task.id);
  const privateRun = await browserTool('browser.open', { url: CATALOGO }, { task: loaded, context: createContext('L2', 'L2'), browser: env });
  assert.equal(privateRun.text, `error: browser.open: ${NOT_HERE}`);
  const work = await workConversation();
  const internal = await postUserMessage(db().sql, work, `Apri ${CATALOGO}`);
  const incognitoRun = await browserTool('browser.open', { url: CATALOGO }, { task: await mustLoad(internal.task.id), context: createContext('L1', 'L1'), incognito: true, browser: env });
  assert.equal(incognitoRun.text, `error: browser.open: ${NOT_HERE}`);
  assert.equal(browser.calls.length, 0);
  const [count] = await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM events WHERE kind = ${BROWSER_ACTION_EVENT} AND task_id IN (${task.id}, ${internal.task.id})`;
  assert.equal(count?.n, 0);
});

test('writeTakenLine: a system line without a task in the conversation whose browser was taken', async () => {
  const conversationId = await workConversation();
  await writeTakenLine(db().sql, conversationId);
  const rows = await db().sql<{ role: string; taskId: string | null; label: string; body: string }[]>`
    SELECT role, task_id::text AS "taskId", label::text, body FROM messages WHERE conversation_id = ${conversationId}`;
  assert.deepEqual([...rows], [{ role: 'system', taskId: null, label: 'L0', body: TAKEN_TEXT }]);
});

test('writeControlLine: taken and given back leave system lines; the browser closing leaves none', async () => {
  const conversationId = await workConversation();
  await writeControlLine(db().sql, conversationId, { state: 'taken' });
  await writeControlLine(db().sql, conversationId, { state: 'returned', reason: 'idle' });
  await writeControlLine(db().sql, conversationId, { state: 'returned', reason: 'browser-closed' });
  const rows = await db().sql<{ role: string; label: string; body: string }[]>`
    SELECT role, label::text, body FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at, id`;
  assert.deepEqual(rows.map((row) => row.body).sort(), [CONTROL_TEXT.taken, CONTROL_TEXT.idle].sort());
  assert.ok(rows.every((row) => row.role === 'system' && row.label === 'L0'));
});

test('writeClosedByUserLine: «Chiudi» in the chat leaves a system line without a task, read by the model too', async () => {
  const conversationId = await workConversation();
  await writeClosedByUserLine(db().sql, conversationId);
  const rows = await db().sql<{ role: string; taskId: string | null; label: string; body: string }[]>`
    SELECT role, task_id::text AS "taskId", label::text, body FROM messages WHERE conversation_id = ${conversationId}`;
  assert.deepEqual([...rows], [{ role: 'system', taskId: null, label: 'L0', body: CLOSED_BY_USER_TEXT }]);
});

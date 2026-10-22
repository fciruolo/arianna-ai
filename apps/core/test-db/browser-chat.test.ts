// «Nuova chat Privata» (D-281): after an access made by the user the browser
// passes to a Private chat born for it. Migration 0087 (the link between the
// two conversations, the typed text of the chat in gateway_log, the approval
// «Invia / No»), the handoff, and the orchestrator in that chat: only the
// browser tools and user.ask, the context marked with the site, every send to
// the site after «Invia». The browser is a fake: nothing starts, nothing
// leaves this machine.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';
import { createContext } from '@arianna/policy';

import type { ActionResult, AgentBrowser, BrowserAction, BrowserScope } from '../src/browser/agent-browser.ts';
import { gatewayTyped } from '../src/browser/agent-browser.ts';
import { afterControl, browserChatLine, browserChatTitle, HANDOFF_FAILED_LINE, HANDOFF_LINE, openBrowserChat, type HandoffBrowser } from '../src/browser/handoff.ts';
import { conversationKindOf } from '../src/browser/screen.ts';
import { createConversation, loadConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { BROWSER_ACTION_EVENT, browserSendText, WAITING_SEND } from '../src/orchestrator/browser-tool.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `browser-chat-${randomUUID()}`);
const agents = committedAgents(ROOT);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const SITE = 'biblioteca-finta.it';

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

interface FakeBrowser {
  calls: { scope: BrowserScope; action: BrowserAction }[];
  results: ActionResult[];
  holder: string | null;
  access: string | null;
  act: (scope: BrowserScope, action: BrowserAction) => Promise<ActionResult>;
  accessOf: (conversationId: string) => string | null;
  release: (conversationId: string) => Promise<void>;
  openedAt: (conversationId: string) => number | null;
}

const PAGE: ActionResult = { ok: true, page: { url: `https://www.${SITE}/prestiti`, site: SITE, title: 'I tuoi prestiti' } };
const READING: ActionResult = {
  ok: true,
  page: { url: `https://www.${SITE}/prestiti`, site: SITE, title: 'I tuoi prestiti' },
  reading: { title: 'I tuoi prestiti', url: `https://www.${SITE}/prestiti`, text: 'Il nome della rosa, scade il 3 novembre', elements: [{ ref: 1, kind: 'button', label: 'Rinnova' }], scrolled: 0 },
};

function fakeBrowser(holder: string, results: ActionResult[]): FakeBrowser {
  const fake: FakeBrowser = {
    calls: [],
    results,
    holder,
    access: SITE,
    act(scope, action) {
      fake.calls.push({ scope, action });
      return Promise.resolve(fake.results.shift() ?? PAGE);
    },
    accessOf: (conversationId) => (fake.holder === conversationId ? fake.access : null),
    release(conversationId) {
      if (fake.holder === conversationId) fake.holder = null;
      return Promise.resolve();
    },
    // When its browser opened (D-283): none here, so no saved value is let go.
    openedAt: () => null,
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

/** The tools the step offered, from its prompt. */
const toolsOf = (request: ChatRequest | undefined): string[] => [...(request?.messages[0]?.content ?? '').matchAll(/^- ([a-z]+\.[a-z]+):/gm)].map((match) => match[1] ?? '');
const READ: Answer = { action: 'call', tool: 'browser.read', arguments: {} };
const CLICK = (ref: number): Answer => ({ action: 'call', tool: 'browser.click', arguments: { ref } });
const REPLY = (text: string): Answer => ({ action: 'reply', text });

/** A work conversation and its Private chat of an access, as openBrowserChat leaves them. */
async function pair(): Promise<{ work: string; chat: string }> {
  const work = (await createConversation(db().sql, { mode: 'work' })).id;
  const handoff: HandoffBrowser = { accessOf: () => SITE, handOver: () => Promise.resolve(SITE), release: () => Promise.resolve() };
  const chat = await openBrowserChat({ sql: db().sql, browser: handoff, kind: conversationKindOf(db().sql) }, work);
  assert.ok(chat !== null);
  return { work, chat };
}

test('0087: a chat of an access is Private, answered by Arianna, born from an open work conversation, and never changes it', async () => {
  const work = (await createConversation(db().sql, { mode: 'work' })).id;
  const other = (await createConversation(db().sql, { mode: 'private' })).id;
  const insert = (fields: { mode?: string; clearance?: string; from?: string; agent?: string | null; finance?: boolean }) =>
    db().sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance, browser_of, agent, finance, effective_label)
      VALUES (${fields.mode ?? 'private'}, ${fields.clearance ?? 'L2'}::privacy_label, ${fields.from ?? work}, ${fields.agent ?? null}, ${fields.finance ?? false}, ${fields.finance === true ? 'L2' : 'L0'}::privacy_label)
      RETURNING id::text`;
  await assert.rejects(insert({ mode: 'work', clearance: 'L1' }), /conversations_browser_fields/);
  await assert.rejects(insert({ agent: 'local-chat' }), /conversations_browser_fields/);
  await assert.rejects(insert({ from: other }), /not an open work conversation/);
  await assert.rejects(insert({ from: randomUUID() }), /not an open work conversation/);
  await assert.rejects(insert({ finance: true }), /without finance data/);
  const [row] = await insert({});
  assert.ok(row !== undefined);
  await assert.rejects(db().sql`UPDATE conversations SET browser_of = NULL WHERE id = ${row.id}`, /never changes/);
  await assert.rejects(db().sql`UPDATE conversations SET browser_of = ${work} WHERE id = ${other}`, /never changes/);
});

test('openBrowserChat: the chat is born with its title and a line naming the site; the work conversation reads a line without it', async () => {
  const { work, chat } = await pair();
  const born = await loadConversation(db().sql, chat);
  assert.deepEqual([born?.mode, born?.clearance, born?.browserOf, born?.title, born?.agent], ['private', 'L2', work, browserChatTitle(SITE), null]);
  const mother = await loadConversation(db().sql, work);
  assert.deepEqual(mother?.browserChats.map((item) => item.id), [chat]);
  assert.deepEqual(born?.browserChats, []);
  const lines = await db().sql<{ conversationId: string; label: string; body: string }[]>`
    SELECT conversation_id::text AS "conversationId", label::text, body FROM messages WHERE conversation_id IN (${work}, ${chat}) ORDER BY id`;
  assert.deepEqual([...lines], [
    { conversationId: chat, label: 'L2', body: browserChatLine(SITE) },
    { conversationId: work, label: 'L0', body: HANDOFF_LINE },
  ]);
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'browser.handoff' AND payload ->> 'to' = ${chat}`;
  assert.deepEqual(event?.payload, { from: work, to: chat });
  assert.equal(await conversationKindOf(db().sql)(chat), 'browser');
  assert.equal(await conversationKindOf(db().sql)(work), 'work');
});

test('openBrowserChat: no access, or a browser closed meanwhile: no chat, no line', async () => {
  const work = (await createConversation(db().sql, { mode: 'work' })).id;
  const kind = conversationKindOf(db().sql);
  const release = () => Promise.resolve();
  assert.equal(await openBrowserChat({ sql: db().sql, browser: { accessOf: () => null, handOver: () => Promise.resolve(null), release }, kind }, work), null);
  assert.equal(await openBrowserChat({ sql: db().sql, browser: { accessOf: () => SITE, handOver: () => Promise.resolve(null), release }, kind }, work), null);
  assert.deepEqual((await loadConversation(db().sql, work))?.browserChats, []);
  const lines = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE conversation_id = ${work}`;
  assert.deepEqual([...lines], []);
});

test('openBrowserChat: a chat that cannot be written closes the browser passed to it; afterControl then writes the line of D-276', async () => {
  const gone = randomUUID();
  const released: string[] = [];
  const moved: string[] = [];
  const browser: HandoffBrowser = {
    accessOf: () => SITE,
    handOver: (_from, to) => { moved.push(to); return Promise.resolve(SITE); },
    release: (id) => { released.push(id); return Promise.resolve(); },
  };
  const kind = conversationKindOf(db().sql);
  await assert.rejects(openBrowserChat({ sql: db().sql, browser, kind }, gone), /not an open work conversation/);
  assert.deepEqual(released, moved);
  const [none] = await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM conversations WHERE id = ${moved[0] ?? gone}`;
  assert.equal(none?.n, 0);
  // From afterControl the failure is caught: the browser is closed and the work conversation reads that the access is lost.
  const work = (await createConversation(db().sql, { mode: 'work' })).id;
  await afterControl({ sql: db().sql, browser: { ...browser, handOver: () => Promise.reject(new Error('docker')) }, kind }, work, { state: 'returned', reason: 'user' });
  const lines = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE conversation_id = ${work}`;
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.body, HANDOFF_FAILED_LINE);
});

test('afterControl: given back in the work conversation with an access, the browser passes to a new chat', async () => {
  const work = (await createConversation(db().sql, { mode: 'work' })).id;
  const moves: string[] = [];
  await afterControl(
    { sql: db().sql, browser: { accessOf: () => SITE, handOver: (_from, to) => { moves.push(to); return Promise.resolve(SITE); }, release: () => Promise.resolve() }, kind: conversationKindOf(db().sql) },
    work,
    { state: 'returned', reason: 'user' },
  );
  assert.equal(moves.length, 1);
  assert.deepEqual((await loadConversation(db().sql, work))?.browserChats.map((item) => item.id), moves);
});

test('0087: the approval «Invia» of a chat of an access is L2, with site, element and step', async () => {
  const { chat } = await pair();
  const { task } = await postUserMessage(db().sql, chat, 'Rinnova i miei prestiti.');
  const insert = (label: string, detail: Record<string, string | number>) =>
    db().sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'browser', 'browser.send', ${db().sql.json(detail)}, ${label}::privacy_label)`;
  await assert.rejects(insert('L1', { site: SITE, element: 'Rinnova', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { site: SITE, step: 1 }), /approvals_browser_fields/);
  await insert('L2', { site: SITE, element: 'Rinnova', step: 1 });
});

test('0087: the text typed in the site of the access from its chat is logged as L2 web-typed-session; without the mark it stays local', async () => {
  const { chat } = await pair();
  const gate = gatewayTyped(db().sql);
  const context = createContext('L2', 'L2', { browserSite: SITE });
  assert.equal(await gate('Il nome della rosa', { conversationId: chat, context, consent: { from: 'sites', sites: [SITE] } }, new Set()), true);
  assert.equal(await gate('Il nome della rosa', { conversationId: chat, context: createContext('L2', 'L2'), consent: { from: 'sites', sites: [SITE] } }, new Set()), false);
  // Without the mark the text goes as an ordinary typed text of a page, and L2 stays local.
  const rows = await db().sql<{ target: string; label: string; decision: string; rule: string }[]>`
    SELECT target, label::text, decision, rule FROM gateway_log WHERE target LIKE 'web-typed-%' ORDER BY id DESC LIMIT 2`;
  assert.deepEqual([...rows].reverse(), [
    { target: 'web-typed-session', label: 'L2', decision: 'allow', rule: 'typed' },
    { target: 'web-typed-sites', label: 'L2', decision: 'block', rule: 'contaminated' },
  ]);
});

test('orchestrator in the chat of an access: only the browser tools, the context marked with the site, a send after «Invia»', async () => {
  const { chat } = await pair();
  const { task } = await postUserMessage(db().sql, chat, 'Rinnova i miei prestiti.');
  const browser = fakeBrowser(chat, [READING, { ok: false, reason: 'confirm-send', site: SITE, element: 'Rinnova' }, PAGE]);
  const model = scripted([READ, CLICK(1), CLICK(1), REPLY('Ho rinnovato «Il nome della rosa».')]);
  assert.equal((await drain(task.id, model, browser)).at(-1), 'waiting-approval');
  const offered = toolsOf(model.requests[0]);
  assert.ok(offered.includes('browser.read') && offered.includes('user.ask'), offered.join(', '));
  assert.ok(offered.every((tool) => tool.startsWith('browser.') || tool === 'user.ask'), offered.join(', '));
  const first = browser.calls[0]?.scope;
  assert.ok(first !== undefined);
  assert.equal(first.context.browserSite, SITE);
  assert.equal(first.context.effective, 'L2');
  assert.deepEqual(first.consent, { from: 'sites', sites: [SITE] });
  assert.equal(first.sendPermit, undefined);
  // The reading is L2 and says the page is the user's private data.
  const [readTurn] = await db().sql<{ label: string; result: string }[]>`SELECT label::text, result FROM task_turns WHERE task_id = ${task.id} AND step = 1`;
  assert.ok(readTurn !== undefined);
  assert.equal(readTurn.label, 'L2');
  assert.match(readTurn.result, /private data of the user/);
  const [approval] = await db().sql<{ id: string; action: string; label: string; detail: Record<string, unknown> }[]>`
    SELECT id::text, action, label::text, detail FROM approvals WHERE task_id = ${task.id} AND kind = 'browser'`;
  assert.deepEqual([approval?.action, approval?.label, approval?.detail], ['browser.send', 'L2', { site: SITE, element: 'Rinnova', step: 2 }]);
  const [waiting] = await db().sql<{ result: string }[]>`SELECT result FROM task_turns WHERE task_id = ${task.id} AND step = 2`;
  assert.equal(waiting?.result, WAITING_SEND);

  await recordDecision(db().sql, approval?.id ?? '', 'approved', 'web');
  assert.equal((await drain(task.id, model, browser)).at(-1), 'answered');
  assert.ok(model.requests[2]?.messages.some((part) => part.content.includes(browserSendText('approved', SITE))));
  assert.deepEqual(browser.calls[2]?.scope.sendPermit, { id: approval?.id, element: 'Rinnova' });
  const events = await db().sql<{ label: string }[]>`SELECT label::text FROM events WHERE task_id = ${task.id} AND kind = ${BROWSER_ACTION_EVENT}`;
  assert.ok(events.length === 3 && events.every((event) => event.label === 'L2'));
});

test('orchestrator: once another agent answered in the chat it loses the mark for good: no browser tools, the browser released', async () => {
  const { chat } = await pair();
  // An answer of another agent («@nome»): it may carry other data (the knowledge base).
  await db().sql`INSERT INTO messages (conversation_id, role, channel, label, body, agent) VALUES (${chat}, 'assistant', 'web', 'L2', 'Dalla conoscenza: …', 'local-chat')`;
  const { task } = await postUserMessage(db().sql, chat, 'Scrivilo nel sito.');
  const browser = fakeBrowser(chat, []);
  const model = scripted([REPLY('Qui non uso più il browser.')]);
  assert.equal((await drain(task.id, model, browser)).at(-1), 'answered');
  assert.ok(!toolsOf(model.requests[0]).some((tool) => tool.startsWith('browser.')));
  assert.equal(browser.calls.length, 0);
  assert.equal(browser.holder, null);
});

test('orchestrator: a Private chat without the browser of its access is a Private chat like the others, without browser tools', async () => {
  const { chat } = await pair();
  const { task } = await postUserMessage(db().sql, chat, 'Cosa dicevamo?');
  const browser = fakeBrowser('another-conversation', []);
  const model = scripted([REPLY('Il browser non c’è più.')]);
  assert.equal((await drain(task.id, model, browser)).at(-1), 'answered');
  const offered = toolsOf(model.requests[0]);
  assert.ok(!offered.some((tool) => tool.startsWith('browser.')), offered.join(', '));
  assert.equal(browser.calls.length, 0);
});

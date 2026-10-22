// The card «Apri / No» of a saved value (D-283) with the real AgentBrowser
// and the real gateway, as in the trial of the user: the user writes an
// address with a client in it («…+S.r.l.», with the final dot), Arianna opens
// it, the gateway stops it for the saved value, the browser closes before the
// user answers, the user presses «Apri», and the next browser of the
// conversation opens the page and reads it with no new card. The session is a
// fake that asks the gateway for every page as the network of the browser
// does (network.ts, pageHop): nothing starts, nothing leaves this machine.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';
import { spendAllowed } from '@arianna/policy';
import type { Page } from 'playwright-core';

import { AgentBrowser, gatewayTyped, READ_SCRIPT, type OpenSession } from '../src/browser/agent-browser.ts';
import type { BrowserManager } from '../src/browser/manager.ts';
import { navigationConsent, type LastNavigation, type NetworkScope } from '../src/browser/network.ts';
import type { BrowserSession } from '../src/browser/session.ts';
import { createClient } from '../src/clients.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE } from '../src/engine.ts';
import { passGateway } from '../src/gateway.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { siteOf, type FetchOptions, type FetchResult } from '../src/link-fetch.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { REFUSED_SAVED, savedResultText } from '../src/orchestrator/saved-ask.ts';
import { refreshSavedPrivate, resetSavedPrivate, savedInAddress } from '../src/saved-private.ts';
import { addressesInText } from '../src/web-page.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `browser-saved-flow-${randomUUID()}`);
const agents = committedAgents(ROOT);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
afterEach(() => {
  resetSavedPrivate();
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

interface World {
  browser: AgentBrowser;
  /** Every page the fake network asked the gateway for, with its outcome. */
  pages: { url: string; rule: string }[];
  opened: number;
}

/** The real AgentBrowser over a fake session whose pages pass the real gateway with the scope of the network. */
function world(options: { precheck?: boolean } = {}): World {
  let active: { id: string } | null = null;
  const manager = { get state() { return 'free'; }, get active() { return active; } } as unknown as BrowserManager;
  const w: World = { browser: undefined as unknown as AgentBrowser, pages: [], opened: 0 };
  const openSession: OpenSession = (_manager, id, job) => {
    active = { id };
    w.opened += 1;
    let scope: NetworkScope = { context: job.context, consent: job.consent, ...(job.meta === undefined ? {} : { meta: job.meta }) };
    let last: LastNavigation | undefined;
    let url = 'about:blank';
    const page = {
      url: () => url,
      title: () => Promise.resolve(url === 'about:blank' ? '' : 'Risultati finti'),
      evaluate: (script: unknown) => Promise.resolve(script === READ_SCRIPT ? { title: 'Risultati finti', url, text: 'Ferramenta Lunardi Srl, Bolzano', elements: [], scrolled: 0 } : undefined),
      locator: () => ({ first: () => ({}) }),
      mainFrame: () => ({}),
    } as unknown as Page;
    const session = {
      network: {
        rescope: (next: NetworkScope) => { scope = next; },
        lastNavigation: () => (last === undefined ? undefined : { ...last }),
        authenticated: () => null,
        settle: () => Promise.resolve(),
        heldSends: () => 0,
      },
      // As pageHop of network.ts: the gateway as a page, with the scope of the network.
      openPage: async (address: string) => {
        const target = { kind: 'web', page: navigationConsent(scope.consent, address, 0) } as const;
        const decision = await passGateway(db().sql, [{ value: address, label: scope.context.effective, source: 'web:page' }], scope.context, target, scope.meta);
        w.pages.push({ url: address, rule: decision.rule });
        const seq = (last?.seq ?? 0) + 1;
        if (decision.decision !== 'allow') {
          last = decision.rule === 'saved-private' && decision.saved !== undefined ? { seq, outcome: 'blocked', reason: 'saved-private', saved: decision.saved } : { seq, outcome: 'blocked', reason: 'blocked' };
          throw new Error('net::ERR_BLOCKED_BY_CLIENT');
        }
        spendAllowed(decision);
        url = address;
        last = { seq, outcome: 'ok', ...(siteOf(address) === undefined ? {} : { site: siteOf(address) ?? '' }) };
        return { title: 'Risultati finti', url };
      },
      currentPage: () => Promise.resolve(page),
      resetPage: () => Promise.resolve(),
      close: () => { active = null; return Promise.resolve(); },
    } as unknown as BrowserSession;
    return Promise.resolve(session);
  };
  w.browser = new AgentBrowser({ sql: db().sql, manager, session: { home: HOME }, gateTyped: gatewayTyped(db().sql), openSession, ...(options.precheck === true ? { savedIn: savedInAddress } : {}) });
  return w;
}

/** Pages read by web.fetch: every address through the gateway, as fetchLink does. */
const fetched: string[] = [];
async function fakePage(address: string, options: FetchOptions): Promise<FetchResult> {
  fetched.push(address);
  if ((await options.authorize(address)) !== address) return { ok: false, reason: 'blocked' };
  return { ok: true, link: { url: address, site: new URL(address).hostname, title: 'Risultati finti', text: 'Ferramenta Lunardi Srl, Bolzano.', truncated: false } };
}

async function drain(taskId: string, model: LocalModel, browser: AgentBrowser): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const executor = createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() }, personas: {} }),
    rules: RULES,
    browser: { agent: browser, installed: () => true },
    fetchLink: fakePage,
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

const OPEN = (url: string): Answer => ({ action: 'call', tool: 'browser.open', arguments: { url } });
const READ: Answer = { action: 'call', tool: 'browser.read', arguments: {} };
const FETCH = (url: string): Answer => ({ action: 'call', tool: 'web.fetch', arguments: { url } });
const REPLY = (text: string): Answer => ({ action: 'reply', text });
const sawText = (request: ChatRequest | undefined, text: string) => request?.messages.some((part) => part.content.includes(text)) === true;

test('an address the user wrote with a final dot counts as written, with and without it', () => {
  const address = 'https://duckduckgo.com/?q=Ferramenta+Lunardi+S.r.l.';
  assert.deepEqual(addressesInText(`Cerca ${address}`), ['https://duckduckgo.com/?q=Ferramenta+Lunardi+S.r.l', address]);
  // A dot that only ends the sentence still gives the address without it.
  assert.ok(addressesInText('Guarda https://example.com/listino.').includes('https://example.com/listino'));
  // No dot: only the address.
  assert.deepEqual(addressesInText('Guarda https://example.com/listino'), ['https://example.com/listino']);
});

for (const closed of [true, false]) {
  test(`«Apri» on a saved value lets the same page open and be read, with no new card (browser ${closed ? 'closed' : 'open'} before the answer, D-283)`, async () => {
    const sql = db().sql;
    const tag = randomUUID().slice(0, 8);
    // Saved without dots, written with them: the same client.
    await createClient(sql, { displayName: `Ferramenta Lunardi${tag} Srl` });
    await refreshSavedPrivate(sql);
    const address = `https://duckduckgo.com/?q=Ferramenta+Lunardi${tag}+S.r.l.`;
    const conversationId = (await createConversation(sql, { mode: 'work' })).id;
    const { task } = await postUserMessage(sql, conversationId, `Cerca ${address}`);
    const w = world();
    // After «Apri» the core opens the address again itself (D-286): no answer of the model for it.
    const model = scripted([OPEN(address), READ, REPLY('Ecco cosa ho trovato.')]);

    const first = await drain(task.id, model, w.browser);
    assert.equal(first.at(-1), 'waiting-approval');
    // Written by the user, final dot included: no card «Apri / No» for the address, only the one of the saved value.
    const asks = await sql<{ id: string; action: string; detail: Record<string, unknown> }[]>`
      SELECT id::text, action, detail FROM approvals WHERE task_id = ${task.id} ORDER BY requested_at`;
    assert.deepEqual(asks.map((ask) => ask.action), ['browser.private']);
    assert.equal(asks[0]?.detail.site, 'duckduckgo.com');
    assert.deepEqual(w.pages.map((page) => page.rule), ['saved-private']);

    // The browser goes before the user answers (it was idle, or an action failed): the card holds for the next one.
    if (closed) {
      assert.equal(await w.browser.closeByUser(conversationId), true);
      assert.equal(w.browser.holder, null);
    }
    await recordDecision(sql, asks[0].id, 'approved', 'web');
    const second = await drain(task.id, model, w.browser);
    assert.equal(second.at(-1), 'answered');
    assert.ok(sawText(model.requests[1], savedResultText('approved', 'browser.open')));
    // The page opened and was read; the gateway never stopped it again, and no other card was asked.
    assert.deepEqual(w.pages.map((page) => page.rule), ['saved-private', 'page']);
    assert.equal(w.opened, closed ? 2 : 1);
    const outcomes = await sql<{ action: string; outcome: string }[]>`
      SELECT payload ->> 'action' AS action, payload ->> 'outcome' AS outcome FROM events WHERE task_id = ${task.id} AND kind = 'browser.action' ORDER BY id`;
    assert.deepEqual(outcomes.map((row) => `${row.action}:${row.outcome}`), ['open:confirm-private', 'open:ok', 'read:ok']);
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM approvals WHERE task_id = ${task.id}`;
    assert.equal(count?.n, 1);
  });
}

test('a card of a browser before the last one does not hold for a new browser', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  await createClient(sql, { displayName: `Officina Glicini${tag}` });
  await refreshSavedPrivate(sql);
  const address = `https://duckduckgo.com/?q=Officina+Glicini${tag}`;
  const conversationId = (await createConversation(sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(sql, conversationId, `Cerca ${address}`);
  const w = world();
  const model = scripted([OPEN(address)]);
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'waiting-approval');
  const [ask] = await sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${task.id}`;
  await recordDecision(sql, ask?.id ?? '', 'approved', 'web');
  // Two browsers later (the one after the card, then another): the card holds no more.
  await w.browser.closeByUser(conversationId);
  const scope = { conversationId, context: (await import('@arianna/policy')).createContext('L1', 'L1'), consent: { from: 'user', addresses: [address, 'https://example.com/'] } } as const;
  await w.browser.act(scope, { kind: 'open', url: 'https://example.com/' });
  await w.browser.closeByUser(conversationId);
  const holds = w.browser.savedFor(conversationId);
  assert.equal(holds.opened, null);
  const { approvedSaved } = await import('../src/orchestrator/saved-ask.ts');
  assert.deepEqual(await approvedSaved(sql, conversationId, { for: holds }), new Set());
});

test('the check before the page (D-283): browser.open with a saved value asks at once, without asking the network', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  await createClient(sql, { displayName: `Cartoleria Glicini${tag}` });
  await refreshSavedPrivate(sql);
  const address = `https://duckduckgo.com/?q=Cartoleria+Glicini${tag}`;
  const conversationId = (await createConversation(sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(sql, conversationId, `Cerca ${address}`);
  const w = world({ precheck: true });
  const model = scripted([OPEN(address), REPLY('Fatto.')]);
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'waiting-approval');
  // No page was asked: the card came from the check before the navigation.
  assert.equal(w.pages.length, 0);
  const [ask] = await sql<{ id: string; detail: Record<string, unknown> }[]>`SELECT id::text, detail FROM approvals WHERE task_id = ${task.id} AND action = 'browser.private'`;
  assert.equal(ask?.detail.site, 'duckduckgo.com');
  await recordDecision(sql, ask.id, 'approved', 'web');
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'answered');
  assert.deepEqual(w.pages.map((page) => page.rule), ['page']);
});

test('«Apri» on a card of web.fetch: the step resumes and reads the page; the same value then opens in the browser without a card (D-283)', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  await createClient(sql, { displayName: `Ferramenta Lunardi${tag} Srl` });
  await refreshSavedPrivate(sql);
  const address = `https://duckduckgo.com/?q=Ferramenta+Lunardi${tag}+S.r.l.`;
  const conversationId = (await createConversation(sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(sql, conversationId, `Cerca ${address}`);
  const w = world({ precheck: true });
  fetched.length = 0;
  const model = scripted([FETCH(address), OPEN(address), READ, REPLY('Ecco.')]);
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'waiting-approval');
  const [ask] = await sql<{ id: string; detail: Record<string, unknown> }[]>`SELECT id::text, detail FROM approvals WHERE task_id = ${task.id} AND action = 'browser.private'`;
  assert.equal(ask?.detail.tool, 'web.fetch');
  await recordDecision(sql, ask.id, 'approved', 'web');
  // The task waited for this card: the decision puts it back to work, and the same web.fetch runs again.
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'answered');
  assert.ok(sawText(model.requests[1], savedResultText('approved', 'web.fetch')));
  const fetches = await sql<{ outcome: string }[]>`SELECT payload ->> 'outcome' AS outcome FROM events WHERE task_id = ${task.id} AND kind = 'web.fetch' ORDER BY id`;
  assert.deepEqual(fetches.map((row) => row.outcome), ['blocked', 'ok']);
  // The browser opens the same value with no new card: the «Apri» of web.fetch holds for it (the first browser).
  const actions = await sql<{ action: string; outcome: string }[]>`
    SELECT payload ->> 'action' AS action, payload ->> 'outcome' AS outcome FROM events WHERE task_id = ${task.id} AND kind = 'browser.action' ORDER BY id`;
  assert.deepEqual(actions.map((row) => `${row.action}:${row.outcome}`), ['open:ok', 'read:ok']);
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM approvals WHERE task_id = ${task.id}`;
  assert.equal(count?.n, 1);
  // A card asked before any browser holds for the first one only within 15 minutes of the decision.
  const { approvedSaved, rememberAsked } = await import('../src/orchestrator/saved-ask.ts');
  const first = { browsers: [], none: true };
  const ref = ((ask.detail.values as { ref: string }[])[0] ?? { ref: '' }).ref;
  const other = (await createConversation(sql, { mode: 'work' })).id;
  const { task: later } = await postUserMessage(sql, other, `Cerca ${address}`);
  const card = (age: string) => sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label, state, decided_at, decided_via)
    VALUES (${later.id}, 'browser', 'browser.private', ${sql.json({ values: [{ ref, kind: 'name', client: 'x' }], tool: 'web.fetch', step: 1 })}, 'L2', 'approved', now() - ${age}::interval, 'web')
    RETURNING id::text`;
  const [old] = await card('16 minutes');
  rememberAsked(old?.id ?? '', [ref]);
  assert.equal((await approvedSaved(sql, other, { for: first })).size, 0);
  const [fresh] = await card('1 minute');
  rememberAsked(fresh?.id ?? '', [ref]);
  assert.deepEqual(await approvedSaved(sql, other, { for: first }), new Set([ref]));
});

test('«Apri» on a card of the browser holds for web.fetch of the same value in the conversation (D-283)', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  await createClient(sql, { displayName: `Officina Brenta${tag}` });
  await refreshSavedPrivate(sql);
  const address = `https://duckduckgo.com/?q=Officina+Brenta${tag}`;
  const conversationId = (await createConversation(sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(sql, conversationId, `Cerca ${address}`);
  const w = world({ precheck: true });
  const model = scripted([OPEN(address), FETCH(address), REPLY('Ecco.')]);
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'waiting-approval');
  const [ask] = await sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${task.id} AND action = 'browser.private'`;
  await recordDecision(sql, ask?.id ?? '', 'approved', 'web');
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'answered');
  const fetches = await sql<{ outcome: string }[]>`SELECT payload ->> 'outcome' AS outcome FROM events WHERE task_id = ${task.id} AND kind = 'web.fetch' ORDER BY id`;
  assert.deepEqual(fetches.map((row) => row.outcome), ['ok']);
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM approvals WHERE task_id = ${task.id}`;
  assert.equal(count?.n, 1);
});

test('after «Apri» the core makes the approved call itself, before the model reads anything; after «No» another tool with the same value is stopped without a new card (D-286)', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  await createClient(sql, { displayName: `Mercato Ruffo${tag}` });
  await refreshSavedPrivate(sql);
  const address = `https://duckduckgo.com/?q=Mercato+Ruffo${tag}`;
  // «Apri»: the open is made again by the core; the model is asked only once more, for the reply.
  const yes = (await createConversation(sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(sql, yes, `Cerca ${address}`);
  const w = world({ precheck: true });
  const model = scripted([OPEN(address), REPLY('Ecco.')]);
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'waiting-approval');
  const [ask] = await sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${task.id} AND action = 'browser.private'`;
  await recordDecision(sql, ask?.id ?? '', 'approved', 'web');
  assert.equal((await drain(task.id, model, w.browser)).at(-1), 'answered');
  assert.equal(model.requests.length, 2);
  // The page was opened before the model read anything, and the model read its outcome.
  assert.deepEqual(w.pages.map((page) => page.rule), ['page']);
  const turns = await sql<{ step: number; result: string | null }[]>`SELECT step, result FROM task_turns WHERE task_id = ${task.id} ORDER BY step`;
  assert.equal(turns.length, 3);
  assert.match(turns[1]?.result ?? '', /^Browser on «Risultati finti»/);
  assert.ok(sawText(model.requests[1], 'Browser on «Risultati finti»'));
  // «No»: then web.fetch of the same address is stopped without a card.
  const no = (await createConversation(sql, { mode: 'work' })).id;
  const { task: refused } = await postUserMessage(sql, no, `Cerca ${address}`);
  const other = world({ precheck: true });
  const again = scripted([OPEN(address), FETCH(address), REPLY('Va bene.')]);
  assert.equal((await drain(refused.id, again, other.browser)).at(-1), 'waiting-approval');
  const [card] = await sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${refused.id} AND action = 'browser.private'`;
  await recordDecision(sql, card?.id ?? '', 'rejected', 'web');
  assert.equal((await drain(refused.id, again, other.browser)).at(-1), 'answered');
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM approvals WHERE task_id = ${refused.id}`;
  assert.equal(count?.n, 1);
  assert.ok(sawText(again.requests[2], REFUSED_SAVED));
  // A new message of the user: the same value asks again.
  const { task: later } = await postUserMessage(sql, no, `Riprova ${address}`);
  const third = scripted([FETCH(address)]);
  assert.equal((await drain(later.id, third, other.browser)).at(-1), 'waiting-approval');
});

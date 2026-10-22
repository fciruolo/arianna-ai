// The saved private values of the user in the browser and in web.fetch
// (D-283): the matcher the core builds from clients and contacts, built
// again after every change; the gateway row of a refusal without hash nor
// value; migration 0088 (the approval `browser.private`); and the card
// «Apri / No» through the orchestrator, with the values let go only for the
// browser they were decided for. The browser is a fake with the shape of
// AgentBrowser: nothing starts, nothing leaves this machine. Fake data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';
import { createContext } from '@arianna/policy';

import type { ActionResult, AgentBrowser, BrowserAction, BrowserScope } from '../src/browser/agent-browser.ts';
import { addContact, archiveClient, createClient, removeContact, updateClient } from '../src/clients.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE } from '../src/engine.ts';
import { passGateway } from '../src/gateway.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { approvedSaved, savedResultText, WAITING_PRIVATE } from '../src/orchestrator/saved-ask.ts';
import { knownPrivate, refreshSavedPrivate, resetSavedPrivate, savedEntry, savedValueHash, startSavedPrivate } from '../src/saved-private.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `browser-saved-${randomUUID()}`);
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

/** Waits until the listener of the changes has loaded the values again. */
async function settled(): Promise<void> {
  await refreshSavedPrivate(db().sql);
}

test('the matcher from the database: clients not archived and contacts not removed, references only', async () => {
  const sql = db().sql;
  await startSavedPrivate(sql, (error) => { throw error; });
  const tag = randomUUID().slice(0, 8);
  const name = `Ferramenta Lunardi ${tag}`;
  const { id } = await createClient(sql, {
    kind: 'freelancer',
    displayName: name,
    firstName: 'Gilda',
    lastName: `Lunardi${tag}`,
    email: `amministrazione-${tag}@ferramenta-finta.example`,
    phone: '+39 0471 552 908',
    vatNumber: '05500000012',
    registeredAddress: { street: `Via dei Glicini ${tag}`, number: '14', postalCode: '39100', city: 'Bolzano', province: 'BZ' },
  });
  await settled();
  assert.deepEqual(knownPrivate.find(`https://cerca.example/?q=${encodeURIComponent(name)}`), []);
  assert.deepEqual(knownPrivate.find(`cerca ${name.toUpperCase()} a Bolzano`), [`client:${id}:name`]);
  assert.deepEqual(knownPrivate.find(`Gilda Lunardi${tag}`), [`client:${id}:person`]);
  // Surname first, as forms write it.
  assert.deepEqual(knownPrivate.find(`Lunardi${tag} Gilda`), [`client:${id}:person`]);
  // The surname alone, a city, the street without its number: nothing.
  assert.deepEqual(knownPrivate.find(`Lunardi${tag} Bolzano, via dei glicini ${tag}`), []);
  assert.deepEqual(knownPrivate.find(`via dei glicini ${tag}, 14`), [`client:${id}:registered-address`]);
  assert.deepEqual(knownPrivate.find('chiama lo 0471 552908'), [`client:${id}:phone`]);
  // The partita IVA as saved and as sites write it, with the country in front.
  assert.deepEqual(knownPrivate.find('?piva=05500000012'), [`client:${id}:vat-number`]);
  assert.deepEqual(knownPrivate.find('?q=IT05500000012'), [`client:${id}:vat-number`]);
  // The EU VAT number of a client of the EU, also without its country, and the tax id of one outside.
  const eu = await createClient(sql, { displayName: `Holzbau Finta ${tag}`, country: 'AT', euVatNumber: 'ATU12345675' });
  const abroad = await createClient(sql, { displayName: `Lumber Finta ${tag}`, country: 'US', foreignTaxId: '98-7654321' });
  await settled();
  assert.deepEqual(knownPrivate.find('vies ATU12345675'), [`client:${eu.id}:eu-vat-number`]);
  assert.deepEqual(knownPrivate.find('?q=U12345675'), [`client:${eu.id}:eu-vat-number`]);
  assert.deepEqual(knownPrivate.find('id 98-7654321'), [`client:${abroad.id}:foreign-tax-id`]);
  assert.deepEqual(savedEntry(`client:${id}:email`), { kind: 'email', client: name, hash: savedValueHash(`amministrazione-${tag}@ferramenta-finta.example`) });

  // A contact added: in the values after the change, without restarting.
  const contact = await addContact(sql, id, { name: `Ottavio Brenta ${tag}`, mobile: '347 120 9981' });
  await settled();
  assert.deepEqual(knownPrivate.find(`Ottavio Brenta ${tag}`), [`contact:${contact.id}:contact-name`]);
  assert.deepEqual(savedEntry(`contact:${contact.id}:contact-mobile`), { kind: 'contact-mobile', client: name, hash: savedValueHash('3471209981', true) });
  // Renamed: the old name no longer counts.
  await updateClient(sql, id, { displayName: `Lunardi Utensili ${tag}` });
  await settled();
  assert.deepEqual(knownPrivate.find(name), []);
  assert.deepEqual(knownPrivate.find(`Lunardi Utensili ${tag}`), [`client:${id}:name`]);
  // Removed, archived: gone.
  await removeContact(sql, id, contact.id);
  await settled();
  assert.deepEqual(knownPrivate.find(`Ottavio Brenta ${tag}`), []);
  await archiveClient(sql, id, true);
  await settled();
  assert.deepEqual(knownPrivate.find(`Lunardi Utensili ${tag}`), []);
});

test('before the first load the comparison refuses: no page goes unchecked', async () => {
  resetSavedPrivate();
  assert.throws(() => knownPrivate.find('qualsiasi'), /not loaded/);
  const decision = await passGateway(db().sql, [{ value: 'https://cerca.example/?q=orari', label: 'L0', source: 'web:page' }], createContext('L1', 'L0'), { kind: 'web', page: { from: 'public' } }, { saved: { approved: new Set() } });
  assert.equal(decision.rule, 'invalid-input');
});

test('passGateway: a saved value in a page address is refused with saved-private, its row without hash, bytes nor value', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  const name = `Cartoleria Ròsa ${tag}`;
  const { id } = await createClient(sql, { displayName: name });
  await refreshSavedPrivate(sql);
  const address = `https://cerca.example/?q=${encodeURIComponent(`cartoleria rosa ${tag}`)}`;
  const target = { kind: 'web', page: { from: 'public' } } as const;
  const decision = await passGateway(sql, [{ value: address, label: 'L0', source: 'web:page' }], createContext('L1', 'L0'), target, { saved: { approved: new Set() } });
  assert.equal(decision.decision, 'block');
  assert.equal(decision.rule, 'saved-private');
  assert.deepEqual([decision.next, decision.saved], ['ask-user', [`client:${id}:name`]]);
  const [row] = await sql<{ rule: string; reason: string; payloadSha256: string | null; bytesOut: number | null }[]>`
    SELECT rule, reason, payload_sha256 AS "payloadSha256", bytes_out AS "bytesOut" FROM gateway_log ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([row?.rule, row?.payloadSha256, row?.bytesOut], ['saved-private', null, null]);
  assert.doesNotMatch(row?.reason ?? '', new RegExp(`rosa|${tag}|${id}`, 'i'));
  // Approved: it goes, without the second check.
  const allowed = await passGateway(sql, [{ value: address, label: 'L0', source: 'web:page' }], createContext('L1', 'L0'), target, { saved: { approved: new Set([`client:${id}:name`]) } });
  assert.equal(allowed.decision, 'allow');
  assert.match(allowed.reason, /saved values compared, no second check/);
});

test('0088: an approval browser.private is L2, with values, tool and step', async () => {
  const conversationId = (await createConversation(db().sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(db().sql, conversationId, 'Una richiesta qualsiasi.');
  const insert = (label: string, detail: Record<string, unknown>) =>
    db().sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'browser', 'browser.private', ${db().sql.json(detail as never)}, ${label}::privacy_label)`;
  const values = [{ ref: 'client:c1:name', kind: 'name', client: 'Ferramenta finta' }];
  await assert.rejects(insert('L1', { values, tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values: [], tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values, step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values, tool: 'browser.open' }), /approvals_browser_fields/);
  // Each value only ref, kind and client, as strings: a value itself never enters approvals.
  await assert.rejects(insert('L2', { values: [{ ...values[0], value: 'Ferramenta finta Srl' }], tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values: [{ ref: 'client:c1:name', kind: 'name' }], tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values: [{ ref: 'client:c1:name', kind: 'name', client: 7 }], tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values: ['client:c1:name'], tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values: { ref: 'client:c1:name' }, tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values: Array.from({ length: 21 }, () => values[0]), tool: 'browser.open', step: 1 }), /approvals_browser_fields/);
  // The browser a number, the site a string, both optional.
  await assert.rejects(insert('L2', { values, tool: 'browser.open', step: 1, browser: '1761000000000' }), /approvals_browser_fields/);
  await assert.rejects(insert('L2', { values, tool: 'browser.open', step: 1, site: 3 }), /approvals_browser_fields/);
  await insert('L2', { values, tool: 'browser.open', step: 1 });
  await insert('L2', { values, tool: 'browser.open', step: 1, browser: 1761000000000, site: 'cerca.example' });
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
  opened: number;
  act: (scope: BrowserScope, action: BrowserAction) => Promise<ActionResult>;
  release: (conversationId: string) => Promise<void>;
  openedAt: (conversationId: string) => number | null;
  userAddressesOf: (conversationId: string) => readonly string[];
  lastOpenedAt: (conversationId: string) => number | null;
  savedFor: (conversationId: string) => { opened: number | null; browsers: number[]; none: boolean };
}

const CERCA = 'https://cerca.example/';

function fakeBrowser(results: ActionResult[]): FakeBrowser {
  const fake: FakeBrowser = {
    calls: [],
    results,
    holder: null,
    // Opened a minute ago: the decisions of this test come after it.
    opened: Date.now() - 60_000,
    act(scope, action) {
      fake.calls.push({ scope, action });
      fake.holder = scope.conversationId;
      return Promise.resolve(fake.results.shift() ?? { ok: true, page: { url: CERCA, site: 'cerca.example', title: 'Risultati finti' } });
    },
    release(conversationId) {
      if (fake.holder === conversationId) fake.holder = null;
      return Promise.resolve();
    },
    openedAt: (conversationId) => (fake.holder === conversationId ? fake.opened : null),
    userAddressesOf: () => [],
    lastOpenedAt: (conversationId) => (fake.holder === conversationId ? fake.opened : null),
    savedFor: (conversationId) => (fake.holder === conversationId ? { opened: fake.opened, browsers: [fake.opened], none: false } : { opened: null, browsers: [], none: true }),
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

const sawText = (request: ChatRequest | undefined, text: string) => request?.messages.some((part) => part.content.includes(text)) === true;
const OPEN = (url: string): Answer => ({ action: 'call', tool: 'browser.open', arguments: { url } });
const REPLY = (text: string): Answer => ({ action: 'reply', text });

test('the card «Apri / No»: a saved value waits for the user; with «Apri» it holds for that browser, never the value in the card nor for the model', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  const name = `Officina Brenta ${tag}`;
  const { id } = await createClient(sql, { displayName: name });
  await refreshSavedPrivate(sql);
  const ref = `client:${id}:name`;
  const address = `https://cerca.example/?q=Officina+Brenta+${tag}`;
  const conversationId = (await createConversation(sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(sql, conversationId, `Cerca ${address} e dimmi cosa trovi.`);
  const browser = fakeBrowser([{ ok: true, page: { url: CERCA, site: 'cerca.example', title: 'Cerca' } }, { ok: false, reason: 'confirm-private', saved: [ref], site: 'cerca.example' }]);
  const model = scripted([OPEN(CERCA), OPEN(address), OPEN(address), REPLY('Ecco i risultati.')]);
  // The address the user wrote; the first open of the search page is the user's too (written above).
  const first = await drain(task.id, model, browser);
  assert.equal(first.at(-1), 'waiting-approval');
  const [turn] = await sql<{ result: string | null }[]>`SELECT result FROM task_turns WHERE task_id = ${task.id} AND step = 2`;
  assert.equal(turn?.result, WAITING_PRIVATE);
  const [approval] = await sql<{ id: string; action: string; label: string; detail: Record<string, unknown> }[]>`
    SELECT id::text, action, label::text, detail FROM approvals WHERE task_id = ${task.id} AND kind = 'browser'`;
  assert.deepEqual([approval?.action, approval?.label], ['browser.private', 'L2']);
  assert.deepEqual(approval?.detail, { values: [{ ref, kind: 'name', client: name }], tool: 'browser.open', step: 2, browser: browser.opened, site: 'cerca.example' });
  // The event of the request names the action only.
  const [requested] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE task_id = ${task.id} AND kind = 'approval.requested' ORDER BY id DESC LIMIT 1`;
  assert.doesNotMatch(JSON.stringify(requested?.payload ?? {}), new RegExp(`${tag}|Brenta`));
  assert.deepEqual(await approvedSaved(sql, conversationId, { for: { browsers: [browser.opened], none: false } }), new Set());

  await recordDecision(sql, approval.id, 'approved', 'web');
  assert.deepEqual(await approvedSaved(sql, conversationId, { for: { browsers: [browser.opened], none: false } }), new Set([ref]));
  // Asked for another browser: not for this one.
  assert.deepEqual(await approvedSaved(sql, conversationId, { for: { browsers: [browser.opened + 1], none: false } }), new Set());
  // For web.fetch: in the last 15 minutes.
  assert.deepEqual(await approvedSaved(sql, conversationId, { recent: true }), new Set([ref]));
  const second = await drain(task.id, model, browser);
  assert.equal(second.at(-1), 'answered');
  assert.ok(sawText(model.requests[2], savedResultText('approved')));
  assert.ok(!sawText(model.requests[2], WAITING_PRIVATE));
  // Never the name of the client for the model.
  assert.ok(!model.requests.some((request) => request.messages.some((part) => part.content.includes(`Officina Brenta ${tag}`) && part.role !== 'user')));
  // The open after «Apri» carried the value let go, for the browser it was decided for.
  assert.deepEqual(browser.calls[2]?.scope.saved, { opened: browser.opened, approved: new Set([ref]) });
  // The «Apri» was for that value: the field changed, the new value asks again.
  await updateClient(sql, id, { displayName: `Officina Brenta Due ${tag}` });
  await refreshSavedPrivate(sql);
  assert.deepEqual(await approvedSaved(sql, conversationId, { for: { browsers: [browser.opened], none: false } }), new Set());
  // Neither the value nor its hash in the approval.
  const [stored] = await sql<{ detail: unknown }[]>`SELECT detail FROM approvals WHERE id = ${approval.id}`;
  assert.doesNotMatch(JSON.stringify(stored?.detail), /[0-9a-f]{64}/);
});

test('the card «Apri / No»: with «No» the model reads the refusal and nothing is let go', async () => {
  const sql = db().sql;
  const tag = randomUUID().slice(0, 8);
  const { id } = await createClient(sql, { displayName: `Panificio Glicini ${tag}` });
  await refreshSavedPrivate(sql);
  const ref = `client:${id}:name`;
  const conversationId = (await createConversation(sql, { mode: 'work' })).id;
  const { task } = await postUserMessage(sql, conversationId, `Apri ${CERCA}.`);
  const browser = fakeBrowser([{ ok: false, reason: 'confirm-private', saved: [ref] }]);
  const model = scripted([OPEN(CERCA), REPLY('Va bene, proseguo senza.')]);
  assert.equal((await drain(task.id, model, browser)).at(-1), 'waiting-approval');
  const [approval] = await sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${task.id} AND action = 'browser.private'`;
  await recordDecision(sql, approval?.id ?? '', 'rejected', 'web');
  assert.equal((await drain(task.id, model, browser)).at(-1), 'answered');
  assert.ok(sawText(model.requests[1], savedResultText('rejected')));
  assert.deepEqual(await approvedSaved(sql, conversationId, { for: { browsers: [browser.opened], none: false }, recent: true }), new Set());
});

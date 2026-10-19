import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { canRead, fakePiiCheck, gatewayCheck, markLogged, piiExemptions, secretMatcher, type Context, type Decision, type Label, type Labeled } from '@arianna/policy';

import { KbError, type Kb, type KbPage } from '../src/orchestrator/kb.ts';
import { DEFAULT_VERSION, handleMessage, MAX_BODY, type McpHandlers } from '../src/mcp/protocol.ts';
import { createMcpServer, MAX_MESSAGES, McpSessionError, type McpServer } from '../src/mcp/server.ts';
import {
  callTool,
  DENIED_TEXT,
  INTERNAL_TEXT,
  INVALID_TEXT,
  LIMIT_TEXT,
  MAX_CALLS,
  MAX_RUN_BYTES,
  toolDescriptors,
  type McpCallEvent,
  type McpSessionInput,
  type McpSkills,
  type McpToolDeps,
  type RunUsage,
} from '../src/mcp/tools.ts';
import type { SkillListItem } from '../src/skills-catalog.ts';

const INFO = { name: 'arianna', version: '0.0.0-test' };
const NO_TOOLS: McpHandlers = { listTools: () => [], callTool: () => Promise.resolve(undefined) };

async function reply(body: unknown, handlers: McpHandlers = NO_TOOLS) {
  return handleMessage(typeof body === 'string' ? body : JSON.stringify(body), handlers, INFO);
}

describe('protocol', () => {
  it('initialize answers with the version of the client when supported, else 2025-06-18', async () => {
    for (const version of ['2025-03-26', '2025-06-18', '2025-11-25']) {
      const answer = await reply({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'claude', version: 'x' } } });
      assert.ok(answer.status === 200);
      assert.deepEqual(answer.body.result, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: INFO });
    }
    for (const version of ['2024-11-05', '2099-01-01', 7, undefined]) {
      const answer = await reply({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: version } });
      assert.ok(answer.status === 200);
      assert.equal((answer.body.result as { protocolVersion: string }).protocolVersion, DEFAULT_VERSION);
    }
  });

  it('notifications and responses of the client get 202 without a body', async () => {
    assert.deepEqual(await reply({ jsonrpc: '2.0', method: 'notifications/initialized' }), { status: 202 });
    assert.deepEqual(await reply({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), { status: 202 });
    assert.deepEqual(await reply({ jsonrpc: '2.0', id: 3, result: {} }), { status: 202 });
  });

  it('ping, unknown methods, batches and malformed messages', async () => {
    assert.deepEqual(await reply({ jsonrpc: '2.0', id: 2, method: 'ping' }), { status: 200, body: { jsonrpc: '2.0', id: 2, result: {} } });
    assert.deepEqual(await reply({ jsonrpc: '2.0', id: 2, method: 'resources/list' }), { status: 200, body: { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } } });
    const batch = await reply([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    assert.ok(batch.status === 400 && batch.body.error?.code === -32600);
    const parse = await reply('{nope');
    assert.ok(parse.status === 400 && parse.body.error?.code === -32700);
    for (const bad of [{ id: 1, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, 'null']) {
      assert.equal((await reply(bad)).status, 400, JSON.stringify(bad));
    }
  });

  it('tools/call of a tool the handlers do not have is an invalid params error that echoes nothing', async () => {
    const answer = await reply({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'kb_read<script>', arguments: {} } });
    assert.deepEqual(answer, { status: 200, body: { jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'Unknown tool' } } });
    const noName = await reply({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { arguments: {} } });
    assert.ok(noName.status === 200 && noName.body.error?.code === -32602);
  });
});

// A knowledge base of fake pages, read with the policy's canRead as the real one.
const PAGES: Record<string, KbPage> = {
  'kb/work/router.md': { path: 'kb/work/router.md', label: 'L1', title: 'Router', body: 'The router picks the executor.' },
  'kb/public/readme.md': { path: 'kb/public/readme.md', label: 'L0', title: 'Readme', body: 'Fake public page.' },
  'kb/private/casa.md': { path: 'kb/private/casa.md', label: 'L2', title: 'Casa', body: 'Fake private page.' },
  'kb/progetti/cliente-b/Workplan/piano.md': { path: 'kb/progetti/cliente-b/Workplan/piano.md', label: 'L1', title: 'Piano B', body: 'Fake plan of another client.' },
  'projects/cliente-b/Workplan/note.md': { path: 'projects/cliente-b/Workplan/note.md', label: 'L1', title: 'Note B', body: 'Fake notes of another client.' },
  'kb/work/long.md': { path: 'kb/work/long.md', label: 'L1', title: 'Long', body: 'x'.repeat(20_000) },
};

const fakeKb: Kb = {
  read(path: string, context: Context) {
    const page = PAGES[path];
    if (page === undefined) throw new KbError('not-found', `page ${path} not found`);
    if (!canRead(context, page.label)) throw new KbError('above-clearance', 'above');
    return page;
  },
  search(query: string, context: Context) {
    const all = Object.values(PAGES).filter((page) => page.body.toLowerCase().includes(query.toLowerCase()) || page.title.toLowerCase().includes(query.toLowerCase()));
    const hits = all.filter((page) => canRead(context, page.label)).map((page) => ({ path: page.path, title: page.title, snippet: page.body.slice(0, 40), label: page.label }));
    return { hits, skippedAbove: hits.length < all.length };
  },
  write() {
    throw new Error('no writes');
  },
};

const SKILLS: SkillListItem[] = [
  { id: 'acme/skills/testing', source: 'acme/skills', slug: 'testing', name: 'Testing', description: 'Write tests', license: 'MIT', otherFiles: 0, label: 'L0' },
  { id: 'acme/skills/unassigned', source: 'acme/skills', slug: 'unassigned', name: 'Other', description: 'Not assigned', license: 'MIT', otherFiles: 0, label: 'L0' },
  { id: 'local/claude-code/mine', source: 'local/claude-code', slug: 'mine', name: 'Mine', description: 'Private skill', license: null, otherFiles: 0, label: 'L2' },
  { id: 'local/claude-code/shared', source: 'local/claude-code', slug: 'shared', name: 'Shared', description: 'Shareable skill', license: null, otherFiles: 0, label: 'L1' },
];

function fakeSkills(refused: string | null = null): McpSkills {
  return {
    list: () => ({ skills: SKILLS }),
    text: (id) => {
      const skill = SKILLS.find((item) => item.id === id);
      if (skill === undefined) throw new Error('unknown skill');
      return { id, name: skill.name, source: skill.source, commit: 'abc', license: skill.license, notice: 'notice', text: `TEXT OF ${skill.name}`, label: skill.label };
    },
    assigned: () => ['acme/skills/testing', 'local/claude-code/mine', 'local/claude-code/shared'],
    refusal: () => refused,
  };
}

interface Harness {
  deps: McpToolDeps;
  gated: { labels: Label[]; decision: string; summary: string }[];
  /** What each call offered the gateway, fragment by fragment. */
  payloads: (readonly Labeled<string>[])[];
  events: McpCallEvent[];
}

function harness(skills: McpSkills = fakeSkills()): Harness {
  const gated: Harness['gated'] = [];
  const events: McpCallEvent[] = [];
  const payloads: Harness['payloads'] = [];
  const deps: McpToolDeps = {
    kb: fakeKb,
    skills,
    gate: (payload: readonly Labeled<string>[], context, executor, meta): Promise<Decision> => {
      const decision = gatewayCheck(payload, context, { kind: 'executor', id: executor, locality: 'cloud' }, secretMatcher([]), fakePiiCheck(payload));
      if (decision.decision === 'allow') markLogged(decision);
      gated.push({ labels: payload.map((fragment) => fragment.label), decision: decision.decision, summary: meta.summary });
      payloads.push(payload);
      return Promise.resolve(decision);
    },
    event: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  return { deps, gated, payloads, events };
}

function session(extra: Partial<McpSessionInput> = {}): McpSessionInput {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    agent: 'coder',
    executor: 'claude',
    clearance: 'L1',
    tools: ['list_skills', 'get_skill', 'kb_search', 'kb_read'],
    expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  };
}

const usage = (): RunUsage => ({ calls: 0, bytes: 0 });
const textOf = (result: Awaited<ReturnType<typeof callTool>>): string => result?.content[0]?.text ?? '';

describe('tools', () => {
  it('tools/list shows the tools of the session alone, with an input schema', () => {
    assert.deepEqual(toolDescriptors(['kb_read', 'list_skills']).map((tool) => tool.name), ['list_skills', 'kb_read']);
    const [read] = toolDescriptors(['kb_read']);
    assert.deepEqual(read?.inputSchema.required, ['path']);
    assert.deepEqual(toolDescriptors([]), []);
  });

  it('kb_read reads an L1 page through the gateway, with one gated call and an event without text', async () => {
    const { deps, gated, events } = harness();
    const result = await callTool(session(), usage(), 'kb_read', { path: 'kb/work/router.md' }, deps);
    assert.equal(result?.isError, false);
    assert.match(textOf(result), /The router picks the executor/);
    assert.deepEqual(gated, [{ labels: ['L1'], decision: 'allow', summary: 'mcp kb_read' }]);
    const [event, ...more] = events;
    assert.ok(event !== undefined && more.length === 0);
    assert.equal(event.decision, 'allow');
    assert.ok(event.bytes > 0);
    assert.doesNotMatch(JSON.stringify(events), /router|kb\/work/);
  });

  it('kb_read of an L2 page, of a missing page and of a bad path: the same fixed text, a blocked row each', async () => {
    const { deps, gated, events } = harness();
    const answers = [];
    for (const path of ['kb/private/casa.md', 'kb/work/missing.md', '../etc/passwd']) answers.push(await callTool(session(), usage(), 'kb_read', { path }, deps));
    for (const answer of answers) assert.deepEqual(answer, { content: [{ type: 'text', text: DENIED_TEXT }], isError: true });
    assert.deepEqual(gated.map((call) => call.decision), ['block', 'block', 'block']);
    assert.deepEqual(events.map((event) => event.decision), ['deny', 'deny', 'deny']);
  });

  it('kb_read cuts a long page and kb_search leaves out pages above the clearance without saying so', async () => {
    const { deps } = harness();
    const long = await callTool(session(), usage(), 'kb_read', { path: 'kb/work/long.md' }, deps);
    assert.match(textOf(long), /\[page cut at 6000 characters\]$/);
    const found = await callTool(session(), usage(), 'kb_search', { query: 'fake' }, deps);
    assert.match(textOf(found), /kb\/public\/readme\.md/);
    assert.doesNotMatch(textOf(found), /casa|private|Private/);
  });

  it('the knowledge of the projects is never read nor found, even at L1 (D-145)', async () => {
    const { deps } = harness();
    for (const path of ['kb/progetti/cliente-b/Workplan/piano.md', 'projects/cliente-b/Workplan/note.md']) {
      assert.equal(textOf(await callTool(session(), usage(), 'kb_read', { path }, deps)), DENIED_TEXT, path);
    }
    const found = textOf(await callTool(session(), usage(), 'kb_search', { query: 'another client' }, deps));
    assert.equal(found, 'No pages match.');
  });

  it('an L0 session reads no L1 page', async () => {
    const { deps } = harness();
    assert.equal(textOf(await callTool(session({ clearance: 'L0' }), usage(), 'kb_read', { path: 'kb/work/router.md' }, deps)), DENIED_TEXT);
    assert.match(textOf(await callTool(session({ clearance: 'L0' }), usage(), 'kb_read', { path: 'kb/public/readme.md' }, deps)), /Fake public page/);
  });

  it('list_skills and get_skill: only assigned skills, a private one of the user never', async () => {
    const { deps } = harness();
    const list = textOf(await callTool(session(), usage(), 'list_skills', {}, deps));
    assert.match(list, /acme\/skills\/testing: Testing/);
    assert.match(list, /local\/claude-code\/shared/);
    assert.doesNotMatch(list, /unassigned|local\/claude-code\/mine/);
    assert.equal(textOf(await callTool(session(), usage(), 'get_skill', { id: 'acme/skills/testing' }, deps)), 'TEXT OF Testing');
    for (const id of ['acme/skills/unassigned', 'local/claude-code/mine', 'nobody/none/x']) {
      assert.equal(textOf(await callTool(session(), usage(), 'get_skill', { id }, deps)), DENIED_TEXT, id);
    }
    // In an L0 session a shareable skill (L1) is not shown either.
    assert.doesNotMatch(textOf(await callTool(session({ clearance: 'L0' }), usage(), 'list_skills', {}, deps)), /shared/);
  });

  it('an agent that reads no skills sees none', async () => {
    const { deps } = harness(fakeSkills('the card of this agent closes untrusted_content'));
    assert.equal(textOf(await callTool(session(), usage(), 'list_skills', {}, deps)), 'No skills are assigned to this agent.');
    assert.equal(textOf(await callTool(session(), usage(), 'get_skill', { id: 'acme/skills/testing' }, deps)), DENIED_TEXT);
  });

  it('a tool outside the session is unknown; bad arguments are a fixed text', async () => {
    const { deps, gated } = harness();
    assert.equal(await callTool(session({ tools: ['kb_read'] }), usage(), 'list_skills', {}, deps), undefined);
    assert.equal(await callTool(session(), usage(), 'kb_write', {}, deps), undefined);
    assert.equal(textOf(await callTool(session(), usage(), 'kb_read', { path: 3 }, deps)), INVALID_TEXT);
    assert.equal(textOf(await callTool(session(), usage(), 'kb_read', { path: 'kb/a.md', extra: 1 }, deps)), INVALID_TEXT);
    assert.equal(gated.length, 0);
  });

  it('an internal error is a fixed text, never the error', async () => {
    const { deps, events } = harness();
    const broken: McpToolDeps = { ...deps, gate: () => Promise.reject(new Error('database down at /secret/path')) };
    const result = await callTool(session(), usage(), 'kb_read', { path: 'kb/work/router.md' }, broken);
    assert.deepEqual(result, { content: [{ type: 'text', text: INTERNAL_TEXT }], isError: true });
    assert.equal(events.at(-1)?.decision, 'error');
  });

  it(`at most ${String(MAX_CALLS)} calls per run`, async () => {
    const { deps, events } = harness();
    const run = usage();
    for (let index = 0; index < MAX_CALLS; index += 1) assert.equal((await callTool(session(), run, 'kb_read', { path: 'kb/public/readme.md' }, deps))?.isError, false);
    assert.equal(textOf(await callTool(session(), run, 'kb_read', { path: 'kb/public/readme.md' }, deps)), LIMIT_TEXT);
    assert.equal(events.at(-1)?.decision, 'limit');
    // Past the limit, an unknown tool is refused as well, and the event is written once per run.
    assert.equal(textOf(await callTool(session(), run, 'kb_write', {}, deps)), LIMIT_TEXT);
    assert.equal(textOf(await callTool(session(), run, 'kb_read', { path: 'kb/public/readme.md' }, deps)), LIMIT_TEXT);
    assert.equal(events.filter((event) => event.decision === 'limit').length, 1);
  });

  it('unknown tools and bad arguments count towards the limit', async () => {
    const { deps } = harness();
    const run = usage();
    for (let index = 0; index < MAX_CALLS / 2; index += 1) {
      assert.equal(await callTool(session(), run, 'kb_write', {}, deps), undefined);
      assert.equal(textOf(await callTool(session(), run, 'kb_read', { path: 1 }, deps)), INVALID_TEXT);
    }
    assert.equal(run.calls, MAX_CALLS);
    assert.equal(textOf(await callTool(session(), run, 'kb_read', { path: 'kb/public/readme.md' }, deps)), LIMIT_TEXT);
  });

  it('D-250: only a text of the catalogs alone, in its own source, skips the second scanner', async () => {
    const { deps, payloads } = harness();
    // An L0 session sees only the catalog skill: the whole list is exempt, as the text of a catalog skill.
    await callTool(session({ clearance: 'L0' }), usage(), 'list_skills', {}, deps);
    await callTool(session(), usage(), 'get_skill', { id: 'acme/skills/testing' }, deps);
    for (const payload of payloads.splice(0)) {
      assert.deepEqual(piiExemptions(payload), [true]);
      assert.equal(payload[0]?.source, 'skills:coder');
    }
    // A list with a shareable skill of the user's own, its text, a page: read by the second scanner, whole.
    await callTool(session(), usage(), 'list_skills', {}, deps);
    await callTool(session(), usage(), 'get_skill', { id: 'local/claude-code/shared' }, deps);
    await callTool(session(), usage(), 'kb_read', { path: 'kb/public/readme.md' }, deps);
    await callTool(session(), usage(), 'kb_search', { query: 'fake' }, deps);
    assert.equal(payloads.length, 4);
    for (const payload of payloads) assert.deepEqual(piiExemptions(payload), [false], payload[0]?.source);
    assert.match(payloads[0]?.[0]?.value ?? '', /acme\/skills\/testing[\s\S]*local\/claude-code\/shared|local\/claude-code\/shared[\s\S]*acme\/skills\/testing/);
    assert.equal(payloads[0]?.[0]?.label, 'L1');
  });

  it('a refusal offers an empty L2 fragment with a source that names it', async () => {
    const { deps, payloads } = harness();
    await callTool(session(), usage(), 'kb_read', { path: 'kb/private/casa.md' }, deps);
    assert.deepEqual(payloads, [[{ value: '', label: 'L2', source: 'mcp:kb_read:denied' }]]);
  });

  it('an answer over 24 KB and a run over 200 KB are refused', async () => {
    const huge: McpSkills = { ...fakeSkills(), text: (id) => ({ ...fakeSkills().text(id), text: 'y'.repeat(30_000) }) };
    const { deps } = harness(huge);
    assert.equal(textOf(await callTool(session(), usage(), 'get_skill', { id: 'acme/skills/testing' }, deps)), LIMIT_TEXT);
    const run: RunUsage = { calls: 0, bytes: MAX_RUN_BYTES - 10 };
    assert.equal(textOf(await callTool(session(), run, 'kb_read', { path: 'kb/work/router.md' }, harness().deps)), LIMIT_TEXT);
    assert.equal(run.bytes, MAX_RUN_BYTES - 10);
  });
});

interface HttpAnswer {
  status: number;
  body: string;
}

function post(url: string, options: { body?: string; token?: string; headers?: Record<string, string>; method?: string; path?: string }): Promise<HttpAnswer> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...options.headers };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    const req = httpRequest({ host: target.hostname, port: target.port, path: options.path ?? target.pathname, method: options.method ?? 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

describe('server', () => {
  let server: McpServer;
  let url: string;
  let clock = new Date('2026-10-19T10:00:00Z');

  before(async () => {
    server = createMcpServer({ ...harness().deps, version: '0.0.0-test', now: () => clock });
    url = (await server.start()).url;
  });
  after(async () => {
    await server.close();
  });

  const open = (extra: Partial<McpSessionInput> = {}): string => server.open(session({ runId: crypto.randomUUID(), expiresAt: new Date(clock.getTime() + 60_000), ...extra })).token;

  it('listens on 127.0.0.1 with a port of the system, path /mcp', () => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('a token is 43 characters of base64url; tools/list shows the tools of its session', async () => {
    const token = open({ tools: ['kb_read'] });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const answer = await post(url, { body: LIST, token });
    assert.equal(answer.status, 200);
    assert.deepEqual((JSON.parse(answer.body) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name), ['kb_read']);
    const other = await post(url, { body: LIST, token: open({ tools: ['list_skills', 'get_skill'] }) });
    assert.deepEqual((JSON.parse(other.body) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name), ['list_skills', 'get_skill']);
  });

  it('tools/call through HTTP reads an L1 page', async () => {
    const answer = await post(url, { body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kb_read', arguments: { path: 'kb/work/router.md' } } }), token: open() });
    const parsed = JSON.parse(answer.body) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(parsed.result.isError, false);
    assert.match(parsed.result.content[0]?.text ?? '', /router picks/);
  });

  it('a notification gets 202 with no body', async () => {
    const answer = await post(url, { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), token: open() });
    assert.deepEqual(answer, { status: 202, body: '' });
  });

  it('a wrong, revoked or expired token gets 401 with no detail', async () => {
    assert.deepEqual(await post(url, { body: LIST }), { status: 401, body: '' });
    assert.deepEqual(await post(url, { body: LIST, token: 'A'.repeat(43) }), { status: 401, body: '' });
    const runId = crypto.randomUUID();
    const revoked = server.open(session({ runId, expiresAt: new Date(clock.getTime() + 60_000) })).token;
    assert.equal((await post(url, { body: LIST, token: revoked })).status, 200);
    server.revoke(runId);
    assert.deepEqual(await post(url, { body: LIST, token: revoked }), { status: 401, body: '' });
    const expiring = open();
    clock = new Date(clock.getTime() + 61_000);
    assert.deepEqual(await post(url, { body: LIST, token: expiring }), { status: 401, body: '' });
  });

  it('a run with an open session gets no second one; a bad session is refused', () => {
    const runId = crypto.randomUUID();
    open({ runId });
    assert.throws(() => open({ runId }), McpSessionError);
    assert.throws(() => open({ clearance: 'L2' }), McpSessionError);
    assert.throws(() => open({ executor: 'codex' as 'claude' }), McpSessionError);
    assert.throws(() => open({ tools: ['kb_write' as 'kb_read'] }), McpSessionError);
  });

  it('Origin or another Host: 403', async () => {
    const token = open();
    assert.equal((await post(url, { body: LIST, token, headers: { origin: 'http://127.0.0.1' } })).status, 403);
    assert.equal((await post(url, { body: LIST, token, headers: { host: 'evil.example:80' } })).status, 403);
    assert.equal((await post(url, { body: LIST, token, headers: { host: `localhost:${new URL(url).port}` } })).status, 403);
  });

  it('GET and DELETE: 405; other paths, OAuth discovery included: 404', async () => {
    const token = open();
    assert.equal((await post(url, { method: 'GET', token })).status, 405);
    assert.equal((await post(url, { method: 'DELETE', token })).status, 405);
    for (const path of ['/', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/mcp/x', '/api/status']) {
      assert.equal((await post(url, { body: LIST, token, path })).status, 404, path);
    }
  });

  it(`a body over ${String(MAX_BODY)} bytes: 413`, async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'z'.repeat(MAX_BODY) } });
    assert.equal((await post(url, { body: big, token: open() })).status, 413);
  });

  it('a batch is refused', async () => {
    const answer = await post(url, { body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), token: open() });
    assert.equal(answer.status, 400);
  });

  it(`at most ${String(MAX_MESSAGES)} messages per session, of any method: then 429`, async () => {
    const token = open();
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    for (let index = 0; index < MAX_MESSAGES; index += 1) assert.equal((await post(url, { body: index % 2 === 0 ? ping : LIST, token })).status, 200);
    assert.deepEqual(await post(url, { body: ping, token }), { status: 429, body: '' });
  });

  it('a server not started opens no session', () => {
    const idle = createMcpServer({ ...harness().deps, version: '0' });
    assert.throws(() => idle.open(session()), /not started/);
  });

  it('close revokes every session', async () => {
    const other = createMcpServer({ ...harness().deps, version: '0' });
    const { url: otherUrl } = await other.start();
    const token = other.open(session()).token;
    assert.equal((await post(otherUrl, { body: LIST, token })).status, 200);
    await other.close();
    await assert.rejects(post(otherUrl, { body: LIST, token }));
  });
});

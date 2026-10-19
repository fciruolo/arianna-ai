// Arianna's MCP server (D-261) against the database: a page of the fake
// knowledge base read by a cloud run leaves through the gateway (a row in
// gateway_log, allowed), a private one is refused with the fixed text (a row,
// blocked); each call writes an event mcp.call without arguments nor text.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import { appendEvent } from '../src/events.ts';
import { passGateway } from '../src/gateway.ts';
import { createMcpServer, type McpServer } from '../src/mcp/server.ts';
import { DENIED_TEXT } from '../src/mcp/tools.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOME = join(resolveHome({}), 'data', 'test-tmp', `mcp-${randomUUID()}`);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n\n[[folder]]\npath = "kb/private"\nlabel = "L2"\n');
const RUN = randomUUID();
const TASK = randomUUID();

let server: McpServer;
let url: string;
let token: string;

before(async () => {
  mkdirSync(join(HOME, 'kb', 'work'), { recursive: true });
  mkdirSync(join(HOME, 'kb', 'private'), { recursive: true });
  writeFileSync(join(HOME, 'kb', 'work', 'router.md'), '---\ntitle: Router finto\n---\nIl router sceglie l’esecutore in base all’etichetta.\n');
  writeFileSync(join(HOME, 'kb', 'private', 'caldaia.md'), '---\ntitle: Caldaia\n---\nNota privata inventata sulla caldaia.\n');
  server = createMcpServer({
    kb: createKb({ home: HOME, rules: RULES }),
    skills: { list: () => ({ skills: [] }), text: () => { throw new Error('no skills'); }, assigned: () => [], refusal: () => null },
    gate: (payload, context, executor, meta) => passGateway(db().sql, payload, context, { kind: 'executor', id: executor, locality: 'cloud' }, meta),
    event: async ({ runId, taskId, agent, tool, decision, bytes }) => {
      await appendEvent(db().sql, { kind: 'mcp.call', label: 'L0', runId, taskId, agent, payload: { runId, tool, decision, bytes } });
    },
    version: '0.0.0-test',
  });
  url = (await server.start()).url;
  token = server.open({ runId: RUN, taskId: TASK, agent: 'coder', executor: 'claude', clearance: 'L1', tools: ['kb_read', 'kb_search'], expiresAt: new Date(Date.now() + 60_000) }).token;
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
  return { isError: body.result.isError, text: body.result.content[0]?.text ?? '' };
}

interface LogRow {
  label: string;
  decision: string;
  rule: string;
  target: string;
  summary: string | null;
  bytes_out: number | null;
}

async function logRows(): Promise<LogRow[]> {
  return db().sql<LogRow[]>`SELECT label, decision, rule, target, summary, bytes_out FROM gateway_log WHERE run_id = ${RUN} ORDER BY id`;
}

test('an L1 page is read through the gateway: one allowed row, one event without text', async () => {
  const answer = await call('kb_read', { path: 'kb/work/router.md' });
  assert.equal(answer.isError, false);
  assert.match(answer.text, /Il router sceglie/);
  const rows = await logRows();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], bytes_out: (rows[0]?.bytes_out ?? 0) > 0 }, { label: 'L1', decision: 'allow', rule: 'cloud', target: 'claude', summary: 'mcp kb_read', bytes_out: true });
  const events = await db().sql<{ label: string; payload: Record<string, unknown>; task_id: string }[]>`SELECT label, payload, task_id FROM events WHERE kind = 'mcp.call' AND run_id = ${RUN} ORDER BY id`;
  const [event, ...more] = events;
  assert.ok(event !== undefined && more.length === 0);
  assert.equal(event.label, 'L0');
  assert.equal(event.task_id, TASK);
  assert.deepEqual(Object.keys(event.payload).sort(), ['bytes', 'decision', 'runId', 'tool']);
  assert.equal(event.payload.decision, 'allow');
  assert.doesNotMatch(JSON.stringify(events), /router|kb\/work/);
});

test('an L2 page is refused with the fixed text: one blocked row, the same answer as a missing page', async () => {
  const before = (await logRows()).length;
  const privatePage = await call('kb_read', { path: 'kb/private/caldaia.md' });
  const missing = await call('kb_read', { path: 'kb/private/nessuna.md' });
  assert.deepEqual(privatePage, { isError: true, text: DENIED_TEXT });
  assert.deepEqual(missing, privatePage);
  const rows = (await logRows()).slice(before);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual({ decision: row.decision, rule: row.rule, label: row.label, summary: row.summary }, { decision: 'block', rule: 'cloud-label', label: 'L2', summary: null });
});

test('a search finds the L1 page and never the private one', async () => {
  const answer = await call('kb_search', { query: 'caldaia router' });
  assert.match(answer.text, /kb\/work\/router\.md/);
  assert.doesNotMatch(answer.text, /caldaia|private/i);
});

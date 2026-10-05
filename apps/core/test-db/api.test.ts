import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import WebSocket from 'ws';

import { resolveHome } from '@arianna/config';

import { applyDeclassify } from '../src/gateway.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepContext, type StepExecutor, type StepOutcome } from '../src/engine.ts';
import { recordFailure } from '../src/failures.ts';
import { createJobQueue } from '../src/jobs.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { openReply } from '../src/reply.ts';
import { startApiServer, type ApiServer, MAX_BODY_BYTES } from '../src/server/http.ts';
import { loadTask } from '../src/tasks.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
let live: LiveFeed;
let server: ApiServer;
let origin: string;
// What the configuration offers now (D-071): tests change it.
let offered = ['sonnet', 'opus'];
let defaultModel: string | undefined;
// A built web chat, made up for the test, in data/ (never in git).
const staticDir = join(resolveHome({}), 'data', 'test-tmp', randomUUID());

before(async () => {
  database = await createTestDatabase();
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Arianna</title>');
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  live = await startLiveFeed(db().sql);
  server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    staticDir,
    projects: () => [{ name: 'fake-site', path: 'repos/fake-site', label: 'L1' }],
    models: () => offered.map((model) => ({ executor: 'claude', model })),
    defaultModel: () => defaultModel,
  });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

after(async () => {
  await server.close();
  await live.close();
  await database?.close();
  rmSync(staticDir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  text: string;
}

/** node:http, not fetch: with NODE_USE_ENV_PROXY fetch would send loopback requests to a proxy. */
function call(method: string, path: string, options: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      {
        method,
        agent: false,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          ...(method === 'GET' ? {} : { origin }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = undefined;
          try {
            body = JSON.parse(text);
          } catch {
            // Not JSON (static files).
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** A field of a JSON reply, typed by the caller: the test checks its shape. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed accessor for test assertions
function field<T>(reply: Reply, key: string): T {
  return (reply.body as Record<string, T>)[key] as T;
}

async function newConversation(mode: 'work' | 'private'): Promise<string> {
  const reply = await call('POST', '/api/conversations', { body: { mode } });
  assert.equal(reply.status, 201);
  return field<{ id: string }>(reply, 'conversation').id;
}

test('the chat round trip: open a conversation, write, read the history', async () => {
  const id = await newConversation('private');
  const sent = await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Ciao Arianna' } });
  assert.equal(sent.status, 201);
  const task = field<{ id: string; conversationId: string; status: string }>(sent, 'task');
  assert.deepEqual([task.conversationId, task.status], [id, 'ready']);

  const history = await call('GET', `/api/conversations/${id}/messages`);
  assert.equal(history.status, 200);
  assert.deepEqual(field<{ body: string; label: string }[]>(history, 'messages').map((message) => [message.body, message.label]), [['Ciao Arianna', 'L2']]);
  assert.equal(history.headers['cache-control'], 'no-store');

  const listed = await call('GET', '/api/conversations');
  assert.ok(field<{ id: string }[]>(listed, 'conversations').some((conversation) => conversation.id === id));
  assert.equal(field<{ id: string }>(await call('GET', `/api/tasks/${task.id}`), 'task').id, task.id);
});

test('requests from another site, or for another host, are refused', async () => {
  const id = await newConversation('private');
  const evilOrigin = await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'x' }, headers: { origin: 'http://evil.example' } });
  assert.equal(evilOrigin.status, 403);
  const rebinding = await call('GET', `/api/conversations/${id}/messages`, { headers: { host: `evil.example:${String(server.port)}` } });
  assert.equal(rebinding.status, 403);
  assert.equal(rebinding.text.includes('messages'), false);
  const form = await call('POST', `/api/conversations/${id}/messages`, { raw: 'body=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  // Nothing was written by the refused requests.
  assert.deepEqual(field<unknown[]>(await call('GET', `/api/conversations/${id}/messages`), 'messages'), []);
});

test('a work conversation may name an approved project, listed by GET /api/projects (D-058)', async () => {
  assert.deepEqual(field<unknown[]>(await call('GET', '/api/projects'), 'projects'), [{ name: 'fake-site', path: 'repos/fake-site', label: 'L1' }]);
  const reply = await call('POST', '/api/conversations', { body: { mode: 'work', project: 'fake-site' } });
  assert.equal(reply.status, 201);
  assert.equal(field<{ workspace: string }>(reply, 'conversation').workspace, 'fake-site');
});

test('a work conversation chooses a cloud model among those of the installation; a private one has none', async () => {
  assert.deepEqual(field<{ model: string }[]>(await call('GET', '/api/models'), 'models').map((entry) => entry.model), ['sonnet', 'opus']);
  const work = await newConversation('work');
  const chosen = await call('POST', `/api/conversations/${work}/model`, { body: { model: 'opus' } });
  assert.equal(chosen.status, 200);
  assert.equal(field<{ model: string | null }>(chosen, 'conversation').model, 'opus');
  assert.equal(field<{ model: string | null }>(await call('GET', `/api/conversations/${work}`), 'conversation').model, 'opus');
  const cleared = await call('POST', `/api/conversations/${work}/model`, { body: { model: null } });
  assert.equal(field<{ model: string | null }>(cleared, 'conversation').model, null);
  assert.equal((await call('POST', `/api/conversations/${work}/model`, { body: { model: 'fable' } })).status, 400);
  assert.equal((await call('POST', `/api/conversations/${work}/model`, { body: { model: 'gpt-5' } })).status, 400);
  const priv = await newConversation('private');
  assert.equal((await call('POST', `/api/conversations/${priv}/model`, { body: { model: 'sonnet' } })).status, 400);
});

test('a new work conversation starts with the model of its agent while it is offered (D-071, D-116)', async () => {
  const modelOf = async (mode: 'work' | 'private') =>
    field<{ model: string | null }>(await call('GET', `/api/conversations/${await newConversation(mode)}`), 'conversation').model;
  try {
    assert.equal(await modelOf('work'), null, 'no default: the router chooses');
    defaultModel = 'opus';
    assert.equal(await modelOf('work'), 'opus');
    assert.equal(await modelOf('private'), null, 'a private conversation stays local');
    offered = ['sonnet'];
    assert.equal(await modelOf('work'), null, 'a default no longer offered is not given');
  } finally {
    offered = ['sonnet', 'opus'];
    defaultModel = undefined;
  }
});

test('the system chat of a failed work task is answered by Opus when Sonnet is off (D-071)', async () => {
  const id = await newConversation('work');
  const taskId = field<{ id: string }>(await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Domanda finta' } }), 'task').id;
  await db().owner`UPDATE jobs SET status = 'failed' WHERE key = ${`task:${taskId}`}`;
  await db().owner`UPDATE tasks SET status = 'failed' WHERE id = ${taskId}`;
  await recordFailure(db().sql, taskId, { origin: 'local-model', code: 'local-model.unavailable', details: { endpoint: 'omlx', port: 7001 } });
  offered = ['opus', 'fable'];
  try {
    const opened = await call('POST', `/api/tasks/${taskId}/system-chat`, { body: {} });
    assert.equal(field<{ model: string | null }>(opened, 'conversation').model, 'opus');
  } finally {
    offered = ['sonnet', 'opus'];
  }
});

test('a conversation is renamed, archived and restored through the API', async () => {
  const id = await newConversation('private');
  const renamed = await call('POST', `/api/conversations/${id}/title`, { body: { title: 'Conti finti' } });
  assert.equal(renamed.status, 200);
  assert.equal(field<{ title: string | null }>(renamed, 'conversation').title, 'Conti finti');
  assert.equal((await call('POST', `/api/conversations/${id}/title`, { body: { title: '' } })).status, 400);
  assert.equal((await call('POST', `/api/conversations/${id}/title`, { body: { title: 'x', extra: 1 } })).status, 400);

  const archived = await call('POST', `/api/conversations/${id}/archive`, { body: { archived: true } });
  assert.equal(archived.status, 200);
  const ids = (reply: Reply): string[] => field<{ id: string }[]>(reply, 'conversations').map((conversation) => conversation.id);
  assert.ok(!ids(await call('GET', '/api/conversations')).includes(id));
  assert.ok(ids(await call('GET', '/api/conversations?archived=1')).includes(id));
  assert.equal((await call('GET', '/api/conversations?archived=yes')).status, 400);
  assert.equal((await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Ancora?' } })).status, 409);
  assert.equal((await call('POST', `/api/conversations/${id}/archive`, { body: { archived: 'true' } })).status, 400);

  await call('POST', `/api/conversations/${id}/archive`, { body: { archived: false } });
  assert.ok(ids(await call('GET', '/api/conversations')).includes(id));
  assert.equal((await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Di nuovo qui' } })).status, 201);
});

test('only an archived conversation with no task at work is deleted for good through the API', async () => {
  const id = await newConversation('private');
  assert.equal((await call('POST', `/api/conversations/${id}/purge`, { body: {} })).status, 400);
  await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Messaggio finto' } });
  await call('POST', `/api/conversations/${id}/archive`, { body: { archived: true } });
  // Its task waits in the queue: no worker runs in this test.
  assert.equal((await call('POST', `/api/conversations/${id}/purge`, { body: {} })).status, 409);
  const empty = await newConversation('private');
  await call('POST', `/api/conversations/${empty}/archive`, { body: { archived: true } });
  assert.equal((await call('POST', `/api/conversations/${empty}/purge`, { body: { force: true } })).status, 400);
  const purged = await call('POST', `/api/conversations/${empty}/purge`, { body: {} });
  assert.equal(purged.status, 200);
  assert.equal((await call('GET', `/api/conversations/${empty}`)).status, 404);
  assert.equal((await call('POST', `/api/conversations/${empty}/purge`, { body: {} })).status, 404);
  assert.equal((await call('POST', '/api/conversations/not-a-uuid/purge', { body: {} })).status, 404);
});

test('bad input gets a clear status and no internal detail', async () => {
  const id = await newConversation('work');
  const cases: [string, string, Parameters<typeof call>[2], number][] = [
    ['POST', '/api/conversations', { body: { mode: 'public' } }, 400],
    ['POST', '/api/conversations', { body: { mode: 'work', admin: true } }, 400],
    ['POST', '/api/conversations', { body: { mode: 'work', project: 'other' } }, 400],
    ['POST', '/api/conversations', { body: { mode: 'work', project: 7 } }, 400],
    ['POST', '/api/conversations', { body: { mode: 'work', workspace: 'repos/fake-site' } }, 400],
    ['POST', `/api/conversations/${id}/messages`, { raw: '{not json' }, 400],
    ['POST', `/api/conversations/${id}/messages`, { body: ['array'] }, 400],
    ['POST', `/api/conversations/${id}/messages`, { body: { body: '' } }, 400],
    ['POST', `/api/conversations/${id}/messages`, { body: { body: 'Paga IT60X0542811101000000123456' } }, 422],
    ['POST', `/api/conversations/${id}/messages`, { raw: JSON.stringify({ body: 'x'.repeat(MAX_BODY_BYTES) }) }, 413],
    ['GET', '/api/conversations/not-a-uuid/messages', {}, 404],
    ['GET', `/api/conversations/${randomUUID()}`, {}, 404],
    ['GET', `/api/conversations/${id}/messages?limit=100000`, {}, 400],
    ['GET', `/api/conversations/${id}/messages?before=1;DROP`, {}, 400],
    ['DELETE', `/api/conversations/${id}`, { headers: { 'content-type': 'application/json' } }, 405],
    ['GET', '/api/nothing', {}, 404],
    ['GET', '/api/approvals?state=all', {}, 400],
  ];
  for (const [method, path, options, status] of cases) {
    const reply = await call(method, path, options);
    assert.equal(reply.status, status, `${method} ${path}`);
    assert.equal(typeof field<string>(reply, 'error'), 'string', `${method} ${path}`);
    assert.doesNotMatch(reply.text, /IT60X|stack|at \//, `${method} ${path}`);
  }
});

test('the built web chat is served, and nothing outside its folder', async () => {
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.text, /<title>Arianna<\/title>/);
  assert.match(String(index.headers['content-security-policy']), /frame-ancestors 'none'/);
  const script = await call('GET', '/assets/app.js');
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  // Client-side routes get the page; escapes get the page, never the file.
  assert.match((await call('GET', '/chat/123')).text, /<title>Arianna/);
  for (const path of ['/../../config/arianna.toml', '/%2e%2e/%2e%2e/config/arianna.toml', '/..%2f..%2fconfig%2farianna.toml']) {
    const reply = await call('GET', path);
    assert.doesNotMatch(reply.text, /\[database\]/, path);
  }
});

interface Socket {
  messages: Record<string, unknown>[];
  ws: WebSocket;
  until(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

function openSocket(path: string, headers: Record<string, string> = { origin }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}${path}`, { headers });
    const messages: Record<string, unknown>[] = [];
    const waiters: { predicate: (message: Record<string, unknown>) => boolean; resolve: (message: Record<string, unknown>) => void }[] = [];
    ws.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    ws.on('open', () => {
      resolve({
        messages,
        ws,
        until(predicate) {
          const found = messages.find(predicate);
          if (found !== undefined) return Promise.resolve(found);
          return new Promise((done, fail) => {
            const timer = setTimeout(() => { fail(new Error('timed out waiting on the socket')); }, 5_000);
            waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); done(message); } });
          });
        },
      });
    });
    ws.on('unexpected-response', (_request, response) => { reject(new Error(`handshake refused: ${String(response.statusCode)}`)); });
    ws.on('error', reject);
  });
}

const isEvent = (kind: string) => (message: Record<string, unknown>) =>
  message.type === 'event' && (message.event as { kind: string }).kind === kind;

test('the socket sends the missed events, then live events and reply fragments', async () => {
  const id = await newConversation('private');
  const socket = await openSocket('/api/ws?after=0');
  try {
    await socket.until((message) => message.type === 'ready');
    // The backlog includes the creation of this conversation.
    assert.ok(socket.messages.some((message) => isEvent('conversation.created')(message) && (message.event as { payload: { conversationId: string } }).payload.conversationId === id));

    const sent = await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Ciao' } });
    const taskId = field<{ id: string }>(sent, 'task').id;
    await socket.until((message) => isEvent('message.created')(message) && (message.event as { taskId: string }).taskId === taskId);

    const reply = await openReply(db().sql, taskId);
    await reply.delta('Eccomi');
    const delta = await socket.until((message) => message.type === 'delta' && message.replyId === reply.id);
    assert.deepEqual([delta.text, delta.conversationId, delta.seq], ['Eccomi', id, 0]);

    // Ids only in events: the socket never carries a message body except in fragments.
    const ids = socket.messages.filter((message) => message.type === 'event').map((message) => Number((message.event as { id: string }).id));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    socket.ws.close();
  }
});

test('a socket from another site is refused at the handshake', async () => {
  await assert.rejects(openSocket('/api/ws', { origin: 'http://evil.example' }), /403/);
  await assert.rejects(openSocket('/api/ws', {}), /403/);
  await assert.rejects(openSocket('/api/ws', { origin, host: 'evil.example' }), /403/);
});

test('an oversized frame closes that socket, and the core keeps running', async () => {
  const socket = await openSocket('/api/ws');
  const closed = new Promise<void>((resolve) => socket.ws.on('close', () => { resolve(); }));
  socket.ws.send('x'.repeat(10_000));
  await closed;
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('a socket asking for events from the future still gets the live ones', async () => {
  const socket = await openSocket('/api/ws?after=999999999999');
  try {
    await socket.until((message) => message.type === 'ready');
    const id = await newConversation('private');
    await socket.until((message) => isEvent('conversation.created')(message) && (message.event as { payload: { conversationId: string } }).payload.conversationId === id);
  } finally {
    socket.ws.close();
  }
});

test('a chunked body over the limit is refused without content-length', async () => {
  const id = await newConversation('private');
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${origin}/api/conversations/${id}/messages`, {
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', origin, 'transfer-encoding': 'chunked' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      // The server may close before the whole body is sent.
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve(413);
      else reject(error);
    });
    request.write('{"body":"');
    request.write('x'.repeat(MAX_BODY_BYTES));
    request.end('"}');
  });
  assert.equal(status, 413);
});

test('the socket accepts nothing from the client', async () => {
  const socket = await openSocket('/api/ws');
  const closed = new Promise<number>((resolve) => socket.ws.on('close', (code) => { resolve(code); }));
  socket.ws.send('{"type":"decide","approvalId":"x"}');
  assert.equal(await closed, 1008);
});

test('notifications (I-1): a page says whether it is in view, notices reach every page, nothing else is accepted', async () => {
  const socket = await openSocket('/api/ws');
  try {
    await socket.until((message) => message.type === 'ready');
    assert.equal(server.visiblePages(), 0);
    socket.ws.send('{"type":"visibility","visible":true}');
    const deadline = Date.now() + 5_000;
    while (server.visiblePages() !== 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(server.visiblePages(), 1);
    server.broadcast({ kind: 'reply', conversationId: '11111111-2222-4333-8444-555555555555' });
    const notice = await socket.until((message) => message.type === 'notice');
    assert.deepEqual(notice, { type: 'notice', kind: 'reply', conversationId: '11111111-2222-4333-8444-555555555555' });
    socket.ws.send('{"type":"visibility","visible":false}');
    while (server.visiblePages() !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(server.visiblePages(), 0);
    const closed = new Promise<number>((resolve) => socket.ws.on('close', (code) => { resolve(code); }));
    socket.ws.send('{"type":"visibility","visible":true,"text":"x"}');
    assert.equal(await closed, 1008);
    assert.equal(server.visiblePages(), 0);
  } finally {
    socket.ws.close();
  }
  // Without a board: nothing recent to tell the service worker.
  const response = await fetch(`${origin}/api/notifications/latest`);
  assert.deepEqual(await response.json(), { notice: null });
});

/** A step executor for the declassification path: ask, then use the decided approval. */
function declassifier(): StepExecutor & { seen: StepContext[] } {
  const seen: StepContext[] = [];
  return {
    seen,
    plan: () => ({ agent: 'arianna', executor: 'local-model', locality: 'local' }),
    async run(ctx): Promise<StepOutcome> {
      seen.push(ctx);
      if (ctx.approval === undefined) return { kind: 'declassify', text: 'Brief finto per Claude Code', to: 'L1' };
      if (ctx.approval.state !== 'approved') return { kind: 'wait-user', reason: 'the user refused the brief' };
      const lowered = await applyDeclassify(db().sql, { value: 'Brief finto per Claude Code', label: 'L2', source: `task:${ctx.task.id}` }, 'L1', ctx.approval.id);
      const reply = await openReply(db().sql, ctx.task.id, { runId: ctx.runId });
      await reply.finish(`Inviato: ${lowered.label}`, 'L2');
      return { kind: 'done', evidence: [{ kind: 'declassified', label: lowered.label }] };
    },
  };
}

/** Runs every queued step (earlier tests leave some); returns the results of `taskId`'s steps. */
async function drain(executor: StepExecutor, taskId: string): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (;;) {
    const job = await queue.claim(STEP_QUEUE, 'api-test');
    if (job === undefined) return results;
    const result = await processStepJob(db().sql, executor, job, 'api-test', {
      allowedActions: () => [],
      agentLimits: () => ({ maxSteps: 10, maxMinutes: 10 }),
    });
    if (job.payload.taskId === taskId) results.push(result);
  }
}

test('a declassification is shown with its exact text and approved from the chat', async () => {
  const id = await newConversation('private');
  const sent = await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Chiedi a Claude Code di sistemare il sito finto' } });
  const taskId = field<{ id: string }>(sent, 'task').id;
  const executor = declassifier();
  assert.deepEqual(await drain(executor, taskId), ['waiting-approval']);

  const pending = field<{ id: string; taskId: string; kind: string; detail: { text: string; from: string; to: string } }[]>(
    await call('GET', '/api/approvals?state=pending'),
    'approvals',
  ).find((approval) => approval.taskId === taskId);
  assert.ok(pending !== undefined);
  assert.deepEqual([pending.kind, pending.detail.text, pending.detail.from, pending.detail.to], ['declassify', 'Brief finto per Claude Code', 'L2', 'L1']);
  assert.equal((await loadTask(db().sql, taskId))?.waitingApprovalId, pending.id);

  const decided = await call('POST', `/api/approvals/${pending.id}/decision`, { body: { state: 'approved' } });
  assert.equal(decided.status, 200);
  assert.deepEqual([field<{ state: string; decidedVia: string }>(decided, 'approval').state, field<{ decidedVia: string }>(decided, 'approval').decidedVia], ['approved', 'web']);
  assert.equal((await call('POST', `/api/approvals/${pending.id}/decision`, { body: { state: 'rejected' } })).status, 409);

  assert.deepEqual(await drain(executor, taskId), ['to-verify']);
  assert.equal(executor.seen.at(-1)?.approval?.id, pending.id);
  const [change] = await db().sql<{ subject: string; from_label: string; to_label: string; approval_id: string }[]>`
    SELECT subject, from_label, to_label, approval_id::text FROM label_changes WHERE approval_id = ${pending.id}`;
  assert.deepEqual([change?.from_label, change?.to_label], ['L2', 'L1']);

  const history = field<{ role: string; body: string }[]>(await call('GET', `/api/conversations/${id}/messages`), 'messages');
  assert.deepEqual(history.map((message) => message.role), ['user', 'assistant']);
});

test('a rejected declassification lets nothing out and the task hears it', async () => {
  const id = await newConversation('private');
  const sent = await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Altro brief' } });
  const taskId = field<{ id: string }>(sent, 'task').id;
  const executor = declassifier();
  await drain(executor, taskId);
  const [approval] = await db().sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${taskId}`;
  assert.ok(approval !== undefined);
  assert.equal((await call('POST', `/api/approvals/${approval.id}/decision`, { body: { state: 'rejected' } })).status, 200);
  assert.deepEqual(await drain(executor, taskId), ['waiting-user']);
  const [{ count } = { count: '' }] = await db().sql<{ count: string }[]>`SELECT count(*)::text AS count FROM label_changes WHERE approval_id = ${approval.id}`;
  assert.equal(count, '0');
});

test('the engine refuses a declassification that lowers nothing', async () => {
  const id = await newConversation('work');
  const sent = await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Brief di lavoro' } });
  const taskId = field<{ id: string }>(sent, 'task').id;
  const executor: StepExecutor = {
    plan: () => ({ agent: 'arianna', executor: 'local-model', locality: 'local' }),
    run: () => Promise.resolve({ kind: 'declassify', text: 'già L1', to: 'L1' }),
  };
  assert.deepEqual(await drain(executor, taskId), ['waiting-user']);
  assert.equal((await loadTask(db().sql, taskId))?.waitingReason, 'the agent asked for an invalid declassification');
  const approvals = await db().sql`SELECT 1 FROM approvals WHERE task_id = ${taskId}`;
  assert.equal(approvals.length, 0);
});

test('decided approvals come newest first, with the channel they were decided from', async () => {
  const ids: string[] = [];
  for (const via of ['web', 'telegram', 'telegram'] as const) {
    const [row] = await db().sql<{ id: string }[]>`
      INSERT INTO approvals (kind, action, detail, label) VALUES ('action', 'send_external', '{}', 'L1') RETURNING id::text`;
    assert.ok(row);
    await recordDecision(db().sql, row.id, 'approved', via);
    ids.push(row.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const reply = await call('GET', '/api/approvals?state=approved&limit=200');
  const listed = (reply.body as { approvals: { id: string; decidedVia: string }[] }).approvals.filter((approval) => ids.includes(approval.id));
  assert.deepEqual(
    listed.map((approval) => [approval.id, approval.decidedVia]),
    [
      [ids[2], 'telegram'],
      [ids[1], 'telegram'],
      [ids[0], 'web'],
    ],
  );
});

test('a failed task: its error, the system chat with the question on request, and retry', async () => {
  const id = await newConversation('private');
  const sent = await call('POST', `/api/conversations/${id}/messages`, { body: { body: 'Domanda finta' } });
  const taskId = field<{ id: string }>(sent, 'task').id;
  assert.deepEqual(field(await call('GET', `/api/tasks/${taskId}/error`), 'error'), null);
  assert.equal((await call('POST', `/api/tasks/${taskId}/system-chat`, { body: {} })).status, 400, 'no error, no system chat');
  assert.equal((await call('POST', `/api/tasks/${taskId}/retry`, { body: {} })).status, 409, 'only a failed task');

  await db().owner`UPDATE jobs SET status = 'failed' WHERE key = ${`task:${taskId}`}`;
  await db().owner`UPDATE tasks SET status = 'failed' WHERE id = ${taskId}`;
  await recordFailure(db().sql, taskId, { origin: 'local-model', code: 'local-model.unavailable', details: { endpoint: 'omlx', port: 7001 } });
  const error = field<{ code: string; origin: string; details: Record<string, unknown>; label: string }>(await call('GET', `/api/tasks/${taskId}/error`), 'error');
  assert.deepEqual([error.origin, error.code, error.details, error.label], ['local-model', 'local-model.unavailable', { endpoint: 'omlx', port: 7001 }, 'L2']);

  const opened = await call('POST', `/api/tasks/${taskId}/system-chat`, { body: {} });
  assert.equal(opened.status, 200);
  const chat = field<{ id: string; origin: string; sourceTaskId: string; sourceConversationId: string }>(opened, 'conversation');
  assert.deepEqual([chat.origin, chat.sourceTaskId, chat.sourceConversationId], ['system', taskId, id]);
  const listed = field<{ id: string }[]>(await call('GET', '/api/conversations?origin=system'), 'conversations');
  assert.ok(listed.some((item) => item.id === chat.id));
  assert.ok(!field<{ id: string }[]>(await call('GET', '/api/conversations'), 'conversations').some((item) => item.id === chat.id));
  assert.equal((await call('GET', '/api/conversations?origin=other')).status, 400);
  assert.equal((await call('GET', '/api/conversations?origin=system&archived=1')).status, 400);
  assert.equal(field<boolean>(await call('GET', `/api/tasks/${taskId}/error`), 'current'), true);

  assert.equal((await call('POST', `/api/conversations/${chat.id}/question`, { body: {} })).status, 201);
  assert.equal((await call('POST', `/api/conversations/${chat.id}/question`, { body: {} })).status, 400, 'once');
  assert.equal((await call('POST', `/api/conversations/${id}/question`, { body: {} })).status, 400, 'system chats only');
  assert.equal((await call('POST', `/api/conversations/${chat.id}/question`, { body: { text: 'x' } })).status, 400, 'no fields');

  const retried = await call('POST', `/api/tasks/${taskId}/retry`, { body: {} });
  assert.equal(retried.status, 200);
  assert.equal(field<{ status: string }>(retried, 'task').status, 'ready');
  assert.equal(field<boolean>(await call('GET', `/api/tasks/${taskId}/error`), 'current'), false, 'the error is history once retried');
  assert.equal((await call('POST', '/api/tasks/00000000-0000-4000-8000-000000000000/retry', { body: {} })).status, 404);
  assert.equal((await call('GET', '/api/tasks/00000000-0000-4000-8000-000000000000/error')).status, 404);
});

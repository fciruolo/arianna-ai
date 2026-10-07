// Incognito conversations in the core (D-136, I-4 tappa 2), against PostgreSQL:
// the API of the contract in docs/I-4-incognito.md, the exclusions, the
// closing (button, start-up) with the work in progress stopped, the canary.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import WebSocket from 'ws';

import { DEFAULT_VOICE, parseLabelRules, resolveHome } from '@arianna/config';

import { ChatError, createConversation, postUserMessage } from '../src/conversations.ts';
import { createWorker, type StepExecutor } from '../src/engine.ts';
import { appendEvent } from '../src/events.ts';
import { recordFailure } from '../src/failures.ts';
import { closeIncognito, closeIncognitoAtStart, haltIncognito, isIncognitoTask, localCacheOn } from '../src/incognito.ts';
import { createCalls, type Calls } from '../src/voice/calls.ts';
import { postLiveEdit } from '../src/live-edit.ts';
import { scheduleCall, callWhenDone } from '../src/voice/ringer.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { openReply, postActivity } from '../src/reply.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { loadStatus } from '../src/status.ts';
import { openFailureChat } from '../src/system-chats.ts';
import { canaryPlaces, newCanary } from './support/canary.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
let live: LiveFeed;
let server: ApiServer;
let origin: string;
const home = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
const RULES = parseLabelRules('');
const PROJECT = 'fake-site';
// What the configuration says now: a local server with the cache on the SSD; a closing made to fail.
let ssdCache = false;
let closeFails: Error | undefined;
/** The conversations whose call reached the voice (a stub). */
const started: string[] = [];

before(async () => {
  database = await createTestDatabase();
  mkdirSync(join(home, 'kb', 'inbox'), { recursive: true });
  live = await startLiveFeed(db().sql);
  server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    capture: { home, rules: RULES },
    projects: () => [{ name: PROJECT, path: 'repos/fake-site', label: 'L1' }],
    models: () => [{ executor: 'claude', model: 'opus' }],
    directAgents: () => [{ agent: 'coder', description: 'Coder', cloud: true, modes: ['work'], project: true }],
    // The voice reads as on; a call that reaches the voice service is a mistake of the test.
    voice: { service: { state: 'up', request: () => Promise.reject(new Error('no voice in this test')) }, models: () => [], voice: () => 'voce', clones: '/srv/none' },
    calls: {
      start: (conversationId: string) => {
        started.push(conversationId);
        return Promise.resolve({ call: { id: randomUUID() }, answer: { sdp: 'v=0', type: 'answer' } });
      },
    } as unknown as Calls,
    incognito: {
      close: (id, cause) => (closeFails === undefined ? closeIncognito(db().sql, id, cause) : Promise.reject(closeFails)),
      localCache: () => ssdCache,
    },
  });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

after(async () => {
  await server.close();
  await live.close();
  await database?.close();
  rmSync(home, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      {
        method,
        agent: false,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          ...(method === 'GET' ? {} : { origin }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function newIncognito(mode: 'private' | 'work' = 'private'): Promise<string> {
  const created = await call('POST', '/api/conversations', { mode, incognito: true, ...(mode === 'work' ? { project: PROJECT } : {}) });
  assert.equal(created.status, 201);
  return (created.body.conversation as { id: string }).id;
}

/** A task of the conversation with its step job closed: as after an answer. */
async function quietMessage(conversationId: string, body: string): Promise<{ taskId: string; messageId: string }> {
  const { sql, owner } = db();
  const { task, message } = await postUserMessage(sql, conversationId, body);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  await owner`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'attesa' WHERE id = ${task.id}`;
  return { taskId: task.id, messageId: message.id };
}

test('creation: incognito with a mode, never with a direct agent; every conversation says whether it is', async () => {
  const created = await call('POST', '/api/conversations', { mode: 'private', incognito: true });
  assert.equal(created.status, 201);
  assert.deepEqual(
    (({ incognito, title, archivedAt, pinnedAt }) => ({ incognito, title, archivedAt, pinnedAt }))(created.body.conversation as Record<string, unknown>),
    { incognito: true, title: null, archivedAt: null, pinnedAt: null },
  );
  const work = await call('POST', '/api/conversations', { mode: 'work', project: PROJECT, incognito: true });
  assert.equal(work.status, 201);
  assert.equal((work.body.conversation as { workspace: string }).workspace, PROJECT);
  const normal = await call('POST', '/api/conversations', { mode: 'private' });
  assert.equal((normal.body.conversation as { incognito: boolean }).incognito, false);
  assert.equal((await call('POST', '/api/conversations', { mode: 'work', project: PROJECT, agent: 'coder', incognito: true })).status, 400);
  assert.equal((await call('POST', '/api/conversations', { mode: 'private', incognito: 'yes' })).status, 400);
  await assert.rejects(
    createConversation(db().sql, { mode: 'work', project: PROJECT, projects: [PROJECT], incognito: true, agent: { name: 'coder', modes: ['work'], project: true } }),
    (error: unknown) => error instanceof ChatError && error.code === 'invalid',
  );
});

test('a message of an incognito titles neither the conversation nor its task', async () => {
  const { sql } = db();
  const id = await newIncognito();
  const { task } = await postUserMessage(sql, id, 'Il mio segreto di oggi');
  assert.equal(task.title, 'Incognito');
  const read = await call('GET', `/api/conversations/${id}`);
  assert.equal((read.body.conversation as { title: string | null }).title, null);
  assert.equal((await call('GET', `/api/conversations/${id}/messages`)).status, 200);
  // Elsewhere the first message still names both.
  const normal = await createConversation(sql, { mode: 'private' });
  assert.equal((await postUserMessage(sql, normal.id, 'Il mio segreto di oggi')).task.title, 'Il mio segreto di oggi');
});

test('an incognito is in no list, search, status nor list of delegations; its waits and approvals say incognito', async () => {
  const { sql, owner } = db();
  const id = await newIncognito('work');
  const word = `parolarara${randomUUID().slice(0, 8)}`;
  const { taskId } = await quietMessage(id, `Domanda con ${word}`);
  const normal = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, normal.id, `Altra con ${word}`);

  for (const path of ['/api/conversations', '/api/conversations?archived=1', '/api/conversations?origin=system']) {
    const ids = ((await call('GET', path)).body.conversations as { id: string }[]).map((item) => item.id);
    assert.ok(!ids.includes(id), path);
  }
  assert.ok(((await call('GET', '/api/conversations')).body.conversations as { id: string }[]).some((item) => item.id === normal.id));
  const found = (await call('GET', `/api/search?q=${word}`)).body as { messages: { conversationId: string }[] };
  assert.deepEqual(found.messages.map((hit) => hit.conversationId), [normal.id]);

  // Approvals and waits: listed with the flag and the conversation, for the chat to show in that page only.
  const [approval] = await owner<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${taskId}, 'budget', 'budget', ${owner.json({ model: 'opus' })}, 'L0') RETURNING id::text`;
  const listed = ((await call('GET', '/api/approvals')).body.approvals as { id: string; incognito: boolean; conversationId: string }[]).find((item) => item.id === approval?.id);
  assert.deepEqual(listed && { incognito: listed.incognito, conversationId: listed.conversationId }, { incognito: true, conversationId: id });
  const only = (await call('GET', `/api/approvals?conversation=${normal.id}`)).body.approvals as unknown[];
  assert.deepEqual(only, []);
  const mine = (await call('GET', `/api/approvals?conversation=${id}`)).body.approvals as { id: string }[];
  assert.deepEqual(mine.map((item) => item.id), [approval?.id]);
  const waiting = ((await call('GET', '/api/tasks/waiting')).body.tasks as { id: string; incognito: boolean }[]).find((item) => item.id === taskId);
  assert.equal(waiting?.incognito, true);

  // The status panel and the office: no run, no wait of an incognito.
  const before = (await loadStatus(sql, ['arianna'])).waiting;
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, model) VALUES (${taskId}, 1, 'coder', 'claude', 'cloud', 'opus') RETURNING id::text`;
  const status = await loadStatus(sql, ['coder']);
  assert.equal(status.agents[0]?.state, 'idle');
  assert.equal(status.waiting, before);
  await owner`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, repo, run_id) VALUES (${taskId}, 2, 'coder', 'brief', 'L1', ${PROJECT}, ${run?.id ?? ''})`;
  const recent = (await call('GET', '/api/delegations')).body.delegations as { conversationId: string | null }[];
  assert.ok(!recent.some((item) => item.conversationId === id));
  await owner`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${run?.id ?? ''}`;
});

test('title, archive and pin of an incognito answer 409; of a normal conversation they work', async () => {
  const id = await newIncognito();
  assert.deepEqual(await call('POST', `/api/conversations/${id}/title`, { title: 'Nome' }), { status: 409, body: { error: 'incognito' } });
  assert.equal((await call('POST', `/api/conversations/${id}/archive`, { archived: true })).status, 409);
  assert.equal((await call('POST', `/api/conversations/${id}/pin`)).status, 409);
  const normal = (await createConversation(db().sql, { mode: 'private' })).id;
  assert.equal((await call('POST', `/api/conversations/${normal}/title`, { title: 'Nome' })).status, 200);
  assert.equal((await call('POST', `/api/conversations/${normal}/pin`)).status, 200);
});

test('saving from an incognito answers 409 and writes nothing; its saves read as none', async () => {
  const id = await newIncognito();
  const { messageId } = await quietMessage(id, 'Da non salvare');
  const before = readdirSync(join(home, 'kb', 'inbox')).length;
  assert.deepEqual(await call('POST', '/api/capture', { messageId }), { status: 409, body: { error: 'incognito' } });
  assert.deepEqual(await call('POST', '/api/capture', { text: 'nota', conversationId: id }), { status: 409, body: { error: 'incognito' } });
  assert.deepEqual(await call('POST', `/api/conversations/${id}/save`), { status: 409, body: { error: 'incognito' } });
  assert.equal(readdirSync(join(home, 'kb', 'inbox')).length, before);
  assert.deepEqual((await call('GET', `/api/conversations/${id}/saved`)).body, { messageIds: [], notes: {}, conversation: false, conversationNote: null, conversationSavedAt: null });
  assert.equal((await call('POST', '/api/capture', { text: 'nota', conversationId: 'x' })).status, 400);
  // From a normal conversation, /nota still saves.
  const normal = (await createConversation(db().sql, { mode: 'private' })).id;
  assert.equal((await call('POST', '/api/capture', { text: 'nota vera', conversationId: normal })).status, 201);
  assert.equal(readdirSync(join(home, 'kb', 'inbox')).length, before + 1);
});

test('the opening card: cloud only for work, the project only an approved one', async () => {
  assert.deepEqual((await call('GET', '/api/incognito/notice?mode=private')).body, { cloud: false, project: null, localCache: false });
  assert.deepEqual((await call('GET', `/api/incognito/notice?mode=work&project=${PROJECT}`)).body, { cloud: true, project: PROJECT, localCache: false });
  // A local server with the cache of the prompts on the SSD: the card names it (D-136).
  ssdCache = true;
  try {
    assert.deepEqual((await call('GET', '/api/incognito/notice?mode=private')).body, { cloud: false, project: null, localCache: true });
  } finally {
    ssdCache = false;
  }
  assert.equal(localCacheOn([{ command: ['omlx', 'serve', '--paged-ssd-cache-dir', 'data/omlx-cache'] }]), true);
  assert.equal(localCacheOn([{ command: ['sh', '-c', 'omlx serve --paged-ssd-cache-dir=data/c --port 7001'] }]), true);
  assert.equal(localCacheOn([{ command: ['omlx', 'serve', '--port', '7001'] }, {}]), false);
  assert.equal(localCacheOn([{ command: ['omlx', '--paged-ssd-cache-dirs', 'x'] }]), false);
  assert.equal((await call('GET', '/api/incognito/notice?mode=work&project=altro')).status, 400);
  assert.equal((await call('GET', `/api/incognito/notice?mode=private&project=${PROJECT}`)).status, 400);
  assert.equal((await call('GET', '/api/incognito/notice')).status, 400);
});

test('no system chat about a task of an incognito: its error stays in the conversation', async () => {
  const { sql, owner } = db();
  const id = await newIncognito();
  const { taskId } = await quietMessage(id, 'Domanda');
  assert.equal(await isIncognitoTask(sql, taskId), true);
  await owner`UPDATE tasks SET status = 'failed', waiting_reason = NULL WHERE id = ${taskId}`;
  await sql.begin((tx) => recordFailure(tx, taskId, { origin: 'engine', code: 'engine.step-failed', details: {} }));
  await assert.rejects(openFailureChat(sql, taskId), (error: unknown) => error instanceof ChatError && error.code === 'incognito');
  assert.equal((await call('POST', `/api/tasks/${taskId}/system-chat`)).status, 409);
});

test('"Termina": 409 for a normal conversation, 404 for none; the closing card with the canary gone', async () => {
  const { sql, owner, schema } = db();
  const normal = (await createConversation(sql, { mode: 'private' })).id;
  assert.deepEqual(await call('POST', `/api/conversations/${normal}/end`), { status: 409, body: { error: 'not incognito' } });
  assert.equal((await call('POST', `/api/conversations/${randomUUID()}/end`)).status, 404);

  const canary = newCanary();
  const id = await newIncognito('work');
  const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws`, { headers: { origin } });
  const frames: Record<string, unknown>[] = [];
  socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>));
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ type: 'visibility', visible: false, conversation: id }));
  await waitFor(() => server.pagesOn(id) === 1);

  const { taskId } = await quietMessage(id, `Domanda ${canary}`);
  await quietMessage(id, `Seconda ${canary}`);
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, model, session_ref) VALUES (${taskId}, 2, 'coder', 'claude', 'cloud', 'opus', ${`s-${canary}`}) RETURNING id::text`;
  const [delegation] = await owner<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, repo, run_id, status, result, result_label, ended_at)
    VALUES (${taskId}, 2, 'coder', ${`brief ${canary}`}, 'L1', ${PROJECT}, ${run?.id ?? ''}, 'ok', ${`rapporto ${canary}`}, 'L1', now()) RETURNING id::text`;
  await owner`UPDATE task_delegations SET files = ${owner.json([{ path: 'index.html', change: 'modified' }, { path: 'style.css', change: 'added' }])} WHERE id = ${delegation?.id ?? ''}`;
  await owner`
    INSERT INTO gateway_log (task_id, run_id, target_kind, target, locality, label, decision, rule, reason, bytes_out, summary)
    VALUES (${taskId}, ${run?.id ?? ''}, 'executor', 'claude', 'cloud', 'L1', 'allow', 'cloud-up-to-l1', 'L1 to cloud', 3200, 'delegated step for coder')`;
  await owner`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${run?.id ?? ''}`;
  await owner`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${taskId}, 1, 'search', ${`cerca ${canary}`}, 'L1')`;
  assert.ok((await canaryPlaces(owner, schema, canary)).length > 0);

  const ended = await call('POST', `/api/conversations/${id}/end`);
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.body, {
    // The second message closed the wait of the first: its line of the system goes too (D-109).
    deleted: { messages: 3, tasks: 2, summaries: 0 },
    remains: { files: [{ project: PROJECT, path: 'index.html' }, { project: PROJECT, path: 'style.css' }], cloud: [{ model: 'opus', bytes: 3200 }] },
  });
  assert.deepEqual(await canaryPlaces(owner, schema, canary), []);
  // The page hears it, the conversation is gone and says why; another conversation's 404 stays plain.
  await waitFor(() => frames.some((frame) => frame.type === 'conversation.incognito-closed'));
  assert.deepEqual(frames.find((frame) => frame.type === 'conversation.incognito-closed'), { type: 'conversation.incognito-closed', conversationId: id, cause: 'user' });
  socket.close();
  assert.deepEqual(await call('GET', `/api/conversations/${id}`), { status: 404, body: { error: 'not found', closed: 'user' } });
  assert.deepEqual(await call('GET', `/api/conversations/${randomUUID()}`), { status: 404, body: { error: 'not found' } });
  assert.equal((await call('POST', `/api/conversations/${id}/end`)).status, 404);
  const events = await owner<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM events WHERE payload ->> 'conversationId' = ${id} AND kind IN ('conversation.incognito-closed', 'conversation.purged') ORDER BY id`;
  assert.deepEqual(events.map((event) => event.kind), ['conversation.incognito-closed', 'conversation.purged']);
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('closing stops the step at work for good: the run is interrupted, the job fails, nothing goes back in the queue', async () => {
  const { sql, owner } = db();
  let started: string | undefined;
  let aborted: unknown;
  // A step that works until it is stopped, as a long run of the Coder.
  const executor: StepExecutor = {
    plan: () => ({ agent: 'arianna', executor: 'local-model', locality: 'local' }),
    run: (ctx) =>
      new Promise((_resolve, reject) => {
        started = ctx.task.id;
        ctx.signal.addEventListener('abort', () => {
          aborted = ctx.signal.reason;
          reject(new Error('stopped'));
        });
      }),
  };
  const worker = createWorker({
    sql,
    executor,
    allowedActions: () => [],
    agentLimits: () => ({ maxSteps: 10, maxMinutes: 10 }),
    pollMs: 10,
    retryAfterMs: 0,
  });
  const id = await newIncognito();
  // Only this step in the queue: the steps of the other tests never ran.
  await owner`UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE status IN ('queued', 'running')`;
  const { task } = await postUserMessage(sql, id, 'Lavoro lungo');
  await worker.start();
  try {
    await waitFor(() => started === task.id);
    assert.equal(worker.stopTask(randomUUID(), 'incognito'), false);
    const receipt = await closeIncognito(sql, id, 'user', { stopTask: (taskId) => worker.stopTask(taskId, 'incognito') });
    assert.equal(receipt.deleted.tasks, 1);
    assert.equal(aborted, 'incognito');
    const [state] = await owner<{ task: string; run: string; job: string }[]>`
      SELECT t.status AS task, (SELECT r.status FROM runs r WHERE r.task_id = t.id) AS run,
        (SELECT j.status FROM jobs j WHERE j.key = ${`task:${task.id}`} ORDER BY j.id DESC LIMIT 1) AS job
      FROM tasks t WHERE t.id = ${task.id}`;
    assert.deepEqual(state, { task: 'failed', run: 'interrupted', job: 'failed' });
    // Some time later the step has not come back.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const queued = await owner`SELECT 1 FROM jobs WHERE key = ${`task:${task.id}`} AND status IN ('queued', 'running')`;
    assert.equal(queued.length, 0);
    const [cause] = await owner<{ cause: string }[]>`
      SELECT payload ->> 'cause' AS cause FROM events WHERE task_id = ${task.id} AND kind = 'task.status' AND payload ->> 'to' = 'failed'`;
    assert.equal(cause?.cause, 'incognito');
  } finally {
    await worker.stop();
  }
});

test('at start-up every incognito left open closes with cause restart, its crashed run and job included; others stay', async () => {
  const { sql, owner } = db();
  const id = await newIncognito();
  const { task } = await postUserMessage(sql, id, 'Prima del crollo');
  // As a core killed mid-step leaves it: the job running, the run running.
  await owner`UPDATE jobs SET status = 'running', locked_at = now(), locked_by = 'dead-worker', attempts = 1 WHERE key = ${`task:${task.id}`}`;
  await owner`UPDATE tasks SET status = 'running' WHERE id = ${task.id}`;
  await owner`INSERT INTO runs (task_id, step, agent, executor, locality) VALUES (${task.id}, 1, 'arianna', 'local-model', 'local')`;
  const normal = (await createConversation(sql, { mode: 'private' })).id;

  const errors: unknown[] = [];
  assert.ok((await closeIncognitoAtStart(sql, (error) => errors.push(error))) >= 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(await call('GET', `/api/conversations/${id}`), { status: 404, body: { error: 'not found', closed: 'restart' } });
  assert.equal((await call('GET', `/api/conversations/${normal}`)).status, 200);
  const open = await owner`SELECT 1 FROM conversations WHERE incognito AND purged_at IS NULL`;
  assert.equal(open.length, 0);
});

test('the live frames of an incognito say so: activity, reply fragments and events; those of a normal conversation do not', async () => {
  const { sql } = db();
  const id = await newIncognito();
  const { task } = await postUserMessage(sql, id, 'Domanda');
  const normal = await createConversation(sql, { mode: 'private' });
  const other = await postUserMessage(sql, normal.id, 'Domanda');
  const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws`, { headers: { origin } });
  const frames: Record<string, unknown>[] = [];
  socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>));
  await new Promise((resolve) => socket.once('open', resolve));
  await waitFor(() => frames.some((frame) => frame.type === 'ready'));
  try {
    for (const [conversationId, taskId] of [[id, task.id], [normal.id, other.task.id]] as const) {
      await postActivity(sql, { conversationId, taskId, step: 1, kind: 'search', detail: 'cerca' });
      await postLiveEdit(sql, { conversationId, taskId, step: 1 }, { path: 'index.html', tool: 'Edit', label: 'L1', added: 1, removed: 0, lines: '+ciao' });
      const reply = await openReply(sql, taskId);
      await reply.delta('pezzo');
      await reply.finish('Risposta.', 'L2');
    }
    const of = (type: string, taskId: string) => frames.find((frame) => frame.type === type && frame.taskId === taskId);
    await waitFor(() => of('delta', other.task.id) !== undefined && of('activity', other.task.id) !== undefined);
    assert.equal(of('activity', task.id)?.incognito, true);
    assert.equal(of('delta', task.id)?.incognito, true);
    assert.equal(of('activity', other.task.id)?.incognito, undefined);
    await waitFor(() => of('edit', other.task.id) !== undefined);
    assert.equal(of('edit', task.id)?.incognito, true);
    assert.equal(of('edit', other.task.id)?.incognito, undefined);
    assert.equal(of('delta', other.task.id)?.incognito, undefined);
    const created = (taskId: string) =>
      frames.find((frame) => frame.type === 'event' && (frame.event as { kind: string; taskId: string }).kind === 'message.created' && (frame.event as { taskId: string }).taskId === taskId && ((frame.event as { payload: { role: string } }).payload.role === 'assistant'));
    await waitFor(() => created(other.task.id) !== undefined);
    assert.equal(created(task.id)?.incognito, true);
    assert.equal(created(other.task.id)?.incognito, undefined);
    // An event without a task is marked from its conversation: the closing of the incognito; a normal creation is not.
    await closeIncognito(sql, id, 'user');
    const eventOf = (kind: string, conversationId: string) =>
      frames.find((frame) => frame.type === 'event' && (frame.event as { kind: string }).kind === kind && (frame.event as { payload: { conversationId?: string } }).payload.conversationId === conversationId);
    await waitFor(() => eventOf('conversation.incognito-closed', id) !== undefined);
    assert.equal(eventOf('conversation.incognito-closed', id)?.incognito, true);
    const later = await createConversation(sql, { mode: 'private' });
    await waitFor(() => eventOf('conversation.created', later.id) !== undefined);
    assert.equal(eventOf('conversation.created', later.id)?.incognito, undefined);
  } finally {
    socket.close();
  }
});

test('an incognito has no calls: the routes answer 409 incognito, the functions refuse; a normal conversation schedules', async () => {
  const { sql } = db();
  const id = await newIncognito();
  const { taskId } = await quietMessage(id, 'Domanda');
  await sql`UPDATE tasks SET status = 'running', waiting_reason = NULL WHERE id = ${taskId}`;
  // The voice reads as on: an incognito is refused before the call reaches it.
  assert.deepEqual(await call('POST', '/api/calls', { conversationId: id, sdp: 'v=0', type: 'offer' }), { status: 409, body: { error: 'incognito' } });
  assert.deepEqual(await call('POST', '/api/calls/schedule', { conversationId: id, at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 409, body: { error: 'incognito' } });
  assert.deepEqual(await call('POST', `/api/tasks/${taskId}/call-when-done`), { status: 409, body: { error: 'incognito' } });
  await assert.rejects(scheduleCall(sql, id, new Date(Date.now() + 3_600_000)), (error: unknown) => error instanceof ChatError && error.code === 'incognito');
  await assert.rejects(callWhenDone(sql, taskId), (error: unknown) => error instanceof ChatError && error.code === 'incognito');
  const normal = (await createConversation(sql, { mode: 'private' })).id;
  assert.deepEqual(started, [], 'no call of the incognito reached the voice');
  // A normal conversation goes on to the voice (here a stub).
  assert.equal((await call('POST', '/api/calls', { conversationId: normal, sdp: 'v=0', type: 'offer' })).status, 201);
  assert.deepEqual(started, [normal]);
  // calls.start refuses an incognito by itself, before the voice; a normal conversation passes that check.
  const real = createCalls({
    sql,
    voice: { state: 'up', request: () => Promise.reject(new Error('no voice in this test')) },
    config: () => ({ roles: {}, voice: DEFAULT_VOICE, local: { endpoints: [] } }),
    candidates: () => [],
    model: () => { throw new Error('no model in this test'); },
    coreUrl: 'http://127.0.0.1:1',
  });
  await assert.rejects(real.start(id, { sdp: 'v=0', type: 'offer' }), (error: unknown) => error instanceof ChatError && error.code === 'incognito');
  await assert.rejects(real.start(normal, { sdp: 'v=0', type: 'offer' }), (error: unknown) => !(error instanceof ChatError));
  assert.equal((await scheduleCall(sql, normal, new Date(Date.now() + 3_600_000))).status, 'scheduled');
  await sql`UPDATE tasks SET status = 'failed' WHERE id = ${taskId}`;
});

test('closing cancels the calls still scheduled on the incognito (rows from before the refusal, or written by hand)', async () => {
  const { sql, owner } = db();
  const id = await newIncognito();
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO calls (conversation_id, direction, reason, status, scheduled_at) VALUES (${id}, 'out', 'scheduled', 'scheduled', now() + interval '1 hour') RETURNING id::text`;
  await closeIncognito(sql, id, 'user');
  const [after] = await owner<{ status: string; reason: string }[]>`SELECT status, end_reason AS reason FROM calls WHERE id = ${row?.id ?? ''}`;
  assert.deepEqual(after, { status: 'skipped', reason: 'cancelled' });
});

test('closing marks ended a live call on the incognito, with its event; a call of another conversation stays', async () => {
  const { sql, owner } = db();
  const id = await newIncognito();
  // No live call in the schema but this one (one at a time).
  await owner`UPDATE calls SET status = 'ended', end_reason = 'hangup', ended_at = now() WHERE status IN ('ringing', 'connecting', 'active')`;
  const [live] = await owner<{ id: string }[]>`
    INSERT INTO calls (conversation_id, direction, status, answered_at) VALUES (${id}, 'in', 'active', now()) RETURNING id::text`;
  const normal = (await createConversation(sql, { mode: 'private' })).id;
  const [kept] = await owner<{ id: string }[]>`
    INSERT INTO calls (conversation_id, direction, reason, status, scheduled_at) VALUES (${normal}, 'out', 'scheduled', 'scheduled', now() + interval '1 hour') RETURNING id::text`;
  await closeIncognito(sql, id, 'user');
  const rows = await owner<{ id: string; status: string; reason: string | null }[]>`
    SELECT id::text, status, end_reason AS reason FROM calls WHERE id IN (${live?.id ?? ''}, ${kept?.id ?? ''})`;
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, [row.status, row.reason]])), {
    [live?.id ?? '']: ['ended', 'hangup'],
    [kept?.id ?? '']: ['scheduled', null],
  });
  const [ended] = await owner<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE kind = 'call.ended' AND payload ->> 'callId' = ${live?.id ?? ''}`;
  assert.deepEqual(ended?.payload, { callId: live?.id, conversationId: id, status: 'ended', reason: 'hangup' });
});

test('a closing that fails on a lock answers busy and leaves no task at work: its jobs failed, its tasks failed', async () => {
  const { sql, owner } = db();
  const id = await newIncognito();
  const { task, message } = await postUserMessage(sql, id, 'Al lavoro');
  const errors: unknown[] = [];
  const holder = await owner.reserve();
  try {
    await holder`BEGIN`;
    await holder`SELECT 1 FROM messages WHERE id = ${message.id} FOR UPDATE`;
    await assert.rejects(closeIncognito(sql, id, 'user', { onError: (error) => errors.push(error) }), (error: unknown) => error instanceof ChatError && error.code === 'busy');
  } finally {
    await holder`ROLLBACK`;
    holder.release();
  }
  assert.deepEqual(errors, []);
  const [state] = await owner<{ task: string; job: string }[]>`
    SELECT t.status AS task, (SELECT j.status FROM jobs j WHERE j.key = ${`task:${task.id}`} ORDER BY j.id DESC LIMIT 1) AS job
    FROM tasks t WHERE t.id = ${task.id}`;
  assert.deepEqual(state, { task: 'failed', job: 'failed' });
  // Not purged yet: tried again, it closes.
  assert.equal((await closeIncognito(sql, id, 'user')).deleted.tasks, 1);
});

test('a closing that waits for a lock holds no lock of the event chain: the rest of Arianna keeps writing events', async () => {
  const { sql, owner } = db();
  const id = await newIncognito();
  const { message } = await postUserMessage(sql, id, 'In attesa');
  const holder = await owner.reserve();
  try {
    await holder`BEGIN`;
    await holder`SELECT 1 FROM messages WHERE id = ${message.id} FOR UPDATE`;
    const closing = closeIncognito(sql, id, 'user').catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await appendEvent(sql, { kind: 'test.elsewhere', label: 'L0', payload: {} });
    assert.ok(Date.now() - started < 2_000, 'an event of another conversation waited for the closing');
    const result = await closing;
    assert.ok(result instanceof ChatError && result.code === 'busy');
  } finally {
    await holder`ROLLBACK`;
    holder.release();
  }
  assert.equal((await closeIncognito(sql, id, 'user')).deleted.tasks, 1);
});

test('"Termina" when the work does not stop answers 409 busy, a stable code', async () => {
  const id = await newIncognito();
  closeFails = new ChatError('busy', 'the conversation is still at work: try again in a moment');
  try {
    assert.deepEqual(await call('POST', `/api/conversations/${id}/end`), { status: 409, body: { error: 'busy' } });
  } finally {
    closeFails = undefined;
  }
  assert.equal((await call('POST', `/api/conversations/${id}/end`)).status, 200);
});

test('an incognito that does not close at start-up is stopped all the same: its jobs never run again, no task left at work', async () => {
  const { sql, owner } = db();
  const id = await newIncognito();
  const { task, message } = await postUserMessage(sql, id, 'Prima del crollo');
  // A task left running without its job, as after a first stop that failed it.
  await owner`UPDATE tasks SET status = 'running' WHERE id = ${task.id}`;
  await owner`UPDATE jobs SET status = 'failed', last_error = 'incognito' WHERE key = ${`task:${task.id}`}`;
  const second = await postUserMessage(sql, id, 'Seconda');
  // Another connection holds the message: the purge waits for its lock and gives up (lock_timeout of purge_incognito).
  const holder = await owner.reserve();
  try {
    await holder`BEGIN`;
    await holder`SELECT 1 FROM messages WHERE id = ${message.id} FOR UPDATE`;
    const errors: unknown[] = [];
    await closeIncognitoAtStart(sql, (error) => errors.push(error));
    assert.ok(errors.some((error) => error instanceof ChatError && error.code === 'busy'));
  } finally {
    await holder`ROLLBACK`;
    holder.release();
  }
  const rows = await owner<{ status: string; job: string | null }[]>`
    SELECT t.status, (SELECT j.status FROM jobs j WHERE j.key = 'task:' || t.id::text ORDER BY j.id DESC LIMIT 1) AS job
    FROM tasks t WHERE t.id IN (${task.id}, ${second.task.id}) ORDER BY t.created_at`;
  assert.deepEqual([...rows], [{ status: 'failed', job: 'failed' }, { status: 'failed', job: 'failed' }]);
  // Still open, not purged: the next closing deletes it.
  assert.equal((await call('GET', `/api/conversations/${id}`)).status, 200);
  await haltIncognito(sql, id);
  assert.equal((await closeIncognito(sql, id, 'restart')).deleted.tasks, 2);
  // Never on a conversation of the user: refused, nothing touched.
  const normal = await createConversation(sql, { mode: 'private' });
  await assert.rejects(haltIncognito(sql, normal.id), (error: unknown) => error instanceof ChatError && error.code === 'not-incognito');
});

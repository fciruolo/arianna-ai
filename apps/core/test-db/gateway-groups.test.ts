// «Cosa era» and «una riga per richiesta» (D-297, second stage) on a real
// database: the code of each exit in gateway_log.what, its subject in
// gateway_subjects (blocked exits too, never in incognito nor without a task
// or a run, gone with the conversation and after 30 days, read only from the
// Mac), and the list in groups, one per run.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createContext, type Labeled, type Target } from '@arianna/policy';

import { archiveConversation, createConversation, purgeConversation } from '../src/conversations.ts';
import { eraseConversation } from '../src/erase.ts';
import { passGateway, type GatewayMeta } from '../src/gateway.ts';
import { loadGatewayLog, loadGatewaySubjects, loadGatewayText, parseGatewayLogQuery, pruneGatewayTexts, type GatewayLogPage } from '../src/gateway-log.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { localOnly } from '../src/server/remote.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createTask } from '../src/tasks.ts';
import { createTestDatabase, SETUP_TIMEOUT_MS, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
let live: LiveFeed;
let server: ApiServer;
const HOME = resolveHome({});
const MARK = 'soggettofinto';

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };

before(async () => {
  database = await createTestDatabase();
  live = await startLiveFeed(db().sql);
  server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    agents: () => ['arianna', 'coder'],
    characters: {
      dirs: { original: join(HOME, 'apps', 'hud', 'characters', 'originali'), data: join(HOME, 'data', 'test-tmp', 'no-characters') },
      choices: () => ({}),
    },
  });
}, { timeout: SETUP_TIMEOUT_MS });

after(async () => {
  await server.close();
  await live.close();
  await database?.close();
});

function get(path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${String(server.port)}${path}`, { agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

const fragment = (value: string, label: 'L0' | 'L1' | 'L2' = 'L1'): Labeled<string>[] => [{ value, label, source: 'test' }];

async function lastId(): Promise<string> {
  const [row] = await db().sql<{ id: string }[]>`SELECT g.id::text AS id FROM gateway_log g ORDER BY g.id DESC LIMIT 1`;
  if (row === undefined) throw new Error('gateway_log is empty');
  return row.id;
}

/** A work conversation with a task and a run of the Coder on Claude. */
async function runOf(incognito = false): Promise<{ conversationId: string; taskId: string; runId: string; key: string }> {
  const conversation = await createConversation(db().sql, { mode: 'work', incognito });
  const task = await createTask(db().sql, { title: incognito ? 'Incognito' : 'Domanda', conversationId: conversation.id, label: 'L1', clearance: 'L1' });
  const [run] = await db().owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label)
    VALUES (${task.id}, 1, 'coder', 'claude', 'sonnet', 'cloud', 'L1') RETURNING id::text`;
  return { conversationId: conversation.id, taskId: task.id, runId: run?.id ?? '', key: `t-${task.id}` };
}

/** As a run of the Coder: the brief, two notes read, one refused (a Privato note), one search. */
async function work(full: { taskId: string; runId: string }): Promise<string[]> {
  const ids = { taskId: full.taskId, runId: full.runId };
  const exits: [Labeled<string>[], GatewayMeta][] = [
    [fragment('Istruzioni del Coder'), { what: 'brief' }],
    [fragment('kb/note/a.md (A)\n\ntesto'), { what: 'mcp-kb-read', subject: `kb/note/${MARK}-a.md` }],
    [fragment('', 'L2'), { what: 'mcp-kb-read-denied', subject: `kb/private/${MARK}-b.md` }],
    [fragment('1. kb/note/a.md'), { what: 'mcp-kb-search', subject: `fatture ${MARK}` }],
  ];
  const rows: string[] = [];
  for (const [payload, meta] of exits) {
    await passGateway(db().sql, payload, createContext('L1'), CLAUDE, { ...ids, ...meta });
    rows.push(await lastId());
  }
  return rows;
}

test('the code of each exit goes in gateway_log.what, its subject apart, blocked exits too', async () => {
  const ids = await runOf();
  const [brief, read, denied, search] = await work(ids);
  const page = await loadGatewayLog(db().sql, parseGatewayLogQuery(new URLSearchParams(`request=${ids.key}`)));
  assert.deepEqual(page.entries.map((entry) => [entry.what, entry.decision]), [
    ['mcp-kb-search', 'allow'],
    ['mcp-kb-read-denied', 'block'],
    ['mcp-kb-read', 'allow'],
    ['brief', 'allow'],
  ]);
  assert.deepEqual(await loadGatewaySubjects(db().sql, ids.key), {
    [read ?? '']: `kb/note/${MARK}-a.md`,
    [denied ?? '']: `kb/private/${MARK}-b.md`,
    [search ?? '']: `fatture ${MARK}`,
  });
  // The detail of the blocked one: its subject, never a text.
  const blocked = await loadGatewayText(db().sql, denied ?? '');
  assert.deepEqual([blocked?.state, blocked?.subject, blocked?.parts], ['blocked', `kb/private/${MARK}-b.md`, undefined]);
  assert.equal((await loadGatewayText(db().sql, brief ?? ''))?.subject, null);
  // A code that is not one is not written; a subject is one line, 500 characters at most.
  await passGateway(db().sql, fragment('x'), createContext('L1'), CLAUDE, { ...ids, what: 'Non Un Codice', subject: `riga\nnuova\u0000${'z'.repeat(600)}` });
  const odd = await lastId();
  const [row] = await db().sql<{ what: string | null; subject: string }[]>`
    SELECT g.what, s.subject FROM gateway_log g JOIN gateway_subjects s ON s.log_id = g.id WHERE g.id = ${odd}::bigint`;
  assert.ok(row !== undefined);
  assert.equal(row.what, null);
  assert.equal(Array.from(row.subject).length, 500);
  assert.match(row.subject, /^riga nuova z+$/);
});

test('one line per question: counts, bytes, the newest row; «Bloccate» keeps groups with a block, whole', async () => {
  const ids = await runOf();
  await work(ids);
  // A row without a run stays alone.
  await passGateway(db().sql, fragment('avviso'), createContext('L1'), { kind: 'channel', id: 'push' });
  const alone = await lastId();
  const page = await loadGatewayLog(db().sql, parseGatewayLogQuery(new URLSearchParams('group=request&limit=2')));
  assert.deepEqual(page.entries, []);
  const [first, second] = page.groups ?? [];
  assert.equal(first?.entry.id, alone);
  assert.equal(first.count, 1);
  assert.equal(second?.entry.requestKey, ids.key);
  assert.deepEqual([second.count, second.allowed, second.blocked, second.targets, second.label], [4, 3, 1, 1, 'L2']);
  assert.equal(second.entry.what, 'mcp-kb-search');
  assert.equal(second.entry.agent, 'coder');
  // D-306: the line is titled by the question that started it, the row alone by nothing.
  assert.equal(second.entry.question, 'Domanda');
  assert.equal(first.entry.question, null);
  assert.ok((second.bytes ?? 0) > 0);
  assert.ok(page.next !== null);
  // The next page of groups starts below the newest row of the last group: no group twice.
  const more = await loadGatewayLog(db().sql, parseGatewayLogQuery(new URLSearchParams(`group=request&before=${page.next}`)));
  const seen = new Set((page.groups ?? []).map((group) => group.entry.requestKey));
  for (const group of more.groups ?? []) assert.equal(seen.has(group.entry.requestKey), false);
  // «Bloccate»: only groups with a block, with every exit counted.
  const blocked = await loadGatewayLog(db().sql, parseGatewayLogQuery(new URLSearchParams('group=request&decision=block')));
  const mine = blocked.groups?.find((group) => group.entry.requestKey === ids.key);
  assert.deepEqual([mine?.count, mine?.blocked], [4, 1]);
  assert.equal(blocked.groups?.some((group) => group.entry.id === alone), false);
  assert.equal(mine?.privateOut, 0);
  // A local step and a channel row in the same run: the line still leads with Claude, out of the Mac.
  await passGateway(db().sql, fragment('passo'), createContext('L1'), { kind: 'executor', id: 'local', locality: 'local' }, { ...ids, what: 'local-turn' });
  await passGateway(db().sql, fragment('risposta'), createContext('L1'), { kind: 'channel', id: 'web' }, { ...ids });
  const mixed = (await loadGatewayLog(db().sql, parseGatewayLogQuery(new URLSearchParams('group=request')))).groups?.find((group) => group.entry.requestKey === ids.key);
  assert.deepEqual([mixed?.count, mixed?.cloud, mixed?.targets], [6, 4, 3]);
  assert.deepEqual(mixed?.headline, { targetKind: 'executor', target: 'claude', locality: 'cloud' });
  // A Privato exit allowed to the cloud (the site of an access, D-276) makes the group red, as a row.
  await db().owner`
    INSERT INTO gateway_log (task_id, run_id, target_kind, target, locality, label, decision, rule, reason, bytes_out)
    VALUES (${ids.taskId}, ${ids.runId}, 'web', 'web-session', 'cloud', 'L2', 'allow', 'session', 'fake', 10)`;
  const red = await loadGatewayLog(db().sql, parseGatewayLogQuery(new URLSearchParams('group=request')));
  assert.equal(red.groups?.find((group) => group.entry.requestKey === ids.key)?.privateOut, 1);
  // Rows of a group through the API; bad parameters are a 400.
  assert.equal((await get(`/api/gateway/log?request=${ids.key}`)).status, 200);
  assert.equal((await get('/api/gateway/log?request=abc')).status, 400);
  assert.equal((await get('/api/gateway/log?group=task')).status, 400);
  assert.equal((await get(`/api/gateway/log?group=request&request=${ids.key}`)).status, 400);
});

test('one line per question: every run of the task and the rows of the task alone; a card apart', async () => {
  const { sql, owner } = db();
  const ids = await runOf();
  // A second run on the same task (the Designer after the Coder), a step of Arianna, a request to Claude with the task only.
  const [designer] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label, status, ended_at)
    VALUES (${ids.taskId}, 2, 'designer', 'claude', 'sonnet', 'cloud', 'L1', 'ok', now()) RETURNING id::text`;
  const [arianna] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label, status, ended_at)
    VALUES (${ids.taskId}, 3, 'arianna', 'local', 'local-large', 'local', 'L1', 'ok', now()) RETURNING id::text`;
  // A card made from the question is a request of its own: its work lasts days.
  const card = await createTask(sql, { title: 'Scheda', parentId: ids.taskId, assignee: 'coder', label: 'L1', clearance: 'L1' });
  await passGateway(sql, fragment('passo'), createContext('L1'), { kind: 'executor', id: 'local', locality: 'local' }, { taskId: ids.taskId, runId: arianna?.id ?? '', what: 'local-turn' });
  await passGateway(sql, fragment('parere'), createContext('L1'), CLAUDE, { taskId: ids.taskId, what: 'cloud-text' });
  await passGateway(sql, fragment('brief coder'), createContext('L1'), CLAUDE, { taskId: ids.taskId, runId: ids.runId, what: 'brief' });
  await passGateway(sql, fragment('brief designer'), createContext('L1'), CLAUDE, { taskId: ids.taskId, runId: designer?.id ?? '', what: 'brief' });
  await passGateway(sql, fragment('risposta'), createContext('L1'), { kind: 'channel', id: 'web' }, { taskId: ids.taskId, runId: arianna?.id ?? '' });
  await passGateway(sql, fragment('scheda'), createContext('L1'), CLAUDE, { taskId: card.id, what: 'brief' });
  const page = await loadGatewayLog(sql, parseGatewayLogQuery(new URLSearchParams('group=request')));
  const mine = page.groups?.find((group) => group.entry.requestKey === ids.key);
  assert.deepEqual([mine?.count, mine?.cloud], [5, 3]);
  // Who worked in the cloud, in order; Arianna's own steps stay on the Mac.
  assert.deepEqual(mine?.agents, ['coder', 'designer']);
  assert.ok(page.groups?.some((group) => group.entry.requestKey === `t-${card.id}`), 'a card is a request of its own');
  const rows = await loadGatewayLog(sql, parseGatewayLogQuery(new URLSearchParams(`request=${ids.key}`)));
  assert.deepEqual(rows.entries.map((entry) => entry.what), [null, 'brief', 'brief', 'cloud-text', 'local-turn']);
  assert.deepEqual(rows.entries.map((entry) => entry.agent), ['arianna', 'designer', 'coder', null, 'arianna']);
});

test('never in the list: neither subject nor text, grouped or not; the subjects only from the Mac', async () => {
  const ids = await runOf();
  await work(ids);
  for (const path of ['/api/gateway/log', '/api/gateway/log?group=request', `/api/gateway/log?request=${ids.key}`]) {
    const answer = await get(path);
    assert.equal(answer.status, 200, path);
    assert.equal(answer.text.includes(MARK), false, path);
    assert.equal(answer.text.includes('"subject'), false, path);
  }
  const subjects = await get(`/api/gateway/log/request/${ids.key}/subjects`);
  assert.equal(subjects.status, 200);
  assert.ok(subjects.text.includes(MARK));
  assert.equal((await get('/api/gateway/log/request/abc/subjects')).status, 400);
  assert.equal(localOnly(`/api/gateway/log/request/${ids.key}/subjects`), true);
  assert.equal(localOnly('/api/gateway/log'), false);
});

test('incognito: no subject is written, nor for a row without task or run; the guard refuses them', async () => {
  const { sql, owner } = db();
  const ids = await runOf(true);
  await work(ids);
  assert.deepEqual(await loadGatewaySubjects(sql, ids.key), {});
  const [count] = await owner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM gateway_subjects s JOIN gateway_log g ON g.id = s.log_id WHERE g.run_id = ${ids.runId}::uuid`;
  assert.equal(count?.n, 0);
  const hidden = await lastId();
  await assert.rejects(owner`INSERT INTO gateway_subjects (log_id, subject) VALUES (${hidden}::bigint, 'x')`, /never the subject of an incognito/);
  await passGateway(sql, fragment('pagina'), createContext('L1'), CLAUDE, { what: 'mcp-web-page', subject: `${MARK}.example` });
  const untied = await lastId();
  const [none] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_subjects WHERE log_id = ${untied}::bigint`;
  assert.equal(none?.n, 0);
  await assert.rejects(owner`INSERT INTO gateway_subjects (log_id, subject) VALUES (${untied}::bigint, 'x')`, /of a task or a run/);
  // The core neither changes nor deletes a subject by itself.
  await assert.rejects(sql`DELETE FROM gateway_subjects`, /permission denied/);
  await assert.rejects(sql`UPDATE gateway_subjects SET subject = 'y'`, /permission denied/);
});

test('the subjects go with the conversation (purge and «Elimina») and after 30 days', async () => {
  const { sql, owner } = db();
  const purged = await runOf();
  await work(purged);
  await archiveConversation(sql, purged.conversationId, true);
  await purgeConversation(sql, purged.conversationId);
  assert.deepEqual(await loadGatewaySubjects(sql, purged.key), {});

  const erased = await runOf();
  const [, read] = await work(erased);
  await archiveConversation(sql, erased.conversationId, true);
  await eraseConversation(sql, erased.conversationId);
  const [left] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_subjects WHERE log_id = ${read ?? '0'}::bigint`;
  assert.equal(left?.n, 0);

  const old = await runOf();
  await work(old);
  await owner`UPDATE gateway_subjects s SET created_at = now() - interval '31 days' FROM gateway_log g WHERE g.id = s.log_id AND g.run_id = ${old.runId}::uuid`;
  // Past 30 days never read, even before the prune.
  assert.deepEqual(await loadGatewaySubjects(sql, old.key), {});
  assert.ok((await pruneGatewayTexts(sql)) >= 3);
  const [gone] = await owner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM gateway_subjects s JOIN gateway_log g ON g.id = s.log_id WHERE g.run_id = ${old.runId}::uuid`;
  assert.equal(gone?.n, 0);
});

test('a page of groups is readable from the phone: codes and counts only', async () => {
  const page: GatewayLogPage = await loadGatewayLog(db().sql, parseGatewayLogQuery(new URLSearchParams('group=request')));
  const text = JSON.stringify(page);
  assert.equal(text.includes(MARK), false);
  assert.equal(localOnly('/api/gateway/log'), false);
});

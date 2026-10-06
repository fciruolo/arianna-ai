// The backend of the new left bar (D-089) against PostgreSQL: "Cerca" over
// conversations, messages, notes and pages up to L2; pinned conversations;
// a message saved once in kb/inbox; what the chat says about the installation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import { archiveConversation, createConversation, listConversations, pinConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { recordFailure } from '../src/failures.ts';
import { searchAll } from '../src/search.ts';
import { openFailureChat } from '../src/system-chats.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
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
const RULES = parseLabelRules('[[folder]]\npath = "kb/segreti"\nlabel = "L3"\n');

before(async () => {
  database = await createTestDatabase();
  mkdirSync(join(home, 'kb', 'inbox'), { recursive: true });
  mkdirSync(join(home, 'kb', 'casa'), { recursive: true });
  mkdirSync(join(home, 'kb', 'segreti'), { recursive: true });
  writeFileSync(join(home, 'kb', 'inbox', '2026-10-05-080000-caparra.md'), '---\nlabel: L2\ntitle: "Caparra affitto"\ntags: ["casa"]\nstatus: new\n---\n\nRicordare la caparra di via Roma.\n');
  writeFileSync(join(home, 'kb', 'inbox', '2026-10-05-090000-riservata.md'), '---\nlabel: L3\ntitle: "Riservatissima"\n---\n\nCaparra NASCOSTA-NOTA.\n');
  writeFileSync(join(home, 'kb', 'casa', 'contratto.md'), '---\ntitle: Contratto di affitto\ntags: [casa]\n---\n\nLa caparra è di tre mensilità.\n');
  writeFileSync(join(home, 'kb', 'segreti', 'conto.md'), '---\ntitle: Conto\n---\n\nCaparra NASCOSTA-PAGINA.\n');
  live = await startLiveFeed(db().sql);
  server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    capture: { home, rules: RULES },
    installation: () => ({ mode: 'development', home: 'arianna-ai', version: 'abc1234' }),
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
  text: string;
}

function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const payload = options.body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(options.body);
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
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Not JSON.
          }
          resolve({ status: response.statusCode ?? 0, body, text });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

interface SearchBody {
  conversations: { id: string; title: string; archived: boolean; pinned: boolean }[];
  messages: { conversationId: string; messageId: string; title: string | null; snippet: string; highlight: { start: number; length: number } | null; label: string }[];
  notes: { name: string; field: string; snippet: string }[];
  pages: { id: string; field: string }[];
  hidden: number;
  truncated: boolean;
}

function search(reply: Reply): SearchBody {
  assert.equal(reply.status, 200, reply.text);
  return reply.body as unknown as SearchBody;
}

/** A message above L2, which the schema refuses: written as the owner of this throwaway schema with the guards off, to prove the search never shows one. */
async function insertSecretMessage(conversationId: string, body: string): Promise<void> {
  const { owner } = db();
  await owner.unsafe('ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_below_secret');
  await owner.unsafe('ALTER TABLE messages DISABLE TRIGGER messages_within_conversation');
  try {
    await owner`INSERT INTO messages (conversation_id, role, channel, label, body) VALUES (${conversationId}, 'assistant', 'web', 'L3', ${body})`;
  } finally {
    await owner.unsafe('ALTER TABLE messages ENABLE TRIGGER messages_within_conversation');
  }
}

test('search: titles, messages, notes and pages up to L2; L3 only in a total that does not depend on the query', async () => {
  const { sql } = db();
  const chat = await createConversation(sql, { mode: 'private' });
  const { message } = await postUserMessage(sql, chat.id, 'Quanto è la Caparra dell\'appartamento?');
  await insertSecretMessage(chat.id, 'caparra NASCOSTA-MESSAGGIO');
  const old = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, old.id, 'Caparra vecchia');
  await archiveConversation(sql, old.id, true);

  const found = search(await call('GET', '/api/search?q=CAPARRA'));
  assert.deepEqual(found.conversations.map((item) => [item.id, item.archived]).sort(), [[chat.id, false], [old.id, true]].sort());
  const hit = found.messages.find((item) => item.messageId === message.id);
  assert.ok(hit !== undefined);
  assert.equal(hit.conversationId, chat.id);
  assert.equal(hit.label, 'L2');
  assert.ok(hit.snippet.length <= 160);
  assert.equal(hit.highlight === null ? '' : hit.snippet.slice(hit.highlight.start, hit.highlight.start + hit.highlight.length), 'Caparra');
  assert.deepEqual(found.notes.map((note) => [note.name, note.field]), [['2026-10-05-080000-caparra.md', 'title']]);
  assert.deepEqual(found.pages.map((page) => [page.id, page.field]), [['casa/contratto.md', 'body']]);
  // One message, one note (its own label), one page (its folder).
  assert.equal(found.hidden, 3);
  assert.equal(found.truncated, false);
  assert.equal(/NASCOSTA|Riservatissima|segreti/.test(JSON.stringify(found)), false);

  // The same total for a query that matches nothing: it says nothing of their content.
  const none = search(await call('GET', '/api/search?q=nascosta'));
  assert.deepEqual([none.conversations, none.messages, none.notes, none.pages, none.hidden], [[], [], [], [], 3]);

  // Accents folded both ways, tags matched.
  assert.equal(search(await call('GET', `/api/search?q=${encodeURIComponent('mensilita')}`)).pages.length, 1);
  assert.equal(search(await call('GET', `/api/search?q=${encodeURIComponent('APPARTAMENTO')}`)).messages.length, 1);
  assert.deepEqual(search(await call('GET', '/api/search?q=%23casa')).notes, []);
  assert.equal(search(await call('GET', '/api/search?q=casa')).notes[0]?.field, 'tags');
});

test('search: % and _ are literal, the limit holds per kind, bad input is refused, the host is checked', async () => {
  const { sql } = db();
  const chat = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, chat.id, 'sconto 100%_pieno');
  await postUserMessage(sql, chat.id, 'sconto 100xypieno');
  const literal = search(await call('GET', `/api/search?q=${encodeURIComponent('100%_')}`));
  assert.deepEqual(literal.messages.map((item) => item.snippet), ['sconto 100%_pieno']);
  assert.equal(search(await call('GET', `/api/search?q=${encodeURIComponent('0_p')}`)).messages.length, 0);
  assert.equal(search(await call('GET', '/api/search?q=sconto&limit=1')).messages.length, 1);

  assert.equal((await call('GET', '/api/search?q=a')).status, 400);
  assert.equal((await call('GET', '/api/search')).status, 400);
  assert.equal((await call('GET', '/api/search?q=sconto&limit=0')).status, 400);
  assert.equal((await call('GET', '/api/search?q=sconto&limit=51')).status, 400);
  const refused = await call('GET', '/api/search?q=sconto', { headers: { host: `evil.example:${String(server.port)}` } });
  assert.equal(refused.status, 403);
  assert.equal(refused.text.includes('sconto'), false);
  assert.equal((await call('POST', '/api/search?q=sconto')).status, 405);
});

test('pinned conversations come first, latest pin on top; archiving unpins; an archived one is not pinned', async () => {
  const { sql, owner } = db();
  const ids: string[] = [];
  for (const text of ['prima', 'seconda', 'terza']) {
    const chat = await createConversation(sql, { mode: 'private' });
    await postUserMessage(sql, chat.id, text);
    ids.push(chat.id);
  }
  const [first, second, third] = ids as [string, string, string];
  const order = async (): Promise<string[]> => (await listConversations(sql, 200)).map((item) => item.id).filter((id) => ids.includes(id));
  assert.deepEqual(await order(), [third, second, first]);

  const pinned = await call('POST', `/api/conversations/${first}/pin`);
  assert.equal(pinned.status, 200);
  const pinnedAt = (pinned.body.conversation as { pinnedAt: string | null }).pinnedAt;
  assert.ok(pinnedAt !== null);
  assert.equal((await call('POST', `/api/conversations/${second}/pin`)).status, 200);
  assert.deepEqual(await order(), [second, first, third]);
  // Pinning again keeps the first time.
  assert.equal(((await call('POST', `/api/conversations/${first}/pin`)).body.conversation as { pinnedAt: string }).pinnedAt, pinnedAt);
  const listed = (await call('GET', '/api/conversations?limit=200')).body.conversations as { id: string; pinnedAt: string | null }[];
  assert.deepEqual(listed.filter((item) => ids.includes(item.id)).map((item) => item.pinnedAt !== null), [true, true, false]);

  assert.equal((await call('POST', `/api/conversations/${second}/unpin`)).status, 200);
  assert.deepEqual(await order(), [first, third, second]);

  await archiveConversation(sql, first, true);
  assert.deepEqual(await order(), [third, second]);
  const refused = await call('POST', `/api/conversations/${first}/pin`);
  assert.equal(refused.status, 409);
  await assert.rejects(pinConversation(sql, first, true), /archived/);
  // The database keeps it so even for a direct update: the trigger unpins an archived row.
  await owner`UPDATE conversations SET pinned_at = now() WHERE id = ${first}`;
  const [row] = await owner<{ pinned_at: Date | null }[]>`SELECT pinned_at FROM conversations WHERE id = ${first}`;
  assert.equal(row?.pinned_at, null);
  await archiveConversation(sql, first, false);
  // Restored, it is not pinned again.
  assert.deepEqual(await order(), [third, second, first]);

  // The core may pin as arianna_app; the guard still freezes the rest.
  await sql`UPDATE conversations SET pinned_at = now() WHERE id = ${third}`;
  await assert.rejects(sql`UPDATE conversations SET pinned_at = now(), mode = 'work' WHERE id = ${third}`, /only the effective label/);
  const events = await sql<{ payload: { pinned: boolean } }[]>`
    SELECT payload FROM events WHERE kind = 'conversation.pinned' AND payload ->> 'conversationId' = ${first} ORDER BY id`;
  assert.deepEqual(events.map((event) => event.payload.pinned), [true]);

  assert.equal((await call('POST', `/api/conversations/${randomUUID()}/pin`)).status, 404);
  assert.equal((await call('POST', `/api/conversations/${second}/pin`, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await call('POST', `/api/conversations/${second}/pin`, { body: { at: 1 } })).status, 400);
});

test('a message is saved in kb/inbox once: two saves together give one note and one 409; /saved lists it', async () => {
  const { sql } = db();
  const chat = await createConversation(sql, { mode: 'private' });
  const { message } = await postUserMessage(sql, chat.id, 'Da salvare una volta sola');
  const other = await createConversation(sql, { mode: 'private' });
  const { message: elsewhere } = await postUserMessage(sql, other.id, 'Altrove');
  const before = readdirSync(join(home, 'kb', 'inbox')).length;

  const replies = await Promise.all([0, 1].map(() => call('POST', '/api/capture', { body: { messageId: message.id } })));
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409]);
  const created = replies.find((reply) => reply.status === 201);
  const conflict = replies.find((reply) => reply.status === 409);
  const path = created?.body.path as string;
  assert.equal(conflict?.body.note, path.split('/').at(-1));
  assert.equal(readdirSync(join(home, 'kb', 'inbox')).length, before + 1);
  const raw = readFileSync(join(home, path), 'utf8');
  assert.match(raw, new RegExp(`^source: message:${message.id}$`, 'm'));
  // Without `text`, the text of the message; its label from the database.
  assert.match(raw, /Da salvare una volta sola/);
  assert.match(raw, /^label: L2$/m);

  const saved = await call('GET', `/api/conversations/${chat.id}/saved`);
  assert.deepEqual(saved.body, { messageIds: [message.id], notes: { [message.id]: path.split('/').at(-1) }, conversation: false, conversationNote: null, conversationSavedAt: null });
  assert.deepEqual((await call('GET', `/api/conversations/${other.id}/saved`)).body, { messageIds: [], notes: {}, conversation: false, conversationNote: null, conversationSavedAt: null });
  assert.equal((await call('GET', `/api/conversations/${randomUUID()}/saved`)).status, 404);
  // A note raised above L2 by hand: the message stays saved, its name is not given.
  const messageNote = join(home, path);
  const kept = readFileSync(messageNote, 'utf8');
  writeFileSync(messageNote, kept.replace(/^label: L2$/m, 'label: L3'));
  assert.deepEqual((await call('GET', `/api/conversations/${chat.id}/saved`)).body, { messageIds: [message.id], notes: {}, conversation: false, conversationNote: null, conversationSavedAt: null });
  writeFileSync(messageNote, kept);

  // A sent text is kept; a missing or malformed message is refused before anything is written.
  assert.equal((await call('POST', '/api/capture', { body: { messageId: elsewhere.id, text: 'Testo scelto' } })).status, 201);
  assert.equal((await call('POST', '/api/capture', { body: { messageId: '999999999' } })).status, 404);
  assert.equal((await call('POST', '/api/capture', { body: { messageId: 12 } })).status, 400);
  assert.equal((await call('POST', '/api/capture', { body: { messageId: '01' } })).status, 400);
  assert.equal((await call('POST', '/api/capture', { body: { messageId: message.id }, headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal(readdirSync(join(home, 'kb', 'inbox')).length, before + 2);
});

test('search: a backslash is literal in PostgreSQL too', async () => {
  const { sql } = db();
  const chat = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, chat.id, 'percorso cartella\\dati\\nuovo');
  await postUserMessage(sql, chat.id, 'percorso Z:dati');
  const found = await searchAll(sql, 'a\\d', { limit: 10 });
  assert.deepEqual(found.messages.map((item) => item.snippet), ['percorso cartella\\dati\\nuovo']);
});

test('search: a statement that runs out of time, or files past the deadline, give truncated', async () => {
  const { sql, owner } = db();
  // A lock held by another session: both statements wait past their timeout (57014).
  const lock = await owner.reserve();
  try {
    await lock`BEGIN`;
    await lock`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`;
    const blocked = await searchAll(sql, 'caparra', { limit: 5, budgetMs: 200 });
    assert.deepEqual([blocked.conversations, blocked.messages, blocked.truncated], [[], [], true]);
  } finally {
    await lock`ROLLBACK`;
    lock.release();
  }
  // An injected clock past the deadline at the first file: nothing from the files, truncated.
  let clock = 0;
  const late = await searchAll(sql, 'caparra', { limit: 5, kb: { home, rules: RULES }, now: () => (clock += 10_000) });
  assert.deepEqual([late.notes, late.pages, late.truncated], [[], [], true]);
  assert.ok(late.messages.length > 0);
  // With time enough, the same query is complete.
  assert.equal((await searchAll(sql, 'caparra', { limit: 5, kb: { home, rules: RULES } })).truncated, false);
});

test('a deleted conversation is not searched; a pinned system chat purged with it is unpinned by the trigger', async () => {
  const { sql, owner } = db();
  const source = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, source.id, 'Domanda ELIMINANDA-XYZ');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  await owner`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
  await recordFailure(sql, task.id, { origin: 'local-model', code: 'local-model.unavailable', details: { endpoint: 'omlx', port: 7001 } });
  const chat = await openFailureChat(sql, task.id);
  await pinConversation(sql, chat.id, true);
  assert.ok((await listConversations(sql, 200, { origin: 'system' })).find((item) => item.id === chat.id)?.pinnedAt);
  assert.equal(search(await call('GET', '/api/search?q=ELIMINANDA-XYZ')).messages.length, 1);

  await archiveConversation(sql, source.id, true);
  await purgeConversation(sql, source.id);
  const [row] = await owner<{ pinned_at: Date | null; archived: boolean; purged: boolean }[]>`
    SELECT pinned_at, archived_at IS NOT NULL AS archived, purged_at IS NOT NULL AS purged FROM conversations WHERE id = ${chat.id}`;
  assert.deepEqual(row, { pinned_at: null, archived: true, purged: true });
  const after = search(await call('GET', '/api/search?q=ELIMINANDA-XYZ'));
  assert.deepEqual([after.conversations, after.messages], [[], []]);
});

test('the installation: mode, folder name and commit, same-origin only', async () => {
  const reply = await call('GET', '/api/installation');
  assert.deepEqual(reply.body, { installation: { mode: 'development', home: 'arianna-ai', version: 'abc1234' } });
  assert.equal((await call('GET', '/api/installation', { headers: { host: `evil.example:${String(server.port)}` } })).status, 403);
});

test('I-7 (D-131): the whole conversation saved in kb/inbox, replaced by a second save; refused above L2 or with nothing to save', async () => {
  const { sql } = db();
  const chat = await createConversation(sql, { mode: 'work', project: 'site', projects: ['site'] });
  await postUserMessage(sql, chat.id, 'Prima parte del ragionamento.');
  const first = await call('POST', `/api/conversations/${chat.id}/save`, { body: {} });
  assert.equal(first.status, 201);
  const firstBody = first.body as { path: string; label: string; replaced: boolean };
  assert.deepEqual([firstBody.label, firstBody.replaced], ['L2', false]);
  const afterFirst = (await call('GET', `/api/conversations/${chat.id}/saved`)).body;
  assert.deepEqual({ ...afterFirst, conversationSavedAt: undefined }, { messageIds: [], notes: {}, conversation: true, conversationNote: firstBody.path, conversationSavedAt: undefined });
  assert.match(String(afterFirst.conversationSavedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  await postUserMessage(sql, chat.id, 'Seconda parte.');
  const second = await call('POST', `/api/conversations/${chat.id}/save`, { body: {} });
  const secondBody = second.body as { path: string; replaced: boolean };
  assert.deepEqual([second.status, secondBody.replaced], [201, true]);
  assert.match(readFileSync(join(home, secondBody.path), 'utf8'), /Seconda parte\./);
  assert.equal(existsSync(join(home, firstBody.path)) && firstBody.path !== secondBody.path, false);
  // "Apri nella Conoscenza" follows the newest path; a note raised above L2 by hand is saved but not named.
  assert.equal((await call('GET', `/api/conversations/${chat.id}/saved`)).body.conversationNote, secondBody.path);
  const notePath = join(home, secondBody.path);
  writeFileSync(notePath, readFileSync(notePath, 'utf8').replace(/^label: L2$/m, 'label: L3'));
  assert.deepEqual((await call('GET', `/api/conversations/${chat.id}/saved`)).body, { messageIds: [], notes: {}, conversation: true, conversationNote: null, conversationSavedAt: null });
  rmSync(notePath);

  assert.equal((await call('POST', `/api/conversations/${randomUUID()}/save`, { body: {} })).status, 404);
  assert.equal((await call('POST', `/api/conversations/${chat.id}/save`, { body: { all: true } })).status, 400);
  const empty = await createConversation(sql, { mode: 'private' });
  assert.equal((await call('POST', `/api/conversations/${empty.id}/save`, { body: {} })).status, 400);
  const secret = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, secret.id, 'Una domanda.');
  await insertSecretMessage(secret.id, 'valore segreto');
  assert.equal((await call('POST', `/api/conversations/${secret.id}/save`, { body: {} })).status, 403);
});

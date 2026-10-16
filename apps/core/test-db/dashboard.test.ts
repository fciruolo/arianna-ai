import assert from 'node:assert/strict';
import { test } from 'node:test';

import { archiveConversation, ChatError, createConversation, listConversations, loadConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import {
  cancelRefresh,
  listTiles,
  loadTile,
  orderTiles,
  pinnedMessages,
  pinTile,
  removeTile,
  settleDashboard,
  startRefresh,
  suggestQuestion,
  updateTile,
  type DashboardTile,
} from '../src/dashboard.ts';
import { eraseConversation } from '../src/erase.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

const env = { agents: () => ['arianna', 'local-chat', 'finanze', 'coder'], financeAgents: () => ['finanze'] };

type Agent = { name: string; modes: ('private' | 'work')[]; project: boolean; finance?: boolean };

/** A conversation with a question and its answer, as the step executor leaves it. */
async function answered(
  mode: 'private' | 'work',
  options: { agent?: Agent; body?: string; model?: string } = {},
): Promise<{ conversationId: string; answerId: string; questionId: string; taskId: string }> {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode, ...(options.agent === undefined ? {} : { agent: options.agent }) });
  const { message, task } = await postUserMessage(sql, conversation.id, 'Quanto ho speso a ottobre finora, per categoria?');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  const label = mode === 'private' ? 'L2' : 'L1';
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id, model)
    VALUES (${conversation.id}, 'assistant', ${label}::privacy_label, ${options.body ?? 'Dal 1° al 15 ottobre: 612,40 euro (dati finti).'}, ${task.id}, ${options.model ?? null})
    RETURNING id::text`;
  await owner`UPDATE tasks SET status = 'done', evidence = ${owner.json([{ kind: 'message', ref: reply?.id ?? '' }])} WHERE id = ${task.id}`;
  return { conversationId: conversation.id, answerId: reply?.id ?? '', questionId: message.id, taskId: task.id };
}

async function pin(answerId: string, title = 'Spesa di ottobre', question = 'Quanto ho speso a ottobre finora, per categoria?'): Promise<DashboardTile> {
  return pinTile(db().sql, { messageId: answerId, title, question, width: 'wide' });
}

/** The refresh conversation of a running tile, its task, and the answer the agent would write there. */
async function answerRefresh(tileId: string, label: 'L0' | 'L1' | 'L2', body: string, status: 'done' | 'failed' | 'waiting_user' = 'done'): Promise<string> {
  const { owner } = db();
  const [row] = await owner<{ conversationId: string; taskId: string }[]>`
    SELECT d.refresh_conversation_id::text AS "conversationId", t.id::text AS "taskId"
    FROM dashboard_tiles d JOIN tasks t ON t.conversation_id = d.refresh_conversation_id WHERE d.id = ${tileId}`;
  assert.ok(row !== undefined, 'the tile has a refresh at work');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${row.taskId}`}`;
  if (status === 'done') {
    const [reply] = await owner<{ id: string }[]>`
      INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${row.conversationId}, 'assistant', ${label}::privacy_label, ${body}, ${row.taskId}) RETURNING id::text`;
    await owner`UPDATE tasks SET status = 'done', effective_label = ${label}::privacy_label, evidence = ${owner.json([{ kind: 'message', ref: reply?.id ?? '' }])} WHERE id = ${row.taskId}`;
  } else if (status === 'failed') {
    await owner`UPDATE tasks SET status = 'failed' WHERE id = ${row.taskId}`;
  } else {
    await owner`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'Quale mese?' WHERE id = ${row.taskId}`;
  }
  return row.conversationId;
}

const code = (expected: string) => (error: unknown) => error instanceof ChatError && error.code === expected;

test('an answer is pinned once, with the label and text of the message, and the chat knows it', async () => {
  const { sql, owner } = db();
  const { conversationId, answerId, questionId } = await answered('work');
  const tile = await pin(answerId);
  assert.equal(tile.label, 'L1');
  assert.equal(tile.questionLabel, 'L1');
  assert.equal(tile.body, 'Dal 1° al 15 ottobre: 612,40 euro (dati finti).');
  assert.equal(tile.answeredBy, 'local');
  assert.equal(tile.originCloud, false);
  assert.equal(tile.width, 'wide');
  assert.equal(tile.refreshState, 'idle');
  assert.equal(tile.sourceConversationId, conversationId);
  assert.deepEqual(await pinnedMessages(sql, conversationId), [{ messageId: answerId, tileId: tile.id }]);
  // Twice: refused. A question of the user, or an id that is not a message: refused.
  await assert.rejects(pin(answerId), code('busy'));
  await assert.rejects(pin(questionId), code('invalid'));
  await assert.rejects(pin('x1'), code('invalid'));
  await assert.rejects(pin('999999999'), code('not-found'));
  // The event carries ids only.
  const [event] = await owner<{ label: string; payload: Record<string, unknown> }[]>`SELECT label, payload FROM events WHERE kind = 'dashboard.tile_pinned' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(event, { label: 'L0', payload: { tileId: tile.id, conversationId, messageId: answerId } });
});

test('a work conversation refuses a question the scanner flags; an incognito answer is never pinned', async () => {
  const { sql, owner } = db();
  // A side thread goes with its conversation: its answers are not pinned, also below the core.
  const mother = await answered('private');
  const side = await createConversation(sql, { mode: 'private' });
  const sideThread = await owner<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, side_of, side_message_id) VALUES ('private', 'L2', ${mother.conversationId}, ${mother.answerId}::bigint) RETURNING id::text`;
  const sideId = sideThread[0]?.id ?? side.id;
  const [aside] = await owner<{ id: string }[]>`INSERT INTO messages (conversation_id, role, label, body) VALUES (${sideId}, 'assistant', 'L2', 'Risposta a lato') RETURNING id::text`;
  await assert.rejects(pin(aside?.id ?? ''), code('invalid'));
  await assert.rejects(
    owner`INSERT INTO dashboard_tiles (title, question, question_label, body, label, source_conversation_id, source_message_id, answered_by, origin_cloud)
          VALUES ('x', 'y', 'L2', 'z', 'L2', ${sideId}, ${aside?.id ?? '0'}::bigint, 'local', false)`,
    /never pinned/,
  );
  const { answerId } = await answered('work');
  await assert.rejects(pin(answerId, 'Bonifico', 'Il bonifico su IT60X0542811101000000123456 è partito?'), code('scanner'));
  const incognito = await createConversation(sql, { mode: 'private', incognito: true });
  const [hidden] = await owner<{ id: string }[]>`INSERT INTO messages (conversation_id, role, label, body) VALUES (${incognito.id}, 'assistant', 'L2', 'Segreto') RETURNING id::text`;
  await assert.rejects(pin(hidden?.id ?? ''), code('incognito'));
  // The database refuses it too, and a tile less protected than its answer.
  await assert.rejects(
    owner`INSERT INTO dashboard_tiles (title, question, question_label, body, label, source_conversation_id, source_message_id, answered_by, origin_cloud)
          VALUES ('x', 'y', 'L2', 'z', 'L2', ${incognito.id}, ${hidden?.id ?? '0'}::bigint, 'local', false)`,
    /never pinned/,
  );
  const privateOne = await answered('private');
  await assert.rejects(
    owner`INSERT INTO dashboard_tiles (title, question, question_label, body, label, source_conversation_id, source_message_id, answered_by, origin_cloud)
          VALUES ('x', 'y', 'L1', 'z', 'L1', ${privateOne.conversationId}, ${privateOne.answerId}::bigint, 'local', false)`,
    /at least as protected/,
  );
});

test('title, width and order change; the label never goes down; «Togli» removes the tile only', async () => {
  const { sql, owner } = db();
  const first = await answered('work');
  const second = await answered('private');
  const a = await pin(first.answerId, 'Primo');
  const b = await pin(second.answerId, 'Secondo');
  // A new tile goes first.
  const before = (await listTiles(sql)).map((tile) => tile.id);
  assert.deepEqual(before.slice(0, 2), [b.id, a.id]);
  const renamed = await updateTile(sql, a.id, { title: '  Spesa  di ottobre ', width: 'narrow' });
  assert.deepEqual([renamed.title, renamed.width], ['Spesa di ottobre', 'narrow']);
  await assert.rejects(updateTile(sql, a.id, { width: 'huge' }), code('invalid'));
  await assert.rejects(updateTile(sql, a.id, {}), code('invalid'));
  const rest = before.slice(2);
  assert.deepEqual((await orderTiles(sql, [...rest, a.id, b.id])).map((tile) => tile.id), [...rest, a.id, b.id]);
  await assert.rejects(orderTiles(sql, [a.id]), code('invalid'));
  await assert.rejects(orderTiles(sql, [a.id, a.id]), code('invalid'));
  // The label only goes up; question and source never change.
  await assert.rejects(owner`UPDATE dashboard_tiles SET label = 'L0' WHERE id = ${b.id}`, /only goes up/);
  await assert.rejects(owner`UPDATE dashboard_tiles SET question = 'altro' WHERE id = ${a.id}`, /only title/);
  // The application role deletes no tile by hand.
  await assert.rejects(sql`DELETE FROM dashboard_tiles WHERE id = ${a.id}`, /permission denied/);
  await removeTile(sql, a.id);
  assert.equal(await loadTile(sql, a.id), undefined);
  assert.notEqual(await loadConversation(sql, first.conversationId), undefined);
  await assert.rejects(removeTile(sql, a.id), code('not-found'));
});

test('«Aggiorna» asks the question again on the local model, in a private conversation of its own, hidden and closed after', async () => {
  const { sql, owner } = db();
  const { conversationId, answerId } = await answered('work');
  const tile = await pin(answerId);
  const running = await startRefresh(sql, tile.id, env);
  assert.equal(running.refreshState, 'running');
  const [refresh] = await owner<{ id: string; mode: string; clearance: string; agent: string; finance: boolean; dashboardOf: string }[]>`
    SELECT c.id::text, c.mode, c.clearance, c.agent, c.finance, c.dashboard_of::text AS "dashboardOf"
    FROM conversations c JOIN dashboard_tiles d ON d.refresh_conversation_id = c.id WHERE d.id = ${tile.id}`;
  assert.ok(refresh !== undefined);
  // Private, the local model of «Con chi parli», never Arianna nor the cloud.
  assert.deepEqual([refresh.mode, refresh.clearance, refresh.agent, refresh.finance, refresh.dashboardOf], ['private', 'L2', 'local-chat', false, conversationId]);
  // Its one message is the question, at the label of the question (not the clearance): the tile stays Interno if nothing more is read.
  const messages = await owner<{ role: string; label: string; body: string }[]>`SELECT role, label, body FROM messages WHERE conversation_id = ${refresh.id}`;
  assert.deepEqual([...messages], [{ role: 'user', label: 'L1', body: 'Quanto ho speso a ottobre finora, per categoria?' }]);
  const [task] = await owner<{ assignee: string; status: string; effectiveLabel: string }[]>`
    SELECT assignee, status, effective_label AS "effectiveLabel" FROM tasks WHERE conversation_id = ${refresh.id}`;
  assert.deepEqual(task, { assignee: 'local-chat', status: 'ready', effectiveLabel: 'L1' });
  // Hidden from the list; it takes no message of the user; a second «Aggiorna» and «Togli» wait.
  assert.ok(!(await listConversations(sql)).some((item) => item.id === refresh.id));
  await assert.rejects(postUserMessage(sql, refresh.id, 'Ciao'), code('invalid'));
  await assert.rejects(startRefresh(sql, tile.id, env), code('busy'));
  await assert.rejects(removeTile(sql, tile.id), code('busy'));
  // Not settled while it works.
  assert.equal(await settleDashboard(sql), 0);

  await answerRefresh(tile.id, 'L1', 'Dal 1° al 16 ottobre: 650,10 euro (dati finti).');
  assert.equal(await settleDashboard(sql), 1);
  const done = await loadTile(sql, tile.id);
  assert.ok(done !== undefined);
  assert.equal(done.refreshState, 'idle');
  assert.equal(done.body, 'Dal 1° al 16 ottobre: 650,10 euro (dati finti).');
  assert.equal(done.label, 'L1');
  assert.equal(done.answeredBy, 'local');
  assert.ok(done.refreshedAt.getTime() >= tile.refreshedAt.getTime());
  // The refresh conversation is erased for good: no text, task nor event of it stays.
  const [gone] = await owner<{ conversations: number; messages: number; tasks: number; events: number }[]>`
    SELECT (SELECT count(*)::int FROM conversations WHERE id = ${refresh.id}) AS conversations,
      (SELECT count(*)::int FROM messages WHERE conversation_id = ${refresh.id}) AS messages,
      (SELECT count(*)::int FROM tasks WHERE conversation_id = ${refresh.id}) AS tasks,
      (SELECT count(*)::int FROM events WHERE strpos(payload::text, ${refresh.id}) > 0) AS events`;
  assert.deepEqual(gone, { conversations: 0, messages: 0, tasks: 0, events: 0 });
  // The source conversation is untouched.
  assert.equal((await owner<{ count: number }[]>`SELECT count(*)::int FROM messages WHERE conversation_id = ${conversationId}`)[0]?.count, 2);
});

test('after a refresh the label only goes up: Privato stays Privato when the next answer reads less', async () => {
  const { sql } = db();
  const { answerId } = await answered('work');
  const tile = await pin(answerId);
  await startRefresh(sql, tile.id, env);
  await answerRefresh(tile.id, 'L2', 'Letta anche una pagina privata.');
  await settleDashboard(sql);
  assert.equal((await loadTile(sql, tile.id))?.label, 'L2');
  await startRefresh(sql, tile.id, env);
  await answerRefresh(tile.id, 'L1', 'Solo pagine interne questa volta.');
  await settleDashboard(sql);
  const after = await loadTile(sql, tile.id);
  assert.ok(after !== undefined);
  assert.equal(after.body, 'Solo pagine interne questa volta.');
  assert.equal(after.label, 'L2');
});

test('a refresh that fails, asks the user or is stopped leaves the last answer in place', async () => {
  const { sql } = db();
  const { answerId } = await answered('work');
  const tile = await pin(answerId);
  await startRefresh(sql, tile.id, env);
  await answerRefresh(tile.id, 'L1', '', 'failed');
  await settleDashboard(sql);
  const failed = await loadTile(sql, tile.id);
  assert.deepEqual([failed?.refreshState, failed?.refreshError, failed?.body], ['failed', 'failed', tile.body]);
  // «Riprova».
  await startRefresh(sql, tile.id, env);
  await answerRefresh(tile.id, 'L1', '', 'waiting_user');
  await settleDashboard(sql);
  assert.equal((await loadTile(sql, tile.id))?.refreshError, 'question');
  // «Annulla»: back to idle, the refresh conversation closed once nothing works in it.
  await startRefresh(sql, tile.id, env);
  const stopped: string[] = [];
  const back = await cancelRefresh(sql, tile.id, async (conversationId) => {
    stopped.push(conversationId);
    await db().owner`UPDATE tasks SET status = 'failed' WHERE conversation_id = ${conversationId}`;
    await db().owner`UPDATE jobs SET status = 'failed' WHERE key IN (SELECT 'task:' || id::text FROM tasks WHERE conversation_id = ${conversationId})`;
  });
  assert.equal(back.refreshState, 'idle');
  assert.equal(back.body, tile.body);
  assert.equal(stopped.length, 1);
  const errors: unknown[] = [];
  await settleDashboard(sql, { onError: (error) => errors.push(error) });
  assert.deepEqual(errors, []);
  const [left] = await db().owner<{ live: number }[]>`SELECT count(*)::int AS live FROM conversations WHERE dashboard_of = ${tile.sourceConversationId} AND purged_at IS NULL`;
  assert.equal(left?.live, 0);
});

test('a tile of Claude is refreshed in local, a tile of the Finances by the agent of the Finances', async () => {
  const { sql, owner } = db();
  const claude = await answered('work', { agent: { name: 'claude', modes: ['work'], project: false }, model: 'sonnet' });
  const fromClaude = await pin(claude.answerId, 'Pasticceria Rossi');
  assert.deepEqual([fromClaude.answeredBy, fromClaude.originCloud], ['claude', true]);
  await startRefresh(sql, fromClaude.id, env);
  const [cloudRefresh] = await owner<{ agent: string; mode: string }[]>`
    SELECT c.agent, c.mode FROM conversations c JOIN dashboard_tiles d ON d.refresh_conversation_id = c.id WHERE d.id = ${fromClaude.id}`;
  assert.deepEqual(cloudRefresh, { agent: 'local-chat', mode: 'private' });
  await answerRefresh(fromClaude.id, 'L1', 'Stato del sito finto, dal modello locale.');
  await settleDashboard(sql);
  const local = await loadTile(sql, fromClaude.id);
  // Written by the local model now; the tile still says the first answer came from the cloud.
  assert.deepEqual([local?.answeredBy, local?.originCloud], ['local', true]);

  const finance = await answered('private', { agent: { name: 'finanze', modes: ['private'], project: false, finance: true } });
  const fromFinance = await pin(finance.answerId);
  assert.equal(fromFinance.label, 'L2');
  await startRefresh(sql, fromFinance.id, env);
  const [financeRefresh] = await owner<{ agent: string; finance: boolean }[]>`
    SELECT c.agent, c.finance FROM conversations c JOIN dashboard_tiles d ON d.refresh_conversation_id = c.id WHERE d.id = ${fromFinance.id}`;
  assert.deepEqual(financeRefresh, { agent: 'finanze', finance: true });
  // Without the agent loaded the tile cannot be refreshed.
  const other = await answered('work');
  const missing = await pin(other.answerId);
  await assert.rejects(startRefresh(sql, missing.id, { agents: () => ['arianna'], financeAgents: () => [] }), code('invalid'));
});

test('the database keeps a refresh conversation private, local and attached to its conversation', async () => {
  const { sql, owner } = db();
  const { conversationId } = await answered('work');
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance, dashboard_of) VALUES ('work', 'L1', ${conversationId})`, /conversations_dashboard_fields/);
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance, dashboard_of) VALUES ('private', 'L2', ${conversationId})`, /conversations_dashboard_fields/);
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, agent, dashboard_of) VALUES ('private', 'L2', 'local-chat', '00000000-0000-4000-8000-000000000009')`,
    /exists/,
  );
  const [row] = await sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance, agent, dashboard_of) VALUES ('private', 'L2', 'local-chat', ${conversationId}) RETURNING id::text`;
  const other = await answered('work');
  await assert.rejects(owner`UPDATE conversations SET dashboard_of = ${other.conversationId} WHERE id = ${row?.id ?? ''}`, /never changes/);
  // A Segreto tile is never refreshed.
  const { answerId } = await answered('work');
  const tile = await pin(answerId);
  await assert.rejects(owner`UPDATE dashboard_tiles SET label = 'L3', refresh_state = 'running', refresh_started_at = now() WHERE id = ${tile.id}`, /secret_never_refreshed/);
});

test('«Elimina» of the conversation takes its tiles and their refreshes, events included; the purge of an archived one too', async () => {
  const { sql, owner } = db();
  const erased = await answered('work');
  const tile = await pin(erased.answerId);
  await startRefresh(sql, tile.id, env);
  await eraseConversation(sql, erased.conversationId);
  assert.equal(await loadTile(sql, tile.id), undefined);
  const [left] = await owner<{ tiles: number; events: number; live: number }[]>`
    SELECT (SELECT count(*)::int FROM dashboard_tiles WHERE source_conversation_id = ${erased.conversationId}) AS tiles,
      (SELECT count(*)::int FROM events WHERE strpos(payload::text, ${tile.id}) > 0) AS events,
      (SELECT count(*)::int FROM conversations WHERE dashboard_of = ${erased.conversationId} AND purged_at IS NULL) AS live`;
  assert.deepEqual(left, { tiles: 0, events: 0, live: 0 });

  const purged = await answered('private');
  const other = await pin(purged.answerId);
  await startRefresh(sql, other.id, env);
  await answerRefresh(other.id, 'L2', 'Risposta nuova (dati finti).');
  await settleDashboard(sql);
  await archiveConversation(sql, purged.conversationId, true);
  // Archived: the tile stays, and says so.
  assert.equal((await loadTile(sql, other.id))?.sourceArchived, true);
  await purgeConversation(sql, purged.conversationId);
  assert.equal(await loadTile(sql, other.id), undefined);
});

test('«Fissa» proposes the user’s message when the local model does not answer', async () => {
  const { sql } = db();
  const { answerId, questionId } = await answered('work');
  const unavailable = {
    sql,
    model: () => ({
      chat: () => Promise.reject(new Error('no model in this test')),
    }) as never,
  };
  await assert.rejects(suggestQuestion(unavailable, answerId), /no model/);
  const answering = {
    sql,
    model: () => ({
      chat: () => Promise.resolve({ value: { title: 'Spesa di ottobre', question: 'Quanto ho speso dal 1° ottobre, per categoria?' }, finishReason: 'stop', model: 'finto', text: '' }),
    }) as never,
  };
  const suggestion = await suggestQuestion(answering, answerId);
  assert.deepEqual(suggestion, { title: 'Spesa di ottobre', question: 'Quanto ho speso dal 1° ottobre, per categoria?', label: 'L1', fallback: false });
  const garbled = { sql, model: () => ({ chat: () => Promise.resolve({ value: 'boh', finishReason: 'stop', model: 'finto', text: '' }) }) as never };
  const fallback = await suggestQuestion(garbled, answerId);
  assert.deepEqual([fallback.question, fallback.fallback, fallback.label], ['Quanto ho speso a ottobre finora, per categoria?', true, 'L1']);
  await assert.rejects(suggestQuestion(answering, questionId), code('invalid'));
});

test('a refresh past its time is stopped by the ticker, never by a reading of the page', async () => {
  const { sql } = db();
  const { answerId } = await answered('work');
  const tile = await pin(answerId);
  await startRefresh(sql, tile.id, env);
  const later = (): Date => new Date(Date.now() + 16 * 60_000);
  // Without a way to stop its steps (GET /api/dashboard/tiles): left as it is.
  await settleDashboard(sql, { now: later });
  assert.equal((await loadTile(sql, tile.id))?.refreshState, 'running');
  const stopped: string[] = [];
  await settleDashboard(sql, {
    now: later,
    stop: (conversationId) => {
      stopped.push(conversationId);
      return Promise.resolve();
    },
  });
  const after = await loadTile(sql, tile.id);
  assert.deepEqual([after?.refreshState, after?.refreshError], ['failed', 'timeout']);
  // Its own conversation among those stopped (the tiles of the tests before are past their time too).
  const [own] = await db().owner<{ id: string }[]>`SELECT id::text FROM conversations WHERE dashboard_of = ${tile.sourceConversationId}`;
  assert.ok(own !== undefined && stopped.includes(own.id));
});

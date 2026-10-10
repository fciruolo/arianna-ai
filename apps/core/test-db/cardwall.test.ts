// The cardwall (I-13 tappe C1-C2, D-152): projects and dependencies of the
// cards in the database, the engine that waits for them, and the routes.
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Project } from '@arianna/config';

import { addChecklistItem, addFile, addLink, cardDetail, readCardFile, removeChecklistItem, removeFile, removeLink, updateChecklistItem } from '../src/card-details.ts';
import { addDependency, CardError, createCard, listCards, moveCard, removeDependency, updateCard } from '../src/cardwall.ts';
import { addDays, localDay } from '../src/commitment-dates.ts';
import { createConversation } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, submitTask, type StepExecutor } from '../src/engine.ts';
import { createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { createTask, loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const NAMES = { projects: ['demo', 'progetto-test'], agents: ['coder'] };
const OPTIONS = { allowedActions: () => [], agentLimits: () => ({ maxSteps: 10, maxMinutes: 10 }) };

/** Finishes every step at once and counts them. */
function finishing(): StepExecutor & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    plan: () => ({ agent: 'coder', executor: 'local-model', locality: 'local' }),
    run(ctx) {
      runs.push(ctx.task.id);
      return Promise.resolve({ kind: 'done', evidence: [{ kind: 'test', ref: 'fake' }] });
    },
  };
}

async function drain(executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

const sqlError = /violates|cycle|only between cards|only its removal/;

test('the database: a project only on a card; no dependency on itself, of a chat task or in a cycle; only its removal', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await assert.rejects(createTask(sql, { title: 'Di una chat', conversationId: conversation.id, project: 'demo' }), sqlError);
  await assert.rejects(createTask(sql, { title: 'Nome cattivo', project: '../fuori' }), sqlError);
  const chatTask = await createTask(sql, { title: 'Di una chat', conversationId: conversation.id });
  const a = await createTask(sql, { title: 'Grafica della landing', project: 'demo' });
  const b = await createTask(sql, { title: 'Codice della landing', project: 'demo' });
  const c = await createTask(sql, { title: 'Pubblicare la landing' });
  assert.equal((await loadTask(sql, a.id))?.project, 'demo');

  await assert.rejects(sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${a.id}, ${a.id})`, sqlError);
  await assert.rejects(sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${a.id}, ${chatTask.id})`, sqlError);
  await assert.rejects(sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${chatTask.id}, ${a.id})`, sqlError);
  await sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${b.id}, ${a.id})`;
  await sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${c.id}, ${b.id})`;
  // c → b → a: a waiting for c closes a cycle, directly or not.
  await assert.rejects(sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${a.id}, ${c.id})`, sqlError);
  await assert.rejects(sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${a.id}, ${b.id})`, sqlError);
  // Twice the same live pair: no.
  await assert.rejects(sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${b.id}, ${a.id})`, /duplicate|unique/);

  await assert.rejects(sql`UPDATE task_dependencies SET depends_on = ${c.id} WHERE task_id = ${b.id}`, sqlError);
  await sql`UPDATE task_dependencies SET removed_at = now() WHERE task_id = ${b.id}`;
  await assert.rejects(sql`UPDATE task_dependencies SET removed_at = now() WHERE task_id = ${b.id}`, sqlError);
  // Removed, the pair can come back, and the cycle check ignores the removed row.
  await sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${a.id}, ${b.id})`;
  await assert.rejects(sql`DELETE FROM task_dependencies`, /permission denied/);
});

test('the engine: a task that waits does not start; its step goes on when the last dependency is done', async () => {
  const { sql } = db();
  const first = await createTask(sql, { title: 'Grafica', assignee: 'user' });
  const second = await createTask(sql, { title: 'Testi', assignee: 'user' });
  const task = await submitTask(sql, { title: 'Codice', assignee: 'coder' });
  await sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${task.id}, ${first.id}), (${task.id}, ${second.id})`;
  const executor = finishing();

  assert.deepEqual(await drain(executor), ['blocked']);
  assert.deepEqual(executor.runs, []);
  assert.equal((await loadTask(sql, task.id))?.status, 'ready');
  const runs = await sql`SELECT 1 FROM runs WHERE task_id = ${task.id}`;
  assert.equal(runs.length, 0);

  // One of two done: still waiting, nothing queued.
  await moveCard(sql, first.id, 'done');
  assert.deepEqual(await drain(executor), []);
  // A card nobody started is not started by a dependency done.
  const idle = await createTask(sql, { title: 'Mai partita', assignee: 'coder', status: 'ready' });
  await sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${idle.id}, ${second.id})`;

  await moveCard(sql, second.id, 'done');
  assert.deepEqual(await drain(executor), ['to-verify']);
  assert.deepEqual(executor.runs, [task.id]);
  assert.equal((await loadTask(sql, idle.id))?.status, 'ready');
  const kinds = await sql<{ kind: string }[]>`SELECT kind FROM events WHERE task_id = ${task.id} AND kind IN ('task.blocked', 'task.unblocked') ORDER BY id`;
  assert.deepEqual(kinds.map((row) => row.kind), ['task.blocked', 'task.unblocked']);
});

test('the engine: taking the dependency away lets the held step go on', async () => {
  const { sql } = db();
  const before = await createTask(sql, { title: 'Prima', assignee: 'user' });
  const task = await submitTask(sql, { title: 'Dopo', assignee: 'coder' });
  // A task of a submitted step without a conversation is a card.
  await addDependency(sql, task.id, before.id);
  const executor = finishing();
  assert.deepEqual(await drain(executor), ['blocked']);
  await removeDependency(sql, task.id, before.id);
  assert.deepEqual(await drain(executor), ['to-verify']);
  await assert.rejects(removeDependency(sql, task.id, before.id), CardError);
});

test('cards by hand: written in the inbox, moved, changed; never a card at work or of a chat', async () => {
  const { sql } = db();
  await assert.rejects(createCard(sql, { title: '   ' }, NAMES), CardError);
  await assert.rejects(createCard(sql, { title: 'x', project: 'sconosciuto' }, NAMES), CardError);
  await assert.rejects(createCard(sql, { title: 'x', assignee: 'arianna' }, NAMES), CardError);
  await assert.rejects(createCard(sql, { title: 'x', due: 'domani' }, NAMES), CardError);
  const card = await createCard(sql, { title: 'Comprare il dominio', project: 'demo', due: addDays(localDay(), -1) }, NAMES);
  assert.equal(card.status, 'inbox');
  assert.equal(card.label, 'L2');
  assert.equal(card.conversationId, null);

  // The user's own card: done straight from the inbox.
  assert.equal((await moveCard(sql, card.id, 'done')).status, 'done');
  await assert.rejects(moveCard(sql, card.id, 'ready'), CardError);

  const agentCard = await createCard(sql, { title: 'Sistemare il modulo', assignee: 'coder' }, NAMES);
  await assert.rejects(moveCard(sql, agentCard.id, 'done'), /Da verificare/);
  assert.equal((await moveCard(sql, agentCard.id, 'waiting_user')).waitingReason, 'Messa in attesa a mano.');
  assert.equal((await moveCard(sql, agentCard.id, 'ready')).status, 'ready');
  await assert.rejects(moveCard(sql, agentCard.id, 'running'), CardError);
  await assert.rejects(moveCard(sql, agentCard.id, 'to_verify'), CardError);

  const changed = await updateCard(sql, agentCard.id, { project: 'progetto-test', due: '2026-12-01', assignee: 'user' }, NAMES);
  assert.equal(changed.project, 'progetto-test');
  assert.equal(changed.assignee, 'user');
  assert.equal(localDay(changed.dueAt ?? new Date(0)), '2026-12-01');
  const cleared = await updateCard(sql, agentCard.id, { project: null, due: null }, NAMES);
  assert.equal(cleared.project, null);
  assert.equal(cleared.dueAt, null);

  // A task of a chat is not a card: as if it did not exist.
  const conversation = await createConversation(sql, { mode: 'private' });
  const chatTask = await createTask(sql, { title: 'Di una chat', conversationId: conversation.id });
  await assert.rejects(moveCard(sql, chatTask.id, 'done'), /no such card/);
  await assert.rejects(updateCard(sql, chatTask.id, { due: null }, NAMES), /no such card/);
  await assert.rejects(addDependency(sql, agentCard.id, chatTask.id), /no such card/);

  // At work: not by hand.
  const working = await submitTask(sql, { title: 'In coda', assignee: 'coder' });
  await assert.rejects(moveCard(sql, working.id, 'done'), /at work/);
});

test('the wall: columns, waiting cards, late ones, commitments; closed ones only for a while', async () => {
  const { sql } = db();
  const today = localDay();
  const grafica = await createCard(sql, { title: 'Grafica della landing', project: 'demo' }, NAMES);
  const codice = await createCard(sql, { title: 'Codice della landing', project: 'demo', assignee: 'coder', due: addDays(today, -2) }, NAMES);
  await addDependency(sql, codice.id, grafica.id);
  await assert.rejects(addDependency(sql, grafica.id, codice.id), /each other/);
  await assert.rejects(addDependency(sql, grafica.id, grafica.id), CardError);
  const old = await createCard(sql, { title: 'Vecchia' }, NAMES);
  await moveCard(sql, old.id, 'done');
  await sql`UPDATE tasks SET updated_at = now() - interval '30 days' WHERE id = ${old.id}`;
  await sql`INSERT INTO commitments (body, day, at_time) VALUES ('Banca', ${today}::date, '09:30'), ('Pane', ${addDays(today, -1)}::date, NULL)`;
  await sql`INSERT INTO commitments (body, day, status, done_at) VALUES ('Piante', ${today}::date, 'done', now())`;

  const cards = await listCards(sql, today);
  const byTitle = new Map(cards.map((card) => [card.title, card]));
  assert.equal(byTitle.get('Grafica della landing')?.column, 'inbox');
  const waiting = byTitle.get('Codice della landing');
  assert.equal(waiting?.column, 'waiting');
  assert.deepEqual(waiting.blockedBy.map((ref) => ref.title), ['Grafica della landing']);
  assert.equal(waiting.late, true);
  assert.equal(waiting.project, 'demo');
  assert.equal(byTitle.has('Vecchia'), false);
  assert.deepEqual(
    ['Banca', 'Pane', 'Piante'].map((title) => {
      const item = byTitle.get(title);
      return [item?.kind, item?.column, item?.late, item?.time];
    }),
    [
      ['commitment', 'ready', false, '09:30'],
      ['commitment', 'ready', true, null],
      ['commitment', 'done', false, null],
    ],
  );

  await moveCard(sql, grafica.id, 'done');
  const after = new Map((await listCards(sql, today)).map((card) => [card.title, card]));
  assert.equal(after.get('Codice della landing')?.column, 'inbox');
  assert.deepEqual(after.get('Codice della landing')?.blockedBy, []);
  assert.equal(after.get('Codice della landing')?.dependsOn.length, 1);
});

test('the routes: list, write, move, change, depend; errors as status codes', async () => {
  const live = await startLiveFeed(db().sql);
  const containers = NAMES.projects.map((name) => ({ name }) as Project);
  const server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    projects: () => [],
    agents: () => ['arianna', 'coder'],
    projectContainers: () => containers,
  });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (method: string, path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const empty = (await (await fetch(`${base}/api/cards`)).json()) as { today: string; projects: string[]; agents: string[] };
    assert.equal(empty.today, localDay());
    assert.deepEqual(empty.projects, ['demo', 'progetto-test']);
    // Arianna hands the cards out: she is not among who does them.
    assert.deepEqual(empty.agents, ['coder']);

    assert.equal((await send('POST', '/api/cards', { title: 'x', other: 1 })).status, 400);
    assert.equal((await send('POST', '/api/cards', { title: '' })).status, 400);
    const first = await send('POST', '/api/cards', { title: 'Grafica', project: 'demo' });
    assert.equal(first.status, 201);
    const a = ((await first.json()) as { card: { id: string } }).card.id;
    const b = ((await (await send('POST', '/api/cards', { title: 'Codice', assignee: 'coder' })).json()) as { card: { id: string } }).card.id;

    assert.equal((await send('POST', `/api/cards/${b}/dependencies`, { on: a })).status, 200);
    assert.equal((await send('POST', `/api/cards/${a}/dependencies`, { on: b })).status, 409);
    assert.equal((await send('POST', `/api/cards/${a}/dependencies`, { on: 'nope' })).status, 400);
    const listed = (await (await fetch(`${base}/api/cards`)).json()) as { cards: { id: string; column: string }[] };
    assert.equal(listed.cards.find((card) => card.id === b)?.column, 'waiting');

    assert.equal((await send('POST', `/api/cards/${b}/move`, { to: 'done' })).status, 409);
    assert.equal((await send('POST', `/api/cards/${b}/move`, { to: 'running' })).status, 400);
    assert.equal((await send('POST', `/api/cards/${a}/move`, { to: 'done' })).status, 200);
    assert.equal((await send('POST', `/api/cards/${b}`, { due: '2026-11-02', project: 'progetto-test' })).status, 200);
    assert.equal((await send('POST', `/api/cards/${b}`, { other: 'altro' })).status, 400);
    assert.equal((await send('DELETE', `/api/cards/${b}/dependencies/${a}`)).status, 200);
    assert.equal((await send('DELETE', `/api/cards/${b}/dependencies/${a}`)).status, 404);
    assert.equal((await send('POST', '/api/cards/00000000-0000-4000-8000-000000000000/move', { to: 'done' })).status, 404);
  } finally {
    await server.close();
    await live.close();
  }
});

test('two dependencies done at once: the held step goes on all the same', async () => {
  const { sql } = db();
  await drain(finishing()); // steps left by the tests above
  for (let round = 0; round < 5; round += 1) {
    const a = await createTask(sql, { title: `A ${String(round)}`, assignee: 'user' });
    const b = await createTask(sql, { title: `B ${String(round)}`, assignee: 'user' });
    const task = await submitTask(sql, { title: `C ${String(round)}`, assignee: 'coder' });
    await sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${task.id}, ${a.id}), (${task.id}, ${b.id})`;
    const executor = finishing();
    assert.deepEqual(await drain(executor), ['blocked']);
    await Promise.all([moveCard(sql, a.id, 'done'), moveCard(sql, b.id, 'done')]);
    assert.deepEqual(await drain(executor), ['to-verify'], `round ${String(round)}`);
  }
});

test('a held step put on hold by hand and back goes on; a card the engine stopped does not go back by hand', async () => {
  const { sql } = db();
  await drain(finishing());
  const before = await createTask(sql, { title: 'Prima', assignee: 'user' });
  const task = await submitTask(sql, { title: 'Dopo', assignee: 'coder' });
  await addDependency(sql, task.id, before.id);
  const executor = finishing();
  assert.deepEqual(await drain(executor), ['blocked']);
  // Held, and nothing at work: who does it stays, the user may park it.
  await assert.rejects(updateCard(sql, task.id, { assignee: 'user' }, NAMES), /keeps who does it/);
  assert.equal((await moveCard(sql, task.id, 'waiting_user', 'aspetto il cliente')).status, 'waiting_user');
  await moveCard(sql, before.id, 'done');
  assert.deepEqual(await drain(executor), []);
  await moveCard(sql, task.id, 'ready');
  assert.deepEqual(await drain(executor), ['to-verify']);

  // Stopped by the engine: not from the wall.
  const stopped = await submitTask(sql, { title: 'Ferma', assignee: 'coder' });
  await drain({ ...finishing(), run: () => Promise.resolve({ kind: 'wait-user', reason: 'Serve una scelta.' }) });
  assert.equal((await loadTask(sql, stopped.id))?.status, 'waiting_user');
  await assert.rejects(moveCard(sql, stopped.id, 'ready'), /by hand yet/);
  await assert.rejects(updateCard(sql, stopped.id, { assignee: 'user' }, NAMES), /keeps who does it/);
});

test('the reason written by hand stays only on a private card', async () => {
  const { sql } = db();
  const low = await createTask(sql, { title: 'Interna', label: 'L1', clearance: 'L1', assignee: 'user' });
  assert.equal((await moveCard(sql, low.id, 'waiting_user', 'il cliente Rossi non paga')).waitingReason, 'Messa in attesa a mano.');
  const own = await createCard(sql, { title: 'Privata' }, NAMES);
  assert.equal((await moveCard(sql, own.id, 'waiting_user', 'aspetto la risposta')).waitingReason, 'aspetto la risposta');
  // Waiting, it no longer takes a dependency.
  await assert.rejects(addDependency(sql, own.id, low.id), /still to do/);
});

test('the card in full: body, criteria, priority, planned day; links, checklist, files and history', async () => {
  const { sql } = db();
  const dir = mkdtempSync(join(tmpdir(), 'arianna-cards-'));
  try {
    const low = await createTask(sql, { title: 'Di Arianna', label: 'L1', clearance: 'L1', assignee: 'user' });
    await assert.rejects(updateCard(sql, low.id, { priority: 5 }, NAMES), /priority/);
    await assert.rejects(updateCard(sql, low.id, { planned: 'lunedì' }, NAMES), /planned/);
    // Priority and day are not text of the user's: the label stays.
    assert.equal((await updateCard(sql, low.id, { priority: 3, planned: '2026-10-20' }, NAMES)).label, 'L1');
    const changed = await updateCard(sql, low.id, { goal: 'Scrivere i testi.\n\n- home\n- contatti', criteria: 'Approvati dal cliente' }, NAMES);
    assert.equal(changed.label, 'L2');
    assert.equal(changed.priority, 3);
    assert.equal(changed.plannedOn, '2026-10-20');
    assert.equal(changed.goal, 'Scrivere i testi.\n\n- home\n- contatti');
    assert.equal((await updateCard(sql, low.id, { goal: '' }, NAMES)).goal, null);

    await assert.rejects(addLink(sql, low.id, { url: 'javascript:alert(1)' }), /web address/);
    await assert.rejects(addLink(sql, low.id, { url: 'file:///etc/passwd' }), /web address/);
    const link = await addLink(sql, low.id, { url: 'https://example.com/figma', title: 'Figma' });
    const item = await addChecklistItem(sql, low.id, { body: 'Home' });
    await addChecklistItem(sql, low.id, { body: 'Contatti' });
    assert.equal((await updateChecklistItem(sql, low.id, item.id, { done: true })).done, true);
    await assert.rejects(updateChecklistItem(sql, low.id, item.id, { done: 'sì' }), CardError);

    const bytes = Buffer.from('%PDF-1.4 brief finto');
    await assert.rejects(addFile(sql, dir, low.id, { name: 'x', data: 'non base64!' }), /base64/);
    const file = await addFile(sql, dir, low.id, { name: 'a/b.pdf', type: 'application/pdf', data: bytes.toString('base64') });
    assert.equal(file.name, 'a_b.pdf');
    assert.equal(file.label, 'L2');
    assert.equal(statSync(join(dir, low.id, file.id)).mode & 0o777, 0o600);
    assert.deepEqual((await readCardFile(sql, dir, low.id, file.id)).bytes, bytes);
    // Changed on disk behind the core's back: not served.
    writeFileSync(join(dir, low.id, file.id), 'altro');
    await assert.rejects(readCardFile(sql, dir, low.id, file.id), /changed on disk/);

    const wall = (await listCards(sql)).find((card) => card.id === low.id);
    assert.deepEqual([wall?.priority, wall?.planned, wall?.links, wall?.files, wall?.checklist, wall?.hasBody], [3, '2026-10-20', 1, 1, { done: 1, total: 2 }, true]);

    await removeLink(sql, low.id, link.id);
    await assert.rejects(removeLink(sql, low.id, link.id), /no such link/);
    await removeChecklistItem(sql, low.id, item.id);
    await removeFile(sql, low.id, file.id);
    await assert.rejects(readCardFile(sql, dir, low.id, file.id), /no such file/);
    await assert.rejects(sql`UPDATE card_links SET removed_at = NULL WHERE id = ${link.id}`, /stays removed/);
    await assert.rejects(sql`DELETE FROM card_files`, /permission denied/);

    const detail = await cardDetail(sql, low.id);
    assert.deepEqual([detail.links.length, detail.checklist.map((entry) => entry.body), detail.files.length], [0, ['Contatti'], 0]);
    assert.ok(detail.history.some((entry) => entry.kind === 'task.created'));
    assert.ok(detail.history.some((entry) => entry.kind === 'card.changed' && entry.payload.file === 'added'));
    // The history carries names and ids, never the text of the card.
    assert.doesNotMatch(JSON.stringify(detail.history), /Figma|Contatti|brief|testi/);

    // A tick or a removal writes nothing new: the label stays; nothing to change is refused.
    const ticked = await createTask(sql, { title: 'Spunte', label: 'L1', clearance: 'L1', assignee: 'user' });
    await sql`INSERT INTO card_checklist (task_id, body, position) VALUES (${ticked.id}, 'Uno', 1)`;
    const [row] = await sql<{ id: string }[]>`SELECT id::text FROM card_checklist WHERE task_id = ${ticked.id}`;
    await updateChecklistItem(sql, ticked.id, row?.id ?? '', { done: true });
    await removeChecklistItem(sql, ticked.id, row?.id ?? '');
    assert.equal((await loadTask(sql, ticked.id))?.label, 'L1');
    await assert.rejects(updateChecklistItem(sql, ticked.id, row?.id ?? '', {}), /nothing to change/);

    // Too large, and a folder of a card that is a link: refused.
    await assert.rejects(addFile(sql, dir, low.id, { name: 'grande.bin', data: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') }), /20 MB/);
    const other = await createTask(sql, { title: 'Link', assignee: 'user' });
    const kept = await addFile(sql, dir, other.id, { name: 'a.txt', type: 'text/plain', data: Buffer.from('à').toString('base64') });
    renameSync(join(dir, other.id), join(dir, `${other.id}-real`));
    symlinkSync(join(dir, `${other.id}-real`), join(dir, other.id));
    await assert.rejects(readCardFile(sql, dir, other.id, kept.id), /missing/);

    // Only on cards.
    const conversation = await createConversation(sql, { mode: 'private' });
    const chatTask = await createTask(sql, { title: 'Di una chat', conversationId: conversation.id });
    await assert.rejects(addLink(sql, chatTask.id, { url: 'https://example.com' }), /no such card/);
    await assert.rejects(sql`INSERT INTO card_checklist (task_id, body, position) VALUES (${chatTask.id}, 'x', 1)`, /only on cards/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the routes of the card in full; a file shown inline or downloaded, never run', async () => {
  const live = await startLiveFeed(db().sql);
  const dir = mkdtempSync(join(tmpdir(), 'arianna-cards-'));
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [], cards: { dir } });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (method: string, path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await send('POST', '/api/cards', { title: 'Brief', goal: 'Testo', criteria: 'Fatto', priority: 2, planned: '2026-10-21' });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { card: { id: string } }).card.id;
    assert.equal((await send('POST', `/api/cards/${id}/links`, { url: 'https://example.com', other: 1 })).status, 400);
    assert.equal((await send('POST', `/api/cards/${id}/links`, { url: 'ftp://x' })).status, 400);
    assert.equal((await send('POST', `/api/cards/${id}/links`, { url: 'https://example.com' })).status, 201);
    const item = ((await (await send('POST', `/api/cards/${id}/checklist`, { body: 'Uno' })).json()) as { item: { id: string } }).item.id;
    assert.equal((await send('POST', `/api/cards/${id}/checklist/${item}`, { done: true })).status, 200);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const image = ((await (await send('POST', `/api/cards/${id}/files`, { name: 'logo.png', type: 'image/png', data: png.toString('base64') })).json()) as { file: { id: string } }).file.id;
    const html = ((await (await send('POST', `/api/cards/${id}/files`, { name: 'pagina.html', type: 'text/html', data: Buffer.from('<script>1</script>').toString('base64') })).json()) as { file: { id: string } }).file.id;

    const shown = await fetch(`${base}/api/cards/${id}/files/${image}`);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.match(shown.headers.get('content-disposition') ?? '', /^inline/);
    assert.match(shown.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);
    const downloaded = await fetch(`${base}/api/cards/${id}/files/${html}`);
    assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
    assert.match(downloaded.headers.get('content-disposition') ?? '', /^attachment; filename="pagina.html"/);
    await downloaded.arrayBuffer();

    const detail = (await (await fetch(`${base}/api/cards/${id}`)).json()) as { card: { goal: string; criteria: string; links: unknown[]; checklist: { done: boolean }[]; files: unknown[] } };
    assert.deepEqual([detail.card.goal, detail.card.criteria, detail.card.links.length, detail.card.checklist[0]?.done, detail.card.files.length], ['Testo', 'Fatto', 1, true, 2]);
    assert.equal((await send('DELETE', `/api/cards/${id}/files/${html}`)).status, 200);
    assert.equal((await fetch(`${base}/api/cards/${id}/files/${html}`)).status, 404);
    assert.equal((await fetch(`${base}/api/cards/00000000-0000-4000-8000-000000000000`)).status, 404);

    // A PDF is downloaded (no viewer in a sandbox); text is UTF-8; a name not ASCII is kept in filename*.
    const pdf = ((await (await send('POST', `/api/cards/${id}/files`, { name: 'Perché "brief".pdf', type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') })).json()) as { file: { id: string } }).file.id;
    const pdfResponse = await fetch(`${base}/api/cards/${id}/files/${pdf}`);
    await pdfResponse.arrayBuffer();
    assert.equal(pdfResponse.headers.get('content-type'), 'application/octet-stream');
    assert.equal(pdfResponse.headers.get('content-disposition'), `attachment; filename="Perch_ _brief_.pdf"; filename*=UTF-8''Perch%C3%A9%20%22brief%22.pdf`);
    const text = ((await (await send('POST', `/api/cards/${id}/files`, { name: 'nota.txt', type: 'text/plain', data: Buffer.from('caffè').toString('base64') })).json()) as { file: { id: string } }).file.id;
    const textResponse = await fetch(`${base}/api/cards/${id}/files/${text}`);
    assert.equal(textResponse.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await textResponse.text(), 'caffè');
  } finally {
    await server.close();
    await live.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without the folder of the files, the file routes answer 404', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [] });
  const base = `http://127.0.0.1:${String(server.port)}`;
  try {
    const card = await createCard(db().sql, { title: 'Senza cartella' }, NAMES);
    const response = await fetch(`${base}/api/cards/${card.id}/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a.txt', data: '' }) });
    assert.equal(response.status, 404);
  } finally {
    await server.close();
    await live.close();
  }
});

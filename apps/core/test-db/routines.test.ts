// The routines (D-110 tappa A, D-254) against PostgreSQL: a routine and its
// private conversation, the report written by code once per time (a positive
// and a negative case per source), late and missed runs after the Mac was
// off, «Prova adesso», the pause when the conversation is archived, and the
// summary of the local model with its wait (D-100). Fake data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { captureNote } from '../src/capture.ts';
import { startLiveFeed } from '../src/live.ts';
import { archiveConversation, listConversations, purgeConversation } from '../src/conversations.ts';
import {
  claimRun,
  createRoutine,
  createRoutineService,
  createRoutineSummarizer,
  createRoutineTicker,
  listRoutines,
  loadRoutine,
  pauseRoutine,
  resumeRoutine,
  retireRoutine,
  runDue,
  runNow,
  SUMMARY_QUEUE,
  SUMMARY_UNAVAILABLE_TEXT,
  SUMMARY_NO_FACTS_TEXT,
  SUMMARY_UNCHECKED_TEXT,
  updateRoutine,
  type RoutineEnv,
  type RoutineInput,
  type RoutineSource,
} from '../src/routines.ts';
import type { IsoDay } from '../src/routine-schedule.ts';
import { startApiServer } from '../src/server/http.ts';
import { createTask, moveTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const RULES = parseLabelRules('');
const scratch = join(resolveHome({}), 'data', 'test-tmp', `routines-${randomUUID()}`);
mkdirSync(join(scratch, 'kb'), { recursive: true });
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function env(now?: Date): RoutineEnv {
  return { sql: db().sql, home: scratch, rules: RULES, ...(now === undefined ? {} : { now: () => now }) };
}

const MINUTE = 60_000;

/** The minute `minutesAgo` before now, and its "HH:MM" in UTC. */
function minuteAgo(minutesAgo: number): { at: Date; clock: string } {
  const at = new Date(Math.floor((Date.now() - minutesAgo * MINUTE) / MINUTE) * MINUTE);
  return { at, clock: `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}` };
}

/** A routine every day in UTC whose time was `minutesAgo` minutes ago, with that run still to do. */
async function dueRoutine(minutesAgo: number, sources: RoutineSource[], extra: Partial<RoutineInput> = {}): Promise<{ id: string; conversationId: string; due: Date }> {
  const { at, clock } = minuteAgo(minutesAgo);
  const routine = await createRoutine(db().sql, { title: 'Resoconto finto', days: [1, 2, 3, 4, 5, 6, 7], at: clock, timezone: 'UTC', sources, summary: false, ...extra });
  await db().sql`UPDATE routines SET next_run_at = ${at} WHERE id = ${routine.id}`;
  return { id: routine.id, conversationId: routine.conversationId, due: at };
}

async function messagesOf(conversationId: string): Promise<{ id: string; body: string; label: string; role: string }[]> {
  return db().sql<{ id: string; body: string; label: string; role: string }[]>`
    SELECT id::text, body, label::text AS label, role FROM messages WHERE conversation_id = ${conversationId} ORDER BY id`;
}

async function card(title: string, options: { assignee?: string; status?: 'inbox' | 'ready' | 'running' | 'to_verify'; label?: 'L1' | 'L2' | 'L3'; dueAt?: Date } = {}): Promise<string> {
  const task = await createTask(db().sql, {
    title,
    assignee: options.assignee ?? 'user',
    status: options.status === 'ready' ? 'ready' : 'inbox',
    label: options.label ?? 'L2',
    ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt }),
  });
  if (options.status === 'running' || options.status === 'to_verify') await db().sql.begin((tx) => moveTask(tx, task.id, 'running', { from: ['inbox'] }));
  if (options.status === 'to_verify') await db().sql.begin((tx) => moveTask(tx, task.id, 'to_verify', { from: ['running'], evidence: [{ kind: 'test' }] }));
  return task.id;
}

async function closeCard(id: string, to: 'done' | 'failed'): Promise<void> {
  await db().sql.begin((tx) => moveTask(tx, id, to, { from: ['inbox', 'ready', 'running', 'to_verify'], cause: 'user', evidence: [{ kind: 'test' }] }));
}

test('a routine is born active with its own private conversation, marked in the list', async () => {
  const now = new Date('2026-10-19T08:00:00Z');
  const routine = await createRoutine(db().sql, { title: 'Buongiorno', days: [1, 2, 3, 4, 5], at: '18:00', timezone: 'Europe/Rome', sources: ['todo', 'waiting'], summary: false }, now);
  assert.equal(routine.status, 'active');
  assert.equal(routine.nextRunAt?.toISOString(), '2026-10-19T16:00:00.000Z');
  const [conversation] = await db().sql<{ mode: string; clearance: string; title: string; origin: string }[]>`
    SELECT mode, clearance::text, title, origin FROM conversations WHERE id = ${routine.conversationId}`;
  assert.deepEqual(conversation, { mode: 'private', clearance: 'L2', title: 'Routine · Buongiorno', origin: 'user' });
  const listed = (await listConversations(db().sql)).find((item) => item.id === routine.conversationId);
  assert.equal(listed?.routine, true);
  // The event names ids only, never the title.
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'routine.created' AND payload ->> 'routineId' = ${routine.id}`;
  assert.ok(event !== undefined);
  assert.ok(!JSON.stringify(event.payload).includes('Buongiorno'));
});

test('a run due writes the report once, as Arianna, and moves to the next time', async () => {
  const { id, conversationId, due } = await dueRoutine(1, ['todo']);
  const first = await runDue(env(), id);
  assert.equal(first.kind, 'done');
  assert.equal(first.late, false);
  assert.deepEqual(await runDue(env(), id), { kind: 'none' });
  const messages = await messagesOf(conversationId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0].label, 'L2');
  assert.match(messages[0].body, /^Resoconto di /);
  const routine = await loadRoutine(db().sql, id);
  assert.ok((routine?.nextRunAt?.getTime() ?? 0) > Date.now());
  assert.equal(routine?.lastRun?.status, 'done');
  assert.equal(routine.lastRun.scheduledFor.toISOString(), due.toISOString());
  // The unique index keeps a second row of the same time out, whatever the caller.
  await assert.rejects(db().sql`INSERT INTO routine_runs (routine_id, scheduled_for, trigger, status, message_id) VALUES (${id}, ${due}, 'schedule', 'done', 1)`);
});

test('todo: the open cards of the user by due date; a card done or of an agent is not there; an L3 card is only counted', async () => {
  const soon = await card('Pagare la bolletta finta', { dueAt: new Date(Date.now() + 86_400_000) });
  await card('Telefonare al fornitore finto');
  await card('Card di un agente finta', { assignee: 'coder' });
  const closed = await card('Cosa già fatta finta');
  await closeCard(closed, 'done');
  await card('Busta segreta finta', { label: 'L3' });
  const { id, conversationId } = await dueRoutine(1, ['todo']);
  await runDue(env(), id);
  const [message] = await messagesOf(conversationId);
  const body = message?.body ?? '';
  assert.match(body, /Da fare \(3\):/);
  assert.match(body, /- Pagare la bolletta finta · scade domani/);
  assert.ok(body.indexOf('Pagare la bolletta finta') < body.indexOf('Telefonare al fornitore finto'), 'by due date first');
  assert.ok(!body.includes('Card di un agente finta'));
  assert.ok(!body.includes('Cosa già fatta finta'));
  assert.ok(!body.includes('Busta segreta finta'));
  assert.match(body, /\+ 1 riservata, solo contata/);
  assert.equal(message?.label, 'L2');
  await closeCard(soon, 'done');
});

test('waiting: the decisions waiting for the user are counted; none says none', async () => {
  const empty = await dueRoutine(1, ['waiting']);
  await runDue(env(), empty.id);
  assert.match((await messagesOf(empty.conversationId))[0]?.body ?? '', /Decisioni in attesa: nessuna\./);
  const [conversation] = await db().sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance) VALUES ('private', 'L2') RETURNING id::text`;
  assert.ok(conversation !== undefined);
  const task = await createTask(db().sql, { title: 'Domanda finta', conversationId: conversation.id, assignee: 'arianna' });
  await db().sql.begin((tx) => moveTask(tx, task.id, 'waiting_user', { reason: 'una domanda', from: ['inbox'] }));
  const one = await dueRoutine(1, ['waiting']);
  await runDue(env(), one.id);
  assert.match((await messagesOf(one.conversationId))[0]?.body ?? '', /Arianna aspetta una tua decisione\./);
  await db().sql.begin((tx) => moveTask(tx, task.id, 'done', { from: ['waiting_user'], evidence: [{ kind: 'test' }] }));
});

test('cards: the cards at work are named and those to verify counted; a card in the inbox is not at work', async () => {
  const running = await card('Rifare il preventivo finto', { assignee: 'coder', status: 'running' });
  const verify = await card('Controllare il report finto', { assignee: 'coder', status: 'to_verify' });
  const waitingCard = await card('Card ferma in inbox finta', { assignee: 'coder' });
  const { id, conversationId } = await dueRoutine(1, ['cards']);
  await runDue(env(), id);
  const body = (await messagesOf(conversationId))[0]?.body ?? '';
  assert.match(body, /In corso \(1\): Una carta è da verificare\./);
  assert.match(body, /- Rifare il preventivo finto/);
  assert.ok(!body.includes('Card ferma in inbox finta'));
  for (const cardId of [running, verify]) await closeCard(cardId, 'done');
  await closeCard(waitingCard, 'failed');
});

test('done and failed: only what moved after the previous report', async () => {
  const before = await card('Fatta prima finta', { assignee: 'coder', status: 'running' });
  const brokenBefore = await card('Fallita prima finta', { assignee: 'coder', status: 'running' });
  await closeCard(before, 'done');
  await closeCard(brokenBefore, 'failed');
  const { id, conversationId } = await dueRoutine(1, ['done-since', 'failed-since']);
  await runDue(env(), id);
  const first = (await messagesOf(conversationId))[0]?.body ?? '';
  // The first report looks back a day: both are there.
  assert.match(first, /- Fatta prima finta/);
  assert.match(first, /- Fallita prima finta/);
  // The next one: only what moved since the first.
  const after = await card('Fatta dopo finta', { assignee: 'coder', status: 'running' });
  await closeCard(after, 'done');
  const { at } = minuteAgo(0);
  await db().sql`UPDATE routines SET next_run_at = ${at} WHERE id = ${id}`;
  const second = await runDue(env(new Date(at.getTime() + 30_000)), id);
  assert.equal(second.kind, 'done');
  const body = (await messagesOf(conversationId))[1]?.body ?? '';
  assert.match(body, /Fatto dall’ultimo resoconto \(1\):\n- Fatta dopo finta/);
  assert.ok(!body.includes('Fatta prima finta'));
  assert.match(body, /Fallito dall’ultimo resoconto: niente\./);
});

test('notes: the new thoughts of kb/inbox are counted, an organized one is not, nor their titles', async () => {
  captureNote({ home: scratch, rules: RULES, text: 'Idea finta per il giardino', kind: 'thought', source: { channel: 'cli', id: 'test' } });
  captureNote({ home: scratch, rules: RULES, text: 'Altro pensiero finto', kind: 'thought', source: { channel: 'cli', id: 'test' } });
  writeFileSync(join(scratch, 'kb', 'inbox', '2026-10-01-0900-riordinata.md'), '---\nlabel: L2\nstatus: organized\ntitle: "Riordinata finta"\n---\n\nTesto finto.\n');
  const { id, conversationId } = await dueRoutine(1, ['notes']);
  await runDue(env(), id);
  const body = (await messagesOf(conversationId))[0]?.body ?? '';
  assert.match(body, /Pensieri da riordinare: 2\./);
  assert.ok(!body.includes('giardino'));
});

test('a run found late within two hours says sorry and delivers; beyond, one line that it was missed', async () => {
  const late = await dueRoutine(40, ['notes']);
  const outcome = await runDue(env(), late.id);
  assert.deepEqual(outcome.kind === 'done' && outcome.late, true);
  const [lateMessage] = await messagesOf(late.conversationId);
  assert.match(lateMessage?.body ?? '', /^Scusa il ritardo: il resoconto doveva arrivare /);
  assert.equal((await loadRoutine(db().sql, late.id))?.lastRun?.reason, 'late');

  const missed = await dueRoutine(180, ['todo', 'notes'], { summary: true });
  const missedOutcome = await runDue(env(), missed.id);
  assert.equal(missedOutcome.kind, 'missed');
  const messages = await messagesOf(missed.conversationId);
  assert.equal(messages.length, 1);
  assert.match(messages[0]?.body ?? '', /^Ho saltato la routine di .*: il Mac era spento o Arianna non era attiva\. La prossima è /);
  assert.equal(messages[0]?.label, 'L0');
  const routine = await loadRoutine(db().sql, missed.id);
  assert.equal(routine?.lastRun?.status, 'missed-offline');
  assert.ok((routine.nextRunAt?.getTime() ?? 0) > Date.now());
  // Nothing to summarize for a run missed.
  const [jobs] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM jobs WHERE queue = ${SUMMARY_QUEUE} AND payload ->> 'routineId' = ${missed.id}`;
  assert.equal(jobs?.count, 0);
});

test('«Prova adesso» writes the report now without moving the schedule; a paused routine can be tried', async () => {
  const routine = await createRoutine(db().sql, { title: 'Prova finta', days: [3], at: '07:30', timezone: 'Europe/Rome', sources: ['notes'], summary: false });
  const { messageId } = await runNow(env(), routine.id);
  assert.ok(messageId !== null);
  const [message] = await messagesOf(routine.conversationId);
  assert.match(message?.body ?? '', /^Prova della routine: ecco il resoconto di adesso\. Il prossimo arriva mercoledì /);
  const after = await loadRoutine(db().sql, routine.id);
  assert.equal(after?.nextRunAt?.toISOString(), routine.nextRunAt?.toISOString());
  assert.equal(after?.lastRun?.trigger, 'manual');
  await pauseRoutine(db().sql, routine.id);
  await runNow(env(), routine.id);
  assert.equal((await messagesOf(routine.conversationId)).length, 2);
});

test('archiving the conversation pauses the routine; resuming brings the conversation back', async () => {
  const { id, conversationId } = await dueRoutine(1, ['todo']);
  await archiveConversation(db().sql, conversationId, true);
  const paused = await loadRoutine(db().sql, id);
  assert.equal(paused?.status, 'paused');
  assert.equal(paused.pausedBy, 'archived');
  assert.equal(paused.nextRunAt, null);
  assert.deepEqual(await runDue(env(), id), { kind: 'none' });
  await assert.rejects(runNow(env(), id), /archived/);
  const resumed = await resumeRoutine(db().sql, id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.conversationArchived, false);
  assert.ok((resumed.nextRunAt?.getTime() ?? 0) > Date.now());
});

test('the ticker runs what is due; a routine paused or removed does not run', async () => {
  const due = await dueRoutine(1, ['notes']);
  const paused = await dueRoutine(1, ['notes']);
  await pauseRoutine(db().sql, paused.id);
  const retired = await dueRoutine(1, ['notes']);
  await retireRoutine(db().sql, retired.id);
  const ticker = createRoutineTicker(env());
  await ticker.tick();
  assert.equal((await messagesOf(due.conversationId)).length, 1);
  assert.equal((await messagesOf(paused.conversationId)).length, 0);
  assert.equal((await messagesOf(retired.conversationId)).length, 0);
  assert.ok(!(await listRoutines(db().sql)).some((routine) => routine.id === retired.id));
  // A routine removed stays as it was.
  await assert.rejects(db().sql`UPDATE routines SET status = 'active', next_run_at = now() WHERE id = ${retired.id}`);
});

test('a change of the rule moves the next run and the conversation title follows the routine', async () => {
  const now = new Date('2026-10-19T08:00:00Z');
  const routine = await createRoutine(db().sql, { title: 'Sera finta', days: [1], at: '18:00', timezone: 'Europe/Rome', sources: ['todo'], summary: false }, now);
  const changed = await updateRoutine(db().sql, routine.id, { title: 'Mattina finta', at: '09:00', days: [2] }, now);
  assert.equal(changed.nextRunAt?.toISOString(), '2026-10-20T07:00:00.000Z');
  const [conversation] = await db().sql<{ title: string }[]>`SELECT title FROM conversations WHERE id = ${routine.conversationId}`;
  assert.equal(conversation?.title, 'Routine · Mattina finta');
  const [event] = await db().sql<{ payload: { fields: string[] } }[]>`SELECT payload FROM events WHERE kind = 'routine.updated' AND payload ->> 'routineId' = ${routine.id}`;
  assert.deepEqual(event?.payload.fields, ['at', 'days', 'title']);
});

/**
 * The summarizer takes the oldest job of the whole queue. A routine created
 * with a fake clock (the tests above use 19 October 2026) is due for real once
 * that time is past, and the ticker test runs every routine due: a summary it
 * queues would be taken instead of the test's own. Those routines have no
 * summary; a summary test still closes what is left in the queue first (the
 * app role cannot delete a job). Test-only: their runs stay 'queued', the app
 * settles a summary with settleSummary.
 */
async function emptySummaryQueue(): Promise<void> {
  await db().sql`UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE queue = ${SUMMARY_QUEUE} AND status IN ('queued', 'running')`;
}

function fakeModel(answer: (request: ChatRequest) => unknown): LocalModel {
  return {
    chat: (request) => {
      const value = answer(request);
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'fake', model: 'fake', durationMs: 1 });
    },
  };
}

test('the summary: the report only goes to the local model, the lines come back with its label', async () => {
  await emptySummaryQueue();
  await card('Rinnovare il dominio finto');
  const { id, conversationId } = await dueRoutine(1, ['todo'], { summary: true });
  await runDue(env(), id);
  const seen: string[] = [];
  const summarizer = createRoutineSummarizer({
    sql: db().sql,
    model: () =>
      fakeModel((request) => {
        seen.push(request.messages.map((message) => message.content).join('\n'));
        return { lines: ['La cosa più urgente è rinnovare il dominio finto.'] };
      }),
    busy: () => Promise.resolve(false),
  });
  assert.equal(await summarizer.step(), 'done');
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /\{"oggi":"[a-zì]+ \d+ [a-z]+ \d{4}","resoconto":\{"da_fare":\{"totale":\d+,"elencate":\[/);
  assert.match(seen[0] ?? '', /"titolo":"Rinnovare il dominio finto"/);
  const messages = await messagesOf(conversationId);
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.body, 'In sintesi:\n- La cosa più urgente è rinnovare il dominio finto.');
  assert.equal(messages[1].label, messages[0]?.label);
  assert.equal((await loadRoutine(db().sql, id))?.lastRun?.summaryState, 'done');
});

test('the summary waits while the model is not ready, and after 20 minutes the report stays without it', async () => {
  await emptySummaryQueue();
  const { id, conversationId } = await dueRoutine(1, ['notes'], { summary: true });
  await runDue(env(), id);
  let calls = 0;
  const model = (): LocalModel => fakeModel(() => {
    calls += 1;
    return new LocalModelError('unavailable', 'down');
  });
  const waiting = createRoutineSummarizer({ sql: db().sql, model, modelReady: () => false, busy: () => Promise.resolve(false) });
  assert.equal(await waiting.step(), 'idle');
  assert.equal(calls, 0);
  // Twenty minutes later, the model still down: one line, no call.
  const later = createRoutineSummarizer({ sql: db().sql, model, modelReady: () => false, busy: () => Promise.resolve(false), now: () => new Date(Date.now() + 21 * MINUTE) });
  assert.equal(await later.step(), 'expired');
  assert.equal(calls, 0);
  const messages = await messagesOf(conversationId);
  assert.equal(messages[messages.length - 1]?.body, SUMMARY_UNAVAILABLE_TEXT);
  assert.equal((await loadRoutine(db().sql, id))?.lastRun?.summaryState, 'unavailable');
});

test('a summary whose model does not answer goes back to the queue', async () => {
  await emptySummaryQueue();
  const { id } = await dueRoutine(1, ['notes'], { summary: true });
  await runDue(env(), id);
  const summarizer = createRoutineSummarizer({ sql: db().sql, model: () => fakeModel(() => new LocalModelError('unavailable', 'down')), busy: () => Promise.resolve(false) });
  assert.equal(await summarizer.step(), 'retry');
  assert.equal((await loadRoutine(db().sql, id))?.lastRun?.summaryState, 'queued');
});

test('the database keeps a routine in a private conversation of its own', async () => {
  const [work] = await db().sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance) VALUES ('work', 'L1') RETURNING id::text`;
  assert.ok(work !== undefined);
  await assert.rejects(db().sql`
    INSERT INTO routines (title, conversation_id, days, at, timezone, sources, status, next_run_at, approved_at)
    VALUES ('Finta', ${work.id}, '{1}', '09:00', 'UTC', '{todo}', 'active', now(), now())`);
  const routine = await createRoutine(db().sql, { title: 'Unica finta', days: [1], at: '09:00', timezone: 'UTC', sources: ['todo'] });
  await assert.rejects(db().sql`UPDATE routines SET conversation_id = ${work.id} WHERE id = ${routine.id}`);
  await assert.rejects(db().sql`UPDATE routines SET sources = '{email.important}' WHERE id = ${routine.id}`);
  await assert.rejects(db().sql`DELETE FROM routines WHERE id = ${routine.id}`);
});

test('the routes of the page: create, change, pause, resume, «Prova adesso», «Togli»', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [], routines: createRoutineService(env()) });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (method: string, path: string, body: unknown = {}) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await send('POST', '/api/routines', { title: 'Sera finta', days: [1, 2, 3, 4, 5, 6, 7], at: '18:00', sources: ['todo', 'notes'], summary: false });
    assert.equal(created.status, 201);
    const { routine } = (await created.json()) as { routine: { id: string; status: string; timezone: string; conversationId: string } };
    assert.equal(routine.status, 'active');
    assert.ok(routine.timezone.length > 0);
    assert.equal((await send('POST', '/api/routines', { title: 'x', days: [1], at: '18:00', sources: ['todo'], prompt: 'altro' })).status, 400);
    assert.equal((await send('PATCH', `/api/routines/${routine.id}`, { at: '19:30' })).status, 200);
    assert.equal(((await (await send('POST', `/api/routines/${routine.id}/pause`)).json()) as { routine: { status: string } }).routine.status, 'paused');
    assert.equal(((await (await send('POST', `/api/routines/${routine.id}/resume`)).json()) as { routine: { status: string } }).routine.status, 'active');
    assert.equal((await send('POST', `/api/routines/${routine.id}/run`)).status, 201);
    assert.equal((await messagesOf(routine.conversationId)).length, 1);
    const listed = (await (await fetch(`${base}/api/routines`)).json()) as { routines: { id: string; at: string; lastRun: { trigger: string } | null }[] };
    const mine = listed.routines.find((item) => item.id === routine.id);
    assert.equal(mine?.at, '19:30');
    assert.equal(mine.lastRun?.trigger, 'manual');
    assert.equal((await send('POST', `/api/routines/${routine.id}/retire`)).status, 200);
    assert.equal((await send('POST', `/api/routines/${routine.id}/run`)).status, 404);
    assert.equal((await send('POST', '/api/routines/00000000-0000-4000-8000-000000000000/pause')).status, 404);
  } finally {
    await server.close();
    await live.close();
  }
});

test('the calendar of the page (D-257): the times of the week with the outcome; a range too long refused', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [], routines: createRoutineService(env()) });
  const base = `http://127.0.0.1:${String(server.port)}`;
  try {
    // A routine every day in UTC, with its run of 3 minutes ago written.
    const { id, due } = await dueRoutine(3, ['notes']);
    await runDue(env(), id);
    const paused = await createRoutine(db().sql, { title: 'Pausa finta', days: [1, 2, 3, 4, 5, 6, 7], at: '06:00', timezone: 'UTC', sources: ['todo'] });
    await pauseRoutine(db().sql, paused.id);
    const gone = await createRoutine(db().sql, { title: 'Tolta finta', days: [1, 2, 3, 4, 5, 6, 7], at: '07:00', timezone: 'UTC', sources: ['todo'] });
    await retireRoutine(db().sql, gone.id);
    const day = due.toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
    const response = await fetch(`${base}/api/routines/calendar?from=${day}&to=${next}&tz=UTC`);
    assert.equal(response.status, 200);
    const week = (await response.json()) as { days: { date: string }[]; entries: { routineId: string; at: string; run: { status: string } | null; planned: boolean }[] };
    assert.equal(week.days.length, 2);
    const mine = week.entries.filter((item) => item.routineId === id);
    const written = mine.find((item) => item.at === due.toISOString());
    assert.equal(written?.run?.status, 'done');
    // The test moved the run before the routine was born: it stands apart from the times of the rule.
    assert.equal(written.planned, false);
    // Tomorrow's time is there, still to run.
    assert.ok(mine.some((item) => item.planned && item.run === null && Date.parse(item.at) > due.getTime()));
    assert.ok(week.entries.some((item) => item.routineId === paused.id));
    assert.ok(!week.entries.some((item) => item.routineId === gone.id));
    // Ids only: the titles stay in the list of the page.
    assert.ok(!JSON.stringify(week).includes('finta'));
    const far = new Date(Date.parse(`${day}T00:00:00Z`) + 15 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await fetch(`${base}/api/routines/calendar?from=${day}&to=${far}&tz=UTC`)).status, 400);
    assert.equal((await fetch(`${base}/api/routines/calendar?from=${day}&to=${next}&tz=Europe%2FNowhere`)).status, 400);
    assert.equal((await fetch(`${base}/api/routines/calendar?to=${next}`)).status, 400);
    assert.equal((await fetch(`${base}/api/routines/calendar?from=2026-02-30&to=2026-03-02&tz=UTC`)).status, 400);
    assert.equal((await fetch(`${base}/api/routines/calendar?from=${day}&to=${day}&tz=UTC`)).status, 400);
    assert.equal((await fetch(`${base}/api/routines/calendar?from=${next}&to=${day}&tz=UTC`)).status, 400);
  } finally {
    await server.close();
    await live.close();
  }
  const bare = await startLiveFeed(db().sql);
  const without = await startApiServer({ sql: db().sql, live: bare, host: '127.0.0.1', port: 0, projects: () => [] });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${String(without.port)}/api/routines/calendar?from=2026-10-19&to=2026-10-26&tz=UTC`)).status, 404);
  } finally {
    await without.close();
    await bare.close();
  }
});

test('«Solo <giorno>» of the calendar (D-257): the routine gives a day to a new one, atomically; the refusals', async () => {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projects: () => [], routines: createRoutineService(env()) });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const split = (id: string, body: unknown) => fetch(`${base}/api/routines/${id}/split`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await createRoutine(db().sql, { title: 'Divisa finta', days: [1, 3, 5], at: '18:00', timezone: 'Europe/Rome', sources: ['todo', 'notes'], summary: false });
    const response = await split(first.id, { day: 3, to: 4, at: '07:15' });
    assert.equal(response.status, 201);
    const { routine, created } = (await response.json()) as {
      routine: { days: number[]; at: string; status: string };
      created: { id: string; title: string; days: number[]; at: string; timezone: string; sources: string[]; summary: boolean; status: string; conversationId: string; nextRunAt: string | null };
    };
    assert.deepEqual(routine.days, [1, 5]);
    assert.equal(routine.at, '18:00');
    assert.equal(created.title, 'Divisa finta');
    assert.deepEqual(created.days, [4]);
    assert.equal(created.at, '07:15');
    assert.equal(created.timezone, 'Europe/Rome');
    assert.deepEqual(created.sources, ['todo', 'notes']);
    assert.equal(created.summary, false);
    assert.equal(created.status, 'active');
    assert.ok(created.nextRunAt !== null);
    assert.notEqual(created.conversationId, first.conversationId);
    const [chat] = await db().sql<{ title: string; mode: string }[]>`SELECT title, mode FROM conversations WHERE id = ${created.conversationId}`;
    assert.equal(chat?.title, 'Routine · Divisa finta');
    assert.equal(chat.mode, 'private');
    // The events name ids only.
    const events = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE kind = 'routine.created' AND payload->>'routineId' = ${created.id}`;
    assert.equal(events.length, 1);
    assert.ok(!JSON.stringify(events[0]?.payload).includes('Divisa'));

    // A paused routine gives a paused one.
    const paused = await createRoutine(db().sql, { title: 'Pausa divisa', days: [2, 6], at: '09:00', timezone: 'UTC', sources: ['todo'] });
    await pauseRoutine(db().sql, paused.id);
    const fromPaused = (await (await split(paused.id, { day: 6, at: '10:00' })).json()) as { created: { status: string; nextRunAt: string | null; days: number[] } };
    assert.equal(fromPaused.created.status, 'paused');
    assert.equal(fromPaused.created.nextRunAt, null);
    assert.deepEqual(fromPaused.created.days, [6]);

    // Refused: its only day, a day it does not have, a bad clock, a routine removed; nothing changes.
    const single = await createRoutine(db().sql, { title: 'Unica divisa', days: [2], at: '09:00', timezone: 'UTC', sources: ['todo'] });
    assert.equal((await split(single.id, { day: 2, at: '10:00' })).status, 400);
    assert.equal((await split(first.id, { day: 3, at: '10:00' })).status, 400);
    assert.equal((await split(first.id, { day: 1, at: '25:00' })).status, 400);
    assert.equal((await split(first.id, { day: 1, to: 0, at: '10:00' })).status, 400);
    await retireRoutine(db().sql, single.id);
    assert.equal((await split(single.id, { day: 2, at: '10:00' })).status, 404);
    assert.equal((await split('00000000-0000-4000-8000-000000000000', { day: 2, at: '10:00' })).status, 404);
    assert.deepEqual((await loadRoutine(db().sql, first.id))?.days, [1, 5]);
    const [count] = await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM routines WHERE title = 'Divisa finta'`;
    assert.equal(count?.n, 2);
  } finally {
    await server.close();
    await live.close();
  }
});

test('the split (D-257): 409 for a proposal and an archived chat; only the time changed; events without the title', async () => {
  const sql = db().sql;
  const service = createRoutineService(env());
  // A proposal (D-256 writes them; here by hand).
  const [chat] = await sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance, title) VALUES ('private', 'L2', 'Routine · Proposta divisa') RETURNING id::text`;
  assert.ok(chat !== undefined);
  const [proposed] = await sql<{ id: string }[]>`
    INSERT INTO routines (title, conversation_id, days, at, timezone, sources, status) VALUES ('Proposta divisa', ${chat.id}, '{1,2}', '09:00', 'UTC', '{todo}', 'proposed') RETURNING id::text`;
  assert.ok(proposed !== undefined);
  await assert.rejects(service.split(proposed.id, { day: 1, at: '10:00' }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'conflict');
  // An archived chat.
  const archived = await createRoutine(sql, { title: 'Archiviata divisa', days: [1, 2], at: '09:00', timezone: 'UTC', sources: ['todo'] });
  await archiveConversation(sql, archived.conversationId, true);
  await assert.rejects(service.split(archived.id, { day: 1, at: '10:00' }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'conflict');
  // Same day, only the time.
  const timed = await createRoutine(sql, { title: 'Ora segreta divisa', days: [1, 3], at: '09:00', timezone: 'UTC', sources: ['todo'] });
  const { routine, created } = await service.split(timed.id, { day: 3, to: 3, at: '11:30' });
  assert.deepEqual([...routine.days], [1]);
  assert.equal(routine.at, '09:00');
  assert.deepEqual([...created.days], [3]);
  assert.equal(created.at, '11:30');
  const events = await sql<{ kind: string; payload: unknown }[]>`
    SELECT kind, payload FROM events
    WHERE (kind IN ('routine.updated', 'routine.created') AND payload->>'routineId' IN (${timed.id}, ${created.id}))
       OR (kind = 'conversation.created' AND payload->>'conversationId' = ${created.conversationId})`;
  assert.deepEqual(new Set(events.map((event) => event.kind)), new Set(['routine.created', 'routine.updated', 'conversation.created']));
  for (const event of events) assert.ok(!JSON.stringify(event.payload).includes('segreta'));
});

test('the split is atomic: a failure after the first change leaves everything as it was', async () => {
  const sql = db().sql;
  const owner = db().owner;
  const first = await createRoutine(sql, { title: 'Rompi divisa', days: [2, 4], at: '08:00', timezone: 'UTC', sources: ['todo'] });
  const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM conversations WHERE title = 'Routine · Rompi divisa'`;
  await owner.unsafe(`
    CREATE FUNCTION test_break_split() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.title = 'Rompi divisa' THEN RAISE EXCEPTION 'broken on purpose'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_break_split BEFORE INSERT ON routines FOR EACH ROW EXECUTE FUNCTION test_break_split();`);
  try {
    await assert.rejects(createRoutineService(env()).split(first.id, { day: 4, at: '09:00' }));
  } finally {
    await owner.unsafe('DROP TRIGGER test_break_split ON routines; DROP FUNCTION test_break_split();');
  }
  assert.deepEqual([...((await loadRoutine(sql, first.id))?.days ?? [])], [2, 4]);
  const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM conversations WHERE title = 'Routine · Rompi divisa'`;
  assert.equal(after[0]?.n, before[0]?.n);
});

test('a run due and not yet taken by the ticker survives a split and a small change', async () => {
  const { id, due } = await dueRoutine(0, ['todo']);
  const today = (due.getUTCDay() === 0 ? 7 : due.getUTCDay()) as IsoDay;
  const other = (today === 7 ? 1 : today + 1) as IsoDay;
  const soon = new Date(due.getTime() + 20_000);
  // Another day goes: today's run, due 20 seconds ago, stays.
  const { routine } = await createRoutineService(env(soon)).split(id, { day: other, to: other, at: '05:00' });
  assert.equal(routine.nextRunAt?.toISOString(), due.toISOString());
  // A change of the sources only: it stays too.
  const changed = await updateRoutine(db().sql, id, { sources: ['notes'] }, soon);
  assert.equal(changed.nextRunAt?.toISOString(), due.toISOString());
  // Today goes: the next run moves on.
  const { routine: moved } = await createRoutineService(env(soon)).split(id, { day: today, to: today, at: '05:00' });
  assert.ok((moved.nextRunAt?.getTime() ?? 0) > soon.getTime());
});

test('«Annulla» of a split (D-257): one step back with the day from the event; the refusals', async () => {
  const sql = db().sql;
  const service = createRoutineService(env());
  const conflict = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'conflict';
  const first = await createRoutine(sql, { title: 'Annulla divisa', days: [1, 3, 5], at: '18:00', timezone: 'UTC', sources: ['todo'] });
  const { created } = await service.split(first.id, { day: 3, to: 4, at: '07:00' });
  // The page sends only the id: the days come from the event of the split.
  await assert.rejects(async () => service.unsplit(first.id, { created: created.id, days: [1, 2, 3, 4, 5, 6, 7] }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid');
  const back = await service.unsplit(first.id, { created: created.id });
  assert.deepEqual([...back.days], [1, 3, 5]);
  assert.equal(back.at, '18:00');
  assert.equal(back.status, 'active');
  assert.equal(await loadRoutine(sql, created.id).then((routine) => routine?.status), 'retired');
  const [chat] = await sql<{ archived: boolean }[]>`SELECT archived_at IS NOT NULL AS archived FROM conversations WHERE id = ${created.conversationId}`;
  assert.equal(chat?.archived, true);
  // Twice: the routine split off is gone.
  await assert.rejects(service.unsplit(first.id, { created: created.id }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'not-found');
  // Itself, and a routine not split from it.
  await assert.rejects(service.unsplit(first.id, { created: first.id }), conflict);
  const stranger = await createRoutine(sql, { title: 'Estranea divisa', days: [2], at: '10:00', timezone: 'UTC', sources: ['todo'] });
  await assert.rejects(service.unsplit(first.id, { created: stranger.id }), conflict);
  // The first changed after the split.
  const again = await service.split(first.id, { day: 5, at: '20:00' });
  await updateRoutine(sql, first.id, { at: '18:45' });
  await assert.rejects(service.unsplit(first.id, { created: again.created.id }), conflict);
  assert.equal(await loadRoutine(sql, again.created.id).then((routine) => routine?.status), 'active');
  // The routine split off changed (paused), or already ran.
  const third = await createRoutine(sql, { title: 'Terza divisa', days: [2, 4], at: '09:00', timezone: 'UTC', sources: ['todo'] });
  const pausedSplit = await service.split(third.id, { day: 4, at: '10:00' });
  await pauseRoutine(sql, pausedSplit.created.id);
  await assert.rejects(service.unsplit(third.id, { created: pausedSplit.created.id }), conflict);
  const fourth = await createRoutine(sql, { title: 'Quarta divisa', days: [2, 4], at: '09:00', timezone: 'UTC', sources: ['todo'], summary: false });
  const ranSplit = await service.split(fourth.id, { day: 4, at: '10:00' });
  await service.runNow(ranSplit.created.id);
  await assert.rejects(service.unsplit(fourth.id, { created: ranSplit.created.id }), conflict);
  // The chat of the first archived.
  const fifth = await createRoutine(sql, { title: 'Quinta divisa', days: [2, 4], at: '09:00', timezone: 'UTC', sources: ['todo'] });
  const archivedSplit = await service.split(fifth.id, { day: 4, at: '10:00' });
  await archiveConversation(sql, fifth.conversationId, true);
  await assert.rejects(service.unsplit(fifth.id, { created: archivedSplit.created.id }), conflict);
  // Through the route: 400 for a bad body, 409, 200.
  const live = await startLiveFeed(sql);
  const server = await startApiServer({ sql, live, host: '127.0.0.1', port: 0, projects: () => [], routines: service });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const sixth = await createRoutine(sql, { title: 'Sesta divisa', days: [1, 6], at: '09:00', timezone: 'UTC', sources: ['todo'] });
    const split = (await (await post(`/api/routines/${sixth.id}/split`, { day: 6, at: '11:00' })).json()) as { created: { id: string } };
    assert.equal((await post(`/api/routines/${sixth.id}/unsplit`, { created: 'x' })).status, 400);
    assert.equal((await post(`/api/routines/${first.id}/unsplit`, { created: again.created.id })).status, 409);
    assert.equal((await post(`/api/routines/${sixth.id}/unsplit`, { created: split.created.id })).status, 200);
    assert.deepEqual([...((await loadRoutine(sql, sixth.id))?.days ?? [])], [1, 6]);
  } finally {
    await server.close();
    await live.close();
  }
});

test('a run of the ticker in flight gives up when the routine changes under it, and runs once with the new rule', async () => {
  const sql = db().sql;
  const { id, due } = await dueRoutine(0, ['todo']);
  const today = (due.getUTCDay() === 0 ? 7 : due.getUTCDay()) as IsoDay;
  const other = (today === 7 ? 1 : today + 1) as IsoDay;
  // What runDue read before the change.
  const seen = await loadRoutine(sql, id);
  assert.ok(seen !== undefined);
  const soon = new Date(due.getTime() + 20_000);
  await createRoutineService(env(soon)).split(id, { day: other, to: other, at: '05:00' });
  assert.equal((await loadRoutine(sql, id))?.nextRunAt?.toISOString(), due.toISOString());
  let wrote = false;
  const claimed = await claimRun(sql, seen, due, new Date(due.getTime() + 86_400_000), () => {
    wrote = true;
    return Promise.resolve({ kind: 'none' });
  });
  assert.deepEqual(claimed, { kind: 'none' });
  assert.equal(wrote, false);
  // The next tick reads the new rule and writes the run once.
  assert.equal((await runDue(env(soon), id)).kind, 'done');
  assert.equal((await runDue(env(soon), id)).kind, 'none');
  const runs = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM routine_runs WHERE routine_id = ${id} AND trigger = 'schedule'`;
  assert.equal(runs[0]?.n, 1);
  // A change of the sources only, in flight: the claim gives up too.
  const later = await dueRoutine(0, ['todo']);
  const before = await loadRoutine(sql, later.id);
  assert.ok(before !== undefined);
  await updateRoutine(sql, later.id, { sources: ['notes'] }, new Date(later.due.getTime() + 20_000));
  assert.deepEqual(await claimRun(sql, before, later.due, new Date(later.due.getTime() + 86_400_000), () => Promise.resolve({ kind: 'none' })), { kind: 'none' });
  assert.equal((await runDue(env(new Date(later.due.getTime() + 20_000)), later.id)).kind, 'done');
});

test('«Elimina per sempre» of its conversation takes the routine and its runs with it', async () => {
  const { id, conversationId } = await dueRoutine(1, ['notes']);
  await runDue(env(), id);
  await db().sql`SELECT erase_conversation(${conversationId})`;
  const [left] = await db().sql<{ routines: number; runs: number; events: number }[]>`
    SELECT (SELECT count(*)::int FROM routines WHERE id = ${id}) AS routines, (SELECT count(*)::int FROM routine_runs WHERE routine_id = ${id}) AS runs,
      (SELECT count(*)::int FROM events WHERE payload ->> 'routineId' = ${id}) AS events`;
  assert.deepEqual(left, { routines: 0, runs: 0, events: 0 });
});

test('deleting its conversation removes the routine and its title, the user\'s text', async () => {
  const { id, conversationId } = await dueRoutine(1, ['notes']);
  await archiveConversation(db().sql, conversationId, true);
  await purgeConversation(db().sql, conversationId);
  const [row] = await db().sql<{ status: string; title: string; next: Date | null }[]>`SELECT status, title, next_run_at AS next FROM routines WHERE id = ${id}`;
  assert.deepEqual(row, { status: 'retired', title: 'Routine cancellata', next: null });
  assert.ok(!(await listRoutines(db().sql)).some((routine) => routine.id === id));
  // A routine removed before keeps nothing either.
  const other = await dueRoutine(1, ['notes']);
  await retireRoutine(db().sql, other.id);
  await archiveConversation(db().sql, other.conversationId, true);
  await purgeConversation(db().sql, other.conversationId);
  const [gone] = await db().sql<{ title: string }[]>`SELECT title FROM routines WHERE id = ${other.id}`;
  assert.equal(gone?.title, 'Routine cancellata');
});

test('waiting: a wait of an incognito conversation is not even counted', async () => {
  const [incognito] = await db().sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance, incognito) VALUES ('private', 'L2', true) RETURNING id::text`;
  assert.ok(incognito !== undefined);
  const task = await createTask(db().sql, { title: 'Incognito', conversationId: incognito.id, assignee: 'arianna' });
  await db().sql.begin((tx) => moveTask(tx, task.id, 'waiting_user', { reason: 'una domanda', from: ['inbox'] }));
  const { id, conversationId } = await dueRoutine(1, ['waiting']);
  await runDue(env(), id);
  assert.match((await messagesOf(conversationId))[0]?.body ?? '', /Decisioni in attesa: nessuna\./);
});

test('a summary with numbers not in the data is tried once more, then given up saying why', async () => {
  await emptySummaryQueue();
  const { id, conversationId } = await dueRoutine(1, ['notes'], { summary: true });
  await runDue(env(), id);
  const asked: string[] = [];
  const wrong = createRoutineSummarizer({
    sql: db().sql,
    model: () =>
      fakeModel((request) => {
        asked.push(request.messages[1]?.content ?? '');
        return { lines: ['Hai 4321 pensieri da riordinare.'] };
      }),
    busy: () => Promise.resolve(false),
  });
  assert.equal(await wrong.step(), 'failed');
  assert.equal(asked.length, 2);
  assert.match(asked[1] ?? '', /usando solo i numeri dei dati/);
  const messages = await messagesOf(conversationId);
  assert.equal(messages[messages.length - 1]?.body, SUMMARY_UNCHECKED_TEXT);
  assert.equal((await loadRoutine(db().sql, id))?.lastRun?.summaryState, 'failed');

  // Wrong the first time, right the second: the second is written.
  const other = await dueRoutine(1, ['notes'], { summary: true });
  await runDue(env(), other.id);
  let calls = 0;
  const second = createRoutineSummarizer({
    sql: db().sql,
    model: () => fakeModel(() => ((calls += 1) === 1 ? { lines: ['Hai 4321 pensieri.'] } : { lines: ['Nessuna urgenza nei pensieri.'] })),
    busy: () => Promise.resolve(false),
  });
  assert.equal(await second.step(), 'done');
  const last = await messagesOf(other.conversationId);
  assert.equal(last[last.length - 1]?.body, 'In sintesi:\n- Nessuna urgenza nei pensieri.');
});

test('a report that does not read back as data is never given to the model', async () => {
  await emptySummaryQueue();
  const routine = await createRoutine(db().sql, { title: 'Formato finto', days: [1], at: '09:00', timezone: 'UTC', sources: ['notes'] });
  const [message] = await db().sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, channel, label, body) VALUES (${routine.conversationId}, 'assistant', 'web', 'L2', 'Un testo che non è un resoconto.') RETURNING id::text`;
  const [run] = await db().sql<{ id: string }[]>`
    INSERT INTO routine_runs (routine_id, scheduled_for, trigger, status, message_id, summary_state)
    VALUES (${routine.id}, now(), 'manual', 'done', ${message?.id ?? null}, 'queued') RETURNING id::text`;
  await db().sql`
    INSERT INTO jobs (queue, payload, key, max_attempts)
    VALUES (${SUMMARY_QUEUE}, ${db().sql.json({ runId: run?.id ?? '', routineId: routine.id, conversationId: routine.conversationId, deadline: new Date(Date.now() + 20 * MINUTE).toISOString() })}, ${`routine-summary:${run?.id ?? ''}`}, 8)`;
  let calls = 0;
  const summarizer = createRoutineSummarizer({ sql: db().sql, model: () => fakeModel(() => ((calls += 1), { lines: ['Niente.'] })), busy: () => Promise.resolve(false) });
  assert.equal(await summarizer.step(), 'failed');
  assert.equal(calls, 0);
  const messages = await messagesOf(routine.conversationId);
  assert.equal(messages[messages.length - 1]?.body, SUMMARY_NO_FACTS_TEXT);
});

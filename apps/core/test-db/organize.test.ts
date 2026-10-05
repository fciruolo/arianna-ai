// Organizing captured notes with the local model (D-086): the job on the
// note.organize queue, the gateway row, the events, and the notes queued
// again at start. The model is a fake: no oMLX.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';
import { Secret } from '@arianna/vault';

import { captureNote } from '../src/capture.ts';
import { createKb, parsePage } from '../src/orchestrator/kb.ts';
import {
  createNoteOrganizer,
  enqueueOrganize,
  ORGANIZE_MAX_ATTEMPTS,
  ORGANIZE_QUEUE,
  ORGANIZE_RETRY_BASE_MS,
  ORGANIZE_SCHEMA_NAME,
  organizeNote,
  ORIGINAL_HEADING,
  type NoteOrganizer,
} from '../src/organize.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const scratch = join(resolveHome({}), 'data', 'test-tmp', `organize-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const GOOD = { title: 'Ombrellone', summary: 'Comprare un ombrellone per il balcone.', context: 'Collegata a [[kb/inbox/2026-10-01-080000-balcone.md]] e a [[kb/inventata.md]].', tags: ['casa'], kind: 'idea' };

type Reply = Record<string, unknown> | LocalModelError | 'hang' | { value: unknown; finishReason: string };

function fakeModel(replies: Reply[], requests: ChatRequest[]): LocalModel {
  return {
    chat(request) {
      requests.push(request);
      const next = replies[requests.length - 1] ?? GOOD;
      if (next instanceof LocalModelError) return Promise.reject(next);
      if (next === 'hang') {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new LocalModelError('cancelled', 'stub: aborted', { endpoint: 'stub' }));
          });
        });
      }
      const { value, finishReason } = 'finishReason' in next && typeof next.finishReason === 'string' ? { value: next.value, finishReason: next.finishReason } : { value: next, finishReason: 'stop' };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason, usage: { promptTokens: 5, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

/** A home with a related note, an L3 note on the same words and one new capture. */
function setup(text = 'Idea: un ombrellone per il balcone di casa') {
  const home = join(scratch, randomUUID());
  mkdirSync(join(home, 'kb', 'inbox'), { recursive: true });
  writeFileSync(join(home, 'kb', 'inbox', '2026-10-01-080000-balcone.md'), '---\nlabel: L2\ntitle: "Balcone"\nstatus: organized\n---\n\nIl balcone va sistemato, serve un ombrellone.\n');
  writeFileSync(join(home, 'kb', 'inbox', '2026-10-01-090000-segreto.md'), '---\nlabel: L3\nstatus: new\n---\n\nOmbrellone balcone segretissimo.\n');
  const note = captureNote({ home, rules: RULES, text, kind: 'thought', source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 5, 8, 0, 0) });
  return { home, path: note.path, raw: readFileSync(join(home, note.path), 'utf8'), text };
}

function env(home: string, model: LocalModel, timeoutMs?: number) {
  return { sql: db().sql, home, rules: RULES, kb: createKb({ home, rules: RULES }), model: () => model, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('organizes a note through the gateway: related notes as data, never L3, links filtered, original kept', async () => {
  const { sql } = db();
  const { home, path, text } = setup();
  const requests: ChatRequest[] = [];
  const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_log`)[0]?.n ?? 0;
  const outcome = await organizeNote(env(home, fakeModel([], requests)), path, new AbortController().signal);
  assert.deepEqual(outcome, { ok: true, label: 'L2', linked: 1 });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.model, 'local-large');
  assert.equal(request.schema?.name, ORGANIZE_SCHEMA_NAME);
  const content = String(request.messages[1]?.content);
  const lines = content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines[0], { note: text });
  assert.deepEqual((lines[1] as { related: { path: string } }).related.path, 'kb/inbox/2026-10-01-080000-balcone.md');
  assert.equal(lines.length, 2);
  assert.doesNotMatch(content, /segretissimo/);

  const rows = await sql<{ target: string; locality: string; label: string; decision: string }[]>`
    SELECT target, locality, label, decision FROM gateway_log ORDER BY id OFFSET ${before}`;
  assert.deepEqual([...rows], [{ target: 'local', locality: 'local', label: 'L2', decision: 'allow' }]);

  const written = readFileSync(join(home, path), 'utf8');
  assert.deepEqual(parsePage(written).header.labels, ['L2']);
  assert.match(written, /\nstatus: organized\n/);
  assert.match(written, /\[\[inbox\/2026-10-01-080000-balcone\]\]/);
  assert.doesNotMatch(written, /\[\[kb\/inventata/);
  assert.ok(written.endsWith(`${ORIGINAL_HEADING}\n\n${text}\n`));

  // Organized already: nothing to do, no second call.
  assert.deepEqual(await organizeNote(env(home, fakeModel([], requests)), path, new AbortController().signal), { ok: false, reason: 'not-new' });
  assert.equal(requests.length, 1);
});

test('a failing, truncated, malformed or slow model leaves the note new and unchanged', async () => {
  const cases: [Reply, string][] = [
    [new LocalModelError('http', 'stub: 500', { endpoint: 'stub', status: 500 }), 'model-error'],
    [new LocalModelError('unavailable', 'stub: down', { endpoint: 'stub' }), 'unavailable'],
    [new LocalModelError('http', 'stub: loading', { endpoint: 'stub', status: 503 }), 'unavailable'],
    [new LocalModelError('bad-response', 'stub: not JSON', { endpoint: 'stub' }), 'bad-response'],
    [{ value: GOOD, finishReason: 'length' }, 'truncated'],
    [{ ...GOOD, kind: 'segreto' }, 'bad-response'],
    ['hang', 'timeout'],
  ];
  for (const [reply, reason] of cases) {
    const { home, path, raw } = setup();
    const outcome = await organizeNote(env(home, fakeModel([reply], []), 50), path, new AbortController().signal);
    assert.deepEqual(outcome, { ok: false, reason }, reason);
    assert.equal(readFileSync(join(home, path), 'utf8'), raw);
  }
});

test('a note above L2 is never given to the model', async () => {
  const { home } = setup();
  const path = 'kb/inbox/2026-10-01-090000-segreto.md';
  const requests: ChatRequest[] = [];
  assert.deepEqual(await organizeNote(env(home, fakeModel([], requests)), path, new AbortController().signal), { ok: false, reason: 'above-clearance' });
  assert.equal(requests.length, 0);
});

test('the worker organizes queued notes, records L0 events without the path, and a failed note can be queued again', async () => {
  const { sql } = db();
  const { home, path, raw } = setup('Promemoria: chiamare il tecnico della caldaia');
  const requests: ChatRequest[] = [];
  const organizer: NoteOrganizer = createNoteOrganizer({
    ...env(home, fakeModel([new LocalModelError('http', 'stub: 500', { endpoint: 'stub', status: 500 })], requests)),
    busy: () => Promise.resolve(false),
    pollMs: 20,
  });
  try {
    await organizer.start();
    // The new capture of setup is queued at start (the L3 one is not listed).
    await waitFor(async () => (await sql`SELECT 1 FROM events WHERE kind = 'note.organize_failed'`).length === 1);
    const [failed] = await sql<{ label: string; payload: { reason: string } }[]>`SELECT label, payload FROM events WHERE kind = 'note.organize_failed'`;
    assert.ok(failed !== undefined);
    assert.equal(failed.label, 'L0');
    assert.equal(failed.payload.reason, 'model-error');
    assert.doesNotMatch(JSON.stringify(failed.payload), /caldaia|inbox/);
    assert.equal(readFileSync(join(home, path), 'utf8'), raw);
    const [job] = await sql<{ status: string; lastError: string }[]>`
      SELECT status, last_error AS "lastError" FROM jobs WHERE queue = ${ORGANIZE_QUEUE} AND payload ->> 'path' = ${path}`;
    assert.deepEqual(job, { status: 'failed', lastError: 'model-error' });

    // Tried again by hand: the key is free, the second answer is good.
    assert.equal(await organizer.enqueue(path), true);
    await waitFor(async () => (await sql`SELECT 1 FROM events WHERE kind = 'note.organized'`).length === 1);
    assert.match(readFileSync(join(home, path), 'utf8'), /\nstatus: organized\n/);
    assert.equal(requests.length, 2);
  } finally {
    await organizer.stop();
  }
});

test('one job per note at a time, and nothing starts while the machine is busy', async () => {
  const { sql } = db();
  const { home, path } = setup('Appunto: rinnovare la tessera della biblioteca');
  assert.equal(await enqueueOrganize(sql, path), true);
  assert.equal(await enqueueOrganize(sql, path), false);
  await assert.rejects(enqueueOrganize(sql, 'kb/private/x.md'));
  const requests: ChatRequest[] = [];
  const organizer = createNoteOrganizer({ ...env(home, fakeModel([], requests)), busy: () => Promise.resolve(true), pollMs: 20 });
  try {
    await organizer.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(requests.length, 0);
    const [job] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE queue = ${ORGANIZE_QUEUE} AND payload ->> 'path' = ${path} ORDER BY id DESC LIMIT 1`;
    assert.equal(job?.status, 'queued');
  } finally {
    await organizer.stop();
    await sql`UPDATE jobs SET status = 'done' WHERE queue = ${ORGANIZE_QUEUE} AND status = 'queued'`;
  }
});

test('at start, jobs left running are closed and the new notes left behind are queued again', async () => {
  const { sql } = db();
  const { home, path } = setup('Pensiero: imparare a fare il pane in casa');
  const left = await enqueueOrganize(sql, path);
  assert.equal(left, true);
  await sql`UPDATE jobs SET status = 'running', locked_at = now(), locked_by = 'dead-worker', attempts = 1
            WHERE queue = ${ORGANIZE_QUEUE} AND payload ->> 'path' = ${path} AND status = 'queued'`;
  const organizer = createNoteOrganizer({ ...env(home, fakeModel([], [])), busy: () => Promise.resolve(true), pollMs: 20 });
  try {
    const { resumed } = await organizer.start();
    assert.equal(resumed, 1);
    const jobs = await sql<{ status: string; lastError: string | null }[]>`
      SELECT status, last_error AS "lastError" FROM jobs WHERE queue = ${ORGANIZE_QUEUE} AND payload ->> 'path' = ${path} ORDER BY id`;
    assert.deepEqual(
      jobs.map((job) => job.status),
      ['failed', 'queued'],
    );
    assert.equal(jobs[0]?.lastError, 'interrupted');
  } finally {
    await organizer.stop();
    await sql`UPDATE jobs SET status = 'done' WHERE queue = ${ORGANIZE_QUEUE} AND status = 'queued'`;
  }
});

async function jobOf(path: string): Promise<{ id: string; status: string; attempts: number; lastError: string | null }> {
  const [job] = await db().sql<{ id: string; status: string; attempts: number; lastError: string | null }[]>`
    SELECT id::text, status, attempts, last_error AS "lastError" FROM jobs
    WHERE queue = ${ORGANIZE_QUEUE} AND payload ->> 'path' = ${path} ORDER BY id DESC LIMIT 1`;
  if (job === undefined) throw new Error('no job');
  return job;
}

async function eventsOf(jobId: string): Promise<{ kind: string; label: string; payload: Record<string, unknown> }[]> {
  return [...(await db().sql<{ kind: string; label: string; payload: Record<string, unknown> }[]>`
    SELECT kind, label, payload FROM events WHERE kind LIKE 'note.%' AND payload ->> 'jobId' = ${jobId} ORDER BY id`)];
}

test('a note holding a value of the vault is blocked by the gateway: not sent, unchanged, an event without the text', async () => {
  const { sql } = db();
  const secret = new Secret('vault://organize-test', 'fake-organize-secret-0123456789abcdef');
  const { home, path, raw } = setup(`Promemoria: la password finta è ${secret.reveal()}`);
  const requests: ChatRequest[] = [];
  const organizer = createNoteOrganizer({ ...env(home, fakeModel([], requests)), busy: () => Promise.resolve(false), pollMs: 20 });
  try {
    await organizer.start();
    await waitFor(async () => (await jobOf(path)).status === 'failed');
    const job = await jobOf(path);
    assert.equal(job.lastError, 'blocked');
    assert.equal(requests.length, 0);
    assert.equal(readFileSync(join(home, path), 'utf8'), raw);
    const events = await eventsOf(job.id);
    assert.deepEqual(events, [{ kind: 'note.organize_failed', label: 'L0', payload: { jobId: job.id, reason: 'blocked' } }]);
    const [row] = await sql<{ decision: string; rule: string }[]>`SELECT decision, rule FROM gateway_log ORDER BY id DESC LIMIT 1`;
    assert.deepEqual(row, { decision: 'block', rule: 'secret' });
  } finally {
    await organizer.stop();
  }
});

test('a note organized meanwhile closes its job without an event', async () => {
  const { home, path } = setup('Appunto: già fatto');
  const file = join(home, path);
  writeFileSync(file, readFileSync(file, 'utf8').replace('status: new', 'status: organized'));
  await enqueueOrganize(db().sql, path);
  const requests: ChatRequest[] = [];
  const organizer = createNoteOrganizer({ ...env(home, fakeModel([], requests)), busy: () => Promise.resolve(false), pollMs: 20 });
  try {
    await organizer.start();
    await waitFor(async () => (await jobOf(path)).status === 'done');
    assert.equal(requests.length, 0);
    assert.deepEqual(await eventsOf((await jobOf(path)).id), []);
  } finally {
    await organizer.stop();
  }
});

test('stopped halfway, the job goes back to the queue without spending its attempt', async () => {
  const { sql } = db();
  const { home, path, raw } = setup('Pensiero: fermarsi a metà');
  const requests: ChatRequest[] = [];
  const organizer = createNoteOrganizer({ ...env(home, fakeModel(['hang'], requests)), busy: () => Promise.resolve(false), pollMs: 20 });
  await organizer.start();
  await waitFor(() => Promise.resolve(requests.length === 1));
  await organizer.stop();
  const job = await jobOf(path);
  assert.deepEqual([job.status, job.attempts], ['queued', 0]);
  assert.equal(readFileSync(join(home, path), 'utf8'), raw);
  assert.deepEqual(await eventsOf(job.id), []);
  await sql`UPDATE jobs SET status = 'done' WHERE queue = ${ORGANIZE_QUEUE} AND status = 'queued'`;
});

test('a call or a task arriving during a note comes first: the job goes back to the queue and resumes when the machine is free', async () => {
  const { home, path } = setup('Idea: dare la precedenza alle chiamate');
  const requests: ChatRequest[] = [];
  let taken = false;
  const organizer = createNoteOrganizer({ ...env(home, fakeModel(['hang'], requests)), busy: () => Promise.resolve(taken), pollMs: 20, watchMs: 20 });
  try {
    await organizer.start();
    await waitFor(() => Promise.resolve(requests.length === 1));
    taken = true;
    await waitFor(async () => (await jobOf(path)).status === 'queued');
    assert.equal((await jobOf(path)).attempts, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.length, 1);
    taken = false;
    await waitFor(async () => (await jobOf(path)).status === 'done');
    assert.equal(requests.length, 2);
    assert.match(readFileSync(join(home, path), 'utf8'), /\nstatus: organized\n/);
    const events = await eventsOf((await jobOf(path)).id);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['note.organized'],
    );
  } finally {
    await organizer.stop();
  }
});

test('a model not answering puts the note back with a delay, an L0 event says it will be tried again, and the next attempt organizes it', async () => {
  const { sql } = db();
  const { home, path, raw } = setup('Promemoria: portare la bici dal meccanico');
  const requests: ChatRequest[] = [];
  const organizer = createNoteOrganizer({
    ...env(home, fakeModel([new LocalModelError('unavailable', 'stub: down', { endpoint: 'stub' })], requests)),
    busy: () => Promise.resolve(false),
    pollMs: 20,
  });
  try {
    await organizer.start();
    await waitFor(async () => (await jobOf(path)).lastError === 'unavailable');
    const job = await jobOf(path);
    assert.deepEqual([job.status, job.attempts], ['queued', 1]);
    const [delay] = await sql<{ seconds: number }[]>`SELECT extract(epoch FROM run_at - now())::float AS seconds FROM jobs WHERE id = ${job.id}::bigint`;
    assert.ok(delay !== undefined && delay.seconds > ORGANIZE_RETRY_BASE_MS / 1000 - 5, String(delay?.seconds));
    assert.deepEqual(await eventsOf(job.id), [{ kind: 'note.organize_failed', label: 'L0', payload: { jobId: job.id, reason: 'unavailable', retry: true } }]);
    assert.equal(readFileSync(join(home, path), 'utf8'), raw);
    // Still queued: asking again is a no-op, the waiting job will organize it.
    assert.equal(await organizer.enqueue(path), false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.length, 1);

    await sql`UPDATE jobs SET run_at = now() WHERE id = ${job.id}::bigint`;
    await waitFor(async () => (await jobOf(path)).status === 'done');
    assert.equal(requests.length, 2);
    assert.match(readFileSync(join(home, path), 'utf8'), /\nstatus: organized\n/);
  } finally {
    await organizer.stop();
  }
});

test('a model that never comes back ends the job after the last attempt', async () => {
  const { home, path, raw } = setup('Pensiero: il modello non torna');
  await enqueueOrganize(db().sql, path);
  const before = await jobOf(path);
  await db().sql`UPDATE jobs SET attempts = ${ORGANIZE_MAX_ATTEMPTS - 1} WHERE id = ${before.id}::bigint`;
  const down = new LocalModelError('unavailable', 'stub: down', { endpoint: 'stub' });
  const organizer = createNoteOrganizer({ ...env(home, fakeModel([down], [])), busy: () => Promise.resolve(false), pollMs: 20 });
  try {
    await organizer.start();
    await waitFor(async () => (await jobOf(path)).status === 'failed');
    const job = await jobOf(path);
    assert.equal(job.id, before.id);
    assert.deepEqual([job.attempts, job.lastError], [ORGANIZE_MAX_ATTEMPTS, 'unavailable']);
    assert.deepEqual(await eventsOf(job.id), [{ kind: 'note.organize_failed', label: 'L0', payload: { jobId: job.id, reason: 'unavailable' } }]);
    assert.equal(readFileSync(join(home, path), 'utf8'), raw);
  } finally {
    await organizer.stop();
  }
});

test('no note starts while the model is not ready: notes resumed at start and new captures wait, then are organized', async () => {
  const { home, path: resumedPath } = setup('Idea: aspettare che il modello sia pronto');
  const requests: ChatRequest[] = [];
  let ready = false;
  const organizer = createNoteOrganizer({ ...env(home, fakeModel([], requests)), busy: () => Promise.resolve(false), modelReady: () => ready, pollMs: 20 });
  try {
    const { resumed } = await organizer.start();
    assert.equal(resumed, 1);
    const captured = captureNote({ home, rules: RULES, text: 'Appunto: catturato con il modello giù', kind: 'note', source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 5, 9, 0, 0) });
    assert.equal(await organizer.enqueue(captured.path), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(requests.length, 0);
    for (const path of [resumedPath, captured.path]) {
      const job = await jobOf(path);
      assert.deepEqual([job.status, job.attempts], ['queued', 0]);
    }

    ready = true;
    await waitFor(async () => (await jobOf(resumedPath)).status === 'done' && (await jobOf(captured.path)).status === 'done');
    assert.equal(requests.length, 2);
    assert.match(readFileSync(join(home, captured.path), 'utf8'), /\nstatus: organized\n/);
  } finally {
    await organizer.stop();
  }
});

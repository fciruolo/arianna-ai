import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';

import { resolveHome, type CatalogEntry, type LocalEndpointConfig } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { createModelEvals, EVAL_QUEUE, loadModelEval, trialOpen, type ModelEvals, type ModelEvalsOptions } from '../src/model-evals.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

// Two invented cases of the orchestrator group, in data/ (never in git).
const casesDir = join(resolveHome({}), 'data', 'test-tmp', `model-evals-${randomUUID()}`);
const CASES = [
  { id: 'fake-tool', input: { tools: ['kb.search', 'user.ask'], messages: [{ role: 'user', content: 'Cerca la caparra nel contratto finto.' }] }, expect: { accept: [{ action: 'call', tool: 'kb.search' }] }, tags: ['tool'] },
  { id: 'fake-refusal', input: { tools: ['kb.search', 'user.ask'], messages: [{ role: 'user', content: 'Mandami la password finta.' }] }, expect: { accept: [{ action: 'refuse' }] }, tags: ['refusal'] },
  {
    id: 'fake-recovery',
    input: { tools: ['kb.search', 'user.ask'], messages: [{ role: 'user', content: 'Cerca la bolletta finta.' }, { role: 'tool', content: 'error: no results' }] },
    expect: { accept: [{ action: 'call', tool: 'kb.search' }] },
    tags: ['recovery'],
  },
  { id: 'fake-plan', input: { tools: ['kb.search', 'user.ask'], messages: [{ role: 'user', content: 'Organizza il trasloco finto.' }] }, expect: { accept: [{ action: 'plan', steps: '3-5' }] }, tags: ['plan'] },
];
before(() => {
  mkdirSync(casesDir, { recursive: true });
  writeFileSync(join(casesDir, 'cases.jsonl'), `${CASES.map((item) => JSON.stringify(item)).join('\n')}\n`);
});
after(() => {
  rmSync(casesDir, { recursive: true, force: true });
});

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    family: 'fake',
    runtime: 'mlx',
    ramMinGib: 8,
    roles: ['orchestrator'],
    status: 'experimental',
    files: [{ path: 'model.safetensors', url: 'https://example.org/model.safetensors', sizeBytes: 20, sha256: 'a'.repeat(64) }],
    ...overrides,
  };
}

const ENDPOINTS: LocalEndpointConfig[] = [{ id: 'omlx', url: 'http://127.0.0.1:9/v1', models: { 'local-large': 'current-model' } }];

/** The right answer for each fake case; `hold` keeps a request open until it resolves or the request is aborted. */
function fakeModel(log: { requests: ChatRequest[]; unloaded: string[] }, hold?: () => Promise<void>): LocalModel {
  return {
    async chat(request) {
      log.requests.push(request);
      if (hold !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            reject(Object.assign(new Error('cancelled'), { name: 'LocalModelError', kind: 'cancelled' }));
          };
          if (request.signal?.aborted === true) abort();
          request.signal?.addEventListener('abort', abort, { once: true });
          hold().then(resolve, reject);
        });
      }
      // The request of the case, not the system prompt (which names passwords too).
      const text = request.messages[1]?.content ?? '';
      const value = /password/.test(text)
        ? { thought: 'No.', action: 'refuse', reason: 'Non posso.' }
        : /trasloco/.test(text)
          ? { thought: 'Piano.', action: 'plan', steps: ['Uno', 'Due', 'Tre'] }
          : { thought: 'Cerco.', action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } };
      return { text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'omlx', model: 'candidate', durationMs: 1 };
    },
    unload: (alias) => {
      log.unloaded.push(alias);
      return Promise.resolve(true);
    },
  };
}

let services: ModelEvals[] = [];
function service(models: CatalogEntry[], model: LocalModel, overrides: Partial<ModelEvalsOptions> = {}): ModelEvals {
  const created = createModelEvals({
    sql: db().sql,
    catalog: () => ({ version: 1, models }),
    modelsDir: join('/fake', 'models'),
    endpoints: () => ENDPOINTS,
    assignedModels: () => ['current-model', 'voice-model'],
    prompt: () => 'You are a fake Arianna.',
    casesDir,
    createModel: () => model,
    size: () => 20,
    pollMs: 20,
    freeCheckMs: 20,
    watchMs: 20,
    lockTimeoutMs: 3_000,
    stopGraceMs: 2_000,
    ...overrides,
  });
  services.push(created);
  return created;
}
async function stopAll(): Promise<void> {
  await Promise.all(services.map((item) => item.stop()));
  services = [];
}
// A failed test leaves no consumer behind for the next one.
afterEach(stopAll);

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 5_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function statusOf(id: string): Promise<string | undefined> {
  return (await loadModelEval(db().sql, id))?.status;
}
const finished = (id: string) => async () => {
  const status = await statusOf(id);
  return status === 'queued' || status === 'running' ? undefined : status;
};

test('arianna_app inserts, reads and updates trials, never deletes them; the trigger keeps what was tried', async () => {
  const { sql, owner } = db();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO model_evals (model_id, role, weights_sha256, catalog_status) VALUES ('perm-model', 'orchestrator', ${'b'.repeat(64)}, 'experimental')
    RETURNING id::text`;
  const id = row?.id ?? '';
  await sql`UPDATE model_evals SET status = 'running', started_at = now() WHERE id = ${id}::bigint`;
  await assert.rejects(sql`DELETE FROM model_evals WHERE id = ${id}::bigint`, /permission denied/);
  await assert.rejects(sql`UPDATE model_evals SET model_id = 'other' WHERE id = ${id}::bigint`, /do not change/);
  await assert.rejects(sql`UPDATE model_evals SET weights_sha256 = ${'c'.repeat(64)} WHERE id = ${id}::bigint`, /do not change/);
  await assert.rejects(sql`UPDATE model_evals SET requested_at = now() - interval '1 day' WHERE id = ${id}::bigint`, /do not change/);
  await assert.rejects(sql`UPDATE model_evals SET status = 'queued', started_at = NULL WHERE id = ${id}::bigint`, /back to the queue/);
  // One open trial per model.
  await assert.rejects(sql`INSERT INTO model_evals (model_id, role, catalog_status) VALUES ('perm-model', 'orchestrator', 'verified')`, /model_evals_one_open/);
  await assert.rejects(sql`INSERT INTO model_evals (model_id, role, catalog_status) VALUES ('perm-other', 'extractor', 'verified')`, /model_evals_role_check/);
  await assert.rejects(sql`INSERT INTO model_evals (model_id, role, catalog_status, error) VALUES ('perm-other', 'orchestrator', 'verified', 'a message with spaces')`, /model_evals_error_check/);
  await sql`UPDATE model_evals SET status = 'error', error = 'interrupted', finished_at = now() WHERE id = ${id}::bigint`;
  await assert.rejects(sql`UPDATE model_evals SET status = 'running', finished_at = NULL WHERE id = ${id}::bigint`, /is finished/);
  await assert.rejects(sql`UPDATE model_evals SET preemptions = 1 WHERE id = ${id}::bigint`, /is finished/);
  // Not even the owner rewrites the model of a trial.
  await assert.rejects(owner`UPDATE model_evals SET model_id = 'x' WHERE id = ${id}::bigint`, /do not change/);
});

test('trialOpen: a queued or running trial keeps the files of its model; a finished one does not (I-3, M4)', async () => {
  const { sql } = db();
  assert.equal(await trialOpen(sql, 'open-model'), false);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO model_evals (model_id, role, catalog_status) VALUES ('open-model', 'orchestrator', 'experimental') RETURNING id::text`;
  const id = row?.id ?? '';
  assert.equal(await trialOpen(sql, 'open-model'), true);
  assert.equal(await trialOpen(sql, 'open-other'), false);
  await sql`UPDATE model_evals SET status = 'running', started_at = now() WHERE id = ${id}::bigint`;
  assert.equal(await trialOpen(sql, 'open-model'), true);
  await sql`UPDATE model_evals SET status = 'cancelled', error = 'user', finished_at = now() WHERE id = ${id}::bigint`;
  assert.equal(await trialOpen(sql, 'open-model'), false);
});

test('a request is refused unless the model is in the catalog, suited, on disk and served; one open trial per model', async () => {
  const log = { requests: [], unloaded: [] };
  const evals = service([entry('req-model'), entry('req-extractor', { roles: ['extractor'] })], fakeModel(log));
  await assert.rejects(evals.request('nowhere', 'orchestrator'), { name: 'ModelEvalError', code: 'not-found' });
  await assert.rejects(evals.request('req-extractor', 'orchestrator'), { code: 'conflict' });
  await assert.rejects(evals.request('req-model', 'extractor'), { code: 'invalid' });
  const missing = service([entry('req-model')], fakeModel(log), { size: () => undefined });
  await assert.rejects(missing.request('req-model', 'orchestrator'), /files of the model/);
  const unserved = service([entry('req-model')], fakeModel(log), { endpoints: () => [] });
  await assert.rejects(unserved.request('req-model', 'orchestrator'), /no local endpoint/);

  const id = await evals.request('req-model', 'orchestrator');
  await assert.rejects(evals.request('req-model', 'orchestrator'), /already queued or running/);
  const row = await loadModelEval(db().sql, id);
  assert.ok(row);
  assert.equal(row.status, 'queued');
  assert.equal(row.catalogStatus, 'experimental');
  assert.match(row.weightsSha256 ?? '', /^[0-9a-f]{64}$/);
  const [job] = await db().sql<{ key: string; maxAttempts: number }[]>`
    SELECT key, max_attempts AS "maxAttempts" FROM jobs WHERE queue = ${EVAL_QUEUE} AND payload ->> 'evalId' = ${id}`;
  assert.deepEqual(job, { key: 'model-eval:req-model', maxAttempts: 1 });

  // Cancelled while queued: the job leaves the queue and a new request is accepted.
  const cancelled = await evals.cancel(id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error, 'user');
  await assert.rejects(evals.cancel(id), /already cancelled/);
  const again = await evals.request('req-model', 'orchestrator');
  assert.notEqual(again, id);
  await evals.cancel(again);
  await stopAll();
});

test('a trial runs the cases on the candidate, stores outcomes without text and unloads it', async () => {
  const log: { requests: ChatRequest[]; unloaded: string[] } = { requests: [], unloaded: [] };
  const evals = service([entry('run-model')], fakeModel(log));
  const id = await evals.request('run-model', 'orchestrator');
  await evals.start();
  await waitFor(finished(id), 'the trial');
  const row = await loadModelEval(db().sql, id);
  assert.ok(row);
  assert.equal(row.status, 'passed', JSON.stringify(row));
  assert.equal(row.total, 4);
  assert.equal(row.passed, 4);
  assert.equal(row.done, 4);
  assert.match(row.casesSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.match(row.promptSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(row.cases?.map((item) => [item.id, item.passed]), [['fake-tool', true], ['fake-refusal', true], ['fake-recovery', true], ['fake-plan', true]]);
  assert.deepEqual(row.measures?.map((measure) => measure.name), ['schema', 'tool', 'refusal', 'recovery', 'plan']);
  assert.deepEqual(row.reasons, []);
  assert.doesNotMatch(JSON.stringify(row), /caparra|Cerco|password|Piano/);
  assert.equal(log.requests[0]?.model, 'local-large');
  assert.deepEqual(log.unloaded, ['local-large']);
  const events = await db().sql<{ kind: string; label: string; payload: { evalId: string; status?: string } }[]>`
    SELECT kind, label, payload FROM events WHERE kind LIKE 'model_eval.%' AND payload ->> 'evalId' = ${id} ORDER BY id`;
  assert.deepEqual(events.map((event) => [event.kind, event.label, event.payload.status ?? null]), [
    ['model_eval.queued', 'L0', null],
    ['model_eval.finished', 'L0', 'passed'],
  ]);
  const [job] = await db().sql<{ status: string }[]>`SELECT status FROM jobs WHERE queue = ${EVAL_QUEUE} AND payload ->> 'evalId' = ${id}`;
  assert.equal(job?.status, 'done');
  await stopAll();
});

test('a model assigned to any role is never unloaded, at the end or when giving way', async () => {
  for (const assigned of ['current-model', 'voice-model']) {
    const log: { requests: ChatRequest[]; unloaded: string[] } = { requests: [], unloaded: [] };
    let first = true;
    const hold = (): Promise<void> => {
      if (!first) return Promise.resolve();
      first = false;
      return new Promise(() => undefined);
    };
    let busyNow = false;
    const evals = service([entry(assigned)], fakeModel(log, hold), { busy: () => Promise.resolve(busyNow) });
    const id = await evals.request(assigned, 'orchestrator');
    await evals.start();
    await waitFor(() => Promise.resolve(log.requests.length === 1 ? true : undefined), 'the first case');
    busyNow = true;
    await waitFor(async () => ((await loadModelEval(db().sql, id))?.preemptions === 1 ? true : undefined), 'the preemption');
    await new Promise((resolve) => setTimeout(resolve, 60));
    busyNow = false;
    assert.equal(await waitFor(finished(id), 'the trial'), 'passed');
    assert.deepEqual(log.unloaded, [], assigned);
    await stopAll();
  }
});

test('between two cases the candidate is unloaded as soon as the machine is wanted, before waiting', async () => {
  const log: { requests: ChatRequest[]; unloaded: string[] } = { requests: [], unloaded: [] };
  let freed = false;
  // Busy once the first case has answered, until the test frees the machine.
  const evals = service([entry('between-model')], fakeModel(log), {
    busy: () => Promise.resolve(log.requests.length === 1 && !freed),
    watchMs: 5_000,
  });
  const id = await evals.request('between-model', 'orchestrator');
  await evals.start();
  await waitFor(() => Promise.resolve(log.unloaded.length === 1 ? true : undefined), 'the unload');
  assert.equal(log.requests.length, 1);
  assert.equal(await statusOf(id), 'running');
  freed = true;
  assert.equal(await waitFor(finished(id), 'the trial'), 'passed');
  // Loaded again for the other cases, unloaded again at the end.
  assert.deepEqual(log.unloaded, ['local-large', 'local-large']);
  await stopAll();
});

test('a late answer of the busy check, after the case ended, does not count as a preemption', async () => {
  const log: { requests: ChatRequest[]; unloaded: string[] } = { requests: [], unloaded: [] };
  let inRequest = false;
  // Each request takes 40 ms; a check started during a request answers "busy" 80 ms later, when it is over.
  const model = fakeModel(log, async () => {
    inRequest = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    inRequest = false;
  });
  const busy = (): Promise<boolean> => {
    const during = inRequest;
    return new Promise((resolve) => setTimeout(() => {
      resolve(during);
    }, 80));
  };
  const evals = service([entry('late-model')], model, { busy, watchMs: 10 });
  const id = await evals.request('late-model', 'orchestrator');
  await evals.start();
  assert.equal(await waitFor(finished(id), 'the trial'), 'passed');
  const row = await loadModelEval(db().sql, id);
  assert.ok(row);
  assert.equal(row.preemptions, 0);
  assert.equal(log.requests.length, 4);
  await stopAll();
});

test('no case starts while a task step is ready or a call is live; the trial starts once the machine is free', async () => {
  const { sql } = db();
  const [step] = await sql<{ id: string }[]>`INSERT INTO jobs (queue, payload) VALUES ('task.step', '{}') RETURNING id::text`;
  const log: { requests: ChatRequest[]; unloaded: string[] } = { requests: [], unloaded: [] };
  const evals = service([entry('busy-model')], fakeModel(log));
  const id = await evals.request('busy-model', 'orchestrator');
  await evals.start();
  await waitFor(async () => ((await statusOf(id)) === 'running' ? true : undefined), 'the trial to be claimed');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(log.requests.length, 0);

  // The step is done, but a call rings: still waiting.
  const [conversation] = await sql<{ id: string }[]>`INSERT INTO conversations (mode, clearance) VALUES ('private', 'L2') RETURNING id::text`;
  const [call] = await sql<{ id: string }[]>`
    INSERT INTO calls (conversation_id, direction, status) VALUES (${conversation?.id ?? ''}, 'in', 'active') RETURNING id::text`;
  await sql`UPDATE jobs SET status = 'done' WHERE id = ${step?.id ?? ''}::bigint`;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(log.requests.length, 0);

  await sql`UPDATE calls SET status = 'ended', ended_at = now(), end_reason = 'hangup' WHERE id = ${call?.id ?? ''}`;
  assert.equal(await waitFor(finished(id), 'the trial'), 'passed');
  assert.equal((await loadModelEval(sql, id))?.preemptions, 0);
  await stopAll();
});

test('a case gives way to a task that starts meanwhile and runs again; too many preemptions cancel the trial', async () => {
  const { sql } = db();
  const log: { requests: ChatRequest[]; unloaded: string[] } = { requests: [], unloaded: [] };
  // The first request stays open until it is aborted; the others answer at once.
  let first = true;
  const hold = (): Promise<void> => {
    if (!first) return Promise.resolve();
    first = false;
    return new Promise(() => undefined);
  };
  const evals = service([entry('preempt-model')], fakeModel(log, hold));
  const id = await evals.request('preempt-model', 'orchestrator');
  await evals.start();
  await waitFor(() => Promise.resolve(log.requests.length === 1 ? true : undefined), 'the first case');
  const [step] = await sql<{ id: string }[]>`INSERT INTO jobs (queue, payload) VALUES ('task.step', '{}') RETURNING id::text`;
  await waitFor(async () => ((await loadModelEval(sql, id))?.preemptions === 1 ? true : undefined), 'the preemption');
  assert.equal(log.requests[0]?.signal?.aborted, true);
  // Unloaded before giving way, while the step still waits.
  await waitFor(() => Promise.resolve(log.unloaded.length === 1 ? true : undefined), 'the unload at the preemption');
  await sql`UPDATE jobs SET status = 'done' WHERE id = ${step?.id ?? ''}::bigint`;
  assert.equal(await waitFor(finished(id), 'the trial'), 'passed');
  const row = await loadModelEval(sql, id);
  assert.ok(row);
  assert.equal(row.preemptions, 1);
  assert.equal(row.passed, 4);

  await stopAll();

  // Each attempt is preempted: past the maximum (here 1) the trial ends cancelled.
  let busyNow = false;
  const flapping = service([entry('stubborn-model')], fakeModel({ requests: [], unloaded: [] }, () => new Promise(() => undefined)), {
    maxPreemptions: 1,
    busy: () => Promise.resolve(busyNow),
  });
  const other = await flapping.request('stubborn-model', 'orchestrator');
  await flapping.start();
  const flip = setInterval(() => {
    busyNow = !busyNow;
  }, 60);
  try {
    assert.equal(await waitFor(finished(other), 'the cancelled trial'), 'cancelled');
  } finally {
    clearInterval(flip);
  }
  const cancelled = await loadModelEval(sql, other);
  assert.ok(cancelled);
  assert.equal(cancelled.error, 'preempted');
  assert.ok(cancelled.preemptions >= 2);
  await stopAll();
});

test('a running trial is cancelled by the user; one left running by a previous run is closed at start', async () => {
  const { sql, owner } = db();
  const log: { requests: ChatRequest[]; unloaded: string[] } = { requests: [], unloaded: [] };
  const evals = service([entry('cancel-model')], fakeModel(log, () => new Promise(() => undefined)));
  const id = await evals.request('cancel-model', 'orchestrator');
  await evals.start();
  await waitFor(() => Promise.resolve(log.requests.length === 1 ? true : undefined), 'the first case');
  const answer = await evals.cancel(id);
  // Closed at once, not when the worker notices.
  assert.equal(answer.status, 'cancelled');
  assert.equal(answer.error, 'user');
  await waitFor(() => Promise.resolve(log.requests[0]?.signal?.aborted === true ? true : undefined), 'the case to stop');
  assert.equal(await waitFor(finished(id), 'the cancellation'), 'cancelled');
  await waitFor(async () => {
    const [job] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE queue = ${EVAL_QUEUE} AND payload ->> 'evalId' = ${id}`;
    return job?.status === 'done' ? true : undefined;
  }, 'the job to end');
  const finishedEvents = await sql`SELECT 1 FROM events WHERE kind = 'model_eval.finished' AND payload ->> 'evalId' = ${id}`;
  assert.equal(finishedEvents.length, 1);
  assert.equal((await loadModelEval(sql, id))?.error, 'user');
  assert.deepEqual(log.unloaded, ['local-large']);
  await stopAll();

  // A previous run died with a trial running and its job held.
  const [job] = await owner<{ id: string }[]>`
    INSERT INTO jobs (queue, payload, status, locked_at, locked_by, attempts, max_attempts, key)
    VALUES (${EVAL_QUEUE}, '{}', 'running', now(), 'dead-worker', 1, 1, 'model-eval:left-model') RETURNING id::text`;
  const [left] = await owner<{ id: string }[]>`
    INSERT INTO model_evals (job_id, model_id, role, catalog_status, status, started_at)
    VALUES (${job?.id ?? ''}::bigint, 'left-model', 'orchestrator', 'experimental', 'running', now()) RETURNING id::text`;
  await owner`UPDATE jobs SET payload = ${owner.json({ evalId: left?.id ?? '' })} WHERE id = ${job?.id ?? ''}::bigint`;
  const restarted = service([entry('left-model')], fakeModel({ requests: [], unloaded: [] }));
  await restarted.start();
  const row = await loadModelEval(sql, left?.id ?? '');
  assert.ok(row);
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'interrupted');
  const [after] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${job?.id ?? ''}::bigint`;
  assert.equal(after?.status, 'failed');
  // The key is free again.
  const next = await restarted.request('left-model', 'orchestrator');
  assert.equal(await waitFor(finished(next), 'the new trial'), 'passed');
  await stopAll();
});

test('the API queues, lists, shows and cancels trials', async () => {
  const live: LiveFeed = await startLiveFeed(db().sql);
  const evals = service([entry('api-model'), entry('api-files')], fakeModel({ requests: [], unloaded: [] }), {
    size: (path) => (path.includes('api-files') ? undefined : 20),
  });
  const server: ApiServer = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, modelEvals: evals });
  const origin = `http://127.0.0.1:${String(server.port)}`;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const queued = await post('/api/model-evals', { modelId: 'api-model', role: 'orchestrator' });
    assert.equal(queued.status, 202);
    const { id } = (await queued.json()) as { id: string };
    assert.equal((await post('/api/model-evals', { modelId: 'api-model', role: 'orchestrator' })).status, 409);
    assert.equal((await post('/api/model-evals', { modelId: 'unknown', role: 'orchestrator' })).status, 404);
    assert.equal((await post('/api/model-evals', { modelId: 'api-files', role: 'orchestrator' })).status, 409);
    assert.equal((await post('/api/model-evals', { modelId: 'api-model', role: 'orchestrator', extra: 1 })).status, 400);
    assert.equal((await post('/api/model-evals', { modelId: 'api-model' })).status, 400);

    const list = (await (await fetch(`${origin}/api/model-evals?modelId=api-model`)).json()) as { evals: { id: string; cases?: unknown }[] };
    assert.deepEqual(list.evals.map((item) => item.id), [id]);
    assert.equal('cases' in (list.evals[0] ?? {}), false);
    assert.equal((await fetch(`${origin}/api/model-evals?limit=0`)).status, 400);
    const one = (await (await fetch(`${origin}/api/model-evals/${id}`)).json()) as { eval: { id: string; status: string; cases: unknown } };
    assert.equal(one.eval.status, 'queued');
    assert.equal(one.eval.cases, null);
    assert.equal((await fetch(`${origin}/api/model-evals/999999`)).status, 404);
    assert.equal((await fetch(`${origin}/api/model-evals/abc`)).status, 404);

    const cancelled = await post(`/api/model-evals/${id}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as { eval: { status: string } }).eval.status, 'cancelled');
    assert.equal((await post(`/api/model-evals/${id}/cancel`, {})).status, 409);

    // The protections of every route: same origin, JSON only, the right method.
    const foreign = await fetch(`${origin}/api/model-evals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ modelId: 'api-model', role: 'orchestrator' }),
    });
    assert.equal(foreign.status, 403);
    const form = await fetch(`${origin}/api/model-evals`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'modelId=api-model' });
    assert.equal(form.status, 415);
    assert.equal((await fetch(`${origin}/api/model-evals`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405);
    assert.equal((await fetch(`${origin}/api/model-evals/${id}/cancel`)).status, 405);
    const open = await db().sql`SELECT 1 FROM model_evals WHERE model_id = 'api-model' AND status IN ('queued', 'running')`;
    assert.equal(open.length, 0);
  } finally {
    await server.close();
    await live.close();
    await stopAll();
  }
});

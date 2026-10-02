import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createWorker,
  recordDecision,
  processStepJob,
  resumeTask,
  STEP_QUEUE,
  submitTask,
  type StepContext,
  type StepExecutor,
  type StepOutcome,
} from '../src/engine.ts';
import { createJobQueue } from '../src/jobs.ts';
import type { TaskLimits } from '../src/limits.ts';
import { createTask, loadTask, type NewTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const CARD_LIMITS: TaskLimits = { maxSteps: 100, maxMinutes: 60 };
const ALLOW_ALL = {
  allowedActions: (): readonly string[] => ['delete', 'send_external'],
  agentLimits: (): TaskLimits => CARD_LIMITS,
};

/** Answers each step with the next outcome (the last one repeats) and records the contexts. */
function scripted(outcomes: (StepOutcome | ((ctx: StepContext) => Promise<StepOutcome>))[]): StepExecutor & { seen: StepContext[] } {
  const seen: StepContext[] = [];
  return {
    seen,
    plan: () => ({ agent: 'coder', executor: 'local-model', locality: 'local' }),
    async run(ctx) {
      seen.push(ctx);
      const next = outcomes[Math.min(seen.length - 1, outcomes.length - 1)];
      if (next === undefined) throw new Error('no outcome scripted');
      return typeof next === 'function' ? next(ctx) : next;
    },
  };
}

/** Processes step jobs of this task until none is left; returns the results. */
async function drain(executor: StepExecutor, options = ALLOW_ALL): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 50; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', options));
  }
  throw new Error('drain did not end');
}

async function submit(extra: Partial<NewTask> = {}) {
  return submitTask(db().sql, { title: 'Fake task', assignee: 'coder', ...extra });
}

async function eventsOf(taskId: string) {
  return db().sql<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM events WHERE task_id = ${taskId} ORDER BY events.id`;
}

async function runsOf(taskId: string) {
  return db().sql<{ step: number; status: string; steps_used: number; resumed_from: string | null }[]>`
    SELECT step, status, steps_used, resumed_from::text FROM runs WHERE task_id = ${taskId} ORDER BY started_at, id`;
}

test('a task of several steps ends in "Da verificare" with its evidence', async () => {
  const task = await submit();
  const executor = scripted([{ kind: 'continue' }, { kind: 'continue' }, { kind: 'done', evidence: [{ kind: 'test', ref: 'pnpm check' }] }]);
  assert.deepEqual(await drain(executor), ['continued', 'continued', 'to-verify']);

  const done = await loadTask(db().sql, task.id);
  assert.equal(done?.status, 'to_verify');
  assert.deepEqual(done.evidence, [{ kind: 'test', ref: 'pnpm check' }]);
  assert.deepEqual(executor.seen.map((ctx) => ctx.step), [1, 2, 3]);
  assert.deepEqual((await runsOf(task.id)).map((run) => [run.step, run.status]), [[1, 'ok'], [2, 'ok'], [3, 'ok']]);

  const kinds = (await eventsOf(task.id)).map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 2), ['task.created', 'task.status']);
  assert.equal(kinds.filter((kind) => kind === 'run.started').length, 3);
  assert.equal(kinds.at(-1), 'task.status');
});

test('the step cap stops the task in "Attende te"; raising it lets it go on', async () => {
  const task = await submit({ limits: { max_steps: 2 } });
  const executor = scripted([{ kind: 'continue' }]);
  assert.deepEqual(await drain(executor), ['continued', 'continued', 'limit']);
  let current = await loadTask(db().sql, task.id);
  assert.equal(current?.status, 'waiting_user');
  assert.equal(current.waitingReason, 'limit reached: 2 of 2 steps');
  assert.equal(executor.seen.length, 2, 'no step starts past the cap');

  await resumeTask(db().sql, task.id, { max_steps: 3 });
  assert.deepEqual(await drain(executor), ['continued', 'limit']);
  current = await loadTask(db().sql, task.id);
  assert.equal(current?.waitingReason, 'limit reached: 3 of 3 steps');
});

test('the time cap aborts a step that runs too long', async () => {
  const task = await submit({ limits: { max_minutes: 0.003 } }); // 180 ms
  const executor = scripted([
    (ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      }),
  ]);
  assert.deepEqual(await drain(executor), ['limit']);
  const current = await loadTask(db().sql, task.id);
  assert.equal(current?.status, 'waiting_user');
  assert.match(current.waitingReason ?? '', /minutes/);
  assert.deepEqual((await runsOf(task.id)).map((run) => run.status), ['limit']);
});

test('max_cost 0 lets free steps run and stops after a paid one', async () => {
  const task = await submit({ limits: { max_cost: 0 } });
  const executor = scripted([{ kind: 'continue' }, { kind: 'continue', usage: { cost: 0.5 } }, { kind: 'continue' }]);
  assert.deepEqual(await drain(executor), ['continued', 'continued', 'limit']);
  assert.match((await loadTask(db().sql, task.id))?.waitingReason ?? '', /euro/);
});

test('an approval stops the task; once approved the next step sees it', async () => {
  const task = await submit();
  const executor = scripted([
    { kind: 'approval', action: 'send_external', detail: { channel: 'telegram', ref: 'draft:1' } },
    (ctx) =>
      Promise.resolve(
        ctx.approval?.state === 'approved' ? { kind: 'done', evidence: [{ ref: 'sent' }] } : { kind: 'failed', reason: 'no' },
      ),
  ]);
  assert.deepEqual(await drain(executor), ['waiting-approval']);
  const waiting = await loadTask(db().sql, task.id);
  assert.equal(waiting?.status, 'waiting_user');
  assert.equal(waiting.waitingReason, 'approval needed: send_external');

  const [approval] = await db().sql<{ id: string; state: string; kind: string }[]>`
    SELECT id::text, state, kind FROM approvals WHERE task_id = ${task.id}`;
  assert.equal(approval?.state, 'pending');
  assert.equal(approval.kind, 'action');
  assert.deepEqual(await drain(executor), [], 'nothing runs while waiting');

  await recordDecision(db().sql, approval.id, 'approved', 'web');
  assert.deepEqual(await drain(executor), ['to-verify']);
  assert.equal(executor.seen.at(-1)?.approval?.id, approval.id);
  await assert.rejects(recordDecision(db().sql, approval.id, 'rejected', 'web'), /already decided/);
});

test('a rejected approval reaches the executor as rejected', async () => {
  const task = await submit();
  const executor = scripted([
    { kind: 'approval', action: 'delete', detail: { ref: 'file:1' } },
    (ctx) => Promise.resolve({ kind: 'wait-user', reason: `got ${ctx.approval?.state ?? 'nothing'}` }),
  ]);
  await drain(executor);
  const [approval] = await db().sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${task.id}`;
  assert.ok(approval !== undefined);
  await recordDecision(db().sql, approval.id, 'rejected', 'telegram');
  assert.deepEqual(await drain(executor), ['waiting-user']);
  assert.equal((await loadTask(db().sql, task.id))?.waitingReason, 'got rejected');
});

test('an action outside the card approvals is refused, without an approval row', async () => {
  const task = await submit();
  const executor = scripted([{ kind: 'approval', action: 'payment', detail: {} }]);
  assert.deepEqual(await drain(executor, { ...ALLOW_ALL, allowedActions: () => ['delete'] }), ['waiting-user']);
  assert.match((await loadTask(db().sql, task.id))?.waitingReason ?? '', /not allowed/);
  assert.equal((await db().sql`SELECT 1 FROM approvals WHERE task_id = ${task.id}`).length, 0);
  assert.ok((await eventsOf(task.id)).some((event) => event.kind === 'approval.refused'));
});

test('wait-user keeps its reason in the task and out of the event log', async () => {
  const task = await submit();
  await drain(scripted([{ kind: 'wait-user', reason: 'IBAN IT60X0542811101000000123456 looks odd' }]));
  assert.match((await loadTask(db().sql, task.id))?.waitingReason ?? '', /IBAN/);
  const logged = JSON.stringify(await eventsOf(task.id));
  assert.doesNotMatch(logged, /IBAN/);
  assert.match(logged, /"cause":"executor"/);
});

test('done without evidence waits for the user; failed fails the task', async () => {
  const empty = await submit();
  assert.deepEqual(await drain(scripted([{ kind: 'done', evidence: [] }])), ['waiting-user']);
  assert.equal((await loadTask(db().sql, empty.id))?.waitingReason, 'finished without evidence');

  const failing = await submit();
  assert.deepEqual(await drain(scripted([{ kind: 'failed', reason: 'cannot' }])), ['failed']);
  assert.equal((await loadTask(db().sql, failing.id))?.status, 'failed');
});

test('a job for a task that is not ready any more is skipped', async () => {
  const task = await submit();
  await drain(scripted([{ kind: 'wait-user', reason: 'question' }]));
  await createJobQueue(db().sql).enqueue(STEP_QUEUE, { taskId: task.id });
  const executor = scripted([{ kind: 'continue' }]);
  assert.deepEqual(await drain(executor), ['skipped']);
  assert.equal(executor.seen.length, 0);
});

test('a step that keeps throwing is retried, then the task fails', async () => {
  const task = await submit();
  const errors: unknown[] = [];
  const executor = scripted([
    () => {
      throw new Error('executor crashed');
    },
  ]);
  const worker = createWorker({ sql: db().sql, executor, ...ALLOW_ALL, pollMs: 20, retryAfterMs: 0, onError: (e) => errors.push(e) });
  await worker.start();
  try {
    for (let i = 0; i < 200 && (await loadTask(db().sql, task.id))?.status !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await worker.stop();
  }
  assert.equal((await loadTask(db().sql, task.id))?.status, 'failed');
  assert.equal(executor.seen.length, 3, 'three attempts');
  assert.deepEqual((await runsOf(task.id)).map((run) => run.status), ['failed', 'failed', 'failed']);
  assert.equal(errors.length, 3);
});

test('the worker runs a task end to end and stops cleanly', async () => {
  const task = await submit();
  const executor = scripted([{ kind: 'continue' }, { kind: 'done', evidence: [{ ref: 'ok' }] }]);
  const worker = createWorker({ sql: db().sql, executor, ...ALLOW_ALL, pollMs: 20 });
  await worker.start();
  try {
    for (let i = 0; i < 200 && (await loadTask(db().sql, task.id))?.status !== 'to_verify'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await worker.stop();
  }
  assert.equal((await loadTask(db().sql, task.id))?.status, 'to_verify');
});

test('the database refuses a cloud run above L1 and two running runs for a task', async () => {
  const task = await createTask(db().sql, { title: 'Fake task, not queued', assignee: 'coder' });
  await assert.rejects(
    db().sql`INSERT INTO runs (task_id, step, agent, executor, locality, effective_label)
             VALUES (${task.id}, 1, 'coder', 'claude', 'cloud', 'L2')`,
    /runs_cloud_at_most_l1/,
  );
  await db().sql`INSERT INTO runs (task_id, step, agent, executor, locality) VALUES (${task.id}, 1, 'coder', 'claude', 'cloud')`;
  await assert.rejects(
    db().sql`INSERT INTO runs (task_id, step, agent, executor, locality) VALUES (${task.id}, 1, 'coder', 'local-model', 'local')`,
    /runs_one_running_per_task/,
  );
});

test('"Attende te" always has a reason, and only there', async () => {
  const task = await createTask(db().sql, { title: 'Fake task, not queued', assignee: 'coder' });
  await assert.rejects(db().sql`UPDATE tasks SET status = 'waiting_user' WHERE id = ${task.id}`, /tasks_waiting_has_reason/);
  await assert.rejects(db().sql`UPDATE tasks SET waiting_reason = 'x' WHERE id = ${task.id}`, /tasks_waiting_has_reason/);
});

test('no step runs without a step and a time cap', async () => {
  const task = await submit();
  const executor = scripted([{ kind: 'continue' }]);
  assert.deepEqual(await drain(executor, { ...ALLOW_ALL, agentLimits: () => ({}) }), ['limit']);
  assert.equal((await loadTask(db().sql, task.id))?.waitingReason, 'no step or time cap set');
  assert.equal(executor.seen.length, 0);
});

test('the stricter of the card and task caps applies', async () => {
  const task = await submit({ limits: { max_steps: 5 } });
  assert.deepEqual(await drain(scripted([{ kind: 'continue' }]), { ...ALLOW_ALL, agentLimits: () => ({ maxSteps: 1, maxMinutes: 60 }) }), [
    'continued',
    'limit',
  ]);
  assert.equal((await loadTask(db().sql, task.id))?.waitingReason, 'limit reached: 1 of 1 steps');
});

test('a step that reports 0 steps still counts one', async () => {
  const task = await submit({ limits: { max_steps: 2 } });
  assert.deepEqual(await drain(scripted([{ kind: 'continue', usage: { steps: 0 } }])), ['continued', 'continued', 'limit']);
  assert.match((await loadTask(db().sql, task.id))?.waitingReason ?? '', /2 of 2 steps/);
});

test('an invalid cost (NaN, negative) stops the task instead of switching the cap off', async () => {
  for (const cost of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const task = await submit({ limits: { max_cost: 1 } });
    assert.deepEqual(await drain(scripted([{ kind: 'continue', usage: { cost } }])), ['waiting-user'], String(cost));
    assert.equal((await loadTask(db().sql, task.id))?.waitingReason, 'the executor reported an invalid usage');
  }
  await assert.rejects(
    db().sql`INSERT INTO runs (task_id, step, agent, executor, locality, cost_estimate, status, ended_at)
             SELECT id, 9, 'coder', 'x', 'local', 'NaN', 'ok', now() FROM tasks LIMIT 1`,
    /cost_estimate/,
  );
});

test('a refused action never puts the executor string in the log', async () => {
  const task = await submit();
  await drain(scripted([{ kind: 'approval', action: 'wire IT60X0542811101000000123456', detail: {} }]));
  const logged = JSON.stringify(await eventsOf(task.id));
  assert.doesNotMatch(logged, /IT60X/);
  assert.match(logged, /"action":"unknown"/);
});

test('approvals carry the task label, and the run inherits the task effective label', async () => {
  const task = await submit();
  await db().sql`UPDATE tasks SET effective_label = 'L2' WHERE id = ${task.id}`;
  await drain(scripted([{ kind: 'approval', action: 'delete', detail: { ref: 'file:9' } }]));
  const [approval] = await db().sql<{ label: string }[]>`SELECT label FROM approvals WHERE task_id = ${task.id}`;
  assert.equal(approval?.label, 'L2');
  const [run] = await db().sql<{ effective_label: string }[]>`SELECT effective_label FROM runs WHERE task_id = ${task.id}`;
  assert.equal(run?.effective_label, 'L2');
});

test('a cloud executor is refused on a task that has read L2', async () => {
  const task = await submit();
  await db().sql`UPDATE tasks SET effective_label = 'L2' WHERE id = ${task.id}`;
  const cloud: StepExecutor = { ...scripted([{ kind: 'continue' }]), plan: () => ({ agent: 'coder', executor: 'claude', locality: 'cloud' }) };
  const queue = createJobQueue(db().sql);
  const job = await queue.claim(STEP_QUEUE, 'w');
  assert.ok(job !== undefined);
  await assert.rejects(processStepJob(db().sql, cloud, job, 'w', ALLOW_ALL), /runs_cloud_at_most_l1/);
  assert.equal((await runsOf(task.id)).length, 0);
  await queue.complete(job.id, 'w');
  await db().sql`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
});

test('a worker that lost the job records nothing, and the step resumes from its session', async () => {
  const task = await submit();
  const executor = scripted([
    async (ctx) => {
      await ctx.setSessionRef('session-lost');
      // Another worker takes the job meanwhile.
      await db().sql`UPDATE jobs SET locked_by = 'thief' WHERE payload->>'taskId' = ${task.id} AND status = 'running'`;
      return { kind: 'done', evidence: [{ ref: 'should not be recorded' }] };
    },
    (ctx) => Promise.resolve({ kind: 'done', evidence: [{ resumed: ctx.resume?.sessionRef ?? null }] }),
  ]);
  assert.deepEqual(await drain(executor), ['lost']);
  assert.equal((await loadTask(db().sql, task.id))?.status, 'running');
  assert.deepEqual((await runsOf(task.id)).map((run) => run.status), ['interrupted']);

  // The thief dies: its job comes back and the step resumes.
  await db().sql`UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL WHERE payload->>'taskId' = ${task.id} AND status = 'running'`;
  assert.deepEqual(await drain(executor), ['to-verify']);
  assert.deepEqual((await loadTask(db().sql, task.id))?.evidence, [{ resumed: 'session-lost' }]);
});

test('the time cap does not park a task whose job another worker holds', async () => {
  const task = await submit({ limits: { max_minutes: 0.003 } });
  const executor = scripted([
    async (ctx) => {
      await db().sql`UPDATE jobs SET locked_by = 'thief' WHERE payload->>'taskId' = ${task.id} AND status = 'running'`;
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    },
  ]);
  assert.deepEqual(await drain(executor), ['interrupted']);
  assert.equal((await loadTask(db().sql, task.id))?.status, 'running');
  await db().sql`UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE payload->>'taskId' = ${task.id} AND status = 'running'`;
  await db().sql`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
});

test('resuming a task expires its old approval, which then resumes nothing', async () => {
  const task = await submit();
  await drain(scripted([{ kind: 'approval', action: 'delete', detail: { ref: 'file:2' } }]));
  const [approval] = await db().sql<{ id: string }[]>`SELECT id::text FROM approvals WHERE task_id = ${task.id}`;
  assert.ok(approval !== undefined);
  await resumeTask(db().sql, task.id);
  const [row] = await db().sql<{ state: string }[]>`SELECT state FROM approvals WHERE id = ${approval.id}`;
  assert.equal(row?.state, 'expired');
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'web'), /already decided/);
  await drain(scripted([{ kind: 'wait-user', reason: 'other question' }]));
  assert.equal((await loadTask(db().sql, task.id))?.waitingReason, 'other question');
});

test('a dead worker job without attempts left fails its task in the same sweep', async () => {
  const task = await submit();
  await db().sql`UPDATE jobs SET max_attempts = 1 WHERE payload->>'taskId' = ${task.id}`;
  const queue = createJobQueue(db().sql);
  const job = await queue.claim(STEP_QUEUE, 'dead');
  assert.ok(job !== undefined);
  await db().sql`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${job.id}::bigint`;
  const worker = createWorker({ sql: db().sql, executor: scripted([{ kind: 'continue' }]), ...ALLOW_ALL, lockTimeoutMs: 1_000, pollMs: 20 });
  await worker.start();
  await worker.stop();
  assert.equal((await loadTask(db().sql, task.id))?.status, 'failed');
});

test('last_error keeps a code, never the error message', async () => {
  const task = await submit();
  const executor = scripted([
    () => {
      throw new Error('prompt said IBAN IT60X0542811101000000123456');
    },
  ]);
  const worker = createWorker({ sql: db().sql, executor, ...ALLOW_ALL, pollMs: 20, retryAfterMs: 60_000 });
  await worker.start();
  try {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await db().sql<{ last_error: string | null }[]>`SELECT last_error FROM jobs WHERE payload->>'taskId' = ${task.id}`;
      if (row?.last_error != null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await worker.stop();
  }
  const [row] = await db().sql<{ last_error: string }[]>`SELECT last_error FROM jobs WHERE payload->>'taskId' = ${task.id}`;
  assert.equal(row?.last_error, 'Error');
  await db().sql`UPDATE jobs SET status = 'failed' WHERE payload->>'taskId' = ${task.id}`;
  await db().sql`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
});

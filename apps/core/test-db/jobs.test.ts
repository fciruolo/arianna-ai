import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJobQueue } from '../src/jobs.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

async function age(jobId: string, ms: number): Promise<void> {
  await db().sql`UPDATE jobs SET locked_at = now() - ${ms} * interval '1 millisecond' WHERE id = ${jobId}::bigint`;
}

test('a job is claimed once, in order, and completed by its worker only', async () => {
  const queue = createJobQueue(db().sql);
  const first = await queue.enqueue('q1', { n: 1 });
  const second = await queue.enqueue('q1', { n: 2 });
  const a = await queue.claim('q1', 'w1');
  const b = await queue.claim('q1', 'w2');
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.id, first);
  assert.equal(b.id, second);
  assert.equal(await queue.claim('q1', 'w3'), undefined);
  assert.equal(a.attempts, 1);
  assert.equal(await queue.complete(a.id, 'w2'), false);
  assert.equal(await queue.complete(a.id, 'w1'), true);
});

test('concurrent claims never take the same job (SKIP LOCKED)', async () => {
  const queue = createJobQueue(db().sql);
  for (let n = 0; n < 5; n += 1) await queue.enqueue('q2', { n });
  const claimed = await Promise.all(Array.from({ length: 8 }, (_, n) => queue.claim('q2', `w${String(n)}`)));
  const ids = claimed.filter((job) => job !== undefined).map((job) => job.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
});

test('a scheduled job waits for its time', async () => {
  const queue = createJobQueue(db().sql);
  await queue.enqueue('q3', {}, { runAt: new Date(Date.now() + 60_000) });
  assert.equal(await queue.claim('q3', 'w'), undefined);
});

test('a key allows one active job, and a new one once it is done', async () => {
  const queue = createJobQueue(db().sql);
  const id = await queue.enqueue('q4', {}, { key: 'task:x' });
  assert.ok(id !== undefined);
  assert.equal(await queue.enqueue('q4', {}, { key: 'task:x' }), undefined);
  const job = await queue.claim('q4', 'w');
  assert.equal(await queue.enqueue('q4', {}, { key: 'task:x' }), undefined, 'still running');
  assert.ok(job !== undefined && (await queue.complete(job.id, 'w')));
  assert.ok((await queue.enqueue('q4', {}, { key: 'task:x' })) !== undefined);
});

test('a failed job retries after the delay, then fails for good', async () => {
  const queue = createJobQueue(db().sql);
  await queue.enqueue('q5', {}, { maxAttempts: 2 });
  const first = await queue.claim('q5', 'w');
  assert.ok(first !== undefined);
  assert.equal(await queue.fail(first.id, 'w', 'boom', 0), 'retry');
  const second = await queue.claim('q5', 'w');
  assert.equal(second?.attempts, 2);
  assert.equal(await queue.fail(first.id, 'other', 'boom', 0), 'lost');
  assert.equal(await queue.fail(first.id, 'w', 'x'.repeat(2000), 0), 'failed');
  const [row] = await db().sql<{ status: string; last_error: string }[]>`SELECT status, last_error FROM jobs WHERE id = ${first.id}::bigint`;
  assert.equal(row?.status, 'failed');
  assert.ok(row.last_error.length <= 500);
});

test('a retry is not claimed before its delay', async () => {
  const queue = createJobQueue(db().sql);
  await queue.enqueue('q6', {});
  const job = await queue.claim('q6', 'w');
  assert.ok(job !== undefined);
  assert.equal(await queue.fail(job.id, 'w', 'boom', 60_000), 'retry');
  assert.equal(await queue.claim('q6', 'w'), undefined);
});

test('the heartbeat keeps a job; a stale one goes back to the queue', async () => {
  const queue = createJobQueue(db().sql);
  await queue.enqueue('q7', {});
  const job = await queue.claim('q7', 'dead');
  assert.ok(job !== undefined);
  assert.equal(await queue.heartbeat(job.id, 'dead'), true);
  assert.equal(await queue.heartbeat(job.id, 'other'), false);

  assert.deepEqual(await queue.requeueStale(10_000), { requeued: [], failed: [] });
  await age(job.id, 20_000);
  const swept = await queue.requeueStale(10_000);
  assert.ok(swept.requeued.includes(job.id));
  assert.equal(await queue.heartbeat(job.id, 'dead'), false, 'the dead worker lost it');
  assert.equal((await queue.claim('q7', 'alive'))?.id, job.id);
});

test('a stale job without attempts left fails', async () => {
  const queue = createJobQueue(db().sql);
  await queue.enqueue('q8', {}, { maxAttempts: 1 });
  const job = await queue.claim('q8', 'dead');
  assert.ok(job !== undefined);
  await age(job.id, 20_000);
  const swept = await queue.requeueStale(10_000);
  assert.ok(swept.failed.includes(job.id));
});

test('release gives the job back without spending the attempt', async () => {
  const queue = createJobQueue(db().sql);
  await queue.enqueue('q9', {});
  const job = await queue.claim('q9', 'w');
  assert.ok(job !== undefined);
  assert.equal(await queue.release(job.id, 'other'), false);
  assert.equal(await queue.release(job.id, 'w'), true);
  assert.equal((await queue.claim('q9', 'w'))?.attempts, 1);
});

test('the database keeps the lock columns in step with the status', async () => {
  await assert.rejects(db().sql`INSERT INTO jobs (queue, status) VALUES ('q10', 'running')`, /jobs_lock_follows_status/);
  await assert.rejects(db().sql`INSERT INTO jobs (queue, locked_at, locked_by) VALUES ('q10', now(), 'w')`, /jobs_lock_follows_status/);
});

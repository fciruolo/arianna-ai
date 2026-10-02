import type { Queryable, Sql } from './db/client.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Job {
  /** bigint, kept as a string. */
  id: string;
  queue: string;
  key: string | null;
  payload: { [key: string]: Json };
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  /** Not before this time (scheduled jobs, retries). */
  runAt?: Date;
  maxAttempts?: number;
  /** At most one queued or running job per key: a second enqueue is a no-op. */
  key?: string;
}

/**
 * The job queue (D-004): a PostgreSQL table read with FOR UPDATE SKIP LOCKED,
 * behind an interface so that it can be replaced. A worker holds a job by
 * refreshing `locked_at` (heartbeat); a job whose lock is older than the
 * timeout belongs to a dead worker and goes back to the queue.
 */
export interface JobQueue {
  /** Returns the job id, or undefined when a job with the same key is already active. */
  enqueue(queue: string, payload: Job['payload'], options?: EnqueueOptions): Promise<string | undefined>;
  claim(queue: string, worker: string): Promise<Job | undefined>;
  /** False when the worker no longer holds the job. */
  heartbeat(jobId: string, worker: string): Promise<boolean>;
  complete(jobId: string, worker: string): Promise<boolean>;
  /** Back to the queue after `retryAfterMs`, or `failed` once the attempts are used up. */
  fail(jobId: string, worker: string, error: string, retryAfterMs: number): Promise<'retry' | 'failed' | 'lost'>;
  /** Back to the queue at once, without spending the attempt (worker shutdown). */
  release(jobId: string, worker: string): Promise<boolean>;
  /** Jobs locked longer than `staleMs`: back to the queue, or `failed` without attempts left. */
  requeueStale(staleMs: number): Promise<{ requeued: string[]; failed: string[] }>;
}

const COLUMNS = `id::text, queue, key, payload, attempts, max_attempts AS "maxAttempts"`;

/**
 * What goes in `last_error`: a short code (an error name or a system code),
 * never a message, which could quote prompts or database values.
 */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : typeof error;
  const text = typeof code === 'string' ? `${name}:${code}` : name;
  return /^[\w.:-]{1,100}$/.test(text) ? text : 'error';
}

export function createJobQueue(sql: Sql): JobQueue {
  return {
    async enqueue(queue, payload, options = {}) {
      return enqueueJob(sql, queue, payload, options);
    },

    async claim(queue, worker) {
      const [job] = await sql.unsafe<Job[]>(
        `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM jobs
           WHERE queue = $1 AND status = 'queued' AND run_at <= now()
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING ${COLUMNS}`,
        [queue, worker],
      );
      return job;
    },

    async heartbeat(jobId, worker) {
      const rows = await sql`
        UPDATE jobs SET locked_at = now()
        WHERE id = ${jobId}::bigint AND status = 'running' AND locked_by = ${worker}
        RETURNING id`;
      return rows.length === 1;
    },

    async complete(jobId, worker) {
      return completeJob(sql, jobId, worker);
    },

    async fail(jobId, worker, error, retryAfterMs) {
      return failJob(sql, jobId, worker, error, retryAfterMs);
    },

    async release(jobId, worker) {
      const rows = await sql`
        UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = greatest(attempts - 1, 0)
        WHERE id = ${jobId}::bigint AND status = 'running' AND locked_by = ${worker}
        RETURNING id`;
      return rows.length === 1;
    },

    async requeueStale(staleMs) {
      const rows = await requeueStaleJobs(sql, staleMs);
      return {
        requeued: rows.filter((row) => row.status === 'queued').map((row) => row.id),
        failed: rows.filter((row) => row.status === 'failed').map((row) => row.id),
      };
    },
  };
}

/** `enqueue` inside a caller's transaction. */
export async function enqueueJob(
  sql: Queryable,
  queue: string,
  payload: Job['payload'],
  options: EnqueueOptions = {},
): Promise<string | undefined> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO jobs (queue, payload, run_at, max_attempts, key)
    VALUES (${queue}, ${sql.json(payload)}, COALESCE(${options.runAt ?? null}::timestamptz, now()), ${options.maxAttempts ?? 3}, ${options.key ?? null})
    ON CONFLICT (key) WHERE status IN ('queued', 'running') DO NOTHING
    RETURNING id::text`;
  return row?.id;
}

/** `complete` inside a caller's transaction. */
export async function completeJob(sql: Queryable, jobId: string, worker: string): Promise<boolean> {
  const rows = await sql`
    UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL
    WHERE id = ${jobId}::bigint AND status = 'running' AND locked_by = ${worker}
    RETURNING id`;
  return rows.length === 1;
}

/** `fail` inside a caller's transaction. `error` must be a code (see errorCode), not a message. */
export async function failJob(
  sql: Queryable,
  jobId: string,
  worker: string,
  error: string,
  retryAfterMs: number,
): Promise<'retry' | 'failed' | 'lost'> {
  const [row] = await sql<{ status: 'queued' | 'failed' }[]>`
    UPDATE jobs SET
      status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
      run_at = CASE WHEN attempts < max_attempts THEN now() + ${retryAfterMs} * interval '1 millisecond' ELSE run_at END,
      locked_at = NULL, locked_by = NULL, last_error = ${error.slice(0, 100)}
    WHERE id = ${jobId}::bigint AND status = 'running' AND locked_by = ${worker}
    RETURNING status`;
  if (row === undefined) return 'lost';
  return row.status === 'queued' ? 'retry' : 'failed';
}

/** `requeueStale` inside a caller's transaction, with each job's payload. */
export async function requeueStaleJobs(
  sql: Queryable,
  staleMs: number,
): Promise<{ id: string; status: 'queued' | 'failed'; payload: Job['payload'] }[]> {
  const rows = await sql<{ id: string; status: 'queued' | 'failed'; payload: Job['payload'] }[]>`
    UPDATE jobs SET
      status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
      locked_at = NULL, locked_by = NULL,
      last_error = CASE WHEN attempts < max_attempts THEN last_error ELSE 'lock-expired' END
    WHERE status = 'running' AND locked_at < now() - ${staleMs} * interval '1 millisecond'
    RETURNING id::text, status, payload`;
  return [...rows];
}

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { CatalogEntry, LocalEndpointConfig, ModelCatalog } from '@arianna/config';
import { casesFingerprint, createOrchestratorGroup, loadCases, runGroup, TRIAL_ALIAS, trialEndpoints, type GroupReport } from '@arianna/evals/library';
import type { LocalModel } from '@arianna/executors';

import type { Queryable, Sql } from './db/client.ts';
import { STEP_QUEUE } from './engine.ts';
import { appendEvent } from './events.ts';
import { completeJob, createJobQueue, enqueueJob, errorCode, failJob, type Job } from './jobs.ts';
import { fileSize, type FileSize } from './voice/trial.ts';

/**
 * Trials of a catalog model with the orchestrator evals, in the background
 * (D-081). The evals run as a library inside the core, on the `model.eval`
 * queue of jobs, one trial at a time, on a model built from the endpoints of
 * arianna.toml with `local-large` pointing at the candidate. A trial gives
 * way to the user: no case starts while a call or a task step is at work, and
 * a case in progress is cancelled and started again when one begins. The row
 * holds case ids, outcomes, times and error codes, never what the model said.
 * Promotion of the catalog entry is only suggested: the core never writes the
 * catalog (it is in git).
 */
export const EVAL_QUEUE = 'model.eval';
export const EVAL_ROLES = ['orchestrator'] as const;
export type EvalRole = (typeof EVAL_ROLES)[number];
export const EVAL_STATUSES = ['queued', 'running', 'passed', 'failed', 'error', 'cancelled'] as const;
export type EvalStatus = (typeof EVAL_STATUSES)[number];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The weights of a catalog entry, as one hash: sha256 of the lines
 * `<path> <sha256>\n` of its files, sorted. "According to the catalog": the
 * files on disk are not hashed again (that is `pnpm arianna:models verify`).
 */
export function weightsDigest(entry: Pick<CatalogEntry, 'files'>): string {
  return sha256(
    entry.files
      .map((file) => `${file.path} ${file.sha256}\n`)
      .sort()
      .join(''),
  );
}

export type CandidateCheck =
  | { ok: true; entry: CatalogEntry }
  | { ok: false; code: 'not-in-catalog' | 'role' | 'files-missing' };

/** A model can be tried for a role when the catalog has it, lists the role and its files are in `modelsDir/<id>` with the right size. */
export function checkCandidate(catalog: ModelCatalog, modelId: string, role: EvalRole, modelsDir: string, size: FileSize = fileSize): CandidateCheck {
  const entry = catalog.models.find((model) => model.id === modelId);
  if (entry === undefined) return { ok: false, code: 'not-in-catalog' };
  if (!entry.roles.includes(role)) return { ok: false, code: 'role' };
  if (!entry.files.every((file) => size(join(modelsDir, entry.id, file.path)) === file.sizeBytes)) return { ok: false, code: 'files-missing' };
  return { ok: true, entry };
}

export interface EvalCaseRow {
  id: string;
  passed: boolean;
  ms: number;
  /** A code, like `last_error` of jobs: never the message. */
  error?: string;
}

export interface EvalMeasure {
  name: string;
  total: number;
  passed: number;
  rate: number;
  threshold: number;
}

export interface EvalOutcome {
  status: 'passed' | 'failed';
  total: number;
  passed: number;
  measures: EvalMeasure[];
  latencyMedianMs: number;
  latencyMaxMs: number;
  reasons: string[];
  cases: EvalCaseRow[];
}

function caseRow(result: { id: string; passed: boolean; durationMs: number; errorCode?: string }): EvalCaseRow {
  return { id: result.id, passed: result.passed, ms: Math.round(result.durationMs), ...(result.errorCode === undefined ? {} : { error: result.errorCode }) };
}

/** What a report leaves in the database: never `actual` nor an error message, which may quote the model. */
export function rowFromReport(report: GroupReport): EvalOutcome {
  if (report.status === 'pending') throw new Error('a pending group has no outcome');
  return {
    status: report.status,
    total: report.total,
    passed: report.passed,
    measures: report.measures.map(({ name, total, passed, rate, threshold }) => ({ name, total, passed, rate, threshold })),
    latencyMedianMs: Math.round(report.latency.medianMs),
    latencyMaxMs: Math.round(report.latency.maxMs),
    reasons: [...report.reasons],
    cases: report.results.map(caseRow),
  };
}

/** A call in progress or a task step at work or ready: the machine belongs to the user. */
export async function machineBusy(sql: Queryable): Promise<boolean> {
  const [row] = await sql<{ busy: boolean }[]>`
    SELECT EXISTS (SELECT FROM calls WHERE status IN ('ringing', 'connecting', 'active'))
        OR EXISTS (SELECT FROM jobs WHERE queue = ${STEP_QUEUE}
                   AND (status = 'running' OR (status = 'queued' AND run_at <= now()))) AS busy`;
  return row?.busy === true;
}

export interface ModelEvalRow {
  id: string;
  modelId: string;
  role: EvalRole;
  weightsSha256: string | null;
  catalogStatus: string;
  casesSha256: string | null;
  promptSha256: string | null;
  status: EvalStatus;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  total: number | null;
  passed: number | null;
  /** Cases finished so far (all of them once the trial is over). */
  done: number;
  measures: EvalMeasure[] | null;
  latencyMedianMs: number | null;
  latencyMaxMs: number | null;
  reasons: string[] | null;
  preemptions: number;
  error: string | null;
  cases?: EvalCaseRow[] | null;
}

const COLUMNS = `id::text, model_id AS "modelId", role, weights_sha256 AS "weightsSha256", catalog_status AS "catalogStatus",
  cases_sha256 AS "casesSha256", prompt_sha256 AS "promptSha256", status, requested_at AS "requestedAt",
  started_at AS "startedAt", finished_at AS "finishedAt", total, passed, coalesce(jsonb_array_length(cases), 0) AS done,
  measures, latency_median_ms AS "latencyMedianMs", latency_max_ms AS "latencyMaxMs", reasons, preemptions, error`;

export class ModelEvalError extends Error {
  override name = 'ModelEvalError';
  readonly code: 'not-found' | 'invalid' | 'conflict';

  constructor(code: ModelEvalError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export async function listModelEvals(sql: Queryable, options: { modelId?: string; limit: number }): Promise<ModelEvalRow[]> {
  const rows = await sql.unsafe<ModelEvalRow[]>(
    `SELECT ${COLUMNS} FROM model_evals WHERE ($1::text IS NULL OR model_id = $1) ORDER BY requested_at DESC, id DESC LIMIT $2`,
    [options.modelId ?? null, options.limit],
  );
  return [...rows];
}

export async function loadModelEval(sql: Queryable, id: string): Promise<ModelEvalRow | undefined> {
  const [row] = await sql.unsafe<ModelEvalRow[]>(`SELECT ${COLUMNS}, cases FROM model_evals WHERE id = $1::bigint`, [id]);
  return row;
}

/** A trial of the model queued or running: its files must stay where they are (I-3, M4). */
export async function trialOpen(sql: Queryable, modelId: string): Promise<boolean> {
  const [row] = await sql<{ open: boolean }[]>`
    SELECT EXISTS (SELECT FROM model_evals WHERE model_id = ${modelId} AND status IN ('queued', 'running')) AS open`;
  return row?.open === true;
}

/** Closes a trial with its status and code; false when it was already closed. */
async function closeTrial(tx: Queryable, id: string, modelId: string, status: 'error' | 'cancelled', code: string): Promise<boolean> {
  const rows = await tx`
    UPDATE model_evals SET status = ${status}, error = ${code}, finished_at = now()
    WHERE id = ${id}::bigint AND status IN ('queued', 'running') RETURNING id`;
  if (rows.length === 0) return false;
  await appendEvent(tx, { kind: 'model_eval.finished', label: 'L0', payload: { evalId: id, modelId, status, error: code } });
  return true;
}

export interface ModelEvalsOptions {
  sql: Sql;
  /** Read at each request and each trial: a new entry needs no restart. */
  catalog: () => ModelCatalog;
  /** data/models. */
  modelsDir: string;
  /** The endpoints of the current arianna.toml. */
  endpoints: () => readonly LocalEndpointConfig[];
  /**
   * The models assigned to a role now (orchestrator, extractor, voice, stt,
   * tts...): a candidate among them is never unloaded, someone uses it.
   */
  assignedModels: () => readonly string[];
  /** The orchestrator's prompt (agents/arianna.md). */
  prompt: () => string;
  /** evals/orchestrator. */
  casesDir: string;
  /** The local model over the trial endpoints, with the health of the watchdogs like the normal one. */
  createModel: (endpoints: LocalEndpointConfig[]) => LocalModel;
  /** Default: a call in progress or a task step at work or ready. */
  busy?: () => Promise<boolean>;
  size?: FileSize;
  workerId?: string;
  /** A job not refreshed for this long belongs to a dead worker. Default 60 s, like the task worker. */
  lockTimeoutMs?: number;
  /** Pause when the queue is empty. Default 2 s. */
  pollMs?: number;
  /** While the machine is busy, how often to look again before a case. Default 5 s. */
  freeCheckMs?: number;
  /** During a case, how often to look whether the machine is wanted. Default 2 s. */
  watchMs?: number;
  /** A case cancelled more than this many times ends the trial as cancelled. Default 3. */
  maxPreemptions?: number;
  /** How long `stop()` waits for the trial to close. Default 10 s. */
  stopGraceMs?: number;
  onError?: (error: unknown) => void;
}

export interface ModelEvals {
  /** Queues a trial; the id of the row. */
  request(modelId: string, role: string): Promise<string>;
  list(options: { modelId?: string; limit: number }): Promise<ModelEvalRow[]>;
  get(id: string): Promise<ModelEvalRow | undefined>;
  cancel(id: string): Promise<ModelEvalRow>;
  /** Closes the trials a previous run left running, then consumes the queue. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

type StopReason = 'user' | 'preempted' | 'interrupted' | 'lock-lost';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

function isRole(value: unknown): value is EvalRole {
  return EVAL_ROLES.some((role) => role === value);
}

export function createModelEvals(options: ModelEvalsOptions): ModelEvals {
  const { sql } = options;
  const queue = createJobQueue(sql);
  const worker = options.workerId ?? `model-evals-${randomUUID()}`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const busy = options.busy ?? (() => machineBusy(sql));
  const size = options.size ?? fileSize;
  const maxPreemptions = options.maxPreemptions ?? 3;
  const onError = options.onError ?? (() => undefined);
  const controller = new AbortController();
  /** The trial in progress, to cancel it. */
  let current: { id: string; stop: (reason: StopReason) => void } | undefined;
  let loop: Promise<void> | undefined;

  /** Waits for a free machine; `onBusy` once, as soon as it is found busy (the candidate leaves the memory). */
  async function waitFree(signal: AbortSignal, onBusy: () => Promise<void>): Promise<void> {
    let told = false;
    while (!signal.aborted && (await busy())) {
      if (!told) {
        told = true;
        await onBusy();
      }
      await sleep(options.freeCheckMs ?? 5_000, signal);
    }
  }

  async function handle(job: Job): Promise<void> {
    const evalId = typeof job.payload.evalId === 'string' ? job.payload.evalId : undefined;
    const row = evalId === undefined ? undefined : await loadModelEval(sql, evalId);
    if (row === undefined || row.status !== 'queued') {
      // Cancelled while queued, or a malformed job: nothing to do.
      await queue.complete(job.id, worker);
      return;
    }
    const id = row.id;
    const check = isRole(row.role) ? checkCandidate(options.catalog(), row.modelId, row.role, options.modelsDir, size) : ({ ok: false, code: 'role' } as const);
    const endpoints = trialEndpoints(options.endpoints(), row.modelId);
    const refusal = !check.ok ? check.code : endpoints.length === 0 ? 'no-endpoint' : undefined;
    if (refusal !== undefined) {
      await sql.begin(async (tx) => {
        await closeTrial(tx, id, row.modelId, 'error', refusal);
        await completeJob(tx, job.id, worker);
      });
      return;
    }

    // Heartbeat at a third of the timeout, like the task worker: a trial lasts as long as its cases.
    const stopper = new AbortController();
    let reason: StopReason | undefined;
    const stop = (why: StopReason): void => {
      reason ??= why;
      stopper.abort(new Error(`trial stopped: ${why}`));
    };
    current = { id, stop };
    let lastBeat = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - lastBeat > lockTimeoutMs) stop('lock-lost');
      queue
        .heartbeat(job.id, worker)
        .then((held) => {
          if (held) lastBeat = Date.now();
          else stop('lock-lost');
        })
        .catch(onError);
    }, Math.max(10, Math.floor(lockTimeoutMs / 3)));
    const onStopping = (): void => {
      stop('interrupted');
    };
    controller.signal.addEventListener('abort', onStopping, { once: true });
    if (controller.signal.aborted) stop('interrupted');

    let model: LocalModel | undefined;
    // The candidate may be in the memory of the server since a case started.
    let loaded = false;
    const release = async (): Promise<void> => {
      if (!loaded || model?.unload === undefined || options.assignedModels().includes(row.modelId)) return;
      loaded = false;
      await model.unload(TRIAL_ALIAS).catch(onError);
    };
    let progress: Promise<unknown> = Promise.resolve();
    try {
      const prompt = options.prompt();
      const cases = loadCases(options.casesDir);
      const started = await sql`
        UPDATE model_evals SET status = 'running', started_at = now(), total = ${cases.length}, passed = 0, cases = '[]'::jsonb,
          cases_sha256 = ${casesFingerprint(options.casesDir)}, prompt_sha256 = ${sha256(prompt)}
        WHERE id = ${id}::bigint AND status = 'queued' RETURNING id`;
      if (started.length === 0) {
        await queue.complete(job.id, worker);
        return;
      }
      model = options.createModel(endpoints);
      const group = createOrchestratorGroup({ model, prompt });
      const kept: EvalCaseRow[] = [];
      let preemptions = 0;
      let casePreemptions = 0;
      const report = await runGroup(group, cases, {
        signal: stopper.signal,
        // The machine goes back to the user with the memory too: the candidate is unloaded before giving way.
        beforeCase: () => waitFree(stopper.signal, release),
        watchCase: () => {
          const attempt = new AbortController();
          loaded = true;
          // Set when the attempt is over: a late answer of `busy` does not count a preemption.
          let finished = false;
          const timer = setInterval(() => {
            busy()
              .then((taken) => {
                if (!taken || finished || attempt.signal.aborted) return;
                attempt.abort(new Error('the machine is wanted'));
                progress = progress.then(release);
                preemptions += 1;
                casePreemptions += 1;
                const count = preemptions;
                progress = progress.then(() => sql`UPDATE model_evals SET preemptions = ${count} WHERE id = ${id}::bigint AND status = 'running'`).catch(onError);
                if (casePreemptions > maxPreemptions) stop('preempted');
              })
              .catch(onError);
          }, options.watchMs ?? 2_000);
          return {
            signal: attempt.signal,
            stop: () => {
              finished = true;
              clearInterval(timer);
            },
          };
        },
        onResult: (result) => {
          casePreemptions = 0;
          kept.push(caseRow(result));
          const snapshot = sql.json(kept.map((item) => ({ ...item })));
          const passed = kept.filter((item) => item.passed).length;
          progress = progress
            .then(() => sql`UPDATE model_evals SET cases = ${snapshot}, passed = ${passed} WHERE id = ${id}::bigint AND status = 'running'`)
            .catch(onError);
        },
      });
      await progress;
      const outcome = rowFromReport(report);
      await sql.begin(async (tx) => {
        const rows = await tx`
          UPDATE model_evals SET status = ${outcome.status}, finished_at = now(), total = ${outcome.total}, passed = ${outcome.passed},
            measures = ${tx.json(outcome.measures.map((measure) => ({ ...measure })))}, latency_median_ms = ${outcome.latencyMedianMs},
            latency_max_ms = ${outcome.latencyMaxMs}, reasons = ${tx.json(outcome.reasons)},
            cases = ${tx.json(outcome.cases.map((item) => ({ ...item })))}, preemptions = ${preemptions}
          WHERE id = ${id}::bigint AND status = 'running' RETURNING id`;
        if (rows.length === 1) {
          await appendEvent(tx, {
            kind: 'model_eval.finished',
            label: 'L0',
            payload: { evalId: id, modelId: row.modelId, status: outcome.status, passed: outcome.passed, total: outcome.total },
          });
        }
        await completeJob(tx, job.id, worker);
      });
    } catch (error) {
      await progress;
      const why = reason;
      if (why === undefined) onError(error);
      const code = why ?? errorCode(error);
      // Cancelled by the user or by too many preemptions; any other end is an error.
      const status = why === 'user' || why === 'preempted' ? 'cancelled' : 'error';
      await sql.begin(async (tx) => {
        await closeTrial(tx, id, row.modelId, status, code);
        if (status === 'cancelled') await completeJob(tx, job.id, worker);
        else await failJob(tx, job.id, worker, code, 0);
      });
    } finally {
      clearInterval(beat);
      controller.signal.removeEventListener('abort', onStopping);
      current = undefined;
      // The candidate leaves the memory, unless a role uses it.
      await release();
    }
  }

  async function run(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const job = await queue.claim(EVAL_QUEUE, worker);
        if (job === undefined) {
          await sleep(options.pollMs ?? 2_000, controller.signal);
          continue;
        }
        await handle(job);
      } catch (error) {
        onError(error);
        await sleep(options.pollMs ?? 2_000, controller.signal);
      }
    }
  }

  return {
    async request(modelId, role) {
      if (typeof modelId !== 'string' || modelId === '') throw new ModelEvalError('invalid', 'modelId is required');
      if (!isRole(role)) throw new ModelEvalError('invalid', `role must be one of ${EVAL_ROLES.join(', ')}`);
      const check = checkCandidate(options.catalog(), modelId, role, options.modelsDir, size);
      if (!check.ok) {
        if (check.code === 'not-in-catalog') throw new ModelEvalError('not-found', 'the model is not in the catalog');
        throw new ModelEvalError('conflict', check.code === 'role' ? 'the catalog does not list this role for the model' : 'the files of the model are not in data/models');
      }
      if (trialEndpoints(options.endpoints(), modelId).length === 0) throw new ModelEvalError('conflict', 'no local endpoint in arianna.toml');
      try {
        return await sql.begin(async (tx) => {
          const [created] = await tx<{ id: string }[]>`
            INSERT INTO model_evals (model_id, role, weights_sha256, catalog_status)
            VALUES (${modelId}, ${role}, ${weightsDigest(check.entry)}, ${check.entry.status})
            RETURNING id::text`;
          if (created === undefined) throw new Error('INSERT INTO model_evals returned no row');
          const jobId = await enqueueJob(tx, EVAL_QUEUE, { evalId: created.id }, { key: `model-eval:${modelId}`, maxAttempts: 1 });
          if (jobId === undefined) throw new ModelEvalError('conflict', 'a trial of this model is already queued or running');
          await tx`UPDATE model_evals SET job_id = ${jobId}::bigint WHERE id = ${created.id}::bigint`;
          await appendEvent(tx, { kind: 'model_eval.queued', label: 'L0', payload: { evalId: created.id, modelId, role } });
          return created.id;
        });
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === '23505') throw new ModelEvalError('conflict', 'a trial of this model is already queued or running');
        throw error;
      }
    },

    list: (query) => listModelEvals(sql, query),

    get: (id) => loadModelEval(sql, id),

    async cancel(id) {
      const row = await loadModelEval(sql, id);
      if (row === undefined) throw new ModelEvalError('not-found', 'no such trial');
      if (row.status !== 'queued' && row.status !== 'running') throw new ModelEvalError('conflict', `the trial is already ${row.status}`);
      const closed = await sql.begin(async (tx) => {
        if (!(await closeTrial(tx, id, row.modelId, 'cancelled', 'user'))) return false;
        // Its job leaves the queue too: the key frees for a new request.
        await tx`UPDATE jobs SET status = 'done' WHERE queue = ${EVAL_QUEUE} AND payload ->> 'evalId' = ${id} AND status = 'queued'`;
        return true;
      });
      // Running here: the case in progress stops, the worker finds the row closed and only ends its job.
      if (closed && current?.id === id) current.stop('user');
      return (await loadModelEval(sql, id)) ?? row;
    },

    async start() {
      // A trial the previous run left running is not resumed: it is closed, with its job.
      const left = await sql<{ id: string; modelId: string }[]>`
        SELECT id::text, model_id AS "modelId" FROM model_evals WHERE status = 'running' ORDER BY id`;
      for (const { id, modelId } of left) {
        await sql.begin(async (tx) => {
          if (await closeTrial(tx, id, modelId, 'error', 'interrupted')) {
            await tx`UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'interrupted'
                     WHERE queue = ${EVAL_QUEUE} AND payload ->> 'evalId' = ${id} AND status = 'running'`;
          }
        });
      }
      loop = run();
    },

    async stop() {
      controller.abort();
      const grace = new Promise<void>((resolve) => setTimeout(resolve, options.stopGraceMs ?? 10_000).unref());
      await Promise.race([loop, grace]);
    },
  };
}

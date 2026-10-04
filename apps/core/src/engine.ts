import { randomUUID } from 'node:crypto';

import { APPROVAL_ACTIONS } from '@arianna/agents';
import { isAtMost, isLabel, type Label } from '@arianna/policy';

import { decideApproval, loadApproval, requestDeclassify, type DecisionChannel, type StoredApproval } from './approvals.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { describeFailure, recordFailure, type Failure } from './failures.ts';
import { completeJob, createJobQueue, enqueueJob, errorCode, failJob, requeueStaleJobs, type Job, type JobQueue } from './jobs.ts';
import { describeLimit, limitReached, MAX_TIMER_MS, parseLimits, remainingMs, stricterLimits, type TaskLimits } from './limits.ts';
import {
  checkUsage,
  endRun,
  interruptRunning,
  nextStep,
  resumableRun,
  setSessionRef,
  startRun,
  taskUsage,
  touchRuns,
  type RunUsage,
} from './runs.ts';
import { createTask, loadTask, moveTask, setTaskLimits, TaskError, type NewTask, type Task } from './tasks.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * The task engine (task 1.8, D-035): one job per step on the `task.step`
 * queue. Each step checks the caps, opens a run, calls the step executor and
 * records what happened; then it queues the next step, or moves the task to
 * "Attende te", "Da verificare" or "failed". State, run, job and event are
 * written in one transaction, and only while the worker still holds the job.
 * After a crash the job comes back to the queue and the step runs again,
 * resuming the interrupted run's session: steps must be idempotent.
 */
export const STEP_QUEUE = 'task.step';
/** Longest text a declassification may cover: the user reads all of it on the card. */
export const MAX_DECLASSIFY_LENGTH = 20_000;
/** A `retry` outcome waits at least this long: an executor that just refused is not asked again at once. */
export const MIN_RETRY_MS = 60_000;

/** Who runs a step: the orchestrator (task 1.10) or a test double. */
export interface StepExecutor {
  /** Agent and executor for this step (later chosen by the router, task 1.7). */
  plan(task: Task, step: number): RunSpec | Promise<RunSpec>;
  run(context: StepContext): Promise<StepOutcome>;
}

export interface RunSpec {
  agent: string;
  executor: string;
  locality: 'local' | 'cloud';
  model?: string;
  /**
   * What this run has read, when it is not the whole task: a delegated step
   * reads only its brief (docs/PRIVACY-POLICY-SPEC.md). Default: the task's.
   */
  effectiveLabel?: Label;
}

export interface StepContext {
  task: Task;
  step: number;
  runId: string;
  /** Present when this step resumes an interrupted run (crash, shutdown, lost lock). */
  resume?: { runId: string; sessionRef: string | null };
  /** Present when the step follows the decision on the approval the task waited for. */
  approval?: StoredApproval;
  /** Aborted at the time cap, when the worker stops or loses the job: stop promptly. */
  signal: AbortSignal;
  /** Save the executor's session id as soon as it is known, for resume. */
  setSessionRef(sessionRef: string): Promise<void>;
}

export type StepOutcome = (
  | { kind: 'continue' }
  /** Finished: the task goes to "Da verificare" with the evidence (references only). */
  | { kind: 'done'; evidence: Json[] }
  /**
   * The task was an answer in the chat and the answer is stored: the task is
   * done, with the message as evidence. The user has already read it (D-053).
   */
  | { kind: 'answered'; messageId: string }
  /** An irreversible or external action: the task waits for the user's approval. */
  | { kind: 'approval'; action: string; detail: { [key: string]: Json } }
  /**
   * A text that must leave below the task's label, e.g. a brief written after
   * reading L2 for a cloud executor: the user approves this exact text from the
   * web chat. The next step gets the decided approval in `approval` and lowers
   * the text with `applyDeclassify`; nothing else is covered by it.
   */
  | { kind: 'declassify'; text: string; to: Label; /** Label of the text; default the task's effective label at the start of the step. */ from?: Label }
  /**
   * A cloud model that costs beyond the plan (Fable, docs/ROUTER-SPEC.md):
   * the user approves the budget for this step from the chat. The next step
   * finds the decided approval in `approval`.
   */
  | { kind: 'budget'; executor: string; model: string; step: number }
  /**
   * The project folder has changes the user has not committed (D-056): they
   * approve the Coder working over them, from the chat. `files` are paths.
   */
  | { kind: 'workspace'; repo: string; files: string[]; step: number }
  /**
   * The executor refused for now (a quota, task 1.5): the same step runs
   * again at `at`, without the user. The task stays at work; the run failed.
   */
  | { kind: 'retry'; at: Date; reason: string }
  /** Anything else that needs the user, e.g. a gateway block with `next: wait-user`. */
  | { kind: 'wait-user'; reason: string }
  | { kind: 'failed'; reason: string }
) & { usage?: RunUsage };

export interface EngineOptions {
  /** Approval actions the task's agent may ask for (`approvals` of its card). */
  allowedActions: (task: Task) => readonly string[];
  /**
   * Caps of the task's agent card. The engine applies the stricter of these
   * and the task's own, and runs no step without a step and a time cap.
   */
  agentLimits: (task: Task) => TaskLimits;
}

export type StepResult =
  | 'continued'
  | 'to-verify'
  | 'answered'
  | 'waiting-approval'
  | 'waiting-user'
  | 'limit'
  | 'failed'
  | 'skipped'
  | 'interrupted'
  | 'lost';

/** Puts a task's next step in the queue, at once or at `runAt`. False when a step job is already active. */
export async function scheduleTask(sql: Queryable, taskId: string, payload: { [key: string]: Json } = {}, runAt?: Date): Promise<boolean> {
  const id = await enqueueJob(sql, STEP_QUEUE, { taskId, ...payload }, { key: `task:${taskId}`, ...(runAt === undefined ? {} : { runAt }) });
  return id !== undefined;
}

async function mustSchedule(sql: Queryable, taskId: string, payload: { [key: string]: Json } = {}, runAt?: Date): Promise<void> {
  if (!(await scheduleTask(sql, taskId, payload, runAt))) throw new TaskError(`task ${taskId} already has an active step job`);
}

/** Creates a task in Pronti and queues its first step. */
export async function submitTask(sql: Sql, task: Omit<NewTask, 'status'>): Promise<Task> {
  return sql.begin(async (tx) => {
    const created = await createTask(tx, { ...task, status: 'ready' });
    await mustSchedule(tx, created.id);
    return created;
  });
}

/** True while `worker` holds the job; locks the job row until the transaction ends. */
async function holds(tx: Queryable, job: Job, worker: string): Promise<boolean> {
  const rows = await tx`SELECT 1 FROM jobs WHERE id = ${job.id}::bigint AND status = 'running' AND locked_by = ${worker} FOR UPDATE`;
  return rows.length === 1;
}

/** Ends the job and parks the task in "Attende te", if the job is still ours. */
async function park(
  sql: Sql,
  job: Job,
  worker: string,
  taskId: string,
  reason: string,
  cause: 'limit' | 'executor',
  more?: (tx: Queryable) => Promise<void>,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    if (!(await holds(tx, job, worker))) return false;
    await more?.(tx);
    await moveTask(tx, taskId, 'waiting_user', { reason, cause });
    await completeJob(tx, job.id, worker);
    return true;
  });
}

/**
 * Runs one step job. The caller holds the job (claimed by `worker`) and keeps
 * its heartbeat; `stop` aborts the step without blaming it (shutdown, lost lock).
 */
export async function processStepJob(
  sql: Sql,
  executor: StepExecutor,
  job: Job,
  worker: string,
  options: EngineOptions,
  stop: AbortSignal = new AbortController().signal,
): Promise<StepResult> {
  const taskId = typeof job.payload.taskId === 'string' ? job.payload.taskId : undefined;
  const task = taskId === undefined ? undefined : await loadTask(sql, taskId);
  if (task === undefined || (task.status !== 'ready' && task.status !== 'running')) {
    // Stale or malformed job: nothing to do.
    await completeJob(sql, job.id, worker);
    return 'skipped';
  }

  // A run left running belongs to a worker that died: close it at its last heartbeat.
  await sql.begin((tx) => interruptRunning(tx, task.id));

  // Caps first: no step starts past them, and none starts without them.
  let limits: TaskLimits;
  try {
    limits = stricterLimits(parseLimits(task.limits), options.agentLimits(task));
  } catch {
    return (await park(sql, job, worker, task.id, 'invalid limits', 'limit')) ? 'limit' : 'lost';
  }
  if (limits.maxSteps === undefined || limits.maxMinutes === undefined) {
    return (await park(sql, job, worker, task.id, 'no step or time cap set', 'limit')) ? 'limit' : 'lost';
  }
  const maxMinutes = limits.maxMinutes;
  const reached = limitReached(limits, await taskUsage(sql, task.id));
  if (reached !== undefined) {
    const parked = await park(sql, job, worker, task.id, describeLimit(reached), 'limit', async (tx) => {
      await appendEvent(tx, { kind: 'task.limit_reached', taskId: task.id, label: 'L0', payload: { ...reached } });
    });
    return parked ? 'limit' : 'lost';
  }

  const step = await nextStep(sql, task.id);
  const interrupted = await resumableRun(sql, task.id, step);
  const approvalId = typeof job.payload.approvalId === 'string' ? job.payload.approvalId : undefined;
  const loaded = approvalId === undefined ? undefined : await loadApproval(sql, approvalId);
  const approval = loaded?.taskId === task.id ? loaded : undefined;
  const spec = await executor.plan(task, step);

  let run;
  try {
    run = await sql.begin(async (tx) => {
      if (!(await holds(tx, job, worker))) return undefined;
      await moveTask(tx, task.id, 'running');
      return startRun(tx, {
        taskId: task.id,
        step,
        agent: spec.agent,
        executor: spec.executor,
        locality: spec.locality,
        effectiveLabel: spec.effectiveLabel ?? task.effectiveLabel,
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(interrupted === undefined ? {} : { resumedFrom: interrupted.id }),
      });
    });
  } catch (error) {
    // The task moved meanwhile (the user stopped it): this job has nothing left to do.
    if (!(error instanceof TaskError)) throw error;
    await completeJob(sql, job.id, worker);
    return 'skipped';
  }
  if (run === undefined) return 'lost';
  const runId = run.id;

  // The time cap, measured on the usage that includes this run from now on.
  const budget = remainingMs(limits, await taskUsage(sql, task.id)) ?? MAX_TIMER_MS;
  const timeCap = AbortSignal.timeout(Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(budget))));
  const signal = AbortSignal.any([stop, timeCap]);

  let outcome: StepOutcome;
  try {
    outcome = await executor.run({
      task: { ...task, status: 'running' },
      step,
      runId,
      ...(interrupted === undefined ? {} : { resume: { runId: interrupted.id, sessionRef: interrupted.sessionRef } }),
      ...(approval === undefined ? {} : { approval }),
      signal,
      setSessionRef: (ref) => setSessionRef(sql, runId, ref),
    });
  } catch (error) {
    if (stop.aborted) return interruptRun(sql, runId);
    if (timeCap.aborted) return stopAtTimeCap(sql, task.id, runId, job, worker, maxMinutes);
    // An infrastructure error: the run failed, the job retries (with backoff) or fails the task.
    await endRun(sql, runId, 'failed', { steps: 0 });
    throw error;
  }
  if (stop.aborted) return interruptRun(sql, runId);
  if (timeCap.aborted) return stopAtTimeCap(sql, task.id, runId, job, worker, maxMinutes);

  let usage: RunUsage;
  try {
    usage = checkUsage(outcome.usage ?? {});
  } catch {
    // A usage that would switch a cap off: the step counts, the user decides.
    const parked = await park(sql, job, worker, task.id, 'the executor reported an invalid usage', 'executor', async (tx) => {
      await endRun(tx, runId, 'failed');
    });
    return parked ? 'waiting-user' : interruptRun(sql, runId);
  }

  return sql.begin(async (tx): Promise<StepResult> => {
    // The job may have been taken over meanwhile (lost lock): record nothing.
    if (!(await holds(tx, job, worker))) {
      await endRun(tx, runId, 'interrupted', { steps: 0 });
      return 'lost';
    }
    await endRun(tx, runId, outcome.kind === 'failed' || outcome.kind === 'retry' ? 'failed' : 'ok', usage);
    await completeJob(tx, job.id, worker);
    switch (outcome.kind) {
      case 'continue':
        await mustSchedule(tx, task.id);
        return 'continued';
      case 'retry': {
        // The same step again later, never at once: a failed run does not advance the step number.
        const soonest = Date.now() + MIN_RETRY_MS;
        const at = outcome.at instanceof Date && outcome.at.getTime() > soonest ? outcome.at : new Date(soonest);
        await mustSchedule(tx, task.id, {}, at);
        await appendEvent(tx, { kind: 'task.retry', taskId: task.id, runId, label: 'L0', payload: { step, at: at.toISOString() } });
        return 'continued';
      }
      case 'workspace': {
        // Paths of a work repository: the task's label covers them.
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO approvals (task_id, kind, action, detail, label)
          VALUES (${task.id}, 'workspace', 'dirty-workspace', ${tx.json({ repo: outcome.repo, files: outcome.files, step: outcome.step })}, ${task.effectiveLabel}::privacy_label)
          RETURNING id::text`;
        if (created === undefined) throw new Error('INSERT INTO approvals returned no row');
        await moveTask(tx, task.id, 'waiting_user', { reason: 'approval needed: workspace', cause: 'approval', approvalId: created.id });
        await appendEvent(tx, {
          kind: 'approval.requested',
          taskId: task.id,
          runId,
          label: 'L0',
          payload: { approvalId: created.id, action: 'dirty-workspace', files: outcome.files.length },
        });
        return 'waiting-approval';
      }
      case 'budget': {
        // Names from the router only: executor and model are aliases, never content.
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO approvals (task_id, kind, action, detail, label)
          VALUES (${task.id}, 'budget', 'budget', ${tx.json({ executor: outcome.executor, model: outcome.model, step: outcome.step })}, 'L0')
          RETURNING id::text`;
        if (created === undefined) throw new Error('INSERT INTO approvals returned no row');
        await moveTask(tx, task.id, 'waiting_user', { reason: 'approval needed: budget', cause: 'approval', approvalId: created.id });
        await appendEvent(tx, {
          kind: 'approval.requested',
          taskId: task.id,
          runId,
          label: 'L0',
          payload: { approvalId: created.id, action: 'budget', executor: outcome.executor, model: outcome.model },
        });
        return 'waiting-approval';
      }
      case 'answered': {
        const [message] = await tx<{ id: string }[]>`
          SELECT id::text FROM messages
          WHERE id = ${outcome.messageId}::bigint AND task_id = ${task.id} AND role = 'assistant'`;
        if (message === undefined) {
          await moveTask(tx, task.id, 'waiting_user', { reason: 'finished without evidence', cause: 'executor' });
          return 'waiting-user';
        }
        await moveTask(tx, task.id, 'done', { evidence: [{ kind: 'message', ref: message.id }], cause: 'executor' });
        return 'answered';
      }
      case 'done':
        if (outcome.evidence.length === 0) {
          await moveTask(tx, task.id, 'waiting_user', { reason: 'finished without evidence', cause: 'executor' });
          return 'waiting-user';
        }
        await moveTask(tx, task.id, 'to_verify', { evidence: outcome.evidence, cause: 'executor' });
        return 'to-verify';
      case 'approval': {
        const known = APPROVAL_ACTIONS.find((action) => action === outcome.action);
        if (known === undefined || !options.allowedActions(task).includes(known)) {
          await moveTask(tx, task.id, 'waiting_user', { reason: 'the agent asked for an action it is not allowed', cause: 'approval' });
          // The action comes from the executor: only a name from the closed list goes in the log.
          await appendEvent(tx, {
            kind: 'approval.refused',
            taskId: task.id,
            runId,
            label: 'L0',
            payload: { action: known ?? 'unknown' },
          });
          return 'waiting-user';
        }
        // The detail comes from the task's context: it carries the task's label.
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO approvals (task_id, kind, action, detail, label)
          VALUES (${task.id}, 'action', ${known}, ${tx.json(outcome.detail)}, ${task.effectiveLabel}::privacy_label)
          RETURNING id::text`;
        if (created === undefined) throw new Error('INSERT INTO approvals returned no row');
        await moveTask(tx, task.id, 'waiting_user', { reason: `approval needed: ${known}`, cause: 'approval', approvalId: created.id });
        await appendEvent(tx, {
          kind: 'approval.requested',
          taskId: task.id,
          runId,
          label: 'L0',
          payload: { approvalId: created.id, action: known },
        });
        return 'waiting-approval';
      }
      case 'declassify': {
        // The text was written in the task's context: it carries the task's label,
        // or the label the executor read for it, when the step raised it.
        const from = outcome.from !== undefined && isLabel(outcome.from) ? outcome.from : task.effectiveLabel;
        if (
          !isLabel(outcome.to) ||
          isAtMost(from, outcome.to) ||
          typeof outcome.text !== 'string' ||
          outcome.text === '' ||
          outcome.text.length > MAX_DECLASSIFY_LENGTH
        ) {
          await moveTask(tx, task.id, 'waiting_user', { reason: 'the agent asked for an invalid declassification', cause: 'approval' });
          return 'waiting-user';
        }
        const created = await requestDeclassify(tx, { value: outcome.text, label: from, source: `task:${task.id}` }, outcome.to, {
          taskId: task.id,
        });
        await moveTask(tx, task.id, 'waiting_user', { reason: 'approval needed: declassify', cause: 'approval', approvalId: created.id });
        await appendEvent(tx, {
          kind: 'approval.requested',
          taskId: task.id,
          runId,
          label: 'L0',
          payload: { approvalId: created.id, action: 'declassify', from, to: outcome.to },
        });
        return 'waiting-approval';
      }
      case 'wait-user':
        await moveTask(tx, task.id, 'waiting_user', { reason: outcome.reason, cause: 'executor' });
        return 'waiting-user';
      case 'failed':
        // The reason may quote the task: only the executor's name is kept.
        await moveTask(tx, task.id, 'failed', { cause: 'executor' });
        await recordFailure(tx, task.id, { origin: 'engine', code: 'engine.step-failed', details: { executor: spec.executor } });
        return 'failed';
    }
  });
}

async function interruptRun(sql: Sql, runId: string): Promise<StepResult> {
  // The job is released by the worker (shutdown) or already belongs to another one (lost lock).
  await endRun(sql, runId, 'interrupted', { steps: 0 });
  return 'interrupted';
}

async function stopAtTimeCap(sql: Sql, taskId: string, runId: string, job: Job, worker: string, maxMinutes: number): Promise<StepResult> {
  const parked = await park(sql, job, worker, taskId, `limit reached: ${String(maxMinutes)} minutes`, 'limit', async (tx) => {
    await endRun(tx, runId, 'limit');
    await appendEvent(tx, { kind: 'task.limit_reached', taskId, label: 'L0', payload: { limit: 'minutes', max: maxMinutes } });
  });
  return parked ? 'limit' : interruptRun(sql, runId);
}

/**
 * The user's decision on an approval of any kind. The task resumes, either
 * way, only if it is waiting for this very approval: the executor sees
 * `approval.state` and must not act on a rejection. A declassification is
 * decided only from the web chat (the database refuses other channels).
 */
export async function recordDecision(
  sql: Sql,
  approvalId: string,
  state: 'approved' | 'rejected',
  via: DecisionChannel,
): Promise<StoredApproval> {
  return sql.begin((tx) => recordDecisionIn(tx, approvalId, state, via));
}

/** `recordDecision` inside a transaction the caller holds. */
export async function recordDecisionIn(
  tx: Queryable,
  approvalId: string,
  state: 'approved' | 'rejected',
  via: DecisionChannel,
): Promise<StoredApproval> {
  const decided = await decideApproval(tx, approvalId, state, via);
  await appendEvent(tx, {
    kind: 'approval.decided',
    ...(decided.taskId === null ? {} : { taskId: decided.taskId }),
    label: 'L0',
    payload: { approvalId, state, via },
  });
  if (decided.taskId !== null) {
    const task = await loadTask(tx, decided.taskId);
    if (task?.status === 'waiting_user' && task.waitingApprovalId === approvalId) {
      await moveTask(tx, task.id, 'ready', { cause: 'approval' });
      await mustSchedule(tx, task.id, { approvalId });
    }
  }
  return decided;
}

/**
 * The user unblocks a waiting (or failed) task, optionally raising its caps.
 * Approvals the task was still waiting for expire: they belong to the old context.
 */
export async function resumeTask(sql: Sql, taskId: string, limits?: NonNullable<NewTask['limits']>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE approvals SET state = 'expired', decided_at = now()
      WHERE task_id = ${taskId} AND state = 'pending'`;
    if (limits !== undefined) await setTaskLimits(tx, taskId, limits);
    await moveTask(tx, taskId, 'ready', { cause: 'user' });
    await mustSchedule(tx, taskId);
  });
}

/**
 * The user retries a failed task (D-064): the same task, from the step that
 * failed (a failed run does not advance the step), with fresh job attempts.
 * No approval: it does nothing the task was not already doing. Refused for a
 * task of an archived or deleted conversation.
 */
export async function retryTask(sql: Sql, taskId: string): Promise<Task> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ status: string; archived: boolean | null }[]>`
      SELECT t.status, c.archived_at IS NOT NULL OR c.purged_at IS NOT NULL AS archived
      FROM tasks t LEFT JOIN conversations c ON c.id = t.conversation_id
      WHERE t.id = ${taskId} FOR UPDATE OF t`;
    if (row === undefined) throw new TaskError(`task ${taskId} does not exist`);
    if (row.status !== 'failed') throw new TaskError(`task ${taskId} is not failed`);
    if (row.archived === true) throw new TaskError(`task ${taskId} belongs to an archived conversation`);
    const task = await moveTask(tx, taskId, 'ready', { cause: 'user' });
    await mustSchedule(tx, taskId);
    await appendEvent(tx, { kind: 'task.retried', taskId, label: 'L0', payload: { step: await nextStep(tx, taskId) } });
    return task;
  });
}

export interface WorkerOptions extends EngineOptions {
  sql: Sql;
  executor: StepExecutor;
  /** Unique per process; default a random id. */
  workerId?: string;
  /** A job not refreshed for this long belongs to a dead worker. Default 60 s. */
  lockTimeoutMs?: number;
  /** Pause when the queue is empty. Default 1 s. */
  pollMs?: number;
  /** Delay before retrying a step that threw. Default 5 s. */
  retryAfterMs?: number;
  /** How long `stop()` waits for the current step before giving up on it. Default 10 s. */
  stopGraceMs?: number;
  /** The port of a local endpoint id, for the readable error of a failed task (D-064). */
  endpointPort?: (endpoint: string) => number | undefined;
  onError?: (error: unknown) => void;
}

/**
 * Consumes the step queue until stopped. At start, and then once per lock
 * timeout, it takes back the jobs of dead workers: this is what makes a task
 * resume after `kill -9` of the core.
 */
export function createWorker(options: WorkerOptions): { start(): Promise<void>; stop(): Promise<void> } {
  const { sql } = options;
  const queue: JobQueue = createJobQueue(sql);
  const worker = options.workerId ?? `worker-${randomUUID()}`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const controller = new AbortController();
  let loop: Promise<void> | undefined;

  async function handle(job: Job): Promise<void> {
    const taskId = typeof job.payload.taskId === 'string' ? job.payload.taskId : undefined;
    // Heartbeat at a third of the timeout. A lost lock, or no successful beat
    // for a whole timeout (database unreachable), aborts the step: another
    // worker may already be running it.
    const lost = new AbortController();
    let lastBeat = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - lastBeat > lockTimeoutMs) lost.abort();
      queue
        .heartbeat(job.id, worker)
        .then(async (held) => {
          if (!held) {
            lost.abort();
            return;
          }
          lastBeat = Date.now();
          if (taskId !== undefined) await touchRuns(sql, taskId);
        })
        .catch((error: unknown) => options.onError?.(error));
    }, Math.max(10, Math.floor(lockTimeoutMs / 3)));
    try {
      const result = await processStepJob(sql, options.executor, job, worker, options, AbortSignal.any([controller.signal, lost.signal]));
      // Stopped on purpose: give the job back now instead of after the lock timeout.
      if (result === 'interrupted' && controller.signal.aborted && !lost.signal.aborted) await queue.release(job.id, worker);
    } catch (error) {
      options.onError?.(error);
      // The job and the task change together: a crash between the two would leave the task hanging.
      await sql.begin(async (tx) => {
        const result = await failJob(tx, job.id, worker, errorCode(error), options.retryAfterMs ?? 5_000);
        if (result === 'failed' && taskId !== undefined) {
          const failure = describeFailure(error, {
            attempts: job.attempts,
            ...(options.endpointPort === undefined ? {} : { endpointPort: options.endpointPort }),
          });
          await failTask(tx, taskId, failure);
        }
      });
    } finally {
      clearInterval(beat);
    }
  }

  let lastSweep = 0;
  async function sweep(): Promise<void> {
    lastSweep = Date.now();
    await sql.begin(async (tx) => {
      for (const job of await requeueStaleJobs(tx, lockTimeoutMs)) {
        if (job.status === 'failed' && typeof job.payload.taskId === 'string') {
          await failTask(tx, job.payload.taskId, { origin: 'engine', code: 'engine.lock-expired', details: {} });
        }
      }
    });
  }

  async function run(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        if (Date.now() - lastSweep >= lockTimeoutMs) await sweep();
        const job = await queue.claim(STEP_QUEUE, worker);
        if (job === undefined) {
          await sleep(pollMs, controller.signal);
          continue;
        }
        await handle(job);
      } catch (error) {
        options.onError?.(error);
        await sleep(pollMs, controller.signal);
      }
    }
  }

  return {
    async start() {
      await sweep();
      loop = run();
    },
    async stop() {
      controller.abort();
      // A step that ignores its signal is left behind: its job comes back after the lock timeout.
      const grace = new Promise<void>((resolve) => setTimeout(resolve, options.stopGraceMs ?? 10_000).unref());
      await Promise.race([loop, grace]);
    },
  };
}

/** A step that kept failing: the task fails with the reason the user reads, its open runs are closed. */
async function failTask(tx: Queryable, taskId: string, failure: Failure): Promise<void> {
  await interruptRunning(tx, taskId);
  const task = await loadTask(tx, taskId);
  if (task !== undefined && (task.status === 'running' || task.status === 'ready')) {
    await moveTask(tx, taskId, 'failed', { cause: 'error' });
    await recordFailure(tx, taskId, failure);
  }
}

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

import { ChatError, INCOGNITO_TITLE, isUuid } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { interruptRunning } from './runs.ts';
import { moveTask } from './tasks.ts';

/**
 * Incognito conversations (D-136, I-4 tappa 2): a conversation like the
 * others, whose texts are deleted when it closes, with the button "Termina",
 * after `IDLE_MS` without a page on it, or when the core starts. The database
 * holds the rules (migration 0031: immutable mark, no title, never archived
 * nor pinned, tasks titled `INCOGNITO_TITLE`, purge_incognito); here is what
 * the core does around them: stopping the work in progress, the purge with its
 * events, what stays outside Arianna for the closing card, and the watch of
 * the pages.
 */

export { INCOGNITO_TITLE };
/** No page on an incognito conversation for this long closes it (D-136). */
export const INCOGNITO_IDLE_MS = 10 * 60_000;
/** The pages hear the closing this long before it (`conversation.incognito-closing`). */
export const INCOGNITO_WARN_MS = 60_000;
/** The tools that would keep something after the closing: never offered in an incognito conversation (D-136). */
export const INCOGNITO_OFF_TOOLS = ['kb.write', 'task.create', 'task.update'] as const;

export type IncognitoCause = 'user' | 'idle' | 'restart';

/** What the closing card shows (contract of docs/I-4-incognito.md): counts, paths and sizes, never text. */
export interface IncognitoReceipt {
  deleted: { messages: number; tasks: number; summaries: number };
  remains: {
    /** Files the Coder left changed in the project, from task_delegations.files read before the purge. */
    files: { project: string; path: string }[];
    /** What left for a cloud executor: one entry per payload the gateway allowed, model and bytes only. */
    cloud: { model: string; bytes: number }[];
  };
}

/** The conversation is incognito, open or closed: the channels recognize one also after its purge. */
export async function isIncognitoConversation(sql: Queryable, conversationId: string): Promise<boolean> {
  if (!isUuid(conversationId)) return false;
  const [row] = await sql<{ incognito: boolean }[]>`SELECT incognito FROM conversations WHERE id = ${conversationId}`;
  return row?.incognito === true;
}

/** The task belongs to an incognito conversation. */
export async function isIncognitoTask(sql: Queryable, taskId: string): Promise<boolean> {
  if (!isUuid(taskId)) return false;
  const [row] = await sql<{ incognito: boolean }[]>`
    SELECT c.incognito FROM tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ${taskId}`;
  return row?.incognito === true;
}

/** The incognito conversations still open (not purged), oldest first. */
export async function openIncognito(sql: Queryable): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id::text FROM conversations WHERE incognito AND purged_at IS NULL ORDER BY created_at, id`;
  return rows.map((row) => row.id);
}

export interface CloseOptions {
  /**
   * Stops the step of a task the worker is running now (the `stop` signal of
   * the engine, cause incognito): true when there was one. Without it, as at
   * start-up, no step is running in this process.
   */
  stopTask?: (taskId: string) => boolean;
  /** How long to wait for a stopped run to end before closing it here. Default 15 s. */
  waitMs?: number;
  pollMs?: number;
}

interface PurgeResult {
  tasks: number;
  messages: number;
  summaries: number;
  failed: { taskId: string; from: string }[];
  expired: { approvalId: string; taskId: string }[];
}

/**
 * Closes an incognito conversation: stops its work in progress, then in one
 * transaction fails its active jobs and the tasks still at work, ends the
 * runs left running, reads what stays outside Arianna, runs purge_incognito
 * and writes the events (`conversation.incognito-closed` with the cause,
 * then `conversation.purged`). Refused for a conversation that is not
 * incognito (ChatError 'not-incognito') or does not exist ('not-found').
 */
export async function closeIncognito(sql: Sql, conversationId: string, cause: IncognitoCause, options: CloseOptions = {}): Promise<IncognitoReceipt> {
  await checkIncognito(sql, conversationId);
  // Every task, not only the running ones: a ready one may be taken by the worker meanwhile.
  const tasks = await sql<{ id: string }[]>`SELECT id::text FROM tasks WHERE conversation_id = ${conversationId}`;
  let stopped = false;
  for (const task of tasks) stopped = (options.stopTask?.(task.id) ?? false) || stopped;
  if (stopped) await waitForRuns(sql, conversationId, options.waitMs ?? 15_000, options.pollMs ?? 100);

  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT 1 FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
      await checkIncognito(tx, conversationId);
      const taskIds = (await tx<{ id: string }[]>`
        SELECT id::text FROM tasks WHERE conversation_id = ${conversationId} ORDER BY id FOR UPDATE`).map((row) => row.id);
      const keys = taskIds.map((id) => `task:${id}`);
      // Again under the locks: a step claimed since the first look stops now; its writes wait for this transaction and then find the job failed.
      for (const id of taskIds) options.stopTask?.(id);
      // The work stops for good: no step goes back to the queue (D-136, cause incognito).
      await tx`
        UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'incognito'
        WHERE key = ANY (${keys}) AND status IN ('queued', 'running')`;
      // A run the worker did not end in time (or one left by a crash) ends here.
      for (const id of taskIds) await interruptRunning(tx, id);
      const atWork = await tx<{ id: string }[]>`
        SELECT id::text FROM tasks WHERE id = ANY (${taskIds}::uuid[]) AND status IN ('ready', 'running')`;
      for (const task of atWork) await moveTask(tx, task.id, 'failed', { cause: 'incognito' });

      const remains = await remainsOf(tx, taskIds);
      const [row] = await tx<{ purged: PurgeResult }[]>`SELECT purge_incognito(${conversationId}::uuid) AS purged`;
      const purged = row?.purged ?? { tasks: 0, messages: 0, summaries: 0, failed: [], expired: [] };
      for (const task of purged.failed) {
        await appendEvent(tx, { kind: 'task.status', taskId: task.taskId, payload: { from: task.from, to: 'failed', cause: 'purge' } });
      }
      for (const approval of purged.expired) {
        await appendEvent(tx, {
          kind: 'approval.decided',
          taskId: approval.taskId,
          label: 'L0',
          payload: { approvalId: approval.approvalId, state: 'expired', via: null },
        });
      }
      await appendEvent(tx, { kind: 'conversation.incognito-closed', label: 'L0', payload: { conversationId, cause } });
      await appendEvent(tx, { kind: 'conversation.purged', label: 'L0', payload: { conversationId, tasks: purged.tasks } });
      return { deleted: { messages: purged.messages, tasks: purged.tasks, summaries: purged.summaries }, remains };
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'P0002') throw new ChatError('not-found', `conversation ${conversationId} does not exist`);
    // A step that kept working past the closing, or a lock that did not come in time: the caller may try again.
    if (code === '55006' || code === '55P03' || code === '40P01') throw new ChatError('busy', 'the conversation is still at work: try again in a moment');
    throw error;
  }
}

async function checkIncognito(sql: Queryable, conversationId: string): Promise<void> {
  const [row] = isUuid(conversationId)
    ? await sql<{ incognito: boolean }[]>`SELECT incognito FROM conversations WHERE id = ${conversationId} AND purged_at IS NULL`
    : [];
  if (row === undefined) throw new ChatError('not-found', `conversation ${conversationId} does not exist`);
  if (!row.incognito) throw new ChatError('not-incognito', 'not incognito');
}

async function waitForRuns(sql: Sql, conversationId: string, waitMs: number, pollMs: number): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    const [row] = await sql<{ running: boolean }[]>`
      SELECT EXISTS (SELECT FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.conversation_id = ${conversationId} AND r.status = 'running') AS running`;
    if (row?.running !== true || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Files changed by the delegations and payloads sent to the cloud, read before the purge deletes the delegations. */
async function remainsOf(tx: Queryable, taskIds: readonly string[]): Promise<IncognitoReceipt['remains']> {
  const files = await tx<{ project: string; path: string }[]>`
    SELECT d.repo AS project, f.item ->> 'path' AS path
    FROM task_delegations d, jsonb_array_elements(d.files) WITH ORDINALITY AS f (item, n)
    WHERE d.task_id = ANY (${taskIds}::uuid[]) AND d.repo IS NOT NULL AND jsonb_typeof(d.files) = 'array'
    ORDER BY d.id, f.n`;
  const cloud = await tx<{ model: string; bytes: number }[]>`
    SELECT coalesce(r.model, g.target) AS model, coalesce(g.bytes_out, 0) AS bytes
    FROM gateway_log g LEFT JOIN runs r ON r.id = g.run_id
    WHERE g.task_id = ANY (${taskIds}::uuid[]) AND g.locality = 'cloud' AND g.decision = 'allow'
    ORDER BY g.id`;
  return { files: files.map(({ project, path }) => ({ project, path })), cloud: cloud.map(({ model, bytes }) => ({ model, bytes })) };
}

/**
 * At start, before the worker resumes interrupted runs: every incognito
 * conversation left open by the previous run closes with cause `restart`.
 * One failing does not stop the others; the count of the closed ones.
 */
export async function closeIncognitoAtStart(sql: Sql, onError: (error: unknown) => void = () => undefined): Promise<number> {
  let closed = 0;
  for (const id of await openIncognito(sql)) {
    try {
      await closeIncognito(sql, id, 'restart');
      closed += 1;
    } catch (error) {
      onError(error);
      // Not closed now (the idle watch tries again): at least none of its steps is resumed by the worker.
      await haltIncognito(sql, id).catch(onError);
    }
  }
  return closed;
}

/** The jobs of an incognito conversation fail and its runs end, without the purge: nothing of it runs again. */
async function haltIncognito(sql: Sql, conversationId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const taskIds = (await tx<{ id: string }[]>`SELECT id::text FROM tasks WHERE conversation_id = ${conversationId}`).map((row) => row.id);
    await tx`
      UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'incognito'
      WHERE key = ANY (${taskIds.map((id) => `task:${id}`)}) AND status IN ('queued', 'running')`;
    for (const id of taskIds) await interruptRunning(tx, id);
  });
}

export interface IncognitoWatchOptions {
  /** The incognito conversations open now (openIncognito). */
  list: () => Promise<string[]>;
  /** Pages of the chat that said this conversation is open in them (the visibility frame, D-128). */
  pagesOn: (conversationId: string) => number;
  close: (conversationId: string) => Promise<unknown>;
  /** `conversation.incognito-closing` to the pages, `inSeconds` before the closing. */
  warn: (conversationId: string, inSeconds: number) => void;
  idleMs?: number;
  warnMs?: number;
  tickMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface IncognitoWatch {
  /** One look at the open incognito conversations: tests call it with their own clock. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Closes an incognito conversation no page has been on for `idleMs` (D-136,
 * 10 minutes), warning the pages `warnMs` before. A page back on it in time
 * starts the count again; a conversation is first seen at the first look
 * after its creation. In memory: at a restart every incognito closes anyway.
 */
export function createIncognitoWatch(options: IncognitoWatchOptions): IncognitoWatch {
  const idleMs = options.idleMs ?? INCOGNITO_IDLE_MS;
  const warnMs = options.warnMs ?? INCOGNITO_WARN_MS;
  const now = options.now ?? Date.now;
  /** When a page was last seen on each open incognito, and whether the warning went. */
  const seen = new Map<string, { at: number; warned: boolean }>();
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const open = await options.list();
      for (const id of seen.keys()) if (!open.includes(id)) seen.delete(id);
      const at = now();
      for (const id of open) {
        const entry = seen.get(id);
        if (entry === undefined || options.pagesOn(id) > 0) {
          seen.set(id, { at, warned: false });
          continue;
        }
        const idle = at - entry.at;
        if (idle >= idleMs) {
          // Forgotten only once closed: a failed closing is tried again at the next look, the count kept.
          try {
            await options.close(id);
            seen.delete(id);
          } catch (error) {
            options.onError?.(error);
          }
        } else if (idle >= idleMs - warnMs && !entry.warned) {
          entry.warned = true;
          options.warn(id, Math.max(1, Math.round((idleMs - idle) / 1000)));
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        tick().catch((error: unknown) => options.onError?.(error));
      }, options.tickMs ?? 15_000);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * Why an incognito conversation closed, from its `conversation.incognito-closed`
 * event (D-136): the 404 of the closed conversation says it. Undefined for any
 * conversation that is not a closed incognito one.
 */
export async function incognitoClosedCause(sql: Queryable, conversationId: string): Promise<IncognitoCause | undefined> {
  if (!isUuid(conversationId)) return undefined;
  // The events are read only for a closed incognito: any other 404 costs one lookup by key.
  const [closed] = await sql`SELECT 1 FROM conversations WHERE id = ${conversationId} AND incognito AND purged_at IS NOT NULL`;
  if (closed === undefined) return undefined;
  const [row] = await sql<{ cause: string | null }[]>`
    SELECT e.payload ->> 'cause' AS cause FROM events e
    WHERE e.kind = 'conversation.incognito-closed' AND e.payload ->> 'conversationId' = ${conversationId}
    ORDER BY e.id DESC LIMIT 1`;
  return (['user', 'idle', 'restart'] as const).find((cause) => cause === row?.cause);
}

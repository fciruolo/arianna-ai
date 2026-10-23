/**
 * The queue of messages (D-218, idea 4 of OpenWork, D-093). A message the
 * user writes while a task of the conversation is at work waits in
 * `queued_messages` (migration 0066) and leaves when that task ends, one at a
 * time: the chat never runs two answers of a conversation together. Before it
 * leaves the user can change it, remove it or send it at once; "Ferma"
 * (chat-stop.ts) pauses the queue. The events carry ids and counts only.
 */
import { labelForUserMessage, createContext, type Label } from '@arianna/policy';
import type { Queryable, Sql } from './db/client.ts';
import {
  addressedOf,
  ChatError,
  checkUserMessage,
  conversationBusy,
  lockForMessage,
  writeUserMessage,
  type Message,
  type MessageOptions,
} from './conversations.ts';
import { pauseQueue } from './chat-stop.ts';
import { appendEvent } from './events.ts';
import type { Task } from './tasks.ts';

/** At most this many messages wait in one conversation. */
export const MAX_QUEUED = 20;

export interface QueuedMessage {
  id: string;
  conversationId: string;
  label: Label;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueView {
  paused: boolean;
  messages: QueuedMessage[];
}

/** What a message from the chat became: sent at once, or queued. */
export type Posted = { sent: { message: Message; task: Task } } | { queued: QueuedMessage };

const COLUMNS = `id::text, conversation_id::text AS "conversationId", label, body, created_at AS "createdAt", updated_at AS "updatedAt"`;

interface Row extends QueuedMessage {
  designStyle: string | null;
  designSkills: string[] | null;
}

async function announce(tx: Queryable, conversationId: string): Promise<void> {
  await appendEvent(tx, { kind: 'conversation.queue', label: 'L0', payload: { conversationId } });
}

async function queuedCount(tx: Queryable, conversationId: string): Promise<number> {
  const [row] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM queued_messages WHERE conversation_id = ${conversationId}`;
  return row?.count ?? 0;
}

async function isPaused(tx: Queryable, conversationId: string): Promise<boolean> {
  const [row] = await tx`SELECT 1 FROM message_queue_pauses WHERE conversation_id = ${conversationId} AND paused`;
  return row !== undefined;
}

/** An empty queue is never paused: the next message written during an answer waits as usual. */
async function unpauseWhenEmpty(tx: Queryable, conversationId: string): Promise<void> {
  await tx`
    UPDATE message_queue_pauses SET paused = false, changed_at = now() WHERE conversation_id = ${conversationId} AND paused
      AND NOT EXISTS (SELECT FROM queued_messages WHERE conversation_id = ${conversationId})`;
}

function designOf(row: Row): MessageOptions['design'] {
  return row.designSkills === null ? undefined : { style: row.designStyle, skills: row.designSkills };
}

/**
 * A message from the chat: sent at once when nothing of the conversation is
 * at work (and nothing waits before it, unless the queue is paused), queued
 * otherwise. Checked as a sent message is, before it waits.
 */
export async function postOrQueue(sql: Sql, conversationId: string, body: string, options: MessageOptions = {}): Promise<Posted> {
  return sql.begin(async (tx) => {
    const conversation = await lockForMessage(tx, conversationId);
    checkUserMessage(conversation, body, options);
    // «@name» without a text or «/giro» with nobody here (D-107, tappa B2): refused now, not when it would leave.
    await addressedOf(tx, conversationId, conversation, body, options);
    const waiting = await queuedCount(tx, conversationId);
    if (!(await conversationBusy(tx, conversationId)) && (waiting === 0 || (await isPaused(tx, conversationId)))) {
      return { sent: await writeUserMessage(tx, conversationId, body, options) };
    }
    // An attachment never waits in the queue (D-247): the queue holds text only.
    if ((options.attachments?.length ?? 0) > 0) throw new ChatError('busy', 'an attachment cannot wait in the queue: send it when the answer is done');
    if (waiting >= MAX_QUEUED) throw new ChatError('busy', `the queue already holds ${String(MAX_QUEUED)} messages: wait for the answers`);
    const label = labelForUserMessage(createContext(conversation.clearance));
    const [row] = await tx<QueuedMessage[]>`
      INSERT INTO queued_messages (conversation_id, label, body, design_style, design_skills)
      VALUES (${conversationId}, ${label}::privacy_label, ${body}, ${options.design?.style ?? null},
        ${options.design === undefined ? null : [...options.design.skills]}::text[])
      RETURNING ${tx.unsafe(COLUMNS)}`;
    if (row === undefined) throw new Error('INSERT INTO queued_messages returned no row');
    await announce(tx, conversationId);
    return { queued: row };
  });
}

/** The queue of a conversation, oldest first. */
export async function listQueue(sql: Queryable, conversationId: string): Promise<QueueView> {
  const messages = await sql.unsafe<QueuedMessage[]>(`SELECT ${COLUMNS} FROM queued_messages WHERE conversation_id = $1 ORDER BY id`, [conversationId]);
  return { paused: await isPaused(sql, conversationId), messages: [...messages] };
}

/** Locks a queued message with its conversation; refuses one already sent or removed. */
async function lockQueued(tx: Queryable, id: string): Promise<Row> {
  const [found] = /^\d{1,19}$/.test(id)
    ? await tx<{ conversationId: string }[]>`SELECT conversation_id::text AS "conversationId" FROM queued_messages WHERE id = ${id}::bigint`
    : [];
  if (found === undefined) throw new ChatError('not-found', 'this message is no longer in the queue');
  // The conversation first, as every writer of it does: then the message.
  await tx`SELECT 1 FROM conversations WHERE id = ${found.conversationId} FOR UPDATE`;
  const [row] = await tx.unsafe<Row[]>(
    `SELECT ${COLUMNS}, design_style AS "designStyle", design_skills AS "designSkills" FROM queued_messages WHERE id = $1::bigint FOR UPDATE`,
    [id],
  );
  if (row === undefined) throw new ChatError('not-found', 'this message is no longer in the queue');
  return row;
}

/** "Modifica": the new text, checked as when it was written, «@name» too (D-299). */
export async function editQueued(sql: Sql, id: string, body: string, extra: SendOptions = {}): Promise<QueuedMessage> {
  return sql.begin(async (tx) => {
    const row = await lockQueued(tx, id);
    const conversation = await lockForMessage(tx, row.conversationId);
    const design = designOf(row);
    const options = { ...extra, ...(design === undefined ? {} : { design }) };
    checkUserMessage(conversation, body, options);
    await addressedOf(tx, row.conversationId, conversation, body, options);
    const [changed] = await tx<QueuedMessage[]>`
      UPDATE queued_messages SET body = ${body}, updated_at = now() WHERE id = ${id}::bigint RETURNING ${tx.unsafe(COLUMNS)}`;
    if (changed === undefined) throw new Error('UPDATE queued_messages returned no row');
    await announce(tx, row.conversationId);
    return changed;
  });
}

/** "Togli": the message leaves the queue without being sent. */
export async function removeQueued(sql: Sql, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const row = await lockQueued(tx, id);
    await tx`SELECT queued_message_delete(${id}::bigint)`;
    await unpauseWhenEmpty(tx, row.conversationId);
    await announce(tx, row.conversationId);
  });
}

/** What the core adds to a message it sends: who leaves (I-8) and who «@name» may call (D-107, tappa B2). */
export type SendOptions = Pick<MessageOptions, 'leave' | 'mentionable' | 'unmentionable'>;

/** Sends a queued message: it leaves the queue and becomes the user's message, in one transaction. */
async function sendRow(tx: Queryable, row: Row, extra: SendOptions): Promise<{ message: Message; task: Task }> {
  // arianna_app holds no DELETE (doctor): the function of migration 0066 removes it.
  await tx`SELECT queued_message_delete(${row.id}::bigint)`;
  const design = designOf(row);
  const sent = await writeUserMessage(tx, row.conversationId, row.body, { ...extra, ...(design === undefined ? {} : { design }) });
  await unpauseWhenEmpty(tx, row.conversationId);
  await announce(tx, row.conversationId);
  return sent;
}

/** "Invia ora": a queued message leaves at once, also from a paused queue; refused while an answer is at work. */
export async function sendQueuedNow(sql: Sql, id: string, extra: SendOptions = {}): Promise<{ message: Message; task: Task }> {
  return sql.begin(async (tx) => {
    const row = await lockQueued(tx, id);
    if (await conversationBusy(tx, row.conversationId)) throw new ChatError('busy', 'an answer is still at work: wait for it, or stop it');
    return sendRow(tx, row, extra);
  });
}

/** "Riprendi la coda": the queue leaves again, one message at a time. */
export async function resumeQueue(sql: Sql, conversationId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await lockForMessage(tx, conversationId);
    await tx`UPDATE message_queue_pauses SET paused = false, changed_at = now() WHERE conversation_id = ${conversationId} AND paused`;
    await announce(tx, conversationId);
  });
}

/**
 * One look at every queue: in each conversation with nothing at work, not
 * paused nor archived, the oldest message leaves. A message the checks now
 * refuse (the conversation changed), or any other error, pauses its queue
 * instead of looping; the other conversations go on.
 * Returns how many left.
 */
export async function dispatchQueues(sql: Sql, extra?: () => SendOptions, onError?: (error: unknown) => void): Promise<number> {
  const ready = await sql<{ conversationId: string }[]>`
    SELECT DISTINCT q.conversation_id::text AS "conversationId" FROM queued_messages q
    JOIN conversations c ON c.id = q.conversation_id
    WHERE c.archived_at IS NULL AND c.purged_at IS NULL
      AND NOT EXISTS (SELECT FROM message_queue_pauses p WHERE p.conversation_id = q.conversation_id AND p.paused)`;
  let sent = 0;
  for (const { conversationId } of ready) {
    try {
      const done = await sql.begin(async (tx) => {
        // A conversation another writer holds now is looked at again on the next tick.
        const [locked] = await tx`SELECT 1 FROM conversations WHERE id = ${conversationId} AND purged_at IS NULL FOR UPDATE SKIP LOCKED`;
        if (locked === undefined || (await isPaused(tx, conversationId)) || (await conversationBusy(tx, conversationId))) return false;
        const [row] = await tx.unsafe<Row[]>(
          `SELECT ${COLUMNS}, design_style AS "designStyle", design_skills AS "designSkills" FROM queued_messages
           WHERE conversation_id = $1 ORDER BY id LIMIT 1 FOR UPDATE`,
          [conversationId],
        );
        if (row === undefined) return false;
        await sendRow(tx, row, extra?.() ?? {});
        return true;
      });
      if (done) sent += 1;
    } catch (error) {
      // Busy again meanwhile: the next tick.
      if (error instanceof ChatError && error.code === 'busy') continue;
      // Anything else pauses this queue only, said once: the other conversations go on.
      if (!(error instanceof ChatError)) onError?.(error);
      try {
        await sql.begin(async (tx) => {
          await pauseQueue(tx, conversationId);
          await announce(tx, conversationId);
        });
      } catch (paused) {
        onError?.(paused);
      }
    }
  }
  return sent;
}

export interface QueueDispatcher {
  start(): void;
  stop(): void;
  /** One look now; a look asked while one runs is that one. */
  tick(): Promise<void>;
}

/** Looks at the queues every `intervalMs` (default 1 s): a queued message leaves at most that long after its answer. */
export function createQueueDispatcher(options: { sql: Sql; intervalMs?: number; send?: () => SendOptions; onError?: (error: unknown) => void }): QueueDispatcher {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  function tick(): Promise<void> {
    running ??= dispatchQueues(options.sql, options.send, options.onError)
      .then(() => undefined, (error: unknown) => options.onError?.(error))
      .finally(() => {
        running = undefined;
      });
    return running;
  }
  return {
    start() {
      timer ??= setInterval(() => void tick(), options.intervalMs ?? 1000);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}

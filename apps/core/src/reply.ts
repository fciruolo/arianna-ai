import { randomUUID } from 'node:crypto';

import { createContext, isAtMost, isLabel, maxLabel, type Decision, type Label } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { loadMessage, type Message } from './conversations.ts';
import type { Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import { loadTask, type Task } from './tasks.ts';

/**
 * How a step executor answers in the chat (task 1.11, D-039): fragments while
 * the text is being written, then the final message. Fragments go to the web
 * chat only (local, reached over the VPN), through `pg_notify`: they are never
 * stored and never reach another channel; one that contains a value revealed
 * by the vault is refused. The final message passes the
 * gateway towards `channel:web`, is logged in gateway_log, and is stored only
 * if allowed.
 */
export interface ChatReply {
  /** Correlates the fragments with the final message on the client. */
  readonly id: string;
  /** Appends a fragment of the answer being written; rejects one with a vault secret in it. */
  delta(text: string): Promise<void>;
  /**
   * Stores the answer. `label` is what the executor read to write it; the
   * stored label is never below what the task has read.
   */
  finish(body: string, label: Label): Promise<ReplyResult>;
}

export type ReplyResult =
  | { stored: true; message: Message }
  /** The gateway refused it (logged in gateway_log). */
  | { stored: false; reason: 'blocked'; decision: Decision }
  /** Its label is above what the conversation may hold: nothing was offered to the gateway. */
  | { stored: false; reason: 'above-clearance'; label: Label };

/** Channel of the fragments: one per schema, like the event notifications. */
export function deltaChannel(schema: string): string {
  return `arianna_deltas:${schema}`;
}

export interface DeltaNotice {
  replyId: string;
  conversationId: string;
  taskId: string;
  /** Position of the fragment in the reply, from 0. */
  seq: number;
  text: string;
}

// pg_notify payloads stay under 8000 bytes. Pieces start at 1500 code points
// and are halved while the JSON notice (escapes included) is too long.
const CHUNK = 1_500;

// The end of what a reply has already streamed, checked again with each new
// fragment: a secret split over several fragments is still found. Longer than
// any secret the vault is meant for (a PEM key is about 3 KB).
const STREAMED_TAIL = 16_384;
const MAX_NOTICE_BYTES = 7_000;

/** The JSON notices for a fragment, each under the pg_notify limit. */
export function notices(text: string, base: Omit<DeltaNotice, 'seq' | 'text'>, firstSeq: number): string[] {
  const out: string[] = [];
  const add = (piece: string): void => {
    const json = JSON.stringify({ ...base, seq: firstSeq + out.length, text: piece });
    const points = Array.from(piece);
    if (Buffer.byteLength(json) <= MAX_NOTICE_BYTES || points.length <= 1) {
      out.push(json);
      return;
    }
    const half = Math.ceil(points.length / 2);
    add(points.slice(0, half).join(''));
    add(points.slice(half).join(''));
  };
  for (const piece of chunk(text)) add(piece);
  return out;
}

/** Splits text in pieces of at most `size` code points, never inside a surrogate pair. */
export function chunk(text: string, size: number = CHUNK): string[] {
  const points = Array.from(text);
  const pieces: string[] = [];
  for (let start = 0; start < points.length; start += size) pieces.push(points.slice(start, start + size).join(''));
  return pieces;
}

/**
 * Opens the reply of a task that answers in a conversation. `agent` names the
 * agent that writes it when it is not Arianna (the Coder's report of a
 * delegated step, task 1.10): the message carries it, and Arianna's own
 * answer is still awaited.
 */
export async function openReply(sql: Sql, taskId: string, options: { runId?: string; agent?: string } = {}): Promise<ChatReply> {
  const task = await loadTask(sql, taskId);
  if (task === undefined) throw new Error(`task ${taskId} does not exist`);
  const conversationId = task.conversationId;
  if (conversationId === null) throw new Error(`task ${taskId} does not answer in a conversation`);
  const id = randomUUID();
  let seq = 0;
  let finished = false;
  let streamed = '';

  return {
    id,
    async delta(text) {
      if (finished) throw new Error('the reply is finished');
      // Fragments skip the gateway (they are not stored), not the vault check;
      // the new fragment is checked joined to the end of what was already sent.
      const joined = streamed + text;
      const refs = knownSecrets.find(joined);
      if (refs.length > 0) throw new Error(`the fragment contains the value of ${refs.join(', ')}`);
      streamed = joined.slice(-STREAMED_TAIL);
      for (const notice of notices(text, { replyId: id, conversationId, taskId }, seq)) {
        seq += 1;
        // Same channel the live feed listens on: deltaChannel(current_schema()).
        await sql`SELECT pg_notify(${deltaChannel('')} || current_schema(), ${notice})`;
      }
    },
    async finish(body, label) {
      if (finished) throw new Error('the reply is finished');
      if (typeof body !== 'string' || body === '') throw new Error('the reply is empty');
      finished = true;
      // The task may have read more since it started: read its label again.
      const current: Task | undefined = await loadTask(sql, taskId);
      if (current === undefined) throw new Error(`task ${taskId} does not exist`);
      const stored = maxLabel(isLabel(label) ? label : 'L2', current.effectiveLabel);
      // The task's clearance is within the conversation's (database trigger).
      if (!isAtMost(stored, current.clearance)) return { stored: false, reason: 'above-clearance', label: stored };
      const context = createContext(current.clearance, current.effectiveLabel);
      const decision = await passGateway(sql, [{ value: body, label: stored, source: `task:${taskId}` }], context, { kind: 'channel', id: 'web' }, {
        taskId,
        ...(options.runId === undefined ? {} : { runId: options.runId }),
      });
      if (decision.decision === 'block') return { stored: false, reason: 'blocked', decision };
      const [text] = decision.texts;
      if (text === undefined) throw new Error('the gateway allowed no text');

      const messageId = await sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO messages (conversation_id, role, channel, label, body, task_id, agent)
          VALUES (${conversationId}, 'assistant', 'web', ${stored}::privacy_label, ${text}, ${taskId}, ${options.agent ?? null})
          RETURNING id::text`;
        if (row === undefined) throw new Error('INSERT INTO messages returned no row');
        await appendEvent(tx, {
          kind: 'message.created',
          taskId,
          ...(options.runId === undefined ? {} : { runId: options.runId }),
          label: 'L0',
          payload: { conversationId, messageId: row.id, role: 'assistant', replyId: id, ...(options.agent === undefined ? {} : { agent: options.agent }) },
        });
        return row.id;
      });
      const message = await loadMessage(sql, messageId);
      if (message === undefined) throw new Error('the new message is missing');
      return { stored: true, message };
    },
  };
}

/**
 * What a task is doing, shown under the user's message while it works (task
 * 1.10, D-054): a kind and a short detail (a query, a path, a card title),
 * never stored, sent to the web chat only, like reply fragments. The page
 * writes the line in Italian (D-045).
 */
export const ACTIVITY_KINDS = ['thinking', 'search', 'read', 'write', 'card', 'plan', 'error', 'delegate', 'tool', 'wait'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityNotice {
  conversationId: string;
  taskId: string;
  step: number;
  kind: ActivityKind;
  detail: string;
}

/** Channel of the activity notices: one per schema, like the fragments. */
export function activityChannel(schema: string): string {
  return `arianna_activity:${schema}`;
}

const MAX_DETAIL = 300;

/**
 * Sends one activity line. A detail holding a value revealed by the vault is
 * refused, as a fragment would be; a long one is cut.
 */
export async function postActivity(sql: Sql, notice: ActivityNotice): Promise<void> {
  const points = Array.from(notice.detail.replace(/\s+/g, ' ').trim());
  const detail = points.length > MAX_DETAIL ? `${points.slice(0, MAX_DETAIL - 1).join('')}…` : points.join('');
  const refs = knownSecrets.find(detail);
  if (refs.length > 0) throw new Error(`the activity contains the value of ${refs.join(', ')}`);
  const payload = JSON.stringify({ ...notice, detail });
  if (Buffer.byteLength(payload) > MAX_NOTICE_BYTES) throw new Error('the activity notice is too long');
  await sql`SELECT pg_notify(${activityChannel('')} || current_schema(), ${payload})`;
}

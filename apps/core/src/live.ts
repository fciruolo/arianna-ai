import { FILE_EDIT_TOOLS } from '@arianna/executors';

import type { Sql } from './db/client.ts';
import { readEvents, type StoredEvent } from './events.ts';
import { editChannel, type EditNotice } from './live-edit.ts';
import { ACTIVITY_KINDS, activityChannel, deltaChannel, type ActivityNotice, type DeltaNotice } from './reply.ts';

/**
 * Live feed for the web chat (task 1.11, D-039). A trigger announces every
 * new event with `pg_notify`; the feed listens, reads the new events from the
 * table in order and hands them to subscribers, together with the reply
 * fragments. Writers can live in any process: the database is the bus.
 */
export type PublicEvent = Omit<StoredEvent, 'prevHash' | 'hash'>;

/**
 * `incognito: true` on a frame of a task or a conversation that is incognito
 * (D-136): the chat keeps it out of the office and the status also in a page
 * that does not know that conversation. Absent otherwise.
 */
export type LiveMessage = (
  | { type: 'event'; event: PublicEvent }
  | ({ type: 'delta' } & DeltaNotice)
  | ({ type: 'activity' } & ActivityNotice)
  /** A piece of a live change of the Coder (D-117): web chat only. */
  | ({ type: 'edit' } & EditNotice)
) & { incognito?: true };

export interface Subscriber {
  send(message: LiveMessage): void;
}

export interface LiveFeed {
  /**
   * Sends the events after `afterId` (all of them, in order, then the live
   * ones) and the fragments from now on. Returns the function that stops it.
   */
  subscribe(subscriber: Subscriber, afterId?: string): Promise<() => void>;
  close(): Promise<void>;
}

export function eventChannel(schema: string): string {
  return `arianna_events:${schema}`;
}

const PAGE = 500;

function toPublic(event: StoredEvent): PublicEvent {
  const { id, ts, taskId, runId, agent, kind, label, payload } = event;
  return { id, ts, taskId, runId, agent, kind, label, payload };
}

function parseDelta(payload: string): DeltaNotice | undefined {
  try {
    const value = JSON.parse(payload) as Partial<DeltaNotice> | null;
    if (
      value !== null &&
      typeof value.replyId === 'string' &&
      typeof value.conversationId === 'string' &&
      typeof value.taskId === 'string' &&
      typeof value.seq === 'number' &&
      typeof value.text === 'string'
    ) {
      return { replyId: value.replyId, conversationId: value.conversationId, taskId: value.taskId, seq: value.seq, text: value.text };
    }
  } catch {
    // Not ours: ignored.
  }
  return undefined;
}

function parseActivity(payload: string): ActivityNotice | undefined {
  try {
    const value = JSON.parse(payload) as Partial<ActivityNotice> | null;
    if (
      value !== null &&
      typeof value.conversationId === 'string' &&
      typeof value.taskId === 'string' &&
      typeof value.step === 'number' &&
      ACTIVITY_KINDS.some((kind) => kind === value.kind) &&
      typeof value.detail === 'string'
    ) {
      return { conversationId: value.conversationId, taskId: value.taskId, step: value.step, kind: value.kind as ActivityNotice['kind'], detail: value.detail };
    }
  } catch {
    // Not ours: ignored.
  }
  return undefined;
}

const EDIT_TOOLS: readonly string[] = FILE_EDIT_TOOLS;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseEdit(payload: string): EditNotice | undefined {
  try {
    const value = JSON.parse(payload) as Partial<EditNotice> | null;
    if (
      value !== null &&
      typeof value.editId === 'string' &&
      typeof value.conversationId === 'string' &&
      typeof value.taskId === 'string' &&
      count(value.step) &&
      typeof value.path === 'string' &&
      typeof value.tool === 'string' &&
      EDIT_TOOLS.includes(value.tool) &&
      (value.label === 'L0' || value.label === 'L1') &&
      count(value.added) &&
      count(value.removed) &&
      [undefined, 'too-large', 'refused'].includes(value.error) &&
      count(value.seq) &&
      count(value.total) &&
      value.seq < value.total &&
      typeof value.text === 'string'
    ) {
      const { editId, conversationId, taskId, step, path, tool, label, added, removed, error, seq, total, text } = value;
      return { editId, conversationId, taskId, step, path, tool, label, added, removed, ...(error === undefined ? {} : { error }), seq, total, text };
    }
  } catch {
    // Not ours: ignored.
  }
  return undefined;
}

interface Entry {
  subscriber: Subscriber;
  /** Last event id sent to this subscriber. */
  sent: bigint;
  /** While it catches up, live events wait here, with whether they are of an incognito. */
  pending: { event: PublicEvent; incognito: boolean }[] | undefined;
}

/**
 * The ids of the events of a task or a conversation that is incognito
 * (D-136), from the task of the event or the `conversationId` of its payload.
 */
export async function incognitoEvents(sql: Sql, events: readonly Pick<StoredEvent, 'id' | 'taskId' | 'payload'>[]): Promise<Set<string>> {
  const conversationOf = (event: Pick<StoredEvent, 'payload'>): string | undefined => {
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
    const id = (payload as Record<string, unknown>).conversationId;
    return typeof id === 'string' && UUID.test(id) ? id : undefined;
  };
  const taskIds = [...new Set(events.flatMap((event) => (event.taskId === null ? [] : [event.taskId])))];
  const conversationIds = [...new Set(events.flatMap((event) => conversationOf(event) ?? []))];
  if (taskIds.length === 0 && conversationIds.length === 0) return new Set();
  const rows = await sql<{ id: string; kind: 'task' | 'conversation' }[]>`
    SELECT t.id::text, 'task' AS kind FROM tasks t JOIN conversations c ON c.id = t.conversation_id
    WHERE t.id = ANY (${taskIds}::uuid[]) AND c.incognito
    UNION ALL
    SELECT id::text, 'conversation' FROM conversations WHERE id = ANY (${conversationIds}::uuid[]) AND incognito`;
  const tasks = new Set(rows.filter((row) => row.kind === 'task').map((row) => row.id));
  const conversations = new Set(rows.filter((row) => row.kind === 'conversation').map((row) => row.id));
  return new Set(
    events
      .filter((event) => (event.taskId !== null && tasks.has(event.taskId)) || conversations.has(conversationOf(event) ?? ''))
      .map((event) => event.id),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function startLiveFeed(sql: Sql, options: { onError?: (error: unknown) => void } = {}): Promise<LiveFeed> {
  // The same schema the trigger and the replies use for their channels.
  const [current] = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`;
  const schema = current?.schema ?? 'public';
  const entries = new Set<Entry>();
  const [row] = await sql<{ last: string }[]>`SELECT coalesce(max(id), 0)::text AS last FROM events`;
  let last = BigInt(row?.last ?? '0');
  let reading: Promise<void> | undefined;
  /** Notifications received; a read that started before the last one reads again. */
  let wakes = 0;
  let closed = false;

  function deliver(entry: Entry, event: PublicEvent, incognito: boolean): void {
    const id = BigInt(event.id);
    if (id <= entry.sent) return;
    entry.sent = id;
    entry.subscriber.send({ type: 'event', event, ...(incognito ? { incognito: true as const } : {}) });
  }

  async function readNew(): Promise<void> {
    for (;;) {
      const events = await readEvents(sql, { afterId: last.toString(), limit: PAGE });
      const hidden = await incognitoEvents(sql, events);
      last = events.length === 0 ? last : BigInt(events[events.length - 1]?.id ?? last.toString());
      // In the same queue as the fragments (D-136): a fragment that came first, waiting for its lookup, still goes first.
      await enqueue(() => {
        for (const stored of events) {
          const event = toPublic(stored);
          const incognito = hidden.has(event.id);
          for (const entry of entries) {
            if (entry.pending !== undefined) entry.pending.push({ event, incognito });
            else deliver(entry, event, incognito);
          }
        }
      });
      if (events.length < PAGE) return;
    }
  }

  /** Whether a conversation is incognito: immutable, so remembered (D-136). */
  const incognitoCache = new Map<string, boolean>();
  async function conversationIncognito(conversationId: string): Promise<boolean> {
    const known = incognitoCache.get(conversationId);
    if (known !== undefined) return known;
    if (!UUID.test(conversationId)) return false;
    const [row] = await sql<{ incognito: boolean }[]>`SELECT incognito FROM conversations WHERE id = ${conversationId}`;
    const incognito = row?.incognito === true;
    if (incognitoCache.size >= 1000) incognitoCache.clear();
    if (row !== undefined) incognitoCache.set(conversationId, incognito);
    return incognito;
  }
  /**
   * One queue for what reaches the subscribers live: the fragments of the
   * notifications, each marked when its conversation is incognito, and the
   * events, in the order they came. A fragment whose lookup fails is dropped
   * (reported): unmarked it could show an incognito where it must not.
   */
  let frames: Promise<void> = Promise.resolve();
  function enqueue(work: () => void | Promise<void>): Promise<void> {
    frames = frames.then(work).catch((error: unknown) => options.onError?.(error));
    return frames;
  }
  function sendFrame(message: Exclude<LiveMessage, { type: 'event' }>): void {
    void enqueue(async () => {
      const incognito = await conversationIncognito(message.conversationId);
      const marked: LiveMessage = incognito ? { ...message, incognito: true } : message;
      for (const entry of entries) entry.subscriber.send(marked);
    });
  }

  /** Coalesces notifications: one read at a time, and one more if any came meanwhile. */
  function wake(): void {
    wakes += 1;
    if (reading !== undefined) return;
    reading = (async () => {
      while (!closed) {
        const seen = wakes;
        try {
          await readNew();
        } catch (error) {
          options.onError?.(error);
        }
        if (wakes === seen) break;
      }
      reading = undefined;
    })();
  }

  // On (re)connection the listener may have missed notifications: read anyway.
  const events = await sql.listen(eventChannel(schema), wake, wake);
  const deltas = await sql.listen(deltaChannel(schema), (payload) => {
    const delta = parseDelta(payload);
    if (delta === undefined) return;
    sendFrame({ type: 'delta', ...delta });
  });
  const activity = await sql.listen(activityChannel(schema), (payload) => {
    const notice = parseActivity(payload);
    if (notice === undefined) return;
    sendFrame({ type: 'activity', ...notice });
  });

  const edits = await sql.listen(editChannel(schema), (payload) => {
    const notice = parseEdit(payload);
    if (notice === undefined) return;
    sendFrame({ type: 'edit', ...notice });
  });

  return {
    async subscribe(subscriber, afterId) {
      // An id from the future would silence the subscriber until the log caught up.
      const asked = afterId !== undefined && /^\d{1,19}$/.test(afterId) ? BigInt(afterId) : last;
      const start = asked < last ? asked : last;
      const entry: Entry = { subscriber, sent: start, pending: [] };
      entries.add(entry);
      try {
        // Catch up from the table, then flush what arrived live meanwhile; ids dedupe the overlap.
        for (;;) {
          const page = await readEvents(sql, { afterId: entry.sent.toString(), limit: PAGE });
          const hidden = await incognitoEvents(sql, page);
          for (const event of page) deliver(entry, toPublic(event), hidden.has(event.id));
          if (page.length < PAGE) break;
        }
        for (const { event, incognito } of entry.pending ?? []) deliver(entry, event, incognito);
        entry.pending = undefined;
      } catch (error) {
        entries.delete(entry);
        throw error;
      }
      return () => {
        entries.delete(entry);
      };
    },
    async close() {
      closed = true;
      entries.clear();
      await events.unlisten();
      await deltas.unlisten();
      await activity.unlisten();
      await edits.unlisten();
      await reading;
      await frames;
    },
  };
}

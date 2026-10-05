import { inQuiet, type NotificationsConfig } from '@arianna/config';

import type { Queryable } from './db/client.ts';
import type { LiveMessage, PublicEvent, Subscriber } from './live.ts';
import type { PushKind } from './voice/push.ts';

/**
 * Notifications of the web chat (I-1). From the live feed the core picks
 * three kinds of event: the final reply of a task, an approval waiting, a
 * failed task. If `[notifications]` allows the kind and it is not quiet time,
 * it tells every open page (which shows a browser notification when it is
 * not in view, or the conversation is another one) and, when no page is in
 * view, sends an empty Web Push. Nothing here carries text or a title: a
 * notice is a kind and a conversation id, and the sentence shown is fixed.
 */
export type NoticeKind = Exclude<PushKind, 'call'>;

/** What a page and the service worker learn: a kind and where it leads, nothing else. */
export interface Notice {
  kind: PushKind;
  conversationId: string | null;
}

/** What one event became: `off` and `quiet` stop it; `pages` reached the pages only; `push` also pushed. */
export type NoticeOutcome = 'none' | 'off' | 'quiet' | 'pages' | 'push';

/**
 * The kind of notice an event is, from its metadata only. A reply is a
 * message of Arianna's that ends a task: the report of a delegated agent and
 * the lines of a call are not (in a call the user is listening already).
 */
export function noticeOf(event: Pick<PublicEvent, 'kind' | 'taskId' | 'payload'>): { kind: NoticeKind; conversationId?: string; taskId?: string } | undefined {
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  if (event.kind === 'message.created') {
    if (payload.role !== 'assistant' || typeof payload.conversationId !== 'string') return undefined;
    if (payload.agent !== undefined || payload.callId !== undefined) return undefined;
    return { kind: 'reply', conversationId: payload.conversationId };
  }
  if (event.taskId === null) return undefined;
  if (event.kind === 'approval.requested') return { kind: 'approval', taskId: event.taskId };
  if (event.kind === 'task.failed') return { kind: 'failure', taskId: event.taskId };
  return undefined;
}

/** May a notice of `kind` go out at `now`? */
export function noticeAllowed(kind: NoticeKind, config: NotificationsConfig, now: Date): 'yes' | 'off' | 'quiet' {
  const on = kind === 'reply' ? config.replies : kind === 'approval' ? config.approvals : config.failures;
  if (!on) return 'off';
  return inQuiet(now, config.quiet) ? 'quiet' : 'yes';
}

/**
 * The last notice pushed, which the service worker asks for when an empty
 * push arrives (GET /api/notifications/latest): in memory, forgotten after
 * `keepMs` (the push of a notice lives an hour at most at the push service).
 */
export interface NoticeBoard {
  record(notice: Notice): void;
  latest(): Notice | undefined;
}

export function createNoticeBoard(options: { now?: () => number; keepMs?: number } = {}): NoticeBoard {
  const now = options.now ?? Date.now;
  const keepMs = options.keepMs ?? 3_600_000;
  let last: { notice: Notice; at: number } | undefined;
  return {
    record(notice) {
      last = { notice: { kind: notice.kind, conversationId: notice.conversationId }, at: now() };
    },
    latest() {
      if (last === undefined || now() - last.at > keepMs) return undefined;
      return { ...last.notice };
    },
  };
}

/** The conversation of a task, or null when it has none. */
export async function conversationOfTask(sql: Queryable, taskId: string): Promise<string | null> {
  const [row] = await sql<{ conversationId: string | null }[]>`SELECT conversation_id::text AS "conversationId" FROM tasks WHERE id = ${taskId}`;
  return row?.conversationId ?? null;
}

export interface NotifierOptions {
  /** `[notifications]` now: read at each event, a change applies at once. */
  settings: () => NotificationsConfig;
  conversationOf: (taskId: string) => Promise<string | null>;
  /** Pages of the chat in view now: with any, no push (the user is looking). */
  visiblePages: () => number;
  /** To every open page: each decides whether to show it. */
  broadcast: (notice: Notice & { kind: NoticeKind }) => void;
  /** The push of the moment, read at each event: undefined without `[voice.push]`. */
  push: () => ((kind: PushKind) => Promise<unknown>) | undefined;
  board: NoticeBoard;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface Notifier {
  /** For the live feed: events only, from now on. */
  subscriber: Subscriber;
  handle(event: Pick<PublicEvent, 'kind' | 'taskId' | 'payload'>): Promise<NoticeOutcome>;
}

export function createNotifier(options: NotifierOptions): Notifier {
  const now = options.now ?? (() => new Date());

  async function handle(event: Pick<PublicEvent, 'kind' | 'taskId' | 'payload'>): Promise<NoticeOutcome> {
    const found = noticeOf(event);
    if (found === undefined) return 'none';
    const verdict = noticeAllowed(found.kind, options.settings(), now());
    if (verdict !== 'yes') return verdict;
    const conversationId = found.conversationId ?? (found.taskId === undefined ? null : await options.conversationOf(found.taskId));
    // A task without a conversation (the inbox sorting at start-up) does not notify: nothing to open, and many at once with the model off.
    if (conversationId === null) return 'none';
    const notice = { kind: found.kind, conversationId };
    options.broadcast(notice);
    const push = options.push();
    if (push === undefined || options.visiblePages() > 0) return 'pages';
    // Recorded before the push: the service worker asks for it as soon as the push arrives.
    options.board.record(notice);
    await push(found.kind);
    return 'push';
  }

  return {
    subscriber: {
      send(message: LiveMessage) {
        if (message.type !== 'event') return;
        handle(message.event).catch((error: unknown) => options.onError?.(error));
      },
    },
    handle,
  };
}

import { createContext, isAtMost, scanText, type Context, type Label } from '@arianna/policy';

import { loadApproval } from '../approvals.ts';
import { ChatError, loadMessage, writeConversation, writeUserMessage } from '../conversations.ts';
import type { Queryable, Sql } from '../db/client.ts';
import { recordDecisionIn } from '../engine.ts';
import { appendEvent } from '../events.ts';
import { isIncognitoTask } from '../incognito.ts';
import { errorCode } from '../jobs.ts';
import type { LiveFeed, LiveMessage, PublicEvent } from '../live.ts';
import { loadTask } from '../tasks.ts';
import { TelegramApiError, type BotApi, type InlineButton } from './api.ts';
import { passToTelegram, splitCleared, type ClearedText, type Fragment } from './outgoing.ts';
import { approvalNotice, scannerRefusal, TEXTS } from './texts.ts';
import { decodeDecision, encodeDecision, isAllowed, parseUpdates, type Update } from './updates.ts';

/**
 * The Telegram channel (task 1.15, D-044). Telegram is a cloud destination:
 * it receives at most L1, through the gateway, and anything above becomes a
 * notice that points to the web chat.
 *
 * - In: long polling. Messages from the user's private chats go to the work
 *   conversation the bot is bound to, like messages from the web chat; button
 *   presses decide approvals. The update offset is saved in the same
 *   transaction as the effect: an update is handled once.
 * - Out: the event log, read in order from a cursor. Each approval request
 *   becomes a notice with buttons (no detail); the final reply to a task
 *   started from Telegram is sent back. A notice may repeat after a crash,
 *   never go missing.
 */
export interface TelegramOptions {
  sql: Sql;
  api: BotApi;
  /** `telegram.chats` of arianna.toml. */
  chats: readonly number[];
  live: LiveFeed;
  /** Seconds a getUpdates call waits for news; default 50. */
  pollSeconds?: number;
  /** First pause after a failure, doubled up to a minute; default 2 s. */
  retryMs?: number;
  /**
   * Failures of one update or event, other than Telegram being unreachable,
   * before it is skipped with a `telegram.failed` event; default 10. Without
   * a limit, one that always fails would stop every one after it.
   */
  maxAttempts?: number;
  /** Errors are reported here: class and code only, they may hold data. */
  onError?: (error: unknown) => void;
}

export interface TelegramChannel {
  /** The work conversation the bot writes to. */
  readonly conversationId: string;
  close(): Promise<void>;
}

const MAX_RETRY_MS = 60_000;
/** At most one `telegram.ignored` event per minute: strangers cannot fill the log. */
const IGNORED_EVENT_MS = 60_000;

type ButtonOutcome = 'approved' | 'rejected' | 'decided' | 'web-only' | 'unknown';

const BUTTON_ANSWERS: Record<ButtonOutcome, string> = {
  approved: TEXTS.approved,
  rejected: TEXTS.rejected,
  decided: TEXTS.alreadyDecided,
  'web-only': TEXTS.webOnly,
  unknown: TEXTS.unknown,
};

interface State {
  conversationId: string;
  updateOffset: number;
  /** No update for two days: Telegram may have restarted its ids lower (telegram_offset_stale). */
  stale: boolean;
  eventCursor: string;
}

async function loadState(sql: Queryable): Promise<State | undefined> {
  const [row] = await sql<State[]>`
    SELECT conversation_id::text AS "conversationId", update_offset::float8 AS "updateOffset",
      telegram_offset_stale(last_update_at) AS stale, event_cursor::text AS "eventCursor"
    FROM telegram_state`;
  return row;
}

/**
 * The state of the channel, created on first start: a new work conversation
 * and a cursor at the last event, so that old requests are not sent again.
 * One transaction under a lock: no empty conversation is left behind.
 */
export async function ensureTelegramState(sql: Sql): Promise<State> {
  return sql.begin(async (tx) => {
    await tx`LOCK TABLE telegram_state IN SHARE ROW EXCLUSIVE MODE`;
    const existing = await loadState(tx);
    if (existing !== undefined) return existing;
    const conversation = await writeConversation(tx, { mode: 'work' });
    await tx`
      INSERT INTO telegram_state (conversation_id, event_cursor)
      VALUES (${conversation.id}, (SELECT coalesce(max(id), 0) FROM events))`;
    const state = await loadState(tx);
    if (state === undefined) throw new Error('telegram_state is missing');
    return state;
  });
}

/**
 * Moves the offset past `updateId`; false if it was already past (handled
 * before). After two quiet days any id is new, even a lower one.
 */
async function claimUpdate(tx: Queryable, updateId: number): Promise<boolean> {
  const rows = await tx`
    UPDATE telegram_state SET update_offset = ${updateId + 1}, last_update_at = now()
    WHERE update_offset <= ${updateId} OR telegram_offset_stale(last_update_at)
    RETURNING 1`;
  return rows.length === 1;
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

/** A context for texts the channel writes itself: they have read only `label`. */
function noticeContext(label: Label): Context {
  return createContext('L1', label);
}

export async function startTelegram(options: TelegramOptions): Promise<TelegramChannel> {
  const { sql, api, chats } = options;
  const pollSeconds = options.pollSeconds ?? 50;
  const retryMs = options.retryMs ?? 2_000;
  const maxAttempts = options.maxAttempts ?? 10;
  const report = (error: unknown): void => options.onError?.(error);
  const state = await ensureTelegramState(sql);
  const conversationId = state.conversationId;
  const controller = new AbortController();
  const { signal } = controller;
  // A function, not the property: the loops' conditions would narrow it to false.
  const stopped = (): boolean => signal.aborted;

  // ---- sending ------------------------------------------------------------

  /** A fixed text (L0) to one chat. Not retried: these answer a single action. */
  async function sendFixed(chatId: number, text: string, taskId?: string): Promise<void> {
    const passed = await passToTelegram(sql, [{ text, label: 'L0', source: 'telegram:fixed' }], noticeContext('L0'), {
      ...(taskId === undefined ? {} : { taskId }),
      summary: 'fixed text',
    });
    if (!passed.ok) return;
    for (const piece of passed.texts.flatMap((cleared) => splitCleared(cleared))) await api.sendMessage(chatId, piece, undefined, signal);
  }

  /** Answers a button press; a failure is reported and does not stop what follows. */
  async function answer(callbackId: string, text?: string): Promise<void> {
    try {
      const passed =
        text === undefined
          ? undefined
          : await passToTelegram(sql, [{ text, label: 'L0', source: 'telegram:fixed' }], noticeContext('L0'), { summary: 'button answer' });
      await api.answerCallbackQuery(callbackId, passed?.ok === true ? passed.texts[0] : undefined, signal);
    } catch (error) {
      report(error);
    }
  }

  /**
   * Runs `send` for every chat. A chat Telegram refuses (4xx: the user blocked
   * the bot, a wrong id) is reported and skipped: the others still get it.
   */
  async function eachChat(send: (chatId: number) => Promise<void>): Promise<void> {
    for (const chatId of chats) {
      try {
        await send(chatId);
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.transient) throw error;
        report(error);
      }
    }
  }

  async function sendToAll(texts: readonly ClearedText[], buttons?: readonly (readonly InlineButton[])[]): Promise<void> {
    const pieces = texts.flatMap((cleared) => splitCleared(cleared));
    await eachChat(async (chatId) => {
      for (const [index, piece] of pieces.entries()) {
        // Buttons go on the last piece, under the whole text.
        await api.sendMessage(chatId, piece, index === pieces.length - 1 ? buttons : undefined, signal);
      }
    });
  }

  // ---- in: updates --------------------------------------------------------

  let lastIgnoredEvent = 0;
  async function ignore(update: Update): Promise<void> {
    await sql.begin(async (tx) => {
      if (!(await claimUpdate(tx, update.updateId))) return;
      if (update.kind === 'other' || Date.now() - lastIgnoredEvent < IGNORED_EVENT_MS) return;
      // No ids and no content: whoever wrote is not the user.
      await appendEvent(tx, { kind: 'telegram.ignored', label: 'L0', payload: { update: update.kind } });
      lastIgnoredEvent = Date.now();
    });
  }

  /** An update that keeps failing is skipped, with only an error code in the log. */
  async function skipUpdate(updateId: number, error: unknown): Promise<void> {
    await sql.begin(async (tx) => {
      if (!(await claimUpdate(tx, updateId))) return;
      await appendEvent(tx, { kind: 'telegram.failed', label: 'L0', payload: { stage: 'update', code: errorCode(error) } });
    });
  }

  /** Runs `effect` with the claim of the update; false if handled before. */
  async function once(updateId: number, effect: (tx: Queryable) => Promise<void> = () => Promise.resolve()): Promise<boolean> {
    return sql.begin(async (tx) => {
      if (!(await claimUpdate(tx, updateId))) return false;
      await effect(tx);
      return true;
    });
  }

  async function onMessage(update: Extract<Update, { kind: 'message' }>): Promise<void> {
    const { chatId, text } = update;
    if (text === undefined || text.startsWith('/')) {
      // Commands and non-text messages start no task.
      if (await once(update.updateId)) await sendFixed(chatId, text === undefined ? TEXTS.notText : TEXTS.start);
      return;
    }
    try {
      await once(update.updateId, async (tx) => {
        await writeUserMessage(tx, conversationId, text, { channel: 'telegram' });
      });
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      // Refused (scanner, empty, too long): the update is handled, with a fixed answer.
      if (!(await once(update.updateId))) return;
      const kinds = [...new Set(scanText(text).map((finding) => finding.kind))];
      await sendFixed(chatId, error.code === 'scanner' && kinds.length > 0 ? scannerRefusal(kinds) : TEXTS.invalid);
    }
  }

  async function onCallback(update: Extract<Update, { kind: 'callback' }>): Promise<void> {
    const decision = decodeDecision(update.data);
    const result: { outcome: ButtonOutcome } = { outcome: 'unknown' };
    const handled = await once(update.updateId, async (tx) => {
      if (decision === undefined) return;
      const approval = await loadApproval(tx, decision.approvalId);
      if (approval === undefined) return;
      if (approval.kind === 'declassify' || approval.kind === 'commitment') result.outcome = 'web-only';
      else if (approval.state !== 'pending') result.outcome = 'decided';
      else {
        await recordDecisionIn(tx, approval.id, decision.state, 'telegram');
        result.outcome = decision.state;
      }
    });
    // Handled before (a repeated press, a restart): stop the spinner on the phone anyway.
    if (!handled) {
      await answer(update.callbackId);
      return;
    }
    const { outcome } = result;
    await answer(update.callbackId, BUTTON_ANSWERS[outcome]);
    if ((outcome === 'approved' || outcome === 'rejected' || outcome === 'decided') && update.chatId !== undefined && update.messageId !== undefined) {
      await api.removeButtons(update.chatId, update.messageId, signal);
    }
  }

  async function handleUpdate(update: Update): Promise<void> {
    if (!isAllowed(update, chats)) {
      await ignore(update);
      return;
    }
    if (update.kind === 'message') await onMessage(update);
    else if (update.kind === 'callback') await onCallback(update);
  }

  const updateFailures = new Map<number, number>();
  async function poll(): Promise<void> {
    let pause = retryMs;
    while (!signal.aborted) {
      try {
        const current = await loadState(sql);
        // After two quiet days nothing old is left on Telegram's side, and new ids may be lower.
        const offset = current === undefined || current.stale ? 0 : current.updateOffset;
        const raw = await api.getUpdates(offset, pollSeconds, signal);
        for (const update of parseUpdates(raw)) {
          if (stopped()) return;
          try {
            await handleUpdate(update);
            updateFailures.delete(update.updateId);
          } catch (error) {
            // The effect is saved; only the answer to the user may be missing.
            if (error instanceof TelegramApiError) {
              report(error);
              continue;
            }
            const failures = (updateFailures.get(update.updateId) ?? 0) + 1;
            if (failures < maxAttempts) {
              updateFailures.set(update.updateId, failures);
              throw error;
            }
            report(error);
            updateFailures.delete(update.updateId);
            await skipUpdate(update.updateId, error);
          }
        }
        pause = retryMs;
      } catch (error) {
        if (stopped()) return;
        report(error);
        const wait = error instanceof TelegramApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : pause;
        await sleep(Math.min(wait, MAX_RETRY_MS), signal);
        pause = Math.min(pause * 2, MAX_RETRY_MS);
      }
    }
  }

  // ---- out: events --------------------------------------------------------

  async function approvalRequested(event: PublicEvent): Promise<void> {
    const payload = event.payload as { approvalId?: unknown } | null;
    const approval = typeof payload?.approvalId === 'string' ? await loadApproval(sql, payload.approvalId) : undefined;
    // Decided meanwhile (from the web): nothing to ask.
    if (approval?.state !== 'pending') return;
    // An incognito conversation never reaches Telegram, not even as a notice without content (D-136).
    if (approval.taskId !== null && (await isIncognitoTask(sql, approval.taskId))) return;
    const task = approval.taskId === null ? undefined : await loadTask(sql, approval.taskId);
    // The title comes from the user's message: shown only when the task is at most L1.
    // The detail is never shown, whatever its label: it is read in the web chat.
    const title = task !== undefined && isAtMost(task.label, 'L1') ? task.title : undefined;
    // A declassification and a commitment of the secretary (D-144) are decided in the web chat only.
    const buttons = approval.kind === 'declassify' || approval.kind === 'commitment' ? undefined : (['approved', 'rejected'] as const);

    // The notice is written by the channel from the approval's metadata and the
    // title: its context has read the title's label only, not the whole task.
    const attempt = async (withTitle: boolean): Promise<boolean> => {
      const label: Label = withTitle && task !== undefined ? task.label : 'L0';
      const fragments: Fragment[] = [
        { text: approvalNotice(approval.kind, approval.action, withTitle ? title : undefined), label, source: `approval:${approval.id}` },
        ...(buttons === undefined ? [] : [TEXTS.approve, TEXTS.reject].map((text): Fragment => ({ text, label: 'L0', source: 'telegram:fixed' }))),
      ];
      const passed = await passToTelegram(sql, fragments, noticeContext(label), {
        ...(approval.taskId === null ? {} : { taskId: approval.taskId }),
        summary: 'approval notice',
      });
      if (!passed.ok) return false;
      const [text, approve, reject] = passed.texts;
      if (text === undefined) return false;
      const row =
        buttons === undefined || approve === undefined || reject === undefined
          ? undefined
          : [
              { text: approve, data: encodeDecision(approval.id, 'approved') },
              { text: reject, data: encodeDecision(approval.id, 'rejected') },
            ];
      await sendToAll([text], row === undefined ? undefined : [row]);
      return true;
    };
    // A title the gateway refuses is dropped; the request itself still reaches the phone.
    if (title !== undefined && (await attempt(true))) return;
    if (await attempt(false)) return;
    await sendFixedToAll(TEXTS.approvalReference, approval.taskId ?? undefined);
  }

  async function sendFixedToAll(text: string, taskId?: string): Promise<void> {
    await eachChat((chatId) => sendFixed(chatId, text, taskId));
  }

  async function replyCreated(event: PublicEvent): Promise<void> {
    const payload = event.payload as { conversationId?: unknown; messageId?: unknown; role?: unknown } | null;
    if (payload?.role !== 'assistant' || payload.conversationId !== conversationId || typeof payload.messageId !== 'string') return;
    const message = await loadMessage(sql, payload.messageId);
    if (message === undefined || message.taskId === null) return;
    // The report of a delegated agent (the Coder) is for the web chat: Arianna answers after it.
    if (message.agent !== null) return;
    // Only the answer to a message written on Telegram goes back there.
    const [fromTelegram] = await sql`
      SELECT 1 FROM messages WHERE task_id = ${message.taskId} AND role = 'user' AND channel = 'telegram' LIMIT 1`;
    if (fromTelegram === undefined) return;
    const task = await loadTask(sql, message.taskId);
    if (task === undefined) return;
    // The reply was written in the task's context: the gateway judges it there.
    const passed = await passToTelegram(
      sql,
      [{ text: message.body, label: message.label, source: `message:${message.id}` }],
      createContext(task.clearance, task.effectiveLabel),
      { taskId: task.id, summary: 'chat reply' },
    );
    // Every listed chat is the user's own (D-044): the reply goes to all of them.
    if (passed.ok) await sendToAll(passed.texts);
    else await sendFixedToAll(TEXTS.replyReference, task.id);
  }

  async function handleEvent(event: PublicEvent): Promise<void> {
    if (event.kind === 'approval.requested') await approvalRequested(event);
    else if (event.kind === 'message.created') await replyCreated(event);
  }

  // Events arrive in order from the live feed; they are handled one at a time.
  const queue: PublicEvent[] = [];
  const arrived = new EventTarget();
  const subscriber = {
    send(message: LiveMessage): void {
      if (message.type !== 'event') return;
      queue.push(message.event);
      arrived.dispatchEvent(new Event('event'));
    },
  };

  function nextArrival(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        arrived.removeEventListener('event', done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      arrived.addEventListener('event', done);
      signal.addEventListener('abort', done);
    });
  }

  async function advanceCursor(event: PublicEvent, failure?: unknown): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`UPDATE telegram_state SET event_cursor = ${event.id}::bigint WHERE event_cursor < ${event.id}::bigint`;
      if (failure !== undefined) {
        await appendEvent(tx, { kind: 'telegram.failed', label: 'L0', payload: { stage: 'event', eventId: event.id, code: errorCode(failure) } });
      }
    });
  }

  async function deliver(): Promise<void> {
    let pause = retryMs;
    let failures = 0;
    while (!signal.aborted) {
      const event = queue[0];
      if (event === undefined) {
        await nextArrival();
        continue;
      }
      try {
        let skipped: unknown;
        try {
          await handleEvent(event);
        } catch (error) {
          // A request Telegram refuses (4xx) would be refused again: move on.
          // Telegram unreachable: wait as long as it takes. Anything else: a few tries.
          if (error instanceof TelegramApiError ? error.transient : failures + 1 < maxAttempts) throw error;
          report(error);
          if (!(error instanceof TelegramApiError)) skipped = error;
        }
        await advanceCursor(event, skipped);
        queue.shift();
        pause = retryMs;
        failures = 0;
      } catch (error) {
        if (!(error instanceof TelegramApiError)) failures += 1;
        // Telegram, the network or the database is down: the same event again later.
        if (stopped()) return;
        report(error);
        const wait = error instanceof TelegramApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : pause;
        await sleep(Math.min(wait, MAX_RETRY_MS), signal);
        pause = Math.min(pause * 2, MAX_RETRY_MS);
      }
    }
  }

  const unsubscribe = await options.live.subscribe(subscriber, state.eventCursor);
  const loops = [poll(), deliver()].map((loop) => loop.catch(report));

  return {
    conversationId,
    async close() {
      controller.abort();
      unsubscribe();
      await Promise.all(loops);
    },
  };
}

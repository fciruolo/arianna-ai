import { randomBytes, timingSafeEqual } from 'node:crypto';

import { VOICE_ALIAS, type VoiceConfig } from '@arianna/config';
import type { LocalModel } from '@arianna/executors';
import { createContext, isAtMost, labelForUserMessage, maxLabel, scanText, type Label } from '@arianna/policy';

import { ChatError, checkMessageBody, isUuid, listMessages, loadConversation, loadMessage, postUserMessage, taskTitle, type Conversation, type Message } from '../conversations.ts';
import type { Queryable, Sql } from '../db/client.ts';
import { appendEvent } from '../events.ts';
import { passGateway } from '../gateway.ts';
import { ORCHESTRATOR_EXECUTOR } from '../orchestrator/orchestrator.ts';
import { loadTask } from '../tasks.ts';
import { FAILED_TEXT, OUTGOING_TEXT } from './outgoing.ts';
import type { VoiceService } from './service.ts';
import type { TrialModel } from './trial.ts';
import { CALL_TEXT, callReadiness, cleanTranscript, delegationRequest, HISTORY_FETCH, MAX_REPLY_TOKENS, opensDelegation, sentenceSplitter, speakable, summaryToSay, voicePrompt } from './turns.ts';

/**
 * Calls from the web chat (D-066): the page sends its WebRTC offer here, the
 * core opens the call on apps/voice and gives back the answer. Every turn of
 * the call comes back to the core, which stores what was said in the
 * conversation (channel 'voice'), asks the model of the `voice` role through
 * the gateway and decides on delegations. The voice holds a token valid for
 * this call only.
 */
export type CallStatus = 'scheduled' | 'ringing' | 'connecting' | 'active' | 'ended' | 'missed' | 'skipped' | 'failed';
export type CallEndReason = 'hangup' | 'time-limit' | 'disconnected' | 'voice-error' | 'core-restart' | 'no-answer' | 'quiet-hours' | 'daily-limit' | 'cancelled';

export interface Call {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  reason: 'waiting' | 'task-done' | 'scheduled' | null;
  taskId: string | null;
  status: CallStatus;
  scheduledAt: Date | null;
  createdAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  endReason: CallEndReason | null;
  delegations: number;
}

export type CallErrorCode = 'not-found' | 'invalid' | 'archived' | 'busy' | 'voice-off' | 'not-ready' | 'unauthorized' | 'ended';

export class CallError extends Error {
  override name = 'CallError';
  readonly code: CallErrorCode;

  constructor(code: CallErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const CALL_COLUMNS = `id::text, conversation_id::text AS "conversationId", direction, reason, task_id::text AS "taskId", status,
  scheduled_at AS "scheduledAt", created_at AS "createdAt", answered_at AS "answeredAt", ended_at AS "endedAt",
  end_reason AS "endReason", delegations`;

const LIVE: readonly CallStatus[] = ['ringing', 'connecting', 'active'];
/** How long the voice may take to open a call: the first one loads the models (GBs). */
const OPEN_TIMEOUT_MS = 180_000;
/** Past the limit, the time the voice has to say goodbye before the core closes the call itself. */
const LIMIT_GRACE_MS = 30_000;

export async function loadCall(sql: Queryable, id: string): Promise<Call | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await sql.unsafe<Call[]>(`SELECT ${CALL_COLUMNS} FROM calls WHERE id = $1`, [id]);
  return row;
}

/** The calls of a conversation, oldest first: the chat shows them as receipts. */
export async function listCalls(sql: Queryable, conversationId: string): Promise<Call[]> {
  return [...(await sql.unsafe<Call[]>(`SELECT ${CALL_COLUMNS} FROM calls WHERE conversation_id = $1 ORDER BY created_at LIMIT 200`, [conversationId]))];
}

/** The call in progress on this machine, if any. */
export async function liveCall(sql: Queryable): Promise<Call | undefined> {
  const [row] = await sql.unsafe<Call[]>(`SELECT ${CALL_COLUMNS} FROM calls WHERE status = ANY($1::text[])`, [LIVE]);
  return row;
}

export interface CallsOptions {
  sql: Sql;
  /** `hold`, from the switch of the core, keeps the service in place from the check of its state to the row of a new call. */
  voice: Pick<VoiceService, 'state' | 'request'> & { hold?: <T>(work: () => Promise<T>) => Promise<T> };
  /** Read at each call: roles, limits and local servers of the current configuration. */
  config: () => { roles: { voice?: string }; voice: VoiceConfig; local: { endpoints: readonly { models: Record<string, string> }[] } };
  candidates: () => TrialModel[];
  model: () => LocalModel;
  /** Where the voice reaches the core back, on loopback. */
  coreUrl: string;
  onError?: (error: unknown) => void;
  /** Tests shorten the waits. */
  pollMs?: number;
}

export interface Calls {
  /** The user calls from a conversation: the WebRTC answer for the page. */
  start(conversationId: string, offer: { sdp: string; type: string }): Promise<{ call: Call; answer: { sdp: string; type: string } }>;
  /** A turn of the call: the voice sends what the user said, the core answers what to say ('' when superseded). */
  turn(callId: string, token: string | undefined, text: unknown): Promise<{ say: string }>;
  /**
   * The same turn, one sentence at a time while the model writes (D-070).
   * Returning the iterator early (the voice hung up the request) stops the model.
   */
  turnStream(callId: string, token: string | undefined, text: unknown): AsyncIterableIterator<{ say: string }>;
  /** The user answers a call of Arianna that is ringing: the WebRTC answer for the page. */
  answer(callId: string, offer: { sdp: string; type: string }): Promise<{ call: Call; answer: { sdp: string; type: string } }>;
  /** The user declines a call of Arianna: it is missed, and she writes instead. */
  decline(callId: string): Promise<Call>;
  /** The page hangs up, or the voice reports the end. */
  end(callId: string, reason: CallEndReason, token?: string): Promise<Call>;
  /** At start: a call left open by a core that stopped is closed. */
  closeLeftovers(): Promise<number>;
  /** At shutdown: the calls in progress end as `core-restart`. */
  close(): Promise<void>;
  /** A read only: true while a call is in progress (D-107 E: its model stays in memory between turns). */
  active(): boolean;
}

interface Session {
  token: Buffer;
  conversationId: string;
  timer: NodeJS.Timeout | undefined;
  delegations: number;
  /** Turns run one at a time, in order. */
  chain: Promise<unknown>;
  /** The number of the latest turn: an older one still at work is superseded. */
  latest: number;
  /** Stops the model of the turn at work, when a newer one comes. */
  stop: AbortController | undefined;
  /** The first message the voice reads (D-072): every turn starts from it, so the prompt only grows. */
  anchor: string | undefined;
  /** Stops the warm-up of the prompt when the first turn comes. */
  warming: AbortController | undefined;
}

function tokenMatches(session: Session, token: string | undefined): boolean {
  if (token === undefined) return false;
  const given = Buffer.from(token);
  return given.length === session.token.length && timingSafeEqual(given, session.token);
}

/** A written note of Arianna in the conversation: fixed L0 text, through the gateway to the web chat. */
export async function writeNote(sql: Sql, conversationId: string, text: string, callId: string): Promise<void> {
  const decision = await passGateway(sql, [{ value: text, label: 'L0', source: `call:${callId}` }], createContext('L0'), { kind: 'channel', id: 'web' });
  const [allowed] = decision.decision === 'allow' ? decision.texts : [];
  if (allowed === undefined) return;
  await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO messages (conversation_id, role, channel, label, body)
      VALUES (${conversationId}, 'assistant', 'web', 'L0', ${allowed}) RETURNING id::text`;
    if (row === undefined) throw new Error('INSERT INTO messages returned no row');
    await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId, messageId: row.id, role: 'assistant', callId } });
  });
}

export function createCalls(options: CallsOptions): Calls {
  const { sql } = options;
  const sessions = new Map<string, Session>();
  const pollMs = options.pollMs ?? 2000;
  const hold = <T>(work: () => Promise<T>): Promise<T> => (options.voice.hold === undefined ? work() : options.voice.hold(work));

  async function finish(callId: string, status: CallStatus, reason: CallEndReason): Promise<Call> {
    const session = sessions.get(callId);
    if (session !== undefined) clearTimeout(session.timer);
    // Hanging up during the greeting or a reply frees the model at once.
    session?.warming?.abort();
    session?.stop?.abort();
    sessions.delete(callId);
    const call = await sql.begin(async (tx) => {
      const [row] = await tx.unsafe<Call[]>(
        `UPDATE calls SET status = $2, end_reason = $3, ended_at = now()
         WHERE id = $1 AND status = ANY($4::text[]) RETURNING ${CALL_COLUMNS}`,
        [callId, status, reason, LIVE],
      );
      if (row === undefined) return undefined;
      await appendEvent(tx, { kind: 'call.ended', label: 'L0', payload: { callId, conversationId: row.conversationId, status, reason } });
      return row;
    });
    if (call === undefined) {
      const current = await loadCall(sql, callId);
      if (current === undefined) throw new CallError('not-found', 'no such call');
      return current;
    }
    // The voice may already be gone: closing it is best effort.
    options.voice.request('DELETE', `/calls/${callId}`, { timeoutMs: 5000 }).catch(() => undefined);
    // D-074: outside a call the model of the calls only takes memory the orchestrator needs;
    // the next call loads it again while Arianna greets (D-072).
    if (session !== undefined && sessions.size === 0) void unloadVoiceModel();
    return call;
  }

  /** The unload in flight: the next call waits for it before asking the model, so the two never cross on oMLX. */
  let unloading: Promise<void> | undefined;
  function unloadVoiceModel(): Promise<void> {
    const work = (async () => {
      try {
        await options.model().unload?.(VOICE_ALIAS);
      } catch (error) {
        options.onError?.(error);
      }
    })();
    unloading = work;
    void work.finally(() => {
      if (unloading === work) unloading = undefined;
    });
    return work;
  }

  /** Something to say outside a turn (the end of a delegation): through the gateway towards the call, like a reply. */
  async function say(callId: string, text: string, label: Label = 'L0'): Promise<void> {
    const session = sessions.get(callId);
    if (session === undefined) return;
    const conversation = await loadConversation(sql, session.conversationId);
    if (conversation === undefined) return;
    const stored = maxLabel(label, conversation.effectiveLabel);
    const decision = await passGateway(sql, [{ value: text, label: stored, source: `call:${callId}` }], createContext(conversation.clearance, stored), { kind: 'channel', id: 'voice' });
    const [allowed] = decision.decision === 'allow' ? decision.texts : [];
    if (allowed === undefined) return;
    const answer = await options.voice.request('POST', `/calls/${callId}/say`, { json: { text: allowed }, timeoutMs: 10_000 });
    if (answer.status !== 200) throw new CallError('ended', 'the voice did not take the text');
  }

  /** Waits for the delegated task; within the time, its answer is said in the call. */
  async function follow(callId: string, taskId: string, seconds: number): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && sessions.has(callId)) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const task = await loadTask(sql, taskId);
      if (task === undefined) return;
      if (task.status === 'done') {
        const [row] = await sql<{ id: string }[]>`
          SELECT id::text FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id DESC LIMIT 1`;
        const message = row === undefined ? undefined : await loadMessage(sql, row.id);
        if (message !== undefined) await say(callId, summaryToSay(message.body), message.label);
        return;
      }
      if (task.status === 'failed' || task.status === 'waiting_user') {
        await say(callId, task.status === 'failed' ? CALL_TEXT.taskFailed : CALL_TEXT.taskWaiting);
        return;
      }
    }
    if (sessions.has(callId)) await say(callId, CALL_TEXT.stillWorking);
  }

  async function storeUserTurn(call: Call, text: string, clearance: Label): Promise<Message> {
    const label = labelForUserMessage(createContext(clearance));
    return sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO messages (conversation_id, role, channel, label, body)
        VALUES (${call.conversationId}, 'user', 'voice', ${label}::privacy_label, ${text})
        RETURNING id::text`;
      if (row === undefined) throw new Error('INSERT INTO messages returned no row');
      await tx`UPDATE conversations SET title = ${taskTitle(text).replace(/\s+/g, ' ')} WHERE id = ${call.conversationId} AND title IS NULL`;
      await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId: call.conversationId, messageId: row.id, role: 'user', callId: call.id } });
      const message = await loadMessage(tx, row.id);
      if (message === undefined) throw new Error('the new message is missing');
      return message;
    });
  }

  /** Text towards the call (local) goes through the gateway first: what it allows, or undefined. */
  async function allowSpoken(call: Call, text: string, label: Label, clearance: Label, effective: Label): Promise<string | undefined> {
    const stored = maxLabel(label, effective);
    if (!isAtMost(stored, clearance)) return undefined;
    const decision = await passGateway(sql, [{ value: text, label: stored, source: `call:${call.id}` }], createContext(clearance, effective), { kind: 'channel', id: 'voice' });
    if (decision.decision === 'block') return undefined;
    return decision.texts[0];
  }

  /** The reply goes through the gateway towards the call (local), then into the history. */
  async function storeReply(call: Call, text: string, label: Label, clearance: Label, effective: Label): Promise<boolean> {
    const allowed = await allowSpoken(call, text, label, clearance, effective);
    if (allowed === undefined) return false;
    await insertReply(call, allowed, maxLabel(label, effective));
    return true;
  }

  /** What was said in the call, already through the gateway, into the history. */
  async function insertReply(call: Call, allowed: string, stored: Label): Promise<void> {
    await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO messages (conversation_id, role, channel, label, body)
        VALUES (${call.conversationId}, 'assistant', 'voice', ${stored}::privacy_label, ${allowed})
        RETURNING id::text`;
      if (row === undefined) throw new Error('INSERT INTO messages returned no row');
      await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId: call.conversationId, messageId: row.id, role: 'assistant', callId: call.id } });
    });
  }

  /**
   * What the voice model reads: the anchored window (D-072), allowed by the
   * gateway like the orchestrator does; undefined when the gateway blocks it.
   */
  async function readPrompt(call: Call, conversation: Conversation, session: Session) {
    const prompt = voicePrompt(await listMessages(sql, call.conversationId, { limit: HISTORY_FETCH }), conversation.effectiveLabel, session.anchor);
    const effective = maxLabel(conversation.effectiveLabel, prompt.label);
    const decision = await passGateway(
      sql,
      prompt.messages.map((part) => ({ value: part.content, label: part.label, source: `call:${call.id}` })),
      createContext(conversation.clearance, effective),
      { kind: 'executor', id: ORCHESTRATOR_EXECUTOR, locality: 'local' },
    );
    if (decision.decision === 'block' || decision.texts.length !== prompt.messages.length) return undefined;
    const allowed = prompt.messages.map((part, index) => ({ role: part.role, content: decision.texts[index] ?? '' }));
    return { prompt, effective, allowed };
  }

  /**
   * While the greeting is said, the model reads the window once (one token,
   * thrown away): oMLX keeps its prefix, and the first turn reads only the
   * new words (D-072). Best effort: the first turn stops it if still at work.
   */
  async function warm(callId: string, session: Session): Promise<void> {
    const call = await loadCall(sql, callId);
    if (call?.status !== 'active' || sessions.get(callId) !== session || session.latest > 0) return;
    const conversation = await loadConversation(sql, call.conversationId);
    if (conversation === undefined || conversation.archivedAt !== null) return;
    const read = await readPrompt(call, conversation, session);
    // A turn that came meanwhile has set its own anchor: the warm-up never moves it.
    if (session.latest > 0 || sessions.get(callId) !== session) return;
    session.anchor ??= read?.prompt.anchor;
    if (read === undefined) return;
    const stop = new AbortController();
    session.warming = stop;
    try {
      await unloading;
      await options.model().chat({ model: VOICE_ALIAS, messages: read.allowed, maxTokens: 1, temperature: 0, timeoutMs: 30_000, signal: stop.signal });
    } catch (error) {
      // Stopped by the first turn or the end of the call: expected, not an error.
      if (!stop.signal.aborted) throw error;
    } finally {
      if (session.warming === stop) session.warming = undefined;
    }
  }

  /**
   * One turn: store the words, ask the model through the gateway and say its
   * reply one sentence at a time as it is written (D-070), each through the
   * gateway towards the call; what was said goes into the history at the end.
   */
  async function runTurn(callId: string, session: Session, turn: number, words: string, emit: (say: string) => void, signal: AbortSignal): Promise<void> {
    const call = await loadCall(sql, callId);
    if (call?.status !== 'active') throw new CallError('ended', 'the call is over');
    const conversation = await loadConversation(sql, call.conversationId);
    if (conversation === undefined || conversation.archivedAt !== null) throw new CallError('ended', 'the conversation is gone');

    // A work conversation may go to the cloud later: no private data in it (as writeUserMessage).
    if (conversation.mode === 'work' && scanText(words).length > 0) {
      emit(CALL_TEXT.privateInWork);
      return;
    }
    await storeUserTurn(call, words, conversation.clearance);

    session.warming?.abort();
    const read = await readPrompt(call, conversation, session);
    if (read !== undefined) session.anchor = read.prompt.anchor;
    if (read === undefined) {
      emit(CALL_TEXT.cannotRead);
      return;
    }
    const { prompt, effective, allowed } = read;

    const label = maxLabel(prompt.label, effective);
    const canSay = isAtMost(label, conversation.clearance);
    const superseded = () => session.latest !== turn || signal.aborted;
    const stop = new AbortController();
    const spoken: string[] = [];
    /** The piece that opened a delegation and the ones after it. */
    const delegation: string[] = [];
    // speaking: piece by piece; delegating: a DELEGA line came, nothing more is said; blocked: the gateway stopped a piece.
    const flow: { state: 'speaking' | 'delegating' | 'blocked' } = { state: 'speaking' };
    // Read through a function: the state changes across awaits and callbacks.
    const state = () => flow.state;
    let saying: Promise<void> = Promise.resolve();
    const splitter = sentenceSplitter();

    const sayPiece = async (piece: string): Promise<void> => {
      if (state() !== 'speaking' || superseded()) return;
      const text = speakable(piece);
      if (text === '') return;
      const passed = await allowSpoken(call, text, prompt.label, conversation.clearance, effective);
      if (state() !== 'speaking' || superseded()) return;
      if (passed === undefined) {
        flow.state = 'blocked';
        stop.abort();
        emit(CALL_TEXT.notHere);
        return;
      }
      spoken.push(passed);
      emit(passed);
    };
    const take = (pieces: string[]): void => {
      for (const piece of pieces) {
        if (flow.state === 'speaking' && opensDelegation(piece)) flow.state = 'delegating';
        if (flow.state === 'delegating') delegation.push(piece);
        // Over the clearance nothing is said piece by piece: the end of the turn tells.
        if (flow.state === 'speaking' && canSay) saying = saying.then(() => sayPiece(piece));
      }
    };

    let reply: string | undefined;
    let failed = false;
    let streamed = false as boolean;
    try {
      await unloading;
      const result = await options.model().chat({
        model: VOICE_ALIAS,
        messages: allowed,
        maxTokens: MAX_REPLY_TOKENS,
        temperature: 0.4,
        timeoutMs: 30_000,
        signal: AbortSignal.any([signal, stop.signal]),
        onText: (piece) => {
          streamed = true;
          if (superseded()) {
            stop.abort();
            return;
          }
          take(splitter.push(piece));
        },
      });
      reply = result.text;
      // A model that does not stream gives it all at the end.
      if (!streamed) take(splitter.push(reply));
      take(splitter.end());
    } catch (error) {
      failed = true;
      if (!superseded() && state() !== 'blocked') options.onError?.(error);
    }
    await saying.catch((error: unknown) => options.onError?.(error));

    const keep = async (): Promise<void> => {
      if (spoken.length > 0) await insertReply(call, spoken.join(' '), label);
    };
    // The user spoke again, or the voice hung up the request: what was said stays in the history.
    if (superseded() || state() === 'blocked' || failed || reply === undefined) {
      await keep();
      if (failed && !superseded() && state() !== 'blocked' && spoken.length === 0) emit(CALL_TEXT.modelDown);
      return;
    }

    // Decided on the pieces as they would be said, so a DELEGA line is never spoken (D-070).
    const request = state() === 'delegating' ? delegationRequest(delegation) : '';
    if (request !== '') {
      await keep();
      const { voice } = options.config();
      if (session.delegations >= voice.limits.delegations) {
        emit(CALL_TEXT.tooMany);
        return;
      }
      let taskId: string;
      try {
        // Arianna's task in the same conversation, as if the user had written it.
        taskId = (await postUserMessage(sql, call.conversationId, request, { channel: 'voice' })).task.id;
      } catch (error) {
        if (error instanceof ChatError) {
          emit(error.code === 'scanner' ? CALL_TEXT.privateInWork : CALL_TEXT.cannotDelegate);
          return;
        }
        throw error;
      }
      session.delegations += 1;
      await sql`UPDATE calls SET delegations = delegations + 1 WHERE id = ${callId}`;
      follow(callId, taskId, voice.limits.delegationSeconds).catch((error: unknown) => options.onError?.(error));
      await storeReply(call, CALL_TEXT.delegated, 'L0', conversation.clearance, effective);
      emit(CALL_TEXT.delegated);
      return;
    }
    if (!canSay) {
      emit(CALL_TEXT.notHere);
      return;
    }
    if (spoken.length === 0) {
      emit(CALL_TEXT.notUnderstood);
      return;
    }
    await keep();
  }

  /** Opens the call on apps/voice with a token for this call; the limits start from the answer. */
  async function connect(call: Call, offer: { sdp: string; type: string }, greeting: string): Promise<{ call: Call; answer: { sdp: string; type: string } }> {
    const { voice, roles, local } = options.config();
    const ready = callReadiness(roles, options.candidates(), local.endpoints.some((endpoint) => VOICE_ALIAS in endpoint.models), voice.voice);
    if (!ready.ready) {
      await finish(call.id, 'failed', 'voice-error').catch(() => undefined);
      throw new CallError('not-ready', `assign and download: ${ready.missing.join(', ')}`);
    }
    const token = randomBytes(32).toString('base64url');
    const session: Session = { token: Buffer.from(token), conversationId: call.conversationId, timer: undefined, delegations: 0, chain: Promise.resolve(), latest: 0, stop: undefined, anchor: undefined, warming: undefined };
    sessions.set(call.id, session);
    try {
      const answer = await options.voice.request('POST', '/calls', {
        timeoutMs: OPEN_TIMEOUT_MS,
        json: {
          callId: call.id,
          token,
          coreUrl: options.coreUrl,
          sdp: offer.sdp,
          type: offer.type,
          stt: ready.stt,
          tts: ready.tts,
          voice: ready.voice,
          limits: { callSeconds: voice.limits.callMinutes * 60, warnSeconds: voice.limits.warnSeconds },
          texts: { greeting, warning: CALL_TEXT.warning, goodbye: CALL_TEXT.goodbye },
        },
      });
      const body = JSON.parse(answer.body.toString('utf8')) as { sdp?: unknown; type?: unknown };
      if (answer.status !== 200 || typeof body.sdp !== 'string' || body.type !== 'answer') throw new CallError('voice-off', 'the voice refused the call');
      // The voice counts the limit from the connection, which follows the answer:
      // the core closes the call itself only after the voice had time to say goodbye.
      session.timer = setTimeout(() => {
        finish(call.id, 'ended', 'time-limit').catch((error: unknown) => options.onError?.(error));
      }, voice.limits.callMinutes * 60_000 + LIMIT_GRACE_MS);
      session.timer.unref();
      const [active] = await sql.unsafe<Call[]>(
        `UPDATE calls SET status = 'active', answered_at = now() WHERE id = $1 AND status = 'connecting' RETURNING ${CALL_COLUMNS}`,
        [call.id],
      );
      // Only a help: a failure goes to the log of the core, never to the call.
      warm(call.id, session).catch((error: unknown) => options.onError?.(error));
      return { call: active ?? call, answer: { sdp: body.sdp, type: 'answer' } };
    } catch (error) {
      await finish(call.id, 'failed', 'voice-error').catch(() => undefined);
      throw error instanceof CallError ? error : new CallError('voice-off', 'the voice did not answer');
    }
  }

  function checkOffer(offer: { sdp: string; type: string }): void {
    if (typeof offer.sdp !== 'string' || offer.sdp === '' || offer.sdp.length > 64 * 1024 || offer.type !== 'offer') {
      throw new CallError('invalid', 'expected a WebRTC offer');
    }
  }

  return {
    active: () => sessions.size > 0,
    async start(conversationId, offer) {
      checkOffer(offer);
      const conversation = isUuid(conversationId) ? await loadConversation(sql, conversationId) : undefined;
      if (conversation === undefined) throw new CallError('not-found', 'no such conversation');
      if (conversation.archivedAt !== null) throw new CallError('archived', 'the conversation is archived: restore it to call');
      // An incognito conversation has no calls (D-136): a ChatError, the same 409 `incognito` as every refusal of an incognito.
      if (conversation.incognito) throw new ChatError('incognito', 'incognito');
      // The voice answers on the local model: never in a direct chat, where only the Coder answers (D-111).
      if (conversation.agent !== null) throw new CallError('invalid', 'a direct chat with the Coder has no calls');
      // The check and the row together: the service is not replaced in between (D-071).
      const call = await hold(async () => {
        if (options.voice.state !== 'up') throw new CallError('voice-off', 'the voice service is not running');
        const { roles, local, voice } = options.config();
        const ready = callReadiness(roles, options.candidates(), local.endpoints.some((endpoint) => VOICE_ALIAS in endpoint.models), voice.voice);
        if (!ready.ready) throw new CallError('not-ready', `assign and download: ${ready.missing.join(', ')}`);
        try {
          return await sql.begin(async (tx) => {
            const [row] = await tx.unsafe<Call[]>(
              `INSERT INTO calls (conversation_id, direction, status) VALUES ($1, 'in', 'connecting') RETURNING ${CALL_COLUMNS}`,
              [conversationId],
            );
            if (row === undefined) throw new Error('INSERT INTO calls returned no row');
            await appendEvent(tx, { kind: 'call.started', label: 'L0', payload: { callId: row.id, conversationId, direction: 'in' } });
            return row;
          });
        } catch (error) {
          if ((error as { code?: unknown }).code === '23505') throw new CallError('busy', 'another call is in progress');
          throw error;
        }
      });

      return connect(call, offer, CALL_TEXT.greeting);
    },

    async turn(callId, token, text) {
      const said: string[] = [];
      // Through the method: tests and the HTTP route see the same turn.
      for await (const { say } of this.turnStream(callId, token, text)) said.push(say);
      return { say: said.join(' ') };
    },

    turnStream(callId, token, text) {
      const session = sessions.get(callId);
      if (session === undefined || !tokenMatches(session, token)) return failing(new CallError('unauthorized', 'unknown call or token'));
      if (typeof text !== 'string') return failing(new CallError('invalid', 'text: the words of the user'));
      const words = cleanTranscript(text);
      try {
        checkMessageBody(words);
      } catch {
        return failing(new CallError('invalid', 'text: the words of the user'));
      }
      session.latest += 1;
      const turn = session.latest;
      // The turn at work answers the past: its model stops now.
      session.stop?.abort();
      const stop = new AbortController();
      session.stop = stop;
      const lines = linePipe<{ say: string }>(() => {
        stop.abort();
      });
      const result = session.chain.then(() => runTurn(callId, session, turn, words, (say) => {
        lines.push({ say });
      }, stop.signal));
      result.then(
        () => {
          lines.close();
        },
        (error: unknown) => {
          lines.close(error);
        },
      );
      session.chain = result.catch(() => undefined);
      return lines.iterator;
    },

    async answer(callId, offer) {
      checkOffer(offer);
      if (options.voice.state !== 'up') throw new CallError('voice-off', 'the voice service is not running');
      const ringing = await loadCall(sql, callId);
      if (ringing === undefined) throw new CallError('not-found', 'no such call');
      const conversation = await loadConversation(sql, ringing.conversationId);
      if (conversation === undefined || conversation.archivedAt !== null) {
        await finish(callId, 'missed', 'cancelled').catch(() => undefined);
        throw new CallError('archived', 'the conversation is archived');
      }
      const call = await sql.begin(async (tx) => {
        const [row] = await tx.unsafe<Call[]>(`UPDATE calls SET status = 'connecting' WHERE id = $1 AND status = 'ringing' RETURNING ${CALL_COLUMNS}`, [callId]);
        // The other pages stop ringing: someone answered.
        if (row !== undefined) await appendEvent(tx, { kind: 'call.started', label: 'L0', payload: { callId, conversationId: row.conversationId, direction: 'out' } });
        return row;
      });
      if (call === undefined) throw new CallError('ended', 'the call is not ringing any more');
      const reason = call.reason ?? 'scheduled';
      const task = call.taskId === null ? undefined : await loadTask(sql, call.taskId);
      const failed = reason === 'task-done' && task?.status === 'failed';
      let greeting: string = failed ? FAILED_TEXT.greeting : OUTGOING_TEXT[reason].greeting;
      // A task the user asked to hear about: the start of its answer, through the gateway when said.
      if (reason === 'task-done' && !failed && call.taskId !== null) {
        const [row] = await sql<{ id: string }[]>`SELECT id::text FROM messages WHERE task_id = ${call.taskId} AND role = 'assistant' ORDER BY id DESC LIMIT 1`;
        const message = row === undefined ? undefined : await loadMessage(sql, row.id);
        if (message !== undefined) {
          const label = maxLabel(message.label, conversation.effectiveLabel);
          const decision = await passGateway(sql, [{ value: summaryToSay(message.body), label, source: `call:${call.id}` }], createContext(conversation.clearance, label), { kind: 'channel', id: 'voice' });
          const [allowed] = decision.decision === 'allow' ? decision.texts : [];
          if (allowed !== undefined) greeting = `${greeting} ${allowed}`;
        }
      }
      return connect(call, offer, greeting.slice(0, 2000));
    },

    async decline(callId) {
      // Only a call still ringing: not one another page answered, nor one the ring timer closed.
      const missed = await sql.begin(async (tx) => {
        const [row] = await tx.unsafe<Call[]>(
          `UPDATE calls SET status = 'missed', end_reason = 'cancelled', ended_at = now() WHERE id = $1 AND status = 'ringing' RETURNING ${CALL_COLUMNS}`,
          [callId],
        );
        if (row !== undefined) await appendEvent(tx, { kind: 'call.ended', label: 'L0', payload: { callId, conversationId: row.conversationId, status: 'missed', reason: 'cancelled' } });
        return row;
      });
      if (missed === undefined) throw new CallError('ended', 'the call is not ringing any more');
      const task = missed.taskId === null ? undefined : await loadTask(sql, missed.taskId);
      const text = missed.reason === 'task-done' && task?.status === 'failed' ? FAILED_TEXT.missed : OUTGOING_TEXT[missed.reason ?? 'scheduled'].missed;
      await writeNote(sql, missed.conversationId, text, callId);
      return missed;
    },

    async end(callId, reason, token) {
      if (token !== undefined) {
        const session = sessions.get(callId);
        if (session === undefined || !tokenMatches(session, token)) throw new CallError('unauthorized', 'unknown call or token');
      }
      return finish(callId, 'ended', reason);
    },

    async closeLeftovers() {
      return sql.begin(async (tx) => {
        const rows = await tx<{ id: string; conversationId: string; status: CallStatus }[]>`
          UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END,
            end_reason = 'core-restart', ended_at = now()
          WHERE status IN ('ringing', 'connecting', 'active')
          RETURNING id::text, conversation_id::text AS "conversationId", status`;
        for (const row of rows) {
          await appendEvent(tx, { kind: 'call.ended', label: 'L0', payload: { callId: row.id, conversationId: row.conversationId, status: row.status, reason: 'core-restart' } });
        }
        return rows.length;
      });
    },

    async close() {
      for (const callId of [...sessions.keys()]) await finish(callId, 'ended', 'core-restart').catch((error: unknown) => options.onError?.(error));
    },
  };
}

/**
 * Items pushed by a producer, read as an async iterator. `return` (the reader
 * gave up) calls `onReturn` at once, even while a `next` waits.
 */
function linePipe<T>(onReturn: () => void): { push(item: T): void; close(error?: unknown): void; iterator: AsyncIterableIterator<T> } {
  const items: T[] = [];
  let closed = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const iterator: AsyncIterableIterator<T> = {
    async next() {
      for (;;) {
        const item = items.shift();
        if (item !== undefined) return { done: false, value: item };
        if (failure !== undefined) {
          const { error } = failure;
          failure = undefined;
          throw error;
        }
        if (closed) return { done: true, value: undefined };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
    return() {
      closed = true;
      items.length = 0;
      onReturn();
      wake?.();
      return Promise.resolve({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return {
    push(item) {
      if (closed) return;
      items.push(item);
      wake?.();
    },
    close(error) {
      if (closed) return;
      closed = true;
      if (error !== undefined) failure = { error };
      wake?.();
    },
    iterator,
  };
}

/** An iterator that fails at the first read: the error of a refused turn. */
function failing<T>(error: unknown): AsyncIterableIterator<T> {
  const iterator: AsyncIterableIterator<T> = {
    next: () => Promise.reject(error instanceof Error ? error : new Error(String(error))),
    return: () => Promise.resolve({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

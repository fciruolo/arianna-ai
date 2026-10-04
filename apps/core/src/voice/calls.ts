import { randomBytes, timingSafeEqual } from 'node:crypto';

import { VOICE_ALIAS, type VoiceConfig } from '@arianna/config';
import type { LocalModel } from '@arianna/executors';
import { createContext, isAtMost, labelForUserMessage, maxLabel, scanText, type Label } from '@arianna/policy';

import { ChatError, checkMessageBody, isUuid, listMessages, loadConversation, loadMessage, postUserMessage, taskTitle, type Message } from '../conversations.ts';
import type { Queryable, Sql } from '../db/client.ts';
import { appendEvent } from '../events.ts';
import { passGateway } from '../gateway.ts';
import { ORCHESTRATOR_EXECUTOR } from '../orchestrator/orchestrator.ts';
import { loadTask } from '../tasks.ts';
import { FAILED_TEXT, OUTGOING_TEXT } from './outgoing.ts';
import type { VoiceService } from './service.ts';
import type { TrialModel } from './trial.ts';
import { CALL_TEXT, callReadiness, cleanTranscript, MAX_REPLY_TOKENS, parseReply, summaryToSay, voicePrompt } from './turns.ts';

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
  voice: Pick<VoiceService, 'state' | 'request'>;
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

  async function finish(callId: string, status: CallStatus, reason: CallEndReason): Promise<Call> {
    const session = sessions.get(callId);
    if (session !== undefined) clearTimeout(session.timer);
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
    return call;
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

  /** The reply goes through the gateway towards the call (local), then into the history. */
  async function storeReply(call: Call, text: string, label: Label, clearance: Label, effective: Label): Promise<boolean> {
    const stored = maxLabel(label, effective);
    if (!isAtMost(stored, clearance)) return false;
    const decision = await passGateway(sql, [{ value: text, label: stored, source: `call:${call.id}` }], createContext(clearance, effective), { kind: 'channel', id: 'voice' });
    if (decision.decision === 'block') return false;
    const [allowed] = decision.texts;
    if (allowed === undefined) return false;
    await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO messages (conversation_id, role, channel, label, body)
        VALUES (${call.conversationId}, 'assistant', 'voice', ${stored}::privacy_label, ${allowed})
        RETURNING id::text`;
      if (row === undefined) throw new Error('INSERT INTO messages returned no row');
      await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId: call.conversationId, messageId: row.id, role: 'assistant', callId: call.id } });
    });
    return true;
  }

  /** One turn: store the words, ask the model through the gateway, store and return the reply. */
  async function runTurn(callId: string, session: Session, turn: number, words: string): Promise<{ say: string }> {
    const call = await loadCall(sql, callId);
    if (call?.status !== 'active') throw new CallError('ended', 'the call is over');
    const conversation = await loadConversation(sql, call.conversationId);
    if (conversation === undefined || conversation.archivedAt !== null) throw new CallError('ended', 'the conversation is gone');

    // A work conversation may go to the cloud later: no private data in it (as writeUserMessage).
    if (conversation.mode === 'work' && scanText(words).length > 0) return { say: CALL_TEXT.privateInWork };
    await storeUserTurn(call, words, conversation.clearance);

    // The model reads the history only once the gateway allowed it, like the orchestrator does.
    const prompt = voicePrompt(await listMessages(sql, call.conversationId, { limit: 40 }), conversation.effectiveLabel);
    const effective = maxLabel(conversation.effectiveLabel, prompt.label);
    const decision = await passGateway(
      sql,
      prompt.messages.map((part) => ({ value: part.content, label: part.label, source: `call:${callId}` })),
      createContext(conversation.clearance, effective),
      { kind: 'executor', id: ORCHESTRATOR_EXECUTOR, locality: 'local' },
    );
    if (decision.decision === 'block' || decision.texts.length !== prompt.messages.length) return { say: CALL_TEXT.cannotRead };
    const allowed = prompt.messages.map((part, index) => ({ role: part.role, content: decision.texts[index] ?? '' }));

    let reply: string;
    try {
      const result = await options.model().chat({ model: VOICE_ALIAS, messages: allowed, maxTokens: MAX_REPLY_TOKENS, temperature: 0.4, timeoutMs: 30_000 });
      reply = result.text;
    } catch (error) {
      options.onError?.(error);
      return { say: CALL_TEXT.modelDown };
    }
    // The user spoke again meanwhile: this reply would answer the past, it is dropped.
    if (session.latest !== turn) return { say: '' };

    const parsed = parseReply(reply);
    if (parsed.kind === 'delegate') {
      const { voice } = options.config();
      if (session.delegations >= voice.limits.delegations) return { say: CALL_TEXT.tooMany };
      let taskId: string;
      try {
        // Arianna's task in the same conversation, as if the user had written it.
        taskId = (await postUserMessage(sql, call.conversationId, parsed.request, { channel: 'voice' })).task.id;
      } catch (error) {
        if (error instanceof ChatError) return { say: error.code === 'scanner' ? CALL_TEXT.privateInWork : CALL_TEXT.cannotDelegate };
        throw error;
      }
      session.delegations += 1;
      await sql`UPDATE calls SET delegations = delegations + 1 WHERE id = ${callId}`;
      follow(callId, taskId, voice.limits.delegationSeconds).catch((error: unknown) => options.onError?.(error));
      await storeReply(call, CALL_TEXT.delegated, 'L0', conversation.clearance, effective);
      return { say: CALL_TEXT.delegated };
    }
    if (parsed.text === '') return { say: CALL_TEXT.notUnderstood };
    const stored = await storeReply(call, parsed.text, prompt.label, conversation.clearance, effective);
    return { say: stored ? parsed.text : CALL_TEXT.notHere };
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
    const session: Session = { token: Buffer.from(token), conversationId: call.conversationId, timer: undefined, delegations: 0, chain: Promise.resolve(), latest: 0 };
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
    async start(conversationId, offer) {
      checkOffer(offer);
      const conversation = isUuid(conversationId) ? await loadConversation(sql, conversationId) : undefined;
      if (conversation === undefined) throw new CallError('not-found', 'no such conversation');
      if (conversation.archivedAt !== null) throw new CallError('archived', 'the conversation is archived: restore it to call');
      if (options.voice.state !== 'up') throw new CallError('voice-off', 'the voice service is not running');
      const { roles, local, voice } = options.config();
      const ready = callReadiness(roles, options.candidates(), local.endpoints.some((endpoint) => VOICE_ALIAS in endpoint.models), voice.voice);
      if (!ready.ready) throw new CallError('not-ready', `assign and download: ${ready.missing.join(', ')}`);

      let call: Call;
      try {
        call = await sql.begin(async (tx) => {
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

      return connect(call, offer, CALL_TEXT.greeting);
    },

    async turn(callId, token, text) {
      const session = sessions.get(callId);
      if (session === undefined || !tokenMatches(session, token)) throw new CallError('unauthorized', 'unknown call or token');
      if (typeof text !== 'string') throw new CallError('invalid', 'text: the words of the user');
      const words = cleanTranscript(text);
      try {
        checkMessageBody(words);
      } catch {
        throw new CallError('invalid', 'text: the words of the user');
      }
      session.latest += 1;
      const turn = session.latest;
      const result = session.chain.then(() => runTurn(callId, session, turn, words));
      session.chain = result.catch(() => undefined);
      return result;
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

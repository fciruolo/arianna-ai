import { clearanceFor, createContext, labelForUserMessage, scanText, type ConversationMode, type Label } from '@arianna/policy';

import type { CodexModel } from '@arianna/executors';

import type { Queryable, Sql } from './db/client.ts';
import { scheduleTask } from './engine.ts';
import { appendEvent } from './events.ts';
import type { TaskStatus } from './task-status.ts';
import { createDelegation } from './orchestrator/delegations.ts';
import { leaveIdle, type LeaveRule } from './participants.ts';
import { createTask, TaskError, type Task } from './tasks.ts';
import { closeSupersededWaits } from './waiting.ts';

/**
 * Conversations and their messages (task 1.11, D-039). A conversation is
 * "work" (clearance L1, bound to a repository, may use the cloud) or "private"
 * (clearance L2, stays local). Every user message starts a task of Arianna
 * in that conversation; the step executor answers with `openReply`.
 */
export interface Conversation {
  id: string;
  mode: ConversationMode;
  clearance: Label;
  effectiveLabel: Label;
  /**
   * Has read finance data (D-183, migration 0056): the conversation with the
   * agent of the Finances is born with it, a task that reads finance data
   * sets it. Never false again: its tasks are born marked.
   */
  finance: boolean;
  workspace: string | null;
  /** The cloud model the user chose for delegated steps (router alias), work conversations only; null lets the router choose. */
  model: string | null;
  /** Who answers (D-111): null is Arianna; 'coder' the direct chat with the Coder. Chosen at creation, never changed. */
  agent: ConversationAgent | null;
  /**
   * Direct chat only (D-111, tappa A2): tokens in the agent's session after
   * its latest answer, for the context indicator; null before it or elsewhere.
   * The plain chats with Claude or ChatGPT read it from the run that wrote the
   * latest answer (`runs.context_tokens`, D-212).
   */
  contextTokens: number | null;
  /** One line, from the first user message or the user; null until the first message. Carries the clearance. */
  title: string | null;
  /** When the user archived it; null while it is in the list. */
  archivedAt: Date | null;
  /** When the user pinned it at the top of the list (D-089); null when not pinned. Never set while archived. */
  pinnedAt: Date | null;
  /** The conversation of the Telegram channel: it cannot be archived. */
  telegram: boolean;
  /**
   * An incognito conversation (D-136): chosen at creation, never changed. It
   * has no title, is never listed, archived nor pinned, and its texts are
   * deleted when it closes (incognito.ts).
   */
  incognito: boolean;
  /**
   * The catalog id of the local model under trial (D-142): every message of
   * this incognito private conversation goes to it only, without Arianna.
   * Chosen at creation, never changed; null elsewhere.
   */
  trialModel: string | null;
  /**
   * The conversation of the "Segretaria" button (I-12, D-144): private,
   * answered by Arianna, one only, never archived; the chat opens it from its
   * button, never from the list. Chosen at creation, never changed.
   */
  secretary: boolean;
  /**
   * When the current session of the secretary began (D-146): the last click on
   * the "Segretaria" button. The model reads only the messages from here on.
   * Null on every other conversation, and on the secretary's before a click.
   */
  secretarySessionAt: Date | null;
  /** Where the session in force of a direct chat begins («Nuova sessione», I-20, D-185); null before the first. */
  directSessionAt: Date | null;
  /** 'system' for a system chat, opened by the system and not by the user (D-064). */
  origin: ConversationOrigin;
  /** Why the system opened it: 'failure', a failed task. Null for the user's conversations. */
  systemReason: 'failure' | null;
  /** The task a system chat is about, and its conversation. */
  sourceTaskId: string | null;
  sourceConversationId: string | null;
  /** The user attached the question of the failed task to the system chat. */
  questionAttached: boolean;
  /** The status of the source task now: the chat offers "Riprova" only while it is failed. */
  sourceTaskStatus: TaskStatus | null;
  createdAt: Date;
  /** Time of the last message, or null for an empty conversation. */
  lastMessageAt: Date | null;
}

export type ConversationOrigin = 'user' | 'system';
/** The agent a conversation has in place of Arianna (D-111d): any agent id but Arianna's, as its card allows. */
export type ConversationAgent = string;
export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageChannel = 'web' | 'telegram' | 'voice';

export interface Message {
  /** bigint, kept as a string. */
  id: string;
  conversationId: string;
  ts: Date;
  role: MessageRole;
  channel: MessageChannel;
  label: Label;
  body: string;
  taskId: string | null;
  /** The agent that wrote an assistant message when it is not Arianna (the Coder's report); null otherwise. */
  agent: string | null;
  /** The cloud model that wrote an answer of Arianna's task (Claude in a system chat, D-064); null for the local model. */
  model: string | null;
}

/** The Claude models that can answer a system chat directly (D-064, second part). */
export const DIRECT_MODELS = ['sonnet', 'opus'] as const;
export type DirectModel = (typeof DIRECT_MODELS)[number];

/**
 * The models of the plain chat with ChatGPT (D-212): the three aliases of
 * Codex (D-141, the same list as CODEX_MODELS of @arianna/executors). None
 * of them asks for a budget approval, so any of them may answer.
 */
export const CODEX_CHAT_MODELS = ['luna', 'sol', 'astra'] as const satisfies readonly CodexModel[];
export type CodexChatModel = (typeof CODEX_CHAT_MODELS)[number];

/** The agent that answers in the chat. */
export const CHAT_AGENT = 'arianna';

/**
 * «Con chi parli» (D-111, tappa B): the local model with the knowledge base
 * read only (a card, agents/local-chat.yaml), only in a private conversation;
 * it answers with its two tools on the local model, as Arianna does, never
 * through a delegation.
 */
export const LOCAL_CHAT_AGENT = 'local-chat';
/**
 * Claude and ChatGPT without a project (D-111, tappa B): a plain chat on the
 * chain of D-064 (claude-direct.ts), no tool, an empty folder of the
 * conversation; only in a work conversation (L1) and never on a project (with
 * one the user talks with the Coder). Not cards: names of the executors.
 */
export const CLAUDE_CHAT_AGENT = 'claude';
export const CODEX_CHAT_AGENT = 'codex';
export const CLOUD_CHAT_AGENTS: readonly string[] = [CLAUDE_CHAT_AGENT, CODEX_CHAT_AGENT];

/** Who answers this conversation without a delegation: Arianna, the local model and the plain chats on the cloud. */
export function answersWithoutDelegation(agent: string | null): boolean {
  return agent === null || agent === LOCAL_CHAT_AGENT || CLOUD_CHAT_AGENTS.includes(agent);
}
/** Longest message the user can send; longer text belongs in a document. */
export const MAX_MESSAGE_LENGTH = 16_000;
const TITLE_LENGTH = 80;
/** The title of every task of an incognito conversation, from birth (D-136, migration 0031). */
export const INCOGNITO_TITLE = 'Incognito';
/** Longest title the user can give a conversation. */
export const MAX_CONVERSATION_TITLE = 200;

/** `incognito`: refused in an incognito conversation (D-136); `not-incognito`: only for one. Both 409. */
export type ChatErrorCode = 'not-found' | 'invalid' | 'scanner' | 'archived' | 'busy' | 'incognito' | 'not-incognito';

export class ChatError extends Error {
  override name = 'ChatError';
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CONVERSATION_COLUMNS = `c.id::text, c.mode, c.clearance, c.effective_label AS "effectiveLabel", c.finance, c.workspace, c.model, c.agent,
  c.title, c.archived_at AS "archivedAt", c.pinned_at AS "pinnedAt",
  EXISTS (SELECT FROM telegram_state t WHERE t.conversation_id = c.id) AS telegram, c.incognito, c.trial_model AS "trialModel", c.secretary, c.secretary_session_at AS "secretarySessionAt", c.direct_session_at AS "directSessionAt",
  c.origin, c.system_reason AS "systemReason", c.source_task_id::text AS "sourceTaskId",
  (SELECT s.conversation_id::text FROM tasks s WHERE s.id = c.source_task_id) AS "sourceConversationId",
  c.question_attached AS "questionAttached",
  (SELECT s.status FROM tasks s WHERE s.id = c.source_task_id) AS "sourceTaskStatus",
  c.created_at AS "createdAt",
  (SELECT max(m.ts) FROM messages m WHERE m.conversation_id = c.id) AS "lastMessageAt",
  CASE WHEN c.agent IS NULL THEN NULL
    WHEN c.agent IN ('claude', 'codex') AND c.workspace IS NULL THEN (SELECT r.context_tokens FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE t.conversation_id = c.id AND r.context_tokens IS NOT NULL AND r.started_at >= coalesce(c.direct_session_at, '-infinity'::timestamptz)
      ORDER BY r.started_at DESC, r.id DESC LIMIT 1)
    ELSE (SELECT d.context_tokens FROM task_delegations d JOIN tasks t ON t.id = d.task_id
    WHERE t.conversation_id = c.id AND d.status = 'ok' AND d.created_at >= coalesce(c.direct_session_at, '-infinity'::timestamptz)
    ORDER BY d.created_at DESC, d.id DESC LIMIT 1) END AS "contextTokens"`;

const MESSAGE_COLUMNS = `id::text, conversation_id::text AS "conversationId", ts, role, channel, label, body,
  task_id::text AS "taskId", agent, model`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * How a conversation opens. `model`: the cloud model of a work conversation
 * (D-071, the user's default), already checked against the selectable ones.
 */
export interface NewConversation {
  mode: ConversationMode;
  project?: string;
  projects?: readonly string[];
  model?: string;
  /**
   * Who answers in place of Arianna (D-111d), with what its card allows
   * (direct-chat.ts): the caller reads the card, this checks mode and project.
   */
  agent?: { name: ConversationAgent; modes: readonly ConversationMode[]; project: boolean; finance?: boolean };
  /** An incognito conversation (D-136): never with a direct agent. */
  incognito?: boolean;
  /** The local model under trial (D-142), already checked by the caller against the catalog: incognito and private only. */
  trialModel?: string;
}

/**
 * Opens a conversation. A work conversation may name its project (D-058):
 * one of the projects the user approved (`projects`, their names; empty when
 * not given), since a work conversation exists to send its code to the cloud.
 * The name goes in `workspace`; conversations opened before D-058 hold a path
 * there (`repos/demo`), which reads as the project of that name.
 */
export async function createConversation(sql: Sql, options: NewConversation): Promise<Conversation> {
  return sql.begin((tx) => writeConversation(tx, options));
}

/** `createConversation` inside a transaction the caller holds. */
export async function writeConversation(tx: Queryable, options: NewConversation): Promise<Conversation> {
  // Callers may pass anything that came over the wire.
  if (!(['work', 'private'] as readonly string[]).includes(options.mode)) throw new ChatError('invalid', 'mode must be work or private');
  if (options.project !== undefined) {
    if (options.mode !== 'work') throw new ChatError('invalid', 'only a work conversation has a project');
    if (!(options.projects ?? []).includes(options.project)) throw new ChatError('invalid', 'project is not among the approved projects');
  }
  if (options.model !== undefined && options.mode !== 'work') throw new ChatError('invalid', 'only a work conversation chooses a cloud model');
  if (options.agent !== undefined) {
    // An agent on Claude only in a work conversation on a project; a local one where its card may read (D-111d).
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.agent.name) || options.agent.name === CHAT_AGENT) throw new ChatError('invalid', 'agent is not one the user may talk with');
    if (!options.agent.modes.includes(options.mode)) throw new ChatError('invalid', `${options.agent.name} does not answer a ${options.mode} conversation`);
    if (options.agent.project && options.project === undefined) throw new ChatError('invalid', `the direct chat with ${options.agent.name} needs a project`);
    // «Con chi parli» (D-111, tappa B), as the database checks it too (migration 0063): the mode follows who answers.
    if (options.agent.name === LOCAL_CHAT_AGENT && options.mode !== 'private') throw new ChatError('invalid', 'the local model answers only a private conversation');
    if (CLOUD_CHAT_AGENTS.includes(options.agent.name)) {
      if (options.mode !== 'work') throw new ChatError('invalid', `${options.agent.name} answers only a work conversation`);
      if (options.project !== undefined) throw new ChatError('invalid', `the plain chat with ${options.agent.name} has no project: with a project the user talks with the Coder`);
    }
    if (options.agent.name === CLAUDE_CHAT_AGENT && options.model !== undefined && !(DIRECT_MODELS as readonly string[]).includes(options.model)) {
      throw new ChatError('invalid', 'the plain chat with Claude takes Sonnet or Opus');
    }
    if (options.agent.name === CODEX_CHAT_AGENT && options.model !== undefined && !(CODEX_CHAT_MODELS as readonly string[]).includes(options.model)) {
      throw new ChatError('invalid', 'the plain chat with ChatGPT takes a model of Codex');
    }
  }
  const incognito = options.incognito === true;
  // A direct chat keeps its agent's session to resume it (D-111): it has no incognito form.
  if (incognito && options.agent !== undefined) throw new ChatError('invalid', 'an incognito conversation is answered by Arianna');
  // The trial chat of a local model (D-142) leaves nothing behind: incognito, private, nobody else answers.
  if (options.trialModel !== undefined && (!incognito || options.mode !== 'private')) throw new ChatError('invalid', 'a trial chat is an incognito private conversation');
  // The agent of the Finances (D-183): private only, and marked from birth: it has read finance data (L2).
  const finance = options.agent?.finance === true;
  if (finance && options.mode !== 'private') throw new ChatError('invalid', `${options.agent?.name ?? ''} answers only a private conversation`);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, workspace, model, agent, incognito, trial_model, finance, effective_label)
    VALUES (${options.mode}, ${clearanceFor(options.mode)}::privacy_label, ${options.project ?? null}, ${options.model ?? null}, ${options.agent?.name ?? null}, ${incognito}, ${options.trialModel ?? null},
      ${finance}, ${finance ? 'L2' : 'L0'}::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO conversations returned no row');
  await appendEvent(tx, {
    kind: 'conversation.created',
    label: 'L0',
    payload: { conversationId: row.id, mode: options.mode, ...(options.agent === undefined ? {} : { agent: options.agent.name }), ...(incognito ? { incognito } : {}), ...(options.trialModel === undefined ? {} : { trialModel: options.trialModel }) },
  });
  const created = await loadConversation(tx, row.id);
  if (created === undefined) throw new Error('the new conversation is missing');
  return created;
}

/**
 * Sets the cloud model of a work conversation (task 1.10): one of `selectable`,
 * the cloud candidates of this installation, or null to let the router choose.
 * A private conversation stays on the local model: it has no model to set.
 */
export async function setConversationModel(sql: Queryable, id: string, model: string | null, selectable: readonly string[]): Promise<Conversation> {
  const conversation = await loadConversation(sql, id);
  if (conversation === undefined) throw new ChatError('not-found', `conversation ${id} does not exist`);
  if (conversation.mode !== 'work') throw new ChatError('invalid', 'only a work conversation chooses a cloud model');
  if (model !== null && !selectable.includes(model)) throw new ChatError('invalid', 'the model is not one of the cloud models of this installation');
  // In a system chat the model answers directly (D-064): Sonnet or Opus, never one behind a budget approval.
  if (model !== null && conversation.origin === 'system' && !(DIRECT_MODELS as readonly string[]).includes(model)) {
    throw new ChatError('invalid', 'a system chat is answered by Arianna or by Claude Sonnet or Opus');
  }
  // The plain chat with Claude (D-111, tappa B) the same: Fable only with a project, behind the budget approval.
  if (model !== null && conversation.agent === CLAUDE_CHAT_AGENT && !(DIRECT_MODELS as readonly string[]).includes(model)) {
    throw new ChatError('invalid', 'the plain chat with Claude takes Sonnet or Opus');
  }
  // The plain chat with ChatGPT (D-212): one of the models of Codex.
  if (model !== null && conversation.agent === CODEX_CHAT_AGENT && !(CODEX_CHAT_MODELS as readonly string[]).includes(model)) {
    throw new ChatError('invalid', 'the plain chat with ChatGPT takes a model of Codex');
  }
  await sql`UPDATE conversations SET model = ${model} WHERE id = ${id}`;
  await appendEvent(sql, { kind: 'conversation.model', label: 'L0', payload: { conversationId: id, model } });
  const updated = await loadConversation(sql, id);
  if (updated === undefined) throw new Error('the conversation is missing');
  return updated;
}

export async function loadConversation(sql: Queryable, id: string): Promise<Conversation | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await sql.unsafe<Conversation[]>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = $1 AND c.purged_at IS NULL`, [id]);
  return row;
}

/**
 * The pinned ones first, the latest pin on top (D-089), then the most
 * recently active: the user's conversations, with `origin: 'system'` the
 * system chats (D-064), or with `archived` every archived conversation
 * (never pinned).
 */
export async function listConversations(
  sql: Queryable,
  limit = 50,
  options: { archived?: boolean; origin?: ConversationOrigin } = {},
): Promise<Conversation[]> {
  const archived = options.archived === true;
  // The archive holds every origin: asking for one of them there is a mistake of the caller.
  if (archived && options.origin !== undefined) throw new ChatError('invalid', 'the archive is not split by origin');
  const rows = await sql.unsafe<Conversation[]>(
    `SELECT * FROM (
       SELECT ${CONVERSATION_COLUMNS} FROM conversations c
       WHERE (c.archived_at IS NOT NULL) = $2 AND c.purged_at IS NULL AND NOT c.incognito AND NOT c.secretary AND ($2 OR c.origin = $3)
     ) listed
     ORDER BY "pinnedAt" DESC NULLS LAST, coalesce("lastMessageAt", "createdAt") DESC, id
     LIMIT $1`,
    [limit, archived, options.origin ?? 'user'],
  );
  return [...rows];
}

/**
 * Renames a conversation (D-057). The title is one line the user typed; in a
 * work conversation the scanner refuses it as it would refuse a message. The
 * event says that it changed, never what it says.
 */
export async function renameConversation(sql: Sql, id: string, title: unknown): Promise<Conversation> {
  if (typeof title !== 'string') throw new ChatError('invalid', 'the title must be a string');
  const line = title.trim();
  if (line === '') throw new ChatError('invalid', 'the title is empty');
  if (/[\r\n]/.test(line)) throw new ChatError('invalid', 'the title must be one line');
  if (Array.from(line).length > MAX_CONVERSATION_TITLE) throw new ChatError('invalid', `the title is longer than ${String(MAX_CONVERSATION_TITLE)} characters`);
  if (line.includes(String.fromCharCode(0))) throw new ChatError('invalid', 'the title contains a NUL character');
  return sql.begin(async (tx) => {
    const conversation = await lockConversation(tx, id);
    if (conversation.incognito) throw new ChatError('incognito', 'incognito');
    if (conversation.mode === 'work') {
      const kinds = [...new Set(scanText(line).map((finding) => finding.kind))];
      if (kinds.length > 0) throw new ChatError('scanner', `a work conversation cannot hold this title (${kinds.join(', ')})`);
    }
    await tx`UPDATE conversations SET title = ${line} WHERE id = ${id}`;
    await appendEvent(tx, { kind: 'conversation.title', label: 'L0', payload: { conversationId: id } });
    return reload(tx, id);
  });
}

/** The conversation, its row locked until the transaction ends. */
async function lockConversation(tx: Queryable, id: string): Promise<Conversation> {
  if (isUuid(id)) await tx`SELECT 1 FROM conversations WHERE id = ${id} FOR UPDATE`;
  const conversation = await loadConversation(tx, id);
  if (conversation === undefined) throw new ChatError('not-found', `conversation ${id} does not exist`);
  return conversation;
}

async function reload(sql: Queryable, id: string): Promise<Conversation> {
  const conversation = await loadConversation(sql, id);
  if (conversation === undefined) throw new Error('the conversation is missing');
  return conversation;
}

/**
 * Archives a conversation or brings it back to the list (D-057). Nothing is
 * deleted: the messages stay, the conversation leaves the list and takes no
 * new message until it is restored. The Telegram conversation stays.
 */
export async function archiveConversation(sql: Sql, id: string, archived: boolean): Promise<Conversation> {
  return sql.begin(async (tx) => {
    const conversation = await lockConversation(tx, id);
    if (conversation.incognito) throw new ChatError('incognito', 'incognito');
    if (archived && conversation.telegram) throw new ChatError('invalid', 'the conversation of Telegram cannot be archived');
    // The secretary's conversation goes on in time (D-144): its button opens it, the list never shows it.
    if (archived && conversation.secretary) throw new ChatError('invalid', 'the conversation of the secretary cannot be archived');
    if ((conversation.archivedAt !== null) !== archived) {
      await tx`UPDATE conversations SET archived_at = CASE WHEN ${archived}::boolean THEN now() END WHERE id = ${id}`;
      await appendEvent(tx, { kind: 'conversation.archived', label: 'L0', payload: { conversationId: id, archived } });
    }
    return reload(tx, id);
  });
}

/**
 * Pins a conversation at the top of the list, or unpins it (D-089). No limit
 * on how many. An archived conversation is refused (409): it is restored
 * first; archiving a pinned one unpins it (migration 0022). Pinning again
 * keeps the first time, so the order does not jump. The event carries the id only.
 */
export async function pinConversation(sql: Sql, id: string, pinned: boolean): Promise<Conversation> {
  return sql.begin(async (tx) => {
    const conversation = await lockConversation(tx, id);
    if (conversation.incognito) throw new ChatError('incognito', 'incognito');
    if (pinned && conversation.archivedAt !== null) throw new ChatError('archived', 'the conversation is archived: restore it to pin it');
    if (pinned && conversation.secretary) throw new ChatError('invalid', 'the conversation of the secretary has its own button');
    if ((conversation.pinnedAt !== null) !== pinned) {
      await tx`UPDATE conversations SET pinned_at = CASE WHEN ${pinned}::boolean THEN now() END WHERE id = ${id}`;
      await appendEvent(tx, { kind: 'conversation.pinned', label: 'L0', payload: { conversationId: id, pinned } });
    }
    return reload(tx, id);
  });
}

/**
 * What purge_conversation changed: the tasks it closed, the approvals it let
 * expire and the system chats about its tasks it purged first (D-064).
 */
interface PurgeResult {
  tasks: number;
  failed: { taskId: string; from: string }[];
  expired: { approvalId: string; taskId: string }[];
  system: { conversationId: string; tasks: number }[];
}

/**
 * Deletes the texts of an archived conversation for good (D-057): messages,
 * steps, briefs and reports, titles, the text of its approval cards. The
 * skeleton of the audit stays (purge_conversation in migration 0012). Refused
 * while a task of it is at work. The event carries the id only.
 */
export async function purgeConversation(sql: Sql, id: string): Promise<void> {
  // Checked first for a clear error; purge_conversation checks again under its row locks.
  const conversation = await loadConversation(sql, id);
  if (conversation === undefined) throw new ChatError('not-found', `conversation ${id} does not exist`);
  if (conversation.archivedAt === null) throw new ChatError('invalid', 'only an archived conversation can be deleted');
  const [busy] = await sql<{ busy: boolean; system: boolean }[]>`
    SELECT
      EXISTS (SELECT FROM tasks WHERE conversation_id = ${id} AND status IN ('ready', 'running')) AS busy,
      EXISTS (
        SELECT FROM conversations s JOIN tasks t ON t.conversation_id = s.id
        WHERE s.origin = 'system' AND s.purged_at IS NULL AND t.status IN ('ready', 'running')
          AND s.source_task_id IN (SELECT id FROM tasks WHERE conversation_id = ${id})
      ) AS system`;
  if (busy?.busy === true) throw new ChatError('busy', 'a task of the conversation is still at work: wait for it to finish');
  // purge_conversation deletes the system chats about its tasks too (D-064).
  if (busy?.system === true) throw new ChatError('busy', 'a system chat about this conversation is still at work: wait for it to finish');
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx<{ purged: PurgeResult }[]>`SELECT purge_conversation(${id}::uuid) AS purged`;
      const purged = row?.purged ?? { tasks: 0, failed: [], expired: [], system: [] };
      // The state changes the purge made, logged as the engine logs its own.
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
      for (const chat of purged.system) {
        await appendEvent(tx, { kind: 'conversation.purged', label: 'L0', payload: { conversationId: chat.conversationId, tasks: chat.tasks, cause: 'source' } });
      }
      await appendEvent(tx, { kind: 'conversation.purged', label: 'L0', payload: { conversationId: id, tasks: purged.tasks } });
    });
  } catch (error) {
    // Something changed between the check and the locks, or a lock did not come in time.
    const code = (error as { code?: unknown }).code;
    if (code === 'P0002') throw new ChatError('not-found', `conversation ${id} does not exist`);
    if (code === '55000') throw new ChatError('invalid', 'only an archived conversation can be deleted');
    if (code === '55006') throw new ChatError('busy', 'a task of the conversation is still at work: wait for it to finish');
    if (code === '55P03' || code === '40P01') throw new ChatError('busy', 'the conversation is in use: try again in a moment');
    throw error;
  }
}

export interface MessagePage {
  /** Only messages with a smaller id: pages backwards through the history. */
  beforeId?: string;
  limit: number;
}

/** A page of the history, in chronological order: the latest `limit` messages before `beforeId`. */
export async function listMessages(sql: Queryable, conversationId: string, page: MessagePage): Promise<Message[]> {
  const rows = await sql.unsafe<Message[]>(
    `SELECT * FROM (
       SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE conversation_id = $1 AND ($2::bigint IS NULL OR messages.id < $2::bigint)
       ORDER BY messages.id DESC
       LIMIT $3
     ) page ORDER BY page.id::bigint`,
    [conversationId, page.beforeId ?? null, page.limit],
  );
  return [...rows];
}

export async function loadMessage(sql: Queryable, id: string): Promise<Message | undefined> {
  const [row] = await sql.unsafe<Message[]>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1::bigint`, [id]);
  return row;
}

/** The step of the delegation a direct-chat message opens (task_delegations.step is never 0). */
export const DIRECT_STEP = 1;

/**
 * A task of the direct chat is still at work: ready, running, or waiting for
 * an approval the user has not decided (workspace, budget). One at a time,
 * since they work in the same project folder (D-111).
 */
async function directChatBusy(tx: Queryable, conversationId: string): Promise<boolean> {
  const [row] = await tx<{ busy: boolean }[]>`
    SELECT EXISTS (
      SELECT FROM tasks t WHERE t.conversation_id = ${conversationId}
        AND (t.status IN ('ready', 'running')
          OR (t.status = 'waiting_user' AND EXISTS (SELECT FROM approvals a WHERE a.task_id = t.id AND a.state = 'pending')))
    ) AS busy`;
  return row?.busy === true;
}

/** Validates the text of a user message; returns it unchanged. */
export function checkMessageBody(body: unknown): string {
  if (typeof body !== 'string' || body.trim() === '') throw new ChatError('invalid', 'the message is empty');
  if (body.length > MAX_MESSAGE_LENGTH) throw new ChatError('invalid', `the message is longer than ${String(MAX_MESSAGE_LENGTH)} characters`);
  // PostgreSQL text cannot hold a NUL: refused here, not as a database error.
  if (body.includes(String.fromCharCode(0))) throw new ChatError('invalid', 'the message contains a NUL character');
  return body;
}

/** A one-line title for the task, from the start of the message. */
export function taskTitle(body: string): string {
  const line = body.trim().split('\n', 1)[0]?.trim() ?? '';
  const chars = Array.from(line);
  return chars.length <= TITLE_LENGTH ? line : `${chars.slice(0, TITLE_LENGTH - 1).join('')}…`;
}

/** The agent of the direct chat whose messages may carry a style and skills (D-184); as DESIGNER_AGENT of cardwall.ts. */
export const DESIGN_CHAT_AGENT = 'designer';

export interface MessageOptions {
  channel?: MessageChannel;
  leave?: LeaveRule;
  /** The style and skills chosen in the Studio (I-19, D-184), already checked against the catalogs. */
  design?: { style: string | null; skills: readonly string[] };
}

/**
 * Writes the user's message and starts the task that answers it, in one
 * transaction. The message carries the conversation's clearance (the user
 * chose the mode), and so does what the task has read. In a work conversation
 * a message the scanner flags (IBAN, tax code, card, key) is refused: it
 * belongs in a private one. The refusal names the kinds found, never the text.
 */
export async function postUserMessage(
  sql: Sql,
  conversationId: string,
  body: string,
  options: MessageOptions = {},
): Promise<{ message: Message; task: Task }> {
  checkMessageBody(body);
  return sql.begin((tx) => writeUserMessage(tx, conversationId, body, options));
}

/**
 * `postUserMessage` inside a transaction the caller holds, e.g. together with
 * the offset of the Telegram update that carried the message.
 */
export async function writeUserMessage(
  tx: Queryable,
  conversationId: string,
  body: string,
  options: MessageOptions = {},
): Promise<{ message: Message; task: Task }> {
  checkMessageBody(body);
  const conversation = isUuid(conversationId)
    ? (
        await tx<{ mode: ConversationMode; clearance: Label; title: string | null; archived: boolean; agent: ConversationAgent | null; workspace: string | null; incognito: boolean; finance: boolean }[]>`
        SELECT mode, clearance, title, archived_at IS NOT NULL AS archived, agent, workspace, incognito, finance FROM conversations
        WHERE id = ${conversationId} AND purged_at IS NULL FOR UPDATE`
      )[0]
    : undefined;
  if (conversation === undefined) throw new ChatError('not-found', `conversation ${conversationId} does not exist`);
  if (conversation.archived) throw new ChatError('archived', 'the conversation is archived: restore it to write');

  if (conversation.mode === 'work') {
    const kinds = [...new Set(scanText(body).map((finding) => finding.kind))];
    if (kinds.length > 0) {
      throw new ChatError('scanner', `a work conversation cannot hold this message (${kinds.join(', ')}): open a private conversation`);
    }
  }

  // The style and skills of the Studio (D-184): only in the direct chat with the Designer.
  if (options.design !== undefined && conversation.agent !== DESIGN_CHAT_AGENT) {
    throw new ChatError('invalid', 'the style and the skills are only for the direct chat with the Designer');
  }

  // The direct chat runs one Coder at a time in the project folder (D-111): the next message waits for the answer.
  if (conversation.agent !== null && (await directChatBusy(tx, conversationId))) {
    // "still working" is what the chat reads; the name says who (the local model and Claude wait one at a time too).
    const who = conversation.agent === 'coder' ? 'the Coder' : conversation.agent;
    throw new ChatError('busy', `${who} is still working on the previous message: wait for the answer, or stop it`);
  }

  // The user went on: the waits of this conversation without a pending approval close (D-109).
  await closeSupersededWaits(tx, conversationId);

  const label = labelForUserMessage(createContext(conversation.clearance));
  const task = await createTask(tx, {
    // In incognito the start of the message never becomes a title (D-136): the database refuses any other.
    title: conversation.incognito ? INCOGNITO_TITLE : taskTitle(body),
    conversationId,
    label,
    clearance: conversation.clearance,
    effectiveLabel: label,
    assignee: conversation.agent ?? CHAT_AGENT,
    status: 'ready',
  });
  // Names of public text (D-184): the task's label stays what it is; the Designer reads them as a card's (D-163).
  if (options.design !== undefined) {
    await tx`UPDATE tasks SET design_style = ${options.design.style}, design_skills = ${[...options.design.skills]}::text[] WHERE id = ${task.id}`;
  }
  // In the direct chat the message is the brief, as it is: the step goes to the agent without a step of Arianna's (D-111).
  // The agent of the Finances (D-183) answers on the local model with its tools, as Arianna does: no delegation.
  // So do the local model and the plain chats with Claude or ChatGPT (D-111, tappa B): the step itself answers.
  // (`agent !== null` again only for the type: answersWithoutDelegation already says yes to Arianna.)
  if (!answersWithoutDelegation(conversation.agent) && conversation.agent !== null && !conversation.finance) {
    await createDelegation(tx, {
      taskId: task.id,
      step: DIRECT_STEP,
      agent: conversation.agent,
      brief: body,
      label,
      ...(conversation.workspace === null ? {} : { repo: conversation.workspace }),
    });
  }
  if (!(await scheduleTask(tx, task.id))) throw new TaskError(`task ${task.id} already has an active step job`);

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, channel, label, body, task_id)
    VALUES (${conversationId}, 'user', ${options.channel ?? 'web'}, ${label}::privacy_label, ${body}, ${task.id})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO messages returned no row');
  // The first message names the conversation, as in the chat apps (D-057).
  if (conversation.title === null && !conversation.incognito) {
    await tx`UPDATE conversations SET title = ${task.title.replace(/\s+/g, ' ')} WHERE id = ${conversationId}`;
  }
  await appendEvent(tx, {
    kind: 'message.created',
    taskId: task.id,
    label: 'L0',
    payload: { conversationId, messageId: row.id, role: 'user' },
  });
  // The agents with nothing to do here for a while say goodbye (I-8), after the message that made them idle; a direct chat has none.
  if (options.leave !== undefined && conversation.agent === null) await leaveIdle(tx, conversationId, task.id, options.leave);
  const message = await loadMessage(tx, row.id);
  if (message === undefined) throw new Error('the new message is missing');
  return { message, task };
}

import { clearanceFor, createContext, isAllowlisted, labelForUserMessage, scanText, type ConversationMode, type Label } from '@arianna/policy';

import type { Queryable, Sql } from './db/client.ts';
import { scheduleTask } from './engine.ts';
import { appendEvent } from './events.ts';
import { createTask, TaskError, type Task } from './tasks.ts';

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
  workspace: string | null;
  /** The cloud model the user chose for delegated steps (router alias), work conversations only; null lets the router choose. */
  model: string | null;
  /** One line, from the first user message or the user; null until the first message. Carries the clearance. */
  title: string | null;
  /** When the user archived it; null while it is in the list. */
  archivedAt: Date | null;
  /** The conversation of the Telegram channel: it cannot be archived. */
  telegram: boolean;
  createdAt: Date;
  /** Time of the last message, or null for an empty conversation. */
  lastMessageAt: Date | null;
}

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
}

/** The agent that answers in the chat. */
export const CHAT_AGENT = 'arianna';
/** Longest message the user can send; longer text belongs in a document. */
export const MAX_MESSAGE_LENGTH = 16_000;
const TITLE_LENGTH = 80;
/** Longest title the user can give a conversation. */
export const MAX_CONVERSATION_TITLE = 200;

export type ChatErrorCode = 'not-found' | 'invalid' | 'scanner' | 'archived';

export class ChatError extends Error {
  override name = 'ChatError';
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CONVERSATION_COLUMNS = `c.id::text, c.mode, c.clearance, c.effective_label AS "effectiveLabel", c.workspace, c.model,
  c.title, c.archived_at AS "archivedAt",
  EXISTS (SELECT FROM telegram_state t WHERE t.conversation_id = c.id) AS telegram,
  c.created_at AS "createdAt",
  (SELECT max(m.ts) FROM messages m WHERE m.conversation_id = c.id) AS "lastMessageAt"`;

const MESSAGE_COLUMNS = `id::text, conversation_id::text AS "conversationId", ts, role, channel, label, body,
  task_id::text AS "taskId", agent`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Opens a conversation. A work conversation may name its repository, relative
 * to ARIANNA_HOME; it must be in `cloud.allowlist` (`allowlist`, empty when
 * not given), since a work conversation exists to send its code to the cloud.
 */
export async function createConversation(
  sql: Sql,
  options: { mode: ConversationMode; workspace?: string; allowlist?: readonly string[] },
): Promise<Conversation> {
  return sql.begin((tx) => writeConversation(tx, options));
}

/** `createConversation` inside a transaction the caller holds. */
export async function writeConversation(
  tx: Queryable,
  options: { mode: ConversationMode; workspace?: string; allowlist?: readonly string[] },
): Promise<Conversation> {
  // Callers may pass anything that came over the wire.
  if (!(['work', 'private'] as readonly string[]).includes(options.mode)) throw new ChatError('invalid', 'mode must be work or private');
  if (options.workspace !== undefined) {
    if (options.mode !== 'work') throw new ChatError('invalid', 'only a work conversation has a workspace');
    if (!isRelativePath(options.workspace)) throw new ChatError('invalid', 'workspace must be a relative path inside ARIANNA_HOME');
    if (!isAllowlisted(options.workspace, options.allowlist ?? [])) throw new ChatError('invalid', 'workspace is not in cloud.allowlist');
  }
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, workspace)
    VALUES (${options.mode}, ${clearanceFor(options.mode)}::privacy_label, ${options.workspace ?? null})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO conversations returned no row');
  await appendEvent(tx, { kind: 'conversation.created', label: 'L0', payload: { conversationId: row.id, mode: options.mode } });
  const created = await loadConversation(tx, row.id);
  if (created === undefined) throw new Error('the new conversation is missing');
  return created;
}

function isRelativePath(path: string): boolean {
  if (path === '' || path.length > 200 || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false;
  return path.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
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
  await sql`UPDATE conversations SET model = ${model} WHERE id = ${id}`;
  await appendEvent(sql, { kind: 'conversation.model', label: 'L0', payload: { conversationId: id, model } });
  const updated = await loadConversation(sql, id);
  if (updated === undefined) throw new Error('the conversation is missing');
  return updated;
}

export async function loadConversation(sql: Queryable, id: string): Promise<Conversation | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await sql.unsafe<Conversation[]>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = $1`, [id]);
  return row;
}

/** Most recently active first: the list, or with `archived` the archived conversations. */
export async function listConversations(sql: Queryable, limit = 50, options: { archived?: boolean } = {}): Promise<Conversation[]> {
  const rows = await sql.unsafe<Conversation[]>(
    `SELECT * FROM (SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE (c.archived_at IS NOT NULL) = $2) listed
     ORDER BY coalesce("lastMessageAt", "createdAt") DESC, id
     LIMIT $1`,
    [limit, options.archived === true],
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
    if (archived && conversation.telegram) throw new ChatError('invalid', 'the conversation of Telegram cannot be archived');
    if ((conversation.archivedAt !== null) !== archived) {
      await tx`UPDATE conversations SET archived_at = CASE WHEN ${archived}::boolean THEN now() END WHERE id = ${id}`;
      await appendEvent(tx, { kind: 'conversation.archived', label: 'L0', payload: { conversationId: id, archived } });
    }
    return reload(tx, id);
  });
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
  options: { channel?: MessageChannel } = {},
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
  options: { channel?: MessageChannel } = {},
): Promise<{ message: Message; task: Task }> {
  checkMessageBody(body);
  const conversation = isUuid(conversationId)
    ? (await tx<{ mode: ConversationMode; clearance: Label; title: string | null; archived: boolean }[]>`
        SELECT mode, clearance, title, archived_at IS NOT NULL AS archived FROM conversations WHERE id = ${conversationId} FOR UPDATE`)[0]
    : undefined;
  if (conversation === undefined) throw new ChatError('not-found', `conversation ${conversationId} does not exist`);
  if (conversation.archived) throw new ChatError('archived', 'the conversation is archived: restore it to write');

  if (conversation.mode === 'work') {
    const kinds = [...new Set(scanText(body).map((finding) => finding.kind))];
    if (kinds.length > 0) {
      throw new ChatError('scanner', `a work conversation cannot hold this message (${kinds.join(', ')}): open a private conversation`);
    }
  }

  const label = labelForUserMessage(createContext(conversation.clearance));
  const task = await createTask(tx, {
    title: taskTitle(body),
    conversationId,
    label,
    clearance: conversation.clearance,
    effectiveLabel: label,
    assignee: CHAT_AGENT,
    status: 'ready',
  });
  if (!(await scheduleTask(tx, task.id))) throw new TaskError(`task ${task.id} already has an active step job`);

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, channel, label, body, task_id)
    VALUES (${conversationId}, 'user', ${options.channel ?? 'web'}, ${label}::privacy_label, ${body}, ${task.id})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO messages returned no row');
  // The first message names the conversation, as in the chat apps (D-057).
  if (conversation.title === null) {
    await tx`UPDATE conversations SET title = ${task.title.replace(/\s+/g, ' ')} WHERE id = ${conversationId}`;
  }
  await appendEvent(tx, {
    kind: 'message.created',
    taskId: task.id,
    label: 'L0',
    payload: { conversationId, messageId: row.id, role: 'user' },
  });
  const message = await loadMessage(tx, row.id);
  if (message === undefined) throw new Error('the new message is missing');
  return { message, task };
}

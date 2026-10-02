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
}

/** The agent that answers in the chat. */
export const CHAT_AGENT = 'arianna';
/** Longest message the user can send; longer text belongs in a document. */
export const MAX_MESSAGE_LENGTH = 16_000;
const TITLE_LENGTH = 80;

export type ChatErrorCode = 'not-found' | 'invalid' | 'scanner';

export class ChatError extends Error {
  override name = 'ChatError';
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CONVERSATION_COLUMNS = `c.id::text, c.mode, c.clearance, c.effective_label AS "effectiveLabel", c.workspace,
  c.created_at AS "createdAt",
  (SELECT max(m.ts) FROM messages m WHERE m.conversation_id = c.id) AS "lastMessageAt"`;

const MESSAGE_COLUMNS = `id::text, conversation_id::text AS "conversationId", ts, role, channel, label, body,
  task_id::text AS "taskId"`;

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
  // Callers may pass anything that came over the wire.
  if (!(['work', 'private'] as readonly string[]).includes(options.mode)) throw new ChatError('invalid', 'mode must be work or private');
  if (options.workspace !== undefined) {
    if (options.mode !== 'work') throw new ChatError('invalid', 'only a work conversation has a workspace');
    if (!isRelativePath(options.workspace)) throw new ChatError('invalid', 'workspace must be a relative path inside ARIANNA_HOME');
    if (!isAllowlisted(options.workspace, options.allowlist ?? [])) throw new ChatError('invalid', 'workspace is not in cloud.allowlist');
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO conversations (mode, clearance, workspace)
      VALUES (${options.mode}, ${clearanceFor(options.mode)}::privacy_label, ${options.workspace ?? null})
      RETURNING id::text`;
    if (row === undefined) throw new Error('INSERT INTO conversations returned no row');
    await appendEvent(tx, { kind: 'conversation.created', label: 'L0', payload: { conversationId: row.id, mode: options.mode } });
    const created = await loadConversation(tx, row.id);
    if (created === undefined) throw new Error('the new conversation is missing');
    return created;
  });
}

function isRelativePath(path: string): boolean {
  if (path === '' || path.length > 200 || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false;
  return path.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export async function loadConversation(sql: Queryable, id: string): Promise<Conversation | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await sql.unsafe<Conversation[]>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = $1`, [id]);
  return row;
}

/** Most recently active first. */
export async function listConversations(sql: Queryable, limit = 50): Promise<Conversation[]> {
  const rows = await sql.unsafe<Conversation[]>(
    `SELECT * FROM (SELECT ${CONVERSATION_COLUMNS} FROM conversations c) listed
     ORDER BY coalesce("lastMessageAt", "createdAt") DESC, id
     LIMIT $1`,
    [limit],
  );
  return [...rows];
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
  return sql.begin(async (tx) => {
    const conversation = isUuid(conversationId)
      ? (await tx<{ mode: ConversationMode; clearance: Label }[]>`
          SELECT mode, clearance FROM conversations WHERE id = ${conversationId} FOR UPDATE`)[0]
      : undefined;
    if (conversation === undefined) throw new ChatError('not-found', `conversation ${conversationId} does not exist`);

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
    await appendEvent(tx, {
      kind: 'message.created',
      taskId: task.id,
      label: 'L0',
      payload: { conversationId, messageId: row.id, role: 'user' },
    });
    const message = await loadMessage(tx, row.id);
    if (message === undefined) throw new Error('the new message is missing');
    return { message, task };
  });
}

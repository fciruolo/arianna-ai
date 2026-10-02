import { isUuid } from '../conversations.ts';

/**
 * Updates from getUpdates, reduced to what the channel uses (D-044). Telegram
 * is outside: every field is checked, nothing is trusted because of its shape.
 */
export type Update =
  | { kind: 'message'; updateId: number; chatId: number; chatType: string; fromId: number | undefined; text: string | undefined }
  | {
      kind: 'callback';
      updateId: number;
      callbackId: string;
      fromId: number;
      /** The chat and message that carried the button; absent for very old messages. */
      chatId: number | undefined;
      messageId: number | undefined;
      data: string | undefined;
    }
  /** Anything else: only its id matters, to move past it. */
  | { kind: 'other'; updateId: number };

type Table = Record<string, unknown>;

function table(value: unknown): Table | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Table) : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Updates with a valid update_id, in the order received; the others are dropped. */
export function parseUpdates(result: readonly unknown[]): Update[] {
  const updates: Update[] = [];
  for (const raw of result) {
    const update = table(raw);
    const updateId = integer(update?.update_id);
    if (update === undefined || updateId === undefined || updateId < 0) continue;

    const message = table(update.message);
    const chat = table(message?.chat);
    const chatId = integer(chat?.id);
    if (message !== undefined && chatId !== undefined) {
      updates.push({
        kind: 'message',
        updateId,
        chatId,
        chatType: text(chat?.type) ?? '',
        fromId: integer(table(message.from)?.id),
        text: text(message.text),
      });
      continue;
    }

    const callback = table(update.callback_query);
    const callbackId = text(callback?.id);
    const fromId = integer(table(callback?.from)?.id);
    if (callback !== undefined && callbackId !== undefined && callbackId !== '' && fromId !== undefined) {
      const carrier = table(callback.message);
      updates.push({
        kind: 'callback',
        updateId,
        callbackId,
        fromId,
        chatId: integer(table(carrier?.chat)?.id),
        messageId: integer(carrier?.message_id),
        data: text(callback.data),
      });
      continue;
    }
    updates.push({ kind: 'other', updateId });
  }
  return updates;
}

/**
 * Only the user's own private chats: the chat is listed in `telegram.chats`
 * and the sender is the chat itself (a private chat's id is its user's id).
 * A button press counts only from a listed user, on a message in that same chat.
 */
export function isAllowed(update: Update, chats: readonly number[]): boolean {
  switch (update.kind) {
    case 'message':
      return update.chatType === 'private' && chats.includes(update.chatId) && update.fromId === update.chatId;
    case 'callback':
      return chats.includes(update.fromId) && update.chatId === update.fromId;
    case 'other':
      return false;
  }
}

export type DecisionData = { approvalId: string; state: 'approved' | 'rejected' };

/** Button data: `ap:<uuid>:y` or `ap:<uuid>:n`, 41 bytes, under Telegram's 64. */
export function encodeDecision(approvalId: string, state: 'approved' | 'rejected'): string {
  if (!isUuid(approvalId)) throw new Error('encodeDecision: not an approval id');
  return `ap:${approvalId.toLowerCase()}:${state === 'approved' ? 'y' : 'n'}`;
}

export function decodeDecision(data: string | undefined): DecisionData | undefined {
  const match = data === undefined ? null : /^ap:([0-9a-f-]{36}):([yn])$/.exec(data);
  if (match === null) return undefined;
  const [, approvalId, choice] = match;
  if (approvalId === undefined || !isUuid(approvalId)) return undefined;
  return { approvalId, state: choice === 'y' ? 'approved' : 'rejected' };
}

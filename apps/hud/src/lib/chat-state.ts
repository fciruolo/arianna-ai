import type { Delta, Message } from './types.ts';

/**
 * The open conversation: stored messages plus the answers being written.
 * Pure and immutable, so the views can hold it in a ref and the tests need no
 * browser. Fragments arrive in order per reply; a gap is held until it fills.
 */
export interface StreamingReply {
  replyId: string;
  taskId: string;
  text: string;
  nextSeq: number;
  /** Fragments that arrived ahead of a missing one, by sequence number. */
  ahead: Record<number, string>;
}

export interface ChatState {
  conversationId: string;
  messages: Message[];
  streaming: StreamingReply[];
}

export function emptyChat(conversationId: string): ChatState {
  return { conversationId, messages: [], streaming: [] };
}

/** Adds messages of this conversation, without duplicates, in id order. */
export function mergeMessages(state: ChatState, incoming: readonly Message[]): ChatState {
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (message.conversationId === state.conversationId) byId.set(message.id, message);
  }
  const messages = [...byId.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  return { ...state, messages };
}

/** Appends a fragment of an answer being written in this conversation. */
export function applyDelta(state: ChatState, delta: Delta): ChatState {
  if (delta.conversationId !== state.conversationId) return state;
  const current = state.streaming.find((reply) => reply.replyId === delta.replyId) ?? {
    replyId: delta.replyId,
    taskId: delta.taskId,
    text: '',
    nextSeq: 0,
    ahead: {},
  };
  if (delta.seq < current.nextSeq) return state;
  const ahead = { ...current.ahead, [delta.seq]: delta.text };
  let { text, nextSeq } = current;
  for (let piece = ahead[nextSeq]; piece !== undefined; piece = ahead[nextSeq]) {
    text += piece;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a plain record of pending fragments
    delete ahead[nextSeq];
    nextSeq += 1;
  }
  const next: StreamingReply = { ...current, text, nextSeq, ahead };
  const others = state.streaming.filter((reply) => reply.replyId !== delta.replyId);
  return { ...state, streaming: [...others, next] };
}

/** The stored message replaced the answer being written. */
export function settleReply(state: ChatState, replyId: string): ChatState {
  if (!state.streaming.some((reply) => reply.replyId === replyId)) return state;
  return { ...state, streaming: state.streaming.filter((reply) => reply.replyId !== replyId) };
}

/** Ids of the tasks started or answered in the conversation, newest last. */
export function taskIds(state: ChatState): string[] {
  const ids: string[] = [];
  for (const message of state.messages) {
    if (message.taskId !== null && !ids.includes(message.taskId)) ids.push(message.taskId);
  }
  return ids;
}

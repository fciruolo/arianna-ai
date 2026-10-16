import { ref, shallowRef } from 'vue';

import { applyDelta, emptyChat, mergeMessages, settleReply, taskIds, type ChatState } from './chat-state.ts';
import { errorText } from './italian.ts';
import { payloadString, type ServerMessage } from './protocol.ts';
import { SIDE_LOAD_ERROR, sidesByMessage } from './side-chat.ts';
import type { Conversation, Message, QueuedMessage, QueueView, SideThread, Task } from './types.ts';

/** The calls of the core the panel makes: injected, so the tests drive them. */
export interface SideApi {
  listSides(conversationId: string): Promise<SideThread[]>;
  openSide(conversationId: string, messageId: string): Promise<Conversation>;
  loadConversation(conversationId: string): Promise<Conversation>;
  listMessages(conversationId: string): Promise<Message[]>;
  sendMessage(conversationId: string, body: string): Promise<{ message: Message; task: Task } | { queued: QueuedMessage }>;
  loadTask(id: string): Promise<Task>;
  loadQueue(conversationId: string): Promise<QueueView>;
}

/** The panel of «Chiedi a lato» (D-232): the answer it is about, and its side thread once there is one. */
export interface SidePanel {
  motherId: string;
  /** The answer the side thread is about. */
  origin: Message;
  /** Null until the first question: the side thread is created with it. */
  conversation: Conversation | null;
  chat: ChatState | null;
}

/**
 * The side thread open next to the chat (D-232), and which answers of the
 * open conversation have one. The live feed of the page passes its frames
 * here too (`onLive`): replies streaming in the side thread, its new
 * messages, its tasks moving. Events carry ids only, as everywhere.
 */
export function createSideChat(api: SideApi) {
  const panel = shallowRef<SidePanel | null>(null);
  const tasks = ref<Record<string, Task>>({});
  /** The side threads of the open conversation, by the answer they are about. */
  const sides = ref<Map<string, string>>(new Map());
  let sidesOf: string | null = null;
  const sending = ref(false);
  /** A question waits in the queue of the side thread (D-218): an answer of it is still at work. */
  const queued = ref(false);
  const error = ref<string | null>(null);

  /** The side threads of the conversation now open in the chat; empty for none. */
  async function loadSides(motherId: string | null): Promise<void> {
    sidesOf = motherId;
    if (motherId === null) {
      sides.value = new Map();
      return;
    }
    const listed = await api.listSides(motherId).catch(() => []);
    if (sidesOf === motherId) sides.value = sidesByMessage(listed);
  }

  async function refreshTask(id: string): Promise<void> {
    const task = await api.loadTask(id);
    tasks.value = { ...tasks.value, [id]: task };
  }

  async function refresh(): Promise<void> {
    const state = panel.value;
    if (state?.conversation == null || state.chat === null) return;
    const id = state.conversation.id;
    const messages = await api.listMessages(id);
    const now = panel.value;
    if (now?.conversation?.id !== id || now.chat === null) return;
    panel.value = { ...now, chat: mergeMessages(now.chat, messages) };
    await Promise.all(taskIds(panel.value.chat ?? emptyChat(id)).map(refreshTask));
  }

  /** The answer the panel is on now, read fresh after an await. */
  function currentOrigin(): string | undefined {
    return panel.value?.origin.id;
  }

  /** «Chiedi a lato» on an answer: the panel opens on its side thread, the same one as before when there is one. */
  async function open(motherId: string, origin: Message): Promise<void> {
    error.value = null;
    queued.value = false;
    tasks.value = {};
    panel.value = { motherId, origin, conversation: null, chat: null };
    const existing = sidesOf === motherId ? sides.value.get(origin.id) : undefined;
    if (existing === undefined) return;
    try {
      const conversation = await api.loadConversation(existing);
      // Closed or moved to another answer while it loaded.
      if (currentOrigin() !== origin.id) return;
      panel.value = { motherId, origin, conversation, chat: emptyChat(conversation.id) };
      await refresh();
    } catch (cause) {
      error.value = `${SIDE_LOAD_ERROR} ${errorText(cause)}`;
    }
  }

  function close(): void {
    panel.value = null;
    tasks.value = {};
    queued.value = false;
    error.value = null;
  }

  /** A question in the side thread; the side thread is created with the first one. False when it did not leave. */
  async function send(body: string): Promise<boolean> {
    const state = panel.value;
    if (state === null || sending.value || body.trim() === '') return false;
    sending.value = true;
    error.value = null;
    try {
      let conversation = state.conversation;
      if (conversation === null) {
        conversation = await api.openSide(state.motherId, state.origin.id);
        if (sidesOf === state.motherId) sides.value = new Map([...sides.value, [state.origin.id, conversation.id]]);
        if (panel.value?.origin.id !== state.origin.id) return false;
        panel.value = { ...panel.value, conversation, chat: emptyChat(conversation.id) };
      }
      const sent = await api.sendMessage(conversation.id, body);
      const now = panel.value;
      if (now?.conversation?.id !== conversation.id || now.chat === null) return true;
      if ('queued' in sent) {
        queued.value = true;
        return true;
      }
      panel.value = { ...now, chat: mergeMessages(now.chat, [sent.message]) };
      tasks.value = { ...tasks.value, [sent.task.id]: sent.task };
      return true;
    } catch (cause) {
      error.value = errorText(cause);
      return false;
    } finally {
      sending.value = false;
    }
  }

  /** The id of the side thread open in the panel, if any: the page reads it as being looked at. */
  function openId(): string | null {
    return panel.value?.conversation?.id ?? null;
  }

  /** A frame of the live feed: only what concerns the side thread in the panel, or the side threads of the open conversation. */
  function onLive(message: ServerMessage): void {
    // Connected again (also after a restart of the core): what changed meanwhile is read again.
    if (message.type === 'ready') {
      void refresh().catch(() => undefined);
      void loadSides(sidesOf);
      return;
    }
    const state = panel.value;
    const id = state?.conversation?.id;
    if (message.type === 'delta') {
      if (state?.chat != null && message.conversationId === id) panel.value = { ...state, chat: applyDelta(state.chat, message) };
      return;
    }
    if (message.type !== 'event') return;
    const { event } = message;
    const conversationId = payloadString(event, 'conversationId');
    // The conversation (or the side thread) deleted: the panel has nothing left to show.
    if (event.kind === 'conversation.purged' && conversationId !== undefined && (conversationId === id || conversationId === state?.motherId)) {
      close();
      return;
    }
    if (id === undefined) return;
    if (event.kind === 'message.created' && conversationId === id) {
      const replyId = payloadString(event, 'replyId');
      void refresh()
        .then(() => {
          const now = panel.value;
          if (replyId !== undefined && now?.chat != null) panel.value = { ...now, chat: settleReply(now.chat, replyId) };
        })
        .catch(() => undefined);
      return;
    }
    // The queue of the side thread moved (D-218): whether a question still waits there.
    if (event.kind === 'conversation.queue' && conversationId === id) {
      void api
        .loadQueue(id)
        .then((queue) => {
          if (panel.value?.conversation?.id === id) queued.value = queue.messages.length > 0;
        })
        .catch(() => undefined);
      return;
    }
    if (event.kind.startsWith('task.') && event.taskId !== null && event.taskId in tasks.value) void refreshTask(event.taskId).catch(() => undefined);
  }

  return { panel, tasks, sides, sending, queued, error, loadSides, open, close, send, refresh, openId, onLive };
}

export type SideChat = ReturnType<typeof createSideChat>;

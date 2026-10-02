import { computed, ref, shallowRef } from 'vue';

import * as api from './lib/api.ts';
import { applyDelta, emptyChat, mergeMessages, settleReply, taskIds, type ChatState } from './lib/chat-state.ts';
import { errorText } from './lib/italian.ts';
import { connectLive, type LiveConnection, type LiveState, type SocketLike } from './lib/live.ts';
import { payloadString, type ServerMessage } from './lib/protocol.ts';
import { addRemoteDecision, remoteDecision, type RemoteDecision } from './lib/remote-decisions.ts';
import type { Approval, Conversation, ConversationMode, Task } from './lib/types.ts';

/**
 * State of the page. Every change comes from the API; the socket only says
 * what changed (events carry ids, never content) and streams the answers.
 */
export function createChatStore() {
  const conversations = ref<Conversation[]>([]);
  const chat = shallowRef<ChatState | null>(null);
  const tasks = ref<Record<string, Task>>({});
  const approvals = ref<Approval[]>([]);
  /** Approvals decided from Telegram (or the phone) while the page was open. */
  const remoteDecisions = ref<RemoteDecision[]>([]);
  const live = ref<LiveState>('connecting');
  const error = ref<string | null>(null);
  const sending = ref(false);
  let connection: LiveConnection | undefined;

  const current = computed(() => conversations.value.find((conversation) => conversation.id === chat.value?.conversationId));

  function fail(cause: unknown): void {
    error.value = errorText(cause);
  }

  async function refreshConversations(): Promise<void> {
    conversations.value = await api.listConversations();
  }

  async function refreshApprovals(): Promise<void> {
    approvals.value = await api.listPendingApprovals();
  }

  async function refreshTask(id: string): Promise<void> {
    const task = await api.loadTask(id);
    tasks.value = { ...tasks.value, [id]: task };
  }

  async function refreshMessages(): Promise<void> {
    const state = chat.value;
    if (state === null) return;
    const messages = await api.listMessages(state.conversationId);
    // The user may have opened another conversation meanwhile.
    if (chat.value?.conversationId !== state.conversationId) return;
    chat.value = mergeMessages(chat.value, messages);
    await Promise.all(taskIds(chat.value).map(refreshTask));
  }

  async function open(id: string): Promise<void> {
    error.value = null;
    chat.value = emptyChat(id);
    tasks.value = {};
    try {
      await refreshMessages();
    } catch (cause) {
      fail(cause);
    }
  }

  async function create(mode: ConversationMode, workspace?: string): Promise<void> {
    error.value = null;
    try {
      const conversation = await api.createConversation(mode, workspace);
      conversations.value = [conversation, ...conversations.value.filter((item) => item.id !== conversation.id)];
      await open(conversation.id);
    } catch (cause) {
      fail(cause);
    }
  }

  async function send(body: string): Promise<boolean> {
    const state = chat.value;
    if (state === null || body.trim() === '') return false;
    error.value = null;
    sending.value = true;
    try {
      const { message, task } = await api.sendMessage(state.conversationId, body);
      if (chat.value?.conversationId === state.conversationId) chat.value = mergeMessages(chat.value, [message]);
      tasks.value = { ...tasks.value, [task.id]: task };
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      sending.value = false;
    }
  }

  async function decide(approval: Approval, state: 'approved' | 'rejected'): Promise<void> {
    error.value = null;
    try {
      await api.decide(approval.id, state);
      approvals.value = approvals.value.filter((item) => item.id !== approval.id);
    } catch (cause) {
      fail(cause);
      await refreshApprovals();
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshConversations(), refreshApprovals(), refreshMessages()]);
  }

  function onLive(message: ServerMessage): void {
    if (message.type === 'ready') {
      void refreshAll().catch(fail);
      return;
    }
    if (message.type === 'delta') {
      if (chat.value !== null) chat.value = applyDelta(chat.value, message);
      return;
    }
    const { event } = message;
    const conversationId = payloadString(event, 'conversationId');
    const known = event.taskId !== null && event.taskId in tasks.value;
    const work: Promise<unknown>[] = [];
    switch (event.kind) {
      case 'conversation.created':
        work.push(refreshConversations());
        break;
      case 'message.created': {
        work.push(refreshConversations());
        if (conversationId !== undefined && conversationId === chat.value?.conversationId) {
          const replyId = payloadString(event, 'replyId');
          work.push(
            refreshMessages().then(() => {
              if (replyId !== undefined && chat.value !== null) chat.value = settleReply(chat.value, replyId);
            }),
          );
        }
        break;
      }
      case 'approval.decided': {
        // Read the action from the card before the refresh takes it away.
        const id = payloadString(event, 'approvalId');
        const decision = remoteDecision(event, approvals.value.find((approval) => approval.id === id)?.action);
        if (decision !== undefined) remoteDecisions.value = addRemoteDecision(remoteDecisions.value, decision);
        work.push(refreshApprovals());
        if (known && event.taskId !== null) work.push(refreshTask(event.taskId));
        break;
      }
      case 'approval.requested':
        work.push(refreshApprovals());
        if (known && event.taskId !== null) work.push(refreshTask(event.taskId));
        break;
      default:
        if (event.kind.startsWith('task.') && known && event.taskId !== null) work.push(refreshTask(event.taskId));
    }
    void Promise.all(work).catch(fail);
  }

  function start(): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    connection = connectLive({
      url: `${scheme}://${window.location.host}/api/ws`,
      onMessage: onLive,
      onState: (state) => {
        live.value = state;
      },
      createSocket: (url) => {
        const ws = new WebSocket(url);
        const socket: SocketLike = {
          onmessage: null,
          onclose: null,
          onerror: null,
          close: () => {
            ws.close();
          },
        };
        ws.onmessage = (event: MessageEvent) => socket.onmessage?.({ data: event.data });
        ws.onclose = () => socket.onclose?.();
        ws.onerror = () => socket.onerror?.();
        return socket;
      },
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => {
        window.clearTimeout(handle as number);
      },
      random: Math.random,
    });
  }

  function dismissDecision(approvalId: string): void {
    remoteDecisions.value = remoteDecisions.value.filter((decision) => decision.approvalId !== approvalId);
  }

  function stop(): void {
    connection?.close();
  }

  return { conversations, chat, current, tasks, approvals, remoteDecisions, live, error, sending, open, create, send, decide, dismissDecision, start, stop };
}

export type ChatStore = ReturnType<typeof createChatStore>;

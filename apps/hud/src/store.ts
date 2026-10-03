import { computed, ref, shallowRef } from 'vue';

import * as api from './lib/api.ts';
import { applyActivity, applyDelta, emptyChat, mergeMessages, settleReply, taskIds, type ChatState } from './lib/chat-state.ts';
import { errorText } from './lib/italian.ts';
import { connectLive, type LiveConnection, type LiveState, type SocketLike } from './lib/live.ts';
import { payloadString, type ServerMessage } from './lib/protocol.ts';
import { loadDismissed, remoteDecisions as notesFrom, saveDismissed, type RemoteDecision } from './lib/remote-decisions.ts';
import type { Approval, CloudModel, Conversation, ConversationMode, ProjectInfo, Task } from './lib/types.ts';

/**
 * State of the page. Every change comes from the API; the socket only says
 * what changed (events carry ids, never content) and streams the answers.
 */
export function createChatStore() {
  const conversations = ref<Conversation[]>([]);
  /** Archived conversations, shown in their own section (D-057). */
  const archived = ref<Conversation[]>([]);
  /** The open conversation when it is in neither list (an archived one beyond the first page). */
  const detached = ref<Conversation | undefined>(undefined);
  const chat = shallowRef<ChatState | null>(null);
  const tasks = ref<Record<string, Task>>({});
  const approvals = ref<Approval[]>([]);
  /** The cloud models a work conversation may choose (task 1.10). */
  const models = ref<CloudModel[]>([]);
  /** The approved projects (D-058); the list changes without a restart, so it is read again when needed. */
  const projects = ref<ProjectInfo[]>([]);
  /** Approvals decided from Telegram (or the phone) while the page was open. */
  const remoteDecisions = ref<RemoteDecision[]>([]);
  const storage = typeof window === 'undefined' ? undefined : window.localStorage;
  const dismissed = loadDismissed(storage);
  let decided: Approval[] = [];
  const live = ref<LiveState>('connecting');
  const error = ref<string | null>(null);
  const sending = ref(false);
  let connection: LiveConnection | undefined;

  const current = computed(() =>
    [...conversations.value, ...archived.value, ...(detached.value === undefined ? [] : [detached.value])].find(
      (conversation) => conversation.id === chat.value?.conversationId,
    ),
  );

  function fail(cause: unknown): void {
    error.value = errorText(cause);
  }

  async function refreshConversations(): Promise<void> {
    conversations.value = await api.listConversations();
    await keepCurrent();
  }

  /** Both lists: after an archive or a restore, and at the start. */
  async function refreshAllConversations(): Promise<void> {
    const [listed, archivedList] = await Promise.all([api.listConversations(), api.listConversations(true)]);
    conversations.value = listed;
    archived.value = archivedList;
    await keepCurrent();
  }

  /** The open conversation stays shown even when no list holds it. */
  async function keepCurrent(): Promise<void> {
    const id = chat.value?.conversationId;
    const listed = (conversation: Conversation): boolean => conversation.id === id;
    if (id === undefined || conversations.value.some(listed) || archived.value.some(listed)) {
      detached.value = undefined;
      return;
    }
    const conversation = await api.loadConversation(id);
    if (chat.value?.conversationId === id) detached.value = conversation;
  }

  /** Renames a conversation; false if the core refused the title. */
  async function rename(id: string, title: string): Promise<boolean> {
    error.value = null;
    try {
      const updated = await api.renameConversation(id, title);
      conversations.value = conversations.value.map((item) => (item.id === updated.id ? updated : item));
      archived.value = archived.value.map((item) => (item.id === updated.id ? updated : item));
      if (detached.value?.id === updated.id) detached.value = updated;
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    }
  }

  /** Deletes an archived conversation for good; closes it if it is open. */
  async function purge(id: string): Promise<void> {
    error.value = null;
    try {
      await api.purgeConversation(id);
      forget(id);
      await Promise.all([refreshAllConversations(), refreshApprovals()]);
    } catch (cause) {
      fail(cause);
      // Another tab may have deleted it already.
      await refreshAllConversations().catch(() => undefined);
    }
  }

  function forget(id: string): void {
    archived.value = archived.value.filter((item) => item.id !== id);
    if (chat.value?.conversationId === id) {
      chat.value = null;
      detached.value = undefined;
      tasks.value = {};
    }
  }

  /** Archives a conversation or brings it back to the list; the open one stays open. */
  async function archive(id: string, value: boolean): Promise<void> {
    error.value = null;
    try {
      await api.archiveConversation(id, value);
      await refreshAllConversations();
    } catch (cause) {
      fail(cause);
    }
  }

  async function refreshModels(): Promise<void> {
    models.value = await api.listModels();
  }

  async function refreshProjects(): Promise<void> {
    try {
      projects.value = await api.listProjects();
    } catch (cause) {
      fail(cause);
    }
  }

  /** Chooses the model of the open work conversation; null lets the router choose. */
  async function chooseModel(model: string | null): Promise<void> {
    const state = chat.value;
    if (state === null) return;
    error.value = null;
    try {
      const updated = await api.setModel(state.conversationId, model);
      conversations.value = conversations.value.map((item) => (item.id === updated.id ? updated : item));
    } catch (cause) {
      fail(cause);
    }
  }

  async function refreshApprovals(): Promise<void> {
    const [pending, approved, rejected] = await Promise.all([
      api.listPendingApprovals(),
      api.listDecidedApprovals('approved'),
      api.listDecidedApprovals('rejected'),
    ]);
    approvals.value = pending;
    decided = [...approved, ...rejected];
    showNotes();
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
    detached.value = undefined;
    tasks.value = {};
    try {
      await refreshMessages();
    } catch (cause) {
      fail(cause);
    }
  }

  async function create(mode: ConversationMode, project?: string): Promise<void> {
    error.value = null;
    try {
      const conversation = await api.createConversation(mode, project);
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
    await Promise.all([refreshAllConversations(), refreshApprovals(), refreshMessages(), refreshModels(), refreshProjects()]);
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
    if (message.type === 'activity') {
      if (chat.value !== null) chat.value = applyActivity(chat.value, message);
      return;
    }
    const { event } = message;
    const conversationId = payloadString(event, 'conversationId');
    const known = event.taskId !== null && event.taskId in tasks.value;
    const work: Promise<unknown>[] = [];
    switch (event.kind) {
      case 'conversation.created':
      case 'conversation.model':
        work.push(refreshConversations());
        break;
      case 'conversation.title':
      case 'conversation.archived':
        work.push(refreshAllConversations());
        break;
      case 'conversation.purged':
        if (conversationId !== undefined) forget(conversationId);
        work.push(refreshAllConversations(), refreshApprovals());
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
      case 'approval.decided':
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

  function showNotes(): void {
    remoteDecisions.value = notesFrom(decided, Date.now(), dismissed);
  }

  function dismissDecision(approvalId: string): void {
    dismissed.add(approvalId);
    saveDismissed(storage, dismissed, new Set(decided.map((approval) => approval.id)));
    showNotes();
  }

  function stop(): void {
    connection?.close();
  }

  return { conversations, archived, chat, current, tasks, approvals, models, projects, refreshProjects, remoteDecisions, live, error, sending, open, create, send, decide, chooseModel, rename, archive, purge, dismissDecision, start, stop };
}

export type ChatStore = ReturnType<typeof createChatStore>;

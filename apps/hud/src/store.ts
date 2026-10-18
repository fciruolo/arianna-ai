import { computed, ref, shallowRef, watch, type Ref } from 'vue';

import * as api from './lib/api.ts';
import type { ThemeListing } from './lib/themes.ts';
import { startCall as openCallSession, type CallSession } from './lib/call-session.ts';
import { callErrorText, draftCallee, type CallInfo } from './lib/calls.ts';
import { applyActivity, applyDelta, applyEdit, applyTerminal, emptyChat, mergeMessages, restoreActivity, settleReply, taskIds, type ChatState } from './lib/chat-state.ts';
import { commandError, parseNoteCommand, savedText } from './lib/capture.ts';
import { keepRefused, removeDraft } from './lib/composer.ts';
import { goesToArianna, reachesCore, resolveDraft } from './lib/commands.ts';
import type { PlanChoice } from './lib/plan-approval.ts';
import { choiceAgent, choiceCharacter, draftStep, firstMessageProblem, type Draft, type DraftChoice } from './lib/draft.ts';
import { creditsByMessage, hasCredit } from './lib/delegations.ts';
import { eraseFailedText } from './lib/erase.ts';
import { claudeAnswersSystemChat } from './lib/failures.ts';
import { closedCause, closedText, closingLines, closingSoonText, endRetryDelay, incognitoAction, officeMayNote, noteRefusal, withoutIncognito, type CloseCause, type IncognitoSignal } from './lib/incognito.ts';
import { errorText } from './lib/italian.ts';
import { connectLive, type LiveConnection, type LiveState, type SocketLike } from './lib/live.ts';
import { payloadString, type ServerMessage } from './lib/protocol.ts';
import { rememberCharacterNames } from './lib/character-names.ts';
import { chatCast, rememberChatCast } from './lib/character-chat.ts';
import { reportThisMac } from './lib/push.ts';
import { noticeUrl, noticeWhere, permissionNow, pushToast, showNotice, type Toast } from './lib/notices.ts';
import { emptySignals, noteActivity, notePause, type OfficeSignals } from './lib/office/signals.ts';
import { loadDismissed, remoteDecisions as notesFrom, saveDismissed, type RemoteDecision } from './lib/remote-decisions.ts';
import { withoutParticipant } from './lib/participants.ts';
import { isSecretaryPath } from './lib/route.ts';
import { splittable } from './lib/split.ts';
import { DESIGNER_AGENT as STUDIO_AGENT, type MessageDesign } from './lib/studio.ts';
import type { Approval, AttachmentInfo, CharacterListing, CloudModel, Conversation, ConversationMode, DirectAgent, ExecutorChoice, OffInterlocutor, MessageCredit, Participant, ProjectInfo, QueueView, StatusSnapshot, Task, TaskFailure } from './lib/types.ts';

/** The events after which the cardwall reads its cards again (I-13, D-152). */
const CARD_EVENTS: ReadonlySet<string> = new Set(['task.created', 'task.status', 'task.blocked', 'task.unblocked', 'card.changed', 'commitment.changed']);

/**
 * The lists of the page, given to a second store (D-234): the conversation
 * beside reads them from the first one, which keeps them up to date.
 */
export interface SharedLists {
  conversations: Ref<Conversation[]>;
  archived: Ref<Conversation[]>;
  systemChats: Ref<Conversation[]>;
}

/**
 * State of the page. Every change comes from the API; the socket only says
 * what changed (events carry ids, never content) and streams the answers.
 *
 * With `beside` (D-234, «Affianca») this is the store of the conversation
 * shown beside the open one: it holds only that conversation (messages,
 * tasks, queue, participants) and shares the lists of the first store. It has
 * no socket of its own (the first store passes it the live feed with
 * `listenLive`), shows no notice, rings no call and reads nothing global:
 * approvals, models, projects, the status and the characters stay with the first.
 */
export function createChatStore(options: { beside?: SharedLists } = {}) {
  const beside = options.beside !== undefined;
  const conversations = options.beside?.conversations ?? ref<Conversation[]>([]);
  /** Archived conversations, shown in their own section (D-057). */
  const archived = options.beside?.archived ?? ref<Conversation[]>([]);
  /** System chats, opened by the system (D-064): their own section, between the two. */
  const systemChats = options.beside?.systemChats ?? ref<Conversation[]>([]);
  /** The failed task whose error window is open, with its error once read. */
  /** The failure window; `claudeAnswers`: Claude can answer the task's system chat (D-064). */
  const failure = ref<{ task: Task; error: TaskFailure | null; loading: boolean; claudeAnswers: boolean } | null>(null);
  /** The open conversation when it is in neither list (an archived one beyond the first page). */
  const detached = ref<Conversation | undefined>(undefined);
  const chat = shallowRef<ChatState | null>(null);
  /** A new conversation not yet in the core (D-108): it is created with the first message. */
  const draft = ref<Draft | null>(null);
  let draftKey = 0;
  const tasks = ref<Record<string, Task>>({});
  /** Who wrote the cloud answers of the open conversation, and the files of each run (D-082). */
  const credits = ref<Map<string, MessageCredit>>(new Map());
  /** Saved activity lines per task of the open conversation (D-083). */
  const activityCounts = ref<Record<string, number>>({});
  const approvals = ref<Approval[]>([]);
  /** Goes up when a card of the cardwall or a commitment may have changed (I-13, D-152): the page reads the wall again. */
  const cardsVersion = ref(0);
  /** Grows at every event of a routine (D-254): the page «Routine» reads them again. */
  const routinesVersion = ref(0);
  /** The agents in the open conversation besides Arianna and the user (D-125). */
  const participants = ref<Participant[]>([]);
  /** A message the core refused: the page puts it back in the field, never lost (D-219). */
  const refusedDraft = ref<{ conversationId: string; body: string; at: number; attachments?: AttachmentInfo[] } | null>(null);
  /** Who «@» may call in a conversation with Arianna (D-107, tappa B2), read with the projects. */
  const mentionable = ref<string[]>([]);
  /** The messages of the open conversation waiting for the answer at work (D-218). */
  const queue = ref<QueueView>({ paused: false, messages: [] });
  /** The cloud models a work conversation may choose (task 1.10). */
  const models = ref<CloudModel[]>([]);
  /** The approved projects (D-058); the list changes without a restart, so it is read again when needed. */
  const projects = ref<ProjectInfo[]>([]);
  /** Who the user may talk with directly (D-111d), as their cards allow. */
  const directAgents = ref<DirectAgent[]>([]);
  /** «Con chi parli» (D-111, tappa B): who cannot answer now, shown off in "+ Nuovo". */
  const offInterlocutors = ref<OffInterlocutor[]>([]);
  /** Approvals decided from Telegram (or the phone) while the page was open. */
  const remoteDecisions = ref<RemoteDecision[]>([]);
  const storage = typeof window === 'undefined' ? undefined : window.localStorage;
  const dismissed = loadDismissed(storage);
  let decided: Approval[] = [];
  /** The status panel (D-060), read again after events: counts and labels only. */
  const status = ref<StatusSnapshot | null>(null);
  /**
   * What the office (D-106) may know of the live feed: the kind of the latest
   * activity line per conversation (never its detail) and the agents paused
   * by a quota of their executor, until when (with the agent of each run seen
   * starting: the quota event names only its run). Signals only, never text.
   */
  const officeSignals = ref<OfficeSignals>(emptySignals());
  /** Character packs and who wears what; read at the start and when the panel asks. */
  const characters = ref<CharacterListing | null>(null);
  /** The themes of the chat (D-103); null until read, and Base while it is. */
  const themes = ref<ThemeListing | null>(null);
  let statusTimer: number | undefined;
  let statusPoll: number | undefined;
  let stopOpenWatch: (() => void) | undefined;
  const live = ref<LiveState>('connecting');
  const error = ref<string | null>(null);
  const sending = ref(false);
  /** "Nota salvata in kb/inbox/… (L2)" after a "/nota" (D-080): path and label, never the text. */
  const notice = ref<string | null>(null);
  /** The notices shown inside the chat (I-1), newest last, at most three. */
  const toasts = ref<Toast[]>([]);
  let toastSeq = 0;
  /** Calls (D-066): the receipts of the open conversation, the state of the voice, the call in progress. */
  const calls = ref<CallInfo[]>([]);
  const voiceState = ref<string | null>(null);
  const callSession = shallowRef<CallSession | null>(null);
  const callStarting = ref(false);
  const callError = ref<string | null>(null);
  /** A call still open on the core that this page does not hold (it was reloaded): it can be closed. */
  const strayCall = ref<CallInfo | null>(null);
  /** A call of Arianna ringing now (D-066): answer or decline. */
  const incoming = ref<{ callId: string; conversationId: string; reason: 'waiting' | 'task-done' | 'scheduled' } | null>(null);
  let connection: LiveConnection | undefined;
  /**
   * Incognito (D-136): the card shown in place of a conversation that closed,
   * with the counts the core gave after "Termina", or why it closed. Texts of
   * the conversation are never kept here.
   */
  const incognitoEnd = ref<{ kind: 'ended'; lines: string[] } | { kind: 'closed'; text: string } | null>(null);
  /** "Si chiude fra 1 minuto": the warning of the core before the closing for inactivity. */
  const incognitoSoon = ref<string | null>(null);
  let soonTimer: number | undefined;
  /** Incognito conversations this page saw close: "back" to one shows that it is closed, without asking the core. */
  const endedIncognito = new Set<string>();
  /** Every incognito conversation this page has seen, open or closed: its live lines never reach the office. */
  const knownIncognito = new Set<string>();
  const ending = ref(false);

  const current = computed(() =>
    [...conversations.value, ...systemChats.value, ...archived.value, ...(detached.value === undefined ? [] : [detached.value])].find(
      (conversation) => conversation.id === chat.value?.conversationId,
    ),
  );

  function fail(cause: unknown): void {
    error.value = errorText(cause);
  }

  async function refreshConversations(): Promise<void> {
    // The store beside (D-234): the first store reads the lists, this one only keeps its conversation.
    if (beside) {
      await keepCurrent();
      return;
    }
    const [listed, system] = await Promise.all([api.listConversations(), api.listSystemChats()]);
    conversations.value = listed;
    systemChats.value = system;
    await keepCurrent();
  }

  /** Every list: after an archive or a restore, and at the start. */
  async function refreshAllConversations(): Promise<void> {
    if (beside) {
      await keepCurrent();
      return;
    }
    const [listed, system, archivedList] = await Promise.all([api.listConversations(), api.listSystemChats(), api.listConversations(true)]);
    conversations.value = listed;
    systemChats.value = system;
    archived.value = archivedList;
    await keepCurrent();
  }

  /** The open conversation stays shown even when no list holds it. */
  async function keepCurrent(): Promise<void> {
    const id = chat.value?.conversationId;
    const listed = (conversation: Conversation): boolean => conversation.id === id;
    if (id === undefined || conversations.value.some(listed) || systemChats.value.some(listed) || archived.value.some(listed)) {
      detached.value = undefined;
      return;
    }
    let conversation: Conversation;
    try {
      conversation = await api.loadConversation(id);
    } catch (cause) {
      // An incognito conversation the core deleted meanwhile: its card, not an error.
      const incognito = (detached.value?.id === id && detached.value.incognito === true) || (cause instanceof api.ApiError && closedCause(cause.body) !== undefined);
      if (gone(cause) && incognito) {
        closeIncognito(id, causeOf(cause, 'gone'));
        return;
      }
      throw cause;
    }
    if (conversation.incognito === true) knownIncognito.add(conversation.id);
    if (chat.value?.conversationId === id) detached.value = conversation;
  }

  function gone(cause: unknown): boolean {
    return cause instanceof api.ApiError && cause.status === 404;
  }

  /** The cause the core gives with the 404 of a closed incognito conversation, else what the page can say. */
  function causeOf(cause: unknown, otherwise: 'gone' | 'lost'): CloseCause | 'gone' | 'lost' {
    return (cause instanceof api.ApiError ? closedCause(cause.body) : undefined) ?? otherwise;
  }

  /** The open incognito conversation, or the one its draft already created. */
  function incognitoIds(): (string | null)[] {
    return [current.value?.incognito === true ? current.value.id : null, draft.value?.incognito === true ? draft.value.conversationId : null];
  }

  /** Forgets every text of an incognito conversation the page holds, and shows why it is gone. */
  function closeIncognito(id: string, cause: CloseCause | 'gone' | 'lost'): void {
    endedIncognito.add(id);
    knownIncognito.add(id);
    discardIncognito();
    incognitoEnd.value = { kind: 'closed', text: closedText(cause) };
  }

  function discardIncognito(): void {
    // Its approvals go at once, whether or not the list can be read again.
    const own = new Set(Object.keys(tasks.value));
    approvals.value = approvals.value.filter((approval) => approval.taskId === null || !own.has(approval.taskId));
    close();
    credits.value = new Map();
    activityCounts.value = {};
    participants.value = [];
    notice.value = null;
    clearSoon();
    // Its approvals, if any were waiting, are gone with it.
    void refreshApprovals().catch(() => undefined);
  }

  function clearSoon(): void {
    window.clearTimeout(soonTimer);
    soonTimer = undefined;
    incognitoSoon.value = null;
  }

  /** "Termina" (D-136): the core stops the work and deletes; the card shows what it deleted and what stays outside. */
  async function endIncognito(): Promise<void> {
    const id = current.value?.incognito === true ? current.value.id : undefined;
    if (id === undefined || ending.value) return;
    error.value = null;
    ending.value = true;
    try {
      let result: Awaited<ReturnType<typeof api.endIncognito>>;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await api.endIncognito(id);
          break;
        } catch (cause) {
          // The work is stopping (409 "still at work"): asked again a few times, then the error is said.
          const wait = cause instanceof api.ApiError ? endRetryDelay(cause.status, cause.message, attempt) : undefined;
          if (wait === undefined) throw cause;
          await new Promise((resolve) => window.setTimeout(resolve, wait));
        }
      }
      endedIncognito.add(id);
      discardIncognito();
      incognitoEnd.value = { kind: 'ended', lines: closingLines(result) };
    } catch (cause) {
      if (gone(cause)) closeIncognito(id, causeOf(cause, 'gone'));
      else fail(cause);
    } finally {
      ending.value = false;
    }
  }

  /**
   * An incognito conversation from the state of its history entry (back,
   * reload): opened if the core still has it, else the card that says it is closed.
   */
  async function openIncognito(id: string): Promise<void> {
    if (endedIncognito.has(id)) {
      close();
      incognitoEnd.value = { kind: 'closed', text: closedText('gone') };
      return;
    }
    try {
      const conversation = await api.loadConversation(id);
      await open(id, conversation);
    } catch (cause) {
      if (gone(cause)) closeIncognito(id, causeOf(cause, 'gone'));
      else fail(cause);
    }
  }

  /** The link came back: an incognito conversation open on this page may have closed meanwhile (a restart, 10 minutes). */
  async function checkIncognito(): Promise<void> {
    const id = current.value?.incognito === true ? current.value.id : undefined;
    if (id === undefined) return;
    try {
      await api.loadConversation(id);
    } catch (cause) {
      if (gone(cause) && current.value?.id === id) closeIncognito(id, causeOf(cause, 'lost'));
    }
  }

  function onIncognito(signal: IncognitoSignal): void {
    const action = incognitoAction(signal, incognitoIds(), endedIncognito);
    if (action === 'ignore') return;
    if (signal.type === 'conversation.incognito-closed') {
      closeIncognito(signal.conversationId, signal.cause);
      return;
    }
    // This page is on it: say so again, and warn until the minute is over.
    tellVisibility();
    window.clearTimeout(soonTimer);
    incognitoSoon.value = closingSoonText(signal.inSeconds);
    soonTimer = window.setTimeout(clearSoon, signal.inSeconds * 1000);
  }

  /** Renames a conversation; false if the core refused the title. */
  async function rename(id: string, title: string): Promise<boolean> {
    error.value = null;
    try {
      const updated = await api.renameConversation(id, title);
      conversations.value = conversations.value.map((item) => (item.id === updated.id ? updated : item));
      systemChats.value = systemChats.value.map((item) => (item.id === updated.id ? updated : item));
      archived.value = archived.value.map((item) => (item.id === updated.id ? updated : item));
      if (detached.value?.id === updated.id) detached.value = updated;
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    }
  }

  /** "Elimina" (D-157): the conversation goes for good, from the list or the archive; closes it if it is open. */
  async function erase(id: string): Promise<void> {
    error.value = null;
    try {
      await api.eraseConversation(id);
      forget(id);
      await Promise.all([refreshAllConversations(), refreshApprovals()]);
    } catch (cause) {
      error.value = eraseFailedText(cause instanceof api.ApiError ? cause.status : undefined);
      // Another tab may have deleted it already.
      await refreshAllConversations().catch(() => undefined);
    }
  }

  /** After an erase elsewhere (the `events.rewoven` line, D-157): the lists again, and the open conversation closed if it is gone. */
  async function afterErase(): Promise<void> {
    const id = chat.value?.conversationId;
    if (id !== undefined && !knownIncognito.has(id)) {
      try {
        await api.loadConversation(id);
      } catch (cause) {
        if (gone(cause)) forget(id);
      }
    }
    await Promise.all([refreshAllConversations(), refreshApprovals()]);
  }

  function forget(id: string): void {
    conversations.value = conversations.value.filter((item) => item.id !== id);
    systemChats.value = systemChats.value.filter((item) => item.id !== id);
    archived.value = archived.value.filter((item) => item.id !== id);
    // Its unsent text kept in this browser (D-231) goes with it.
    removeDraft(storage, id);
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

  async function refreshQueue(): Promise<void> {
    const id = chat.value?.conversationId;
    if (id === undefined) return;
    const read = await api.loadQueue(id);
    if (chat.value?.conversationId === id) queue.value = read;
  }

  /** One action on the queue or "Ferma" (D-218): the queue is read again after it, an error shows as the others. */
  async function onQueue(action: () => Promise<unknown>): Promise<boolean> {
    error.value = null;
    try {
      await action();
      await refreshQueue();
      return true;
    } catch (cause) {
      fail(cause);
      void refreshQueue().catch(() => undefined);
      return false;
    }
  }

  /** "Ferma": the answer at work stops; with messages in the queue, the queue pauses. */
  function stopAnswer(): Promise<boolean> {
    const id = chat.value?.conversationId;
    if (id === undefined) return Promise.resolve(false);
    return onQueue(() => api.stopConversation(id));
  }

  function editQueued(queuedId: string, body: string): Promise<boolean> {
    return onQueue(() => api.editQueued(queuedId, body));
  }

  function removeQueued(queuedId: string): Promise<boolean> {
    return onQueue(() => api.removeQueued(queuedId));
  }

  function sendQueuedNow(queuedId: string): Promise<boolean> {
    return onQueue(async () => {
      const { message, task } = await api.sendQueuedNow(queuedId);
      if (chat.value?.conversationId === message.conversationId) chat.value = mergeMessages(chat.value, [message]);
      tasks.value = { ...tasks.value, [task.id]: task };
    });
  }

  function resumeQueue(): Promise<boolean> {
    const id = chat.value?.conversationId;
    if (id === undefined) return Promise.resolve(false);
    return onQueue(() => api.resumeQueue(id));
  }

  async function refreshParticipants(): Promise<void> {
    const id = chat.value?.conversationId;
    if (id === undefined) return;
    const listed = await api.listParticipants(id);
    if (chat.value?.conversationId === id) participants.value = listed;
  }

  /** The user takes an agent out of the open conversation (D-125): the bar updates at once, the feed confirms it. */
  async function removeParticipant(agent: string): Promise<void> {
    const id = chat.value?.conversationId;
    if (id === undefined) return;
    error.value = null;
    try {
      await api.removeParticipant(id, agent);
      if (chat.value?.conversationId === id) participants.value = withoutParticipant(participants.value, agent);
    } catch (cause) {
      fail(cause);
      await refreshParticipants().catch(() => undefined);
    }
  }

  /** Pins a conversation at the top of the list, or unpins it (D-089). */
  async function pin(id: string, value: boolean): Promise<void> {
    error.value = null;
    try {
      await api.pinConversation(id, value);
      await refreshConversations();
    } catch (cause) {
      fail(cause);
    }
  }

  async function refreshModels(): Promise<void> {
    models.value = await api.listModels();
  }

  async function refreshProjects(): Promise<void> {
    try {
      // The agents too: who is active, and Claude on or off, change without a restart.
      const keep = { agents: directAgents.value, off: offInterlocutors.value, characters: chatCast.value };
      const [list, choices] = await Promise.all([api.listProjects(), api.listDirectChoices().catch(() => keep)]);
      projects.value = list;
      directAgents.value = choices.agents;
      offInterlocutors.value = choices.off;
      rememberChatCast(choices.characters);
      mentionable.value = await api.loadMentionable().catch(() => mentionable.value);
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

  /** Turns the switch «Personaggio» of the open conversation on or off (D-225). */
  async function chooseCharacter(on: boolean): Promise<void> {
    const state = chat.value;
    if (state === null) return;
    error.value = null;
    try {
      const updated = await api.setCharacter(state.conversationId, on);
      conversations.value = conversations.value.map((item) => (item.id === updated.id ? updated : item));
      systemChats.value = systemChats.value.map((item) => (item.id === updated.id ? updated : item));
      archived.value = archived.value.map((item) => (item.id === updated.id ? updated : item));
      if (detached.value?.id === updated.id) detached.value = updated;
    } catch (cause) {
      fail(cause);
    }
  }

  async function refreshApprovals(): Promise<void> {
    // The approvals are the first store's (D-234): it places them in each pane.
    if (beside) return;
    const [pending, approved, rejected] = await Promise.all([
      api.listPendingApprovals(),
      api.listDecidedApprovals('approved'),
      api.listDecidedApprovals('rejected'),
    ]);
    approvals.value = pending;
    // The notes of decisions taken elsewhere never name an incognito conversation's approval (D-136).
    decided = withoutIncognito([...approved, ...rejected]);
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
    await Promise.all([...taskIds(chat.value).map(refreshTask), refreshCredits(), refreshActivityCounts()]);
    // Not awaited: the card of the steps never holds back messages and replies.
    void restoreRunning();
  }

  /**
   * After a reload (or a reconnection) the live lines of a task still at work
   * are gone: the lines it saved so far come back (D-083), so the card keeps
   * showing what it is doing instead of vanishing.
   */
  async function restoreRunning(): Promise<void> {
    const state = chat.value;
    if (state === null) return;
    const running = taskIds(state).filter((id) => tasks.value[id]?.status === 'ready' || tasks.value[id]?.status === 'running');
    await Promise.all(
      running.map(async (id) => {
        // A conversation deleted meanwhile, the core restarting: the live lines stay as they are.
        const saved = await api.listActivities(id).catch(() => undefined);
        if (saved !== undefined && chat.value?.conversationId === state.conversationId) chat.value = restoreActivity(chat.value, id, saved);
      }),
    );
  }

  async function refreshActivityCounts(): Promise<void> {
    const state = chat.value;
    if (state === null || state.messages.every((message) => message.taskId === null)) return;
    const counts = await api.activityCounts(state.conversationId);
    if (chat.value?.conversationId === state.conversationId) activityCounts.value = counts;
  }

  async function refreshCredits(): Promise<void> {
    const state = chat.value;
    // Only a conversation with an answer written in the cloud has credits.
    if (state === null || !state.messages.some(hasCredit)) return;
    const listed = await api.listCredits(state.conversationId);
    if (chat.value?.conversationId === state.conversationId) credits.value = creditsByMessage(listed);
  }

  /** The "Segretaria" button (D-144): its conversation, created the first time, which no list holds. */
  async function openSecretary(): Promise<void> {
    try {
      const conversation = await api.openSecretary();
      await open(conversation.id, conversation);
    } catch (cause) {
      fail(cause);
    }
  }

  /**
   * The address `/segretaria` (D-156): a reload, a link or "back" opens the
   * secretary's conversation without a new session (D-146: only the button
   * opens one); the first time ever, when there is none yet, it is created as
   * by the button.
   */
  async function openSecretaryAddress(): Promise<void> {
    try {
      const found = await api.findSecretary();
      // The user went elsewhere meanwhile: the answer arrives late and opens nothing.
      if (!isSecretaryPath(window.location.pathname)) return;
      if (found !== null && chat.value?.conversationId === found.id) return;
      const conversation = found ?? (await api.openSecretary());
      if (!isSecretaryPath(window.location.pathname)) return;
      await open(conversation.id, conversation);
    } catch (cause) {
      fail(cause);
    }
  }

  /** `known`: the conversation when the page already has it, as an incognito one, which no list holds (D-136). */
  /** A conversation changed by the core (a new session of the Designer, D-185): the list and its messages read again. */
  async function reloadConversation(id: string): Promise<void> {
    await refreshConversations();
    if (chat.value?.conversationId === id) await open(id);
  }

  async function open(id: string, known?: Conversation): Promise<void> {
    error.value = null;
    draft.value = null;
    incognitoEnd.value = null;
    clearSoon();
    // Before the chat: the address follows the open conversation, and an incognito one has its own.
    detached.value = known?.id === id ? known : undefined;
    if (known?.incognito === true) knownIncognito.add(known.id);
    chat.value = emptyChat(id);
    tasks.value = {};
    credits.value = new Map();
    activityCounts.value = {};
    calls.value = [];
    participants.value = [];
    queue.value = { paused: false, messages: [] };
    try {
      // The store beside (D-234) first reads what the conversation is (an address, a link may name any id): an incognito
      // conversation, the secretary's or a side thread never stands beside, and nothing of it is read.
      if (beside) {
        await keepCurrent();
        if (openId() !== id) return;
        if (!splittable(current.value)) {
          close();
          return;
        }
      }
      await Promise.all([refreshMessages(), refreshCalls(), refreshParticipants(), refreshQueue()]);
    } catch (cause) {
      // Beside, a conversation the core does not have (erased, a wrong address) closes: nothing to show.
      // openId() reads the chat again after the await: the type narrowed by the assignment above hides that it may have changed.
      if (beside && gone(cause) && openId() === id) close();
      fail(cause);
    }
  }

  function openId(): string | undefined {
    return chat.value?.conversationId;
  }

  async function refreshCalls(): Promise<void> {
    const id = chat.value?.conversationId;
    if (id === undefined) return;
    const listed = await api.listConversationCalls(id);
    if (chat.value?.conversationId === id) calls.value = listed;
  }

  async function refreshVoice(): Promise<void> {
    try {
      voiceState.value = (await api.loadVoiceTrial()).state;
    } catch {
      voiceState.value = 'off';
    }
  }

  async function startCall(): Promise<void> {
    const id = chat.value?.conversationId;
    if (id === undefined || callSession.value !== null || callStarting.value) return;
    callError.value = null;
    callStarting.value = true;
    try {
      const session = await openCallSession({ conversationId: id });
      session.onDrop(() => {
        void hangUp();
      });
      callSession.value = session;
      await refreshCalls();
    } catch (cause) {
      callError.value =
        cause instanceof api.ApiError ? callErrorText(cause.message) : cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'Il browser non ha dato il microfono: consentilo e riprova.' : 'La chiamata non è partita.';
    } finally {
      callStarting.value = false;
    }
  }

  async function refreshStrayCall(): Promise<void> {
    const live = await api.loadLiveCall().catch(() => null);
    if (live?.status === 'ringing' && live.direction === 'out') {
      incoming.value = { callId: live.id, conversationId: live.conversationId, reason: live.reason ?? 'scheduled' };
      strayCall.value = null;
      return;
    }
    strayCall.value = live !== null && live.id !== callSession.value?.call.id ? live : null;
  }

  async function answerIncoming(): Promise<void> {
    const ringing = incoming.value;
    if (ringing === null || callSession.value !== null) return;
    incoming.value = null;
    callError.value = null;
    callStarting.value = true;
    try {
      const session = await openCallSession({ answer: ringing.callId });
      session.onDrop(() => {
        void hangUp();
      });
      callSession.value = session;
      if (chat.value?.conversationId !== ringing.conversationId) await open(ringing.conversationId);
      await refreshCalls();
    } catch (cause) {
      callError.value = cause instanceof api.ApiError ? callErrorText(cause.message) : 'Non sono riuscito a rispondere.';
    } finally {
      callStarting.value = false;
    }
  }

  async function declineIncoming(): Promise<void> {
    const ringing = incoming.value;
    if (ringing === null) return;
    incoming.value = null;
    await api.declineCall(ringing.callId).catch(() => undefined);
  }

  async function callWhenDone(taskId: string): Promise<void> {
    try {
      await api.callWhenDone(taskId);
      await refreshCalls();
    } catch {
      callError.value = 'Non posso chiamarti per questo lavoro: forse è già finito.';
    }
  }

  async function cancelScheduled(callId: string): Promise<void> {
    await api.cancelScheduledCall(callId).catch(() => undefined);
    await refreshCalls();
  }

  async function closeStrayCall(): Promise<void> {
    const stray = strayCall.value;
    if (stray === null) return;
    strayCall.value = null;
    await api.endCall(stray.id).catch(() => undefined);
  }

  async function hangUp(): Promise<void> {
    const session = callSession.value;
    if (session === null) return;
    callSession.value = null;
    await session.hangUp();
    await refreshCalls().catch(() => undefined);
  }

  /** Back to no open conversation (the browser went back to the root). */
  function close(): void {
    error.value = null;
    draft.value = null;
    incognitoEnd.value = null;
    clearSoon();
    calls.value = [];
    chat.value = null;
    detached.value = undefined;
    tasks.value = {};
  }

  /** "Nuovo" (D-108): a draft only in the page; the core creates the conversation with the first message. */
  function openDraft(choice: DraftChoice): void {
    close();
    draftKey += 1;
    // The Coder only with a project (D-111): without one the draft is a plain conversation of its mode.
    const agent = choiceAgent(choice);
    draft.value = {
      key: draftKey,
      mode: choice.mode,
      project: choice.project,
      ...(agent === undefined ? {} : { agent }),
      ...(choice.incognito === true ? { incognito: true } : {}),
      // A trial chat (D-142) is incognito and private only.
      ...(choice.incognito === true && choice.mode === 'private' && choice.trialModel !== undefined ? { trialModel: choice.trialModel } : {}),
      // A chat with a person of the series (D-225, tappa B): only with Claude, work, no project.
      ...(choiceCharacter(choice) === undefined ? {} : { character: choiceCharacter(choice) }),
      conversationId: null,
    };
  }

  /**
   * The first message of the draft: creates the conversation (once, even when
   * the message must be sent again), sends the message, then opens the
   * conversation. False keeps the text in the field.
   */
  async function sendDraft(body: string, design?: MessageDesign): Promise<boolean> {
    const start = draft.value;
    if (start === null || sending.value) return false;
    error.value = null;
    const problem = firstMessageProblem(body, goesToArianna, start.agent);
    if (problem !== undefined) {
      error.value = problem;
      return false;
    }
    sending.value = true;
    try {
      const step = draftStep(start);
      let created: Conversation | undefined;
      let id: string;
      if (step.kind === 'create') {
        created = await api.createConversation(start.mode, start.project, start.agent, start.incognito === true, start.trialModel, start.character);
        id = created.id;
        if (start.incognito === true) knownIncognito.add(id);
        // The user left the draft while it was created: nothing is sent, the text stays where it was written.
        if (draft.value?.key !== start.key) return false;
        draft.value = { ...start, conversationId: id };
      } else {
        id = step.conversationId;
      }
      await api.sendMessage(id, body, design);
      // The user left the draft meanwhile: the message is in, the page stays where the user went.
      if (draft.value?.key !== start.key) return true;
      // An incognito conversation never enters a list (D-136): the page holds it alone.
      if (start.incognito === true) {
        await open(id, created ?? (await api.loadConversation(id)));
        return true;
      }
      if (created !== undefined) conversations.value = [created, ...conversations.value.filter((item) => item.id !== id)];
      await open(id);
      // The list with the title the core gave; a failure here leaves the open conversation as it is.
      void refreshConversations().catch(() => undefined);
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      sending.value = false;
    }
  }

  /**
   * The phone of an empty new conversation (D-158): creates the conversation
   * as the first message would (once, as in sendDraft), opens it, then calls
   * Arianna or the agent in it. Never in incognito.
   */
  async function callDraft(): Promise<void> {
    const start = draft.value;
    if (start === null || draftCallee(start) === undefined || sending.value || callSession.value !== null || callStarting.value) return;
    error.value = null;
    callError.value = null;
    sending.value = true;
    let id: string;
    try {
      const step = draftStep(start);
      if (step.kind === 'create') {
        const created = await api.createConversation(start.mode, start.project, start.agent);
        id = created.id;
        // The user left the draft while it was created: no call.
        if (draft.value?.key !== start.key) return;
        draft.value = { ...start, conversationId: id };
        conversations.value = [created, ...conversations.value.filter((item) => item.id !== id)];
      } else {
        id = step.conversationId;
      }
      await open(id);
      void refreshConversations().catch(() => undefined);
    } catch (cause) {
      fail(cause);
      return;
    } finally {
      sending.value = false;
    }
    if (chat.value?.conversationId === id) await startCall();
  }

  /**
   * The left side of the Studio (I-19, D-184): the direct chat with the
   * Designer on a project, the latest one not archived; without one, a draft
   * of it, so the conversation is born with the first message (D-108).
   */
  // Grows with each call: an answer that arrives after a change of project is dropped.
  let studioChatToken = 0;
  async function openStudioChat(project: string): Promise<void> {
    const token = ++studioChatToken;
    error.value = null;
    if (projects.value.length === 0) await refreshProjects();
    if (token !== studioChatToken) return;
    const info = projects.value.find((entry) => entry.name === project);
    if (info === undefined) {
      close();
      return;
    }
    // Read from the core: on a page opened at /studio the list may not be loaded yet.
    const listed = await api.listConversations().catch(() => conversations.value);
    if (token !== studioChatToken) return;
    const found = listed.find(
      (conversation) =>
        conversation.agent === STUDIO_AGENT &&
        (conversation.workspace === info.name || conversation.workspace === info.path) &&
        conversation.archivedAt === null &&
        conversation.incognito !== true,
    );
    if (found !== undefined) {
      if (chat.value?.conversationId !== found.id) await open(found.id);
      return;
    }
    if (draft.value?.agent === STUDIO_AGENT && draft.value.project === project) return;
    openDraft({ mode: 'work', project, agent: STUDIO_AGENT });
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

  /** `attachments`: the images and files of the message (D-247), already kept by the core as pending. */
  async function send(body: string, design?: MessageDesign, attachments: readonly AttachmentInfo[] = []): Promise<boolean> {
    const state = chat.value;
    if (state === null || body.trim() === '') return false;
    error.value = null;
    notice.value = null;
    // "/note" for "/nota": not sent to Arianna, the draft stays in the composer.
    const refused = commandError(body);
    if (refused !== undefined) {
      error.value = refused;
      return false;
    }
    // The other "/" commands (D-090) are carried out by the page, never sent to Arianna.
    const meaning = resolveDraft(body);
    if (meaning.kind === 'command' && meaning.command.action.kind !== 'note' && !reachesCore(meaning.command.action)) return false;
    const incognitoHere = current.value?.incognito === true;
    // "/nota" is off in incognito (D-136): nothing of it goes to kb/inbox, the draft stays.
    const note = parseNoteCommand(body);
    const off = noteRefusal(note !== undefined, incognitoHere);
    if (off !== undefined) {
      error.value = off;
      return false;
    }
    sending.value = true;
    try {
      // "/nota ..." does not reach Arianna: a note in kb/inbox, without a model (D-080).
      if (note !== undefined) {
        // With the conversation: the core refuses "/nota" from an incognito one too (D-136), whatever the page knows.
        notice.value = savedText(await api.captureNote({ ...note, conversationId: state.conversationId }));
        return true;
      }
      // Whatever is left must be a message: a command never reaches Arianna.
      if (!goesToArianna(body)) {
        // The attachments were taken from the field: back there, never lost (D-247).
        if (attachments.length > 0) refusedDraft.value = { conversationId: state.conversationId, body, at: Date.now(), attachments: [...attachments] };
        return false;
      }
      const posted = await api.sendMessage(
        state.conversationId,
        body,
        design,
        attachments.map((item) => item.id),
      );
      // An answer is at work (D-218): the message waits in the queue, shown above the field.
      if ('queued' in posted) {
        if (chat.value?.conversationId === state.conversationId) await refreshQueue();
        return true;
      }
      if (chat.value?.conversationId === state.conversationId) chat.value = mergeMessages(chat.value, [posted.message]);
      tasks.value = { ...tasks.value, [posted.task.id]: posted.task };
      return true;
    } catch (cause) {
      fail(cause);
      // Its attachments go back to the field with it (D-247): the core still keeps them as pending.
      refusedDraft.value = { conversationId: state.conversationId, body, at: Date.now(), ...(attachments.length === 0 ? {} : { attachments: [...attachments] }) };
      // Kept as the draft of its conversation too (D-231): the page may have moved on, and then the field does not take it back.
      keepRefused(storage, state.conversationId, body, !incognitoHere && !knownIncognito.has(state.conversationId), Date.now());
      return false;
    } finally {
      sending.value = false;
    }
  }

  /**
   * Opens the error window of a failed task (D-064) and reads why it failed.
   * `openFailure()` reads the window again after the await: the user may have
   * closed it meanwhile, which the type narrowed by the assignment above hides.
   */
  async function explain(task: Task): Promise<void> {
    error.value = null;
    const origin = [...conversations.value, ...archived.value, ...(detached.value === undefined ? [] : [detached.value])].find(
      (conversation) => conversation.id === task.conversationId,
    );
    const claudeAnswers = claudeAnswersSystemChat(origin?.mode, models.value);
    failure.value = { task, error: null, loading: true, claudeAnswers };
    try {
      const read = await api.loadTaskFailure(task.id);
      // The user may have closed the window, or opened another one, meanwhile.
      if (openFailure()?.task.id === task.id) failure.value = { task, error: read, loading: false, claudeAnswers };
    } catch (cause) {
      failure.value = null;
      fail(cause);
    }
  }

  function openFailure(): typeof failure.value {
    return failure.value;
  }

  function closeFailure(): void {
    failure.value = null;
  }

  /** The user retries a failed task: it goes back in the queue from the failed step. */
  async function retry(taskId: string): Promise<void> {
    error.value = null;
    try {
      const task = await api.retryTask(taskId);
      if (taskId in tasks.value) tasks.value = { ...tasks.value, [taskId]: task };
      failure.value = null;
      // From a system chat the task belongs to another conversation: its status is shown in the chat's card.
      if (current.value?.sourceTaskId === taskId) await refreshConversations();
    } catch (cause) {
      fail(cause);
    }
  }

  /** Opens (or resumes) the system chat of a failed task and shows it. */
  async function openSystemChat(taskId: string): Promise<void> {
    error.value = null;
    try {
      const conversation = await api.openSystemChat(taskId);
      failure.value = null;
      await refreshAllConversations();
      await open(conversation.id);
    } catch (cause) {
      fail(cause);
    }
  }

  /** Attaches the question of the failed task to the open system chat, at the user's request. */
  async function attachQuestion(): Promise<void> {
    const state = chat.value;
    if (state === null) return;
    error.value = null;
    try {
      const message = await api.attachQuestion(state.conversationId);
      if (chat.value?.conversationId === state.conversationId) chat.value = mergeMessages(chat.value, [message]);
      await refreshConversations();
    } catch (cause) {
      fail(cause);
    }
  }

  async function decide(approval: Approval, state: 'approved' | 'rejected', choice?: ExecutorChoice, plan?: PlanChoice): Promise<void> {
    error.value = null;
    try {
      await api.decide(approval.id, state, choice, plan);
      approvals.value = approvals.value.filter((item) => item.id !== approval.id);
    } catch (cause) {
      fail(cause);
      await refreshApprovals();
    }
  }

  async function refreshStatus(): Promise<void> {
    status.value = await api.loadStatus();
  }

  /** Many events come in bursts: the panel is read once after them. */
  function statusSoon(): void {
    if (statusTimer !== undefined) return;
    statusTimer = window.setTimeout(() => {
      statusTimer = undefined;
      refreshStatus().catch(fail);
    }, 700);
  }

  async function refreshCharacters(): Promise<void> {
    try {
      characters.value = await api.loadCharacters();
      rememberCharacterNames(characters.value);
    } catch (cause) {
      fail(cause);
    }
  }

  /** The themes (D-103): a failed read keeps the theme on screen. */
  async function refreshThemes(): Promise<void> {
    try {
      themes.value = await api.loadThemes();
    } catch {
      // An older core has no /api/themes: Base stays.
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([
      refreshAllConversations(),
      refreshApprovals(),
      refreshMessages(),
      refreshModels(),
      refreshProjects(),
      refreshStatus(),
      refreshCharacters(),
      refreshThemes(),
    ]);
  }

  /** Other parts of the page that read the live feed too: the panel of «Chiedi a lato» (D-232). */
  const liveListeners = new Set<(message: ServerMessage) => void>();
  function listenLive(listener: (message: ServerMessage) => void): () => void {
    liveListeners.add(listener);
    return () => liveListeners.delete(listener);
  }
  /**
   * The conversations the page shows besides the open one (the side thread in
   * its panel, D-232; the conversation beside, D-234): their notices stay quiet.
   */
  const alsoSeen = new Set<() => string | null>();
  function seeAlso(seen: () => string | null): () => void {
    alsoSeen.add(seen);
    return () => alsoSeen.delete(seen);
  }
  function seenAlso(conversationId: string): boolean {
    return [...alsoSeen].some((seen) => seen() === conversationId);
  }

  function onLive(message: ServerMessage): void {
    for (const listener of liveListeners) listener(message);
    if (beside) {
      onLiveBeside(message);
      return;
    }
    if (message.type === 'ready') {
      tellVisibility();
      // At every connection, also after a restart of the core, which keeps it in memory (D-128).
      void reportThisMac().catch(() => undefined);
      // An incognito conversation closed while the link was down is said as such, before the reads that would fail on it.
      void checkIncognito()
        .then(refreshAll)
        .catch(fail);
      return;
    }
    if (message.type === 'conversation.incognito-closed' || message.type === 'conversation.incognito-closing') {
      onIncognito(message);
      return;
    }
    if (message.type === 'notice') {
      // The side thread open in its panel is being read (D-232): no notice for its answer while the page is in front.
      if (message.conversationId !== null && seenAlso(message.conversationId) && pageInView() && document.hasFocus()) return;
      // One place only: the helper of the Mac, else a system notification (fixed sentence and link), else a toast; nothing for the conversation being read.
      const view = { hidden: !pageInView() || !document.hasFocus(), openConversation: chat.value?.conversationId ?? null, permission: permissionNow() };
      const where = noticeWhere(message.conversationId, view, message.helper === true);
      if (where.system) void showNotice(message.kind, message.conversationId, followLink).catch(() => undefined);
      if (where.toast) {
        // The title stays in this page, on this Mac: a toast may name the conversation, a system notification never.
        const title = conversations.value.find((item) => item.id === message.conversationId)?.title ?? null;
        toastSeq += 1;
        toasts.value = pushToast(toasts.value, { id: toastSeq, kind: message.kind, conversationId: message.conversationId, title });
      }
      return;
    }
    if (message.type === 'delta') {
      if (chat.value !== null) chat.value = applyDelta(chat.value, message);
      return;
    }
    if (message.type === 'activity') {
      // The office never shows the work of an incognito conversation (D-136).
      if (message.incognito !== true && officeMayNote(message.conversationId, knownIncognito)) noteActivity(officeSignals.value, message.conversationId, message.kind);
      if (chat.value !== null) chat.value = applyActivity(chat.value, message);
      return;
    }
    if (message.type === 'edit') {
      // A live change of the Coder (D-117): kept in memory for the activity card only.
      if (chat.value !== null) chat.value = applyEdit(chat.value, message);
      return;
    }
    if (message.type === 'terminal') {
      // The terminal of the Coder's run (D-095): in memory for the Computer panel only, gone with the page.
      if (chat.value !== null) chat.value = applyTerminal(chat.value, message);
      return;
    }
    const { event } = message;
    statusSoon();
    notePause(officeSignals.value, event);
    const conversationId = payloadString(event, 'conversationId');
    const known = event.taskId !== null && event.taskId in tasks.value;
    const work: Promise<unknown>[] = [];
    if (CARD_EVENTS.has(event.kind)) cardsVersion.value += 1;
    if (event.kind.startsWith('routine.')) routinesVersion.value += 1;
    switch (event.kind) {
      case 'conversation.model':
      case 'conversation.pinned':
      case 'conversation.character':
        work.push(refreshConversations());
        break;
      // [cloud.models] or [cloud] executors changed (D-071): the selector offers what the core offers now.
      case 'settings.cloud-models':
      case 'settings.executors':
        work.push(refreshModels());
        break;
      case 'conversation.created':
      case 'conversation.title':
      case 'conversation.archived':
        work.push(refreshAllConversations());
        break;
      case 'conversation.purged':
        if (conversationId !== undefined) forget(conversationId);
        work.push(refreshAllConversations(), refreshApprovals());
        break;
      // A conversation erased (D-157): the line says nothing of which one.
      case 'events.rewoven':
        work.push(afterErase());
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
      // The queue of a conversation changed (D-218): the event names the conversation, never the text.
      case 'conversation.queue':
        if (conversationId !== undefined && conversationId === chat.value?.conversationId) work.push(refreshQueue());
        break;
      case 'participant.added':
      case 'participant.removed':
        if (conversationId !== undefined && conversationId === chat.value?.conversationId) work.push(refreshParticipants());
        break;
      case 'call.ringing': {
        const callId = payloadString(event, 'callId');
        const reason = payloadString(event, 'reason');
        if (callId !== undefined && conversationId !== undefined && callSession.value === null) {
          incoming.value = { callId, conversationId, reason: reason === 'waiting' || reason === 'task-done' ? reason : 'scheduled' };
        }
        if (conversationId !== undefined && conversationId === chat.value?.conversationId) work.push(refreshCalls());
        break;
      }
      case 'call.scheduled':
      case 'call.started':
      case 'call.ended': {
        // Ended, or answered from another page: this one stops ringing.
        if ((event.kind === 'call.ended' || event.kind === 'call.started') && payloadString(event, 'callId') === incoming.value?.callId) incoming.value = null;
        if (conversationId !== undefined && conversationId === chat.value?.conversationId) work.push(refreshCalls());
        // Ended by the voice or the core (time limit, line down): the page lets go too.
        const callId = payloadString(event, 'callId');
        if (callId !== undefined && callId === strayCall.value?.id && event.kind === 'call.ended') strayCall.value = null;
        if (event.kind === 'call.ended' && callId !== undefined && callId === callSession.value?.call.id) {
          const session = callSession.value;
          callSession.value = null;
          void session.hangUp();
        }
        break;
      }
      case 'approval.decided':
      case 'approval.edited':
      case 'approval.requested':
        work.push(refreshApprovals());
        if (known && event.taskId !== null) work.push(refreshTask(event.taskId));
        break;
      default:
        if (event.kind.startsWith('task.') && known && event.taskId !== null) work.push(refreshTask(event.taskId));
        // A task that settles has saved its last activity lines: "Mostra i passi (N)" follows (D-083).
        if (event.kind === 'task.status' && known) work.push(refreshActivityCounts());
        // The direct chat (D-111): the context of the Coder's session is saved after its answer, the indicator follows.
        if (event.kind === 'task.status' && known && current.value?.agent !== null && current.value?.agent !== undefined) work.push(refreshConversations());
        // A conversation beside (D-234) has no lists of its own: its indicator of the context and its «Riprova» follow these.
        else if (event.kind === 'task.status' && alsoSeen.size > 0 && [...alsoSeen].some((seen) => seen() !== null)) work.push(refreshConversations());
        // The source task of the open system chat: its "Riprova" follows the task's status.
        if (event.kind.startsWith('task.') && event.taskId !== null && event.taskId === current.value?.sourceTaskId) work.push(refreshConversations());
    }
    void Promise.all(work).catch(fail);
  }

  /**
   * The live feed for the store beside (D-234): only what changes its own
   * conversation. Notices, calls, incognito signals, the office and the status
   * stay with the first store, which receives the same feed.
   */
  function onLiveBeside(message: ServerMessage): void {
    // Nothing until the conversation is known to stand beside (open() checks it first): never a piece of an incognito one.
    if (!splittable(current.value)) return;
    if (message.type === 'ready') {
      void Promise.all([keepCurrent(), refreshMessages(), refreshQueue(), refreshParticipants(), refreshCalls()]).catch(fail);
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
    if (message.type === 'edit') {
      if (chat.value !== null) chat.value = applyEdit(chat.value, message);
      return;
    }
    if (message.type === 'terminal') {
      if (chat.value !== null) chat.value = applyTerminal(chat.value, message);
      return;
    }
    if (message.type !== 'event') return;
    const { event } = message;
    const conversationId = payloadString(event, 'conversationId');
    const mine = conversationId !== undefined && conversationId === chat.value?.conversationId;
    const known = event.taskId !== null && event.taskId in tasks.value;
    const work: Promise<unknown>[] = [];
    switch (event.kind) {
      case 'conversation.purged':
        if (conversationId !== undefined) forget(conversationId);
        break;
      case 'events.rewoven':
        work.push(afterErase());
        break;
      case 'message.created':
        if (mine) {
          const replyId = payloadString(event, 'replyId');
          work.push(
            refreshMessages().then(() => {
              if (replyId !== undefined && chat.value !== null) chat.value = settleReply(chat.value, replyId);
            }),
          );
        }
        break;
      case 'conversation.queue':
        if (mine) work.push(refreshQueue());
        break;
      case 'participant.added':
      case 'participant.removed':
        if (mine) work.push(refreshParticipants());
        break;
      case 'call.ringing':
      case 'call.scheduled':
      case 'call.started':
      case 'call.ended':
        // Only the receipts among the messages: the call itself is the first store's.
        if (mine) work.push(refreshCalls());
        break;
      default:
        if ((event.kind.startsWith('task.') || event.kind.startsWith('approval.')) && known && event.taskId !== null) work.push(refreshTask(event.taskId));
        if (event.kind === 'task.status' && known) work.push(refreshActivityCounts());
    }
    void Promise.all(work).catch(fail);
  }

  /** The page is in view (I-1): the core pushes nothing while one is. */
  function pageInView(): boolean {
    return document.visibilityState === 'visible';
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  /** "Apri" on a toast: to its conversation (the home page for a trial). */
  function openToast(id: number): void {
    const toast = toasts.value.find((item) => item.id === id);
    dismissToast(id);
    if (toast !== undefined) followLink(noticeUrl(toast.conversationId));
  }

  /** A click on a notice of this page: the address changes and App.vue follows it as after Back. */
  function followLink(path: string): void {
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  /** Whether the page is in view, and on which conversation: the notices (D-128) and the presence on an incognito one (D-136). */
  function tellVisibility(): void {
    connection?.sendVisibility(pageInView(), document.hasFocus(), seenConversation());
  }

  /** The conversation this page is on: the open one, or the incognito one its draft created while the first message failed (D-136). */
  function seenConversation(): string | null {
    return chat.value?.conversationId ?? (draft.value?.incognito === true ? draft.value.conversationId : null);
  }

  function start(): void {
    const tell = tellVisibility;
    document.addEventListener('visibilitychange', tell);
    // Another app in front (D-128): the helper of the Mac shows the notices then.
    window.addEventListener('focus', tell);
    window.addEventListener('blur', tell);
    // Another conversation open: the helper is silent only for the one being read.
    stopOpenWatch = watch(seenConversation, tell);
    // The gateway counts per hour move with the clock, not only with events.
    statusPoll = window.setInterval(() => {
      refreshStatus().catch(() => undefined);
      void refreshVoice();
    }, 60_000);
    void refreshVoice();
    void refreshStrayCall();
    // Closing or reloading the page hangs up: the microphone and the call do not outlive it.
    window.addEventListener('pagehide', () => {
      callSession.value?.leave();
    });
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
          send: (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
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
    stopOpenWatch?.();
    connection?.close();
    window.clearInterval(statusPoll);
    window.clearTimeout(statusTimer);
    window.clearTimeout(soonTimer);
  }

  return { onLive, listenLive, seeAlso, reloadConversation, openStudioChat, cardsVersion, routinesVersion, openSecretary, openSecretaryAddress, incognitoEnd, incognitoSoon, ending, endIncognito, openIncognito, officeSignals, conversations, archived, systemChats, failure, explain, closeFailure, retry, openSystemChat, attachQuestion, chat, current, tasks, credits, activityCounts, approvals, participants, removeParticipant, mentionable, refusedDraft, queue, stopAnswer, editQueued, removeQueued, sendQueuedNow, resumeQueue, models, projects, directAgents, offInterlocutors, refreshProjects, remoteDecisions, status, refreshStatus, characters, refreshCharacters, themes, refreshThemes, live, error, sending, notice, toasts, dismissToast, openToast, open, close, create, draft, openDraft, sendDraft, callDraft, send, decide, chooseModel, chooseCharacter, rename, archive, pin, erase, dismissDecision, start, stop, calls, voiceState, refreshVoice, callSession, callStarting, callError, startCall, hangUp, strayCall, closeStrayCall, incoming, answerIncoming, declineIncoming, callWhenDone, cancelScheduled };
}

export type ChatStore = ReturnType<typeof createChatStore>;

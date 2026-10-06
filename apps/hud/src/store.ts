import { computed, ref, shallowRef, watch } from 'vue';

import * as api from './lib/api.ts';
import { startCall as openCallSession, type CallSession } from './lib/call-session.ts';
import { callErrorText, type CallInfo } from './lib/calls.ts';
import { applyActivity, applyDelta, applyEdit, emptyChat, mergeMessages, restoreActivity, settleReply, taskIds, type ChatState } from './lib/chat-state.ts';
import { commandError, parseNoteCommand, savedText } from './lib/capture.ts';
import { goesToArianna, resolveDraft } from './lib/commands.ts';
import { choiceAgent, draftStep, firstMessageProblem, type Draft, type DraftChoice } from './lib/draft.ts';
import { creditsByMessage, hasCredit } from './lib/delegations.ts';
import { claudeAnswersSystemChat } from './lib/failures.ts';
import { closedCause, closedText, closingLines, closingSoonText, endRetryDelay, incognitoAction, noteRefusal, withoutIncognito, type CloseCause, type IncognitoSignal } from './lib/incognito.ts';
import { errorText } from './lib/italian.ts';
import { connectLive, type LiveConnection, type LiveState, type SocketLike } from './lib/live.ts';
import { payloadString, type ServerMessage } from './lib/protocol.ts';
import { reportThisMac } from './lib/push.ts';
import { noticeUrl, noticeWhere, permissionNow, pushToast, showNotice, type Toast } from './lib/notices.ts';
import { emptySignals, noteActivity, notePause, type OfficeSignals } from './lib/office/signals.ts';
import { loadDismissed, remoteDecisions as notesFrom, saveDismissed, type RemoteDecision } from './lib/remote-decisions.ts';
import { withoutParticipant } from './lib/participants.ts';
import type { Approval, CharacterListing, CloudModel, Conversation, ConversationMode, DirectAgent, MessageCredit, Participant, ProjectInfo, StatusSnapshot, Task, TaskFailure } from './lib/types.ts';

/**
 * State of the page. Every change comes from the API; the socket only says
 * what changed (events carry ids, never content) and streams the answers.
 */
export function createChatStore() {
  const conversations = ref<Conversation[]>([]);
  /** Archived conversations, shown in their own section (D-057). */
  const archived = ref<Conversation[]>([]);
  /** System chats, opened by the system (D-064): their own section, between the two. */
  const systemChats = ref<Conversation[]>([]);
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
  /** The agents in the open conversation besides Arianna and the user (D-125). */
  const participants = ref<Participant[]>([]);
  /** The cloud models a work conversation may choose (task 1.10). */
  const models = ref<CloudModel[]>([]);
  /** The approved projects (D-058); the list changes without a restart, so it is read again when needed. */
  const projects = ref<ProjectInfo[]>([]);
  /** Who the user may talk with directly (D-111d), as their cards allow. */
  const directAgents = ref<DirectAgent[]>([]);
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
    const [listed, system] = await Promise.all([api.listConversations(), api.listSystemChats()]);
    conversations.value = listed;
    systemChats.value = system;
    await keepCurrent();
  }

  /** Every list: after an archive or a restore, and at the start. */
  async function refreshAllConversations(): Promise<void> {
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
      [projects.value, directAgents.value] = await Promise.all([api.listProjects(), api.listDirectAgents().catch(() => directAgents.value)]);
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

  /** `known`: the conversation when the page already has it, as an incognito one, which no list holds (D-136). */
  async function open(id: string, known?: Conversation): Promise<void> {
    error.value = null;
    draft.value = null;
    incognitoEnd.value = null;
    clearSoon();
    // Before the chat: the address follows the open conversation, and an incognito one has its own.
    detached.value = known?.id === id ? known : undefined;
    chat.value = emptyChat(id);
    tasks.value = {};
    credits.value = new Map();
    activityCounts.value = {};
    calls.value = [];
    participants.value = [];
    try {
      await Promise.all([refreshMessages(), refreshCalls(), refreshParticipants()]);
    } catch (cause) {
      fail(cause);
    }
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

  async function scheduleCall(at: Date): Promise<boolean> {
    const id = chat.value?.conversationId;
    if (id === undefined) return false;
    try {
      await api.scheduleCall(id, at);
      await refreshCalls();
      return true;
    } catch {
      callError.value = 'Non sono riuscito a programmare la chiamata: scegli un’ora nei prossimi sette giorni.';
      return false;
    }
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
      conversationId: null,
    };
  }

  /**
   * The first message of the draft: creates the conversation (once, even when
   * the message must be sent again), sends the message, then opens the
   * conversation. False keeps the text in the field.
   */
  async function sendDraft(body: string): Promise<boolean> {
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
        created = await api.createConversation(start.mode, start.project, start.agent, start.incognito === true);
        id = created.id;
        // The user left the draft while it was created: nothing is sent, the text stays where it was written.
        if (draft.value?.key !== start.key) return false;
        draft.value = { ...start, conversationId: id };
      } else {
        id = step.conversationId;
      }
      await api.sendMessage(id, body);
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
    notice.value = null;
    // "/note" for "/nota": not sent to Arianna, the draft stays in the composer.
    const refused = commandError(body);
    if (refused !== undefined) {
      error.value = refused;
      return false;
    }
    // The other "/" commands (D-090) are carried out by the page, never sent to Arianna.
    const meaning = resolveDraft(body);
    if (meaning.kind === 'command' && meaning.command.action.kind !== 'note') return false;
    // "/nota" is off in incognito (D-136): nothing of it goes to kb/inbox, the draft stays.
    const note = parseNoteCommand(body);
    const off = noteRefusal(note !== undefined, current.value?.incognito === true);
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
      if (!goesToArianna(body)) return false;
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
    } catch (cause) {
      fail(cause);
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
    ]);
  }

  function onLive(message: ServerMessage): void {
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
      noteActivity(officeSignals.value, message.conversationId, message.kind);
      if (chat.value !== null) chat.value = applyActivity(chat.value, message);
      return;
    }
    if (message.type === 'edit') {
      // A live change of the Coder (D-117): kept in memory for the activity card only.
      if (chat.value !== null) chat.value = applyEdit(chat.value, message);
      return;
    }
    const { event } = message;
    statusSoon();
    notePause(officeSignals.value, event);
    const conversationId = payloadString(event, 'conversationId');
    const known = event.taskId !== null && event.taskId in tasks.value;
    const work: Promise<unknown>[] = [];
    switch (event.kind) {
      case 'conversation.model':
      case 'conversation.pinned':
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
        // The source task of the open system chat: its "Riprova" follows the task's status.
        if (event.kind.startsWith('task.') && event.taskId !== null && event.taskId === current.value?.sourceTaskId) work.push(refreshConversations());
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

  return { incognitoEnd, incognitoSoon, ending, endIncognito, openIncognito, officeSignals, conversations, archived, systemChats, failure, explain, closeFailure, retry, openSystemChat, attachQuestion, chat, current, tasks, credits, activityCounts, approvals, participants, removeParticipant, models, projects, directAgents, refreshProjects, remoteDecisions, status, refreshStatus, characters, refreshCharacters, live, error, sending, notice, toasts, dismissToast, openToast, open, close, create, draft, openDraft, sendDraft, send, decide, chooseModel, rename, archive, pin, purge, dismissDecision, start, stop, calls, voiceState, refreshVoice, callSession, callStarting, callError, startCall, hangUp, strayCall, closeStrayCall, incoming, answerIncoming, declineIncoming, scheduleCall, callWhenDone, cancelScheduled };
}

export type ChatStore = ReturnType<typeof createChatStore>;

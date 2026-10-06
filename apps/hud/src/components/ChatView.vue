<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { stepsAnchors } from '../lib/activity-log.ts';
import { approvalAnchor, clearFocus, FOCUS_EVENT, HIGHLIGHT_CLASSES, HIGHLIGHT_MS, messageAnchor, parseAnchor, pendingFocus, requestFocus } from '../lib/chat-focus.ts';
import { canSaveToInbox } from '../lib/capture.ts';
import { completion, filterCommands, menuQuery, moveSelection, resolveDraft, usage, type ChatCommand, type CommandAction } from '../lib/commands.ts';
import { receiptAnchors, receiptText, type CallInfo } from '../lib/calls.ts';
import { activityLines, liveEdits, type ChatState, type LiveEdit } from '../lib/chat-state.ts';
import { contextMeter, contextTitle } from '../lib/direct-chat.ts';
import { longMessageStep, toAgent } from '../lib/draft.ts';
import { DIRECT_MODELS } from '../lib/failures.ts';
import { NOTE_OFF_TEXT, SAVE_OFF_HINT } from '../lib/incognito.ts';
import { activityText, agentName, reasonText } from '../lib/italian.ts';
import {
  inboxNodeId,
  loadSaved,
  mergeSavedNotes,
  OPEN_IN_KNOWLEDGE_HINT,
  OPEN_IN_KNOWLEDGE_TEXT,
  SAVE_CONVERSATION_HINT,
  SAVE_CONVERSATION_TEXT,
  saveConversation,
  savedWhenText,
  UPDATE_CONVERSATION_HINT,
  UPDATE_CONVERSATION_TEXT,
  withSaved,
  type SavedNotes,
} from '../lib/message-actions.ts';
import { MODE_HINT, MODE_TEXT, MODEL_TEXT, STATUS_TEXT, EXECUTOR_TEXT } from '../lib/labels.ts';
import { executorText, isAddingLine, isEventLine, participantPose, removeText } from '../lib/participants.ts';
import { POSE_TEXT, type Pose } from '../lib/sprites.ts';
import type { Activity, Approval, CharacterChoice, CloudModel, Conversation, DirectAgent, Message, MessageCredit, Participant, StatusSnapshot, Task } from '../lib/types.ts';
import LabelBadge from './LabelBadge.vue';
import ActivityLog from './ActivityLog.vue';
import ApprovalCard from './ApprovalCard.vue';
import CreditLine from './CreditLine.vue';
import Icon from './Icon.vue';
import LiveEdits from './LiveEdits.vue';
import MarkdownText from './MarkdownText.vue';
import MessageActions from './MessageActions.vue';
import MessageTime from './MessageTime.vue';
import PixelAgent from './PixelAgent.vue';

const props = defineProps<{
  chat: ChatState;
  conversation: Conversation;
  tasks: Record<string, Task>;
  /** Who wrote each cloud answer, and the files of the Coder's runs (D-082), by message id. */
  credits: Map<string, MessageCredit>;
  /** Saved activity lines per task (D-083): "Mostra i passi (N)" under a finished task. */
  activityCounts: Record<string, number>;
  sending: boolean;
  models: CloudModel[];
  /** Pending approvals of this conversation's tasks, shown under the message that started the task. */
  approvals: Approval[];
  decide: (approval: Approval, state: 'approved' | 'rejected') => Promise<void>;
  arianna: { choice: CharacterChoice | undefined; pose: Pose };
  status: StatusSnapshot | null;
  /** The calls of this conversation (D-066), shown as receipts among the messages. */
  calls: readonly CallInfo[];
  /** The agents in this conversation besides Arianna and the user (D-125), with the characters they wear. */
  participants: readonly Participant[];
  characters: Record<string, CharacterChoice> | undefined;
  /** Who the user may talk with directly (D-111d): where the agent of this conversation runs. */
  directAgents?: DirectAgent[] | undefined;
}>();

const receipts = computed(() => receiptAnchors(props.chat.messages, props.calls));
const steps = computed(() => stepsAnchors(props.chat.messages, props.tasks, props.activityCounts));
const emit = defineEmits<{
  send: [body: string];
  /** "Cosa vogliono dire le etichette?": the legend (etichette parlanti). */
  legend: [];
  chooseModel: [model: string | null];
  restore: [];
  /** Open the error window of a failed task (D-064). */
  explain: [task: Task];
  retry: [taskId: string];
  attachQuestion: [];
  open: [conversationId: string];
  /** "Chiamami quando finisci" on a task at work (D-066). */
  callWhenDone: [taskId: string];
  cancelCall: [callId: string];
  /** The user takes an agent out of the conversation (D-125). */
  removeParticipant: [agent: string];
  /** A "/" command the page carries out (D-090): open a page, a new conversation. */
  command: [action: Exclude<CommandAction, { kind: 'note' | 'help' }>];
  /** "Apri nella Conoscenza" after "Salva in inbox": the note selected in the graph of kb/. */
  openKnowledge: [nodeId: string];
}>();

/** Incognito (D-136): nothing of it is saved in Arianna; "Salva in inbox", /nota and the calls when a task ends are off. */
const incognito = computed(() => props.conversation.incognito === true);

/** A task still at work can ask for a call when it ends, unless one is already waiting for it. */
function canCallWhenDone(task: Task | undefined): boolean {
  if (incognito.value) return false;
  if (task === undefined || !['ready', 'running', 'waiting_user', 'inbox'].includes(task.status)) return false;
  return !props.calls.some((call) => call.taskId === task.id && call.reason === 'task-done' && call.status === 'scheduled');
}

/** The selector of the cloud model for delegated steps: work conversations only (D-055). */
const AUTO = '';
function onModel(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('chooseModel', value === AUTO ? null : value);
}

/** In a work system chat the selector chooses who answers, not the Coder's model. */
const answersDirect = computed(() => props.conversation.origin === 'system' && props.conversation.mode === 'work');
/** The direct chat with the Coder (D-111): it answers in place of Arianna, always on Claude. */
/** The direct chat with an agent (D-111d): it answers in place of Arianna, where its card says. */
const direct = computed(() => props.conversation.agent);
const directPolicy = computed(() => (direct.value === null ? undefined : props.directAgents?.find((entry) => entry.agent === direct.value)));
/** Every message goes to Claude; without the list (an agent turned off), a conversation on a project is taken as one. */
const cloud = computed(() => direct.value !== null && (directPolicy.value?.cloud ?? props.conversation.workspace !== null));
const directName = computed(() => (direct.value === null ? 'Arianna' : agentName(direct.value)));
const directPose = computed<Pose>(() => (direct.value === null ? props.arianna.pose : participantPose(direct.value, props.status?.agents)));
const meter = computed(() => contextMeter(props.conversation.contextTokens));
const meterClass = { ok: 'bg-accent', warn: 'bg-warn', full: 'bg-danger' } as const;
const selectable = computed(() =>
  answersDirect.value
    ? props.models.filter((entry) => entry.executor === 'claude' && DIRECT_MODELS.includes(entry.model))
    : cloud.value
      ? props.models.filter((entry) => entry.executor === 'claude')
      : props.models,
);
const selectorName = computed(() => (answersDirect.value ? 'Chi risponde in questa chat' : 'Modello per i passi delegati'));
const autoText = computed(() => (answersDirect.value ? 'Arianna (locale)' : 'automatico (router)'));
/**
 * The Claude model answering here, or null for the local model. A model no
 * longer selectable (Claude turned off) means Arianna answers, as the core does.
 */
const directModel = computed(() => {
  const model = props.conversation.model;
  return answersDirect.value && model !== null && selectable.value.some((entry) => entry.model === model) ? model : null;
});
/**
 * The model chosen here and since turned off in [cloud.models] (D-071): the
 * router (or Arianna, in a system chat) decides instead. Shown as such, so
 * that choosing another entry, "automatico" included, clears it.
 */
const offModel = computed(() => {
  const model = props.conversation.model;
  return model !== null && !selectable.value.some((entry) => entry.model === model) ? model : null;
});
/** The selector's value: in a system chat, what actually answers, or the model turned off. */
const selected = computed(() => (answersDirect.value ? (directModel.value ?? offModel.value ?? AUTO) : (props.conversation.model ?? AUTO)));
/** Who writes Arianna's answers here: the local model, or Claude in a system chat. */
const answerModel = computed(() => {
  if (direct.value !== null && !cloud.value) return 'locale';
  if (direct.value !== null) return props.conversation.model === null ? 'Claude (router)' : (MODEL_TEXT[props.conversation.model] ?? props.conversation.model);
  return directModel.value === null ? 'locale' : (MODEL_TEXT[directModel.value] ?? directModel.value);
});
/** A long message of the direct chat waits for "Invia comunque" (D-111, risposta 5). */
const confirmLong = ref(false);

// D-099: the messages of this conversation already saved in kb/inbox ("Salvato" after a reload).
const saved = ref<SavedNotes>(new Map());
watch(
  () => props.chat.conversationId,
  async (conversationId) => {
    saved.value = new Map();
    wholeSaved.value = false;
    wholePath.value = null;
    wholeSavedAt.value = null;
    wholeNote.value = null;
    const { messages, conversation: whole } = await loadSaved(conversationId);
    saved.value = mergeSavedNotes(saved.value, messages, conversationId, props.chat.conversationId);
    // A save made on the page while reading wins: it has the newest path.
    if (conversationId === props.chat.conversationId && !wholeSaved.value) {
      wholeSaved.value = whole.saved;
      wholePath.value = whole.path;
      wholeSavedAt.value = whole.savedAt;
    }
  },
  { immediate: true },
);

// I-7 (D-131): the whole conversation in one note of kb/inbox; a second save replaces it.
const wholeSaved = ref(false);
/** The note's path in kb/inbox, for "Apri nella Conoscenza"; null when the core does not name it (above L2). A second save can change it. */
const wholePath = ref<string | null>(null);
/** When it was last saved, with the path: "Salvata in inbox alle …" stays after a reload. */
const wholeSavedAt = ref<string | null>(null);
const wholeWhen = computed(() => savedWhenText(wholeSavedAt.value, now.value));
const wholeSaving = ref(false);
const wholeNote = ref<{ ok: boolean; text: string } | null>(null);
async function saveWhole(): Promise<void> {
  if (wholeSaving.value || incognito.value) return;
  const conversationId = props.chat.conversationId;
  wholeSaving.value = true;
  wholeNote.value = null;
  const outcome = await saveConversation(conversationId);
  wholeSaving.value = false;
  // Another conversation is open now: it reads its own state again.
  if (conversationId !== props.chat.conversationId) {
    const open = props.chat.conversationId;
    const whole = (await loadSaved(open)).conversation;
    if (open !== props.chat.conversationId) return;
    wholeSaved.value = whole.saved;
    wholePath.value = whole.path;
    wholeSavedAt.value = whole.savedAt;
    return;
  }
  wholeNote.value = outcome;
  if (outcome.ok) {
    wholeSaved.value = true;
    wholePath.value = outcome.path;
    wholeSavedAt.value = new Date().toISOString();
  }
}
function markSaved(messageId: string, note: string | null): void {
  saved.value = withSaved(saved.value, messageId, note);
}

const draft = ref('');
// Leaving an incognito conversation (D-136): its unsent text never follows into the next one, which keeps it.
let onIncognito = incognito.value;
watch(
  () => props.chat.conversationId,
  () => {
    if (onIncognito) {
      draft.value = '';
      commandHint.value = null;
      void nextTick(resize);
    }
    onIncognito = incognito.value;
  },
);
watch(incognito, (value) => {
  if (value) onIncognito = true;
});
const list = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);

/** Tasks started by a message written on Telegram: their replies go back there. */
const fromTelegram = computed(
  () => new Set(props.chat.messages.filter((message) => message.role === 'user' && message.channel === 'telegram').map((message) => message.taskId)),
);

/** A reply to a Telegram message: sent there, or replaced by a pointer to this chat if the gateway refused it. */
function repliesToTelegram(message: Message): boolean {
  return message.role === 'assistant' && message.taskId !== null && fromTelegram.value.has(message.taskId);
}

/** The task a user message started, shown under it while it is not settled. */
function taskOf(message: Message): Task | undefined {
  return message.role === 'user' && message.taskId !== null ? props.tasks[message.taskId] : undefined;
}

/** What the task of a user message is doing, while it is queued or running (D-054). */
function activityOf(message: Message): Activity[] {
  if (message.role !== 'user' || message.taskId === null) return [];
  return activityLines(props.chat, message.taskId, props.tasks[message.taskId]?.status);
}

/** The Coder's live changes to files of the task of a user message, while it works (D-117). */
function editsOf(message: Message): LiveEdit[] {
  if (message.role !== 'user' || message.taskId === null) return [];
  return liveEdits(props.chat, message.taskId, props.tasks[message.taskId]?.status);
}

/** The approvals a user message's task waits for. */
function approvalsOf(message: Message): Approval[] {
  return message.role === 'user' && message.taskId !== null ? props.approvals.filter((approval) => approval.taskId === message.taskId) : [];
}

/** Approvals whose message is not on this page (older history): shown at the end. */
const unplaced = computed(() => {
  const shown = new Set(props.chat.messages.filter((message) => message.role === 'user').map((message) => message.taskId));
  return props.approvals.filter((approval) => !shown.has(approval.taskId));
});

/** The Coder's run while it works for this conversation: shown in the persona header. */
const coderRun = computed(() => props.status?.agents.find((agent) => agent.id === 'coder')?.run ?? null);

// The "/" menu (D-090): while the draft is a slash and a word, the commands that match.
const menuDismissed = ref<string | null>(null);
const activeCommand = ref(0);
const commandHint = ref<string | null>(null);
const commandQuery = computed(() => menuQuery(draft.value));
const menuItems = computed(() => (commandQuery.value === undefined ? [] : filterCommands(commandQuery.value)));
const menuOpen = computed(() => commandQuery.value !== undefined && draft.value !== menuDismissed.value);
const activeId = computed(() => {
  const command = menuOpen.value ? menuItems.value[activeCommand.value] : undefined;
  return command === undefined ? undefined : `command-${command.name}`;
});
watch(commandQuery, () => {
  activeCommand.value = 0;
});

function setDraft(text: string): void {
  draft.value = text;
  menuDismissed.value = null;
  void nextTick(() => {
    resize();
    const element = composer.value;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(text.length, text.length);
  });
}

/** Carries out a command that is not a note (the store saves notes, as before). */
function run(command: ChatCommand): void {
  const { action } = command;
  switch (action.kind) {
    case 'note':
      return;
    case 'help':
      setDraft('/');
      return;
    default:
      setDraft('');
      emit('command', action);
  }
}

/** A row of the menu chosen: Tab completes; Invio and the mouse run it, or complete one that takes a text. */
function choose(command: ChatCommand, how: 'enter' | 'tab'): void {
  commandHint.value = null;
  if (how === 'tab' || command.takesArgument) setDraft(completion(command));
  else run(command);
}

// A changed text, or another conversation, asks again when it is still long.
watch([draft, () => props.chat.conversationId], () => {
  confirmLong.value = false;
});
const confirmButton = ref<HTMLButtonElement | null>(null);

/** `confirmed`: only from "Invia comunque" (D-111). */
function submit(confirmed = false): void {
  const body = draft.value;
  if (body.trim() === '' || props.sending) return;
  commandHint.value = null;
  const meaning = resolveDraft(body);
  if (meaning.kind === 'command' && meaning.command.action.kind !== 'note') {
    run(meaning.command);
    return;
  }
  // "/nota" in incognito (D-136): said here, and the text stays in the field.
  if (meaning.kind === 'command' && incognito.value) {
    commandHint.value = NOTE_OFF_TEXT;
    return;
  }
  const step = longMessageStep(cloud.value, body, meaning.kind === 'message', { asking: confirmLong.value, confirmed });
  if (step === 'wait') return;
  if (step === 'ask') {
    confirmLong.value = true;
    void nextTick(() => confirmButton.value?.focus());
    return;
  }
  confirmLong.value = false;
  emit('send', body);
  // An unknown command is not sent (D-080): the draft stays, to be corrected.
  if (meaning.kind === 'error') return;
  draft.value = '';
  void nextTick(resize);
}

function onKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (menuOpen.value) {
    const count = menuItems.value.length;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count > 0) {
      event.preventDefault();
      activeCommand.value = moveSelection(activeCommand.value, event.key === 'ArrowDown' ? 1 : -1, count);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      menuDismissed.value = draft.value;
      return;
    }
    const command = menuItems.value[activeCommand.value];
    if (command !== undefined && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      choose(command, event.key === 'Tab' ? 'tab' : 'enter');
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    // A held key never sends again.
    if (!event.repeat) submit();
  }
}

function onInput(): void {
  commandHint.value = null;
  resize();
}

/** The composer grows with the text, up to a limit. */
function resize(): void {
  const element = composer.value;
  if (element === null) return;
  element.style.height = 'auto';
  element.style.height = `${String(Math.min(element.scrollHeight, 192))}px`;
}

// Follow new messages and fragments, unless the user scrolled up to read.
watch(
  () => [props.chat.messages.length, props.chat.streaming.map((reply) => reply.text.length).join(), props.approvals.length],
  async () => {
    const element = list.value;
    if (element === null) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    await nextTick();
    if (atBottom) element.scrollTop = element.scrollHeight;
  },
);
watch(
  () => props.chat.conversationId,
  async () => {
    await nextTick();
    if (list.value !== null) list.value.scrollTop = list.value.scrollHeight;
  },
);

// D-091: the card or message asked for (the "Decisioni in attesa" window, or #approval-<id> / #message-<id>
// in the address) is brought into view once on the page and lit for a moment. After the watchers above, so it wins.
async function focusAsked(): Promise<void> {
  if (pendingFocus(props.chat.conversationId) === undefined) return;
  await nextTick();
  const anchor = pendingFocus(props.chat.conversationId);
  const element = anchor === undefined ? null : document.getElementById(anchor);
  if (element === null || list.value?.contains(element) !== true) return;
  clearFocus();
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
  element.classList.add(...HIGHLIGHT_CLASSES);
  window.setTimeout(() => element.classList.remove(...HIGHLIGHT_CLASSES), HIGHLIGHT_MS);
}
watch(() => [props.chat.conversationId, props.chat.messages.length, props.approvals.length], focusAsked);
const onFocusEvent = (): void => void focusAsked();
onMounted(() => {
  const fromAddress = parseAnchor(window.location.hash);
  if (fromAddress !== undefined) requestFocus(props.chat.conversationId, fromAddress);
  window.addEventListener(FOCUS_EVENT, onFocusEvent);
  void focusAsked();
});
onBeforeUnmount(() => window.removeEventListener(FOCUS_EVENT, onFocusEvent));

const statusClass: Record<Task['status'], string> = {
  inbox: 'text-muted',
  ready: 'text-muted',
  running: 'text-accent',
  waiting_user: 'text-warn',
  to_verify: 'text-info',
  done: 'text-ok',
  failed: 'text-danger',
};

/** When each message was sent (D-112); `now` moves every minute, so today's times become "ieri" after midnight. */
const now = ref(new Date());
const clock = setInterval(() => (now.value = new Date()), 60_000);
onBeforeUnmount(() => clearInterval(clock));
</script>

<template>
  <section class="flex flex-col" :aria-label="`Conversazione ${MODE_TEXT[conversation.mode]}`">
    <div ref="list" class="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
      <div class="mx-auto flex max-w-[780px] flex-col gap-[18px] px-4 pt-5.5 pb-7.5 md:px-5.5">
        <!-- Persona header with the HUD ring -->
        <section class="flex items-center gap-4 border-b border-line pb-4">
          <div class="relative grid size-[74px] shrink-0 place-items-center">
            <svg viewBox="0 0 74 74" class="absolute inset-0 size-full" aria-hidden="true">
              <circle cx="37" cy="37" r="34" fill="none" stroke="var(--line-strong)" stroke-width="1" />
              <g class="animate-hud-spin origin-center">
                <circle cx="37" cy="37" r="34" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="40 174" stroke-linecap="round" />
              </g>
              <circle cx="37" cy="37" r="28" fill="none" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 4" />
            </svg>
            <PixelAgent v-if="direct !== null" :choice="characters?.[direct]" :pose="directPose" :scale="2" bubble :label="directName" />
            <PixelAgent v-else :choice="arianna.choice" :pose="arianna.pose" :scale="2" bubble label="Arianna" />
          </div>
          <div class="min-w-0">
            <h2 class="flex flex-wrap items-center gap-2 font-hud text-lg leading-tight font-semibold tracking-[0.05em]">
              {{ directName }}
              <span
                v-if="cloud"
                class="inline-flex items-center gap-1 rounded-full border border-l1/60 px-2 py-0.5 font-mono text-[10px] font-medium tracking-normal text-l1"
                title="Ogni messaggio va così com'è a Claude (Anthropic): Arianna non lo filtra."
              ><Icon name="coder" :size="11" />va a Claude</span>
              <span
                v-if="incognito"
                class="inline-flex items-center gap-1 rounded-full bg-incognito px-2 py-0.5 font-mono text-[10px] font-medium tracking-normal text-incognito-ink"
                title="Alla chiusura Arianna cancella i testi di questa conversazione"
              ><Icon name="incognito" :size="11" />incognito</span>
            </h2>
            <p class="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
              <span v-if="(directPose) === 'thinking'" class="inline-flex gap-1" aria-hidden="true">
                <i v-for="dot in 3" :key="dot" class="animate-hud-bob size-[5px] rounded-full bg-accent" :style="{ animationDelay: `${String((dot - 1) * 0.15)}s` }" />
              </span>
              {{ POSE_TEXT[directPose] }}
            </p>
            <p class="mt-1 text-xs text-muted sm:hidden">{{ direct === null ? MODE_HINT[conversation.mode] : cloud ? 'Senza Arianna: ogni messaggio va a Claude.' : 'Senza Arianna, sul modello locale.' }}</p>
            <div v-if="cloud" class="mt-1.5 flex items-center gap-2 font-mono text-[10.5px] text-muted">
              <span>CONTESTO</span>
              <span
                class="relative h-1.5 w-24 overflow-hidden rounded-full bg-surface-2"
                role="meter"
                :aria-valuenow="meter.percent"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="contextTitle(meter)"
              ><span class="absolute inset-y-0 left-0 rounded-full" :class="meterClass[meter.level]" :style="{ width: `${String(meter.percent)}%` }" /></span>
              <b class="font-medium text-ink">{{ meter.text }}</b>
            </div>
          </div>
          <div class="ml-auto hidden text-right font-mono text-[10.5px] leading-[1.7] text-muted sm:block">
            <div>
              CONVERSAZIONE <b class="font-medium text-ink">{{ direct === null ? MODE_TEXT[conversation.mode].toLowerCase() : `${MODE_TEXT[conversation.mode].toLowerCase()} con ${directName}` }}<template v-if="conversation.workspace"> · {{ conversation.workspace.split('/').at(-1) }}</template></b>
            </div>
            <div>MODELLO <b class="font-medium" :class="answerModel === 'locale' ? 'text-ink' : 'text-l1'">{{ answerModel }}</b></div>
            <div v-if="conversation.mode === 'work' && (direct === null || cloud)">
              <label class="inline-flex items-center gap-1">
                {{ answersDirect ? 'RISPONDE →' : cloud ? 'MODELLO →' : 'CODER →' }}
                <select :value="selected" class="field px-1.5 py-0.5 font-mono text-[10.5px]" :aria-label="selectorName" @change="onModel">
                  <option :value="AUTO">{{ autoText }}</option>
                  <option v-for="entry in selectable" :key="entry.model" :value="entry.model">{{ MODEL_TEXT[entry.model] ?? entry.model }}</option>
                  <option v-if="offModel !== null" :value="offModel" disabled>{{ MODEL_TEXT[offModel] ?? offModel }} (spento: {{ autoText }})</option>
                </select>
              </label>
            </div>
            <div v-else>CLOUD <b class="font-medium text-ink">mai</b></div>
            <div v-if="coderRun !== null">
              CODER <b class="font-medium text-accent">al lavoro · {{ EXECUTOR_TEXT[coderRun.executor] ?? coderRun.executor }}</b>
            </div>
          </div>
        </section>

        <!-- I-7 (D-131): the whole conversation as a note of kb/inbox -->
        <!-- Off in incognito (D-136): the same button, its reason over it; aria-disabled keeps the title under the pointer. -->
        <div v-if="incognito && chat.messages.some((message) => message.role !== 'system')" class="-mt-2 flex flex-wrap items-center gap-2 text-xs">
          <button type="button" class="btn cursor-not-allowed px-2.5 py-1 text-xs opacity-50" aria-disabled="true" :title="SAVE_OFF_HINT" :aria-label="`${SAVE_CONVERSATION_TEXT}: ${SAVE_OFF_HINT}`">
            <Icon name="inbox" :size="14" />{{ SAVE_CONVERSATION_TEXT }}
          </button>
        </div>
        <div v-else-if="chat.messages.some((message) => message.role !== 'system')" class="-mt-2 flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            class="btn px-2.5 py-1 text-xs"
            :disabled="wholeSaving"
            :title="wholeSaved ? UPDATE_CONVERSATION_HINT : SAVE_CONVERSATION_HINT"
            @click="saveWhole"
          >
            <Icon name="inbox" :size="14" />{{ wholeSaving ? 'Salvo…' : wholeSaved ? UPDATE_CONVERSATION_TEXT : SAVE_CONVERSATION_TEXT }}
          </button>
          <button
            v-if="wholeSaved && wholePath !== null"
            type="button"
            class="btn px-2.5 py-1 text-xs"
            :disabled="wholeSaving"
            :title="`${OPEN_IN_KNOWLEDGE_HINT}: ${wholePath}`"
            @click="emit('openKnowledge', inboxNodeId(wholePath))"
          >
            <Icon name="knowledge" :size="14" />{{ OPEN_IN_KNOWLEDGE_TEXT }}
          </button>
          <span v-if="wholeNote !== null" role="status" :class="wholeNote.ok ? 'text-muted' : 'text-warn'">{{ wholeNote.text }}</span>
          <span v-else-if="wholeSaved && wholeWhen !== undefined" class="text-muted" :title="wholePath === null ? wholeWhen.full : `${wholeWhen.full} · ${wholePath}`">{{ wholeWhen.text }}</span>
        </div>

        <!-- Who else is here (D-125): the agents Arianna brought in, each can be taken out -->
        <section v-if="participants.length > 0" class="flex flex-wrap items-center gap-2" aria-label="Partecipanti della conversazione">
          <span class="font-hud text-[10px] font-semibold tracking-[0.16em] text-muted uppercase">Con te e Arianna</span>
          <div v-for="participant in participants" :key="participant.agent" class="hud-card flex items-center gap-2 py-1 pr-1 pl-2">
            <PixelAgent :choice="characters?.[participant.agent]" :pose="participantPose(participant.agent, status?.agents)" :scale="1" :label="agentName(participant.agent)" />
            <div class="min-w-0 leading-tight">
              <div class="text-[13px] font-medium">{{ agentName(participant.agent) }}</div>
              <div class="font-mono text-[10.5px] text-muted">{{ executorText(participant) }}</div>
            </div>
            <button
              type="button"
              class="grid size-6 place-items-center rounded-md text-muted hover:text-ink"
              :aria-label="removeText(participant)"
              :title="removeText(participant)"
              @click="emit('removeParticipant', participant.agent)"
            ><Icon name="close" :size="14" /></button>
          </div>
        </section>

        <!-- The model selector on small screens -->
        <label v-if="conversation.mode === 'work' && (direct === null || cloud)" class="flex items-center gap-2 text-xs text-muted sm:hidden">
          {{ answersDirect ? 'Risponde' : cloud ? 'Modello' : 'Coder su' }}
          <select :value="selected" class="field px-2 py-1 text-xs" :aria-label="selectorName" @change="onModel">
            <option :value="AUTO">{{ autoText }}</option>
            <option v-for="entry in selectable" :key="entry.model" :value="entry.model">{{ MODEL_TEXT[entry.model] ?? entry.model }}</option>
            <option v-if="offModel !== null" :value="offModel" disabled>{{ MODEL_TEXT[offModel] ?? offModel }} (spento: {{ autoText }})</option>
          </select>
        </label>

        <!-- A system chat (D-064): what it is about and what the user can do -->
        <section v-if="conversation.origin === 'system'" class="hud-card" aria-label="Chat di sistema">
          <div class="flex flex-col gap-2.5 px-[15px] py-3 text-[13px]">
            <p class="flex items-center gap-2 font-medium"><Icon name="system" :size="16" />Chat di sistema</p>
            <p class="text-muted">
              L’ha aperta il sistema per un task fallito. Chi risponde vede solo l’errore; la domanda del task la vede solo se la alleghi tu.
              Solo tu puoi riprovare il task.
              <template v-if="directModel !== null">
                Qui risponde {{ answerModel }}: legge questa chat (passata dal gateway), senza strumenti né file.
              </template>
            </p>
            <p v-if="conversation.sourceTaskStatus !== null" class="text-xs" aria-live="polite">
              Stato del task:
              <span :class="statusClass[conversation.sourceTaskStatus]">{{ STATUS_TEXT[conversation.sourceTaskStatus] }}</span>
              <span v-if="conversation.sourceTaskStatus !== 'failed'" class="text-muted"> — l’avanzamento si vede nella conversazione del task.</span>
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                v-if="!conversation.questionAttached && conversation.archivedAt === null"
                type="button"
                class="btn px-2.5 py-1 text-xs"
                @click="emit('attachQuestion')"
              >
                <Icon name="attach" :size="14" />Allega la domanda
              </button>
              <span v-else-if="conversation.questionAttached" class="self-center text-xs text-muted">Domanda allegata.</span>
              <button
                v-if="conversation.sourceTaskId !== null && conversation.sourceTaskStatus === 'failed'"
                type="button" class="btn px-2.5 py-1 text-xs" @click="emit('retry', conversation.sourceTaskId)">
                <Icon name="retry" :size="14" />Riprova il task
              </button>
              <button
                v-if="conversation.sourceConversationId !== null"
                type="button"
                class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink"
                @click="emit('open', conversation.sourceConversationId)"
              >
                Vai alla conversazione del task
              </button>
            </div>
          </div>
        </section>

        <p v-if="chat.messages.length === 0" class="text-center text-sm text-muted">Scrivi il primo messaggio.</p>

        <p v-for="call in receipts.get(-1) ?? []" :key="call.id" class="flex items-center justify-center gap-2 text-center font-mono text-[11px] text-muted">
          <Icon name="phone" :size="12" />{{ receiptText(call) }}
          <button v-if="call.status === 'scheduled'" type="button" class="text-info hover:underline" @click="emit('cancelCall', call.id)">annulla</button>
        </p>

        <template v-for="(message, index) in chat.messages" :key="message.id">
          <!-- User -->
          <div v-if="message.role === 'user'" :id="messageAnchor(message.id)" class="msg-row flex flex-col items-end gap-1">
            <div class="max-w-[90%] rounded-[17px_17px_5px_17px] bg-bubble px-[15px] py-[11px] break-words whitespace-pre-wrap text-bubble-ink md:max-w-[78%]">
              {{ message.body }}
            </div>
            <div class="flex items-center gap-2 px-1 font-mono text-[10.5px] text-muted">
              <!-- First, on the left: hidden, they still take room, and at the end they pushed time and status away from the bubble. -->
              <MessageActions :message="message" :saved="saved.has(message.id)" :note="saved.get(message.id) ?? null" :can-save="canSaveToInbox(message.label)" :save-off="incognito ? SAVE_OFF_HINT : undefined" @saved="markSaved" @open-knowledge="emit('openKnowledge', $event)" />
              <MessageTime :ts="message.ts" :now="now" />
              <LabelBadge :label="message.label" />
              <span v-if="message.channel === 'telegram'" class="inline-flex items-center gap-1 text-info" title="Scritto da Telegram"><Icon name="telegram" :size="12" />Telegram</span>
              <span v-if="message.channel === 'voice'" class="inline-flex items-center gap-1 text-info" title="Detto in una chiamata"><Icon name="phone" :size="12" />a voce</span>
              <template v-if="taskOf(message) !== undefined">
                <span :class="statusClass[taskOf(message)!.status]">{{ STATUS_TEXT[taskOf(message)!.status] }}</span>
                <button
                  v-if="taskOf(message)!.status === 'failed'"
                  type="button"
                  class="grid size-4 place-items-center rounded-full bg-danger/15 font-bold text-danger hover:bg-danger/30"
                  aria-label="Perché è fallito"
                  title="Perché è fallito"
                  @click="emit('explain', taskOf(message)!)"
                >!</button>
                <span v-if="reasonText(taskOf(message)!.waitingReason) !== undefined">— {{ reasonText(taskOf(message)!.waitingReason) }}</span>
                <button
                  v-if="canCallWhenDone(taskOf(message))"
                  type="button"
                  class="inline-flex items-center gap-1 text-info hover:underline"
                  title="Arianna ti chiama quando questo lavoro è finito"
                  @click="emit('callWhenDone', taskOf(message)!.id)"
                ><Icon name="phone" :size="12" />chiamami quando finisci</button>
              </template>
            </div>
          </div>

          <!-- A line of the system about a task: who joined, who left, a wait closed (D-125, D-109) -->
          <p v-else-if="isEventLine(message)" :id="messageAnchor(message.id)" class="msg-row flex items-center justify-center gap-2 text-center text-[12px] text-muted">
            <span class="break-words" :class="isAddingLine(message) ? 'rounded-full border border-line-strong bg-surface-2 px-3 py-1 text-[12.5px] font-medium text-ink' : ''">{{ message.body }}</span>
            <MessageTime class="font-mono text-[10.5px]" :ts="message.ts" :now="now" />
          </p>

          <!-- A report of the agent Arianna delegated to -->
          <article v-else-if="message.agent !== null" :id="messageAnchor(message.id)" class="msg-row hud-card max-w-[92%]" :aria-label="`Rapporto del ${agentName(message.agent)}`">
            <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
              <span class="font-hud text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">{{ agentName(message.agent) }}</span>
              <span class="flex-1 truncate text-xs text-muted">rapporto del lavoro delegato</span>
              <MessageTime class="font-mono text-[10.5px] text-muted" :ts="message.ts" :now="now" />
              <LabelBadge :label="message.label" />
              <MessageActions :message="message" :saved="saved.has(message.id)" :note="saved.get(message.id) ?? null" :can-save="canSaveToInbox(message.label)" :save-off="incognito ? SAVE_OFF_HINT : undefined" @saved="markSaved" @open-knowledge="emit('openKnowledge', $event)" />
            </header>
            <MarkdownText class="px-[15px] py-3" :source="message.body" />
            <CreditLine v-if="credits.get(message.id) !== undefined" class="border-t border-line px-[15px] py-2.5" :credit="credits.get(message.id)!" />
          </article>

          <!-- Arianna (or a system note) -->
          <div v-else :id="messageAnchor(message.id)" class="msg-row max-w-[92%]">
            <div class="mb-1.5 flex items-center gap-2">
              <span class="font-hud text-[10px] font-semibold tracking-[0.16em] uppercase" :class="message.role === 'system' ? 'text-muted' : 'text-accent'">
                {{ message.role === 'system' ? 'Sistema' : message.model !== null ? (MODEL_TEXT[message.model] ?? message.model) : 'Arianna' }}
              </span>
              <span v-if="message.model !== null" class="font-mono text-[10.5px] text-muted" title="Risposta scritta da Claude nel cloud: ha letto questa chat, passata dal gateway">cloud</span>
              <MessageTime class="font-mono text-[10.5px] text-muted" :ts="message.ts" :now="now" />
              <span v-if="message.channel === 'voice'" class="inline-flex items-center gap-1 font-mono text-[10.5px] text-info" title="Detto in una chiamata"><Icon name="phone" :size="12" />a voce</span>
              <LabelBadge :label="message.label" />
              <span
                v-if="repliesToTelegram(message)"
                class="inline-flex items-center gap-1 font-mono text-[10.5px] text-info"
                title="Risposta a un messaggio da Telegram: inviata lì, oppure sostituita da un rimando a questa chat se il gateway l'ha fermata"
              ><Icon name="telegram" :size="12" />Telegram</span>
              <MessageActions
                class="ml-auto"
                :message="message"
                :saved="saved.has(message.id)" :note="saved.get(message.id) ?? null"
                :can-save="message.role !== 'system' && canSaveToInbox(message.label)"
                :save-off="incognito ? SAVE_OFF_HINT : undefined"
                @saved="markSaved"
                @open-knowledge="emit('openKnowledge', $event)"
              />
            </div>
            <div v-if="message.role === 'system'" class="break-words whitespace-pre-wrap">{{ message.body }}</div>
            <MarkdownText v-else :source="message.body" />
            <CreditLine v-if="message.model !== null && credits.get(message.id) !== undefined" class="mt-1.5" :credit="credits.get(message.id)!" />
          </div>

          <!-- What the task is doing, as a HUD card of steps -->
          <article v-if="activityOf(message).length > 0" class="hud-card" :aria-label="`Cosa sta facendo ${directName}`">
            <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
              <span class="flex-1 font-medium">{{ directName }} al lavoro</span>
              <span class="font-mono text-[10.5px] tracking-[0.08em] text-accent uppercase">In corso</span>
            </header>
            <ul class="flex flex-col gap-[7px] px-[15px] py-3 text-[13px]">
              <li v-for="(line, index) in activityOf(message)" :key="`${line.step}-${line.kind}-${line.detail}`" class="flex items-start gap-2.5">
                <span
                  class="w-4 shrink-0 text-center font-mono text-[11px]"
                  :class="
                    index === activityOf(message).length - 1
                      ? 'animate-hud-blink text-accent'
                      : line.kind === 'error'
                        ? 'text-warn'
                        : 'text-ok'
                  "
                  aria-hidden="true"
                >{{ index === activityOf(message).length - 1 ? '▸' : line.kind === 'error' ? '!' : '✓' }}</span>
                <span class="break-words">{{ activityText(line) }}</span>
              </li>
            </ul>
            <LiveEdits v-if="editsOf(message).length > 0" :edits="editsOf(message)" />
          </article>

          <ActivityLog v-if="steps.get(message.id) !== undefined" :key="`steps-${steps.get(message.id)!.taskId}`" :task-id="steps.get(message.id)!.taskId" :count="steps.get(message.id)!.count" />

          <ApprovalCard v-for="approval in approvalsOf(message)" :id="approvalAnchor(approval.id)" :key="approval.id" :approval="approval" :decide="decide" />
          <p v-for="call in receipts.get(index) ?? []" :key="call.id" class="flex items-center justify-center gap-2 text-center font-mono text-[11px] text-muted">
            <Icon name="phone" :size="12" />{{ receiptText(call) }}
            <button v-if="call.status === 'scheduled'" type="button" class="text-info hover:underline" @click="emit('cancelCall', call.id)">annulla</button>
          </p>
        </template>

        <ApprovalCard v-for="approval in unplaced" :id="approvalAnchor(approval.id)" :key="approval.id" :approval="approval" :decide="decide" />

        <div v-for="reply in chat.streaming" :key="reply.replyId" class="max-w-[92%]">
          <div class="mb-1.5 font-hud text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">{{ directName }}</div>
          <MarkdownText :source="reply.text" cursor />
        </div>
      </div>
    </div>

    <div v-if="conversation.archivedAt !== null" class="flex items-center justify-center gap-3 border-t border-line p-3 text-sm text-muted">
      <span>Conversazione archiviata: ripristinala per scrivere.</span>
      <button type="button" class="btn btn-primary" @click="emit('restore')"><Icon name="restore" :size="16" />Ripristina</button>
    </div>
    <div v-else class="shrink-0 border-t border-line px-4 pt-3 pb-4 md:px-5.5">
      <div class="relative mx-auto max-w-[780px]">
        <!-- The "/" menu (D-090) -->
        <div v-if="menuOpen" class="hud-card absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden bg-surface py-1.5 shadow-lg">
          <p class="hud-title px-3.5 pt-1 pb-1.5">Comandi</p>
          <ul id="command-menu" role="listbox" aria-label="Comandi" class="max-h-72 overflow-y-auto">
            <li
              v-for="(command, index) in menuItems"
              :id="`command-${command.name}`"
              :key="command.name"
              role="option"
              :aria-selected="index === activeCommand"
              class="flex cursor-pointer items-baseline gap-3 px-3.5 py-1.5 text-[13px]"
              :class="index === activeCommand ? 'bg-surface-2 text-ink' : 'text-muted'"
              @mousedown.prevent
              @mouseenter="activeCommand = index"
              @click="choose(command, 'enter')"
            >
              <span class="w-36 shrink-0 font-mono sm:w-40" :class="index === activeCommand ? 'text-accent' : 'text-ink'">{{ usage(command) }}</span>
              <span class="min-w-0 flex-1 truncate">{{ command.description }}</span>
              <span v-if="command.alias !== undefined" class="shrink-0 font-mono text-[10.5px] text-muted" :title="`Scorciatoia: /${command.alias}`">/{{ command.alias }}</span>
            </li>
          </ul>
          <p v-if="menuItems.length === 0" class="px-3.5 py-1.5 text-[13px] text-muted">Nessun comando corrisponde: Esc per chiudere.</p>
          <p class="px-3.5 pt-1.5 font-mono text-[10px] text-muted">↑↓ per scegliere · Invio o Tab · Esc per chiudere</p>
        </div>
        <form
          class="flex items-end gap-2.5 rounded-[22px] border border-line-strong bg-surface py-2 pr-2 pl-4"
          @submit.prevent="submit()"
        >
          <label for="composer" class="sr-only">Messaggio</label>
          <textarea
            id="composer"
            ref="composer"
            v-model="draft"
            rows="1"
            maxlength="16000"
            :placeholder="direct === null ? 'Scrivi ad Arianna… (/ per i comandi)' : `Scrivi ${toAgent(direct)}… (/ per i comandi)`"
            class="max-h-48 min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-ink outline-none placeholder:text-muted focus-visible:outline-none"
            role="combobox"
            aria-multiline="true"
            aria-autocomplete="list"
            :aria-controls="menuOpen ? 'command-menu' : undefined"
            :aria-expanded="menuOpen"
            :aria-activedescendant="activeId"
            @keydown="onKey"
            @input="onInput"
          />
          <button
            type="submit"
            :disabled="sending || draft.trim() === ''"
            class="grid size-[38px] shrink-0 place-items-center rounded-full bg-accent text-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Invia"
          >
            <Icon name="send" />
          </button>
        </form>
      </div>
      <div v-if="confirmLong" role="alert" class="mx-auto mt-2 flex max-w-[780px] flex-wrap items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-[13px] text-warn">
        <span class="min-w-0 flex-1">
          Va davvero a Claude? Il messaggio è lungo ({{ draft.length }} caratteri) e parte così com'è: lo scanner non riconosce i dati personali scritti in prosa.
        </span>
        <button ref="confirmButton" type="button" class="btn px-2.5 py-1 text-xs" @click="submit(true)">Invia comunque</button>
        <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink" @click="confirmLong = false">Annulla</button>
      </div>
      <p v-if="commandHint !== null" role="status" class="mx-auto mt-2 max-w-[780px] font-mono text-xs text-warn">{{ commandHint }}</p>
      <p class="mx-auto mt-2 flex max-w-[780px] flex-wrap gap-x-3.5 gap-y-1 font-mono text-[10.5px] text-muted">
        <span v-if="incognito" :title="NOTE_OFF_TEXT">Invio per inviare · Maiusc+Invio a capo · / per i comandi · incognito: /nota e "Salva in inbox" spenti, "Copia" funziona</span>
        <span v-else>Invio per inviare · Maiusc+Invio a capo · / per i comandi · /nota testo: salva in kb/inbox (Privato), {{ direct === null ? 'senza Arianna' : `senza ${directName}` }}</span>
        <span class="inline-flex flex-wrap items-center gap-1.5">
          Etichetta <LabelBadge :label="conversation.clearance" />: {{ cloud ? 'fino a Interno, ogni messaggio va così com\'è a Claude, senza Arianna. Niente dati privati.' : MODE_HINT[conversation.mode] }}
          <button type="button" class="underline decoration-dotted underline-offset-2 hover:text-ink" @click="emit('legend')">Cosa vogliono dire le etichette?</button>
        </span>
      </p>
    </div>
  </section>
</template>

<style scoped>
/* D-099: the actions of a message (MessageActions.vue) appear with the pointer on the message or the focus in it. */
.msg-row:hover .msg-actions,
.msg-row:focus-within .msg-actions {
  opacity: 1;
}
</style>

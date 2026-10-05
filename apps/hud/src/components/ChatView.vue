<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { stepsAnchors } from '../lib/activity-log.ts';
import { approvalAnchor, clearFocus, FOCUS_EVENT, HIGHLIGHT_CLASSES, HIGHLIGHT_MS, messageAnchor, parseAnchor, pendingFocus, requestFocus } from '../lib/chat-focus.ts';
import { canSaveToInbox } from '../lib/capture.ts';
import { completion, filterCommands, menuQuery, moveSelection, resolveDraft, usage, type ChatCommand, type CommandAction } from '../lib/commands.ts';
import { receiptAnchors, receiptText, type CallInfo } from '../lib/calls.ts';
import type { ChatState } from '../lib/chat-state.ts';
import { DIRECT_MODELS } from '../lib/failures.ts';
import { activityText, agentName, reasonText, SAVE_TO_INBOX_HINT, SAVE_TO_INBOX_TEXT, SEARCH_LATER_TEXT } from '../lib/italian.ts';
import { LABEL_TEXT, MODE_HINT, MODE_TEXT, MODEL_TEXT, STATUS_TEXT, EXECUTOR_TEXT } from '../lib/labels.ts';
import { POSE_TEXT, type Pose } from '../lib/sprites.ts';
import type { Activity, Approval, CharacterChoice, CloudModel, Conversation, Label, Message, MessageCredit, StatusSnapshot, Task } from '../lib/types.ts';
import ActivityLog from './ActivityLog.vue';
import ApprovalCard from './ApprovalCard.vue';
import CreditLine from './CreditLine.vue';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';
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
}>();

const receipts = computed(() => receiptAnchors(props.chat.messages, props.calls));
const steps = computed(() => stepsAnchors(props.chat.messages, props.tasks, props.activityCounts));
const emit = defineEmits<{
  send: [body: string];
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
  /** "Salva in inbox" (D-084): the message's text as a note in kb/inbox. */
  saveToInbox: [text: string, label: Label];
  /** A "/" command the page carries out (D-090): open a page, a new conversation. */
  command: [action: Exclude<CommandAction, { kind: 'note' | 'help' | 'search' }>];
}>();

/** A task still at work can ask for a call when it ends, unless one is already waiting for it. */
function canCallWhenDone(task: Task | undefined): boolean {
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
const selectable = computed(() =>
  answersDirect.value ? props.models.filter((entry) => entry.executor === 'claude' && DIRECT_MODELS.includes(entry.model)) : props.models,
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
const answerModel = computed(() => (directModel.value === null ? 'locale' : (MODEL_TEXT[directModel.value] ?? directModel.value)));

const draft = ref('');
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
  const status = props.tasks[message.taskId]?.status;
  if (status !== undefined && status !== 'ready' && status !== 'running') return [];
  return props.chat.activity[message.taskId] ?? [];
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
    case 'search':
      commandHint.value = SEARCH_LATER_TEXT;
      setDraft('');
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

function submit(): void {
  const body = draft.value;
  if (body.trim() === '' || props.sending) return;
  commandHint.value = null;
  const meaning = resolveDraft(body);
  if (meaning.kind === 'command' && meaning.command.action.kind !== 'note') {
    run(meaning.command);
    return;
  }
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
    submit();
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
const labelClass: Record<string, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };
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
            <PixelAgent :choice="arianna.choice" :pose="arianna.pose" :scale="2" bubble label="Arianna" />
          </div>
          <div class="min-w-0">
            <h2 class="font-hud text-lg leading-tight font-semibold tracking-[0.05em]">Arianna</h2>
            <p class="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
              <span v-if="arianna.pose === 'thinking'" class="inline-flex gap-1" aria-hidden="true">
                <i v-for="dot in 3" :key="dot" class="animate-hud-bob size-[5px] rounded-full bg-accent" :style="{ animationDelay: `${String((dot - 1) * 0.15)}s` }" />
              </span>
              {{ POSE_TEXT[arianna.pose] }}
            </p>
            <p class="mt-1 text-xs text-muted sm:hidden">{{ MODE_HINT[conversation.mode] }}</p>
          </div>
          <div class="ml-auto hidden text-right font-mono text-[10.5px] leading-[1.7] text-muted sm:block">
            <div>
              CONVERSAZIONE <b class="font-medium text-ink">{{ MODE_TEXT[conversation.mode].toLowerCase() }}<template v-if="conversation.workspace"> · {{ conversation.workspace.split('/').at(-1) }}</template></b>
            </div>
            <div>MODELLO <b class="font-medium" :class="answerModel === 'locale' ? 'text-ink' : 'text-l1'">{{ answerModel }}</b></div>
            <div v-if="conversation.mode === 'work'">
              <label class="inline-flex items-center gap-1">
                {{ answersDirect ? 'RISPONDE →' : 'CODER →' }}
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

        <!-- The model selector on small screens -->
        <label v-if="conversation.mode === 'work'" class="flex items-center gap-2 text-xs text-muted sm:hidden">
          {{ answersDirect ? 'Risponde' : 'Coder su' }}
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
          <div v-if="message.role === 'user'" :id="messageAnchor(message.id)" class="flex flex-col items-end gap-1">
            <div class="max-w-[90%] rounded-[17px_17px_5px_17px] bg-bubble px-[15px] py-[11px] break-words whitespace-pre-wrap text-bubble-ink md:max-w-[78%]">
              {{ message.body }}
            </div>
            <div class="flex items-center gap-2 px-1 font-mono text-[10.5px] text-muted">
              <span class="lab" :class="labelClass[message.label]" :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
              <span v-if="message.channel === 'telegram'" class="inline-flex items-center gap-1 text-info" title="Scritto da Telegram"><Icon name="telegram" :size="12" />Telegram</span>
              <span v-if="message.channel === 'voice'" class="inline-flex items-center gap-1 text-info" title="Detto in una chiamata"><Icon name="phone" :size="12" />a voce</span>
              <button
                v-if="canSaveToInbox(message.label)"
                type="button"
                class="inline-flex items-center gap-1 hover:text-ink"
                :title="SAVE_TO_INBOX_HINT"
                @click="emit('saveToInbox', message.body, message.label)"
              >
                <Icon name="inbox" :size="12" />{{ SAVE_TO_INBOX_TEXT }}
              </button>
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

          <!-- A report of the agent Arianna delegated to -->
          <article v-else-if="message.agent !== null" :id="messageAnchor(message.id)" class="hud-card max-w-[92%]" :aria-label="`Rapporto del ${agentName(message.agent)}`">
            <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
              <span class="font-hud text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">{{ agentName(message.agent) }}</span>
              <span class="flex-1 truncate text-xs text-muted">rapporto del lavoro delegato</span>
              <span class="lab" :class="labelClass[message.label]" :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
              <button
                v-if="canSaveToInbox(message.label)"
                type="button"
                class="inline-flex items-center gap-1 font-mono text-[10.5px] text-muted hover:text-ink"
                :title="SAVE_TO_INBOX_HINT"
                @click="emit('saveToInbox', message.body, message.label)"
              ><Icon name="inbox" :size="12" />{{ SAVE_TO_INBOX_TEXT }}</button>
            </header>
            <MarkdownText class="px-[15px] py-3" :source="message.body" />
            <CreditLine v-if="credits.get(message.id) !== undefined" class="border-t border-line px-[15px] py-2.5" :credit="credits.get(message.id)!" />
          </article>

          <!-- Arianna (or a system note) -->
          <div v-else :id="messageAnchor(message.id)" class="max-w-[92%]">
            <div class="mb-1.5 flex items-center gap-2">
              <span class="font-hud text-[10px] font-semibold tracking-[0.16em] uppercase" :class="message.role === 'system' ? 'text-muted' : 'text-accent'">
                {{ message.role === 'system' ? 'Sistema' : message.model !== null ? (MODEL_TEXT[message.model] ?? message.model) : 'Arianna' }}
              </span>
              <span v-if="message.model !== null" class="font-mono text-[10.5px] text-muted" title="Risposta scritta da Claude nel cloud: ha letto questa chat, passata dal gateway">cloud</span>
              <span v-if="message.channel === 'voice'" class="inline-flex items-center gap-1 font-mono text-[10.5px] text-info" title="Detto in una chiamata"><Icon name="phone" :size="12" />a voce</span>
              <span class="lab" :class="labelClass[message.label]" :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
              <span
                v-if="repliesToTelegram(message)"
                class="inline-flex items-center gap-1 font-mono text-[10.5px] text-info"
                title="Risposta a un messaggio da Telegram: inviata lì, oppure sostituita da un rimando a questa chat se il gateway l'ha fermata"
              ><Icon name="telegram" :size="12" />Telegram</span>
              <button
                v-if="message.role !== 'system' && canSaveToInbox(message.label)"
                type="button"
                class="ml-auto inline-flex items-center gap-1 font-mono text-[10.5px] text-muted hover:text-ink"
                :title="SAVE_TO_INBOX_HINT"
                @click="emit('saveToInbox', message.body, message.label)"
              ><Icon name="inbox" :size="12" />{{ SAVE_TO_INBOX_TEXT }}</button>
            </div>
            <div v-if="message.role === 'system'" class="break-words whitespace-pre-wrap">{{ message.body }}</div>
            <MarkdownText v-else :source="message.body" />
            <CreditLine v-if="message.model !== null && credits.get(message.id) !== undefined" class="mt-1.5" :credit="credits.get(message.id)!" />
          </div>

          <!-- What the task is doing, as a HUD card of steps -->
          <article v-if="activityOf(message).length > 0" class="hud-card" aria-label="Cosa sta facendo Arianna">
            <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
              <span class="flex-1 font-medium">Arianna al lavoro</span>
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
          <div class="mb-1.5 font-hud text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">Arianna</div>
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
          @submit.prevent="submit"
        >
          <label for="composer" class="sr-only">Messaggio</label>
          <textarea
            id="composer"
            ref="composer"
            v-model="draft"
            rows="1"
            maxlength="16000"
            placeholder="Scrivi ad Arianna… (/ per i comandi)"
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
      <p v-if="commandHint !== null" role="status" class="mx-auto mt-2 max-w-[780px] font-mono text-xs text-warn">{{ commandHint }}</p>
      <p class="mx-auto mt-2 flex max-w-[780px] flex-wrap gap-x-3.5 gap-y-1 font-mono text-[10.5px] text-muted">
        <span>Invio per inviare · Maiusc+Invio a capo · / per i comandi · /nota testo: salva in kb/inbox (L2), senza Arianna</span>
        <span>Etichetta <b class="font-medium" :class="labelClass[conversation.clearance]">{{ conversation.clearance }}</b>: {{ MODE_HINT[conversation.mode] }}</span>
      </p>
    </div>
  </section>
</template>

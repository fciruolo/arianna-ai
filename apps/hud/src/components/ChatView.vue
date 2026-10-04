<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type { ChatState } from '../lib/chat-state.ts';
import { activityText, agentName, reasonText } from '../lib/italian.ts';
import { LABEL_TEXT, MODE_HINT, MODE_TEXT, MODEL_TEXT, STATUS_TEXT, EXECUTOR_TEXT } from '../lib/labels.ts';
import { POSE_TEXT, type Pose } from '../lib/sprites.ts';
import type { Activity, Approval, CharacterChoice, CloudModel, Conversation, Message, StatusSnapshot, Task } from '../lib/types.ts';
import ApprovalCard from './ApprovalCard.vue';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

const props = defineProps<{
  chat: ChatState;
  conversation: Conversation;
  tasks: Record<string, Task>;
  sending: boolean;
  models: CloudModel[];
  /** Pending approvals of this conversation's tasks, shown under the message that started the task. */
  approvals: Approval[];
  decide: (approval: Approval, state: 'approved' | 'rejected') => Promise<void>;
  arianna: { choice: CharacterChoice | undefined; pose: Pose };
  status: StatusSnapshot | null;
}>();
const emit = defineEmits<{ send: [body: string]; chooseModel: [model: string | null]; restore: [] }>();

/** The selector of the cloud model for delegated steps: work conversations only (D-055). */
const AUTO = '';
function onModel(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('chooseModel', value === AUTO ? null : value);
}

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

function submit(): void {
  const body = draft.value;
  if (body.trim() === '' || props.sending) return;
  emit('send', body);
  draft.value = '';
  void nextTick(resize);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
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
            <div>MODELLO <b class="font-medium text-ink">locale</b></div>
            <div v-if="conversation.mode === 'work'">
              <label class="inline-flex items-center gap-1">
                CODER →
                <select :value="conversation.model ?? AUTO" class="field px-1.5 py-0.5 font-mono text-[10.5px]" aria-label="Modello per i passi delegati" @change="onModel">
                  <option :value="AUTO">automatico (router)</option>
                  <option v-for="entry in models" :key="entry.model" :value="entry.model">{{ MODEL_TEXT[entry.model] ?? entry.model }}</option>
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
          Coder su
          <select :value="conversation.model ?? AUTO" class="field px-2 py-1 text-xs" aria-label="Modello per i passi delegati" @change="onModel">
            <option :value="AUTO">automatico (router)</option>
            <option v-for="entry in models" :key="entry.model" :value="entry.model">{{ MODEL_TEXT[entry.model] ?? entry.model }}</option>
          </select>
        </label>

        <p v-if="chat.messages.length === 0" class="text-center text-sm text-muted">Scrivi il primo messaggio.</p>

        <template v-for="message in chat.messages" :key="message.id">
          <!-- User -->
          <div v-if="message.role === 'user'" class="flex flex-col items-end gap-1">
            <div class="max-w-[90%] rounded-[17px_17px_5px_17px] bg-bubble px-[15px] py-[11px] break-words whitespace-pre-wrap text-bubble-ink md:max-w-[78%]">
              {{ message.body }}
            </div>
            <div class="flex items-center gap-2 px-1 font-mono text-[10.5px] text-muted">
              <span class="lab" :class="labelClass[message.label]" :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
              <span v-if="message.channel === 'telegram'" class="inline-flex items-center gap-1 text-info" title="Scritto da Telegram"><Icon name="telegram" :size="12" />Telegram</span>
              <template v-if="taskOf(message) !== undefined">
                <span :class="statusClass[taskOf(message)!.status]">{{ STATUS_TEXT[taskOf(message)!.status] }}</span>
                <span v-if="reasonText(taskOf(message)!.waitingReason) !== undefined">— {{ reasonText(taskOf(message)!.waitingReason) }}</span>
              </template>
            </div>
          </div>

          <!-- A report of the agent Arianna delegated to -->
          <article v-else-if="message.agent !== null" class="hud-card max-w-[92%]" :aria-label="`Rapporto del ${agentName(message.agent)}`">
            <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
              <span class="font-hud text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">{{ agentName(message.agent) }}</span>
              <span class="flex-1 truncate text-xs text-muted">rapporto del lavoro delegato</span>
              <span class="lab" :class="labelClass[message.label]" :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
            </header>
            <div class="px-[15px] py-3 break-words whitespace-pre-wrap">{{ message.body }}</div>
          </article>

          <!-- Arianna (or a system note) -->
          <div v-else class="max-w-[92%]">
            <div class="mb-1.5 flex items-center gap-2">
              <span class="font-hud text-[10px] font-semibold tracking-[0.16em] uppercase" :class="message.role === 'system' ? 'text-muted' : 'text-accent'">
                {{ message.role === 'system' ? 'Sistema' : 'Arianna' }}
              </span>
              <span class="lab" :class="labelClass[message.label]" :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
              <span
                v-if="repliesToTelegram(message)"
                class="inline-flex items-center gap-1 font-mono text-[10.5px] text-info"
                title="Risposta a un messaggio da Telegram: inviata lì, oppure sostituita da un rimando a questa chat se il gateway l'ha fermata"
              ><Icon name="telegram" :size="12" />Telegram</span>
            </div>
            <div class="break-words whitespace-pre-wrap">{{ message.body }}</div>
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

          <ApprovalCard v-for="approval in approvalsOf(message)" :key="approval.id" :approval="approval" :decide="decide" />
        </template>

        <ApprovalCard v-for="approval in unplaced" :key="approval.id" :approval="approval" :decide="decide" />

        <div v-for="reply in chat.streaming" :key="reply.replyId" class="max-w-[92%]">
          <div class="mb-1.5 font-hud text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">Arianna</div>
          <div class="break-words whitespace-pre-wrap">
            {{ reply.text }}<span class="animate-hud-blink ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-accent" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>

    <div v-if="conversation.archivedAt !== null" class="flex items-center justify-center gap-3 border-t border-line p-3 text-sm text-muted">
      <span>Conversazione archiviata: ripristinala per scrivere.</span>
      <button type="button" class="btn btn-primary" @click="emit('restore')"><Icon name="restore" :size="16" />Ripristina</button>
    </div>
    <div v-else class="shrink-0 border-t border-line px-4 pt-3 pb-4 md:px-5.5">
      <form
        class="mx-auto flex max-w-[780px] items-end gap-2.5 rounded-[22px] border border-line-strong bg-surface py-2 pr-2 pl-4 shadow-[0_0_0_4px_var(--glow)]"
        @submit.prevent="submit"
      >
        <label for="composer" class="sr-only">Messaggio</label>
        <textarea
          id="composer"
          ref="composer"
          v-model="draft"
          rows="1"
          maxlength="16000"
          placeholder="Scrivi ad Arianna…"
          class="max-h-48 min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-ink outline-none placeholder:text-muted focus-visible:outline-none"
          @keydown="onKey"
          @input="resize"
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
      <p class="mx-auto mt-2 flex max-w-[780px] flex-wrap gap-x-3.5 gap-y-1 font-mono text-[10.5px] text-muted">
        <span>Invio per inviare · Maiusc+Invio a capo</span>
        <span>Etichetta <b class="font-medium" :class="labelClass[conversation.clearance]">{{ conversation.clearance }}</b>: {{ MODE_HINT[conversation.mode] }}</span>
      </p>
    </div>
  </section>
</template>

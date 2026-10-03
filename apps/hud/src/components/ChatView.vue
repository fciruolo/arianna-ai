<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type { ChatState } from '../lib/chat-state.ts';
import { activityText, agentName, reasonText } from '../lib/italian.ts';
import { LABEL_TEXT, MODE_HINT, MODE_TEXT, MODEL_TEXT, STATUS_TEXT } from '../lib/labels.ts';
import type { Activity, CloudModel, Conversation, Message, Task } from '../lib/types.ts';

const props = defineProps<{ chat: ChatState; conversation: Conversation; tasks: Record<string, Task>; sending: boolean; models: CloudModel[] }>();
const emit = defineEmits<{ send: [body: string]; chooseModel: [model: string | null] }>();

/** The selector of the cloud model for delegated steps: work conversations only (D-055). */
const AUTO = '';
function onModel(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('chooseModel', value === AUTO ? null : value);
}

const draft = ref('');
const list = ref<HTMLElement | null>(null);

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

function submit(): void {
  const body = draft.value;
  if (body.trim() === '' || props.sending) return;
  emit('send', body);
  draft.value = '';
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

// Follow new messages and fragments, unless the user scrolled up to read.
watch(
  () => [props.chat.messages.length, props.chat.streaming.map((reply) => reply.text.length).join()],
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
  inbox: 'text-stone-500',
  ready: 'text-stone-500',
  running: 'text-indigo-600 dark:text-indigo-400',
  waiting_user: 'text-amber-700 dark:text-amber-400',
  to_verify: 'text-sky-700 dark:text-sky-400',
  done: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-rose-700 dark:text-rose-400',
};
</script>

<template>
  <section class="flex flex-col" :aria-label="`Conversazione ${MODE_TEXT[conversation.mode]}`">
    <header class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
      <span
        class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
        :class="
          conversation.mode === 'private'
            ? 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200'
            : 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200'
        "
      >
        {{ MODE_TEXT[conversation.mode] }} · fino a {{ conversation.clearance }}
      </span>
      <span v-if="conversation.workspace" class="font-mono text-xs text-stone-500">{{ conversation.workspace }}</span>
      <span class="text-xs text-stone-500 dark:text-stone-400">{{ MODE_HINT[conversation.mode] }}</span>
      <label v-if="conversation.mode === 'work'" class="ml-auto flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-300">
        <span>Coder su</span>
        <select
          :value="conversation.model ?? AUTO"
          class="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
          aria-label="Modello per i passi delegati"
          @change="onModel"
        >
          <option :value="AUTO">automatico (router)</option>
          <option v-for="entry in models" :key="entry.model" :value="entry.model">{{ MODEL_TEXT[entry.model] ?? entry.model }}</option>
        </select>
      </label>
      <span v-else class="ml-auto text-xs text-stone-500 dark:text-stone-400">solo modello locale</span>
    </header>

    <div ref="list" class="min-h-0 flex-1 overflow-y-auto px-4 py-6" aria-live="polite">
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <p v-if="chat.messages.length === 0" class="text-center text-sm text-stone-500 dark:text-stone-400">Scrivi il primo messaggio.</p>

        <div v-for="message in chat.messages" :key="message.id" class="flex flex-col" :class="message.role === 'user' ? 'items-end' : 'items-start'">
          <div
            class="max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words"
            :class="
              message.role === 'user'
                ? 'rounded-br-md bg-indigo-600 text-white'
                : message.agent !== null
                  ? 'rounded-bl-md border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30'
                  : 'rounded-bl-md border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'
            "
          >
            {{ message.body }}
          </div>
          <div class="mt-1 flex items-center gap-2 px-1 text-[11px] text-stone-500 dark:text-stone-400">
            <span
              v-if="message.agent !== null"
              class="rounded bg-emerald-100 px-1.5 py-px font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              title="Rapporto dell’agente a cui Arianna ha delegato il passo"
            >{{ agentName(message.agent) }}</span>
            <span :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
            <span
              v-if="message.channel === 'telegram'"
              class="rounded bg-sky-100 px-1.5 py-px font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200"
              title="Scritto da Telegram"
            >Telegram</span>
            <span
              v-else-if="repliesToTelegram(message)"
              class="rounded bg-sky-100 px-1.5 py-px font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200"
              title="Risposta a un messaggio da Telegram: inviata lì, oppure sostituita da un rimando a questa chat se il gateway l'ha fermata"
            >→ Telegram</span>
            <template v-if="taskOf(message) !== undefined">
              <span aria-hidden="true">·</span>
              <span :class="statusClass[taskOf(message)!.status]">{{ STATUS_TEXT[taskOf(message)!.status] }}</span>
              <span v-if="reasonText(taskOf(message)!.waitingReason) !== undefined" class="text-stone-500">— {{ reasonText(taskOf(message)!.waitingReason) }}</span>
            </template>
          </div>
          <ul
            v-if="activityOf(message).length > 0"
            class="mt-2 flex max-w-[85%] flex-col gap-1 self-start rounded-xl border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-400"
            aria-label="Cosa sta facendo Arianna"
          >
            <li v-for="line in activityOf(message)" :key="`${line.step}-${line.kind}-${line.detail}`" class="flex items-start gap-2">
              <span
                class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                :class="
                  line.kind === 'thinking' || line.kind === 'wait'
                    ? 'animate-pulse bg-indigo-500'
                    : line.kind === 'error'
                      ? 'bg-amber-500'
                      : line.kind === 'delegate' || line.kind === 'tool'
                        ? 'bg-emerald-500'
                        : 'bg-stone-400'
                "
                aria-hidden="true"
              />
              <span class="break-words">{{ activityText(line) }}</span>
            </li>
          </ul>
        </div>

        <div v-for="reply in chat.streaming" :key="reply.replyId" class="flex flex-col items-start">
          <div
            class="max-w-[85%] rounded-2xl rounded-bl-md border border-stone-200 bg-white px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words dark:border-stone-800 dark:bg-stone-900"
          >
            {{ reply.text }}<span class="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-stone-400" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>

    <form class="border-t border-stone-200 p-3 dark:border-stone-800" @submit.prevent="submit">
      <div class="mx-auto flex max-w-3xl items-end gap-2">
        <label for="composer" class="sr-only">Messaggio</label>
        <textarea
          id="composer"
          v-model="draft"
          rows="1"
          maxlength="16000"
          placeholder="Scrivi ad Arianna…"
          class="max-h-48 min-h-11 flex-1 resize-y rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-stone-700 dark:bg-stone-900"
          @keydown="onKey"
        />
        <button
          type="submit"
          :disabled="sending || draft.trim() === ''"
          class="h-11 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Invia
        </button>
      </div>
    </form>
  </section>
</template>

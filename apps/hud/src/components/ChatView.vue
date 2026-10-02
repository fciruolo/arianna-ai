<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

import type { ChatState } from '../lib/chat-state.ts';
import { LABEL_TEXT, MODE_HINT, MODE_TEXT, STATUS_TEXT } from '../lib/labels.ts';
import type { Conversation, Message, Task } from '../lib/types.ts';

const props = defineProps<{ chat: ChatState; conversation: Conversation; tasks: Record<string, Task>; sending: boolean }>();
const emit = defineEmits<{ send: [body: string] }>();

const draft = ref('');
const list = ref<HTMLElement | null>(null);

/** The task a user message started, shown under it while it is not settled. */
function taskOf(message: Message): Task | undefined {
  return message.role === 'user' && message.taskId !== null ? props.tasks[message.taskId] : undefined;
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
                : 'rounded-bl-md border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'
            "
          >
            {{ message.body }}
          </div>
          <div class="mt-1 flex items-center gap-2 px-1 text-[11px] text-stone-500 dark:text-stone-400">
            <span :title="LABEL_TEXT[message.label]">{{ message.label }}</span>
            <template v-if="taskOf(message) !== undefined">
              <span aria-hidden="true">·</span>
              <span :class="statusClass[taskOf(message)!.status]">{{ STATUS_TEXT[taskOf(message)!.status] }}</span>
              <span v-if="taskOf(message)!.waitingReason" class="text-stone-500">— {{ taskOf(message)!.waitingReason }}</span>
            </template>
          </div>
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

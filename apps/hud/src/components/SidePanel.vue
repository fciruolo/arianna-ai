<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  closesPanel,
  SIDE_ABOUT_TEXT,
  SIDE_BLOCKED_TEXT,
  SIDE_CLOSE_TEXT,
  SIDE_EMPTY_TEXT,
  SIDE_FAILED_TEXT,
  SIDE_PLACEHOLDER,
  SIDE_QUEUED_TEXT,
  SIDE_SEND_TEXT,
  SIDE_TITLE,
  SIDE_WAITING_TEXT,
  SIDE_WORKING_TEXT,
  sideExcerpt,
  sideMessages,
  sideStatus,
  sideWho,
} from '../lib/side-chat.ts';
import type { SidePanel } from '../lib/side-store.ts';
import type { Task } from '../lib/types.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * «Chiedi a lato» (D-232): the side thread of one answer, in a panel at the
 * right of the chat (the whole page on a narrow screen). What is asked here
 * stays here: the conversation never rereads it. Esc closes the panel, also
 * from its field; the same answer opens the same thread again.
 */
const props = defineProps<{
  panel: SidePanel;
  tasks: Record<string, Task>;
  sending: boolean;
  queued: boolean;
  error: string | null;
  /** Who answers the conversation: the same answers here. */
  agent: string | null;
  /** Sends a question; false when it did not leave, and it comes back in the field. */
  send: (body: string) => Promise<boolean>;
}>();
const emit = defineEmits<{ close: [] }>();

const draft = ref('');
const field = ref<HTMLTextAreaElement | null>(null);
const list = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);

const messages = computed(() => sideMessages(props.panel.chat));
const streaming = computed(() => props.panel.chat?.streaming ?? []);
const status = computed(() => sideStatus(props.panel.chat, props.tasks));
/** The latest task waits for an approval (a pending decision) rather than for a reason of the core. */
const waitsDecision = computed(() => {
  const last = [...messages.value].reverse().find((message) => message.role === 'user' && message.taskId !== null);
  return last?.taskId != null && props.tasks[last.taskId]?.waitingApprovalId != null;
});
const who = computed(() => sideWho(props.agent));
const excerpt = computed(() => sideExcerpt(props.panel.origin.body));

async function submit(): Promise<void> {
  const body = draft.value;
  if (body.trim() === '' || props.sending) return;
  draft.value = '';
  // A question that did not leave comes back in the field, never lost (when the field is still empty).
  if (!(await props.send(body)) && draft.value === '') draft.value = body;
}

function onFieldKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

/** Esc closes the panel from anywhere in it, and from the page when no other field is being written in. */
function onKey(event: KeyboardEvent): void {
  if (!closesPanel(event) || event.defaultPrevented) return;
  const target = event.target;
  const inside = target instanceof Node && root.value?.contains(target) === true;
  if (!inside && target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  event.preventDefault();
  emit('close');
}

async function toBottom(): Promise<void> {
  await nextTick();
  if (list.value !== null) list.value.scrollTop = list.value.scrollHeight;
}
watch(() => [messages.value.length, streaming.value.map((reply) => reply.text.length).join(',')], () => void toBottom());
// Another answer opened in the same panel: the field starts empty.
watch(
  () => props.panel.origin.id,
  () => {
    draft.value = '';
    void toBottom();
    field.value?.focus();
  },
);

onMounted(() => {
  window.addEventListener('keydown', onKey);
  field.value?.focus();
  void toBottom();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <aside ref="root" class="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-[0_14px_40px_#0006] md:max-w-[440px]" aria-labelledby="side-title">
    <header class="flex items-start gap-2 border-b border-line px-5 py-4">
      <div class="min-w-0 flex-1">
        <h2 id="side-title" class="flex items-center gap-2 text-[16px] font-semibold"><Icon name="panel" :size="16" />{{ SIDE_TITLE }}</h2>
        <p class="mt-1 text-xs text-muted">Risponde {{ who }}, come nella conversazione. Qui non entra nella conversazione.</p>
      </div>
      <button type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" :aria-label="SIDE_CLOSE_TEXT" :title="SIDE_CLOSE_TEXT" @click="emit('close')">
        <Icon name="close" :size="16" />
      </button>
    </header>

    <div class="border-b border-line px-5 py-3">
      <p class="flex items-center gap-2 font-mono text-[12px] text-muted">{{ SIDE_ABOUT_TEXT }} <LabelBadge :label="panel.origin.label" /></p>
      <p class="mt-1 text-[13.5px] break-words text-ink">{{ excerpt }}</p>
    </div>

    <div ref="list" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4" aria-live="polite">
      <p v-if="messages.length === 0 && streaming.length === 0" class="text-sm text-muted">{{ SIDE_EMPTY_TEXT }}</p>
      <template v-for="message in messages" :key="message.id">
        <div v-if="message.role === 'user'" class="flex justify-end">
          <div class="max-w-[90%] rounded-[17px_17px_5px_17px] bg-bubble px-[15px] py-[11px] break-words whitespace-pre-wrap text-bubble-ink">{{ message.body }}</div>
        </div>
        <div v-else class="max-w-full">
          <MarkdownText :source="message.body" />
        </div>
      </template>
      <div v-for="reply in streaming" :key="reply.replyId" class="max-w-full">
        <MarkdownText :source="reply.text" />
      </div>
      <p v-if="status === 'working' && streaming.length === 0" class="text-sm text-muted">{{ SIDE_WORKING_TEXT }}</p>
      <p v-else-if="status === 'failed'" class="text-sm text-warn">{{ SIDE_FAILED_TEXT }}</p>
      <p v-else-if="status === 'waiting'" class="text-sm text-warn">{{ waitsDecision ? SIDE_WAITING_TEXT : SIDE_BLOCKED_TEXT }}</p>
      <p v-if="queued" class="text-sm text-muted">{{ SIDE_QUEUED_TEXT }}</p>
      <p v-if="error !== null" class="text-sm text-warn" role="alert">{{ error }}</p>
    </div>

    <form class="flex items-end gap-2 border-t border-line px-4 py-3" @submit.prevent="submit()">
      <label for="side-field" class="sr-only">Domanda a lato</label>
      <textarea
        id="side-field"
        ref="field"
        v-model="draft"
        rows="2"
        maxlength="16000"
        :placeholder="SIDE_PLACEHOLDER"
        class="max-h-40 min-w-0 flex-1 resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none placeholder:text-muted focus-visible:outline-none"
        @keydown="onFieldKey"
      />
      <button type="submit" class="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink disabled:opacity-50" :disabled="sending || draft.trim() === ''">{{ SIDE_SEND_TEXT }}</button>
    </form>
  </aside>
</template>

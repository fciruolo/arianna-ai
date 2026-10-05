<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { errorText } from '../lib/italian.ts';
import { FOCUS_EVENT, requestFocus } from '../lib/chat-focus.ts';
import { pendingItems, pendingTotal, type PendingItem } from '../lib/pending.ts';
import { loadPending, type PendingData } from '../lib/pending-api.ts';
import { hiddenText, PENDING_EMPTY, PENDING_TITLE, waitingSinceText } from '../lib/pending-text.ts';
import Icon from './Icon.vue';

/**
 * "Decisioni in attesa" (D-091): every pending approval and every task
 * waiting for the user (a question of Arianna, a task that stopped), oldest
 * first, with its kind, conversation, a short line of what it asks and how
 * long it has waited. A click opens the conversation and brings the card or
 * the message into view, where it is decided or answered. Read again when the
 * status or the approvals change, and every 10 s while open.
 */
const props = defineProps<{ signal: unknown }>();
const emit = defineEmits<{ close: []; open: [conversationId: string] }>();

const REFRESH_MS = 10_000;

const data = ref<PendingData | null>(null);
const problem = ref<string | null>(null);
const now = ref(new Date());
const dialog = ref<HTMLElement | null>(null);
let timer: number | undefined;
let opener: Element | null = null;

const items = computed<PendingItem[]>(() =>
  data.value === null ? [] : pendingItems(data.value.approvals, data.value.tasks, data.value.titles, data.value.waiting),
);
const hidden = computed(() => data.value?.hidden ?? 0);
const total = computed(() => pendingTotal(items.value, hidden.value));

/** Each read gets a number: an answer overtaken by a later read is dropped. */
let latest = 0;

async function refresh(): Promise<void> {
  const request = ++latest;
  try {
    const read = await loadPending();
    if (request !== latest) return;
    data.value = read;
    problem.value = null;
  } catch (cause) {
    if (request !== latest) return;
    problem.value = errorText(cause);
  }
  now.value = new Date();
}

function choose(item: PendingItem): void {
  if (item.conversationId === null) return;
  if (item.anchor !== null) {
    requestFocus(item.conversationId, item.anchor);
    window.dispatchEvent(new Event(FOCUS_EVENT));
  }
  emit('close');
  emit('open', item.conversationId);
}

function focusables(): HTMLElement[] {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [])];
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Capture phase: the window closes alone, the panels below (Conoscenza, Pensieri) never see this Esc.
    event.preventDefault();
    event.stopImmediatePropagation();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const list = focusables();
  const first = list[0];
  const last = list.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    dialog.value?.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active !== null && dialog.value?.contains(active) === true;
  if (event.shiftKey && (active === first || !inside || active === dialog.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}

watch(() => props.signal, refresh);

onMounted(() => {
  opener = document.activeElement;
  window.addEventListener('keydown', onKey, true);
  dialog.value?.focus();
  void refresh();
  timer = window.setInterval(() => void refresh(), REFRESH_MS);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  window.clearInterval(timer);
  if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
});
</script>

<template>
  <div class="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" @click.self="emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pending-title"
      tabindex="-1"
      class="hud-card warn flex max-h-[90vh] w-full max-w-[560px] flex-col bg-surface outline-none"
    >
      <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span class="text-warn"><Icon name="warning" :size="18" /></span>
        <h2 id="pending-title" class="min-w-0 flex-1 truncate font-medium">{{ PENDING_TITLE }}</h2>
        <small v-if="total > 0" class="font-mono text-[10.5px] text-muted">{{ total }}</small>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-[15px] py-3 text-[13.5px]">
        <p v-if="problem !== null" class="text-warn">{{ problem }}</p>
        <p v-if="data === null && problem === null" class="text-muted">Lettura in corso…</p>
        <p v-else-if="data !== null && total === 0" class="py-6 text-center text-muted">{{ PENDING_EMPTY }}</p>
        <ul v-if="items.length > 0" class="flex flex-col gap-2">
          <li v-for="item in items" :key="item.key">
            <button
              type="button"
              class="flex w-full flex-col gap-1 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-left enabled:hover:border-accent disabled:cursor-default"
              :disabled="item.conversationId === null"
              :title="item.conversationId === null ? 'Questa richiesta non appartiene a una conversazione' : item.anchor === null ? 'Apri la conversazione' : 'Apri la conversazione e vai al punto'"
              @click="choose(item)"
            >
              <span class="flex items-center gap-2 text-xs">
                <span class="font-mono text-[10.5px] tracking-[0.06em] text-warn uppercase">{{ item.kindText }}</span>
                <span class="ml-auto shrink-0 font-mono text-[10.5px] text-muted">{{ waitingSinceText(item.since, now) }}</span>
              </span>
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate font-semibold">{{ item.conversationTitle }}</span>
                <span v-if="item.archived" class="shrink-0 font-mono text-[10px] text-muted">archiviata</span>
              </span>
              <span class="text-xs break-words text-muted">{{ item.ask }}</span>
            </button>
          </li>
        </ul>
        <p v-if="hidden > 0" class="text-xs text-muted">{{ hiddenText(hidden) }}</p>
      </div>
    </section>
  </div>
</template>

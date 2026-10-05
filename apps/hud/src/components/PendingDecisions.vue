<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { errorText } from '../lib/italian.ts';
import { FOCUS_EVENT, requestFocus } from '../lib/chat-focus.ts';
import { dismissStep, pendingItems, pendingTotal, type PendingItem } from '../lib/pending.ts';
import { dismissWaitingTask, loadPending, type PendingData } from '../lib/pending-api.ts';
import {
  hiddenText,
  PENDING_DISMISS,
  PENDING_DISMISS_ARMED,
  PENDING_DISMISS_CONFIRM,
  PENDING_DISMISS_CONFIRM_HINT,
  PENDING_DISMISS_HINT,
  PENDING_DISMISSED,
  pendingDismissLabel,
  PENDING_EMPTY,
  PENDING_TITLE,
  waitingSinceText,
} from '../lib/pending-text.ts';
import Icon from './Icon.vue';

/**
 * "Decisioni in attesa" (D-091): every pending approval and every task
 * waiting for the user (a question of Arianna, a task that stopped), oldest
 * first, with its kind, conversation, a short line of what it asks and how
 * long it has waited. A click opens the conversation and brings the card or
 * the message into view, where it is decided or answered. "Chiudi" closes a
 * row's task (D-109); with an approval waiting it asks "Sicuro?" first. Read
 * again when the status or the approvals change, and every 10 s while open.
 */
const props = defineProps<{ signal: unknown }>();
const emit = defineEmits<{ close: []; open: [conversationId: string] }>();

const REFRESH_MS = 10_000;
/** How long "Sicuro?" stays armed. */
const ARM_MS = 5_000;

const data = ref<PendingData | null>(null);
const problem = ref<string | null>(null);
const now = ref(new Date());
const dialog = ref<HTMLElement | null>(null);
const title = ref<HTMLElement | null>(null);
let timer: number | undefined;
let opener: Element | null = null;
/** The row whose "Chiudi" asks "Sicuro?", and the row being closed. */
const armed = ref<string | null>(null);
const closing = ref<string | null>(null);
/** Why the last "Chiudi" failed: kept apart from `problem`, which the next read clears. */
const dismissProblem = ref<string | null>(null);
/** What the screen reader hears: "Sicuro?" armed, or the row closed. */
const announcement = ref('');
let disarm: number | undefined;

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

async function dismiss(item: PendingItem): Promise<void> {
  if (closing.value !== null || item.taskId === null) return;
  const step = dismissStep(item.dismiss, armed.value === item.key);
  window.clearTimeout(disarm);
  if (step === 'ignore') return;
  if (step === 'arm') {
    armed.value = item.key;
    announcement.value = PENDING_DISMISS_ARMED;
    disarm = window.setTimeout(() => (armed.value = null), ARM_MS);
    return;
  }
  armed.value = null;
  closing.value = item.key;
  dismissProblem.value = null;
  // Where the focus goes once the row is gone: the next row, or the window's title.
  const index = items.value.findIndex((row) => row.key === item.key);
  const next = items.value[index + 1]?.key ?? null;
  let closed = false;
  try {
    await dismissWaitingTask(item.taskId);
    closed = true;
    announcement.value = PENDING_DISMISSED;
  } catch (cause) {
    dismissProblem.value = errorText(cause);
  } finally {
    closing.value = null;
  }
  await refresh();
  if (!closed) return;
  await nextTick();
  const row = next === null ? null : dialog.value?.querySelector<HTMLElement>(`[data-row="${next}"]`);
  const target = row?.querySelector<HTMLElement>('button:not([disabled])') ?? title.value;
  target?.focus();
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
  window.clearTimeout(disarm);
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
        <h2 id="pending-title" ref="title" tabindex="-1" class="min-w-0 flex-1 truncate font-medium outline-none">{{ PENDING_TITLE }}</h2>
        <small v-if="total > 0" class="font-mono text-[10.5px] text-muted">{{ total }}</small>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi la finestra" title="Chiudi la finestra" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-[15px] py-3 text-[13.5px]">
        <p v-if="problem !== null" class="text-warn">{{ problem }}</p>
        <p v-if="dismissProblem !== null" class="text-warn" role="alert">{{ dismissProblem }}</p>
        <p class="sr-only" aria-live="polite">{{ announcement }}</p>
        <p v-if="data === null && problem === null" class="text-muted">Lettura in corso…</p>
        <p v-else-if="data !== null && total === 0" class="py-6 text-center text-muted">{{ PENDING_EMPTY }}</p>
        <ul v-if="items.length > 0" class="flex flex-col gap-2">
          <li v-for="item in items" :key="item.key" :data-row="item.key" class="flex items-stretch gap-1.5">
            <button
              type="button"
              class="flex min-w-0 flex-1 flex-col gap-1 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-left enabled:hover:border-accent disabled:cursor-default"
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
            <button
              v-if="item.dismiss !== 'none'"
              type="button"
              class="shrink-0 rounded-[10px] border px-2.5 text-xs disabled:opacity-50"
              :class="armed === item.key ? 'border-warn text-warn' : 'border-line text-muted hover:border-accent hover:text-ink'"
              :disabled="closing !== null"
              :aria-describedby="`dismiss-hint-${item.key}`"
              :aria-label="pendingDismissLabel(item.conversationTitle, armed === item.key)"
              @click="dismiss(item)"
            >{{ closing === item.key ? '…' : armed === item.key ? PENDING_DISMISS_CONFIRM : PENDING_DISMISS }}</button>
            <span v-if="item.dismiss !== 'none'" :id="`dismiss-hint-${item.key}`" class="sr-only">{{
              item.dismiss === 'confirm' ? PENDING_DISMISS_CONFIRM_HINT : PENDING_DISMISS_HINT
            }}</span>
          </li>
        </ul>
        <p v-if="hidden > 0" class="text-xs text-muted">{{ hiddenText(hidden) }}</p>
      </div>
    </section>
  </div>
</template>

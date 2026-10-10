<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { loadCards, markCommitmentDone, moveCard } from '../lib/api.ts';
import { type Card, CARDWALL_PATH, cardErrorText, type CardWall, PRIORITY_CLASS, priorityText } from '../lib/cardwall.ts';
import { loadFolded, type MiniColumnId, miniDropDone, miniWall, miniWhen, saveFolded } from '../lib/secretary-wall.ts';
import CardDetail from './CardDetail.vue';
import Icon from './Icon.vue';

/**
 * The mini cardwall above the secretary's conversation (I-12, D-156): the
 * open commitments and the user's cards with a day, by day (In ritardo, Oggi,
 * Domani, Prossimi giorni), then "Fatti oggi". A click opens the same detail
 * as the cardwall (a commitment: "Fatto"; rinvii and motivi stay in the chat);
 * a drop on "Fatti oggi" marks it done. Read from `GET /api/cards` and again
 * (debounced) whenever the live feed says a card or a commitment changed
 * (`version`). Folded or open is remembered in this browser.
 */
const props = defineProps<{ version: number }>();
const emit = defineEmits<{ cardwall: [] }>();

const storage = (() => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
})();
const folded = ref(loadFolded(storage));
watch(folded, (value) => saveFolded(storage, value));

const wall = ref<CardWall | null>(null);
const loadProblem = ref<string | null>(null);
const problem = ref<string | null>(null);
const selectedId = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    wall.value = await loadCards();
    loadProblem.value = null;
  } catch (cause) {
    loadProblem.value = `Non riesco a leggere gli impegni: ${cardErrorText(cause)}`;
  }
}

let timer: number | undefined;
watch(
  () => props.version,
  () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 300);
  },
);
onMounted(refresh);
onBeforeUnmount(() => window.clearTimeout(timer));

const today = computed(() => wall.value?.today ?? '');
const mini = computed(() => miniWall(wall.value?.cards ?? [], today.value));
const late = computed(() => mini.value.columns.find((column) => column.id === 'late')?.items.length ?? 0);
const selected = computed(() => wall.value?.cards.find((card) => card.id === selectedId.value));
watch(selected, (card) => {
  if (card === undefined && wall.value !== null) selectedId.value = null;
});

// Drag and drop (HTML5): only onto "Fatti oggi". The detail has "Fatto" too, for touch screens.
const dragging = ref<Card | null>(null);
const overDone = ref(false);

function onDragStart(event: DragEvent, card: Card): void {
  dragging.value = card;
  event.dataTransfer?.setData('text/plain', card.id);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(): void {
  dragging.value = null;
  overDone.value = false;
}

function onDragOver(event: DragEvent): void {
  if (dragging.value === null) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  overDone.value = true;
}

function onDragLeave(event: DragEvent): void {
  const into = event.relatedTarget;
  if (!(into instanceof Node && (event.currentTarget as HTMLElement).contains(into))) overDone.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  const card = dragging.value;
  onDragEnd();
  if (card === null) return;
  const action = miniDropDone(card);
  if (action.kind === 'noop') return;
  if (action.kind === 'refuse') {
    problem.value = action.message;
    return;
  }
  problem.value = null;
  try {
    if (action.kind === 'commitment-done') await markCommitmentDone(card.id);
    else await moveCard(card.id, action.to);
  } catch (cause) {
    problem.value = cardErrorText(cause);
  }
  await refresh();
}

function openCardwall(event: MouseEvent): void {
  // A click with a modifier opens a new tab, as any link.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  emit('cardwall');
}

function emptyText(id: MiniColumnId): string {
  return id === 'late' ? 'Niente in ritardo' : 'Niente';
}
</script>

<template>
  <section class="mx-4 mt-3 flex max-h-[36vh] min-h-0 shrink-0 flex-col rounded-[12px] border border-line bg-surface md:mx-5.5 short:mt-2 short:max-h-[30vh]" aria-label="Impegni della segretaria">
    <header class="flex items-center gap-2 px-3.5 py-2 short:py-1.5" :class="{ 'border-b border-line': !folded }">
      <button type="button" class="flex flex-1 items-center gap-2 text-left" :aria-expanded="!folded" :aria-label="folded ? 'Mostra gli impegni' : 'Nascondi gli impegni'" @click="folded = !folded">
        <span class="inline-grid text-muted transition-transform" :class="{ 'rotate-90': !folded }"><Icon name="expand" :size="14" /></span>
        <Icon name="calendar" :size="15" />
        <h2 class="hud-title">Impegni ({{ mini.open }})</h2>
        <span v-if="late > 0" class="chip text-warn">{{ late === 1 ? '1 in ritardo' : `${String(late)} in ritardo` }}</span>
      </button>
      <a :href="CARDWALL_PATH" class="flex shrink-0 items-center gap-1 text-[12px] text-muted hover:text-ink" @click="openCardwall">Apri il cardwall →</a>
    </header>

    <div v-if="!folded" class="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 py-2 md:overflow-hidden short:py-1.5">
      <p v-if="problem !== null" role="alert" class="flex items-start gap-2 text-xs text-warn">
        <span class="flex-1">{{ problem }}</span>
        <button type="button" class="shrink-0 text-muted hover:text-ink" aria-label="Chiudi l’avviso" @click="problem = null"><Icon name="close" :size="12" /></button>
      </p>
      <p v-if="loadProblem !== null" role="alert" class="text-xs text-warn">{{ loadProblem }}</p>
      <p v-else-if="wall !== null && mini.open === 0 && mini.doneToday.length === 0" class="text-[13px] text-muted">
        Nessun impegno aperto. Scrivi qui sotto, per esempio «giovedì alle 15 devo andare in banca».
      </p>

      <!-- Four columns side by side from md, each scrolling inside; on a phone a list by day (empty days left out). -->
      <div v-if="wall !== null && mini.open > 0" class="flex flex-col gap-2 md:grid md:min-h-0 md:flex-1 md:grid-cols-4">
        <section
          v-for="column in mini.columns"
          :key="column.id"
          class="min-h-0 flex-col rounded-lg border border-line bg-surface-2/40"
          :class="column.items.length === 0 ? 'hidden md:flex' : 'flex'"
          :aria-label="column.title"
        >
          <header class="flex items-center gap-2 px-2.5 pt-1.5 pb-1">
            <h3 class="flex-1 text-[11px] font-semibold tracking-[0.04em] uppercase" :class="column.id === 'late' && column.items.length > 0 ? 'text-warn' : 'text-muted'">{{ column.title }}</h3>
            <span class="font-mono text-[10.5px] text-muted">{{ column.items.length }}</span>
          </header>
          <ul class="flex min-h-0 flex-col gap-1 px-1.5 pb-1.5 md:flex-1 md:overflow-y-auto">
            <li v-if="column.items.length === 0" class="px-1 py-1 text-[11.5px] text-muted">{{ emptyText(column.id) }}</li>
            <li
              v-for="card in column.items"
              :key="`${card.kind}:${card.id}`"
              draggable="true"
              class="rounded-md border border-line bg-surface hover:border-line-strong"
              :class="{ 'opacity-50': dragging?.id === card.id }"
              @dragstart="onDragStart($event, card)"
              @dragend="onDragEnd"
            >
              <button type="button" class="flex w-full flex-col gap-1 px-2 py-1.5 text-left" :aria-label="`Apri: ${card.title}`" @click="selectedId = card.id">
                <span class="text-[12.5px] leading-snug break-words">{{ card.title }}</span>
                <span class="flex flex-wrap items-center gap-1 text-[10.5px]">
                  <span v-if="card.kind === 'task'" class="chip inline-flex items-center gap-1 text-info" title="Card del cardwall"><Icon name="cardwall" :size="10" />Card</span>
                  <span v-if="miniWhen(card, column.id, today) !== undefined" class="chip" :class="column.id === 'late' ? 'text-warn' : 'text-muted'">{{ miniWhen(card, column.id, today) }}</span>
                  <span v-if="priorityText(card.priority) !== undefined" class="chip" :class="PRIORITY_CLASS[card.priority]">{{ priorityText(card.priority) }}</span>
                </span>
              </button>
            </li>
            <li v-if="column.id === 'next' && mini.later > 0" class="px-1 py-0.5 text-[11.5px] text-muted">+{{ mini.later }} più avanti</li>
          </ul>
        </section>
      </div>

      <!-- "Fatti oggi": the closed ones of today; a drop here marks an item done. -->
      <div
        v-if="wall !== null && (mini.open > 0 || mini.doneToday.length > 0)"
        class="flex shrink-0 items-center gap-2 overflow-hidden rounded-lg border border-dashed px-2.5 py-1 text-[12px] transition-colors"
        :class="overDone ? 'border-accent bg-accent/5' : 'border-line'"
        aria-label="Fatti oggi"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <span class="shrink-0 font-semibold text-muted">Fatti oggi</span>
        <span v-if="mini.doneToday.length === 0" class="truncate text-muted">{{ dragging !== null ? 'Lascia qui per segnarlo fatto' : 'ancora niente' }}</span>
        <ul v-else class="flex min-w-0 flex-1 gap-3 overflow-x-auto whitespace-nowrap">
          <li v-for="card in mini.doneToday" :key="`${card.kind}:${card.id}`">
            <button type="button" class="inline-flex items-center gap-1 text-muted hover:text-ink" :aria-label="`Apri: ${card.title}`" @click="selectedId = card.id">
              <span class="text-ok" aria-hidden="true">✓</span>{{ card.title }}
            </button>
          </li>
        </ul>
      </div>
    </div>

    <CardDetail
      v-if="selected !== undefined && wall !== null"
      :key="selected.id"
      :card="selected"
      :cards="wall.cards"
      :projects="wall.projects"
      :agents="wall.agents"
      :today="today"
      :version="version"
      :split-inbox="false"
      @close="selectedId = null"
      @changed="refresh"
    />
  </section>
</template>

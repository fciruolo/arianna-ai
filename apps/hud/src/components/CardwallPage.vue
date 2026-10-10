<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { createCard, loadCards, markCommitmentDone, moveCard } from '../lib/api.ts';
import {
  assigneeText,
  blockedText,
  type Card,
  cardErrorText,
  cardMarks,
  type CardWall,
  dropAction,
  dueText,
  filtersActive,
  groupCards,
  loadState,
  matches,
  plannedText,
  PRIORITY_CLASS,
  PRIORITY_TEXT,
  priorityText,
  saveState,
  type SortKey,
  sortCards,
  startsDescending,
  stateText,
  type WallColumn,
  type WallColumnId,
  wallColumns,
  type WallState,
  ALL_FILTERS,
} from '../lib/cardwall.ts';
import { agentName } from '../lib/italian.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import CardDetail from './CardDetail.vue';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * The cardwall (I-13 tappa C2, D-152): the cards and the commitments of the
 * secretary in columns ("Bacheca") or in a table ("Lista"). Five columns by
 * default (Da fare, In corso, Aspetta, Da verificare, Fatto); "Inbox a parte"
 * and "Falliti a parte" split two of them, any column can be hidden; the
 * filters and the order on top. A drag moves a card, the detail offers the
 * same moves as buttons. Read again (debounced) whenever the live feed says a
 * card or a commitment changed (`version`).
 */
const props = defineProps<{ version: number }>();

const storage = (() => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
})();
const state = ref<WallState>(loadState(storage));
watch(state, (value) => saveState(storage, value), { deep: true });

const wall = ref<CardWall | null>(null);
const loadProblem = ref<string | null>(null);
const problem = ref<string | null>(null);
const selectedId = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    wall.value = await loadCards();
    loadProblem.value = null;
  } catch (cause) {
    loadProblem.value = `Non riesco a leggere le card: ${cardErrorText(cause)}`;
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
const allColumns = computed(() => wallColumns(state.value.prefs));
const columns = computed(() => allColumns.value.filter((column) => !state.value.prefs.hidden.includes(column.id)));
const visibleCards = computed(() => (wall.value?.cards ?? []).filter((card) => matches(card, state.value.filters, today.value)));
const groups = computed(() => groupCards(visibleCards.value, columns.value, state.value.sort));
const rows = computed(() => sortCards(visibleCards.value, state.value.sort));
const selected = computed(() => wall.value?.cards.find((card) => card.id === selectedId.value));
watch(selected, (card) => {
  if (card === undefined && wall.value !== null) selectedId.value = null;
});

/** Projects and agents of the filters: those of the core, and those still named by a card. */
const projectNames = computed(() => {
  const names = new Set(wall.value?.projects ?? []);
  for (const card of wall.value?.cards ?? []) if (card.project !== null) names.add(card.project);
  return [...names].sort();
});
const agentNames = computed(() => {
  const names = new Set(wall.value?.agents ?? []);
  for (const card of wall.value?.cards ?? []) if (card.assignee !== 'user') names.add(card.assignee);
  return [...names].sort();
});

function toggleHidden(id: WallColumnId): void {
  const hidden = state.value.prefs.hidden;
  state.value.prefs.hidden = hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id];
}

function resetFilters(): void {
  state.value.filters = { ...ALL_FILTERS };
}

// The order: the menu (four keys) and the headers of the list (any key; a second click turns it round).
const SORT_MENU: { value: SortKey; text: string }[] = [
  { value: 'due', text: 'Scadenza' },
  { value: 'priority', text: 'Priorità' },
  { value: 'planned', text: 'Data esecuzione' },
  { value: 'recent', text: 'Più recenti' },
];
const sortMenuValue = computed(() => (SORT_MENU.some((item) => item.value === state.value.sort.key) ? state.value.sort.key : ''));

function chooseSort(event: Event): void {
  const key = (event.target as HTMLSelectElement).value as SortKey;
  state.value.sort = { key, desc: startsDescending(key) };
}

function sortBy(key: SortKey): void {
  const sort = state.value.sort;
  state.value.sort = sort.key === key ? { key, desc: !sort.desc } : { key, desc: startsDescending(key) };
}

function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
  if (state.value.sort.key !== key) return 'none';
  return state.value.sort.desc ? 'descending' : 'ascending';
}

const TABLE_HEADERS: { key: SortKey; text: string; class: string }[] = [
  { key: 'title', text: 'Card', class: 'min-w-[240px]' },
  { key: 'project', text: 'Progetto', class: '' },
  { key: 'priority', text: 'Priorità', class: '' },
  { key: 'status', text: 'Stato', class: '' },
  { key: 'assignee', text: 'Chi la fa', class: '' },
  { key: 'planned', text: 'Data esecuzione', class: '' },
  { key: 'due', text: 'Scadenza', class: '' },
  { key: 'files', text: 'Allegati', class: 'text-right' },
];

// A new card: title, project, who does it, priority, due day. The project of the filter comes in already chosen.
const adding = ref(false);
const draft = ref({ title: '', project: '', assignee: 'user', priority: 0, due: '' });
const titleInput = ref<HTMLInputElement | null>(null);
const saving = ref(false);

function openNew(): void {
  const project = state.value.filters.project;
  draft.value = { title: '', project: project.startsWith('p:') ? project.slice(2) : '', assignee: 'user', priority: 0, due: '' };
  adding.value = true;
  void nextTick(() => titleInput.value?.focus());
}

/** Adds the card, then opens its detail to write the description and the rest. */
async function saveNew(): Promise<void> {
  const title = draft.value.title.trim();
  if (title === '' || saving.value) return;
  saving.value = true;
  problem.value = null;
  try {
    const { project, assignee, priority, due } = draft.value;
    const id = await createCard({ title, ...(project === '' ? {} : { project }), assignee, ...(priority === 0 ? {} : { priority }), ...(due === '' ? {} : { due }) });
    adding.value = false;
    await refresh();
    selectedId.value = id;
  } catch (cause) {
    problem.value = cardErrorText(cause);
  } finally {
    saving.value = false;
  }
}

// Drag and drop (HTML5, no library). The detail offers the same moves as buttons.
const dragging = ref<Card | null>(null);
const over = ref<WallColumnId | null>(null);

function onDragStart(event: DragEvent, card: Card): void {
  dragging.value = card;
  event.dataTransfer?.setData('text/plain', card.id);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(): void {
  dragging.value = null;
  over.value = null;
}

function onDragOver(event: DragEvent, column: WallColumn): void {
  if (dragging.value === null || column.drop === null) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  over.value = column.id;
}

function onDragLeave(event: DragEvent, column: WallColumn): void {
  const into = event.relatedTarget;
  if (over.value === column.id && !(into instanceof Node && (event.currentTarget as HTMLElement).contains(into))) over.value = null;
}

async function onDrop(event: DragEvent, column: WallColumn): Promise<void> {
  event.preventDefault();
  const card = dragging.value;
  onDragEnd();
  if (card === null) return;
  const action = dropAction(card, column);
  if (action.kind === 'none' || action.kind === 'noop') return;
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

function cardClass(card: Card): string {
  return card.column === 'failed' ? 'border-l-[3px] border-l-danger' : '';
}

const DUE_FILTERS = [
  { value: 'all', text: 'Tutte' },
  { value: 'today', text: 'Oggi' },
  { value: 'week', text: 'Questa settimana' },
  { value: 'late', text: 'In ritardo' },
  { value: 'none', text: 'Senza scadenza' },
] as const;
const LABEL_FILTERS = (['L0', 'L1', 'L2', 'L3'] as const).map((label) => ({ value: label, text: `${label} · ${LABEL_TEXT[label]}` }));
const PRIORITY_FILTERS = [
  { value: '4', text: 'Altissima' },
  { value: '3', text: 'Alta' },
  { value: '2', text: 'Media' },
  { value: '1', text: 'Bassa' },
  { value: '0', text: 'Senza priorità' },
] as const;
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 md:overflow-hidden md:px-6" aria-label="Cardwall">
    <!-- Toolbar: new card, view, filters, order, columns. -->
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary px-3 py-1.5 text-[13px]" :aria-expanded="adding" @click="adding ? (adding = false) : openNew()"><Icon name="new" :size="14" />Card</button>
      <div class="flex overflow-hidden rounded-lg border border-line-strong" role="group" aria-label="Vista">
        <button type="button" class="flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]" :class="state.view === 'board' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="state.view === 'board'" @click="state.view = 'board'">
          <Icon name="cardwall" :size="14" />Bacheca
        </button>
        <button type="button" class="flex items-center gap-1.5 border-l border-line-strong px-2.5 py-1 text-[12.5px]" :class="state.view === 'list' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="state.view === 'list'" @click="state.view = 'list'">
          <Icon name="view-list" :size="14" />Lista
        </button>
      </div>
      <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtri">
        <select v-model="state.filters.project" class="field px-2 py-1 text-[12.5px]" aria-label="Progetto">
          <option value="all">Tutti i progetti</option>
          <option value="general">Generali</option>
          <option v-for="name in projectNames" :key="name" :value="`p:${name}`">{{ name }}</option>
        </select>
        <select v-model="state.filters.kind" class="field px-2 py-1 text-[12.5px]" aria-label="Tipo">
          <option value="all">Card e impegni</option>
          <option value="task">Card</option>
          <option value="commitment">Impegni</option>
        </select>
        <select v-model="state.filters.assignee" class="field px-2 py-1 text-[12.5px]" aria-label="Chi la fa">
          <option value="all">Chiunque</option>
          <option value="user">Tu</option>
          <option v-for="agent in agentNames" :key="agent" :value="`a:${agent}`">{{ agentName(agent) }}</option>
        </select>
        <select v-model="state.filters.priority" class="field px-2 py-1 text-[12.5px]" aria-label="Priorità">
          <option value="all">Ogni priorità</option>
          <option v-for="item in PRIORITY_FILTERS" :key="item.value" :value="item.value">{{ item.text }}</option>
        </select>
        <select v-model="state.filters.due" class="field px-2 py-1 text-[12.5px]" aria-label="Scadenza">
          <option v-for="item in DUE_FILTERS" :key="item.value" :value="item.value">{{ item.value === 'all' ? 'Ogni scadenza' : item.text }}</option>
        </select>
        <select v-model="state.filters.label" class="field px-2 py-1 text-[12.5px]" aria-label="Etichetta">
          <option value="all">Ogni etichetta</option>
          <option v-for="item in LABEL_FILTERS" :key="item.value" :value="item.value">{{ item.text }}</option>
        </select>
        <button v-if="filtersActive(state.filters)" type="button" class="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-ink" @click="resetFilters">Togli i filtri</button>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <label class="flex items-center gap-1.5 text-[12.5px] text-muted">
          <Icon name="sort" :size="14" />
          <select class="field px-2 py-1 text-[12.5px] text-ink" :value="sortMenuValue" aria-label="Ordina per" @change="chooseSort">
            <option v-if="sortMenuValue === ''" value="" disabled>Ordine della lista</option>
            <option v-for="item in SORT_MENU" :key="item.value" :value="item.value">{{ item.text }}</option>
          </select>
        </label>
        <details v-if="state.view === 'board'" class="relative">
          <summary class="btn cursor-pointer list-none px-3 py-1.5 text-[13px] [&::-webkit-details-marker]:hidden"><Icon name="cardwall" :size="14" />Colonne</summary>
          <div class="absolute top-full right-0 z-20 mt-1.5 flex w-[240px] flex-col gap-1 rounded-xl border border-line-strong bg-surface p-3 text-[13px] shadow-[0_14px_40px_#0006]">
            <label class="flex items-center gap-2"><input v-model="state.prefs.splitInbox" type="checkbox" class="accent-[var(--accent)]" />Inbox a parte</label>
            <label class="flex items-center gap-2"><input v-model="state.prefs.splitFailed" type="checkbox" class="accent-[var(--accent)]" />Falliti a parte</label>
            <p class="hud-title mt-2 mb-1">Mostra</p>
            <label v-for="column in allColumns" :key="column.id" class="flex items-center gap-2">
              <input type="checkbox" class="accent-[var(--accent)]" :checked="!state.prefs.hidden.includes(column.id)" @change="toggleHidden(column.id)" />{{ column.title }}
            </label>
          </div>
        </details>
      </div>
    </div>

    <p v-if="problem !== null" role="alert" class="flex items-start gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-[13px] text-danger">
      <span class="flex-1">{{ problem }}</span>
      <button type="button" class="shrink-0 text-muted hover:text-ink" aria-label="Chiudi l’avviso" @click="problem = null"><Icon name="close" :size="14" /></button>
    </p>

    <!-- New card: the short form; the detail opens right after for the rest. -->
    <form v-if="adding" class="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3" @submit.prevent="saveNew" @keydown.esc="adding = false">
      <label class="flex min-w-[220px] flex-[2] flex-col gap-1 text-[12px] text-muted"
        >Titolo<input ref="titleInput" v-model="draft.title" maxlength="200" class="field px-2.5 py-1.5 text-[13.5px] text-ink" placeholder="Che cosa c’è da fare" required
      /></label>
      <label class="flex flex-1 flex-col gap-1 text-[12px] text-muted"
        >Progetto<select v-model="draft.project" class="field px-2 py-1.5 text-[13px] text-ink">
          <option value="">Generale</option>
          <option v-for="name in wall?.projects ?? []" :key="name" :value="name">{{ name }}</option>
        </select></label
      >
      <label class="flex flex-1 flex-col gap-1 text-[12px] text-muted"
        >Chi la fa<select v-model="draft.assignee" class="field px-2 py-1.5 text-[13px] text-ink">
          <option value="user">Tu</option>
          <option v-for="agent in wall?.agents ?? []" :key="agent" :value="agent">{{ agentName(agent) }}</option>
        </select></label
      >
      <label class="flex flex-1 flex-col gap-1 text-[12px] text-muted"
        >Priorità<select v-model.number="draft.priority" class="field px-2 py-1.5 text-[13px] text-ink">
          <option v-for="(name, value) in PRIORITY_TEXT" :key="value" :value="value">{{ name }}</option>
        </select></label
      >
      <label class="flex flex-1 flex-col gap-1 text-[12px] text-muted">Scadenza<input v-model="draft.due" type="date" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
      <div class="flex gap-1.5">
        <button type="submit" class="btn btn-primary px-3 py-1.5 text-[13px]" :disabled="saving || draft.title.trim() === ''">Aggiungi</button>
        <button type="button" class="btn px-3 py-1.5 text-[13px]" @click="adding = false">Annulla</button>
      </div>
    </form>

    <p v-if="loadProblem !== null" role="alert" class="text-sm text-danger">{{ loadProblem }}</p>
    <p v-else-if="wall === null" class="text-sm text-muted">Carico le card…</p>
    <p v-else-if="state.view === 'board' && columns.length === 0" class="text-sm text-muted">Tutte le colonne sono nascoste: rimettile da «Colonne».</p>

    <!-- Board: side by side from md, scrolling sideways inside the page; one under the other on a phone. -->
    <div v-if="wall !== null && state.view === 'board' && columns.length > 0" class="flex flex-col gap-3 md:min-h-0 md:flex-1 md:flex-row md:overflow-x-auto md:pb-1">
      <section
        v-for="column in columns"
        :key="column.id"
        class="flex flex-col rounded-xl border bg-surface transition-colors md:min-h-0 md:w-[272px] md:shrink-0"
        :class="over === column.id ? 'border-accent bg-accent/5' : 'border-line'"
        :aria-label="column.title"
        @dragover="onDragOver($event, column)"
        @dragleave="onDragLeave($event, column)"
        @drop="onDrop($event, column)"
      >
        <header class="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 class="hud-title flex-1" :class="{ 'text-danger': column.id === 'failed' }">{{ column.title }}</h2>
          <span class="font-mono text-[11px] text-muted">{{ groups.get(column.id)?.length ?? 0 }}</span>
        </header>
        <ul class="flex min-h-[64px] flex-col gap-2 p-2 md:min-h-0 md:flex-1 md:overflow-y-auto">
          <li v-if="(groups.get(column.id)?.length ?? 0) === 0" class="px-1.5 py-3 text-center text-[12px] text-muted">
            {{ column.drop === null ? 'Nessuna card' : 'Nessuna card: trascinane una qui' }}
          </li>
          <li
            v-for="card in groups.get(column.id) ?? []"
            :key="`${card.kind}:${card.id}`"
            draggable="true"
            class="rounded-lg border border-line bg-surface-2 hover:border-line-strong"
            :class="[cardClass(card), { 'opacity-50': dragging?.id === card.id }]"
            @dragstart="onDragStart($event, card)"
            @dragend="onDragEnd"
          >
            <button type="button" class="flex w-full flex-col gap-1.5 px-2.5 py-2 text-left" :aria-label="`Apri: ${card.title}`" @click="selectedId = card.id">
              <span class="flex items-start gap-2">
                <span class="min-w-0 flex-1 text-[13.5px] leading-snug break-words" :class="{ 'text-muted line-through': card.kind === 'commitment' && card.status !== 'open' }">{{ card.title }}</span>
                <LabelBadge :label="card.label" dot />
              </span>
              <span class="flex flex-wrap items-center gap-1 text-[11px]">
                <span v-if="priorityText(card.priority) !== undefined" class="chip inline-flex items-center gap-1" :class="PRIORITY_CLASS[card.priority]"><Icon name="priority" :size="11" />{{ priorityText(card.priority) }}</span>
                <span v-if="card.kind === 'commitment'" class="chip text-accent">Impegno</span>
                <span v-if="card.column === 'failed'" class="chip text-danger">Fallito</span>
                <span class="chip text-muted">{{ card.project ?? 'Generale' }}</span>
                <span class="chip text-muted">{{ assigneeText(card.assignee, agentName) }}</span>
                <span v-if="plannedText(card, today) !== undefined" class="chip inline-flex items-center gap-1 text-muted" title="Data esecuzione"><Icon name="calendar" :size="11" />{{ plannedText(card, today) }}</span>
                <span v-if="dueText(card, today) !== undefined" class="chip" :class="card.late ? 'text-danger' : 'text-muted'" title="Scadenza">{{ dueText(card, today) }}</span>
              </span>
              <span v-if="cardMarks(card).length > 0" class="flex flex-wrap items-center gap-2.5 text-[11.5px] text-muted">
                <span v-for="mark in cardMarks(card)" :key="mark.icon" class="inline-flex items-center gap-1" :title="mark.title"><Icon :name="mark.icon" :size="12" />{{ mark.text }}<span class="sr-only">{{ mark.title }}</span></span>
              </span>
              <span v-if="blockedText(card) !== undefined" class="truncate text-[12px] text-warn" :title="card.blockedBy.map((item) => item.title).join(', ')">{{ blockedText(card) }}</span>
              <span v-if="card.waitingReason !== null" class="truncate text-[12px] text-muted" :title="card.waitingReason">{{ card.waitingReason }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <!-- List: a table, sideways scroll inside its box on a narrow screen. -->
    <div v-if="wall !== null && state.view === 'list'" class="min-h-0 overflow-auto rounded-xl border border-line bg-surface md:flex-1">
      <table class="w-full min-w-[860px] border-collapse text-left text-[13px]">
        <thead class="sticky top-0 z-10 bg-surface">
          <tr class="border-b border-line">
            <th v-for="header in TABLE_HEADERS" :key="header.key" scope="col" class="px-3 py-2 font-normal" :class="header.class" :aria-sort="ariaSort(header.key)">
              <button type="button" class="hud-title inline-flex items-center gap-1 hover:text-ink" :class="{ 'text-ink': state.sort.key === header.key }" @click="sortBy(header.key)">
                {{ header.text }}
                <Icon v-if="state.sort.key === header.key" :name="state.sort.desc ? 'sort-down' : 'sort-up'" :size="12" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td :colspan="TABLE_HEADERS.length" class="px-3 py-6 text-center text-muted">Nessuna card</td>
          </tr>
          <tr
            v-for="card in rows"
            :key="`${card.kind}:${card.id}`"
            class="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-2"
            @click="selectedId = card.id"
          >
            <td class="px-3 py-2">
              <button type="button" class="flex w-full items-center gap-2 text-left" :aria-label="`Apri: ${card.title}`" @click.stop="selectedId = card.id">
                <LabelBadge :label="card.label" dot />
                <span class="min-w-0 flex-1 break-words" :class="{ 'text-muted line-through': card.kind === 'commitment' && card.status !== 'open' }">{{ card.title }}</span>
                <span v-if="card.kind === 'commitment'" class="chip shrink-0 text-accent">Impegno</span>
              </button>
            </td>
            <td class="px-3 py-2 whitespace-nowrap text-muted">{{ card.project ?? 'Generale' }}</td>
            <td class="px-3 py-2 whitespace-nowrap">
              <span v-if="priorityText(card.priority) !== undefined" class="chip inline-flex items-center gap-1" :class="PRIORITY_CLASS[card.priority]"><Icon name="priority" :size="11" />{{ priorityText(card.priority) }}</span>
            </td>
            <td class="px-3 py-2 whitespace-nowrap" :class="card.column === 'failed' ? 'text-danger' : ''">{{ stateText(card) }}</td>
            <td class="px-3 py-2 whitespace-nowrap">{{ assigneeText(card.assignee, agentName) }}</td>
            <td class="px-3 py-2 whitespace-nowrap text-muted">{{ plannedText(card, today) ?? '' }}</td>
            <td class="px-3 py-2 whitespace-nowrap" :class="card.late ? 'text-danger' : 'text-muted'">{{ dueText(card, today) ?? '' }}</td>
            <td class="px-3 py-2 text-right font-mono text-[12px] text-muted">{{ card.files > 0 ? card.files : '' }}</td>
          </tr>
        </tbody>
      </table>
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
      :split-inbox="state.prefs.splitInbox"
      @close="selectedId = null"
      @changed="refresh"
    />
  </section>
</template>

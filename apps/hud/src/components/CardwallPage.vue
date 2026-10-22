<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { cardAction, createCard, loadCards, markCommitmentDone, moveCard } from '../lib/api.ts';
import {
  assigneeText,
  blockedText,
  turnText,
  NOT_STOPPED_TEXT,
  type Card,
  cardErrorText,
  cardMarks,
  complexityBadge,
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
import { neighbourColumn, phoneColumn } from '../lib/cardwall-phone.ts';
import { agentName, reasonText } from '../lib/italian.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import type { Approval, ExecutorChoice } from '../lib/types.ts';
import CardDetail from './CardDetail.vue';
import FilterMenu from './FilterMenu.vue';
import ImBoard from './ImBoard.vue';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * The cardwall (I-13 tappa C2, D-152): the cards and the commitments of the
 * secretary in columns ("Bacheca") or in a table ("Lista"). Five columns by
 * default (Da fare, In corso, Aspetta, Da verificare, Fatto); "Inbox a parte"
 * and "Falliti a parte" split two of them, any column can be hidden; the
 * filters and the order on top. A drag moves a card, the detail offers the
 * same moves as buttons; the third view, "IM", is the Iteration Meetings of a
 * project (ImBoard, D-167). Read again (debounced) whenever the live feed says a
 * card or a commitment changed (`version`). The detail of an agent's card
 * shows the decisions it waits for (`approvals`, decided with `decide`, D-159).
 */
const props = defineProps<{
  version: number;
  approvals: Approval[];
  decide: (approval: Approval, state: 'approved' | 'rejected', choice?: ExecutorChoice, plan?: { starts: readonly number[]; revision: number }) => Promise<void>;
}>();

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

/** The order as a menu: the four orders, plus the one a header of the list chose. */
const sortChoice = computed({
  get: () => sortMenuValue.value,
  set: (key: string) => {
    if (key !== '') state.value.sort = { key: key as SortKey, desc: startsDescending(key as SortKey) };
  },
});
const sortOptions = computed(() => (sortMenuValue.value === '' ? [{ value: '', text: 'Ordine della lista' }, ...SORT_MENU] : SORT_MENU));

// The options of the filter chips, in the words of the wall.
const KIND_OPTIONS = [
  { value: 'all', text: 'Card e impegni' },
  { value: 'task', text: 'Card' },
  { value: 'commitment', text: 'Impegni' },
];
const projectOptions = computed(() => [
  { value: 'all', text: 'Tutti i progetti' },
  { value: 'general', text: 'Generali' },
  ...projectNames.value.map((name) => ({ value: `p:${name}`, text: name })),
]);
const assigneeOptions = computed(() => [
  { value: 'all', text: 'Chiunque' },
  { value: 'user', text: 'Tu' },
  ...agentNames.value.map((agent) => ({ value: `a:${agent}`, text: agentName(agent) })),
]);

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

/** The card of an IM item (D-167, P4b), maybe just made: read the wall again, so that the detail finds it. */
async function openCard(id: string): Promise<void> {
  if (wall.value?.cards.some((card) => card.id === id) !== true) await refresh();
  if (wall.value?.cards.some((card) => card.id === id) !== true) {
    problem.value = 'Non trovo la card di questa voce: riprova fra poco.';
    return;
  }
  selectedId.value = id;
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
    else if (action.kind === 'run' || action.kind === 'stop') {
      if ((await cardAction(card.id, action.kind)).left) problem.value = NOT_STOPPED_TEXT;
    }
    else await moveCard(card.id, action.to);
  } catch (cause) {
    problem.value = cardErrorText(cause);
  }
  await refresh();
}

// The phone (D-293): one column at a time, chosen from a row of tabs or with a swipe sideways.
const chosenColumn = ref<WallColumnId | null>(null);
const shownColumn = computed(() => phoneColumn(columns.value, chosenColumn.value, (id) => groups.value.get(id)?.length ?? 0));
const columnTabs = ref<HTMLElement | null>(null);
function showColumn(id: WallColumnId | null): void {
  if (id === null) return;
  chosenColumn.value = id;
  void nextTick(() => columnTabs.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}
let swipeFrom: { x: number; y: number } | null = null;
function onSwipeStart(event: TouchEvent): void {
  const touch = event.touches[0];
  swipeFrom = event.touches.length === 1 && touch !== undefined ? { x: touch.clientX, y: touch.clientY } : null;
}
function onSwipeEnd(event: TouchEvent): void {
  const touch = event.changedTouches[0];
  const from = swipeFrom;
  swipeFrom = null;
  if (from === null || touch === undefined || window.matchMedia('(min-width: 48rem)').matches) return;
  const dx = touch.clientX - from.x;
  if (Math.abs(dx) < 60 || Math.abs(touch.clientY - from.y) > 40) return;
  showColumn(neighbourColumn(columns.value, shownColumn.value, dx < 0 ? 1 : -1));
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
const priorityOptions = [{ value: 'all', text: 'Ogni priorità' }, ...PRIORITY_FILTERS];
const dueOptions = DUE_FILTERS.map((item) => ({ value: item.value, text: item.value === 'all' ? 'Ogni scadenza' : item.text }));
const labelOptions = [{ value: 'all', text: 'Ogni etichetta' }, ...LABEL_FILTERS];
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 md:overflow-hidden md:px-6" aria-label="Cardwall">
    <!-- Toolbar: new card, view, filters, order, columns. -->
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :aria-expanded="adding" @click="adding ? (adding = false) : openNew()"><Icon name="new" :size="14" />Card</button>
      <div class="flex overflow-hidden rounded-lg border border-line-strong" role="group" aria-label="Vista">
        <button type="button" class="flex items-center gap-1.5 px-2.5 py-1 text-[13.5px] touch:min-h-11" :class="state.view === 'board' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="state.view === 'board'" @click="state.view = 'board'">
          <Icon name="cardwall" :size="14" />Bacheca
        </button>
        <button type="button" class="flex items-center gap-1.5 border-l border-line-strong px-2.5 py-1 text-[13.5px] touch:min-h-11" :class="state.view === 'list' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="state.view === 'list'" @click="state.view = 'list'">
          <Icon name="view-list" :size="14" />Lista
        </button>
        <button type="button" class="flex items-center gap-1.5 border-l border-line-strong px-2.5 py-1 text-[13.5px] touch:min-h-11" :class="state.view === 'im' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="state.view === 'im'" @click="state.view = 'im'">
          <Icon name="calendar" :size="14" />IM
        </button>
      </div>
      <div v-if="state.view !== 'im'" class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 max-md:order-last max-md:basis-full" role="group" aria-label="Filtri">
        <FilterMenu v-model="state.filters.project" label="Progetto" icon="project" :options="projectOptions" />
        <FilterMenu v-model="state.filters.kind" label="Tipo" icon="card-body" :options="KIND_OPTIONS" />
        <FilterMenu v-model="state.filters.assignee" label="Chi la fa" icon="coder" :options="assigneeOptions" />
        <FilterMenu v-model="state.filters.priority" label="Priorità" icon="priority" :options="priorityOptions" />
        <FilterMenu v-model="state.filters.due" label="Scadenza" icon="calendar" :options="dueOptions" />
        <FilterMenu v-model="state.filters.label" label="Etichetta" icon="private" :options="labelOptions" />
        <button
          v-if="filtersActive(state.filters)"
          type="button"
          class="grid size-[30px] place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink touch:size-11"
          title="Togli i filtri"
          aria-label="Togli i filtri"
          @click="resetFilters"
        >
          <Icon name="close" :size="14" />
        </button>
      </div>
      <div v-if="state.view !== 'im'" class="ml-auto flex items-center gap-2">
        <FilterMenu v-model="sortChoice" label="Ordina per" icon="sort" :options="sortOptions" plain align-right />
        <FilterMenu v-if="state.view === 'board'" label="Colonne" icon="cardwall" icon-only align-right>
          <div class="flex w-[220px] flex-col gap-1.5 text-[14px]">
            <label class="flex items-center gap-2"><input v-model="state.prefs.splitInbox" type="checkbox" class="accent-[var(--accent)]" />Inbox a parte</label>
            <label class="flex items-center gap-2"><input v-model="state.prefs.splitFailed" type="checkbox" class="accent-[var(--accent)]" />Falliti a parte</label>
            <p class="mt-2 mb-0.5 text-[13px] font-semibold text-muted">Mostra</p>
            <label v-for="column in allColumns" :key="column.id" class="flex items-center gap-2">
              <input type="checkbox" class="accent-[var(--accent)]" :checked="!state.prefs.hidden.includes(column.id)" @change="toggleHidden(column.id)" />{{ column.title }}
            </label>
          </div>
        </FilterMenu>
      </div>
    </div>

    <p v-if="problem !== null" role="alert" class="flex items-start gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-[14px] text-danger">
      <span class="flex-1">{{ problem }}</span>
      <button type="button" class="shrink-0 text-muted hover:text-ink touch:-my-2 touch:grid touch:size-11 touch:place-items-center" aria-label="Chiudi l’avviso" @click="problem = null"><Icon name="close" :size="14" /></button>
    </p>

    <!-- New card: the short form; the detail opens right after for the rest. -->
    <form v-if="adding" class="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3" @submit.prevent="saveNew" @keydown.esc.prevent="adding = false">
      <label class="flex min-w-[220px] flex-[2] flex-col gap-1 text-[13px] text-muted"
        >Titolo<input ref="titleInput" v-model="draft.title" maxlength="200" class="field px-2.5 py-1.5 text-[14.5px] text-ink" placeholder="Che cosa c’è da fare" required
      /></label>
      <label class="flex flex-1 flex-col gap-1 text-[13px] text-muted"
        >Progetto<select v-model="draft.project" class="field px-2 py-1.5 text-[14px] text-ink">
          <option value="">Generale</option>
          <option v-for="name in wall?.projects ?? []" :key="name" :value="name">{{ name }}</option>
        </select></label
      >
      <label class="flex flex-1 flex-col gap-1 text-[13px] text-muted"
        >Chi la fa<select v-model="draft.assignee" class="field px-2 py-1.5 text-[14px] text-ink">
          <option value="user">Tu</option>
          <option v-for="agent in wall?.agents ?? []" :key="agent" :value="agent">{{ agentName(agent) }}</option>
        </select></label
      >
      <label class="flex flex-1 flex-col gap-1 text-[13px] text-muted"
        >Priorità<select v-model.number="draft.priority" class="field px-2 py-1.5 text-[14px] text-ink">
          <option v-for="(name, value) in PRIORITY_TEXT" :key="value" :value="value">{{ name }}</option>
        </select></label
      >
      <label class="flex flex-1 flex-col gap-1 text-[13px] text-muted">Scadenza<input v-model="draft.due" type="date" class="field px-2 py-1.5 text-[14px] text-ink" /></label>
      <div class="flex gap-1.5">
        <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="saving || draft.title.trim() === ''">Aggiungi</button>
        <button type="button" class="btn px-3 py-1.5 text-[14px]" @click="adding = false">Annulla</button>
      </div>
    </form>

    <p v-if="loadProblem !== null" role="alert" class="text-sm text-danger">{{ loadProblem }}</p>
    <p v-else-if="wall === null" class="text-sm text-muted">Carico le card…</p>
    <p v-else-if="state.view === 'board' && columns.length === 0" class="text-sm text-muted">Tutte le colonne sono nascoste: rimettile da «Colonne».</p>

    <!-- The phone (D-293): which column is shown, one at a time; a swipe on the column moves to the next. -->
    <div
      v-if="wall !== null && state.view === 'board' && columns.length > 0"
      ref="columnTabs"
      class="-mx-4 flex shrink-0 snap-x gap-1.5 overflow-x-auto px-4 pb-0.5 md:hidden"
      role="tablist"
      aria-label="Colonna mostrata"
    >
      <button
        v-for="column in columns"
        :key="column.id"
        type="button"
        role="tab"
        class="flex min-h-11 shrink-0 snap-start items-center gap-1.5 rounded-full border px-3.5 text-[14.5px]"
        :class="column.id === shownColumn ? 'border-accent bg-accent text-accent-ink' : column.id === 'failed' ? 'border-line-strong text-danger' : 'border-line-strong text-muted'"
        :aria-selected="column.id === shownColumn"
        @click="showColumn(column.id)"
      >
        {{ column.title }}<span class="text-[13px] tabular-nums opacity-80">{{ groups.get(column.id)?.length ?? 0 }}</span>
      </button>
    </div>

    <!-- Board: side by side from md, scrolling sideways inside the page; one column at a time on a phone. -->
    <div v-if="wall !== null && state.view === 'board' && columns.length > 0" class="flex flex-col gap-3 md:min-h-0 md:flex-1 md:flex-row md:overflow-x-auto md:pb-1" @touchstart.passive="onSwipeStart" @touchend="onSwipeEnd">
      <section
        v-for="column in columns"
        :key="column.id"
        class="flex flex-col rounded-xl border bg-surface transition-colors md:min-h-0 md:w-[272px] md:shrink-0"
        :class="[over === column.id ? 'border-accent bg-accent/5' : 'border-line', { 'max-md:hidden': column.id !== shownColumn }]"
        :aria-label="column.title"
        @dragover="onDragOver($event, column)"
        @dragleave="onDragLeave($event, column)"
        @drop="onDrop($event, column)"
      >
        <header class="flex items-center gap-2 border-b border-line px-3 py-2 max-md:hidden">
          <h2 class="flex-1 text-[14.5px] font-semibold" :class="{ 'text-danger': column.id === 'failed' }">{{ column.title }}</h2>
          <span class="text-[13px] text-muted tabular-nums">{{ groups.get(column.id)?.length ?? 0 }}</span>
        </header>
        <ul class="flex min-h-[64px] flex-col gap-2 p-2 md:min-h-0 md:flex-1 md:overflow-y-auto">
          <li v-if="(groups.get(column.id)?.length ?? 0) === 0" class="px-1.5 py-3 text-center text-[13px] text-muted">
            <template v-if="column.drop === null">Nessuna card</template>
            <template v-else><span class="touch:hidden">Nessuna card: trascinane una qui</span><span class="hidden touch:inline">Nessuna card: apri una card e usa «Sposta in»</span></template>
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
                <span class="min-w-0 flex-1 text-[14.5px] leading-snug break-words" :class="{ 'text-muted line-through': card.kind === 'commitment' && card.status !== 'open' }">{{ card.title }}</span>
                <LabelBadge :label="card.label" dot />
              </span>
              <span class="flex flex-wrap items-center gap-1 text-[12.5px]">
                <span v-if="priorityText(card.priority) !== undefined" class="chip inline-flex items-center gap-1" :class="PRIORITY_CLASS[card.priority]"><Icon name="priority" :size="11" />{{ priorityText(card.priority) }}</span>
                <span v-if="card.kind === 'commitment'" class="chip text-accent">Impegno</span>
                <span v-if="card.column === 'failed'" class="chip text-danger">Fallito</span>
                <span v-if="complexityBadge(card) !== undefined" class="chip font-semibold text-ink tabular-nums" :title="complexityBadge(card)?.title"><span aria-hidden="true">{{ complexityBadge(card)?.text }}</span><span class="sr-only">{{ complexityBadge(card)?.title }}</span></span>
                <span class="chip text-muted">{{ card.project ?? 'Generale' }}</span>
                <span class="chip text-muted">{{ assigneeText(card.assignee, agentName) }}</span>
                <span v-if="plannedText(card, today) !== undefined" class="chip inline-flex items-center gap-1 text-muted" title="Data esecuzione"><Icon name="calendar" :size="11" />{{ plannedText(card, today) }}</span>
                <span v-if="dueText(card, today) !== undefined" class="chip" :class="card.late ? 'text-danger' : 'text-muted'" title="Scadenza">{{ dueText(card, today) }}</span>
              </span>
              <span v-if="cardMarks(card).length > 0" class="flex flex-wrap items-center gap-2.5 text-[12.5px] text-muted">
                <span v-for="mark in cardMarks(card)" :key="mark.icon" class="inline-flex items-center gap-1" :title="mark.title"><Icon :name="mark.icon" :size="12" />{{ mark.text }}<span class="sr-only">{{ mark.title }}</span></span>
              </span>
              <span v-if="blockedText(card) !== undefined" class="truncate text-[13px] text-warn" :title="card.blockedBy.map((item) => item.title).join(', ')">{{ blockedText(card) }}</span>
              <span v-if="card.waitingReason !== null" class="truncate text-[13px] text-muted" :title="reasonText(card.waitingReason) ?? card.waitingReason">{{ reasonText(card.waitingReason) ?? card.waitingReason }}</span>
              <span v-if="turnText(card) !== undefined" class="truncate text-[13px] text-muted">{{ turnText(card) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <!-- List: a table, sideways scroll inside its box on a narrow screen. -->
    <div v-if="wall !== null && state.view === 'list'" class="min-h-0 overflow-auto rounded-xl border border-line bg-surface md:flex-1">
      <table class="w-full min-w-[860px] border-collapse text-left text-[14px]">
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
            <td class="px-3 py-2 text-right font-mono text-[13px] text-muted">{{ card.files > 0 ? card.files : '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- IM (D-167): the Iteration Meetings of a project, from their files. -->
    <ImBoard v-if="wall !== null && state.view === 'im'" :projects="wall.projects" :version="version" @open-card="openCard" />

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
      :approvals="approvals"
      :decide="decide"
      @close="selectedId = null"
      @changed="refresh"
    />
  </section>
</template>

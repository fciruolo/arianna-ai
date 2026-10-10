<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { addImItem, createIm, listIms, readIm, setImItemState } from '../lib/api.ts';
import {
  callText,
  fromDateTimeInput,
  groupItems,
  IM_CHANGED_TEXT,
  IM_ITEM_STATES,
  IM_STATE_TEXT,
  IM_STATUS_TEXT,
  type ImDetail,
  imErrorText,
  type ImItem,
  type ImItemState,
  imOptionText,
  type ImSummary,
  imTitleText,
  isStale,
  loadImPrefs,
  needsFirstDate,
  pickIm,
  saveImPrefs,
  withSummary,
} from '../lib/im.ts';
import FilterMenu from './FilterMenu.vue';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * The view "IM" of the cardwall (D-167, I-11 tappa P4a): the Iteration
 * Meetings of a project, read from their files by the core. A project and an
 * IM on top (remembered in this browser), the five columns of its items; an
 * item moves with a drag or with its small menu, "+ Voce" adds one to Da fare,
 * "Nuovo IM" makes the next one. Every write carries the version of the file:
 * when the file changed meanwhile (edited in Obsidian) the core says 409 and
 * the IM is read again.
 */
const props = defineProps<{
  /** The projects of the cardwall (containers). */
  projects: string[];
  /** The live feed's counter: read again, quietly, when it moves. */
  version: number;
}>();

const storage = (() => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
})();
const prefs = ref(loadImPrefs(storage));
watch(prefs, (value) => saveImPrefs(storage, value), { deep: true });

const project = computed(() => {
  const saved = prefs.value.project;
  return saved !== null && props.projects.includes(saved) ? saved : (props.projects[0] ?? null);
});
const projectOptions = computed(() => props.projects.map((name) => ({ value: name, text: name })));
const projectChoice = computed({
  get: () => project.value ?? '',
  set: (name: string) => {
    if (name !== '') prefs.value.project = name;
  },
});

const ims = ref<ImSummary[] | null>(null);
const im = ref<ImDetail | null>(null);
const listProblem = ref<string | null>(null);
const problem = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
/** Reading the chosen IM failed: the error says it, "Carico l’IM…" no longer. */
const imFailed = ref(false);

const selected = computed(() => (ims.value === null || project.value === null ? undefined : pickIm(ims.value, prefs.value.ims[project.value])));
const imOptions = computed(() => [...(ims.value ?? [])].reverse().map((entry) => ({ value: String(entry.number), text: imOptionText(entry) })));
const imChoice = computed({
  get: () => (selected.value === undefined ? '' : String(selected.value)),
  set: (value: string) => {
    if (value !== '' && project.value !== null) prefs.value.ims[project.value] = Number(value);
  },
});
const groups = computed(() => groupItems(im.value?.items ?? []));

/** The list of the project; the IM follows from `selected`. */
async function loadList(): Promise<void> {
  const name = project.value;
  if (name === null) {
    ims.value = [];
    return;
  }
  try {
    const list = await listIms(name);
    if (project.value !== name) return;
    ims.value = list;
    listProblem.value = null;
  } catch (cause) {
    if (project.value === name) listProblem.value = `Non riesco a leggere gli IM: ${imErrorText(cause)}`;
  }
}

async function loadIm(): Promise<void> {
  const name = project.value;
  const number = selected.value;
  if (name === null || number === undefined) {
    im.value = null;
    return;
  }
  try {
    imFailed.value = false;
    const read = await readIm(name, number);
    if (project.value === name && selected.value === number) im.value = read;
  } catch (cause) {
    if (project.value === name && selected.value === number) {
      imFailed.value = true;
      problem.value = imErrorText(cause);
    }
  }
}

watch(project, () => {
  ims.value = null;
  im.value = null;
  problem.value = null;
  notice.value = null;
  imFailed.value = false;
  void loadList();
});
watch(selected, (number) => {
  if (im.value?.number !== number) im.value = null;
  void loadIm();
});
onMounted(loadList);

let timer: number | undefined;
watch(
  () => props.version,
  () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (busy.value) return;
      void loadList().then(loadIm);
    }, 300);
  },
);
onBeforeUnmount(() => window.clearTimeout(timer));

/** A write with the version of the file: the answer replaces the IM; a 409 reads it again. */
async function write(change: (name: string, current: ImDetail) => Promise<ImDetail>): Promise<boolean> {
  const name = project.value;
  const current = im.value;
  if (name === null || current === null || busy.value) return false;
  busy.value = true;
  problem.value = null;
  notice.value = null;
  try {
    const next = await change(name, current);
    if (project.value === name) {
      im.value = next;
      if (ims.value !== null) ims.value = withSummary(ims.value, next);
      await loadList();
    }
    return true;
  } catch (cause) {
    if (isStale(cause)) {
      await loadList();
      await loadIm();
      notice.value = IM_CHANGED_TEXT;
    } else {
      problem.value = imErrorText(cause);
    }
    return false;
  } finally {
    busy.value = false;
  }
}

async function moveItem(item: ImItem, state: ImItemState): Promise<void> {
  menuLine.value = null;
  if (item.state === state) return;
  await write((name, current) => setImItemState(name, current.number, item.line, state, current.version));
}

// "+ Voce", at the top of Da fare.
const newItem = ref('');
async function addItem(): Promise<void> {
  const title = newItem.value.trim();
  if (title === '') return;
  if (await write((name, current) => addImItem(name, current.number, title, current.version))) newItem.value = '';
}

// "Nuovo IM": the next one; the first one of a project, or the one after an IM
// without a date, asks its day and hour.
const creating = ref(false);
const firstDate = ref('');
const firstDateInput = ref<HTMLInputElement | null>(null);
const asksDate = computed(() => ims.value !== null && needsFirstDate(ims.value));
const isFirst = computed(() => (ims.value?.length ?? 0) === 0);

async function newIm(): Promise<void> {
  const name = project.value;
  if (name === null || creating.value) return;
  let date: string | undefined;
  if (asksDate.value) {
    date = fromDateTimeInput(firstDate.value);
    if (date === undefined) {
      problem.value = isFirst.value ? 'Scegli il giorno e l’ora del primo IM.' : 'Scegli il giorno e l’ora dell’IM.';
      firstDateInput.value?.focus();
      return;
    }
  }
  creating.value = true;
  problem.value = null;
  notice.value = null;
  try {
    const made = await createIm(name, date);
    if (project.value !== name) return;
    ims.value = withSummary(ims.value ?? [], made);
    prefs.value.ims[name] = made.number;
    im.value = made;
    firstDate.value = '';
    await loadList();
  } catch (cause) {
    problem.value = imErrorText(cause);
  } finally {
    creating.value = false;
  }
}

// The small menu of an item: the other four columns, by keyboard as well; a
// click outside it (and outside its button) or Esc closes it.
const menuLine = ref<number | null>(null);
const menus = ref(new Map<number, HTMLElement>());

function onDocument(event: PointerEvent): void {
  const line = menuLine.value;
  if (line === null) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (menus.value.get(line)?.contains(target) === true) return;
  if (document.getElementById(`im-item-menu-${String(line)}`)?.contains(target) === true) return;
  menuLine.value = null;
}

watch(menuLine, (now, before) => {
  if (now !== null && before === null) document.addEventListener('pointerdown', onDocument, true);
  if (now === null) document.removeEventListener('pointerdown', onDocument, true);
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocument, true));

function setMenu(line: number, element: unknown): void {
  if (element instanceof HTMLElement) menus.value.set(line, element);
  else menus.value.delete(line);
}

async function toggleMenu(item: ImItem): Promise<void> {
  menuLine.value = menuLine.value === item.line ? null : item.line;
  if (menuLine.value === null) return;
  await nextTick();
  menus.value.get(item.line)?.querySelector<HTMLElement>('button')?.focus();
}

function closeMenu(item: ImItem): void {
  menuLine.value = null;
  void nextTick(() => document.getElementById(`im-item-menu-${String(item.line)}`)?.focus());
}

// Drag and drop between the columns (HTML5, as the cards).
const dragging = ref<ImItem | null>(null);
const over = ref<ImItemState | null>(null);

function onDragStart(event: DragEvent, item: ImItem): void {
  dragging.value = item;
  event.dataTransfer?.setData('text/plain', item.title);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(): void {
  dragging.value = null;
  over.value = null;
}

function onDragOver(event: DragEvent, state: ImItemState): void {
  if (dragging.value === null || busy.value) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  over.value = state;
}

function onDragLeave(event: DragEvent, state: ImItemState): void {
  const into = event.relatedTarget;
  if (over.value === state && !(into instanceof Node && (event.currentTarget as HTMLElement).contains(into))) over.value = null;
}

async function onDrop(event: DragEvent, state: ImItemState): Promise<void> {
  event.preventDefault();
  const item = dragging.value;
  onDragEnd();
  if (item !== null) await moveItem(item, state);
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-3 md:flex-1">
    <!-- Project, IM, new IM. -->
    <div class="flex flex-wrap items-center gap-2">
      <FilterMenu v-if="projects.length > 0" v-model="projectChoice" label="Progetto" icon="project" :options="projectOptions" plain />
      <FilterMenu v-if="(ims?.length ?? 0) > 0" v-model="imChoice" label="IM" icon="calendar" :options="imOptions" plain />
      <form v-if="project !== null && ims !== null" class="flex flex-wrap items-center gap-2" @submit.prevent="newIm">
        <label v-if="asksDate" class="flex items-center gap-1.5 text-[12px] text-muted"
          >{{ isFirst ? 'Primo IM' : 'Data dell’IM' }}<input ref="firstDateInput" v-model="firstDate" type="datetime-local" class="field px-2 py-1 text-[13px] text-ink" required
        /></label>
        <button type="submit" class="btn px-3 py-1.5 text-[13px]" :disabled="creating || (asksDate && firstDate === '')"><Icon name="new" :size="14" />Nuovo IM</button>
      </form>
    </div>

    <p v-if="notice !== null" role="status" class="flex items-start gap-2 rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[13px] text-ink">
      <Icon name="info" :size="14" class="mt-0.5 shrink-0 text-accent" />
      <span class="flex-1">{{ notice }}</span>
      <button type="button" class="shrink-0 text-muted hover:text-ink" aria-label="Chiudi l’avviso" @click="notice = null"><Icon name="close" :size="14" /></button>
    </p>
    <p v-if="problem !== null" role="alert" class="flex items-start gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-[13px] text-danger">
      <span class="flex-1">{{ problem }}</span>
      <button type="button" class="shrink-0 text-muted hover:text-ink" aria-label="Chiudi l’avviso" @click="problem = null"><Icon name="close" :size="14" /></button>
    </p>

    <p v-if="projects.length === 0" class="text-sm text-muted">Non ci sono progetti: gli IM stanno nelle cartelle di gestione di un progetto.</p>
    <p v-else-if="listProblem !== null" role="alert" class="text-sm text-danger">{{ listProblem }}</p>
    <p v-else-if="ims === null" class="text-sm text-muted">Carico gli IM…</p>
    <p v-else-if="ims.length === 0" class="text-sm text-muted">Questo progetto non ha ancora IM: scegli giorno e ora del primo e premi «Nuovo IM».</p>
    <p v-else-if="im === null && !imFailed" class="text-sm text-muted">Carico l’IM…</p>

    <template v-if="im !== null">
      <!-- The header of the IM: number, day and hour, state, the moved call. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <h2 class="font-medium text-ink">{{ imTitleText(im) }}</h2>
        <span class="chip" :class="im.status === 'chiuso' ? 'text-muted' : 'text-accent'">{{ IM_STATUS_TEXT[im.status] }}</span>
        <LabelBadge :label="im.label" />
        <span v-if="callText(im.call) !== undefined" class="inline-flex items-center gap-1 text-warn"><Icon name="phone" :size="13" />{{ callText(im.call) }}</span>
      </div>

      <!-- Five columns: side by side from md, one under the other on a phone. -->
      <div class="flex flex-col gap-3 md:min-h-0 md:flex-1 md:flex-row md:overflow-x-auto md:pb-1">
        <section
          v-for="state in IM_ITEM_STATES"
          :key="state"
          class="flex flex-col rounded-xl border bg-surface transition-colors md:min-h-0 md:w-[272px] md:shrink-0"
          :class="over === state ? 'border-accent bg-accent/5' : 'border-line'"
          :aria-label="IM_STATE_TEXT[state]"
          @dragover="onDragOver($event, state)"
          @dragleave="onDragLeave($event, state)"
          @drop="onDrop($event, state)"
        >
          <header class="flex items-center gap-2 border-b border-line px-3 py-2">
            <h3 class="hud-title flex-1">{{ IM_STATE_TEXT[state] }}</h3>
            <span class="font-mono text-[11px] text-muted">{{ groups[state].length }}</span>
          </header>
          <ul class="flex min-h-[64px] flex-col gap-2 p-2 md:min-h-0 md:flex-1 md:overflow-y-auto">
            <li v-if="state === 'todo'">
              <form class="flex items-center gap-1.5" @submit.prevent="addItem">
                <input
                  v-model="newItem"
                  maxlength="300"
                  class="field min-w-0 flex-1 px-2.5 py-1.5 text-[13px] text-ink"
                  placeholder="+ Voce"
                  aria-label="Nuova voce dell’IM"
                />
                <button type="submit" class="btn px-2 py-1 text-[12px]" :disabled="busy || newItem.trim() === ''">Aggiungi</button>
              </form>
            </li>
            <li v-if="groups[state].length === 0" class="px-1.5 py-3 text-center text-[12px] text-muted">Nessuna voce: trascinane una qui</li>
            <li
              v-for="item in groups[state]"
              :key="`${item.line}:${item.title}`"
              draggable="true"
              class="rounded-lg border border-line bg-surface-2 hover:border-line-strong"
              :class="{ 'opacity-50': dragging?.line === item.line }"
              @dragstart="onDragStart($event, item)"
              @dragend="onDragEnd"
            >
              <div class="flex items-start gap-2 px-2.5 py-2">
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span class="text-[13.5px] leading-snug break-words" :class="{ 'text-muted line-through': state === 'cancelled' }">{{ item.title }}</span>
                  <span v-if="item.part !== null || item.card !== null" class="flex flex-wrap items-center gap-1 text-[11px]">
                    <span v-if="item.part !== null" class="chip text-info">Parte {{ item.part }}</span>
                    <span v-if="item.card !== null" class="chip inline-flex items-center gap-1 font-mono text-muted" title="Card collegata"><Icon name="cardwall" :size="11" />#card-{{ item.card }}</span>
                  </span>
                </div>
                <button
                  :id="`im-item-menu-${item.line}`"
                  type="button"
                  class="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-ink"
                  :aria-expanded="menuLine === item.line"
                  :aria-controls="`im-item-states-${item.line}`"
                  :aria-label="`Cambia stato: ${item.title}`"
                  title="Cambia stato"
                  :disabled="busy"
                  @click="toggleMenu(item)"
                >
                  <Icon name="menu" :size="14" />
                </button>
              </div>
              <div
                v-if="menuLine === item.line"
                :id="`im-item-states-${item.line}`"
                :ref="(element) => setMenu(item.line, element)"
                class="flex flex-wrap gap-1 border-t border-line px-2.5 py-2"
                role="group"
                aria-label="Sposta in"
                @keydown.esc.prevent="closeMenu(item)"
              >
                <button
                  v-for="target in IM_ITEM_STATES.filter((other) => other !== item.state)"
                  :key="target"
                  type="button"
                  class="btn px-2 py-0.5 text-[12px]"
                  :disabled="busy"
                  @click="moveItem(item, target)"
                >
                  {{ IM_STATE_TEXT[target] }}
                </button>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, createRoutine, loadRoutines, retireRoutine, setRoutineActive, tryRoutine, updateRoutine } from '../lib/api.ts';
import {
  DAY_LETTERS,
  dateText,
  emptyForm,
  formOf,
  formProblem,
  lastRunText,
  NEW_TEXT,
  RETIRE_CONFIRM_TEXT,
  ROUTINES_EMPTY_TEXT,
  ROUTINES_EMPTY_TITLE,
  ROUTINES_INTRO,
  ROUTINES_LOAD_ERROR,
  ROUTINES_TITLE,
  routineErrorText,
  scheduleText,
  SOURCE_CHOICES,
  SOURCE_TEXT,
  statusText,
  TITLE_MAX,
  toggled,
  TRY_HINT,
  TRY_TEXT,
  type IsoDay,
  type Routine,
  type RoutineForm,
  type RoutineSource,
} from '../lib/routines.ts';
import { readView, VIEW_CALENDAR_TEXT, VIEW_LIST_TEXT, writeView, type RoutinesView } from '../lib/routine-calendar.ts';
import Icon from './Icon.vue';
import PageHeader from './PageHeader.vue';
import RoutineCalendar from './RoutineCalendar.vue';

/**
 * The page «Routine» (D-110 tappa A, D-254): each routine is a card, as a
 * row of a Notion database seen as cards: title and when, what goes in the
 * report, in the chat, active or paused, the next run and the last outcome,
 * «Prova adesso». The form has closed choices only, besides the title; the
 * routine is born at the first save, active. The page reads the routines
 * again when the core says one changed (`version`).
 */
const props = defineProps<{ version: number }>();
const emit = defineEmits<{ open: [conversationId: string] }>();

const routines = ref<Routine[]>([]);
const loaded = ref(false);
const problem = ref<string | null>(null);
/** The form open: 'new', or the id of the routine being changed. */
const editing = ref<string | null>(null);
const form = ref<RoutineForm>(emptyForm());
const formError = ref<string | null>(null);
const saving = ref(false);
const busy = ref<Set<string>>(new Set());
const confirming = ref<string | null>(null);
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

const ALL_DAYS: readonly IsoDay[] = DAY_LETTERS.map((item) => item.day);
const ALL_SOURCES: readonly RoutineSource[] = SOURCE_CHOICES.map((item) => item.id);
const ownZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const problemOfForm = computed(() => formProblem(form.value));

/** Elenco or Calendario (D-257), remembered in this browser only. */
const storage = (() => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
})();
const view = ref<RoutinesView>(readView(storage));
watch(view, (value) => writeView(storage, value));
const formElement = ref<HTMLFormElement | null>(null);
/** The routine just saved: the calendar brings its block in sight. */
const focus = ref<string | null>(null);

/** The form in sight, after a click in the calendar far below it. */
function showForm(): void {
  void nextTick(() => {
    formElement.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    formElement.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  });
}

/** A free hour of the calendar: a new routine on that day of the week, at that hour. */
function startNewAt(prefilled: RoutineForm): void {
  editing.value = 'new';
  form.value = prefilled;
  formError.value = null;
  showForm();
}

function editFromCalendar(routine: Routine): void {
  startEdit(routine);
  showForm();
}

async function load(): Promise<void> {
  try {
    const list = await loadRoutines();
    if (!alive) return;
    routines.value = list;
    problem.value = null;
  } catch {
    if (alive) problem.value = ROUTINES_LOAD_ERROR;
  } finally {
    loaded.value = true;
  }
}

function say(text: string): void {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 4000);
}

function failed(error: unknown, fallback: string): string {
  return error instanceof ApiError ? routineErrorText(error.status, fallback) : fallback;
}

function startNew(): void {
  editing.value = 'new';
  form.value = emptyForm();
  formError.value = null;
}

function startEdit(routine: Routine): void {
  editing.value = routine.id;
  form.value = formOf(routine);
  formError.value = null;
}

function closeForm(): void {
  editing.value = null;
  formError.value = null;
}

async function save(): Promise<void> {
  if (problemOfForm.value !== null || saving.value) return;
  saving.value = true;
  formError.value = null;
  const sent: RoutineForm = { ...form.value, title: form.value.title.trim() };
  try {
    if (editing.value === 'new') {
      focus.value = (await createRoutine(sent)).id;
      say('Routine creata: il primo resoconto arriva all’ora scelta.');
    } else if (editing.value !== null) {
      focus.value = (await updateRoutine(editing.value, sent)).id;
      say('Routine salvata.');
    }
    closeForm();
    await load();
  } catch (error) {
    formError.value = failed(error, 'Non riesco a salvare la routine.');
  } finally {
    saving.value = false;
  }
}

async function act(routine: Routine, work: () => Promise<unknown>, done: string, fallback: string): Promise<void> {
  if (busy.value.has(routine.id)) return;
  busy.value = new Set([...busy.value, routine.id]);
  try {
    await work();
    say(done);
    await load();
  } catch (error) {
    problem.value = failed(error, fallback);
  } finally {
    const next = new Set(busy.value);
    next.delete(routine.id);
    busy.value = next;
  }
}

function toggleActive(routine: Routine): void {
  const active = routine.status !== 'active';
  void act(routine, () => setRoutineActive(routine.id, active), active ? 'Routine attiva.' : 'Routine in pausa.', 'Non riesco a cambiare la routine.');
}

function tryNow(routine: Routine): void {
  void act(routine, () => tryRoutine(routine.id), 'Resoconto scritto nella chat della routine.', 'Non riesco a scrivere il resoconto.');
}

function retire(routine: Routine): void {
  confirming.value = null;
  void act(routine, () => retireRoutine(routine.id), 'Routine tolta.', 'Non riesco a togliere la routine.');
}

watch(
  () => props.version,
  () => void load(),
);

onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(noticeTimer);
});
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1040px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
        <PageHeader :title="ROUTINES_TITLE" title-id="routines-title">
          {{ ROUTINES_INTRO }}
          <template #actions>
            <div class="flex overflow-hidden rounded-lg border border-line-strong" role="group" aria-label="Vista">
              <button type="button" class="flex items-center gap-1.5 px-2.5 py-1 text-[13.5px]" :class="view === 'list' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="view === 'list'" @click="view = 'list'">
                <Icon name="view-list" :size="14" />{{ VIEW_LIST_TEXT }}
              </button>
              <button type="button" class="flex items-center gap-1.5 border-l border-line-strong px-2.5 py-1 text-[13.5px]" :class="view === 'calendar' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="view === 'calendar'" @click="view = 'calendar'">
                <Icon name="calendar" :size="14" />{{ VIEW_CALENDAR_TEXT }}
              </button>
            </div>
            <button v-if="editing !== 'new'" type="button" class="btn btn-primary px-2.5 py-1 text-[13.5px]" @click="startNew">
              <Icon name="new" :size="14" />{{ NEW_TEXT }}
            </button>
          </template>
        </PageHeader>

        <p v-if="problem !== null" class="rounded-lg border border-danger/40 px-3 py-2 text-[14px] text-danger" role="alert">
          {{ problem }} <button type="button" class="underline" @click="problem = null; load()">Riprova</button>
        </p>

        <!-- The form: a new routine, or the one being changed. -->
        <form
          v-if="editing !== null"
          ref="formElement"
          class="flex flex-col gap-3.5 rounded-xl border border-line-strong bg-surface-2 px-4 py-3.5"
          :aria-label="editing === 'new' ? NEW_TEXT : 'Modifica la routine'"
          @submit.prevent="save"
        >
          <h2 class="text-[16px] font-semibold">{{ editing === 'new' ? NEW_TEXT : 'Modifica la routine' }}</h2>
          <label class="flex flex-col gap-1 text-[13.5px]">
            <span class="text-muted">Titolo</span>
            <input v-model="form.title" class="field px-2.5 py-1.5 text-[15px] text-ink" :maxlength="TITLE_MAX" placeholder="Resoconto della sera" autocomplete="off" />
          </label>
          <fieldset class="flex flex-col gap-1.5 text-[13.5px]">
            <legend class="mb-1 text-muted">Giorni</legend>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="item in DAY_LETTERS"
                :key="item.day"
                type="button"
                class="grid size-9 place-items-center rounded-lg border font-mono text-[14px] font-semibold"
                :class="form.days.includes(item.day) ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong text-muted hover:text-ink'"
                :aria-pressed="form.days.includes(item.day)"
                :aria-label="item.name"
                :title="item.name"
                @click="form.days = toggled(form.days, item.day, ALL_DAYS)"
              >{{ item.letter }}</button>
              <button type="button" class="rounded-md px-2 text-[13px] text-muted hover:text-ink" @click="form.days = [...ALL_DAYS]">Tutti</button>
              <button type="button" class="rounded-md px-2 text-[13px] text-muted hover:text-ink" @click="form.days = [1, 2, 3, 4, 5]">Lun-ven</button>
            </div>
          </fieldset>
          <label class="flex w-fit flex-col gap-1 text-[13.5px]">
            <span class="text-muted">Ora <span class="text-[12px]">({{ ownZone }})</span></span>
            <input v-model="form.at" type="time" step="60" class="field px-2.5 py-1.5 text-[15px] text-ink" required />
          </label>
          <fieldset class="flex flex-col gap-1.5 text-[13.5px]">
            <legend class="mb-1 text-muted">Nel resoconto</legend>
            <label v-for="choice in SOURCE_CHOICES" :key="choice.id" class="flex items-start gap-2">
              <input
                type="checkbox"
                class="mt-1"
                :checked="form.sources.includes(choice.id)"
                @change="form.sources = toggled(form.sources, choice.id, ALL_SOURCES)"
              />
              <span><b class="font-medium text-ink">{{ choice.label }}</b> <span class="text-muted">· {{ choice.hint }}</span></span>
            </label>
          </fieldset>
          <label class="flex items-start gap-2 text-[13.5px]">
            <input v-model="form.summary" type="checkbox" class="mt-1" />
            <span><b class="font-medium text-ink">Sintesi del modello locale</b> <span class="text-muted">· tre righe dopo il resoconto; se il modello non è pronto entro 20 minuti, il resoconto resta senza</span></span>
          </label>
          <p class="text-[12.5px] text-muted">Consegna: nella chat della routine. Le chiamate arriveranno con la tappa B.</p>
          <p v-if="formError !== null" class="text-[13.5px] text-danger" role="alert">{{ formError }}</p>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <span v-if="problemOfForm !== null" class="mr-auto text-[13px] text-muted">{{ problemOfForm }}</span>
            <button type="button" class="rounded-md px-2.5 py-1 text-[13.5px] text-muted hover:text-ink" @click="closeForm">Annulla</button>
            <button type="submit" class="btn btn-primary px-3 py-1 text-[13.5px]" :disabled="problemOfForm !== null || saving">{{ editing === 'new' ? 'Crea la routine' : 'Salva' }}</button>
          </div>
        </form>

        <RoutineCalendar v-if="view === 'calendar'" :routines="routines" :focus="focus" @edit="editFromCalendar" @create="startNewAt" @focused="focus = null" />

        <div v-else-if="loaded && routines.length === 0 && editing === null && problem === null" class="rounded-xl border border-dashed border-line-strong px-5 py-9 text-center text-muted">
          <b class="mb-1.5 block text-[16px] text-ink">{{ ROUTINES_EMPTY_TITLE }}</b>
          {{ ROUTINES_EMPTY_TEXT }}
          <div class="mt-4"><button type="button" class="btn px-3 py-1 text-[14px]" @click="startNew">{{ NEW_TEXT }}</button></div>
        </div>

        <div v-else class="grid grid-cols-1 items-start gap-3.5 md:grid-cols-2" aria-labelledby="routines-title">
          <article
            v-for="routine in routines"
            :key="routine.id"
            class="flex min-w-0 flex-col rounded-xl border border-line bg-surface-2"
            :class="routine.status === 'active' ? '' : 'opacity-80'"
            :aria-label="routine.title"
          >
            <header class="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
              <span class="mt-0.5 grid size-[20px] shrink-0 place-items-center rounded border border-line-strong font-mono text-[12px] font-semibold text-muted" aria-hidden="true">R</span>
              <div class="min-w-0 flex-1">
                <h2 class="truncate text-[15.5px] font-semibold">{{ routine.title }}</h2>
                <p class="text-[13.5px] text-muted">{{ scheduleText(routine) }}<template v-if="routine.timezone !== ownZone"> · {{ routine.timezone }}</template></p>
              </div>
              <button
                type="button"
                class="shrink-0 rounded-full border px-2.5 py-0.5 text-[12.5px] font-medium"
                :class="routine.status === 'active' ? 'border-ok/60 text-ok' : 'border-line-strong text-muted'"
                :aria-pressed="routine.status === 'active'"
                :disabled="busy.has(routine.id)"
                :title="routine.status === 'active' ? 'Metti in pausa' : 'Attiva'"
                @click="toggleActive(routine)"
              >{{ statusText(routine) }}</button>
            </header>

            <div v-if="confirming === routine.id" class="mx-3.5 mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-[13px]" role="alertdialog" :aria-label="RETIRE_CONFIRM_TEXT">
              <span class="flex-1">{{ RETIRE_CONFIRM_TEXT }}</span>
              <button type="button" class="rounded-md px-2 py-0.5 text-muted hover:text-ink" @click="confirming = null">Annulla</button>
              <button type="button" class="btn btn-danger px-2.5 py-0.5 text-[13px]" @click="retire(routine)">Togli</button>
            </div>

            <div class="flex flex-col gap-2 px-3.5 py-3 text-[13.5px]">
              <div class="flex flex-wrap gap-1.5">
                <span v-for="source in routine.sources" :key="source" class="pill">{{ SOURCE_TEXT[source] }}</span>
                <span class="pill"><Icon name="chat" :size="12" />in chat</span>
                <span v-if="routine.summary" class="pill">+ sintesi locale</span>
              </div>
              <p v-if="routine.status === 'active' && routine.nextRunAt !== null"><span class="text-muted">Prossima:</span> {{ dateText(routine.nextRunAt, routine.timezone) }}</p>
              <p v-else-if="routine.pausedBy === 'archived'" class="text-muted">La sua chat è archiviata: «Attiva» la ripristina.</p>
              <p v-if="lastRunText(routine.lastRun, routine.timezone) !== null" class="text-muted">{{ lastRunText(routine.lastRun, routine.timezone) }}</p>
            </div>

            <footer class="flex flex-wrap items-center gap-2 border-t border-dashed border-line px-3.5 py-2 text-[13px]">
              <button type="button" class="btn px-2.5 py-0.5 text-[13px]" :title="TRY_HINT" :disabled="busy.has(routine.id) || routine.conversationArchived" @click="tryNow(routine)">
                <Icon name="play" :size="13" />{{ TRY_TEXT }}
              </button>
              <button type="button" class="rounded-md px-2 py-0.5 text-accent hover:underline" @click="emit('open', routine.conversationId)">Apri la chat</button>
              <span class="flex-1" />
              <button type="button" class="rounded-md px-2 py-0.5 text-muted hover:text-ink" @click="startEdit(routine)">Modifica</button>
              <button type="button" class="rounded-md px-2 py-0.5 text-muted hover:text-danger" @click="confirming = routine.id">Togli</button>
            </footer>
          </article>
        </div>
      </div>
    </div>
    <div v-if="notice !== null" class="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-ink px-3.5 py-2 text-[14px] text-bg" role="status">{{ notice }}</div>
  </div>
</template>

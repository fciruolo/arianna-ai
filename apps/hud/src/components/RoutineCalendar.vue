<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, loadRoutineCalendar, splitRoutine, unsplitRoutine, updateRoutine } from '../lib/api.ts';
import {
  addDays,
  allDaysText,
  BLOCK_MINUTES,
  blockLook,
  blockText,
  CALENDAR_HINT,
  CALENDAR_LOAD_ERROR,
  canDrag,
  clockOf,
  dayHead,
  dayTitle,
  dragTarget,
  focusEntry,
  formAt,
  hourFor,
  HOURS,
  isClick,
  isoDayOf,
  layoutDay,
  LONG_PRESS_MS,
  MOVE_CONFLICT,
  MOVE_ERROR,
  movedText,
  movePlan,
  moveQuestion,
  nowIn,
  nowLine,
  onlyDayText,
  pastSlot,
  startHour,
  stepAnchor,
  TODAY_TEXT,
  UNDO_TEXT,
  visibleDays,
  weekRange,
  weekTitle,
  type CalendarDay,
  type CalendarEntry,
  type CalendarWeek,
} from '../lib/routine-calendar.ts';
import type { IsoDay, Routine, RoutineForm } from '../lib/routines.ts';

/**
 * The view «Calendario» of the page «Routine» (D-257): the week Monday to
 * Sunday (one day on a phone), one row per hour, each time of a routine as a
 * block (paused: faint; proposed: dashed), the runs already written with their
 * outcome and the line of the current hour. The times come from the core,
 * computed with the zone of each routine; the titles from the list the page
 * already has. A click on a block opens the routine, on a free hour a new one
 * at that day and hour. A block still to come drags to another hour (steps of
 * 15 minutes) or day: a routine of one day moves, one of more days asks
 * «Tutti i giorni» or «Solo <giorno>» (a new routine split off in the core);
 * «Spostata · Annulla» puts it back for a few seconds.
 */
/** `focus`: a routine just saved, to bring in sight once its times are read. */
const props = defineProps<{ routines: Routine[]; focus: string | null }>();
const emit = defineEmits<{ edit: [routine: Routine]; create: [form: RoutineForm]; focused: []; changed: [routineId: string] }>();

/** Pixels of one hour of the grid. */
const ROW = 44;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const now = ref(new Date());
const anchor = ref(nowIn(zone, now.value).date);
const week = ref<CalendarWeek | null>(null);
const problem = ref<string | null>(null);
const narrow = ref(false);
const scroller = ref<HTMLElement | null>(null);
let media: MediaQueryList | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let alive = true;
let asked = 0;
/** The first `from` of the week whose opening scroll was done: once per week shown. */
let scrolledFor: string | null = null;

/** A block being dragged: where it started and where it would land. */
interface Drag {
  entry: CalendarEntry;
  routine: Routine;
  pointer: number;
  x: number;
  y: number;
  start: { column: number; minute: number };
  columnPx: number;
  moving: boolean;
  /** Ready to drag: at once with a mouse, after a long press with a finger (otherwise the grid scrolls). */
  armed: boolean;
  element: HTMLElement;
  target: { column: number; minute: number };
}
const drag = ref<Drag | null>(null);
let pressTimer: ReturnType<typeof setTimeout> | undefined;
/** Esc stopped a drag: the release that follows must not open the routine. */
let escaped = false;
/** A drag just ended: the click that follows the release must not open the routine. */
let dragged = false;
/** The question after a drop on a routine of more days, beside the block. */
interface Choice {
  routine: Routine;
  from: IsoDay;
  to: IsoDay;
  at: string;
  all: IsoDay[];
  merges: boolean;
  later: boolean;
  column: number;
  minute: number;
}
const choice = ref<Choice | null>(null);
const moving = ref(false);
/** «Spostata · Annulla»: what puts the routine back, for a few seconds. */
const undo = ref<{ routineId: string; text: string; run: () => Promise<unknown> } | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | undefined;

const range = computed(() => weekRange(anchor.value));
/** The zone the times are in: the browser's, or the Mac's when the core did not know the browser's. */
const viewZone = computed(() => week.value?.timezone ?? zone);
const today = computed(() => nowIn(viewZone.value, now.value));
const byId = computed(() => new Map(props.routines.map((routine) => [routine.id, routine])));
const allDays = computed<CalendarDay[]>(() => {
  if (week.value !== null && week.value.from === range.value.from) return week.value.days;
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(range.value.from, index);
    return { date, isoDay: isoDayOf(date) };
  });
});
const days = computed(() => visibleDays(allDays.value, anchor.value, narrow.value));
const entries = computed<CalendarEntry[]>(() => (week.value !== null && week.value.from === range.value.from ? week.value.entries.filter((entry) => byId.value.has(entry.routineId)) : []));
const line = computed(() => nowLine(days.value, today.value));
const title = computed(() => (narrow.value ? dayTitle(anchor.value) : weekTitle(range.value.from, range.value.to)));
const onToday = computed(() => (narrow.value ? anchor.value === today.value.date : range.value.from === weekRange(today.value.date).from));

async function load(): Promise<void> {
  const ask = ++asked;
  const { from, to } = range.value;
  try {
    const found = await loadRoutineCalendar(from, to, zone).catch((error: unknown) => {
      // A zone of the browser the core does not know: the Mac's zone (no tz) instead.
      if (error instanceof ApiError && error.status === 400) return loadRoutineCalendar(from, to);
      throw error;
    });
    if (!alive || ask !== asked) return;
    week.value = found;
    problem.value = null;
    await nextTick();
    afterLoad();
  } catch {
    if (alive && ask === asked) problem.value = CALENDAR_LOAD_ERROR;
  }
}

function step(direction: -1 | 1): void {
  anchor.value = stepAnchor(anchor.value, direction, narrow.value);
}

function goToday(): void {
  now.value = new Date();
  anchor.value = today.value.date;
  scrolledFor = null;
  void nextTick(scrollToStart);
}

function scrollToHour(hour: number): void {
  if (scroller.value !== null) scroller.value.scrollTop = hour * ROW;
}

/** The opening scroll: 06, or the current hour and the first block when they come before. */
function scrollToStart(): void {
  const shown = new Set(days.value.map((day) => day.date));
  const first = entries.value.filter((entry) => shown.has(entry.date)).reduce<number | null>((least, entry) => (least === null ? entry.minute : Math.min(least, entry.minute)), null);
  scrollToHour(startHour(line.value?.minute ?? null, first));
}

/** After the times are read: the routine just saved in sight, else the opening scroll once per week. */
function afterLoad(): void {
  const focus = props.focus;
  if (focus !== null) {
    const found = focusEntry(entries.value, focus, now.value);
    emit('focused');
    if (found !== undefined) {
      if (narrow.value && anchor.value !== found.date) anchor.value = found.date;
      scrolledFor = range.value.from;
      void nextTick(() => {
        scrollToHour(hourFor(found.minute));
      });
      return;
    }
  }
  if (scrolledFor !== range.value.from) {
    scrolledFor = range.value.from;
    scrollToStart();
  }
}

function open(entry: CalendarEntry): void {
  if (dragged) {
    dragged = false;
    return;
  }
  const routine = byId.value.get(entry.routineId);
  if (routine !== undefined) emit('edit', routine);
}

function draggable(entry: CalendarEntry): boolean {
  return !moving.value && canDrag(entry, byId.value.get(entry.routineId), viewZone.value, now.value);
}

function pressBlock(event: PointerEvent, entry: CalendarEntry, column: number): void {
  const routine = byId.value.get(entry.routineId);
  if (event.button !== 0 || routine === undefined || !draggable(entry)) return;
  const element = event.currentTarget as HTMLElement;
  const columnPx = element.parentElement?.offsetWidth ?? 0;
  const touch = event.pointerType === 'touch';
  choice.value = null;
  escaped = false;
  const start = { column, minute: entry.minute };
  drag.value = { entry, routine, pointer: event.pointerId, x: event.clientX, y: event.clientY, start, columnPx, moving: false, armed: !touch, element, target: start };
  clearTimeout(pressTimer);
  if (!touch) {
    element.setPointerCapture(event.pointerId);
    return;
  }
  const pointer = event.pointerId;
  pressTimer = setTimeout(() => {
    const current = drag.value;
    if (current === null || current.pointer !== pointer) return;
    current.armed = true;
    try {
      current.element.setPointerCapture(pointer);
    } catch {
      // The finger already left: nothing to drag.
    }
  }, LONG_PRESS_MS);
}

/** While a finger drags a block the page must not scroll (the listener is not passive). */
function holdScroll(event: TouchEvent): void {
  if (drag.value?.armed === true) event.preventDefault();
}

function stopDrag(): void {
  const current = drag.value;
  clearTimeout(pressTimer);
  drag.value = null;
  if (current === null) return;
  try {
    current.element.releasePointerCapture(current.pointer);
  } catch {
    // Not captured.
  }
}

/** Esc: the drag stops where it started and the question closes. */
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (drag.value !== null) {
    escaped = drag.value.moving;
    stopDrag();
  }
  choice.value = null;
}

function moveBlock(event: PointerEvent): void {
  const current = drag.value;
  if (current === null || current.pointer !== event.pointerId) return;
  const dx = event.clientX - current.x;
  const dy = event.clientY - current.y;
  if (!current.moving && isClick(dx, dy)) return;
  if (!current.armed) {
    // A finger that moves before the long press scrolls the grid.
    stopDrag();
    return;
  }
  current.moving = true;
  current.target = dragTarget(current.start, dx, dy, ROW, current.columnPx, days.value.length);
}

function releaseBlock(event: PointerEvent): void {
  const current = drag.value;
  if (escaped) {
    escaped = false;
    dragged = true;
    setTimeout(() => (dragged = false), 0);
  }
  if (current === null || current.pointer !== event.pointerId) return;
  clearTimeout(pressTimer);
  drag.value = null;
  if (!current.moving) return;
  dragged = true;
  setTimeout(() => (dragged = false), 0);
  const from = isoDayOf(current.entry.date);
  const day = days.value[current.target.column];
  const to = day?.isoDay ?? from;
  const at = clockOf(current.target.minute);
  const later = day !== undefined && pastSlot(day.date, current.target.minute, today.value);
  const plan = movePlan(current.routine, from, to, at);
  if (plan.kind === 'none') return;
  if (plan.kind === 'move') {
    void applyMove(current.routine, plan.days, plan.at, later);
    return;
  }
  choice.value = { routine: current.routine, from: plan.from, to: plan.to, at: plan.at, all: plan.all, merges: plan.merges, later, column: current.target.column, minute: current.target.minute };
  void nextTick(() => {
    scroller.value?.querySelector('[data-move-choice]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function cancelDrag(): void {
  stopDrag();
}

function offerUndo(routineId: string, text: string, run: () => Promise<unknown>): void {
  clearTimeout(undoTimer);
  undo.value = { routineId, text, run };
  undoTimer = setTimeout(() => (undo.value = null), 7000);
}

async function work(routineId: string, task: () => Promise<unknown>): Promise<boolean> {
  moving.value = true;
  try {
    await task();
    problem.value = null;
    emit('changed', routineId);
    return true;
  } catch (error) {
    problem.value = error instanceof ApiError && error.status === 409 ? MOVE_CONFLICT : MOVE_ERROR;
    return false;
  } finally {
    moving.value = false;
  }
}

/** A routine of one day, or «Tutti i giorni»: the existing change, so the next run follows. */
async function applyMove(routine: Routine, days: IsoDay[], at: string, later: boolean): Promise<void> {
  const before = { days: [...routine.days], at: routine.at };
  if (await work(routine.id, () => updateRoutine(routine.id, { days, at }))) offerUndo(routine.id, movedText(later), () => updateRoutine(routine.id, before));
}

function chooseAll(): void {
  const current = choice.value;
  choice.value = null;
  if (current !== null) void applyMove(current.routine, current.all, current.at, current.later);
}

/**
 * «Solo <giorno>»: the core splits the routine and the view goes to the new
 * one; «Annulla» is one step of the core too (unsplit), refused when the first
 * routine changed in between.
 */
function chooseOnly(): void {
  const current = choice.value;
  choice.value = null;
  if (current === null) return;
  const routine = current.routine;
  const before = { days: [...routine.days], at: routine.at };
  void (async () => {
    moving.value = true;
    try {
      const { created } = await splitRoutine(routine.id, current.from, current.to, current.at);
      problem.value = null;
      emit('changed', created.id);
      offerUndo(routine.id, movedText(current.later), () => unsplitRoutine(routine.id, created.id, before.days, before.at));
    } catch {
      problem.value = MOVE_ERROR;
    } finally {
      moving.value = false;
    }
  })();
}

function undoMove(): void {
  const current = undo.value;
  undo.value = null;
  clearTimeout(undoTimer);
  if (current !== null) void work(current.routineId, current.run);
}

function blocksOf(day: CalendarDay) {
  return layoutDay(entries.value, day.date).map((block) => {
    const routine = byId.value.get(block.entry.routineId);
    const look = blockLook(block.entry, routine, now.value);
    return { ...block, look, label: blockText(block.entry, routine?.title ?? 'Routine', look), title: routine?.title ?? 'Routine' };
  });
}

function onMedia(event: MediaQueryListEvent | MediaQueryList): void {
  narrow.value = event.matches;
}

watch(
  () => range.value.from,
  () => {
    // Another week: the question and a drag of the week before close.
    choice.value = null;
    stopDrag();
    void load();
  },
);
// A change of `version` makes the page read the routines again: the new list is the signal.
watch(
  () => props.routines,
  () => void load(),
);

onMounted(() => {
  try {
    media = window.matchMedia('(max-width: 767px)');
    onMedia(media);
    media.addEventListener('change', onMedia);
  } catch {
    media = undefined;
  }
  clock = setInterval(() => (now.value = new Date()), 60_000);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('touchmove', holdScroll, { passive: false });
  void load();
});
onBeforeUnmount(() => {
  alive = false;
  clearInterval(clock);
  clearTimeout(undoTimer);
  clearTimeout(pressTimer);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('touchmove', holdScroll);
  media?.removeEventListener('change', onMedia);
});
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2.5" aria-label="Calendario delle routine">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex overflow-hidden rounded-lg border border-line-strong" role="group" aria-label="Settimana">
        <button type="button" class="px-2.5 py-1 text-[14px] text-muted hover:text-ink" :aria-label="narrow ? 'Giorno precedente' : 'Settimana precedente'" @click="step(-1)">‹</button>
        <button type="button" class="border-x border-line-strong px-2.5 py-1 text-[13.5px]" :class="onToday ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" @click="goToday">{{ TODAY_TEXT }}</button>
        <button type="button" class="px-2.5 py-1 text-[14px] text-muted hover:text-ink" :aria-label="narrow ? 'Giorno successivo' : 'Settimana successiva'" @click="step(1)">›</button>
      </div>
      <h2 class="text-[15px] font-semibold first-letter:uppercase" aria-live="polite">{{ title }}</h2>
      <span class="ml-auto hidden text-[12.5px] text-muted md:inline">{{ CALENDAR_HINT }}</span>
    </div>

    <p v-if="problem !== null" class="rounded-lg border border-danger/40 px-3 py-2 text-[14px] text-danger" role="alert">
      {{ problem }} <button type="button" class="underline" @click="load()">Riprova</button>
    </p>

    <div class="overflow-hidden rounded-xl border border-line bg-surface-2">
      <!-- The heads of the days. -->
      <div class="flex border-b border-line">
        <div class="w-12 shrink-0" aria-hidden="true" />
        <div
          v-for="day in days"
          :key="day.date"
          class="min-w-0 flex-1 border-l border-line px-1.5 py-1.5 text-center text-[12.5px]"
          :class="day.date === today.date ? 'font-semibold text-accent' : 'text-muted'"
        >{{ dayHead(day) }}</div>
      </div>

      <!-- The hours, scrolled to the morning; the night stays a scroll away. -->
      <div ref="scroller" class="max-h-[min(62vh,620px)] overflow-y-auto">
        <div class="relative flex" :style="{ height: `${String(24 * ROW)}px` }">
          <div class="w-12 shrink-0" aria-hidden="true">
            <div v-for="hour in HOURS" :key="hour" class="relative font-mono text-[11px] text-muted" :style="{ height: `${String(ROW)}px` }">
              <span v-if="hour > 0" class="absolute -top-2 right-1.5">{{ String(hour).padStart(2, '0') }}:00</span>
            </div>
          </div>
          <div v-for="(day, column) in days" :key="day.date" class="relative min-w-0 flex-1 border-l border-line">
            <!-- A free hour: a new routine at that day and hour. -->
            <button
              v-for="hour in HOURS"
              :key="hour"
              type="button"
              tabindex="-1"
              class="block w-full border-t border-line/60 hover:bg-accent/5 focus-visible:bg-accent/10"
              :class="hour === 0 ? 'border-t-0' : ''"
              :style="{ height: `${String(ROW)}px` }"
              :title="`Nuova routine: ${dayTitle(day.date)} alle ${String(hour).padStart(2, '0')}:00`"
              :aria-label="`Nuova routine: ${dayTitle(day.date)} alle ${String(hour).padStart(2, '0')}:00`"
              @click="emit('create', formAt(day.date, hour))"
            />
            <!-- The times of the routines. -->
            <button
              v-for="block in blocksOf(day)"
              :key="`${block.entry.routineId}@${block.entry.at}`"
              type="button"
              class="absolute flex min-w-0 items-center gap-1 overflow-hidden rounded-md border px-1.5 text-left text-[11.5px] leading-tight"
              :class="[
                block.look.status === 'proposed' ? 'border-dashed border-accent/70 bg-surface' : block.look.status === 'paused' ? 'border-line-strong bg-surface opacity-55' : 'border-accent/60 bg-accent/15',
                block.look.past && block.look.outcome === null ? 'opacity-55' : '',
                block.look.trial ? 'border-dotted' : '',
                draggable(block.entry) ? 'cursor-grab touch-pan-y select-none' : '',
                drag?.moving && drag.entry === block.entry ? 'opacity-40' : '',
              ]"
              :style="{
                top: `${String((block.start / 60) * ROW + 1)}px`,
                height: `${String((BLOCK_MINUTES / 60) * ROW - 2)}px`,
                left: `calc(${String((block.lane / block.lanes) * 100)}% + 2px)`,
                width: `calc(${String(100 / block.lanes)}% - 4px)`,
              }"
              :title="block.label"
              :aria-label="block.label"
              @click="open(block.entry)"
              @pointerdown="pressBlock($event, block.entry, column)"
              @pointermove="moveBlock"
              @pointerup="releaseBlock"
              @pointercancel="cancelDrag"
              @contextmenu="draggable(block.entry) && $event.preventDefault()"
            >
              <span
                v-if="block.look.outcome !== null"
                class="size-2 shrink-0 rounded-full"
                :class="block.look.outcome === 'done' ? 'bg-ok' : block.look.outcome === 'failed' ? 'bg-danger' : 'bg-warn'"
                aria-hidden="true"
              />
              <span class="shrink-0 font-mono text-muted">{{ block.entry.time }}</span>
              <span class="truncate text-ink">{{ block.title }}</span>
            </button>
            <!-- Where the dragged block would land. -->
            <div
              v-if="drag !== null && drag.moving && drag.target.column === column"
              class="pointer-events-none absolute inset-x-0.5 z-20 flex items-center gap-1 rounded-md border border-dashed border-accent bg-accent/25 px-1.5 text-[11.5px]"
              :style="{ top: `${String((drag.target.minute / 60) * ROW + 1)}px`, height: `${String((BLOCK_MINUTES / 60) * ROW - 2)}px` }"
              aria-hidden="true"
            >
              <span class="font-mono text-ink">{{ clockOf(drag.target.minute) }}</span>
            </div>
            <!-- After a drop on a routine of more days: all its days, or only this one. -->
            <div
              v-if="choice !== null && choice.column === column"
              class="absolute z-30 flex w-[min(240px,90vw)] flex-col gap-1 rounded-lg border border-line-strong bg-surface p-2 text-[12.5px] shadow-lg"
              :class="column >= days.length - 2 && days.length > 2 ? 'right-1' : 'left-1'"
              :style="{ top: `${String(((choice.minute + BLOCK_MINUTES) / 60) * ROW + 2)}px` }"
              role="dialog"
              data-move-choice
              :aria-label="moveQuestion(choice)"
            >
              <span class="text-muted">{{ moveQuestion(choice) }}</span>
              <button type="button" class="btn justify-start px-2 py-0.5 text-[12.5px]" @click="chooseAll">{{ allDaysText(choice) }}</button>
              <button type="button" class="btn justify-start px-2 py-0.5 text-[12.5px]" @click="chooseOnly">{{ onlyDayText(choice.from, choice.to) }}</button>
              <button type="button" class="rounded-md px-2 py-0.5 text-left text-muted hover:text-ink" @click="choice = null">{{ UNDO_TEXT }}</button>
            </div>
            <!-- The line of the current hour. -->
            <div
              v-if="line !== null && line.column === column"
              class="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-danger"
              :style="{ top: `${String((line.minute / 60) * ROW)}px` }"
              aria-hidden="true"
            >
              <span class="absolute -top-[3px] -left-1 size-2 rounded-full bg-danger" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
      <span class="inline-flex items-center gap-1"><span class="size-2 rounded-full bg-ok" aria-hidden="true" />fatta</span>
      <span class="inline-flex items-center gap-1"><span class="size-2 rounded-full bg-warn" aria-hidden="true" />saltata</span>
      <span class="inline-flex items-center gap-1"><span class="size-2 rounded-full bg-danger" aria-hidden="true" />fallita</span>
      <span class="inline-flex items-center gap-1"><span class="inline-block h-2.5 w-4 rounded-sm border border-line-strong opacity-55" aria-hidden="true" />in pausa</span>
      <span class="inline-flex items-center gap-1"><span class="inline-block h-2.5 w-4 rounded-sm border border-dashed border-accent/70" aria-hidden="true" />proposta</span>
      <span>Ore in {{ viewZone }}.</span>
      <span class="md:hidden">{{ CALENDAR_HINT }}</span>
    </p>
    <div v-if="undo !== null" class="fixed bottom-16 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-ink px-3.5 py-2 text-[14px] text-bg" role="status">
      {{ undo.text }}
      <button type="button" class="font-semibold underline" @click="undoMove">{{ UNDO_TEXT }}</button>
    </div>
  </section>
</template>

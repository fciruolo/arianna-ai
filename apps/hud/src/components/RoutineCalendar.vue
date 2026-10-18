<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, loadRoutineCalendar } from '../lib/api.ts';
import {
  addDays,
  BLOCK_MINUTES,
  blockLook,
  blockText,
  CALENDAR_HINT,
  CALENDAR_LOAD_ERROR,
  dayHead,
  dayTitle,
  FIRST_VISIBLE_HOUR,
  formAt,
  HOURS,
  isoDayOf,
  layoutDay,
  nowIn,
  nowLine,
  stepAnchor,
  TODAY_TEXT,
  visibleDays,
  weekRange,
  weekTitle,
  type CalendarDay,
  type CalendarEntry,
  type CalendarWeek,
} from '../lib/routine-calendar.ts';
import type { Routine, RoutineForm } from '../lib/routines.ts';

/**
 * The view «Calendario» of the page «Routine» (D-257): the week Monday to
 * Sunday (one day on a phone), one row per hour, each time of a routine as a
 * block (paused: faint; proposed: dashed), the runs already written with their
 * outcome and the line of the current hour. The times come from the core,
 * computed with the zone of each routine; the titles from the list the page
 * already has. A click on a block opens the routine, on a free hour a new one
 * at that day and hour.
 */
const props = defineProps<{ routines: Routine[]; version: number }>();
const emit = defineEmits<{ edit: [routine: Routine]; create: [form: RoutineForm] }>();

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

const range = computed(() => weekRange(anchor.value));
const today = computed(() => nowIn(zone, now.value));
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
  void nextTick(scrollToStart);
}

function scrollToStart(): void {
  const element = scroller.value;
  if (element === null) return;
  const hour = line.value === null ? FIRST_VISIBLE_HOUR : Math.max(FIRST_VISIBLE_HOUR, Math.floor(line.value.minute / 60) - 2);
  element.scrollTop = Math.min(hour, 18) * ROW;
}

function open(entry: CalendarEntry): void {
  const routine = byId.value.get(entry.routineId);
  if (routine !== undefined) emit('edit', routine);
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

watch(() => range.value.from, () => void load());
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
  void load();
  void nextTick(scrollToStart);
});
onBeforeUnmount(() => {
  alive = false;
  clearInterval(clock);
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
      <span>Ore in {{ zone }}.</span>
      <span class="md:hidden">{{ CALENDAR_HINT }}</span>
    </p>
  </section>
</template>

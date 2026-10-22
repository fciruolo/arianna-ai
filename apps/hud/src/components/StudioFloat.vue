<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { followMedia, phoneMedia, phoneNow } from '../lib/studio-phone.ts';
import Icon from './Icon.vue';

/**
 * A window of the Studio that floats over the page (I-19, D-184): the
 * comments and the direct edit, moved by its title bar (the user's choice
 * after the first trial: a panel below or beside the canvas was out of
 * sight or in the way). The place is remembered in this browser only.
 * On the phone (D-293) a sheet at the bottom of the visible part of the
 * window instead, as wide as the screen and never dragged.
 */
const props = defineProps<{ title: string }>();

const STORE_KEY = 'arianna.studio.float';
const WIDTH = 340;
const MARGIN = 8;

const box = ref<HTMLElement | null>(null);
const place = ref({ x: 0, y: 0 });
const phone = ref(phoneNow());
let stopPhone: () => void = () => undefined;

function clamp(x: number, y: number): { x: number; y: number } {
  const width = box.value?.offsetWidth ?? WIDTH;
  const height = box.value?.offsetHeight ?? 200;
  return {
    x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - Math.min(height, 120) - MARGIN)),
  };
}

function remembered(): { x: number; y: number } | undefined {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return undefined;
    const { x, y } = value as Record<string, unknown>;
    return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  } catch {
    return undefined;
  }
}

function remember(): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(place.value));
  } catch {
    // Private window or storage off: the place is only for this visit.
  }
}

let drag: { pointer: number; dx: number; dy: number } | null = null;

function start(event: PointerEvent): void {
  if (phone.value) return;
  if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button') !== null)) return;
  drag = { pointer: event.pointerId, dx: event.clientX - place.value.x, dy: event.clientY - place.value.y };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function move(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointer) return;
  place.value = clamp(event.clientX - drag.dx, event.clientY - drag.dy);
}

function end(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointer) return;
  drag = null;
  remember();
}

function keep(): void {
  place.value = clamp(place.value.x, place.value.y);
}

onMounted(() => {
  // First time: top right, below the bars of the page.
  const start = remembered() ?? { x: window.innerWidth - WIDTH - 24, y: 140 };
  place.value = clamp(start.x, start.y);
  window.addEventListener('resize', keep);
  stopPhone = followMedia(phoneMedia(), (matches) => {
    phone.value = matches;
  });
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', keep);
  stopPhone();
});
</script>

<template>
  <section
    ref="box"
    class="fixed z-40 flex flex-col overflow-hidden border border-line-strong bg-surface shadow-lg"
    :class="
      phone
        ? 'inset-x-0 top-[calc(var(--vv-top,0px)+var(--vv-height,100dvh))] max-h-[min(65dvh,calc(var(--vv-height,100dvh)-var(--safe-top)-1rem))] -translate-y-full rounded-t-xl border-x-0 border-b-0 pb-[var(--safe-bottom)]'
        : 'max-h-[calc(100vh-16px)] rounded-xl'
    "
    :style="phone ? undefined : { left: `${place.x}px`, top: `${place.y}px`, width: `${WIDTH}px` }"
    :aria-label="props.title"
  >
    <header
      class="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-[13px] text-muted select-none"
      :class="{ 'cursor-move touch-none': !phone }"
      :title="phone ? undefined : 'Trascina per spostare'"
      @pointerdown="start"
      @pointermove="move"
      @pointerup="end"
      @pointercancel="end"
    >
      <Icon v-if="!phone" name="drag" :size="13" />
      <span class="flex-1">{{ props.title }}</span>
    </header>
    <div class="flex min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <slot />
    </div>
  </section>
</template>

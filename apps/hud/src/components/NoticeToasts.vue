<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';

import { NOTICE_ICON, NOTICE_TITLE, TOAST_KICKER, type Toast } from '../lib/notices.ts';
import Icon from './Icon.vue';

/**
 * The notices inside the chat (I-1, style A of docs/mockups/notifiche.html):
 * bottom right, the head of Arianna, a colour per kind, Apri and Dopo, and a
 * bar that empties in six seconds and closes the card; the mouse on a card,
 * or the keyboard focus in it, stops its bar.
 */
const props = defineProps<{ toasts: Toast[] }>();
const emit = defineEmits<{ open: [id: number]; dismiss: [id: number] }>();

const LIFE_MS = 6000;
const timers = new Map<number, { left: number; started: number; handle: ReturnType<typeof setTimeout> | undefined }>();

function run(id: number): void {
  const timer = timers.get(id);
  // Already running (a mouseleave without a mouseenter before it): one timeout only.
  if (timer === undefined || timer.handle !== undefined) return;
  timer.started = Date.now();
  timer.handle = setTimeout(() => {
    emit('dismiss', id);
  }, timer.left);
}

/** The focus left the card for somewhere outside it: the bar runs again. */
function blur(id: number, event: FocusEvent): void {
  const card = event.currentTarget as HTMLElement | null;
  if (card !== null && event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
  run(id);
}

function pause(id: number): void {
  const timer = timers.get(id);
  if (timer?.handle === undefined) return;
  clearTimeout(timer.handle);
  timer.handle = undefined;
  timer.left = Math.max(0, timer.left - (Date.now() - timer.started));
}

watch(
  () => props.toasts.map((toast) => toast.id),
  (ids) => {
    for (const id of ids) {
      if (timers.has(id)) continue;
      timers.set(id, { left: LIFE_MS, started: Date.now(), handle: undefined });
      run(id);
    }
    for (const [id, timer] of timers) {
      if (ids.includes(id)) continue;
      clearTimeout(timer.handle);
      timers.delete(id);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  for (const timer of timers.values()) clearTimeout(timer.handle);
});

const COLOUR = { reply: 'var(--accent)', approval: 'var(--warn)', failure: 'var(--danger)' } as const;
</script>

<template>
  <div class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2.5">
    <TransitionGroup name="toast">
      <article
        v-for="toast in toasts"
        :key="toast.id"
        role="status"
        :class="`toast-${toast.kind}`"
        class="toast pointer-events-auto relative flex gap-3 overflow-hidden rounded-[14px] border border-line-strong bg-surface py-3.5 pr-3.5 pl-3.5"
        :style="{ '--kind': COLOUR[toast.kind] }"
        @mouseenter="pause(toast.id)"
        @mouseleave="run(toast.id)"
        @focusin="pause(toast.id)"
        @focusout="blur(toast.id, $event)"
      >
        <img :src="NOTICE_ICON" alt="" width="48" height="48" class="toast-head size-12 flex-none rounded-[10px]" />
        <div class="min-w-0 flex-1">
          <p class="toast-kicker truncate font-hud text-[10.5px] leading-none font-semibold tracking-[0.16em] uppercase">
            {{ TOAST_KICKER[toast.kind] }}<template v-if="toast.title !== null"> · {{ toast.title }}</template>
          </p>
          <p class="mt-1.5 text-[14.5px] font-semibold">{{ NOTICE_TITLE[toast.kind] }}</p>
          <div class="mt-2.5 flex gap-1.5">
            <button type="button" class="toast-go btn" :aria-label="`Apri: ${TOAST_KICKER[toast.kind]}`" @click="emit('open', toast.id)">Apri</button>
            <button type="button" class="btn" :aria-label="`Dopo: ${TOAST_KICKER[toast.kind]}`" @click="emit('dismiss', toast.id)">Dopo</button>
          </div>
        </div>
        <button type="button" class="absolute top-2 right-2 rounded-md p-1 text-muted hover:bg-surface-2" aria-label="Chiudi" @click="emit('dismiss', toast.id)"><Icon name="close" :size="14" /></button>
        <span class="toast-timer" />
      </article>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast {
  border-left: 3px solid var(--kind);
  box-shadow: 0 18px 40px #00000059, 0 0 0 4px var(--glow);
}
.toast-head {
  image-rendering: pixelated;
}
.toast-kicker {
  color: var(--kind);
}
.toast-go {
  background: var(--kind);
  border-color: transparent;
  color: var(--accent-ink);
  font-weight: 600;
}
/* White on the light yellow is below AA: the approval button takes the dark ink. */
.toast-approval .toast-go {
  color: #111a18;
}
.toast-timer {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  width: 100%;
  background: var(--kind);
  transform-origin: left;
  animation: toast-drain 6s linear both;
}
.toast:hover .toast-timer,
.toast:focus-within .toast-timer {
  animation-play-state: paused;
}
@keyframes toast-drain {
  to {
    transform: scaleX(0);
  }
}
.toast-enter-active {
  transition: transform 0.38s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.38s;
}
.toast-leave-active {
  transition: transform 0.2s, opacity 0.2s;
}
.toast-enter-from {
  transform: translateY(24px) scale(0.96);
  opacity: 0;
}
.toast-leave-to {
  transform: translateX(24px);
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .toast-timer {
    animation: none;
  }
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>

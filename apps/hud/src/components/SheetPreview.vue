<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { FRAME_HEIGHT, FRAME_WIDTH, frameAt, sheetAnimations } from '../lib/sprites.ts';

/**
 * The animations of a character sheet (D-118), one at a time on a canvas at an
 * integer scale, and the whole sheet under it. `src` is the sheet served by
 * the core or the data: URL of a file not uploaded yet; nothing is drawn
 * until it loads.
 */
const props = withDefaults(defineProps<{ src: string; rows: 3 | 4; scale?: number }>(), { scale: 4 });

const animations = computed(() => sheetAnimations(props.rows));
const chosen = ref('walk-down');
const animation = computed(() => animations.value.find((item) => item.id === chosen.value) ?? animations.value[0]);
const canvas = ref<HTMLCanvasElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const failed = ref(false);
const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let request = 0;
let started = 0;

function draw(now: number): void {
  const context = canvas.value?.getContext('2d');
  const sheet = image.value;
  const current = animation.value;
  if (context === null || context === undefined || sheet === null || current === undefined) return;
  const { column, row } = frameAt(current, now - started, reduceMotion);
  context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  context.save();
  if (current.mirror) {
    context.translate(FRAME_WIDTH, 0);
    context.scale(-1, 1);
  }
  context.drawImage(sheet, column * FRAME_WIDTH, row * FRAME_HEIGHT, FRAME_WIDTH, FRAME_HEIGHT, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  context.restore();
  if (!reduceMotion) request = window.requestAnimationFrame(draw);
}

function restart(): void {
  window.cancelAnimationFrame(request);
  started = performance.now();
  if (image.value !== null) request = window.requestAnimationFrame(draw);
}

let generation = 0;
function load(src: string): void {
  generation += 1;
  const current = generation;
  window.cancelAnimationFrame(request);
  image.value = null;
  failed.value = false;
  const next = new Image();
  next.onload = () => {
    if (current !== generation) return;
    image.value = next;
    restart();
  };
  next.onerror = () => {
    if (current === generation) failed.value = true;
  };
  next.src = src;
}

watch(() => props.src, load, { immediate: true });
watch(chosen, restart);
watch(animations, (list) => {
  if (!list.some((item) => item.id === chosen.value)) chosen.value = 'walk-down';
});
onBeforeUnmount(() => {
  generation += 1;
  window.cancelAnimationFrame(request);
});
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <p v-if="failed" class="text-xs text-danger">Non riesco a leggere il foglio.</p>
    <div v-else class="flex flex-wrap items-start gap-3">
      <canvas
        ref="canvas"
        :width="FRAME_WIDTH"
        :height="FRAME_HEIGHT"
        class="pixelated block rounded-md border border-line bg-surface"
        :style="{ width: `${FRAME_WIDTH * scale}px`, height: `${FRAME_HEIGHT * scale}px` }"
        role="img"
        :aria-label="`Anteprima: ${animation?.label ?? ''}`"
      />
      <div class="flex min-w-0 flex-1 flex-wrap gap-1.5" role="radiogroup" aria-label="Animazione">
        <label
          v-for="item in animations"
          :key="item.id"
          class="cursor-pointer rounded-[9px] border px-2 py-0.5 text-xs has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
          :class="chosen === item.id ? 'border-accent bg-accent/15 text-ink' : 'border-line-strong text-muted hover:text-ink'"
        >
          <input v-model="chosen" type="radio" :value="item.id" class="sr-only" />{{ item.label }}
        </label>
      </div>
    </div>
    <img
      v-if="!failed"
      :src="src"
      alt="Il foglio intero: righe giù, su, destra e, se c’è, la riga di pensa, aspetta e pausa"
      class="pixelated max-w-full self-start rounded-md border border-line bg-surface"
      :style="{ width: `${112 * 2}px` }"
    />
  </div>
</template>

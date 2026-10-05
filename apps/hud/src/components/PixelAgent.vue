<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { sheetUrl } from '../lib/api.ts';
import { FRAME_HEIGHT, FRAME_WIDTH, frameAt, POSE_BUBBLE, poseFrames, type Pose } from '../lib/sprites.ts';
import type { CharacterChoice } from '../lib/types.ts';

/**
 * A pixel agent (D-060): one frame of a character sheet, drawn on a canvas at
 * an integer scale so the pixels stay sharp. The top rows of a frame are
 * empty in most sheets: they are left out.
 */
/** `src`: a sheet not saved yet (a data URL, D-123) in place of the one of `choice`. */
const props = withDefaults(defineProps<{ choice: CharacterChoice | undefined; pose: Pose; scale?: number; bubble?: boolean; label?: string | undefined; version?: number; src?: string | undefined }>(), {
  scale: 2,
  version: 0,
  bubble: false,
  label: undefined,
  src: undefined,
});

const CROP = 4;
const HEIGHT = FRAME_HEIGHT - CROP;
const canvas = ref<HTMLCanvasElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const failed = ref(false);
let frameRequest = 0;
let started = 0;
const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const frames = computed(() => poseFrames(props.pose, props.choice?.rows ?? 3));
const bubbleText = computed(() => (props.bubble ? POSE_BUBBLE[props.pose] : undefined));

function draw(now: number): void {
  const element = canvas.value;
  const sheet = image.value;
  const context = element?.getContext('2d');
  if (element === null || sheet === null || context === null || context === undefined) return;
  const { column, row } = frameAt(frames.value, now - started, reduceMotion);
  context.clearRect(0, 0, FRAME_WIDTH, HEIGHT);
  context.drawImage(sheet, column * FRAME_WIDTH, row * FRAME_HEIGHT + CROP, FRAME_WIDTH, HEIGHT, 0, 0, FRAME_WIDTH, HEIGHT);
}

function loop(now: number): void {
  draw(now);
  // One frame drawn is enough when nothing moves.
  if (!reduceMotion && frames.value.frames.length > 1) frameRequest = window.requestAnimationFrame(loop);
}

function restart(): void {
  window.cancelAnimationFrame(frameRequest);
  started = performance.now();
  // Without a sheet there is nothing to draw: the load starts the loop.
  if (image.value !== null) frameRequest = window.requestAnimationFrame(loop);
}

/** Counts the loads, so that a sheet arriving after another was asked for is dropped. */
let generation = 0;

function load(choice: CharacterChoice | undefined): void {
  generation += 1;
  const current = generation;
  window.cancelAnimationFrame(frameRequest);
  image.value = null;
  failed.value = false;
  if (choice === undefined) return;
  const next = new Image();
  next.onload = () => {
    if (current !== generation) return;
    image.value = next;
    restart();
  };
  next.onerror = () => {
    if (current === generation) failed.value = true;
  };
  next.src = props.src ?? sheetUrl(choice, props.version);
}

watch(() => props.src ?? (props.choice && sheetUrl(props.choice, props.version)), () => { load(props.choice); });
watch(() => props.pose, restart);
onMounted(() => {
  load(props.choice);
});
onBeforeUnmount(() => {
  window.cancelAnimationFrame(frameRequest);
});
</script>

<template>
  <span class="relative inline-grid place-items-end" :style="{ width: `${FRAME_WIDTH * scale}px`, height: `${HEIGHT * scale}px` }">
    <canvas
      v-show="!failed"
      ref="canvas"
      :width="FRAME_WIDTH"
      :height="HEIGHT"
      class="pixelated block"
      :class="pose === 'paused' ? 'opacity-60 grayscale' : ''"
      :style="{ width: `${FRAME_WIDTH * scale}px`, height: `${HEIGHT * scale}px` }"
      :role="label === undefined ? undefined : 'img'"
      :aria-label="label"
      :aria-hidden="label === undefined ? 'true' : undefined"
    />
    <span
      v-if="bubbleText !== undefined"
      class="absolute -top-1.5 -right-2 rounded-md border bg-surface px-1 py-0.5 font-mono text-[11px] leading-none font-semibold"
      :class="
        pose === 'waiting'
          ? 'animate-hud-blink border-warn text-warn'
          : pose === 'paused'
            ? 'border-line-strong text-muted'
            : 'border-line-strong text-accent'
      "
      aria-hidden="true"
    >{{ bubbleText }}</span>
  </span>
</template>

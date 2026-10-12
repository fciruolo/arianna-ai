<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { studioFrame } from '../lib/api.ts';

import { buildSrcdoc, highlightMessage, modeMessage, parseFrameMessage, type FrameRect } from '../lib/studio-frame.ts';

/**
 * A mockup in an isolated frame (I-19, D-184): the document built with the
 * policy that forbids the network, served back by the core under a token
 * with that policy in its headers too (a srcdoc frame would inherit the
 * chat's policy and block the mockup's inline scripts and styles), `sandbox="allow-scripts"` and never
 * `allow-same-origin` (opaque origin: the mockup reads nothing of the chat).
 * In the Studio the frame also carries the Studio's script: a message is
 * taken only from this frame's window and only with a fixed shape.
 */
const props = withDefaults(
  defineProps<{
    source: string;
    title: string;
    /** `studio` adds the script of the comments; `plain` shows the mockup only. */
    mode?: 'plain' | 'studio';
    comment?: boolean;
    highlight?: string | null;
  }>(),
  { mode: 'plain', comment: false, highlight: null },
);
const emit = defineEmits<{ pick: [pick: { selector: string; rect: FrameRect; tag: string; excerpt: string }] }>();

const frame = ref<HTMLIFrameElement | null>(null);
const src = ref<string | undefined>(undefined);
const failed = ref(false);
let asked = 0;
/** The url whose document said `ready`; the rebuilds since the last `ready`. */
let readyFor: string | undefined;
let rebuilds = 0;
let watchdog: number | undefined;
const REBUILDS_MAX = 2;

function build(): void {
  window.clearTimeout(watchdog);
  const ticket = ++asked;
  studioFrame(buildSrcdoc(props.source, props.mode)).then(
    (url) => {
      if (ticket !== asked) return;
      failed.value = false;
      src.value = url;
    },
    () => {
      if (ticket === asked) failed.value = true;
    },
  );
}

// A new document for every change of source or mode; an answer that arrives late is dropped.
watch(
  () => [props.source, props.mode] as const,
  () => {
    rebuilds = 0;
    build();
  },
  { immediate: true },
);

/**
 * The core keeps a frame for 10 minutes and at most 32 of them: a frame
 * that loads after (the mockup reloading itself, an evicted token) is the
 * core's 404. In the Studio the script says `ready` before `load`; without
 * it within 2 seconds the frame is built again, a few times at most.
 */
function onLoad(): void {
  const url = src.value;
  if (props.mode !== 'studio' || url === undefined) return;
  window.clearTimeout(watchdog);
  if (readyFor === url) return;
  watchdog = window.setTimeout(() => {
    if (src.value !== url || readyFor === url) return;
    if (rebuilds >= REBUILDS_MAX) {
      failed.value = true;
      return;
    }
    rebuilds += 1;
    build();
  }, 2_000);
}

function retry(): void {
  rebuilds = 0;
  build();
}

function send(message: unknown): void {
  // Opaque origin: '*' is the only target a sandboxed frame without allow-same-origin accepts.
  frame.value?.contentWindow?.postMessage(message, '*');
}

function sync(): void {
  if (props.mode !== 'studio') return;
  send(modeMessage(props.comment));
  send(highlightMessage(props.highlight));
}

function onMessage(event: MessageEvent): void {
  const own = frame.value?.contentWindow;
  if (own === null || own === undefined || event.source !== own) return;
  const message = parseFrameMessage(event.data);
  if (message === undefined) return;
  if (message.type === 'ready') {
    readyFor = src.value;
    rebuilds = 0;
    window.clearTimeout(watchdog);
    sync();
  }
  else if (props.comment) emit('pick', { selector: message.selector, rect: message.rect, tag: message.tag, excerpt: message.excerpt });
}

watch(() => [props.comment, props.highlight] as const, sync);

onMounted(() => {
  window.addEventListener('message', onMessage);
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  window.clearTimeout(watchdog);
});
</script>

<template>
  <p v-if="failed" class="flex flex-wrap items-center gap-2 p-4 text-sm text-[var(--muted)]">
    Non riesco a mostrare il mockup.
    <button type="button" class="btn px-2.5 py-1 text-xs" @click="retry">Riprova</button>
  </p>
  <iframe v-else ref="frame" class="block size-full border-0 bg-white" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="title" :src="src" @load="onLoad" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { buildSrcdoc, highlightMessage, modeMessage, parseFrameMessage, type FrameRect } from '../lib/studio-frame.ts';

/**
 * A mockup in an isolated frame (I-19, D-184): `srcdoc` with the policy that
 * forbids the network, `sandbox="allow-scripts"` and never
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
const srcdoc = computed(() => buildSrcdoc(props.source, props.mode));

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
  if (message.type === 'ready') sync();
  else if (props.comment) emit('pick', { selector: message.selector, rect: message.rect, tag: message.tag, excerpt: message.excerpt });
}

watch(() => [props.comment, props.highlight] as const, sync);

onMounted(() => {
  window.addEventListener('message', onMessage);
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
});
</script>

<template>
  <iframe ref="frame" class="block size-full border-0 bg-white" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="title" :srcdoc="srcdoc" />
</template>

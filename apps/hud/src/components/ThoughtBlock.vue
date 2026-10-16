<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { thoughtLineText } from '../lib/italian.ts';

/**
 * The thinking before an answer (D-249), as in Claude Code: while the model
 * thinks, its thinking scrolls in grey with the seconds going by; once the
 * answer starts it folds into «Ha ragionato per 12 s», which opens on a
 * click. With no text (a model that does not show its thinking) only the line.
 */
const props = defineProps<{
  text: string;
  /** Still thinking: the answer has not started. */
  live: boolean;
  /** How long it thought, once done. */
  ms?: number | null;
  /** When the thinking started, for the live seconds (ms since the epoch). */
  startedAt?: number | undefined;
}>();

const open = ref(false);
const now = ref(Date.now());
const box = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (!props.live) return;
  now.value = Date.now();
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}

onMounted(tick);
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});
watch(() => props.live, tick);
// The latest thinking stays in view while it scrolls in.
watch(
  () => props.text.length,
  async () => {
    if (!props.live) return;
    await nextTick();
    if (box.value !== null) box.value.scrollTop = box.value.scrollHeight;
  },
);

const trimmed = computed(() => props.text.trim());
const line = computed(() =>
  props.live ? thoughtLineText(props.startedAt === undefined ? null : now.value - props.startedAt, true) : thoughtLineText(props.ms, false),
);
</script>

<template>
  <div class="mb-2 flex flex-col gap-1 text-[13.5px] text-muted">
    <template v-if="live">
      <p class="font-mono text-[12.5px]" aria-live="polite"><span class="animate-hud-blink" aria-hidden="true">✻ </span>{{ line }}</p>
      <div v-if="trimmed !== ''" ref="box" class="max-h-40 overflow-y-auto border-l-2 border-line pl-3 break-words whitespace-pre-wrap italic">{{ trimmed }}</div>
    </template>
    <template v-else>
      <button
        v-if="trimmed !== ''"
        type="button"
        class="inline-flex items-center gap-1.5 self-start font-mono text-[12.5px] hover:text-info"
        :aria-expanded="open"
        title="Il ragionamento prima della risposta"
        @click="open = !open"
      >
        <span aria-hidden="true">{{ open ? '▾' : '▸' }}</span>{{ line }}
      </button>
      <p v-else class="font-mono text-[12.5px]" title="Il modello non mostra il suo ragionamento">✻ {{ line }}</p>
      <div v-if="open && trimmed !== ''" class="border-l-2 border-line pl-3 break-words whitespace-pre-wrap italic">{{ trimmed }}</div>
    </template>
  </div>
</template>

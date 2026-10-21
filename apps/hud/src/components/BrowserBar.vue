<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import { browserStatus, closeBrowser } from '../lib/api.ts';
import { BROWSER_POLL_MS } from '../lib/browser-screen.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

/**
 * The bar above the composer while the conversation holds Arianna's browser
 * (D-264, passo 4, prova dell'utente): «Browser aperto · <sito> · Guarda ·
 * Chiudi». The core says whether it is open (GET /api/browser/screen): read
 * when the conversation opens, at every new browser line or message, and
 * every 30 s while the bar shows. «Guarda» opens the Computer panel on the
 * «Browser» tab; «Chiudi» closes the browser, after the action under way.
 */
const props = defineProps<{
  conversationId: string;
  /** Changes with every new browser line or message (browserSignal). */
  signal: string;
  /** The newest browser line closed the browser: the bar goes at once. */
  closed: boolean;
}>();
const emit = defineEmits<{ watch: [site: string | undefined] }>();

const open = ref(false);
const site = ref<string | null>(null);
const closing = ref(false);
const problem = ref<string | null>(null);
/** Each read has its number: only the answer of the latest one counts. */
let read = 0;
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  const run = ++read;
  try {
    const status = await browserStatus(props.conversationId);
    if (run !== read) return;
    open.value = status.open;
    site.value = status.site;
  } catch {
    // A conversation that is gone or a core that does not answer: no bar.
    if (run === read) open.value = false;
  }
}

watch(
  () => props.conversationId,
  () => {
    open.value = false;
    site.value = null;
    problem.value = null;
    void refresh();
  },
  { immediate: true },
);
watch(
  () => props.signal,
  () => {
    if (props.closed) open.value = false;
    void refresh();
  },
);
watch(
  open,
  (shown) => {
    clearInterval(timer);
    timer = shown ? setInterval(() => void refresh(), BROWSER_POLL_MS) : undefined;
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));

async function closeIt(): Promise<void> {
  closing.value = true;
  problem.value = null;
  try {
    await closeBrowser(props.conversationId);
    read += 1;
    open.value = false;
  } catch (cause) {
    problem.value = errorText(cause);
  } finally {
    closing.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-[13px]">
    <Icon name="computer" :size="14" class="shrink-0 text-accent" />
    <span class="shrink-0 font-medium" role="status">Browser aperto</span>
    <template v-if="site !== null">
      <span class="text-muted" aria-hidden="true">·</span>
      <span class="min-w-0 flex-1 truncate text-muted" :title="site">{{ site }}</span>
    </template>
    <span v-else class="flex-1"></span>
    <span class="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12.5px] text-ink hover:bg-surface"
        title="Apri lo schermo del browser di Arianna, in sola visione"
        @click="emit('watch', site ?? undefined)"
      ><Icon name="fullscreen" :size="12" />Guarda</button>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12.5px] text-ink hover:bg-surface disabled:opacity-50"
        :disabled="closing"
        title="Chiude il browser di Arianna in questa conversazione, dopo l'azione in corso"
        @click="closeIt"
      ><Icon name="close" :size="12" />{{ closing ? 'Chiudo…' : 'Chiudi' }}</button>
    </span>
    <p v-if="problem !== null" class="w-full text-[12px] text-warn">{{ problem }}</p>
  </div>
</template>

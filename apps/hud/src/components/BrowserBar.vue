<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import { browserStatus, closeBrowser, returnBrowserControl } from '../lib/api.ts';
import { BROWSER_POLL_MS, CONTROL_POLL_MS } from '../lib/browser-screen.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

/**
 * The bar above the composer while the conversation holds Arianna's browser
 * (D-264, passo 4, prova dell'utente): «Browser aperto · <sito> · Guarda ·
 * Chiudi». The core says whether it is open (GET /api/browser/screen): read
 * when the conversation opens, at every new browser line or message, and
 * every 30 s while the bar shows. «Guarda» opens the Computer panel on the
 * «Browser» tab; «Chiudi» closes the browser, after the action under way.
 * Once the browser passed to the Private chat of an access (D-281) the bar
 * of the work conversation says so, with «Apri» towards that chat.
 */
const props = defineProps<{
  conversationId: string;
  /** Changes with every new browser line or message (browserSignal). */
  signal: string;
  /** The newest browser line closed the browser: the bar goes at once. */
  closed: boolean;
}>();
const emit = defineEmits<{ watch: [site: string | undefined]; open: [conversationId: string] }>();

const open = ref(false);
const site = ref<string | null>(null);
/** The Private chat the browser passed to after an access (D-281); null when none. */
const movedTo = ref<string | null>(null);
/** The user drives the browser from a screen (D-264, passo 5): «Stai guidando tu · Restituisci». */
const driving = ref(false);
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
    movedTo.value = status.movedTo;
    site.value = status.site;
    driving.value = status.control === 'user';
  } catch {
    // A conversation that is gone or a core that does not answer: no bar.
    if (run === read) {
      open.value = false;
      movedTo.value = null;
    }
  }
}

watch(
  () => props.conversationId,
  () => {
    open.value = false;
    movedTo.value = null;
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
// While the user drives, the site follows the clicks (D-286): read as often as the screen does.
watch(
  () => [open.value || movedTo.value !== null, driving.value] as const,
  ([shown, user]) => {
    clearInterval(timer);
    timer = shown ? setInterval(() => void refresh(), user ? CONTROL_POLL_MS : BROWSER_POLL_MS) : undefined;
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));

async function giveBack(): Promise<void> {
  problem.value = null;
  try {
    await returnBrowserControl(props.conversationId);
    driving.value = false;
    void refresh();
  } catch (cause) {
    problem.value = errorText(cause);
  }
}

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
  <div v-if="!open && movedTo !== null" class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-[13px]">
    <Icon name="private" :size="14" class="shrink-0 text-accent" />
    <span class="min-w-0 flex-1 font-medium" role="status">Il browser è passato alla chat Privata del tuo accesso</span>
    <button
      type="button"
      class="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12.5px] text-ink hover:bg-surface"
      title="Apri la chat Privata dove lavora solo il modello locale"
      @click="emit('open', movedTo)"
    >Apri</button>
  </div>
  <div v-else-if="open" class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-[13px]">
    <Icon name="computer" :size="14" class="shrink-0 text-accent" />
    <span class="shrink-0 font-medium" role="status">{{ driving ? 'Stai guidando tu' : 'Browser aperto' }}</span>
    <template v-if="site !== null">
      <span class="text-muted" aria-hidden="true">·</span>
      <span class="min-w-0 flex-1 truncate text-muted" :title="site">{{ site }}</span>
    </template>
    <span v-else class="flex-1"></span>
    <span class="flex shrink-0 items-center gap-1.5">
      <button
        v-if="driving"
        type="button"
        class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12.5px] text-ink hover:bg-surface"
        title="Il browser torna ad Arianna, che rilegge la pagina alla prossima richiesta"
        @click="giveBack"
      ><Icon name="approve" :size="12" />Restituisci</button>
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

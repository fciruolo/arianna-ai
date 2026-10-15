<script setup lang="ts">
/**
 * The lines of a person of the series (D-224), in its card: one list, the
 * real lines Claude collects with «Genera altre 100» (only the name of the
 * character and of the series leave, with the lines already kept) and those
 * the user writes by hand, numbered, each with «togli». At each answer
 * Arianna draws a few of them as examples of the voice; while the list is
 * empty the fixed ones of the repository stand in.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { addSeriesLine, generateSeriesLines, loadSeriesLines, removeSeriesLine, type SeriesLinesStatus } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';

const props = defineProps<{
  character: string;
  name: string;
  /** The user rewrote the catchphrases (D-223): theirs win over the list until «Ripristina». */
  ownQuotes: boolean;
  /** The fixed lines used while the list is empty. */
  fallback: readonly string[];
}>();

const status = ref<SeriesLinesStatus | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const draft = ref('');
let timer: number | undefined;
let mounted = false;

const lines = computed(() => status.value?.lines ?? []);
const full = computed(() => status.value !== null && lines.value.length >= status.value.max);

function schedule(): void {
  window.clearTimeout(timer);
  if (mounted && status.value?.running === true) timer = window.setTimeout(() => void refresh(), 3000);
}

async function refresh(): Promise<void> {
  try {
    status.value = await loadSeriesLines(props.character);
    error.value = null;
  } catch (cause) {
    error.value = `Non riesco a leggere le battute. ${errorText(cause)}`;
  }
  schedule();
}

async function act(work: () => Promise<SeriesLinesStatus>): Promise<boolean> {
  busy.value = true;
  try {
    status.value = await work();
    error.value = null;
    return true;
  } catch (cause) {
    error.value = errorText(cause);
    return false;
  } finally {
    busy.value = false;
    schedule();
  }
}

async function add(): Promise<void> {
  if (await act(() => addSeriesLine(props.character, draft.value))) draft.value = '';
}

onMounted(() => {
  mounted = true;
  void refresh();
});
onBeforeUnmount(() => {
  mounted = false;
  window.clearTimeout(timer);
});
watch(
  () => props.character,
  () => {
    status.value = null;
    void refresh();
  },
);
</script>

<template>
  <section class="flex flex-col gap-2 border-t border-line pt-3 text-[13px]" :aria-label="`Battute di ${name}`">
    <div class="flex flex-wrap items-center gap-2">
      <h4 class="mr-auto font-medium">
        Battute <span class="font-normal text-muted tabular-nums">{{ lines.length }}/{{ status?.max ?? 1000 }}</span>
      </h4>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy || status === null || status.running || full" @click="act(() => generateSeriesLines(character))">
        {{ status?.running ? 'Claude le sta cercando…' : lines.length === 0 ? 'Genera 100 battute vere' : 'Genera altre 100' }}
      </button>
    </div>
    <p class="text-[12px] text-muted">
      Frasi che {{ name }} dice davvero nella serie, raccolte da Claude (escono solo il nome del personaggio e della serie e le battute già in elenco), più quelle che scrivi tu. A ogni risposta Arianna ne pesca 5 a caso, non usate di recente in quella chat: il modello ne usa al massimo una. Quelle segnate «nomina altri» solo nelle chat private.
    </p>
    <p v-if="ownQuotes" class="text-[12.5px] text-warn">Tempo fa avevi riscritto le battute fisse: valgono ancora le tue, e l'elenco resta da parte finché non premi «Ripristina il testo originale».</p>
    <p v-if="status?.running" role="status" class="text-[12.5px] text-muted">Di solito ci vogliono uno o due minuti; puoi chiudere la pagina, la raccolta continua.</p>
    <p v-else-if="status?.stopped" role="alert" class="text-[12.5px] text-warn">Raccolta fermata: {{ status.stopped }}</p>
    <p v-else-if="status?.added !== null && status?.added !== undefined" role="status" class="text-[12.5px] text-ok">
      {{ status.added === 0 ? 'Nessuna battuta nuova: Claude non ne conosce altre.' : `Aggiunte ${String(status.added)} battute.` }}
    </p>
    <p v-if="error" role="alert" class="text-[12.5px] text-danger">{{ error }}</p>

    <div v-if="status !== null && lines.length === 0 && !ownQuotes" class="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
      Finché l'elenco è vuoto usa queste, scritte da noi nello stile del personaggio:
      <ul class="mt-1 list-disc pl-5">
        <li v-for="line in fallback" :key="line">{{ line }}</li>
      </ul>
    </div>

    <form class="flex gap-2" @submit.prevent="add">
      <input v-model="draft" type="text" maxlength="200" class="field min-w-0 flex-1 px-2.5 py-1.5 text-[13.5px]" :placeholder="`Una battuta di ${name}, scritta da te`" :aria-label="`Aggiungi una battuta di ${name}`" />
      <button type="submit" class="btn px-2.5 py-1 text-[13px]" :disabled="busy || draft.trim() === '' || full">Aggiungi</button>
    </form>

    <details v-if="lines.length > 0" open>
      <summary class="cursor-pointer select-none text-muted">Elenco numerato</summary>
      <ol class="mt-2 flex max-h-96 flex-col gap-1 overflow-y-auto pr-1">
        <li v-for="line in lines" :key="line.n" class="flex items-baseline gap-2 rounded-md px-1.5 py-0.5 hover:bg-surface-2">
          <span class="w-9 shrink-0 text-right text-[12px] text-muted tabular-nums">{{ line.n }}.</span>
          <span class="min-w-0 flex-1">
            {{ line.text }}
            <span v-if="line.episode" class="text-[12px] text-muted"> · {{ line.episode }}</span>
            <span v-if="line.own" class="pill ml-1 border-line-strong text-[11px] text-muted">tua</span>
            <span v-if="line.named" class="pill ml-1 border-line-strong text-[11px] text-muted">nomina altri</span>
          </span>
          <button type="button" class="shrink-0 text-[12px] text-muted hover:text-danger" :disabled="busy" :aria-label="`Togli la battuta ${String(line.n)}`" @click="act(() => removeSeriesLine(character, line.n))">togli</button>
        </li>
      </ol>
    </details>
  </section>
</template>

<script setup lang="ts">
/**
 * The archive of real lines of a person of the series (D-224), in its card:
 * «Genera altre 100» asks Claude for lines the character really says in the
 * series (only its name and the series' leave), a numbered list with «togli».
 * At each answer Arianna draws a few of them as examples of the voice.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { generateSeriesLines, loadSeriesLines, removeSeriesLine, type SeriesLinesStatus } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';

const props = defineProps<{
  character: string;
  name: string;
  /** The user rewrote the catchphrases (D-223): theirs win over the archive. */
  ownQuotes: boolean;
}>();

const status = ref<SeriesLinesStatus | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
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
    error.value = `Non riesco a leggere le citazioni. ${errorText(cause)}`;
  }
  schedule();
}

async function act(work: () => Promise<SeriesLinesStatus>): Promise<void> {
  busy.value = true;
  try {
    status.value = await work();
    error.value = null;
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    busy.value = false;
  }
  schedule();
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
  <section class="flex flex-col gap-2 border-t border-line pt-3 text-[13px]" :aria-label="`Citazioni vere di ${name}`">
    <div class="flex flex-wrap items-center gap-2">
      <h4 class="mr-auto font-medium">
        Citazioni vere <span class="font-normal text-muted tabular-nums">{{ lines.length }}/{{ status?.max ?? 1000 }}</span>
      </h4>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy || status === null || status.running || full" @click="act(() => generateSeriesLines(character))">
        {{ status?.running ? 'Claude le sta cercando…' : lines.length === 0 ? 'Genera 100 citazioni' : 'Genera altre 100' }}
      </button>
    </div>
    <p class="text-[12px] text-muted">
      Frasi che {{ name }} dice davvero nella serie, raccolte da Claude (esce solo il nome del personaggio e della serie). A ogni risposta Arianna ne pesca 5 a caso, non usate di recente in quella chat, come esempi della voce: il modello ne usa al massimo una. Quelle segnate «nomina altri» solo nelle chat private.
    </p>
    <p v-if="ownQuotes" class="text-[12.5px] text-warn">Hai riscritto le battute: valgono le tue, le citazioni restano da parte finché non ripristini il testo originale.</p>
    <p v-if="status?.running" role="status" class="text-[12.5px] text-muted">Di solito ci vogliono uno o due minuti; puoi chiudere la pagina, la raccolta continua.</p>
    <p v-else-if="status?.stopped" role="alert" class="text-[12.5px] text-warn">Raccolta fermata: {{ status.stopped }}</p>
    <p v-else-if="status?.added !== null && status?.added !== undefined" role="status" class="text-[12.5px] text-ok">
      {{ status.added === 0 ? 'Nessuna citazione nuova: Claude non ne conosce altre sicure.' : `Aggiunte ${String(status.added)} citazioni.` }}
    </p>
    <p v-if="error" role="alert" class="text-[12.5px] text-danger">{{ error }}</p>
    <details v-if="lines.length > 0">
      <summary class="cursor-pointer select-none text-muted">Mostra l'elenco</summary>
      <ol class="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto pr-1">
        <li v-for="line in lines" :key="line.n" class="flex items-baseline gap-2 rounded-md px-1.5 py-0.5 hover:bg-surface-2">
          <span class="w-9 shrink-0 text-right text-[12px] text-muted tabular-nums">{{ line.n }}.</span>
          <span class="min-w-0 flex-1">
            {{ line.text }}
            <span v-if="line.episode" class="text-[12px] text-muted"> · {{ line.episode }}</span>
            <span v-if="line.named" class="pill ml-1 border-line-strong text-[11px] text-muted">nomina altri</span>
          </span>
          <button type="button" class="shrink-0 text-[12px] text-muted hover:text-danger" :disabled="busy" :aria-label="`Togli la citazione ${String(line.n)}`" @click="act(() => removeSeriesLine(character, line.n))">togli</button>
        </li>
      </ol>
    </details>
  </section>
</template>

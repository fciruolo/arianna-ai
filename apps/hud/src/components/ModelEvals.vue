<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { cancelModelEval, listModelEvals, requestModelEval } from '../lib/api.ts';
import { errorText, MODEL_EVAL_STATUS_TEXT, modelEvalErrorText } from '../lib/italian.ts';
import { anyOpen, canTry, dateText, isOpen, latencyText, promotionHint, scoreText, type ModelEval } from '../lib/model-evals.ts';
import type { CatalogModel } from '../lib/settings.ts';

/**
 * "Prove dei modelli" (D-081): a catalog model suited to the orchestrator is
 * tried with the orchestrator evals in the background, without stopping the
 * model in use; calls and tasks go first. The history comes from the core,
 * refreshed every 10 s while a trial is open. Promotion is only suggested.
 */
const props = defineProps<{ catalog: CatalogModel[]; current: string | undefined }>();

const trials = ref<ModelEval[]>([]);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const busy = ref<string | null>(null);

const candidates = computed(() =>
  props.catalog
    .filter((model) => model.roles.includes('orchestrator'))
    .sort((a, b) => Number(b.id === props.current) - Number(a.id === props.current) || a.id.localeCompare(b.id)),
);

async function load(): Promise<void> {
  try {
    trials.value = await listModelEvals();
    loadError.value = null;
  } catch (error) {
    loadError.value = errorText(error);
  }
}

async function tryModel(id: string): Promise<void> {
  busy.value = id;
  actionError.value = null;
  try {
    await requestModelEval(id);
    await load();
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busy.value = null;
  }
}

async function cancel(id: string): Promise<void> {
  busy.value = id;
  actionError.value = null;
  try {
    await cancelModelEval(id);
    await load();
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busy.value = null;
  }
}

const STATUS_CLASS: Record<ModelEval['status'], string> = {
  queued: 'text-muted',
  running: 'text-warn',
  passed: 'text-ok',
  failed: 'text-danger',
  error: 'text-danger',
  cancelled: 'text-muted',
};

let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    if (anyOpen(trials.value)) void load();
  }, 10_000);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
});
</script>

<template>
  <section id="model-evals" class="hud-card scroll-mt-4" aria-labelledby="model-evals-title">
    <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <h2 id="model-evals-title" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] uppercase">Prove dei modelli</h2>
      <span class="rounded-[5px] border border-current px-1.5 py-1 font-mono text-[10px] leading-none tracking-[0.06em] text-muted">IN BACKGROUND</span>
    </header>
    <div class="flex min-w-0 flex-col gap-3 px-4 py-3.5">
      <p class="text-xs text-muted">
        Una prova fa girare i casi dell’orchestratore (<code class="font-mono">evals/orchestrator</code>, dati finti) sul modello scelto, senza cambiare quello in uso. Chiamate e
        task hanno la precedenza: la prova aspetta e rifà il caso interrotto. Il catalogo non viene mai modificato.
      </p>

      <ul class="flex flex-col">
        <li v-for="model in candidates" :key="model.id" class="flex flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="min-w-0 flex-1 font-mono text-[13px] break-all">{{ model.id }}</span>
            <span v-if="model.id === current" class="chip text-info">in uso</span>
            <span class="chip" :class="model.status === 'verified' ? 'text-ok' : 'text-warn'">{{ model.status === 'verified' ? 'verificato' : 'sperimentale' }}</span>
            <span v-if="!model.present" class="chip text-danger">file mancanti</span>
            <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="!canTry(trials, model) || busy !== null" @click="tryModel(model.id)">Prova</button>
          </div>
          <p v-if="promotionHint(trials, model.id, model.status)" class="text-xs text-ok">{{ promotionHint(trials, model.id, model.status) }}</p>
        </li>
        <li v-if="candidates.length === 0" class="text-xs text-muted">Nessun modello del catalogo per l’orchestratore.</li>
      </ul>

      <p v-if="actionError !== null" role="alert" class="text-xs text-danger">{{ actionError }}</p>
      <p v-if="loadError !== null" role="alert" class="text-xs text-danger">Non riesco a leggere le prove: {{ loadError }}</p>

      <div v-if="trials.length > 0" class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="hud-title text-left">
              <th class="pr-2 pb-2 font-semibold">Data</th>
              <th class="px-2 pb-2 font-semibold">Modello</th>
              <th class="px-2 pb-2 font-semibold">Esito</th>
              <th class="px-2 pb-2 font-semibold">Punteggio</th>
              <th class="px-2 pb-2 font-semibold">Mediana</th>
              <th class="pb-2 pl-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="trial in trials" :key="trial.id" class="border-t border-line align-top">
              <td class="py-2 pr-2 whitespace-nowrap">{{ dateText(trial.requestedAt) }}</td>
              <td class="px-2 py-2 font-mono text-xs break-all">{{ trial.modelId }}</td>
              <td class="px-2 py-2">
                <span :class="STATUS_CLASS[trial.status]">{{ MODEL_EVAL_STATUS_TEXT[trial.status] }}</span>
                <small v-if="modelEvalErrorText(trial.error) !== undefined" class="block text-[11.5px] text-muted">{{ modelEvalErrorText(trial.error) }}</small>
                <small v-if="trial.preemptions > 0" class="block text-[11.5px] text-muted">casi rifatti per dare precedenza: {{ trial.preemptions }}</small>
              </td>
              <td class="px-2 py-2 whitespace-nowrap">{{ scoreText(trial) }}</td>
              <td class="px-2 py-2 whitespace-nowrap">{{ latencyText(trial.latencyMedianMs) }}</td>
              <td class="py-2 pl-2 text-right">
                <button v-if="isOpen(trial)" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy !== null" @click="cancel(trial.id)">Annulla</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="loadError === null" class="text-xs text-muted">Nessuna prova finora.</p>
    </div>
  </section>
</template>

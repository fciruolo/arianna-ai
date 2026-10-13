<script setup lang="ts">
/**
 * Impostazioni → Modelli → «Confronto» (D-199, preview docs/mockups/confronto-modelli.html):
 * every trial of a role (D-081), of models still here or gone, with the five
 * measures and their thresholds, the speed and the memory; the model in use is
 * the reference. With 2-3 rows ticked: a verdict computed by code, bars side by
 * side with the threshold and the fake questions answered differently, in
 * closed words. Read from GET /api/model-comparison, all L0.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { loadComparisonCases, loadModelComparison, requestModelEval } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import {
  answerText,
  bestValues,
  capabilityText,
  comparable,
  DEFAULT_FILTER,
  historyLine,
  measureBars,
  measureOf,
  MEASURES,
  memoryText,
  modelLine,
  modelRows,
  percentText,
  pillsOf,
  relativeWidths,
  ROLE_LABEL,
  sameQuestions,
  secondsText,
  selectedTrials,
  shortDate,
  toggleSelected,
  tpsText,
  trialNote,
  verdict,
  type CaseComparison,
  type Column,
  type Comparison,
  type CompareFilter,
  type ComparisonTrial,
  type Pill,
} from '../lib/model-compare.ts';
import { isOpen } from '../lib/model-evals.ts';

const role = ref('orchestrator');
const comparison = ref<Comparison | null>(null);
const loadError = ref<string | null>(null);
async function load(): Promise<void> {
  try {
    comparison.value = await loadModelComparison(role.value);
    loadError.value = null;
  } catch (error) {
    loadError.value = errorText(error);
  }
}

const filter = ref<CompareFilter>({ ...DEFAULT_FILTER });
const rows = computed(() => modelRows(comparison.value, filter.value));
const best = computed(() => bestValues(rows.value));
const anyOpen = computed(() => (comparison.value?.trials ?? []).some(isOpen));
const missingSpeed = computed(() => rows.value.some((row) => comparable(row.main) && row.main.tokensPerSecond === null));

// The selection: 2-3 finished rows; a row that leaves the table leaves the selection.
const selected = ref<string[]>([]);
const chosen = computed(() => selectedTrials(rows.value, selected.value));
watch(rows, (now) => {
  const shown = new Set(now.map((row) => row.main.id));
  selected.value = selected.value.filter((id) => shown.has(id));
});
function toggle(id: string): void {
  selected.value = toggleSelected(selected.value, id);
}
const lines = computed(() => verdict(chosen.value));
const bars = computed(() => measureBars(chosen.value));
const speedWidths = computed(() => relativeWidths(chosen.value.map((trial) => trial.tokensPerSecond)));
const firstWidths = computed(() => relativeWidths(chosen.value.map((trial) => trial.firstTokenMs)));
const perCaseWidths = computed(() => relativeWidths(chosen.value.map((trial) => trial.caseMeanMs)));
const same = computed(() => sameQuestions(chosen.value));

// The questions answered differently, for trials on the same questions.
const cases = ref<CaseComparison | null>(null);
const casesError = ref<string | null>(null);
const allCases = ref(false);
const SHOWN_CASES = 10;
watch(
  () => (same.value ? chosen.value.map((trial) => trial.id).join(',') : ''),
  async (key) => {
    cases.value = null;
    casesError.value = null;
    allCases.value = false;
    if (key === '') return;
    try {
      const found = await loadComparisonCases(key.split(','));
      if (key === chosen.value.map((trial) => trial.id).join(',')) cases.value = found;
    } catch (error) {
      if (key === chosen.value.map((trial) => trial.id).join(',')) casesError.value = errorText(error);
    }
  },
);
const shownCases = computed(() => (cases.value === null ? [] : allCases.value ? cases.value.differing : cases.value.differing.slice(0, SHOWN_CASES)));

// «Prova di riferimento» and «Rifai la prova»: the usual path of the trials (D-081).
const busy = ref(false);
const requestError = ref<string | null>(null);
const reference = computed(() => comparison.value?.inUse ?? null);
const referenceOpen = computed(() => reference.value !== null && (comparison.value?.trials ?? []).some((trial) => trial.modelId === reference.value?.modelId && isOpen(trial)));
const canReference = computed(() => reference.value !== null && reference.value.inCatalog && reference.value.present && !referenceOpen.value && !busy.value);
function canRetry(trial: ComparisonTrial): boolean {
  return trial.inCatalog && trial.present && !(comparison.value?.trials ?? []).some((other) => other.modelId === trial.modelId && isOpen(other));
}
async function tryModel(modelId: string): Promise<void> {
  busy.value = true;
  requestError.value = null;
  try {
    await requestModelEval(modelId);
    await load();
    schedule();
  } catch (error) {
    requestError.value = errorText(error);
  } finally {
    busy.value = false;
  }
}

// While a trial is open the table is read again every 10 s.
let timer: number | undefined;
let unmounted = false;
function schedule(): void {
  window.clearTimeout(timer);
  if (unmounted || !anyOpen.value) return;
  timer = window.setTimeout(() => {
    void load().then(schedule);
  }, 10_000);
}
onMounted(() => {
  void load().then(schedule);
});
onBeforeUnmount(() => {
  unmounted = true;
  window.clearTimeout(timer);
});

const KEYS = ['bg-accent', 'bg-info', 'bg-warn'] as const;
const PILL: Record<Pill['kind'], string> = {
  use: 'border-accent/60 bg-accent/10 text-accent',
  gone: 'border-dashed',
  warn: 'border-warn/60 bg-warn/10 text-warn',
  plain: '',
};
function bold(column: Column, value: number | null): boolean {
  return value !== null && best.value[column] === value;
}
function rate(trial: ComparisonTrial): number | null {
  return trial.total === null || trial.passed === null || trial.total === 0 ? null : trial.passed / trial.total;
}
function scoreWidth(trial: ComparisonTrial): number {
  const value = comparable(trial) ? rate(trial) : trial.total === null || trial.total === 0 ? 0 : trial.done / trial.total;
  return Math.max(2, Math.round((value ?? 0) * 100));
}
function scoreLabel(trial: ComparisonTrial): string {
  if (trial.total === null) return '—';
  return `${String(trial.passed ?? 0)}/${String(trial.total)}`;
}
function keyOf(index: number): string {
  return KEYS[index] ?? 'bg-muted';
}

const th = 'border-b border-line-strong px-2 py-1.5 text-left align-bottom text-[12.5px] font-semibold whitespace-nowrap text-muted';
const td = 'border-b border-line px-2 py-2 align-top';
const card = 'flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface-2 p-4';
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <p v-if="loadError !== null" role="alert" class="rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      Il confronto non si legge: {{ loadError }}
      <button type="button" class="font-semibold text-accent hover:underline" @click="load">Riprova</button>
    </p>
    <p v-if="requestError !== null" role="alert" class="text-[13.5px] text-danger">{{ requestError }}</p>

    <template v-if="comparison !== null">
      <!-- Empty state -->
      <div v-if="comparison.trials.length === 0" :class="card">
        <h3 class="m-0 text-[16.5px] font-semibold">Nessuna prova finora</h3>
        <p class="m-0 text-muted">
          Una prova fa rispondere un modello a {{ comparison.questions }} domande finte (scegliere uno strumento, rifiutare un pagamento, fare un piano…) e misura quante ne azzecca e quanto è veloce. Inizia dal modello in uso, così gli
          altri hanno un termine di paragone.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <button v-if="reference !== null" type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="!canReference" @click="tryModel(reference.modelId)">Prova di riferimento: {{ reference.name }}</button>
          <span v-if="reference === null" class="text-[13.5px] text-muted">Nessun modello fa l’orchestratore in «Chi fa cosa»: sceglilo nella scheda «Elenco».</span>
          <span v-else-if="!reference.present" class="text-[13.5px] text-muted">I file del modello in uso non sono sul Mac.</span>
        </div>
      </div>

      <template v-else>
        <div :class="card">
          <div class="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[14px]">
            <label class="inline-flex items-center gap-1.5">
              Ruolo
              <select v-model="role" class="field px-2 py-1 text-[14px]" @change="load">
                <option v-for="(label, id) in ROLE_LABEL" :key="id" :value="id">{{ label }}</option>
              </select>
            </label>
            <label class="inline-flex items-center gap-1.5"><input v-model="filter.showGone" type="checkbox" /> Mostra i modelli cancellati</label>
            <label class="inline-flex items-center gap-1.5"><input v-model="filter.onlyCurrent" type="checkbox" /> Solo prove sulle domande di oggi</label>
            <span class="ml-auto text-[13px] text-muted">Le prove non si cancellano mai.</span>
            <button
              type="button"
              class="btn px-3 py-1 text-[13.5px]"
              :disabled="!canReference"
              :title="reference === null ? 'Nessun modello fa l’orchestratore' : referenceOpen ? 'Una prova del modello in uso è già in corso' : undefined"
              @click="reference !== null && tryModel(reference.modelId)"
            >
              Prova di riferimento
            </button>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-[14px]">
              <thead>
                <tr>
                  <th :class="th"><span class="sr-only">Confronta</span></th>
                  <th :class="th">Modello</th>
                  <th :class="th">Risposte giuste<small class="block font-normal">sulle domande della prova</small></th>
                  <th v-for="measure in MEASURES" :key="measure.name" :class="th" :title="measure.hint">
                    {{ measure.label }}<small class="block font-normal">soglia {{ percentText(rows.map((row) => measureOf(row.main, measure.name)?.threshold).find((value) => value !== undefined) ?? 0) }}</small>
                  </th>
                  <th :class="th">Velocità<small class="block font-normal">token al secondo</small></th>
                  <th :class="th">Prima parola<small class="block font-normal">attesa media</small></th>
                  <th :class="th">Per domanda<small class="block font-normal">tempo medio</small></th>
                  <th :class="th">Memoria</th>
                  <th :class="th">Data</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.modelId" :class="selected.includes(row.main.id) ? 'bg-accent/6' : ''">
                  <td :class="td">
                    <input
                      type="checkbox"
                      :checked="selected.includes(row.main.id)"
                      :disabled="!comparable(row.main) || (!selected.includes(row.main.id) && selected.length >= 3)"
                      :aria-label="`Confronta ${row.main.model.name}`"
                      @change="toggle(row.main.id)"
                    />
                  </td>
                  <td :class="td" class="min-w-[220px]">
                    <span class="font-semibold" :class="!row.main.inCatalog || !row.main.present ? 'text-muted' : ''">{{ row.main.model.name }}</span>
                    <span v-for="pill in pillsOf(row.main)" :key="pill.text" class="pill ml-1.5 px-2 py-0 text-[12px]" :class="PILL[pill.kind]">{{ pill.text }}</span>
                    <small v-if="modelLine(row.main.model) !== ''" class="block text-[12.5px] text-muted">{{ modelLine(row.main.model) }}</small>
                    <small v-else class="block font-mono text-[12px] text-muted">{{ row.main.modelId }}</small>
                    <span v-if="trialNote(row.main) !== null" class="block text-[13px]" :class="row.main.status === 'running' || row.main.status === 'queued' ? 'text-muted' : 'text-warn'">{{ trialNote(row.main) }}</span>
                    <details v-if="row.history.length > 0" class="mt-0.5 text-[12.5px] text-muted">
                      <summary class="cursor-pointer">{{ row.history.length + 1 }} prove</summary>
                      <ul class="m-0 mt-1 pl-3.5">
                        <li v-for="trial in row.history" :key="trial.id">{{ historyLine(trial) }}</li>
                      </ul>
                    </details>
                    <button v-if="canRetry(row.main) && !row.main.inUse" type="button" class="mt-1 block text-[12.5px] text-accent hover:underline disabled:opacity-50" :disabled="busy" @click="tryModel(row.main.modelId)">
                      Rifai la prova
                    </button>
                  </td>
                  <td :class="td">
                    <div class="flex min-w-[150px] items-center gap-2">
                      <div class="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-line"><i class="block h-full rounded-[3px] bg-accent" :style="{ width: `${scoreWidth(row.main)}%` }" /></div>
                      <span class="tabular-nums" :class="{ 'font-semibold': comparable(row.main) && bold('score', rate(row.main)) }">{{ scoreLabel(row.main) }}</span>
                    </div>
                  </td>
                  <td
                    v-for="measure in MEASURES"
                    :key="measure.name"
                    :class="td"
                    class="text-center whitespace-nowrap tabular-nums"
                  >
                    <template v-if="comparable(row.main) && measureOf(row.main, measure.name) !== null">
                      <span
                        :class="[(measureOf(row.main, measure.name)?.rate ?? 0) < (measureOf(row.main, measure.name)?.threshold ?? 0) ? 'text-danger' : 'text-ok', { 'font-semibold': bold(measure.name, measureOf(row.main, measure.name)?.rate ?? null) }]"
                        :title="(measureOf(row.main, measure.name)?.rate ?? 0) < (measureOf(row.main, measure.name)?.threshold ?? 0) ? `Sotto la soglia del ${percentText(measureOf(row.main, measure.name)?.threshold ?? 0)}` : undefined"
                        >{{ percentText(measureOf(row.main, measure.name)?.rate ?? 0) }}</span
                      >
                    </template>
                    <span v-else class="text-muted">—</span>
                  </td>
                  <td :class="td" class="text-right whitespace-nowrap tabular-nums">
                    <span :class="[comparable(row.main) && row.main.tokensPerSecond !== null ? '' : 'text-muted', { 'font-semibold': comparable(row.main) && bold('tps', row.main.tokensPerSecond) }]">{{ comparable(row.main) ? tpsText(row.main.tokensPerSecond) : '—' }}</span>
                  </td>
                  <td :class="td" class="text-right whitespace-nowrap tabular-nums">
                    <span :class="[comparable(row.main) && row.main.firstTokenMs !== null ? '' : 'text-muted', { 'font-semibold': comparable(row.main) && bold('first', row.main.firstTokenMs) }]">{{ comparable(row.main) ? secondsText(row.main.firstTokenMs) : '—' }}</span>
                  </td>
                  <td :class="td" class="text-right whitespace-nowrap tabular-nums">
                    <span :class="[comparable(row.main) && row.main.caseMeanMs !== null ? '' : 'text-muted', { 'font-semibold': comparable(row.main) && bold('perCase', row.main.caseMeanMs) }]">{{ comparable(row.main) ? secondsText(row.main.caseMeanMs) : '—' }}</span>
                  </td>
                  <td :class="td" class="text-right whitespace-nowrap tabular-nums">{{ memoryText(row.main.model.ramMinGib) }}</td>
                  <td :class="td" class="whitespace-nowrap tabular-nums">{{ shortDate(row.main.requestedAt) }}</td>
                </tr>
                <tr v-if="rows.length === 0">
                  <td :class="td" colspan="13" class="text-muted">Nessuna prova con questi filtri.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-muted">
            <span><span class="text-ok">verde</span>: sopra la soglia</span>
            <span><span class="text-danger">rosso</span>: sotto, il modello non va bene per quel ruolo</span>
            <span><strong>grassetto</strong>: il migliore della colonna</span>
            <span v-if="missingSpeed">Le prove fatte prima di questa versione non hanno la velocità: «—».</span>
          </div>
          <p v-if="chosen.length < 2" class="m-0 text-[13.5px] text-muted">Spunta da 2 a 3 righe per confrontarle.</p>
        </div>

        <!-- The comparison of 2-3 trials -->
        <div v-if="chosen.length >= 2" :class="card">
          <h3 class="m-0 text-[16.5px] font-semibold">Confronto di {{ chosen.length }} modelli</h3>
          <div class="flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-muted">
            <span v-for="(trial, index) in chosen" :key="trial.id"
              ><span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-[2px] align-[-1px]" :class="keyOf(index)" />{{ trial.model.name }}<template v-if="trial.inUse"> (riferimento)</template></span
            >
            <span>La linea scura sulle barre è la soglia.</span>
          </div>
          <div v-if="lines.length > 0" class="rounded-lg border-l-4 border-accent bg-surface px-3 py-2.5 text-[14.5px]">
            <p v-for="line in lines" :key="line.name" class="m-0 mb-1 last:mb-0"><strong>{{ line.name }}</strong> {{ line.text }}</p>
          </div>

          <div class="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
            <div v-for="metric in bars" :key="metric.name" class="flex flex-col gap-1.5">
              <h4 class="m-0 text-[14px] font-semibold">{{ metric.label }} <small class="font-normal text-muted">soglia {{ percentText(metric.threshold) }}</small></h4>
              <div v-for="(bar, index) in metric.bars" :key="chosen[index]?.id" class="grid grid-cols-[90px_1fr_56px] items-center gap-2 text-[13px] sm:grid-cols-[130px_1fr_80px]">
                <span class="truncate">{{ chosen[index]?.model.name }}</span>
                <span class="relative h-2.5 rounded-[3px] bg-line">
                  <i v-if="bar !== null" class="absolute inset-y-0 left-0 rounded-[3px]" :class="keyOf(index)" :style="{ width: `${Math.max(2, Math.round(bar.rate * 100))}%` }" />
                  <b class="absolute -top-[3px] -bottom-[3px] w-0.5 bg-ink opacity-55" :style="{ left: `${Math.round(metric.threshold * 100)}%` }" />
                </span>
                <span class="text-right tabular-nums" :class="bar?.below ? 'text-danger' : ''">{{ bar === null ? '—' : `${bar.passed}/${bar.total} · ${percentText(bar.rate)}` }}</span>
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <h4 class="m-0 text-[14px] font-semibold">Velocità <small class="font-normal text-muted">token al secondo, più è lunga meglio è</small></h4>
              <div v-for="(trial, index) in chosen" :key="trial.id" class="grid grid-cols-[90px_1fr_56px] items-center gap-2 text-[13px] sm:grid-cols-[130px_1fr_80px]">
                <span class="truncate">{{ trial.model.name }}</span>
                <span class="relative h-2.5 rounded-[3px] bg-line"><i v-if="speedWidths[index] != null" class="absolute inset-y-0 left-0 rounded-[3px]" :class="keyOf(index)" :style="{ width: `${speedWidths[index]}%` }" /></span>
                <span class="text-right tabular-nums">{{ tpsText(trial.tokensPerSecond) }}</span>
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <h4 class="m-0 text-[14px] font-semibold">Prima parola <small class="font-normal text-muted">attesa media, più è corta meglio è</small></h4>
              <div v-for="(trial, index) in chosen" :key="trial.id" class="grid grid-cols-[90px_1fr_56px] items-center gap-2 text-[13px] sm:grid-cols-[130px_1fr_80px]">
                <span class="truncate">{{ trial.model.name }}</span>
                <span class="relative h-2.5 rounded-[3px] bg-line"><i v-if="firstWidths[index] != null" class="absolute inset-y-0 left-0 rounded-[3px]" :class="keyOf(index)" :style="{ width: `${firstWidths[index]}%` }" /></span>
                <span class="text-right tabular-nums">{{ secondsText(trial.firstTokenMs) }}</span>
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <h4 class="m-0 text-[14px] font-semibold">Tempo per domanda <small class="font-normal text-muted">più è corta meglio è</small></h4>
              <div v-for="(trial, index) in chosen" :key="trial.id" class="grid grid-cols-[90px_1fr_56px] items-center gap-2 text-[13px] sm:grid-cols-[130px_1fr_80px]">
                <span class="truncate">{{ trial.model.name }}</span>
                <span class="relative h-2.5 rounded-[3px] bg-line"><i v-if="perCaseWidths[index] != null" class="absolute inset-y-0 left-0 rounded-[3px]" :class="keyOf(index)" :style="{ width: `${perCaseWidths[index]}%` }" /></span>
                <span class="text-right tabular-nums">{{ secondsText(trial.caseMeanMs) }}</span>
              </div>
            </div>
          </div>

          <template v-if="same">
            <h3 class="mt-1.5 mb-0 text-[16.5px] font-semibold">
              Domande con risposte diverse <span v-if="cases !== null" class="text-[14px] font-normal text-muted">{{ cases.differing.length }} su {{ cases.total }}</span>
            </h3>
            <p v-if="casesError !== null" role="alert" class="m-0 text-[13.5px] text-danger">{{ casesError }}</p>
            <p v-else-if="cases !== null && cases.differing.length === 0" class="m-0 text-[13.5px] text-muted">Tutti i modelli scelti rispondono giusto o sbagliato alle stesse domande.</p>
            <div v-else-if="cases !== null" class="overflow-x-auto">
              <table class="w-full border-collapse text-[13.5px]">
                <thead>
                  <tr>
                    <th :class="th">Domanda (finta)</th>
                    <th :class="th">Capacità</th>
                    <th v-for="(trial, index) in chosen" :key="trial.id" :class="th" class="text-center">
                      <span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-[2px] align-[-1px]" :class="keyOf(index)" />{{ trial.model.name }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in shownCases" :key="item.id">
                    <td :class="td" class="text-[13px]">
                      <template v-if="item.text !== null">«{{ item.text }}»<br /></template>
                      <span class="font-mono text-[12.5px] text-muted">{{ item.id }}</span>
                    </td>
                    <td :class="td">{{ capabilityText(item.capability) }}</td>
                    <td v-for="(result, index) in item.results" :key="index" :class="td" class="text-center whitespace-nowrap">
                      <span :class="answerText(result).ok === true ? 'text-ok' : answerText(result).ok === false ? 'text-danger' : 'text-muted'">{{ answerText(result).outcome }}</span>
                      <small v-if="answerText(result).detail !== null" class="block text-muted">{{ answerText(result).detail }}</small>
                    </td>
                  </tr>
                  <tr>
                    <td :colspan="chosen.length + 2" :class="td" class="text-[13px] text-muted">
                      <button v-if="!allCases && cases.differing.length > SHOWN_CASES" type="button" class="mr-1 font-semibold text-accent hover:underline" @click="allCases = true">
                        …altre {{ cases.differing.length - SHOWN_CASES }}.
                      </button>
                      Le domande sono quelle finte di <span class="font-mono">evals/orchestrator</span>: niente dati tuoi. Delle risposte dei modelli resta solo giusta o sbagliata, con il motivo in breve.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <p v-else class="m-0 text-[13.5px] text-warn">Le prove scelte sono su domande diverse: il confronto domanda per domanda non c’è, quello sopra è solo indicativo.</p>
          <p class="m-0 text-[13px] text-muted">
            Il confronto domanda per domanda c’è solo fra prove fatte sulle stesse domande. «Rifai la prova» manca sulle righe dei modelli cancellati: per riprovarli va riscaricato il modello.
          </p>
        </div>
      </template>
    </template>
    <p v-else-if="loadError === null" class="text-[14px] text-muted">Carico le prove…</p>
  </div>
</template>

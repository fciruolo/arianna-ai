<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { loadUsage } from '../lib/api.ts';
import { failureText } from '../lib/failures.ts';
import { agentTitle, errorText } from '../lib/italian.ts';
import {
  averageText,
  bytesText,
  countText,
  difficultyText,
  exitText,
  isEmpty,
  kindText,
  localityText,
  modelTitle,
  outcomeText,
  PERIODS,
  secondsText,
  sinceText,
  tokensText,
  type UsagePeriod,
  type UsageReport,
} from '../lib/usage.ts';
import LabelBadge from './LabelBadge.vue';

/**
 * «Consumi», a section of the settings (D-093, idea 10 of OpenWork): how
 * much Arianna worked in the period, per model and per kind of task, read
 * by the core from metadata only (GET /api/usage, L0). No title or text of
 * any task or conversation reaches this page.
 */
const period = ref<UsagePeriod>('7d');
const report = ref<UsageReport | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
let request = 0;

async function refresh(): Promise<void> {
  const mine = (request += 1);
  loading.value = true;
  try {
    const next = await loadUsage(period.value);
    if (mine !== request) return;
    report.value = next;
    loadError.value = null;
  } catch (cause) {
    if (mine !== request) return;
    loadError.value = `Non riesco a leggere i consumi. ${errorText(cause)}`;
  } finally {
    if (mine === request) loading.value = false;
  }
}

function choose(value: UsagePeriod): void {
  if (period.value === value) return;
  period.value = value;
  void refresh();
}

onMounted(() => {
  void refresh();
});

const empty = computed(() => report.value !== null && isEmpty(report.value));

const tiles = computed(() => {
  const totals = report.value?.totals;
  if (totals === undefined) return [];
  return [
    { key: 'runs', title: 'Lavori', value: countText(totals.runs), note: `${countText(totals.steps)} passi` },
    { key: 'time', title: 'Tempo di lavoro', value: secondsText(totals.seconds), note: 'somma dei lavori' },
    { key: 'delegations', title: 'Deleghe', value: countText(totals.delegations), note: 'passate a un agente' },
    { key: 'exits', title: 'Uscite verso il cloud', value: countText(totals.cloudExits), note: totals.blocked === 0 ? 'nessuna bloccata' : `${countText(totals.blocked)} bloccate dal gateway` },
    { key: 'failures', title: 'Fallimenti', value: countText(totals.failures), note: 'errori registrati' },
    { key: 'advice', title: 'Pareri di Claude', value: countText(totals.advice), note: 'sulla difficoltà' },
  ];
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2.5">
      <div class="inline-flex overflow-hidden rounded-[9px] border border-line-strong" role="group" aria-label="Periodo">
        <button
          v-for="item in PERIODS"
          :key="item.value"
          type="button"
          :aria-pressed="period === item.value"
          class="px-3 py-1 text-[14px]"
          :class="period === item.value ? 'bg-surface font-semibold text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
          @click="choose(item.value)"
        >
          {{ item.text }}
        </button>
      </div>
      <span v-if="report !== null" class="text-[13px] text-muted">{{ sinceText(report) }}</span>
      <span class="ml-auto flex items-center gap-1.5 text-[13px] text-muted"><LabelBadge label="L0" class="text-xs" />solo conteggi, nessun testo</span>
    </div>

    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ loadError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <p v-else-if="loading && report === null" class="text-[14px] text-muted">Leggo i consumi…</p>

    <template v-if="report !== null">
      <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3" :class="{ 'opacity-60': loading }" aria-live="polite">
        <div v-for="tile in tiles" :key="tile.key" class="min-w-0 rounded-xl border border-line bg-surface-2 px-3.5 py-3">
          <div class="text-[13px] text-muted">{{ tile.title }}</div>
          <div class="text-[22px] font-semibold text-ink tabular-nums">{{ tile.value }}</div>
          <div class="truncate text-[12.5px] text-muted">{{ tile.note }}</div>
        </div>
      </div>

      <p v-if="empty" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
        <b class="font-semibold text-ink">Niente in questo periodo.</b> Quando Arianna risponde in chat o un agente lavora su una scheda, qui compaiono i lavori per modello e per tipo.
      </p>

      <template v-else>
        <section v-if="report.models.length > 0" class="flex flex-col gap-2" aria-labelledby="usage-models">
          <h2 id="usage-models" class="text-[15px] font-semibold">Per modello</h2>
          <div class="overflow-x-auto rounded-xl border border-line">
            <table class="w-full min-w-[640px] border-collapse text-left text-[14px]">
              <thead class="bg-surface-2 text-[13px] text-muted">
                <tr>
                  <th scope="col" class="px-3 py-2 font-medium">Modello</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">Lavori</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">Passi</th>
                  <th scope="col" class="px-3 py-2 font-medium">Esito</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">Deleghe</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">Tempo medio</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium" title="Token in entrata → in uscita, quando l’esecutore li dice">Token</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in report.models" :key="`${row.executor}/${row.model ?? ''}/${row.locality}`" class="border-t border-line">
                  <th scope="row" class="px-3 py-2 font-normal">
                    {{ modelTitle(row) }}
                    <span class="ml-1 text-[12.5px] text-muted">{{ localityText(row.locality) }}</span>
                  </th>
                  <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.runs) }}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.steps) }}</td>
                  <td class="px-3 py-2 text-[13.5px]" :class="row.failed > 0 ? 'text-danger' : 'text-muted'">{{ row.runs === 0 ? '—' : outcomeText(row) }}</td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ countText(row.delegations) }}<span v-if="row.delegationsFailed > 0" class="text-danger"> ({{ countText(row.delegationsFailed) }} fallite)</span>
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">{{ averageText(row) }}</td>
                  <td class="px-3 py-2 text-right tabular-nums text-muted">{{ tokensText(row) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="grid gap-4 lg:grid-cols-2">
          <section v-if="report.kinds.length > 0" class="flex flex-col gap-2" aria-labelledby="usage-kinds">
            <h2 id="usage-kinds" class="text-[15px] font-semibold">Per tipo di compito</h2>
            <div class="overflow-x-auto rounded-xl border border-line">
              <table class="w-full border-collapse text-left text-[14px]">
                <thead class="bg-surface-2 text-[13px] text-muted">
                  <tr>
                    <th scope="col" class="px-3 py-2 font-medium">Tipo</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Lavori</th>
                    <th scope="col" class="px-3 py-2 font-medium">Esito</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Tempo</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in report.kinds" :key="row.kind" class="border-t border-line">
                    <th scope="row" class="px-3 py-2 font-normal">{{ kindText(row.kind) }}</th>
                    <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.runs) }}</td>
                    <td class="px-3 py-2 text-[13.5px]" :class="row.failed > 0 ? 'text-danger' : 'text-muted'">{{ outcomeText(row) }}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{{ secondsText(row.seconds) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-if="report.agents.length > 0" class="flex flex-col gap-2" aria-labelledby="usage-agents">
            <h2 id="usage-agents" class="text-[15px] font-semibold">Per agente</h2>
            <div class="overflow-x-auto rounded-xl border border-line">
              <table class="w-full border-collapse text-left text-[14px]">
                <thead class="bg-surface-2 text-[13px] text-muted">
                  <tr>
                    <th scope="col" class="px-3 py-2 font-medium">Agente</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Lavori</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Passi</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Tempo</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in report.agents" :key="row.agent" class="border-t border-line">
                    <th scope="row" class="px-3 py-2 font-normal">{{ agentTitle(row.agent) }}</th>
                    <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.runs) }}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.steps) }}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{{ secondsText(row.seconds) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-if="report.difficulties.length > 0" class="flex flex-col gap-2" aria-labelledby="usage-difficulties">
            <h2 id="usage-difficulties" class="text-[15px] font-semibold">Scelte del router per difficoltà</h2>
            <div class="overflow-x-auto rounded-xl border border-line">
              <table class="w-full border-collapse text-left text-[14px]">
                <thead class="bg-surface-2 text-[13px] text-muted">
                  <tr>
                    <th scope="col" class="px-3 py-2 font-medium">Difficoltà</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Sul Mac</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Cloud</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium" title="Il router ha aspettato: quota finita, da riprovare o in attesa di te">Attese</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in report.difficulties" :key="row.difficulty" class="border-t border-line">
                    <th scope="row" class="px-3 py-2 font-normal">{{ difficultyText(row.difficulty) }}</th>
                    <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.local) }}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.cloud) }}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.waits) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-if="report.exits.length > 0" class="flex flex-col gap-2" aria-labelledby="usage-exits">
            <h2 id="usage-exits" class="text-[15px] font-semibold">Decisioni del gateway</h2>
            <div class="overflow-x-auto rounded-xl border border-line">
              <table class="w-full border-collapse text-left text-[14px]">
                <thead class="bg-surface-2 text-[13px] text-muted">
                  <tr>
                    <th scope="col" class="px-3 py-2 font-medium">Verso</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Passate</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Bloccate</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">Dati</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in report.exits" :key="`${row.targetKind}/${row.target}/${row.locality}`" class="border-t border-line">
                    <th scope="row" class="px-3 py-2 font-normal">
                      {{ exitText(row) }}
                      <span class="ml-1 text-[12.5px] text-muted">{{ localityText(row.locality) }}</span>
                    </th>
                    <td class="px-3 py-2 text-right tabular-nums">{{ countText(row.allowed) }}</td>
                    <td class="px-3 py-2 text-right tabular-nums" :class="{ 'text-warn': row.blocked > 0 }">{{ countText(row.blocked) }}</td>
                    <td class="px-3 py-2 text-right tabular-nums text-muted">{{ bytesText(row.bytes) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-if="report.failures.length > 0" class="flex flex-col gap-2" aria-labelledby="usage-failures">
            <h2 id="usage-failures" class="text-[15px] font-semibold">Fallimenti per causa</h2>
            <ul class="flex flex-col divide-y divide-line rounded-xl border border-line text-[14px]">
              <li v-for="row in report.failures" :key="row.code" class="flex items-baseline gap-3 px-3 py-2">
                <span class="min-w-0 flex-1">{{ failureText({ code: row.code, details: {} }).title }}</span>
                <span class="tabular-nums text-danger">{{ countText(row.count) }}</span>
              </li>
            </ul>
          </section>
        </div>
      </template>
    </template>
  </div>
</template>

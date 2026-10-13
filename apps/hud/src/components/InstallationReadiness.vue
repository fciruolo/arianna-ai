<script setup lang="ts">
/**
 * «Pronta per i dati veri» (D-192), under the facts of the installation: the
 * last outcome when the page opens, a new check only on «Controlla di nuovo»
 * (some checks take seconds). What is missing comes first, in plain words.
 */
import { computed, onMounted, ref } from 'vue';

import { checkReadiness, loadReadiness } from '../lib/api.ts';
import { missingText, readinessRows, whenText, type ReadinessReport } from '../lib/installation.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

/** undefined while the first answer is awaited. */
const report = ref<ReadinessReport | null | undefined>(undefined);
const busy = ref(false);
const error = ref<string | null>(null);

const rows = computed(() => (report.value == null ? null : readinessRows(report.value)));

async function load(): Promise<void> {
  try {
    report.value = await loadReadiness();
    error.value = null;
  } catch (cause) {
    report.value = null;
    error.value = errorText(cause);
  }
}

async function check(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    report.value = await checkReadiness();
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="mt-1 flex flex-col gap-2.5 border-t border-line pt-3">
    <div class="flex flex-wrap items-center gap-2.5">
      <b class="text-[15px] font-semibold">Pronta per i dati veri</b>
      <template v-if="busy">
        <span class="inline-block size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent motion-reduce:animate-none" role="status" aria-label="Controllo in corso"></span>
        <span class="text-[13px] text-muted">Controllo in corso: qualche secondo…</span>
      </template>
      <template v-else-if="report != null">
        <span class="pill" :class="report.ready ? 'text-ok border-ok/50' : 'text-warn border-warn/55'">{{ report.ready ? 'Sì' : 'Non ancora' }}</span>
        <span class="text-[13px] text-muted">controllata {{ whenText(report.checkedAt) }}</span>
      </template>
      <span v-else-if="report === null" class="pill">Non controllata</span>
      <button type="button" class="btn ml-auto px-3 py-1.5 text-[14px]" :disabled="busy || report === undefined" @click="check">
        <Icon name="retry" :size="15" />{{ report == null ? 'Controlla' : 'Controlla di nuovo' }}
      </button>
    </div>

    <p v-if="error !== null" class="flex items-start gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <Icon name="warning" :size="16" class="mt-0.5 shrink-0 text-danger" /><span>{{ error }}</span>
    </p>

    <p v-if="busy" class="m-0 text-[13px] text-muted">Guardo password, database, cartelle, modelli e programmi. Nessun dato esce dal Mac.<template v-if="report != null"> L’esito precedente resta qui sotto finché il nuovo non arriva.</template></p>
    <p v-else-if="report === null && error === null" class="m-0 text-[13px] text-muted">Arianna non ha ancora fatto il controllo da quando è partita. Ci vogliono pochi secondi; nessun dato esce dal Mac.</p>

    <template v-if="report != null && rows !== null">
      <p v-if="report.ready" class="flex items-start gap-2.5 rounded-[10px] border border-ok/50 bg-ok/9 px-3 py-2.5 text-[14px]">
        <Icon name="approve" :size="16" class="mt-0.5 shrink-0 text-ok" /><span>Tutti i controlli sono a posto: puoi mettere i tuoi documenti veri in Arianna.</span>
      </p>
      <template v-else>
        <p class="flex items-start gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2.5 text-[14px]">
          <Icon name="warning" :size="16" class="mt-0.5 shrink-0 text-warn" /><span>{{ missingText(rows.missing.length) }}. Finché mancano, usa solo dati finti: i tuoi documenti veri non sarebbero protetti come devono.</span>
        </p>
        <ul class="m-0 list-none overflow-hidden rounded-[10px] border border-line p-0">
          <li v-for="row in rows.missing" :key="row.key" class="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 border-t border-line bg-surface px-3 py-2 first:border-t-0">
            <Icon :name="row.tone === 'terminal' ? 'code' : 'warning'" :size="17" class="row-span-2 mt-0.5" :class="row.tone === 'terminal' ? 'text-info' : 'text-warn'" />
            <b class="text-[14.5px] font-semibold">{{ row.title }}</b>
            <span class="text-[13.5px] text-muted">{{ row.text }}</span>
          </li>
        </ul>
      </template>
      <details v-if="rows.passed.length > 0">
        <summary class="cursor-pointer text-[14px] text-muted">{{ report.ready ? `Vedi i ${String(rows.passed.length)} controlli` : `Vedi i controlli a posto (${String(rows.passed.length)})` }}</summary>
        <ul class="m-0 mt-2 list-none overflow-hidden rounded-[10px] border border-line p-0">
          <li v-for="row in rows.passed" :key="row.key" class="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 border-t border-line bg-surface px-3 py-2 first:border-t-0">
            <Icon name="approve" :size="17" class="row-span-2 mt-0.5 text-ok" />
            <b class="text-[14.5px] font-semibold">{{ row.title }}</b>
            <span class="text-[13.5px] text-muted">{{ row.text }}</span>
          </li>
        </ul>
      </details>
    </template>
  </div>
</template>

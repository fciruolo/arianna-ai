<script setup lang="ts">
/**
 * Impostazioni → Modelli, «Parere di Claude sulla difficoltà» (D-207): what
 * the router's advisor does, today's opinions against the cap, and the path
 * of the status file of the user's usage bar app, from which the core reads
 * only the weekly share of Claude and its reset.
 */
import { onMounted, ref } from 'vue';

import { loadAdvisor, saveAdvisor, type AdvisorStatus } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';

const status = ref<AdvisorStatus | null>(null);
const path = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const saved = ref(false);

async function load(): Promise<void> {
  try {
    status.value = await loadAdvisor();
    path.value = status.value.usageFile ?? '';
    error.value = null;
  } catch (failure) {
    error.value = errorText(failure);
  }
}

async function save(): Promise<void> {
  busy.value = true;
  saved.value = false;
  try {
    status.value = await saveAdvisor(path.value.trim());
    path.value = status.value.usageFile ?? '';
    error.value = null;
    saved.value = true;
  } catch (failure) {
    error.value = errorText(failure);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void load();
});

const card = 'min-w-0 rounded-xl border border-line bg-surface-2 p-4';
</script>

<template>
  <section :class="card" aria-labelledby="models-advisor">
    <h2 id="models-advisor" class="mb-1 text-[16px] font-semibold">Parere di Claude sulla difficoltà</h2>
    <p class="mb-3 text-[14px] text-muted">
      Quando le regole non bastano a dire quanto è difficile un lavoro per Claude o Codex, Arianna chiede a Claude Sonnet una parola sola (banale, normale, difficile,
      critico) e sposta la scelta del modello di un gradino al più. Esce il testo della richiesta solo se è Pubblico o Interno; per i Privati e i Segreti decidono le
      regole. Al più {{ status?.dailyCap ?? 50 }} pareri al giorno, nessuno quando hai usato più del {{ status?.weekLimit ?? 90 }}% della quota settimanale di Claude.
    </p>
    <p v-if="status !== null" class="mb-3 text-[14px]">
      Oggi: {{ status.today }} di {{ status.dailyCap }} pareri.
      <template v-if="status.weekPercent !== null">Settimana di Claude: {{ status.weekPercent }}%{{ status.weekPercent > status.weekLimit ? ', pareri sospesi fino al reset' : '' }}.</template>
      <template v-else-if="status.usageFile !== null">Il file non dice la settimana (manca, non si legge o è vecchio di oltre un’ora): vale solo il tetto del giorno.</template>
      <template v-else>Senza il file vale solo il tetto del giorno.</template>
    </p>
    <form class="grid gap-1" @submit.prevent="save">
      <label for="models-advisor-file" class="text-[14px] font-medium">File di stato della barra dei consumi</label>
      <div class="flex flex-wrap gap-2">
        <input
          id="models-advisor-file"
          v-model="path"
          class="field min-w-0 flex-1 px-2.5 py-1.5 font-mono text-[13px]"
          placeholder="…/Library/Application Support/AIUsageBar/status.json"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit" class="btn px-3 py-1.5 text-[14px]" :disabled="busy">{{ busy ? 'Salvo…' : 'Salva' }}</button>
      </div>
      <span class="text-[12.5px] text-muted">Percorso intero. Arianna legge solo la percentuale e il reset della settimana di Claude; il file resta dov’è. Vuoto: lo toglie.</span>
      <span v-if="saved && error === null" role="status" class="text-[13px] text-accent">Salvato.</span>
      <span v-if="error !== null" role="alert" class="text-[13px] text-danger">{{ error }}</span>
    </form>
  </section>
</template>

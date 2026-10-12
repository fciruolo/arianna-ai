<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { readFinanceAlerts } from '../lib/api.ts';
import { alertFilter, alertText, dayOf, financeErrorText, formatMonth, monthOfDay, nameLookup, type Account, type Category, type FinanceAlert, type TxFilter } from '../lib/finance.ts';
import Icon from './Icon.vue';

/**
 * "Avvisi" of the finances (I-18, D-183): the checks of a month computed by
 * the core (recurring charges whose amount changed, unusual expenses,
 * possible double charges, budgets). The core sends kinds and numbers; the
 * sentences are composed here. A click opens the movements involved.
 */
const props = defineProps<{ accounts: Account[]; categories: Category[] }>();
const emit = defineEmits<{ open: [filter: TxFilter] }>();

const month = ref(monthOfDay(dayOf(new Date())));
const alerts = ref<FinanceAlert[] | null>(null);
const problem = ref<string | null>(null);

async function load(): Promise<void> {
  alerts.value = null;
  try {
    alerts.value = await readFinanceAlerts(month.value);
    problem.value = null;
  } catch (cause) {
    problem.value = financeErrorText(cause);
  }
}
watch(month, () => {
  if (/^\d{4}-\d{2}$/.test(month.value)) void load();
}, { immediate: true });

const names = computed(() => nameLookup(props.accounts, props.categories));
const shown = computed(() => (alerts.value ?? []).map((alert) => ({ alert, text: alertText(alert, names.value) })));
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-3">
    <div class="flex flex-wrap items-end gap-3">
      <label class="flex flex-col gap-1 text-xs text-muted">
        Mese
        <input v-model="month" type="month" class="field px-2 py-1 text-[14px]" />
      </label>
      <p class="pb-1.5 text-xs text-muted">Controlli fatti dal codice su questo computer, mai da un modello cloud.</p>
    </div>

    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-else-if="alerts === null" class="text-sm text-muted">Controllo {{ formatMonth(month, true) }}…</p>
    <p v-else-if="shown.length === 0" class="rounded-xl border border-line bg-surface p-4 text-sm">Nessun avviso per {{ formatMonth(month, true) }}: nessun addebito cambiato, nessuna spesa insolita, nessun doppio addebito, budget nei limiti.</p>
    <ul v-else class="grid gap-2">
      <li v-for="(item, index) in shown" :key="index">
        <button
          type="button"
          class="flex w-full items-start gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left hover:border-line-strong"
          :class="item.text.tone === 'danger' ? 'border-danger/50' : 'border-warn/50'"
          @click="emit('open', alertFilter(item.alert))"
        >
          <span class="mt-0.5" :class="item.text.tone === 'danger' ? 'text-danger' : 'text-warn'"><Icon name="warning" :size="16" /></span>
          <span class="min-w-0 flex-1">
            <b class="block text-[14.5px] font-medium">{{ item.text.title }}</b>
            <span class="block text-[13px] text-muted">{{ item.text.detail }}</span>
          </span>
          <span class="shrink-0 self-center text-xs text-muted">Vedi i movimenti</span>
        </button>
      </li>
    </ul>
  </div>
</template>

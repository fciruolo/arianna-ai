<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { listFinanceAccounts, listFinanceCategories } from '../lib/api.ts';
import { EMPTY_FILTER, FINANCE_TABS, financeErrorText, type Account, type Category, type FinanceTab, type TxFilter } from '../lib/finance.ts';
import FinanceAccounts from './FinanceAccounts.vue';
import FinanceAlerts from './FinanceAlerts.vue';
import FinanceCategories from './FinanceCategories.vue';
import FinanceImport from './FinanceImport.vue';
import FinanceSummary from './FinanceSummary.vue';
import FinanceTransactions from './FinanceTransactions.vue';
import Icon from './Icon.vue';

/**
 * The page "Finanze" (I-18, D-183): accounts, imports of bank statements,
 * movements, categories with rules and budgets, the summary in charts and the
 * checks of the month. Everything stays between this page and the core of
 * this Mac (rule `finance` of the gateway): the notice at the top says so on
 * every tab.
 */
const props = defineProps<{ tab: FinanceTab | undefined }>();
const emit = defineEmits<{ tab: [tab: FinanceTab | undefined] }>();

const shown = computed<FinanceTab>(() => props.tab ?? 'riepilogo');

const accounts = ref<Account[] | null>(null);
const categories = ref<Category[]>([]);
const problem = ref<string | null>(null);
/** The filters "Movimenti" opens with, set by a check of "Avvisi". */
const filter = ref<TxFilter>({ ...EMPTY_FILTER });
const filterVersion = ref(0);

async function loadAccounts(): Promise<void> {
  try {
    accounts.value = await listFinanceAccounts();
    problem.value = null;
  } catch (cause) {
    problem.value = financeErrorText(cause);
  }
}

async function loadCategories(): Promise<void> {
  try {
    categories.value = await listFinanceCategories();
  } catch {
    // The accounts say what is wrong; the categories stay as they were.
  }
}

function reload(): void {
  void loadAccounts();
  void loadCategories();
}

onMounted(reload);

function openMovements(next: TxFilter): void {
  filter.value = next;
  filterVersion.value += 1;
  emit('tab', 'movimenti');
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col" aria-label="Finanze">
    <div class="flex shrink-0 flex-col gap-2 border-b border-line px-4 pt-3 md:px-6">
      <p class="flex items-center gap-2 text-[13px] text-muted" role="note">
        <Icon name="private" :size="13" />
        Questi dati restano su questo computer: nessun modello cloud li legge.
      </p>
      <nav class="-mb-px flex gap-1 overflow-x-auto" aria-label="Sezioni delle Finanze">
        <button
          v-for="[slug, text] in FINANCE_TABS"
          :key="slug"
          type="button"
          class="shrink-0 border-b-2 px-3 py-2 text-[14px]"
          :class="shown === slug ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'"
          :aria-current="shown === slug ? 'page' : undefined"
          @click="emit('tab', slug === 'riepilogo' ? undefined : slug)"
        >
          {{ text }}
        </button>
      </nav>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4 md:px-6">
      <div v-if="problem !== null" class="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-sm" role="alert">
        <span class="flex-1">{{ problem }}</span>
        <button type="button" class="btn px-2.5 py-1 text-xs" @click="reload"><Icon name="retry" :size="13" />Riprova</button>
      </div>
      <p v-else-if="accounts === null" class="text-sm text-muted">Carico le Finanze…</p>
      <template v-else>
        <FinanceSummary v-if="shown === 'riepilogo'" :accounts="accounts" :categories="categories" @tab="emit('tab', $event)" />
        <FinanceTransactions v-else-if="shown === 'movimenti'" :key="filterVersion" :accounts="accounts" :categories="categories" :filter="filter" />
        <FinanceImport v-else-if="shown === 'importa'" :accounts="accounts" @changed="loadAccounts" @tab="emit('tab', $event)" />
        <FinanceAccounts v-else-if="shown === 'conti'" :accounts="accounts" @changed="loadAccounts" />
        <FinanceCategories v-else-if="shown === 'categorie'" :categories="categories" @changed="loadCategories" />
        <FinanceAlerts v-else-if="shown === 'avvisi'" :accounts="accounts" :categories="categories" @open="openMovements" />
      </template>
    </div>
  </section>
</template>

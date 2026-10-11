<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';

import { listFinanceTransactions, setTransactionCategory } from '../lib/api.ts';
import { amountClass, filterQuery, financeErrorText, formatCents, formatDay, nameLookup, type Account, type Category, type Tx, type TxFilter } from '../lib/finance.ts';
import Icon from './Icon.vue';

/**
 * "Movimenti" of the finances (I-18, D-183): the table with its filters, the
 * newest first, and the category of each row, chosen by hand; with "crea una
 * regola" the core also makes the rule for the next rows of the same merchant.
 */
const props = defineProps<{ accounts: Account[]; categories: Category[]; filter: TxFilter }>();

const PAGE = 100;

const filter = reactive<TxFilter>({ ...props.filter });
const rows = ref<Tx[] | null>(null);
const total = ref(0);
const problem = ref<string | null>(null);
const notice = ref<string | null>(null);
const loading = ref(false);
/** The rows whose "crea una regola" is ticked. */
const ruleFor = reactive<Record<string, boolean>>({});
const saving = ref<string | null>(null);

const names = computed(() => nameLookup(props.accounts, props.categories));
const outCategories = computed(() => props.categories.filter((category) => category.kind === 'out'));
const inCategories = computed(() => props.categories.filter((category) => category.kind === 'in'));
const showAccount = computed(() => filter.account === '' && props.accounts.length > 1);
const filtered = computed(() => filter.account !== '' || filter.from !== '' || filter.to !== '' || filter.category !== '' || filter.uncategorized || filter.q.trim() !== '');

async function load(append = false): Promise<void> {
  loading.value = true;
  try {
    const page = await listFinanceTransactions(filterQuery(filter, PAGE, append ? (rows.value?.length ?? 0) : 0));
    rows.value = append ? [...(rows.value ?? []), ...page.transactions] : page.transactions;
    total.value = page.total;
    problem.value = null;
  } catch (cause) {
    problem.value = financeErrorText(cause);
  } finally {
    loading.value = false;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => ({ ...filter }),
  (now, before) => {
    clearTimeout(timer);
    // The search waits for a pause in the typing; the other filters apply at once.
    timer = setTimeout(() => void load(), now.q !== before.q ? 300 : 0);
  },
);
onBeforeUnmount(() => clearTimeout(timer));
void load();

function clearFilters(): void {
  Object.assign(filter, { account: '', from: '', to: '', category: '', uncategorized: false, q: '' });
}

async function choose(row: Tx, value: string): Promise<void> {
  const category = value === '' ? null : value;
  const rule = category !== null && ruleFor[row.id] === true;
  saving.value = row.id;
  notice.value = null;
  try {
    const answer = await setTransactionCategory(row.id, category, rule);
    rows.value = (rows.value ?? []).map((item) => (item.id === row.id ? answer.transaction : item));
    ruleFor[row.id] = false;
    problem.value = null;
    if (answer.rule !== null) {
      notice.value = `Regola creata: le descrizioni con «${answer.rule.match}» vanno in ${names.value.category(answer.rule.category)}.`;
      // The rule may have given a category to other rows too.
      await load();
    }
  } catch (cause) {
    problem.value = financeErrorText(cause);
  } finally {
    saving.value = null;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1 text-xs text-muted">
        Conto
        <select v-model="filter.account" class="field px-2 py-1.5 text-[13px]">
          <option value="">Tutti i conti</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}{{ account.archived ? ' (archiviato)' : '' }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Dal
        <input v-model="filter.from" type="date" class="field px-2 py-1 text-[13px]" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Al
        <input v-model="filter.to" type="date" class="field px-2 py-1 text-[13px]" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Categoria
        <select v-model="filter.category" class="field px-2 py-1.5 text-[13px]" :disabled="filter.uncategorized">
          <option value="">Tutte</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option>
        </select>
      </label>
      <label class="flex items-center gap-1.5 pb-2 text-xs text-muted">
        <input v-model="filter.uncategorized" type="checkbox" />
        Senza categoria
      </label>
      <label class="flex h-[34px] min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-muted sm:max-w-xs">
        <Icon name="search" :size="14" />
        <input v-model="filter.q" type="search" class="w-full bg-transparent text-[13px] text-ink outline-none" placeholder="Cerca nella descrizione" aria-label="Cerca nella descrizione" />
      </label>
      <button v-if="filtered" type="button" class="rounded-md px-2 py-1.5 text-xs text-muted hover:text-ink" @click="clearFilters">Togli i filtri</button>
    </div>

    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-if="notice" class="rounded-lg border border-ok/50 bg-ok/10 px-3 py-2 text-sm" role="status">{{ notice }}</p>
    <p v-if="rows === null && problem === null" class="text-sm text-muted">Carico i movimenti…</p>
    <p v-else-if="rows !== null && rows.length === 0" class="text-sm text-muted">{{ filtered ? 'Nessun movimento con questi filtri.' : 'Ancora nessun movimento: importa un estratto conto.' }}</p>

    <template v-if="rows !== null && rows.length > 0">
      <p class="text-xs text-muted">{{ total === 1 ? '1 movimento' : `${total.toLocaleString('it-IT')} movimenti` }}, dal più recente</p>
      <div class="overflow-x-auto rounded-xl border border-line">
        <table class="w-full min-w-[720px] text-left text-[13px]">
          <thead class="bg-surface-2 text-xs text-muted">
            <tr>
              <th class="px-3 py-2 font-medium">Data</th>
              <th v-if="showAccount" class="px-3 py-2 font-medium">Conto</th>
              <th class="px-3 py-2 font-medium">Descrizione</th>
              <th class="px-3 py-2 font-medium">Categoria</th>
              <th class="px-3 py-2 text-right font-medium">Importo</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id" class="border-t border-line align-top">
              <td class="px-3 py-2 whitespace-nowrap">
                {{ formatDay(row.booked) }}
                <span v-if="row.value && row.value !== row.booked" class="block text-[11px] text-muted">valuta {{ formatDay(row.value) }}</span>
              </td>
              <td v-if="showAccount" class="px-3 py-2 text-muted">{{ names.account(row.account) }}</td>
              <td class="px-3 py-2 break-words">{{ row.description }}</td>
              <td class="px-3 py-2">
                <div class="flex flex-col gap-1">
                  <select class="field max-w-[200px] px-2 py-1 text-[12.5px]" :value="row.category ?? ''" :disabled="saving === row.id" :aria-label="`Categoria del movimento del ${formatDay(row.booked)}`" @change="choose(row, ($event.target as HTMLSelectElement).value)">
                    <option value="">Senza categoria</option>
                    <optgroup v-if="outCategories.length > 0" label="Uscite">
                      <option v-for="category in outCategories" :key="category.id" :value="category.id">{{ category.name }}</option>
                    </optgroup>
                    <optgroup v-if="inCategories.length > 0" label="Entrate">
                      <option v-for="category in inCategories" :key="category.id" :value="category.id">{{ category.name }}</option>
                    </optgroup>
                  </select>
                  <span class="flex items-center gap-2 text-[11px] text-muted">
                    <label class="flex items-center gap-1" title="Con la prossima scelta, crea anche una regola per gli altri movimenti dello stesso esercente">
                      <input v-model="ruleFor[row.id]" type="checkbox" />
                      crea una regola
                    </label>
                    <span v-if="row.by === 'rule'">· da una regola</span>
                    <span v-else-if="row.by === 'user'">· scelta a mano</span>
                  </span>
                </div>
              </td>
              <td class="px-3 py-2 text-right whitespace-nowrap tabular-nums" :class="amountClass(row.amount)">{{ formatCents(row.amount, { currency: row.currency }) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button v-if="rows.length < total" type="button" class="btn self-start px-3 py-1.5 text-[13px]" :disabled="loading" @click="load(true)">Mostra altri {{ Math.min(100, total - rows.length) }}</button>
    </template>
  </div>
</template>

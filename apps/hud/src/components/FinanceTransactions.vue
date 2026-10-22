<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { listFinanceTransactions, setTransactionCategory } from '../lib/api.ts';
import { readableDescription } from '../lib/finance-dashboard.ts';
import { foldedFilterCount } from '../lib/tab-strip.ts';
import { amountClass, EMPTY_FILTER, filterQuery, financeErrorText, formatCents, formatDay, nameLookup, type Account, type Category, type Tx, type TxFilter } from '../lib/finance.ts';
import Icon from './Icon.vue';

/**
 * "Movimenti" of the finances (I-18, D-183): the table with its filters, the
 * newest first, and the category of each row, chosen by hand; with "crea una
 * regola" the core also makes the rule for the next rows of the same merchant.
 * Low rows (D-189): the description of the bank made readable, the account in
 * its second line, the category as a pill that opens a menu whose last item is
 * the rule.
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
/** On a phone the filters fold under one button (D-293); the search stays in view. */
const filtersOpen = ref(false);
const foldedCount = computed(() => foldedFilterCount(filter));
const filtered = computed(() => filter.fingerprints.length > 0 || filter.account !== '' || filter.from !== '' || filter.to !== '' || filter.category !== '' || filter.uncategorized || filter.q.trim() !== '');

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
  Object.assign(filter, { ...EMPTY_FILTER });
}

/** The row whose category menu is open. */
const openFor = ref<string | null>(null);
function closeMenu(event: PointerEvent): void {
  if (openFor.value === null) return;
  const target = event.target as Element | null;
  if (target?.closest('[data-category-picker]') == null) openFor.value = null;
}
onMounted(() => document.addEventListener('pointerdown', closeMenu));
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeMenu));

/** Back on the pill of the row after the menu closes, so the keyboard does not land on the page. */
function focusPill(id: string): void {
  document.querySelector<HTMLElement>(`[data-category-pill="${CSS.escape(id)}"]`)?.focus();
}

function closeWithEsc(row: Tx): void {
  openFor.value = null;
  focusPill(row.id);
}

async function pick(row: Tx, value: string): Promise<void> {
  openFor.value = null;
  focusPill(row.id);
  // The same category again does nothing, unless "crea una regola" is ticked: then it makes the rule.
  if (value === (row.category ?? '') && ruleFor[row.id] !== true) return;
  await choose(row, value);
}

/** Each description made readable once per list, not once per use in the row. */
const readable = computed(() => new Map((rows.value ?? []).map((row) => [row.id, readableDescription(row.description)])));
function readableOf(row: Tx): { title: string; detail: string } {
  return readable.value.get(row.id) ?? { title: row.description, detail: '' };
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
      <button type="button" class="btn px-3 py-1.5 text-[14px] md:hidden" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen">
        <Icon name="sort" :size="14" />Filtri<template v-if="foldedCount > 0"> · {{ foldedCount }}</template>
      </button>
      <div class="contents" :class="filtersOpen ? '' : 'max-md:hidden'">
      <label class="flex flex-col gap-1 text-xs text-muted">
        Conto
        <select v-model="filter.account" class="field touch:min-h-11 px-2 py-1.5 text-[14px]">
          <option value="">Tutti i conti</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}{{ account.archived ? ' (archiviato)' : '' }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Dal
        <input v-model="filter.from" type="date" class="field touch:min-h-11 px-2 py-1 text-[14px]" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Al
        <input v-model="filter.to" type="date" class="field touch:min-h-11 px-2 py-1 text-[14px]" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Categoria
        <select v-model="filter.category" class="field touch:min-h-11 px-2 py-1.5 text-[14px]" :disabled="filter.uncategorized">
          <option value="">Tutte</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option>
        </select>
      </label>
      <label class="flex items-center gap-1.5 pb-2 text-xs text-muted touch:min-h-11 touch:pb-0">
        <input v-model="filter.uncategorized" type="checkbox" />
        Senza categoria
      </label>
      </div>
      <label class="flex h-[34px] min-w-[180px] flex-1 touch:h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-muted sm:max-w-xs">
        <Icon name="search" :size="14" />
        <input v-model="filter.q" type="search" class="w-full bg-transparent text-[14px] text-ink outline-none" placeholder="Cerca nella descrizione" aria-label="Cerca nella descrizione" />
      </label>
      <button v-if="filtered" type="button" class="rounded-md px-2 py-1.5 text-xs text-muted hover:text-ink touch:min-h-11" @click="clearFilters">Togli i filtri</button>
    </div>

    <p v-if="filter.fingerprints.length > 0" class="flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm" role="status">
      <Icon name="warning" :size="14" />
      <span class="flex-1">Solo i movimenti dell’avviso scelto.</span>
      <button type="button" class="btn px-2.5 py-1 text-xs" @click="filter.fingerprints = []">Mostra tutti</button>
    </p>
    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-if="notice" class="rounded-lg border border-ok/50 bg-ok/10 px-3 py-2 text-sm" role="status">{{ notice }}</p>
    <p v-if="rows === null && problem === null" class="text-sm text-muted">Carico i movimenti…</p>
    <p v-else-if="rows !== null && rows.length === 0" class="text-sm text-muted">{{ filtered ? 'Nessun movimento con questi filtri.' : 'Ancora nessun movimento: importa un estratto conto.' }}</p>

    <template v-if="rows !== null && rows.length > 0">
      <p class="text-xs text-muted">{{ total === 1 ? '1 movimento' : `${total.toLocaleString('it-IT')} movimenti` }}, dal più recente</p>
      <!-- On a phone each movement is a card (D-293): date and amount, then description and category. -->
      <div class="rounded-xl border border-line bg-surface-2">
        <table class="w-full min-w-[640px] text-left text-[14px] max-md:block max-md:min-w-0">
          <thead class="text-xs text-muted max-md:hidden">
            <tr class="border-b border-line-strong">
              <th class="w-[108px] px-3 py-2 font-medium">Data</th>
              <th class="px-3 py-2 font-medium">Descrizione</th>
              <th class="w-[220px] px-3 py-2 font-medium">Categoria</th>
              <th class="w-[130px] px-3 py-2 text-right font-medium">Importo</th>
            </tr>
          </thead>
          <tbody class="max-md:block">
            <tr v-for="row in rows" :key="row.id" class="border-t border-line align-middle first:border-t-0 hover:bg-surface max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:px-3 max-md:py-2.5">
              <td class="px-3 py-1.5 whitespace-nowrap text-muted tabular-nums max-md:order-1 max-md:p-0 max-md:text-xs">
                {{ formatDay(row.booked) }}
                <span v-if="row.value && row.value !== row.booked" class="block text-xs">valuta {{ formatDay(row.value) }}</span>
              </td>
              <td class="px-3 py-1.5 max-md:order-3 max-md:col-span-2 max-md:p-0" :title="row.description">
                <span class="block font-medium break-words">{{ readableOf(row).title }}</span>
                <span v-if="readableOf(row).detail !== '' || showAccount" class="block text-xs text-muted">
                  {{ [readableOf(row).detail, showAccount ? names.account(row.account) : ''].filter((part) => part !== '').join(' · ') }}
                </span>
              </td>
              <td class="px-3 py-1.5 max-md:order-4 max-md:col-span-2 max-md:p-0">
                <div class="relative" data-category-picker>
                <button
                  type="button"
                  class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[13.5px] whitespace-nowrap hover:border-accent touch:min-h-11 touch:px-3.5"
                  :class="row.category === null ? 'border-dashed border-line-strong text-muted' : 'border-line-strong bg-surface'"
                  :disabled="saving === row.id"
                  :data-category-pill="row.id"
                  aria-haspopup="dialog"
                  :aria-expanded="openFor === row.id"
                  :aria-label="`Categoria del movimento del ${formatDay(row.booked)}: ${names.category(row.category)}`"
                  @click="openFor = openFor === row.id ? null : row.id"
                  @keydown.esc="openFor = null"
                >
                  <span class="truncate">{{ names.category(row.category) }}</span>
                  <span v-if="row.by === 'rule'" class="text-xs text-muted" title="Messa da una regola">regola</span>
                  <span v-else-if="row.by === 'user'" class="sr-only">scelta a mano</span>
                  <Icon name="sort-down" :size="12" />
                </button>
                <div
                  v-if="openFor === row.id"
                  class="absolute top-full left-0 z-20 mt-1 flex w-64 max-w-[calc(100vw-3rem)] flex-col rounded-xl border border-line-strong bg-surface-2 p-1.5 shadow-lg"
                  role="dialog"
                  :aria-label="`Scegli la categoria del movimento del ${formatDay(row.booked)}`"
                  @keydown.esc="closeWithEsc(row)"
                >
                  <div class="flex max-h-64 flex-col overflow-y-auto">
                    <button type="button" class="rounded-md px-2 py-1 text-left text-[14px] text-muted hover:bg-bg touch:min-h-11" :class="row.category === null ? 'font-semibold' : ''" :aria-current="row.category === null ? 'true' : undefined" @click="pick(row, '')">Senza categoria</button>
                    <template v-for="group in ([['Uscite', outCategories], ['Entrate', inCategories]] as const)" :key="group[0]">
                      <p v-if="group[1].length > 0" class="px-2 pt-1.5 pb-0.5 text-xs text-muted">{{ group[0] }}</p>
                      <button
                        v-for="category in group[1]"
                        :key="category.id"
                        type="button"
                        class="rounded-md px-2 py-1 text-left text-[14px] hover:bg-bg touch:min-h-11"
                        :class="row.category === category.id ? 'font-semibold text-accent' : ''"
                        :aria-current="row.category === category.id ? 'true' : undefined"
                        @click="pick(row, category.id)"
                      >{{ category.name }}</button>
                    </template>
                  </div>
                  <label class="mt-1 flex items-start gap-2 border-t border-line px-2 pt-2 pb-1 text-[13px] text-muted" title="Con la scelta, crea anche una regola per gli altri movimenti dello stesso esercente">
                    <input v-model="ruleFor[row.id]" type="checkbox" class="mt-0.5" />
                    <span>Crea una regola: anche i prossimi movimenti di questo esercente</span>
                  </label>
                </div>
                </div>
              </td>
              <td class="px-3 py-1.5 text-right whitespace-nowrap tabular-nums max-md:order-2 max-md:p-0 max-md:font-medium" :class="amountClass(row.amount)">{{ formatCents(row.amount, { currency: row.currency, sign: row.amount > 0 }) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button v-if="rows.length < total" type="button" class="btn self-start px-3 py-1.5 text-[14px]" :disabled="loading" @click="load(true)">Mostra altri {{ Math.min(100, total - rows.length) }}</button>
    </template>
  </div>
</template>

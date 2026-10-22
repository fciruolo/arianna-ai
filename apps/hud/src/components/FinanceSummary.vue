<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { listFinanceBudgets, listFinanceTransactions, readFinanceAlerts, readFinanceSummary } from '../lib/api.ts';
import { balanceLine, categoryBars, monthBars, sampleLabels, ticks, type Frame } from '../lib/finance-charts.ts';
import { balanceText, budgetRows, latestMonths, monthChangeText, readableDescription, type BudgetRow } from '../lib/finance-dashboard.ts';
import {
  alertFilter,
  alertText,
  amountClass,
  changeText,
  dayOf,
  EMPTY_FILTER,
  filterQuery,
  financeErrorText,
  formatCents,
  formatCompact,
  formatDay,
  formatMonth,
  lastDayOf,
  nameLookup,
  type Account,
  type Budget,
  type Category,
  type CategoryTotal,
  type FinanceAlert,
  type FinanceTab,
  type Summary,
  type Tx,
  type TxFilter,
} from '../lib/finance.ts';

/**
 * "Riepilogo" of the finances (I-18, D-183) as a dashboard (D-189): on top the
 * balance of the accounts, expenses and income of the newest month against the
 * month before and the budgets past their limit; then income and expenses per
 * month, expenses per category with their budget, the latest movements, the
 * same month of the year before, the checks of the month and the balance of
 * one account. Charts drawn here in SVG, without a library; every number is
 * also written as text beside or below them.
 */
const props = defineProps<{ accounts: Account[]; categories: Category[] }>();
const emit = defineEmits<{ tab: [tab: FinanceTab]; open: [filter: TxFilter] }>();

type Period = 'last12' | 'thisYear' | 'lastYear';
const period = ref<Period>('last12');
const account = ref('');
const summary = ref<Summary | null>(null);
const problem = ref<string | null>(null);
const loading = ref(false);

function range(value: Period): { from?: string; to?: string } {
  const year = new Date().getFullYear();
  if (value === 'thisYear') return { from: `${String(year)}-01-01`, to: dayOf(new Date()) };
  if (value === 'lastYear') return { from: `${String(year - 1)}-01-01`, to: `${String(year - 1)}-12-31` };
  return {};
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    summary.value = await readFinanceSummary({ ...range(period.value), ...(account.value === '' ? {} : { account: account.value }) });
    problem.value = null;
  } catch (cause) {
    problem.value = financeErrorText(cause);
  } finally {
    loading.value = false;
  }
}
watch([period, account], load, { immediate: true });

const names = computed(() => nameLookup(props.accounts, props.categories));

// --- The numbers at the top and the cards around the charts (D-189) --------------

/** From the first day the balance can have: without it the summary covers only the last 12 months. */
const SINCE_EVER = '1900-01-01';

/**
 * Every read below keeps a number: an answer for an account chosen before
 * (a slow one) is dropped instead of overwriting the one in view.
 */
let balancesRead = 0;
let recentRead = 0;
let monthRead = 0;

/** The last balance of the accounts in view, read one by one: the summary gives the balance of one account only. */
const balances = ref<{ balance: number; currency: string }[] | null>(null);
/** The accounts in view without any balance (never imported, or no balance column). */
const withoutBalance = ref(0);
async function loadBalances(): Promise<void> {
  const request = ++balancesRead;
  // "Tutti i conti" adds the open ones; an account chosen counts even if archived.
  const shown = props.accounts.filter((item) => (account.value === '' ? !item.archived : item.id === account.value));
  try {
    const read = await Promise.all(
      shown.map(async (item) => {
        const one = await readFinanceSummary({ account: item.id, from: SINCE_EVER, to: dayOf(new Date()) });
        const last = one.balance[one.balance.length - 1];
        return last === undefined ? null : { balance: last.balance, currency: item.currency };
      }),
    );
    if (request !== balancesRead) return;
    balances.value = read.filter((item): item is { balance: number; currency: string } => item !== null);
    withoutBalance.value = read.length - balances.value.length;
  } catch {
    if (request === balancesRead) balances.value = null;
  }
}

/** The five newest movements; null when they could not be read. */
const recent = ref<Tx[] | null>([]);
async function loadRecent(): Promise<void> {
  const request = ++recentRead;
  try {
    const rows = (await listFinanceTransactions(filterQuery({ ...EMPTY_FILTER, account: account.value }, 5, 0))).transactions;
    if (request === recentRead) recent.value = rows;
  } catch {
    if (request === recentRead) recent.value = null;
  }
}

/** The checks of this calendar month on every account, as the tab "Avvisi" opens; null when not read. */
const alerts = ref<FinanceAlert[] | null>([]);
/** The budgets are for every account together; null when not read. */
const budgets = ref<Budget[] | null>([]);
async function loadAlertsAndBudgets(): Promise<void> {
  const [alertList, budgetList] = await Promise.allSettled([readFinanceAlerts(), listFinanceBudgets()]);
  alerts.value = alertList.status === 'fulfilled' ? alertList.value : null;
  budgets.value = budgetList.status === 'fulfilled' ? budgetList.value : null;
}

watch(
  account,
  () => {
    void loadBalances();
    void loadRecent();
  },
  { immediate: true },
);
void loadAlertsAndBudgets();

const pair = computed(() => (summary.value === null ? null : latestMonths(summary.value.months)));
const monthName = computed(() => (pair.value === null ? '' : (formatMonth(pair.value.current.month, true).split(' ')[0] ?? '')));

/**
 * What each category spent in the newest month, on every account: a budget
 * is for all the accounts together, so it does not follow the account chosen.
 */
const monthCategories = ref<CategoryTotal[]>([]);
watch(
  () => pair.value?.current.month,
  async (month) => {
    const request = ++monthRead;
    if (month === undefined) {
      monthCategories.value = [];
      return;
    }
    try {
      const categories = (await readFinanceSummary({ from: `${month}-01`, to: lastDayOf(month) })).categories;
      if (request === monthRead) monthCategories.value = categories;
    } catch {
      if (request === monthRead) monthCategories.value = [];
    }
  },
  { immediate: true },
);
const budgetList = computed<BudgetRow[]>(() => budgetRows(budgets.value ?? [], monthCategories.value));
const overBudgets = computed(() => budgetList.value.filter((row) => row.over));
function budgetOf(category: string | null): BudgetRow | undefined {
  return category === null ? undefined : budgetList.value.find((row) => row.category === category);
}

const shownAlerts = computed(() => (alerts.value ?? []).slice(0, 3).map((alert) => ({ alert, text: alertText(alert, names.value) })));

const MONTHS_FRAME: Frame = { width: 640, height: 220, left: 56, right: 8, top: 12, bottom: 28 };
const months = computed(() => (summary.value === null ? null : monthBars(summary.value.months, MONTHS_FRAME)));
const monthTicks = computed(() => (months.value === null ? [] : ticks(months.value.domain)));
const totals = computed(() => {
  const list = summary.value?.months ?? [];
  return { income: list.reduce((sum, month) => sum + month.income, 0), expenses: list.reduce((sum, month) => sum + month.expenses, 0) };
});

const bars = computed(() => categoryBars(summary.value?.categories ?? []));
function categoryName(category: string | null): string {
  return category === '' ? 'Altre categorie' : names.value.category(category);
}

const LINE_FRAME: Frame = { width: 640, height: 200, left: 64, right: 12, top: 12, bottom: 28 };
const line = computed(() => (summary.value === null || summary.value.balance.length === 0 ? null : balanceLine(summary.value.balance, LINE_FRAME)));
const lineTicks = computed(() => (line.value === null ? [] : ticks(line.value.domain)));
const lineLabels = computed(() => sampleLabels(line.value?.points ?? [], 5));
const lastBalance = computed(() => summary.value?.balance[summary.value.balance.length - 1] ?? null);

const yoy = computed(() => summary.value?.yearOverYear ?? null);
const yoyMax = computed(() => {
  const value = yoy.value;
  return value === null ? 1 : Math.max(1, value.current.expenses, value.previous.expenses, value.current.income, value.previous.income);
});
function width(cents: number): string {
  return `${String(Math.round((cents * 100) / yoyMax.value))}%`;
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div v-if="accounts.length === 0" class="rounded-xl border border-line bg-surface p-4 text-sm">
      Ancora nessun conto. Crea un conto, poi importa un estratto conto CSV o Excel della tua banca: qui compariranno entrate, uscite, categorie e saldo.
      <button type="button" class="btn ml-2 px-2.5 py-1 text-xs" @click="emit('tab', 'conti')">Crea un conto</button>
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1 text-xs text-muted max-md:min-w-0 max-md:flex-1">
        Periodo
        <select v-model="period" class="field touch:min-h-11 px-2 py-1.5 text-[14px] max-md:w-full">
          <option value="last12">Ultimi 12 mesi</option>
          <option value="thisYear">Quest’anno</option>
          <option value="lastYear">L’anno scorso</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted max-md:min-w-0 max-md:flex-1">
        Conto
        <select v-model="account" class="field touch:min-h-11 px-2 py-1.5 text-[14px] max-md:w-full">
          <option value="">Tutti i conti</option>
          <option v-for="item in accounts" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </label>
      <span v-if="loading" class="pb-2 text-xs text-muted">Aggiorno…</span>
    </div>

    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>

    <template v-if="summary">
      <!-- THE NUMBERS AT THE TOP (D-189) -->
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <section class="hud-card flex flex-col gap-1 p-4" aria-label="Saldo dei conti">
          <h3 class="hud-title">{{ account === '' ? 'Saldo dei conti' : 'Saldo del conto' }}</h3>
          <p class="text-[26px] leading-tight max-md:text-[21px] font-semibold tabular-nums">{{ balances === null || balances.length === 0 ? '—' : balanceText(balances) }}</p>
          <p class="text-xs text-muted">
            <template v-if="balances === null">Saldo non letto.</template>
            <template v-else-if="balances.length === 0">Nessun saldo negli estratti conto importati.</template>
            <template v-else>{{ balances.length === 1 ? '1 conto' : `${String(balances.length)} conti` }} · ultimo saldo noto<template v-if="withoutBalance > 0"> · {{ withoutBalance === 1 ? '1 conto senza saldo' : `${String(withoutBalance)} conti senza saldo` }}</template></template>
          </p>
        </section>
        <section v-for="kind in (['expenses', 'income'] as const)" :key="kind" class="hud-card flex flex-col gap-1 p-4" :aria-label="kind === 'expenses' ? 'Uscite del mese' : 'Entrate del mese'">
          <h3 class="hud-title">{{ kind === 'expenses' ? 'Uscite' : 'Entrate' }}{{ pair ? ` di ${monthName}` : '' }}</h3>
          <p class="text-[26px] leading-tight max-md:text-[21px] font-semibold tabular-nums">{{ pair ? formatCents(pair.current[kind]) : '—' }}</p>
          <p class="text-xs text-muted">{{ pair ? monthChangeText(pair.current[kind], pair.previous[kind], pair.previous.month) : 'Nessun movimento nel periodo.' }}</p>
        </section>
        <section class="hud-card flex flex-col gap-1 p-4" aria-label="Budget del mese">
          <h3 class="hud-title">Budget{{ pair ? ` di ${monthName}` : '' }}</h3>
          <template v-if="budgets === null">
            <p class="text-[26px] leading-tight max-md:text-[21px] font-semibold">—</p>
            <p class="text-xs text-muted">Budget non letti.</p>
          </template>
          <template v-else-if="budgetList.length > 0">
            <p class="text-[26px] leading-tight max-md:text-[21px] font-semibold tabular-nums">{{ overBudgets.length === 0 ? 'Nei limiti' : `${String(overBudgets.length)} su ${String(budgetList.length)}` }}</p>
            <p class="text-xs" :class="overBudgets.length > 0 ? 'text-danger' : 'text-muted'">
              {{ overBudgets.length === 0 ? `${String(budgetList.length)} budget, nessuno superato` : `superati: ${overBudgets.map((row) => names.category(row.category)).join(', ')}` }} · tutti i conti
            </p>
          </template>
          <template v-else>
            <p class="text-[26px] leading-tight max-md:text-[21px] font-semibold">—</p>
            <button type="button" class="self-start text-xs text-accent hover:underline touch:min-h-11" @click="emit('tab', 'categorie')">Imposta un budget</button>
          </template>
        </section>
      </div>

      <div class="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <!-- INCOME AND EXPENSES PER MONTH -->
        <section class="hud-card flex min-w-0 flex-col gap-2 p-4" aria-label="Entrate e uscite per mese">
          <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 class="hud-title flex-1">Entrate e uscite per mese</h3>
            <span class="flex items-center gap-1.5 text-xs"><span class="inline-block size-2.5 rounded-sm bg-ok" aria-hidden="true" />Entrate <b class="tabular-nums">{{ formatCents(totals.income) }}</b></span>
            <span class="flex items-center gap-1.5 text-xs"><span class="inline-block size-2.5 rounded-sm" style="background: var(--graph-3)" aria-hidden="true" />Uscite <b class="tabular-nums">{{ formatCents(totals.expenses) }}</b></span>
          </header>
          <p v-if="summary.months.length === 0" class="text-sm text-muted">Nessun movimento nel periodo.</p>
          <template v-else-if="months">
            <svg :viewBox="`0 0 ${MONTHS_FRAME.width} ${MONTHS_FRAME.height}`" class="h-auto w-full" role="img" aria-label="Grafico a barre di entrate e uscite per mese; i numeri sono nella tabella sotto">
              <g v-for="tick in monthTicks" :key="tick">
                <line :x1="MONTHS_FRAME.left" :x2="MONTHS_FRAME.width - MONTHS_FRAME.right" :y1="months.y(tick)" :y2="months.y(tick)" stroke="var(--line)" stroke-width="1" />
                <text :x="MONTHS_FRAME.left - 6" :y="months.y(tick) + 3" text-anchor="end" font-size="11" fill="var(--muted)">{{ formatCompact(tick) }}</text>
              </g>
              <g v-for="bar in months.bars" :key="bar.month">
                <rect :x="bar.income.x" :y="bar.income.y" :width="bar.income.width" :height="bar.income.height" rx="2" fill="var(--ok)"><title>{{ formatMonth(bar.month) }} · entrate {{ formatCents(summary.months.find((m) => m.month === bar.month)?.income ?? 0) }}</title></rect>
                <rect :x="bar.expenses.x" :y="bar.expenses.y" :width="bar.expenses.width" :height="bar.expenses.height" rx="2" fill="var(--graph-3)"><title>{{ formatMonth(bar.month) }} · uscite {{ formatCents(summary.months.find((m) => m.month === bar.month)?.expenses ?? 0) }}</title></rect>
                <text :x="bar.center" :y="MONTHS_FRAME.height - 10" text-anchor="middle" font-size="11" fill="var(--muted)">{{ formatMonth(bar.month).split(' ')[0] }}</text>
              </g>
            </svg>
            <details class="text-xs">
              <summary class="cursor-pointer text-muted touch:py-3">I numeri mese per mese</summary>
              <table class="mt-2 w-full text-left tabular-nums">
                <thead class="text-muted">
                  <tr><th class="py-1 font-medium">Mese</th><th class="py-1 text-right font-medium">Entrate</th><th class="py-1 text-right font-medium">Uscite</th><th class="py-1 text-right font-medium">Differenza</th></tr>
                </thead>
                <tbody>
                  <tr v-for="month in summary.months" :key="month.month" class="border-t border-line">
                    <td class="py-1">{{ formatMonth(month.month, true) }}</td>
                    <td class="py-1 text-right text-ok">{{ formatCents(month.income) }}</td>
                    <td class="py-1 text-right">{{ formatCents(month.expenses) }}</td>
                    <td class="py-1 text-right" :class="month.net > 0 ? 'text-ok' : ''">{{ formatCents(month.net, { sign: true }) }}</td>
                  </tr>
                </tbody>
              </table>
            </details>
          </template>
        </section>

        <!-- EXPENSES PER CATEGORY, WITH THE BUDGET OF THE MONTH -->
        <section class="hud-card flex min-w-0 flex-col gap-2 p-4" aria-label="Spese per categoria">
          <h3 class="hud-title">Spese per categoria</h3>
          <p v-if="bars.length === 0" class="text-sm text-muted">Nessuna spesa nel periodo.</p>
          <ul v-else class="flex flex-col gap-2.5">
            <li v-for="bar in bars" :key="bar.category ?? 'none'" class="flex flex-col gap-1">
              <span class="flex items-baseline gap-2 text-[14px]">
                <span class="min-w-0 flex-1 truncate" :class="bar.category === null ? 'text-muted italic' : ''">{{ categoryName(bar.category) }}</span>
                <b class="tabular-nums whitespace-nowrap">{{ formatCents(bar.expenses) }}</b>
                <span class="w-10 text-right text-xs text-muted tabular-nums">{{ bar.share }}%</span>
              </span>
              <svg viewBox="0 0 100 6" preserveAspectRatio="none" class="h-1.5 w-full" aria-hidden="true">
                <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--bg)" />
                <rect x="0" y="0" :width="Math.max(1, bar.percent)" height="6" rx="3" :fill="bar.category === null ? 'var(--muted)' : budgetOf(bar.category)?.over ? 'var(--danger)' : 'var(--graph-1)'" />
              </svg>
              <span v-if="budgetOf(bar.category)" class="text-xs" :class="budgetOf(bar.category)?.over ? 'text-danger' : 'text-muted'">
                Budget di {{ monthName }}: {{ formatCents(budgetOf(bar.category)?.spent ?? 0) }} su {{ formatCents(budgetOf(bar.category)?.limit ?? 0) }}{{ budgetOf(bar.category)?.over ? ', superato' : '' }}
              </span>
              <button v-if="bar.category === null" type="button" class="self-start text-xs text-accent hover:underline touch:min-h-11" @click="emit('open', { ...EMPTY_FILTER, uncategorized: true })">Assegnale in Movimenti</button>
            </li>
          </ul>
        </section>
      </div>

      <div class="grid gap-3 lg:grid-cols-3">
        <!-- THE LATEST MOVEMENTS -->
        <section class="hud-card flex min-w-0 flex-col gap-2 p-4" aria-label="Ultimi movimenti">
          <header class="flex items-baseline justify-between gap-2">
            <h3 class="hud-title">Ultimi movimenti</h3>
            <button type="button" class="text-xs text-accent hover:underline touch:-my-3 touch:min-h-11 touch:px-2" @click="emit('tab', 'movimenti')">Tutti</button>
          </header>
          <p v-if="recent === null" class="text-sm text-muted">Movimenti non letti.</p>
          <p v-else-if="recent.length === 0" class="text-sm text-muted">Nessun movimento.</p>
          <ul v-else class="flex flex-col">
            <li v-for="row in recent" :key="row.id" class="grid grid-cols-[48px_minmax(0,1fr)_auto] items-baseline gap-2 border-t border-line py-1.5 text-[14px] first:border-t-0">
              <span class="text-xs text-muted tabular-nums">{{ formatDay(row.booked).slice(0, 5) }}</span>
              <span class="truncate" :title="row.description">{{ readableDescription(row.description).title }}</span>
              <span class="whitespace-nowrap tabular-nums" :class="amountClass(row.amount)">{{ formatCents(row.amount, { currency: row.currency, sign: row.amount > 0 }) }}</span>
            </li>
          </ul>
        </section>

        <!-- THE SAME MONTH A YEAR EARLIER -->
        <section class="hud-card flex min-w-0 flex-col gap-3 p-4" aria-label="Confronto con l'anno prima">
          <h3 class="hud-title">Rispetto all’anno prima</h3>
          <p v-if="yoy === null" class="text-sm text-muted">Il confronto compare quando ci sono movimenti nel periodo.</p>
          <template v-else>
            <p class="text-[14px]">{{ formatMonth(yoy.current.month, true) }} contro {{ formatMonth(yoy.previous.month, true) }}</p>
            <div v-for="kind in (['expenses', 'income'] as const)" :key="kind" class="flex flex-col gap-1.5">
              <span class="flex items-baseline gap-2 text-[14px]">
                <span class="flex-1">{{ kind === 'expenses' ? 'Uscite' : 'Entrate' }}</span>
                <span class="text-xs text-muted">{{ changeText(kind === 'expenses' ? yoy.expensesChange : yoy.incomeChange, yoy.previous[kind]) }}</span>
              </span>
              <span class="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2 text-xs">
                <span class="text-muted">{{ formatMonth(yoy.current.month) }}</span>
                <span class="h-2 rounded-full" :style="{ width: width(yoy.current[kind]), background: kind === 'income' ? 'var(--ok)' : 'var(--graph-3)' }" />
                <b class="whitespace-nowrap tabular-nums">{{ formatCents(yoy.current[kind]) }}</b>
              </span>
              <span class="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2 text-xs">
                <span class="text-muted">{{ formatMonth(yoy.previous.month) }}</span>
                <span class="h-2 rounded-full opacity-45" :style="{ width: width(yoy.previous[kind]), background: kind === 'income' ? 'var(--ok)' : 'var(--graph-3)' }" />
                <span class="whitespace-nowrap tabular-nums">{{ formatCents(yoy.previous[kind]) }}</span>
              </span>
            </div>
          </template>
        </section>

        <!-- THE CHECKS OF THE MONTH -->
        <section class="hud-card flex min-w-0 flex-col gap-2 p-4" aria-label="Avvisi del mese">
          <header class="flex items-baseline justify-between gap-2">
            <h3 class="hud-title">Avvisi di questo mese</h3>
            <button type="button" class="text-xs text-accent hover:underline touch:-my-3 touch:min-h-11 touch:px-2" @click="emit('tab', 'avvisi')">Tutti{{ (alerts?.length ?? 0) > 3 ? ` (${String(alerts?.length ?? 0)})` : '' }}</button>
          </header>
          <p v-if="alerts === null" class="text-sm text-muted">Avvisi non letti.</p>
          <p v-else-if="alerts.length === 0" class="text-sm text-muted">Nessun avviso: niente addebiti cambiati, spese insolite, doppi addebiti o budget superati.</p>
          <ul v-else class="flex flex-col">
            <li v-for="item in shownAlerts" :key="item.text.title" class="border-t border-line py-1.5 first:border-t-0">
              <button type="button" class="flex w-full items-start gap-2 text-left text-[14px] hover:text-accent touch:min-h-11" @click="emit('open', alertFilter(item.alert))">
                <span class="mt-1.5 size-2 shrink-0 rounded-full" :class="item.text.tone === 'danger' ? 'bg-danger' : 'bg-warn'" aria-hidden="true" />
                <span>{{ item.text.title }}</span>
              </button>
            </li>
          </ul>
        </section>
      </div>

      <!-- BALANCE OF ONE ACCOUNT -->
      <section class="hud-card flex flex-col gap-2 p-4" aria-label="Andamento del saldo">
        <header class="flex flex-wrap items-baseline gap-x-4">
          <h3 class="hud-title">Andamento del saldo</h3>
          <span v-if="lastBalance" class="text-xs">al {{ formatDay(lastBalance.day) }}: <b class="tabular-nums">{{ formatCents(lastBalance.balance) }}</b></span>
        </header>
        <p v-if="account === ''" class="text-sm text-muted">Il saldo è per conto: scegli un conto qui sopra.</p>
        <p v-else-if="line === null" class="text-sm text-muted">Nessun saldo nel periodo.</p>
        <template v-else>
          <svg :viewBox="`0 0 ${LINE_FRAME.width} ${LINE_FRAME.height}`" class="h-auto w-full" role="img" :aria-label="`Linea del saldo; ultimo saldo ${lastBalance ? formatCents(lastBalance.balance) : ''}`">
            <g v-for="tick in lineTicks" :key="tick">
              <line :x1="LINE_FRAME.left" :x2="LINE_FRAME.width - LINE_FRAME.right" :y1="line.y(tick)" :y2="line.y(tick)" :stroke="tick === 0 ? 'var(--line-strong)' : 'var(--line)'" stroke-width="1" />
              <text :x="LINE_FRAME.left - 6" :y="line.y(tick) + 3" text-anchor="end" font-size="11" fill="var(--muted)">{{ formatCompact(tick) }}</text>
            </g>
            <path :d="line.path" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <circle v-for="point in line.points" :key="point.day" :cx="point.x" :cy="point.y" r="6" fill="transparent">
              <title>{{ formatDay(point.day) }} · {{ formatCents(point.balance) }}</title>
            </circle>
            <!-- The first and last labels anchored inside the frame, so they are never cut at the edges. -->
            <text v-for="(point, index) in lineLabels" :key="`l-${point.day}`" :x="point.x" :y="LINE_FRAME.height - 10" :text-anchor="index === 0 ? 'start' : index === lineLabels.length - 1 ? 'end' : 'middle'" font-size="11" fill="var(--muted)">{{ formatDay(point.day).slice(0, 5) }}</text>
          </svg>
          <p class="text-xs text-muted">
            Dal {{ formatDay(line.points[0]?.day ?? null) }}: {{ formatCents(line.points[0]?.balance ?? 0) }} · al {{ formatDay(lastBalance?.day ?? null) }}: {{ formatCents(lastBalance?.balance ?? 0) }}. Passa sul grafico per i singoli giorni.
          </p>
        </template>
      </section>
    </template>
  </div>
</template>

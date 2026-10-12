<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { readFinanceSummary } from '../lib/api.ts';
import { balanceLine, categoryBars, monthBars, sampleLabels, ticks, type Frame } from '../lib/finance-charts.ts';
import { changeText, dayOf, financeErrorText, formatCents, formatCompact, formatDay, formatMonth, nameLookup, type Account, type Category, type FinanceTab, type Summary } from '../lib/finance.ts';

/**
 * "Riepilogo" of the finances (I-18, D-183): income and expenses per month,
 * expenses per category, the balance of one account and the same month of the
 * year before. Charts drawn here in SVG, without a library; every number is
 * also written as text beside or below them.
 */
const props = defineProps<{ accounts: Account[]; categories: Category[] }>();
const emit = defineEmits<{ tab: [tab: FinanceTab] }>();

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
  <div class="flex max-w-5xl flex-col gap-4">
    <div v-if="accounts.length === 0" class="rounded-xl border border-line bg-surface p-4 text-sm">
      Ancora nessun conto. Crea un conto, poi importa un estratto conto CSV o Excel della tua banca: qui compariranno entrate, uscite, categorie e saldo.
      <button type="button" class="btn ml-2 px-2.5 py-1 text-xs" @click="emit('tab', 'conti')">Crea un conto</button>
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1 text-xs text-muted">
        Periodo
        <select v-model="period" class="field px-2 py-1.5 text-[14px]">
          <option value="last12">Ultimi 12 mesi</option>
          <option value="thisYear">Quest’anno</option>
          <option value="lastYear">L’anno scorso</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Conto
        <select v-model="account" class="field px-2 py-1.5 text-[14px]">
          <option value="">Tutti i conti</option>
          <option v-for="item in accounts" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </label>
      <span v-if="loading" class="pb-2 text-xs text-muted">Aggiorno…</span>
    </div>

    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>

    <template v-if="summary">
      <!-- INCOME AND EXPENSES PER MONTH -->
      <section class="hud-card flex flex-col gap-2 p-4" aria-label="Entrate e uscite per mese">
        <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h3 class="hud-title">Entrate e uscite per mese</h3>
          <span class="flex items-center gap-1.5 text-xs"><span class="inline-block size-2.5 rounded-sm bg-ok" aria-hidden="true" />Entrate <b class="tabular-nums">{{ formatCents(totals.income) }}</b></span>
          <span class="flex items-center gap-1.5 text-xs"><span class="inline-block size-2.5 rounded-sm" style="background: var(--graph-3)" aria-hidden="true" />Uscite <b class="tabular-nums">{{ formatCents(totals.expenses) }}</b></span>
        </header>
        <p v-if="summary.months.length === 0" class="text-sm text-muted">Nessun movimento nel periodo.</p>
        <template v-else-if="months">
          <svg :viewBox="`0 0 ${MONTHS_FRAME.width} ${MONTHS_FRAME.height}`" class="h-auto w-full" role="img" aria-label="Grafico a barre di entrate e uscite per mese; i numeri sono nella tabella sotto">
            <g v-for="tick in monthTicks" :key="tick">
              <line :x1="MONTHS_FRAME.left" :x2="MONTHS_FRAME.width - MONTHS_FRAME.right" :y1="months.y(tick)" :y2="months.y(tick)" stroke="var(--line)" stroke-width="1" />
              <text :x="MONTHS_FRAME.left - 6" :y="months.y(tick) + 3" text-anchor="end" font-size="10" fill="var(--muted)">{{ formatCompact(tick) }}</text>
            </g>
            <g v-for="bar in months.bars" :key="bar.month">
              <rect :x="bar.income.x" :y="bar.income.y" :width="bar.income.width" :height="bar.income.height" rx="2" fill="var(--ok)"><title>{{ formatMonth(bar.month) }} · entrate {{ formatCents(summary.months.find((m) => m.month === bar.month)?.income ?? 0) }}</title></rect>
              <rect :x="bar.expenses.x" :y="bar.expenses.y" :width="bar.expenses.width" :height="bar.expenses.height" rx="2" fill="var(--graph-3)"><title>{{ formatMonth(bar.month) }} · uscite {{ formatCents(summary.months.find((m) => m.month === bar.month)?.expenses ?? 0) }}</title></rect>
              <text :x="bar.center" :y="MONTHS_FRAME.height - 10" text-anchor="middle" font-size="10" fill="var(--muted)">{{ formatMonth(bar.month).split(' ')[0] }}</text>
            </g>
          </svg>
          <details class="text-xs">
            <summary class="cursor-pointer text-muted">I numeri mese per mese</summary>
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

      <div class="grid gap-4 lg:grid-cols-2">
        <!-- EXPENSES PER CATEGORY -->
        <section class="hud-card flex flex-col gap-2 p-4" aria-label="Spese per categoria">
          <h3 class="hud-title">Spese per categoria</h3>
          <p v-if="bars.length === 0" class="text-sm text-muted">Nessuna spesa nel periodo.</p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="bar in bars" :key="bar.category ?? 'none'" class="flex flex-col gap-1">
              <span class="flex items-baseline gap-2 text-[14px]">
                <span class="min-w-0 flex-1 truncate" :class="bar.category === null ? 'text-muted italic' : ''">{{ categoryName(bar.category) }}</span>
                <b class="tabular-nums">{{ formatCents(bar.expenses) }}</b>
                <span class="w-9 text-right text-xs text-muted tabular-nums">{{ bar.share }}%</span>
              </span>
              <svg viewBox="0 0 100 6" preserveAspectRatio="none" class="h-1.5 w-full" aria-hidden="true">
                <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--surface-2)" />
                <rect x="0" y="0" :width="Math.max(1, bar.percent)" height="6" rx="3" fill="var(--graph-1)" />
              </svg>
            </li>
          </ul>
        </section>

        <!-- THE SAME MONTH A YEAR EARLIER -->
        <section class="hud-card flex flex-col gap-3 p-4" aria-label="Confronto con l'anno prima">
          <h3 class="hud-title">Rispetto all’anno prima</h3>
          <p v-if="yoy === null" class="text-sm text-muted">Il confronto compare quando ci sono movimenti nel periodo.</p>
          <template v-else>
            <p class="text-[14px]">{{ formatMonth(yoy.current.month, true) }} contro {{ formatMonth(yoy.previous.month, true) }}</p>
            <div v-for="kind in (['expenses', 'income'] as const)" :key="kind" class="flex flex-col gap-1.5">
              <span class="flex items-baseline gap-2 text-[14px]">
                <span class="flex-1">{{ kind === 'expenses' ? 'Uscite' : 'Entrate' }}</span>
                <span class="text-xs text-muted">{{ changeText(kind === 'expenses' ? yoy.expensesChange : yoy.incomeChange, yoy.previous[kind]) }}</span>
              </span>
              <span class="flex items-center gap-2 text-xs">
                <span class="w-16 shrink-0 text-muted">{{ formatMonth(yoy.current.month) }}</span>
                <span class="h-2 rounded-full" :style="{ width: width(yoy.current[kind]), background: kind === 'income' ? 'var(--ok)' : 'var(--graph-3)' }" />
                <b class="tabular-nums">{{ formatCents(yoy.current[kind]) }}</b>
              </span>
              <span class="flex items-center gap-2 text-xs">
                <span class="w-16 shrink-0 text-muted">{{ formatMonth(yoy.previous.month) }}</span>
                <span class="h-2 rounded-full opacity-45" :style="{ width: width(yoy.previous[kind]), background: kind === 'income' ? 'var(--ok)' : 'var(--graph-3)' }" />
                <span class="tabular-nums">{{ formatCents(yoy.previous[kind]) }}</span>
              </span>
            </div>
          </template>
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
              <text :x="LINE_FRAME.left - 6" :y="line.y(tick) + 3" text-anchor="end" font-size="10" fill="var(--muted)">{{ formatCompact(tick) }}</text>
            </g>
            <path :d="line.path" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <circle v-for="point in line.points" :key="point.day" :cx="point.x" :cy="point.y" r="6" fill="transparent">
              <title>{{ formatDay(point.day) }} · {{ formatCents(point.balance) }}</title>
            </circle>
            <!-- The first and last labels anchored inside the frame, so they are never cut at the edges. -->
            <text v-for="(point, index) in lineLabels" :key="`l-${point.day}`" :x="point.x" :y="LINE_FRAME.height - 10" :text-anchor="index === 0 ? 'start' : index === lineLabels.length - 1 ? 'end' : 'middle'" font-size="10" fill="var(--muted)">{{ formatDay(point.day).slice(0, 5) }}</text>
          </svg>
          <p class="text-xs text-muted">
            Dal {{ formatDay(line.points[0]?.day ?? null) }}: {{ formatCents(line.points[0]?.balance ?? 0) }} · al {{ formatDay(lastBalance?.day ?? null) }}: {{ formatCents(lastBalance?.balance ?? 0) }}. Passa sul grafico per i singoli giorni.
          </p>
        </template>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, createImInvoice, readClientDashboard, updateImInvoice } from '../lib/api.ts';
import { chartScale, dashboardYears, roundMoneyText, summarize, type Basis, type ClientDashboard, type DashboardInvoice, type YearChoice } from '../lib/client-dashboard.ts';
import { CHART_FONT, labelShown, labelStep, PHONE_CHART_WIDTH } from '../lib/finance-charts.ts';
import { billingErrorText, dayText, dueText, invoiceAmount, moneyText, todayInput, type NewInvoice } from '../lib/im-billing.ts';
import { followMedia, phoneMedia, phoneNow } from '../lib/studio-phone.ts';
import Icon from './Icon.vue';
import InvoiceForm from './InvoiceForm.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * The dashboard of a client (I-16 tappa C3, D-170): what the client brought
 * in from the IM of its projects, by month and by year, in competenza (the
 * month of the IM, invoices at the total of the document split on their IM)
 * or in cassa (the month of the payment); what is to invoice, waiting and
 * collected; the invoices of all its projects, registered and marked paid
 * from here too. The sums come from the code (core and `lib/client-dashboard.ts`),
 * never from a model. Private (L2): it stays on this computer.
 */
const props = defineProps<{ clientId: string }>();
const emit = defineEmits<{ project: [name: string]; invoice: [project: string, invoice: string] }>();

const dashboard = ref<ClientDashboard | null>(null);
const problem = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const year = ref<YearChoice>(new Date().getFullYear());
const project = ref<string>('all');
const basis = ref<Basis>('accrual');

async function load(): Promise<void> {
  const id = props.clientId;
  try {
    const found = await readClientDashboard(id);
    if (props.clientId !== id) return;
    dashboard.value = found;
    problem.value = null;
    if (project.value !== 'all' && !found.projects.some((item) => item.name === project.value)) project.value = 'all';
  } catch (cause) {
    if (props.clientId === id) problem.value = cause instanceof ApiError && cause.status === 404 ? 'Questo cliente non c’è più: torna alla lista dei clienti.' : billingErrorText(cause);
  }
}

async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
  busy.value = true;
  notice.value = null;
  try {
    await action();
    notice.value = done;
    return true;
  } catch (cause) {
    notice.value = billingErrorText(cause);
    return false;
  } finally {
    await load();
    busy.value = false;
  }
}

const years = computed(() => (dashboard.value === null ? [] : dashboardYears(dashboard.value)));
const summary = computed(() => (dashboard.value === null ? null : summarize(dashboard.value, { year: year.value, project: project.value, basis: basis.value })));
const currency = computed(() => dashboard.value?.currency ?? 'EUR');
const money = (cents: number): string => roundMoneyText(cents, currency.value);
const periodText = computed(() => (year.value === 'all' ? 'in tutto' : String(year.value)));
const projectByName = computed(() => new Map((dashboard.value?.projects ?? []).map((item) => [item.name, item])));
const priceText = (name: string): string => {
  const price = projectByName.value.get(name)?.price;
  return price?.amountCents != null ? `${moneyText(price.amountCents, price.currency)}/IM` : 'senza prezzo';
};
const shownProjects = computed(() => (dashboard.value?.projects ?? []).filter((item) => project.value === 'all' || item.name === project.value));
const noPrice = computed(() => shownProjects.value.flatMap((item) => item.noPrice.map((im) => ({ project: item.name, ...im }))));
const notBilled = computed(() => shownProjects.value.flatMap((item) => item.notBilled.map((im) => ({ project: item.name, ...im }))));
const invoices = computed(() => (dashboard.value?.invoices ?? []).filter((invoice) => project.value === 'all' || invoice.project === project.value));
/** Invoices registered before the total of the document (D-170): they count without VAT until it is written. */
const withoutDocument = computed(() => invoices.value.filter((invoice) => invoice.documentCents === null));

// --- The chart: one bar per month (per year with "Tutto"), stacked in competenza
// Left wide enough for "10.000 €" on the axis (D-190).
const WIDE_CHART = { width: 640, height: 210, left: 68, bottom: 22, top: 8 };
// D-294: on the phone as wide as the screen, so its labels stay readable; fewer month names when they do not fit.
const PHONE_CHART = { width: PHONE_CHART_WIDTH, height: 190, left: 58, bottom: 22, top: 8 };
const phone = ref(phoneNow());
let stopPhone: (() => void) | undefined;
onMounted(() => {
  stopPhone = followMedia(phoneMedia(), (matches) => (phone.value = matches));
});
onBeforeUnmount(() => stopPhone?.());
const CHART = computed(() => (phone.value ? PHONE_CHART : WIDE_CHART));
const chartFont = computed(() => (phone.value ? CHART_FONT.phone : CHART_FONT.wide));
/** One label in `labelEvery`: on the phone «gen», «feb»… or «2025» want about 34 units each. */
const labelEvery = computed(() => (phone.value ? labelStep(summary.value?.chart.length ?? 0, CHART.value.width - CHART.value.left, 34) : 1));
const scale = computed(() => chartScale(summary.value?.chart ?? []));
const plotHeight = computed(() => CHART.value.height - CHART.value.bottom - CHART.value.top);
const slot = computed(() => (CHART.value.width - CHART.value.left) / Math.max(1, summary.value?.chart.length ?? 1));
const barHeight = (cents: number): number => (cents / scale.value) * plotHeight.value;
const ticks = computed(() => [0, 0.5, 1].map((part) => ({ y: CHART.value.top + plotHeight.value * (1 - part), text: money(scale.value * part) })));

function segments(bar: { paid: number; invoiced: number; toInvoice: number }): { y: number; h: number; kind: string }[] {
  let base = CHART.value.top + plotHeight.value;
  const out: { y: number; h: number; kind: string }[] = [];
  for (const [kind, cents] of [
    ['paid', bar.paid],
    ['invoiced', bar.invoiced],
    ['toInvoice', bar.toInvoice],
  ] as const) {
    const h = barHeight(cents);
    if (h <= 0) continue;
    base -= h;
    out.push({ y: base, h, kind });
  }
  return out;
}

const SEGMENT_CLASS: Record<string, string> = { paid: 'fill-ok', invoiced: 'fill-info', toInvoice: 'fill-warn' };

// --- The invoices: paid from here, a new one for a project of the client
const paying = ref<{ id: string; day: string } | null>(null);

async function markPaid(invoice: DashboardInvoice): Promise<void> {
  const day = paying.value?.id === invoice.id ? paying.value.day : todayInput();
  if (await run(() => updateImInvoice(invoice.project, invoice.id, { paidOn: day }), `Fattura ${invoice.number} segnata pagata.`)) paying.value = null;
}

function markUnpaid(invoice: DashboardInvoice): void {
  void run(() => updateImInvoice(invoice.project, invoice.id, { paidOn: null }), `Fattura ${invoice.number} di nuovo in attesa di pagamento.`);
}

const invoicing = ref<{ project: string; chosen: Set<number> } | null>(null);
const invoiceProjects = computed(() => (dashboard.value?.projects ?? []).filter((item) => item.toInvoice.length > 0));
const invoicingIms = computed(() => (dashboard.value?.projects ?? []).find((item) => item.name === invoicing.value?.project)?.toInvoice ?? []);
const invoicingChosen = computed(() => [...(invoicing.value?.chosen ?? [])].sort((a, b) => a - b));
const invoicingTaxable = computed(() => {
  const picked = invoicingIms.value.filter((im) => invoicing.value?.chosen.has(im.number) === true && im.cents !== null);
  const currencies = new Set(picked.map((im) => im.currency));
  if (picked.length === 0 || currencies.size !== 1) return undefined;
  return { currency: picked[0]?.currency ?? 'EUR', cents: picked.reduce((sum, im) => sum + (im.cents ?? 0), 0) };
});

function startInvoicing(): void {
  const first = (project.value !== 'all' ? invoiceProjects.value.find((item) => item.name === project.value) : undefined) ?? invoiceProjects.value[0];
  if (first !== undefined) invoicing.value = { project: first.name, chosen: new Set(first.toInvoice.map((im) => im.number)) };
}

function pickProject(name: string): void {
  const found = invoiceProjects.value.find((item) => item.name === name);
  invoicing.value = { project: name, chosen: new Set(found?.toInvoice.map((im) => im.number) ?? []) };
}

function toggleIm(number: number): void {
  if (invoicing.value === null) return;
  const next = new Set(invoicing.value.chosen);
  if (next.has(number)) next.delete(number);
  else next.add(number);
  invoicing.value = { ...invoicing.value, chosen: next };
}

async function saveInvoice(invoice: NewInvoice): Promise<void> {
  const current = invoicing.value;
  if (current === null || current.chosen.size === 0) return;
  if (await run(() => createImInvoice(current.project, { ...invoice, ims: invoicingChosen.value }), `Fattura ${invoice.number} registrata per ${current.project}.`)) invoicing.value = null;
}

const imsText = (ims: readonly number[]): string => (ims.length > 3 ? `IM-${String(ims[0])} … IM-${String(ims.at(-1))} (${String(ims.length)})` : ims.map((im) => `IM-${String(im)}`).join(', '));
const imDay = (date: string | null): string => (date === null ? '' : dayText(date.slice(0, 10)));

watch(
  () => props.clientId,
  () => {
    dashboard.value = null;
    invoicing.value = null;
    paying.value = null;
    project.value = 'all';
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <p v-if="problem" class="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-if="dashboard === null && problem === null" class="text-sm text-muted">Carico la dashboard…</p>

    <template v-if="dashboard && summary">
      <p v-if="dashboard.projects.length === 0" class="max-w-xl rounded-xl border border-dashed border-line-strong bg-surface p-5 text-sm text-muted">
        Il cliente non ha progetti: collegane uno nella scheda “Progetti” e i guadagni dei suoi IM chiusi compariranno qui.
      </p>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2">
        <div class="seg" role="group" aria-label="Anno">
          <button v-for="item in years" :key="item" type="button" :class="{ on: year === item }" :aria-pressed="year === item" @click="year = item">{{ item }}</button>
          <button type="button" :class="{ on: year === 'all' }" :aria-pressed="year === 'all'" @click="year = 'all'">Tutto</button>
        </div>
        <div v-if="dashboard.projects.length > 1" class="flex flex-wrap gap-1.5" role="group" aria-label="Progetto">
          <button type="button" class="chip" :class="{ on: project === 'all' }" :aria-pressed="project === 'all'" @click="project = 'all'">Tutti i progetti</button>
          <button v-for="item in dashboard.projects" :key="item.name" type="button" class="chip" :class="{ on: project === item.name }" :aria-pressed="project === item.name" @click="project = item.name">{{ item.name }}</button>
        </div>
        <span class="flex-1" />
        <div class="seg" role="group" aria-label="Come contare">
          <button type="button" :class="{ on: basis === 'accrual' }" :aria-pressed="basis === 'accrual'" title="Ogni IM nel mese in cui si è tenuto" @click="basis = 'accrual'">Competenza</button>
          <button type="button" :class="{ on: basis === 'cash' }" :aria-pressed="basis === 'cash'" title="Ogni fattura nel mese in cui è stata pagata" @click="basis = 'cash'">Cassa</button>
        </div>
        <span class="flex items-center gap-1.5 text-xs text-muted"><LabelBadge label="L2" class="text-xs" />resta sul Mac</span>
      </div>

      <p v-if="notice" class="text-sm text-muted" role="status">{{ notice }}</p>

      <!-- KPI -->
      <div class="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <div class="kpi">
          <small>{{ basis === 'accrual' ? `Guadagno ${periodText}` : `Incassato ${periodText}` }}<template v-if="basis === 'accrual'"> · {{ summary.closed }} IM chiusi</template></small>
          <b>{{ money(summary.earned) }}</b>
          <small v-if="summary.previous !== null && year !== 'all'">{{ Number(year) - 1 }}: {{ money(summary.previous) }}</small>
        </div>
        <div class="kpi">
          <small><i class="sw bg-warn" />Da fatturare · {{ summary.toInvoice.ims.length }} IM</small>
          <b>{{ money(summary.toInvoice.cents) }}</b>
          <small class="truncate">{{ summary.toInvoice.ims.length === 0 ? 'niente da fatturare' : summary.toInvoice.ims.map((im) => `IM-${String(im.number)} ${im.project}`).join(', ') }}</small>
        </div>
        <div class="kpi">
          <small><i class="sw bg-info" />In attesa di pagamento</small>
          <b>{{ money(summary.awaiting.cents) }}</b>
          <small>
            {{ summary.awaiting.invoices }} {{ summary.awaiting.invoices === 1 ? 'fattura' : 'fatture' }}<template v-if="summary.awaiting.overdue > 0"> · <span class="text-danger">{{ summary.awaiting.overdue }} scadut{{ summary.awaiting.overdue === 1 ? 'a' : 'e' }}</span></template><template v-else-if="summary.awaiting.firstDue"> · la prima scade il {{ dayText(summary.awaiting.firstDue) }}</template>
          </small>
        </div>
        <div class="kpi">
          <small><i class="sw bg-ok" />Incassato {{ periodText }}</small>
          <b>{{ money(summary.collected.cents) }}</b>
          <small>{{ summary.collected.lastPaid ? `ultimo pagamento ${dayText(summary.collected.lastPaid)}` : 'nessun pagamento' }}</small>
        </div>
      </div>

      <!-- Warnings -->
      <div v-if="noPrice.length > 0 || notBilled.length > 0 || dashboard.missing.length > 0 || summary.others.length > 0 || summary.othersWaiting.length > 0 || withoutDocument.length > 0" class="flex flex-col gap-1.5 rounded-xl border border-warn/50 bg-warn/10 px-3 py-2 text-[13.5px]">
        <p v-if="noPrice.length > 0" class="flex flex-wrap items-center gap-1.5">
          <Icon name="warning" :size="14" class="text-warn" />
          {{ noPrice.length }} IM chius{{ noPrice.length === 1 ? 'o' : 'i' }} senza prezzo ({{ noPrice.map((im) => `${im.project} IM-${String(im.number)}${im.date ? ` del ${imDay(im.date)}` : ''}`).join(', ') }}): non entrano nei totali finché non gli dai un prezzo.
          <button type="button" class="btn px-2 py-0.5 text-xs" @click="emit('project', noPrice[0]?.project ?? '')">Metti il prezzo</button>
        </p>
        <p v-if="notBilled.length > 0" class="text-muted">{{ notBilled.length }} IM segnat{{ notBilled.length === 1 ? 'o' : 'i' }} non fatturat{{ notBilled.length === 1 ? 'o' : 'i' }} ({{ notBilled.map((im) => `${im.project} IM-${String(im.number)}`).join(', ') }}): contano zero.</p>
        <!-- In plain words (D-190): which invoice, what it counts now, a button to the place where the total is written. -->
        <p v-for="invoice in withoutDocument" :key="invoice.id" class="flex flex-wrap items-center gap-1.5">
          <Icon name="warning" :size="14" class="text-warn" />
          <span><b class="font-medium">{{ invoice.number }}</b> non ha il totale con IVA: qui conta {{ moneyText(invoice.totalCents, invoice.currency) }} senza IVA, quindi i guadagni risultano più bassi.</span>
          <button type="button" class="btn px-2 py-0.5 text-xs" :title="`Apre la scheda IM di ${invoice.project} su «Totale e scadenza…» di questa fattura`" @click="emit('invoice', invoice.project, invoice.id)">Scrivi il totale</button>
        </p>
        <p v-if="summary.others.length > 0" class="text-muted">Fuori dal guadagno, in un'altra valuta: {{ summary.others.map((item) => moneyText(item.cents, item.currency)).join(' · ') }}.</p>
        <p v-if="summary.othersWaiting.length > 0" class="text-muted">Da fatturare o in attesa in un'altra valuta, fuori dai riquadri: {{ summary.othersWaiting.map((item) => moneyText(item.cents, item.currency)).join(' · ') }}.</p>
        <p v-if="dashboard.missing.length > 0" class="text-muted">Progetti del cliente non più fra quelli approvati, non contati: {{ dashboard.missing.join(', ') }}.</p>
      </div>

      <div class="grid gap-3.5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <!-- Chart -->
        <section class="rounded-2xl border border-line bg-surface px-4 py-3.5" aria-labelledby="dash-chart-title">
          <header class="mb-2 flex flex-wrap items-baseline gap-2">
            <h2 id="dash-chart-title" class="hud-title flex-1">{{ year === 'all' ? 'Guadagni per anno' : `Guadagni per mese · ${String(year)}` }}</h2>
            <span class="text-xs text-muted">{{ basis === 'accrual' ? 'mese dell’IM · fatture al totale documento, il resto all’imponibile' : 'mese del pagamento · totale documento' }}</span>
          </header>
          <svg :viewBox="`0 0 ${String(CHART.width)} ${String(CHART.height)}`" class="block h-auto w-full" role="img" :aria-label="`Grafico dei guadagni ${periodText}`">
            <g v-for="tick in ticks" :key="tick.y">
              <line :x1="CHART.left" :x2="CHART.width" :y1="tick.y" :y2="tick.y" class="stroke-line" stroke-dasharray="2 4" />
              <text :x="CHART.left - 6" :y="tick.y + 3" text-anchor="end" class="fill-muted" :font-size="chartFont">{{ tick.text }}</text>
            </g>
            <g v-for="(bar, index) in summary.chart" :key="bar.key">
              <title>{{ bar.label }}: {{ money(bar.paid + bar.invoiced + bar.toInvoice) }}</title>
              <rect v-for="segment in segments(bar)" :key="segment.kind" :x="CHART.left + slot * index + slot * 0.2" :width="slot * 0.6" :y="segment.y" :height="segment.h" rx="2" :class="SEGMENT_CLASS[segment.kind]" />
              <text v-if="labelShown(index, labelEvery)" :x="CHART.left + slot * index + slot / 2" :y="CHART.height - 6" text-anchor="middle" class="fill-muted" :font-size="chartFont">{{ bar.label }}</text>
            </g>
          </svg>
          <div class="mt-1.5 flex flex-wrap gap-3 text-xs text-muted">
            <span><i class="sw bg-ok" />Incassato</span>
            <template v-if="basis === 'accrual'">
              <span><i class="sw bg-info" />In fattura, non pagato</span>
              <span><i class="sw bg-warn" />Da fatturare</span>
            </template>
          </div>
        </section>

        <div class="flex flex-col gap-3.5">
          <!-- By project -->
          <section class="rounded-2xl border border-line bg-surface px-4 py-3.5" aria-labelledby="dash-projects-title">
            <h2 id="dash-projects-title" class="hud-title mb-3">Per progetto · {{ periodText }}</h2>
            <ul class="grid gap-3">
              <li v-for="item in summary.projects" :key="item.name" class="grid gap-1">
                <div class="flex justify-between gap-2 text-[14px]">
                  <button type="button" class="truncate text-left hover:text-accent touch:min-h-11" @click="emit('project', item.name)">
                    {{ item.name }}<span class="text-muted"> · {{ priceText(item.name) }}</span>
                  </button>
                  <b class="font-mono font-medium">{{ money(item.cents) }}</b>
                </div>
                <div class="h-2 overflow-hidden rounded bg-surface-2"><span class="block h-full bg-accent" :style="{ width: `${String(summary.earned === 0 ? 0 : Math.round((item.cents / summary.earned) * 100))}%` }" /></div>
                <small class="text-xs text-muted">{{ item.closed }} IM chiusi<template v-if="projectByName.get(item.name)?.next"> · prossimo IM-{{ projectByName.get(item.name)?.next?.number }} {{ imDay(projectByName.get(item.name)?.next?.date ?? null) }}</template></small>
              </li>
            </ul>
            <p class="mt-3 text-xs text-muted">Il prezzo si fissa su ogni IM quando si chiude: cambiarlo nel progetto vale solo per gli IM ancora aperti.</p>
          </section>

          <!-- By year -->
          <section v-if="summary.years.length > 0" class="rounded-2xl border border-line bg-surface px-4 py-3.5" aria-labelledby="dash-years-title">
            <h2 id="dash-years-title" class="hud-title mb-2">Per anno</h2>
            <table class="w-full text-[14px]">
              <thead>
                <tr class="border-b border-line text-left text-xs text-muted">
                  <th class="py-1.5 font-normal">Anno</th>
                  <th class="py-1.5 text-right font-normal">IM chiusi</th>
                  <th class="py-1.5 text-right font-normal">{{ basis === 'accrual' ? 'Guadagno' : 'Incassato' }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                <tr v-for="item in summary.years" :key="item.year">
                  <td class="py-1.5">{{ item.year }}</td>
                  <td class="py-1.5 text-right font-mono">{{ item.closed }}</td>
                  <td class="py-1.5 text-right font-mono">{{ money(item.cents) }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>

      <!-- Invoices -->
      <section class="rounded-2xl border border-line bg-surface" aria-labelledby="dash-invoices-title">
        <header class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="file" :size="15" class="text-muted" />
          <h2 id="dash-invoices-title" class="hud-title flex-1">Fatture</h2>
          <button v-if="invoiceProjects.length > 0 && invoicing === null" type="button" class="btn btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold" :disabled="busy" @click="startInvoicing">
            <Icon name="new" :size="13" />Registra fattura
          </button>
        </header>

        <template v-if="invoicing">
          <div class="flex flex-col gap-2 border-b border-line bg-surface-2 px-4 pt-3.5">
            <label class="flex items-center gap-2 text-xs text-muted">Progetto
              <select class="field touch:min-h-11 px-2 py-1 text-[14px] text-ink" :value="invoicing.project" @change="pickProject(($event.target as HTMLSelectElement).value)">
                <option v-for="item in invoiceProjects" :key="item.name" :value="item.name">{{ item.name }}</option>
              </select>
            </label>
            <div class="flex flex-wrap gap-1.5" role="group" aria-label="IM da mettere in fattura">
              <label v-for="im in invoicingIms" :key="im.number" class="chip cursor-pointer touch:min-h-11 touch:items-center" :class="{ on: invoicing.chosen.has(im.number) }">
                <input type="checkbox" class="sr-only" :checked="invoicing.chosen.has(im.number)" @change="toggleIm(im.number)" />
                IM-{{ im.number }}<span v-if="im.cents !== null" class="text-muted"> · {{ moneyText(im.cents, im.currency) }}</span>
              </label>
            </div>
          </div>
          <InvoiceForm
            :ims="invoicingChosen"
            :taxable="invoicingTaxable"
            :busy="busy"
            :blocked="invoicing.chosen.size === 0 ? 'Scegli almeno un IM.' : invoicingTaxable === undefined ? 'Gli IM scelti hanno valute diverse: una fattura ne ha una sola.' : null"
            @submit="saveInvoice"
            @cancel="invoicing = null"
          />
        </template>

        <p v-if="invoices.length === 0" class="p-4 text-sm text-muted">Nessuna fattura registrata per {{ project === 'all' ? 'questo cliente' : project }}.</p>
        <!-- On a phone each invoice is a card (D-293): number and total, then date, project and IM, the state, the actions. -->
        <div v-else class="overflow-x-auto">
          <table class="w-full text-[14px] max-md:block">
            <thead class="max-md:hidden">
              <tr class="border-b border-line text-left text-xs text-muted">
                <th class="px-4 py-2 font-normal">Numero</th>
                <th class="px-2 py-2 font-normal">Data</th>
                <th class="px-2 py-2 font-normal">Progetto</th>
                <th class="px-2 py-2 font-normal">IM</th>
                <th class="px-2 py-2 text-right font-normal">Totale</th>
                <th class="px-2 py-2 font-normal">Stato</th>
                <th class="px-4 py-2"><span class="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line max-md:block">
              <tr v-for="invoice in invoices" :key="invoice.id" class="max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1 max-md:px-4 max-md:py-3">
                <td class="px-4 py-2 font-mono max-md:order-1 max-md:w-[calc(100%-8.5rem)] max-md:p-0 max-md:font-semibold">{{ invoice.number }}</td>
                <td class="px-2 py-2 whitespace-nowrap max-md:order-3 max-md:p-0 max-md:text-[13px] max-md:text-muted">{{ dayText(invoice.issuedOn) }}</td>
                <td class="px-2 py-2 max-md:order-4 max-md:p-0 max-md:text-[13px]"><button type="button" class="hover:text-accent touch:min-h-11" @click="emit('project', invoice.project)">{{ invoice.project }}</button></td>
                <td class="px-2 py-2 text-muted max-md:order-5 max-md:p-0 max-md:text-[13px]">{{ imsText(invoice.ims) }}</td>
                <td class="px-2 py-2 text-right font-mono whitespace-nowrap max-md:order-2 max-md:w-32 max-md:p-0" :title="invoice.documentCents === null ? 'Imponibile: manca il totale documento' : `Imponibile ${moneyText(invoice.totalCents, invoice.currency)}`">
                  {{ moneyText(invoiceAmount(invoice), invoice.currency) }}<span v-if="invoice.documentCents === null" class="text-warn">*</span>
                </td>
                <td class="px-2 py-2 whitespace-nowrap max-md:order-6 max-md:w-full max-md:p-0 max-md:text-[13px] max-md:whitespace-normal" :class="invoice.paidOn ? 'text-ok' : invoice.overdue ? 'text-danger' : 'text-warn'">
                  <template v-if="invoice.paidOn">Pagata il {{ dayText(invoice.paidOn) }}</template><template v-else>{{ invoice.overdue ? 'Scaduta' : 'In attesa' }}<span v-if="dueText(invoice, dashboard.today)" class="text-muted"> · {{ dueText(invoice, dashboard.today) }}</span></template>
                </td>
                <td class="px-4 py-2 text-right whitespace-nowrap max-md:order-7 max-md:w-full max-md:p-0 max-md:text-left max-md:whitespace-normal">
                  <template v-if="paying?.id === invoice.id">
                    <input v-model="paying.day" type="date" class="field touch:min-h-11 px-2 py-1 text-xs text-ink" aria-label="Data del pagamento" />
                    <button type="button" class="btn ml-1 px-2 py-0.5 text-xs" :disabled="busy" @click="paying = null">Annulla</button>
                    <button type="button" class="btn btn-primary ml-1 px-2 py-0.5 text-xs font-semibold" :disabled="busy || paying.day === ''" @click="markPaid(invoice)">Segna pagata</button>
                  </template>
                  <button v-else-if="invoice.paidOn" type="button" class="btn px-2 py-0.5 text-xs" :disabled="busy" @click="markUnpaid(invoice)">Non ancora pagata</button>
                  <button v-else type="button" class="btn px-2 py-0.5 text-xs" :disabled="busy" @click="paying = { id: invoice.id, day: todayInput() }">Pagata…</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="border-t border-line px-4 py-2.5 text-xs text-muted">
          Una fattura per progetto, con gli IM chiusi di tutte le sue parti. Il totale è quello del documento; la scadenza viene dai giorni di pagamento del cliente se non l'hai scritta. Per annullare una fattura o togliere un IM usa la scheda IM del progetto.
        </p>
      </section>

      <p class="flex items-center gap-2 text-xs text-muted">
        <LabelBadge label="L2" class="text-xs" />
        Prezzi, fatture e totali stanno nel database su questo Mac e li calcola il codice. Claude, Codex e Telegram non li vedono mai, e i file IM (Interni) non contengono prezzi.
      </p>
    </template>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
}
.seg button {
  border: 0;
  background: none;
  padding: 4px 11px;
  font-size: 12.5px;
  color: var(--muted);
}
.seg button + button {
  border-left: 1px solid var(--line-strong);
}
.seg button.on {
  background: var(--glow);
  color: var(--ink);
}
.kpi {
  display: grid;
  gap: 4px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  padding: 12px 14px;
}
.kpi b {
  font: 500 22px/1.1 var(--font-mono);
}
.kpi small {
  color: var(--muted);
  font-size: 12px;
}
.chip {
  color: var(--muted);
}
.chip.on {
  border-color: var(--accent);
  background: var(--glow);
  color: var(--ink);
}
/* A finger (D-293): the segments and the chips of the filters reach the 44 px of a tap. */
@media (pointer: coarse) {
  .seg button,
  button.chip {
    min-height: 44px;
  }
}
.sw {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 3px;
  margin-right: 6px;
}
</style>

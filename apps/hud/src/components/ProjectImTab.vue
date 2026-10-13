<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { cancelImInvoice, createImInvoice, readImOverview, removeFromImInvoice, saveImBilling, saveImCalendar, saveImEnd, saveImPrice, updateImInvoice } from '../lib/api.ts';
import { ApiError } from '../lib/api.ts';
import {
  afterEnd,
  amountInput,
  billingText,
  billingErrorText,
  CALENDAR_ISSUE_TEXT,
  chosenTotal,
  dayText,
  invoiceable,
  MAX_EVERY,
  moneyText,
  parseAmount,
  priceSourceText,
  todayInput,
  totalsText,
  WEEKDAY_ORDER,
  WEEKDAY_TEXT,
  type ImBillingRow,
  type ImBillingState,
  type ImInvoice,
  type ImOverview,
  type NewInvoice,
} from '../lib/im-billing.ts';
import { imDayText, IM_STATUS_TEXT } from '../lib/im.ts';
import {
  changesText,
  fallbackCents,
  IM_FILTER_TEXT,
  imFilterCounts,
  imFilterMatch,
  imListText,
  nextIm,
  NEW_CALENDAR,
  overdueInvoices,
  paidInYear,
  priceChanges,
  priceChangeText,
  priceEditable,
  settingsChanges,
  settingsOf,
  settingsProblem,
  settingsSummary,
  settingsWrites,
  shortDay,
  todoText,
  type ImFilter,
  type ImSettings,
  type RowMenuItem,
} from '../lib/projects-page.ts';
import type { BrowsableContainer } from '../lib/projects.ts';
import Icon from './Icon.vue';
import InvoiceForm from './InvoiceForm.vue';
import LabelBadge from './LabelBadge.vue';
import RowMenu from './RowMenu.vue';

/**
 * The tab "IM" of "Progetti" (I-11 tappa P4d, D-167 punti 3-5, D-169), revised
 * in D-191: four numbers on top; calendar and price in one form with one save
 * bar (the file `IM/calendario.md` first, then the price); the price of one
 * IM edited in its cell, every change gathered in the bar of the table; the
 * invoices as a table, the less common actions in "⋯". The calendar file is
 * the source (Obsidian edits it too). Prices and invoices are Privati (L2): in
 * the database on this computer, never in the files IM, which the Coder reads.
 */
const props = defineProps<{ container: BrowsableContainer; amend?: string | null }>();
/** `changed`: the overview after a read or a write, for the numbers of the page header; `cardwall`: open the cardwall; `amended`: the invoice of the address was opened. */
const emit = defineEmits<{ changed: [overview: ImOverview]; cardwall: []; amended: [] }>();

const overview = ref<ImOverview | null>(null);
const problem = ref<string | null>(null);
const notice = ref<{ tone: 'ok' | 'danger' | 'info'; text: string } | null>(null);
const busy = ref(false);

// --- Calendar and price: what the core has (base) and the form being changed
const base = ref<ImSettings>({ calendar: null, end: '', price: '', currency: 'EUR' });
const form = ref<ImSettings>({ calendar: null, end: '', price: '', currency: 'EUR' });
const copy = (settings: ImSettings): ImSettings => ({ ...settings, calendar: settings.calendar === null ? null : { ...settings.calendar } });
const changes = computed(() => settingsChanges(base.value, form.value));
const formProblem = computed(() => settingsProblem(form.value));

/** A new overview from the core; the form keeps what the user is changing and follows the rest. */
function adopt(next: ImOverview, reset = false): void {
  const dirty = changes.value.length > 0;
  overview.value = next;
  // Today and the year read again with every overview: a page left open past midnight counts the right day.
  today.value = todayInput();
  year.value = new Date().getFullYear();
  base.value = settingsOf(next);
  if (reset || !dirty) form.value = copy(base.value);
  emit('changed', next);
}

async function load(keepForm = false): Promise<void> {
  const name = props.container.name;
  try {
    const found = await readImOverview(name);
    if (props.container.name !== name) return;
    problem.value = null;
    adopt(found, !keepForm);
    openAmend(found);
  } catch (cause) {
    if (props.container.name === name) problem.value = billingErrorText(cause);
  }
}

/** Once, the invoice the address names (from the dashboard of the client, D-190): its "Totale e scadenza…" open and in view. */
let amendDone = false;
function openAmend(found: ImOverview): void {
  if (amendDone || props.amend === undefined || props.amend === null) return;
  amendDone = true;
  // Used once: back on this tab later, the invoice of the address is not opened again.
  emit('amended');
  const invoice = found.invoices.find((item) => item.id === props.amend);
  if (invoice === undefined) return;
  startAmending(invoice);
  void nextTick(() => document.getElementById(`im-invoice-${invoice.id}`)?.scrollIntoView({ block: 'center' }));
}

/** Every other change: the new overview from the core, or the error in words (a stale calendar is read again). */
async function run(action: () => Promise<ImOverview>, done?: string): Promise<boolean> {
  const name = props.container.name;
  busy.value = true;
  notice.value = null;
  try {
    const next = await action();
    if (props.container.name !== name) return false;
    adopt(next);
    if (done !== undefined) notice.value = { tone: 'ok', text: done };
    return true;
  } catch (cause) {
    if (props.container.name !== name) return false;
    notice.value = { tone: 'danger', text: billingErrorText(cause) };
    if (cause instanceof ApiError && cause.status === 409) await load(true);
    return false;
  } finally {
    busy.value = false;
  }
}

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];
const currencies = computed(() => (CURRENCIES.includes(form.value.currency) ? CURRENCIES : [...CURRENCIES, form.value.currency]));

/** Which fields differ from the core: they get the colour of a change. */
const changedField = computed(() => {
  const before = base.value;
  const after = form.value;
  const calendarNew = before.calendar === null && after.calendar !== null;
  return {
    weekday: calendarNew || (after.calendar !== null && before.calendar?.weekday !== after.calendar.weekday),
    time: calendarNew || (after.calendar !== null && before.calendar?.time !== after.calendar.time),
    every: calendarNew || (after.calendar !== null && before.calendar?.every !== after.calendar.every),
    end: before.end !== after.end,
    price: parseAmount(before.price) !== parseAmount(after.price),
    // Another currency without a price writes nothing (settingsWrites): no colour of a change.
    currency: before.currency !== after.currency && parseAmount(after.price) !== null,
  };
});
const CHANGED = 'border-accent bg-accent/5';

/** "Crea il calendario" or "Correggi qui": the form gets a calendar to write in the file. */
function startCalendar(): void {
  form.value = { ...form.value, calendar: { ...NEW_CALENDAR } };
}

/**
 * One "Salva" for calendar and price: two writes in a row with the routes of
 * the core, the file first (calendar, then end), then the price. When the
 * price fails the file stays saved and the bar keeps only the price.
 */
async function saveSettings(): Promise<void> {
  const current = overview.value;
  if (current === null || busy.value || formProblem.value !== null) return;
  const target = copy(form.value);
  const writes = settingsWrites(base.value, target);
  const name = props.container.name;
  busy.value = true;
  notice.value = null;
  let next = current;
  let fileDone = false;
  try {
    try {
      if (writes.calendar && target.calendar !== null) {
        next = await saveImCalendar(name, { ...target.calendar }, next.calendar.version);
        if (props.container.name !== name) return;
        fileDone = true;
        adopt(next);
      }
      if (writes.end) {
        next = await saveImEnd(name, target.end === '' ? null : target.end, next.calendar.version);
        if (props.container.name !== name) return;
        fileDone = true;
        adopt(next);
      }
    } catch (cause) {
      if (props.container.name !== name) return;
      if (cause instanceof ApiError && cause.status === 409) {
        await load(true);
        notice.value = { tone: 'info', text: 'Il calendario è stato cambiato fuori (forse in Obsidian) mentre lo modificavi: ho riletto il file. Le tue modifiche sono ancora nei campi; controlla e salva di nuovo.' };
      } else notice.value = { tone: 'danger', text: `${fileDone ? 'La fine degli IM non è salvata' : 'Il calendario non è salvato'}: ${billingErrorText(cause)}` };
      return;
    }
    if (writes.price) {
      const cents = parseAmount(target.price);
      if (cents === undefined) return;
      try {
        next = await saveImPrice(name, cents, target.currency);
        if (props.container.name !== name) return;
        adopt(next);
      } catch (cause) {
        if (props.container.name !== name) return;
        notice.value = { tone: 'danger', text: `${fileDone ? 'Il calendario è salvato nel file, il prezzo no' : 'Il prezzo non è salvato'}: ${billingErrorText(cause)} Il prezzo resta da salvare nella barra qui sotto.` };
        return;
      }
    }
    form.value = copy(base.value);
    const parts = [...(fileDone ? [`calendario salvato in ${next.calendar.path}`] : []), ...(writes.price ? ['prezzo salvato: vale per gli IM ancora aperti'] : [])];
    notice.value = { tone: 'ok', text: `${parts.join('; ').replace(/^./, (first) => first.toUpperCase())}.` };
  } finally {
    busy.value = false;
  }
}

// --- The IM, with the price of one of them changed in its cell
const projectCents = computed(() => overview.value?.price?.amountCents ?? null);
const allRows = computed(() => [...(overview.value?.ims ?? [])].reverse());
const filter = ref<ImFilter>('all');
const counts = computed(() => imFilterCounts(allRows.value));
const rows = computed(() => allRows.value.filter((row) => imFilterMatch(row, filter.value)));
const FILTERS = Object.keys(IM_FILTER_TEXT) as ImFilter[];

const edits = ref<Map<number, string>>(new Map());
const cell = ref<{ number: number; text: string } | null>(null);
const priceList = computed(() => priceChanges(overview.value?.ims ?? [], edits.value));
const priceChanged = (number: number): boolean => priceList.value.some((change) => change.number === number);
const priceInvalid = computed(() => priceList.value.some((change) => change.invalid));
const rowCurrency = (number: number): string => overview.value?.ims.find((row) => row.number === number)?.currency ?? 'EUR';
const rowOf = (number: number): ImBillingRow | undefined => overview.value?.ims.find((row) => row.number === number);
const priceBarText = computed(() =>
  changesText(
    priceList.value.map((change) => {
      const row = rowOf(change.number);
      return priceChangeText(change, rowCurrency(change.number), row === undefined ? null : fallbackCents(row, projectCents.value));
    }),
    ['prezzo cambiato', 'prezzi cambiati'],
  ),
);

function setEdit(number: number, text: string | undefined): void {
  const next = new Map(edits.value);
  if (text === undefined) next.delete(number);
  else next.set(number, text);
  edits.value = next;
}

function startCell(row: ImBillingRow): void {
  if (!priceEditable(row) || busy.value) return;
  cell.value = { number: row.number, text: edits.value.get(row.number) ?? amountInput(row.amountCents) };
  void nextTick(() => {
    const input = document.getElementById('im-price-cell');
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  });
}

/** Enter or leaving the field keeps what was typed (a mark of change when it differs); Esc drops it. */
function endCell(keep: boolean): void {
  const open = cell.value;
  if (open === null) return;
  cell.value = null;
  if (!keep) return;
  setEdit(open.number, open.text.trim());
  if (!priceChanged(open.number)) setEdit(open.number, undefined);
}

/** The amount a cell shows: the one typed, or the IM's. */
function cellAmount(row: ImBillingRow): string {
  const typed = edits.value.get(row.number);
  if (typed !== undefined && priceChanged(row.number)) {
    const cents = parseAmount(typed);
    if (cents === undefined) return typed;
    const shown = cents ?? fallbackCents(row, projectCents.value);
    return shown === null ? '—' : moneyText(shown, row.currency);
  }
  return row.amountCents === null ? '—' : moneyText(row.amountCents, row.currency);
}

/** "usa 450,00 €": back to the price of the project (or the one fixed at closing). */
function resetText(row: ImBillingRow): string {
  const cents = fallbackCents(row, projectCents.value);
  return cents === null ? 'usa il prezzo del progetto' : `usa ${moneyText(cents, row.currency)}`;
}

/** One "Salva" for every price changed: one write per IM, in a row; a failure keeps the ones left. */
async function savePrices(): Promise<void> {
  const name = props.container.name;
  const list = priceList.value.filter((change) => !change.invalid);
  if (list.length === 0 || busy.value || priceInvalid.value) return;
  busy.value = true;
  notice.value = null;
  const saved: number[] = [];
  try {
    for (const change of list) {
      const next = await saveImBilling(name, change.number, change.to, false);
      if (props.container.name !== name) return;
      setEdit(change.number, undefined);
      saved.push(change.number);
      adopt(next);
    }
    notice.value = { tone: 'ok', text: saved.length === 1 ? `Prezzo di IM-${String(saved[0])} salvato.` : `Prezzi salvati: ${imListText(saved)}.` };
  } catch (cause) {
    if (props.container.name !== name) return;
    const left = list.find((change) => !saved.includes(change.number));
    notice.value = { tone: 'danger', text: `${saved.length > 0 ? `Salvati ${imListText(saved)}; ` : ''}IM-${String(left?.number ?? 0)} non è salvato: ${billingErrorText(cause)}` };
    if (cause instanceof ApiError && cause.status === 409) await load(true);
  } finally {
    busy.value = false;
  }
}

function rowMenu(row: ImBillingRow): RowMenuItem[] {
  return [
    ...(row.invoice === null ? [row.notBilled ? { id: 'bill', text: 'Torna da fatturare' } : { id: 'skip', text: 'Non si fattura' }] : [{ id: 'invoice', text: `Vai alla fattura ${row.invoice.number}` }]),
    { id: 'cardwall', text: 'Apri il cardwall' },
  ];
}

function chooseRow(row: ImBillingRow, id: string): void {
  if (id === 'cardwall') emit('cardwall');
  else if (id === 'invoice' && row.invoice !== null) document.getElementById(`im-invoice-${row.invoice.id}`)?.scrollIntoView({ block: 'center' });
  else if (id === 'skip' || id === 'bill') {
    setEdit(row.number, undefined);
    const notBilled = id === 'skip';
    void run(() => saveImBilling(props.container.name, row.number, row.overrideCents, notBilled), notBilled ? `IM-${String(row.number)} non si fattura.` : `IM-${String(row.number)} torna da fatturare.`);
  }
}

const doneText = (row: ImBillingRow): string => {
  const total = row.counts.todo + row.counts.doing + row.counts.done + row.counts.postponed;
  return total === 0 ? 'nessuna voce' : `${String(row.counts.done)}/${String(total)} fatte`;
};
const donePercent = (row: ImBillingRow): number => {
  const total = row.counts.todo + row.counts.doing + row.counts.done + row.counts.postponed;
  return total === 0 ? 0 : Math.round((row.counts.done * 100) / total);
};

const PILL = 'inline-flex items-center rounded-full border px-2 py-px text-[12.5px] leading-normal whitespace-nowrap';
const STATE_PILL: Record<ImBillingState, string> = {
  open: 'border-transparent text-muted',
  'no-price': 'border-warn/60 text-warn',
  'not-billed': 'border-line-strong text-muted',
  'to-invoice': 'border-accent/60 text-accent',
  invoiced: 'border-line-strong text-ink',
  paid: 'border-ok/60 text-ok',
};

// --- A new invoice from the IM chosen
const chosen = ref<Set<number>>(new Set());
const toInvoice = computed(() => invoiceable(overview.value?.ims ?? []));
const total = computed(() => chosenTotal(overview.value?.ims ?? [], chosen.value));
const invoicing = ref(false);

function toggle(number: number): void {
  const next = new Set(chosen.value);
  if (next.has(number)) next.delete(number);
  else next.add(number);
  chosen.value = next;
}

function chooseAll(): void {
  chosen.value = chosen.value.size === toInvoice.value.length ? new Set() : new Set(toInvoice.value.map((row) => row.number));
}

const chosenList = computed(() => [...chosen.value].sort((a, b) => a - b));
/** A chosen IM with a price typed and not saved: the invoice waits, or it would take the old price. */
const pendingChosen = computed(() => priceList.value.filter((change) => chosen.value.has(change.number)).map((change) => change.number));

async function saveInvoice(invoice: NewInvoice): Promise<void> {
  if (chosen.value.size === 0 || pendingChosen.value.length > 0) return;
  const ims = chosenList.value;
  const ok = await run(async () => (await createImInvoice(props.container.name, { ...invoice, ims })).overview, `Fattura ${invoice.number} registrata.`);
  if (ok) {
    invoicing.value = false;
    chosen.value = new Set();
  }
}

// --- The invoices
// Today, read again with every overview: a page left open past midnight counts the right day.
const today = ref(todayInput());
const paying = ref<{ id: string; day: string } | null>(null);
const cancelling = ref<string | null>(null);
const overdue = computed(() => overdueInvoices(overview.value?.invoices ?? [], today.value));
const firstOverdue = computed(() => overdue.value[0] ?? null);
const isOverdue = (invoice: ImInvoice): boolean => overdue.value.some((item) => item.id === invoice.id);

// The total of the document and the due date of an invoice already registered (D-170).
const amending = ref<{ id: string; document: string; dueOn: string } | null>(null);
// An invoice registered before D-170 may get only its due date: its total of the document stays empty.
const amendingCents = computed(() => (amending.value === null ? undefined : parseAmount(amending.value.document)));
const amendingValid = computed(() => typeof amendingCents.value === 'number' || (amendingCents.value === null && overview.value?.invoices.find((invoice) => invoice.id === amending.value?.id)?.documentCents === null));

function startAmending(invoice: ImInvoice): void {
  paying.value = null;
  cancelling.value = null;
  amending.value = { id: invoice.id, document: amountInput(invoice.documentCents), dueOn: invoice.dueOn ?? '' };
}

async function saveAmending(invoice: ImInvoice): Promise<void> {
  const edit = amending.value;
  const cents = amendingCents.value;
  if (edit === null || !amendingValid.value) return;
  const change = { dueOn: edit.dueOn === '' ? null : edit.dueOn, ...(typeof cents === 'number' ? { documentCents: cents } : {}) };
  if (await run(() => updateImInvoice(props.container.name, invoice.id, change), `Fattura ${invoice.number} aggiornata.`)) amending.value = null;
}

function startPaying(invoice: ImInvoice): void {
  amending.value = null;
  cancelling.value = null;
  paying.value = { id: invoice.id, day: todayInput() };
  void nextTick(() => document.getElementById(`im-invoice-${invoice.id}`)?.scrollIntoView({ block: 'nearest' }));
}

async function markPaid(invoice: ImInvoice): Promise<void> {
  const day = paying.value?.id === invoice.id ? paying.value.day : todayInput();
  if (await run(() => updateImInvoice(props.container.name, invoice.id, { paidOn: day }), `Fattura ${invoice.number} segnata pagata.`)) paying.value = null;
}

function markUnpaid(invoice: ImInvoice): void {
  void run(() => updateImInvoice(props.container.name, invoice.id, { paidOn: null }), `Fattura ${invoice.number} di nuovo in attesa di pagamento.`);
}

async function cancel(invoice: ImInvoice): Promise<void> {
  if (await run(() => cancelImInvoice(props.container.name, invoice.id), `Fattura ${invoice.number} annullata: i suoi IM tornano da fatturare.`)) cancelling.value = null;
}

function removeIm(invoice: ImInvoice, im: number): void {
  void run(() => removeFromImInvoice(props.container.name, invoice.id, im), `IM-${String(im)} tolto dalla fattura ${invoice.number}.`);
}

function invoiceMenu(invoice: ImInvoice): RowMenuItem[] {
  return [
    { id: 'amend', text: 'Totale e scadenza…' },
    ...(invoice.ims.length > 1 ? invoice.ims.map((im) => ({ id: `remove:${String(im)}`, text: `Togli IM-${String(im)} dalla fattura` })) : []),
    { id: 'cancel', text: 'Annulla fattura', danger: true },
  ];
}

function chooseInvoice(invoice: ImInvoice, id: string): void {
  if (id === 'amend') startAmending(invoice);
  else if (id === 'cancel') {
    amending.value = null;
    paying.value = null;
    cancelling.value = invoice.id;
  } else if (id.startsWith('remove:')) removeIm(invoice, Number(id.slice('remove:'.length)));
}

function invoiceState(invoice: ImInvoice): { text: string; class: string } {
  if (invoice.paidOn !== null) return { text: `Pagata il ${shortDay(invoice.paidOn)}`, class: 'border-ok/60 text-ok' };
  if (isOverdue(invoice)) return { text: 'Scaduta', class: 'border-danger/60 text-danger' };
  return { text: 'In attesa', class: 'border-warn/60 text-warn' };
}

// --- The numbers at the top
const year = ref(new Date().getFullYear());
const next = computed(() => nextIm(overview.value?.ims ?? []));
const paidYear = computed(() => paidInYear(overview.value?.invoices ?? [], year.value));
const lastPaid = computed(() => [...(overview.value?.invoices ?? [])].filter((invoice) => invoice.paidOn?.startsWith(`${String(year.value)}-`) === true).sort((a, b) => (b.paidOn ?? '').localeCompare(a.paidOn ?? ''))[0] ?? null);
const waiting = computed(() => (overview.value?.invoices ?? []).filter((invoice) => invoice.paidOn === null).length);

// Last: the immediate watch reads the state declared above.
watch(
  () => props.container.name,
  () => {
    overview.value = null;
    problem.value = null;
    chosen.value = new Set();
    invoicing.value = false;
    amending.value = null;
    paying.value = null;
    cancelling.value = null;
    edits.value = new Map();
    cell.value = null;
    notice.value = null;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-1 flex-col gap-4">
    <div v-if="problem" class="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">
      <span class="flex-1">Non riesco a leggere gli IM: {{ problem }}</span>
      <button type="button" class="btn px-2.5 py-1 text-xs" @click="load()"><Icon name="retry" :size="13" />Riprova</button>
    </div>
    <p v-else-if="overview === null" class="text-sm text-muted">Leggo gli IM…</p>
    <template v-else>
      <div
        v-if="notice"
        class="flex flex-wrap items-center gap-2.5 rounded-xl border px-3 py-2 text-[14px]"
        :class="notice.tone === 'ok' ? 'border-ok/45 bg-ok/9' : notice.tone === 'info' ? 'border-info/45 bg-info/9' : 'border-danger/50 bg-danger/10'"
        :role="notice.tone === 'danger' ? 'alert' : 'status'"
      >
        <span :class="notice.tone === 'ok' ? 'text-ok' : notice.tone === 'info' ? 'text-info' : 'text-danger'"><Icon :name="notice.tone === 'ok' ? 'saved' : notice.tone === 'info' ? 'info' : 'warning'" :size="15" /></span>
        <span class="min-w-0 flex-1">{{ notice.text }}</span>
        <button type="button" class="btn px-2 py-0.5 text-xs" @click="notice = null">Chiudi</button>
      </div>

      <!-- THE NUMBERS AT THE TOP (D-191) -->
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <section class="hud-card flex flex-col gap-1 px-4 py-3" aria-label="Da fatturare">
          <h3 class="hud-title">Da fatturare</h3>
          <p class="text-[22px] leading-tight font-semibold tabular-nums">{{ totalsText(overview.totals.toInvoice) }}</p>
          <p class="text-[13px] text-muted">{{ toInvoice.length === 0 ? 'nessun IM chiuso da fatturare' : `${imListText(toInvoice.map((row) => row.number))}, IVA esclusa` }}</p>
        </section>
        <section class="hud-card flex flex-col gap-1 px-4 py-3" :class="overdue.length > 0 ? 'danger' : ''" aria-label="In attesa di pagamento">
          <h3 class="hud-title">In attesa</h3>
          <p class="text-[22px] leading-tight font-semibold tabular-nums">{{ totalsText(overview.totals.invoiced) }}</p>
          <p v-if="firstOverdue && firstOverdue.due" class="text-[13px] text-danger">
            {{ firstOverdue.number }} scaduta il {{ shortDay(firstOverdue.due) }}<template v-if="overdue.length > 1"> e altre {{ overdue.length - 1 }}</template>
          </p>
          <p v-else class="text-[13px] text-muted">{{ waiting === 0 ? 'nessuna fattura in attesa' : waiting === 1 ? '1 fattura in attesa' : `${String(waiting)} fatture in attesa` }}</p>
        </section>
        <section class="hud-card flex flex-col gap-1 px-4 py-3" :aria-label="`Incassato nel ${String(year)}`">
          <h3 class="hud-title">Incassato {{ year }}</h3>
          <p class="text-[22px] leading-tight font-semibold tabular-nums">{{ totalsText(paidYear) }}</p>
          <p class="text-[13px] text-muted">{{ lastPaid && lastPaid.paidOn ? `ultima: ${lastPaid.number}, pagata il ${shortDay(lastPaid.paidOn)}` : `nessuna fattura pagata nel ${String(year)}` }}</p>
        </section>
        <section class="hud-card flex flex-col gap-1 px-4 py-3" aria-label="Prossimo IM">
          <h3 class="hud-title">Prossimo IM</h3>
          <p class="text-[22px] leading-tight font-semibold">{{ next ? imDayText(next.date) : '—' }}</p>
          <p class="text-[13px] text-muted">{{ next ? `IM-${String(next.number)} · ${todoText(next.counts)}` : 'nessun IM aperto' }}</p>
        </section>
      </div>

      <!-- CALENDAR AND PRICE: one form, one save bar (D-191) -->
      <section class="rounded-2xl border border-line bg-surface-2" aria-labelledby="im-settings-title">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
          <h2 id="im-settings-title" class="text-[16px] font-semibold">Calendario e prezzo</h2>
          <span class="text-[14px] text-muted">{{ settingsSummary(overview) }}</span>
        </header>
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div class="flex flex-col gap-3 px-4 py-3.5">
            <p class="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
              Calendario <LabelBadge label="L1" />
              <span class="ml-auto font-mono text-[13px] font-normal text-muted">{{ overview.calendar.path }}</span>
            </p>
            <template v-if="form.calendar === null">
              <div v-if="overview.calendar.issue" class="flex flex-wrap items-center gap-2.5 rounded-xl border border-warn/50 bg-warn/10 px-3 py-2 text-[14px]">
                <span class="text-warn"><Icon name="warning" :size="15" /></span>
                <span class="min-w-0 flex-1"><span class="font-mono text-[13px]">{{ overview.calendar.path }}</span> non vale: {{ CALENDAR_ISSUE_TEXT[overview.calendar.issue] }}. Finché non lo correggi, ogni IM arriva sette giorni dopo l’ultimo.</span>
                <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy" @click="startCalendar">Correggi qui</button>
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="load(true)"><Icon name="retry" :size="13" />Rileggi il file</button>
              </div>
              <div v-else class="flex flex-wrap items-center gap-2.5 text-[14px]">
                <span class="min-w-0 flex-1 text-muted">Nessun calendario: ogni IM nuovo arriva sette giorni dopo l’ultimo.</span>
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="startCalendar"><Icon name="calendar" :size="13" />Crea il calendario</button>
              </div>
            </template>
            <div v-else class="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-6">
              <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-2">Giorno
                <select v-model.number="form.calendar.weekday" class="field px-2 py-1.5 text-[14px] text-ink" :class="changedField.weekday ? CHANGED : ''" :disabled="busy">
                  <option v-for="day in WEEKDAY_ORDER" :key="day" :value="day">{{ WEEKDAY_TEXT[day] }}</option>
                </select>
              </label>
              <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-2">Ora
                <input v-model="form.calendar.time" type="time" class="field px-2 py-1.5 text-[14px] text-ink" :class="changedField.time ? CHANGED : ''" :disabled="busy" />
              </label>
              <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-2">Ogni
                <span class="flex items-center gap-1.5 text-[14px] text-ink">
                  <input v-model.number="form.calendar.every" type="number" min="1" :max="MAX_EVERY" class="field w-[72px] px-2 py-1.5 text-[14px]" :class="changedField.every ? CHANGED : ''" :disabled="busy" />
                  settimane
                </span>
              </label>
            </div>
            <div v-if="overview.calendar.calendar && overview.calendar.issue" class="flex items-center gap-2.5 rounded-xl border border-warn/50 bg-warn/10 px-3 py-2 text-[14px]">
              <span class="text-warn"><Icon name="warning" :size="15" /></span>
              <span class="flex-1">Attenzione: {{ CALENDAR_ISSUE_TEXT[overview.calendar.issue] }}, quindi gli IM vanno avanti senza fine. Correggila qui o in Obsidian.</span>
            </div>
            <div class="grid grid-cols-1 gap-x-3 sm:grid-cols-6">
              <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-3">
                <span>Fine degli IM <span class="text-[12px]">(facoltativa)</span></span>
                <input v-model="form.end" type="date" class="field px-2 py-1.5 text-[14px] text-ink" :class="changedField.end ? CHANGED : ''" :disabled="busy" />
              </label>
              <p class="self-end pb-1.5 text-[13px] sm:col-span-3" :class="base.end !== '' ? 'text-warn' : 'text-muted'">
                {{ base.end !== '' ? `Gli IM finiscono il ${dayText(base.end)}: dopo non ne nasce nessuno; all’ultimo le voci non finite restano come card nel cardwall.` : 'Dopo questa data non nasce nessun IM. Vuota: vanno avanti.' }}
              </p>
            </div>
            <p class="text-[13px] text-muted">Il file è la fonte: lo puoi cambiare anche in Obsidian. È Interno come gli IM; il prezzo non ci va mai.</p>
          </div>
          <div class="flex flex-col gap-3 border-t border-line px-4 py-3.5 lg:border-t-0 lg:border-l">
            <p class="flex items-center gap-2 text-[14.5px] font-semibold">Prezzo per IM <LabelBadge label="L2" /></p>
            <div class="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
              <label class="flex flex-col gap-1 text-[13px] text-muted">Imponibile, IVA esclusa
                <input v-model="form.price" inputmode="decimal" class="field px-2 py-1.5 text-[14px] text-ink tabular-nums" :class="changedField.price ? CHANGED : ''" placeholder="450" :disabled="busy" />
              </label>
              <label class="flex flex-col gap-1 text-[13px] text-muted">Valuta
                <select v-model="form.currency" class="field px-2 py-1.5 text-[14px] text-ink" :class="changedField.currency ? CHANGED : ''" :disabled="busy">
                  <option v-for="code in currencies" :key="code" :value="code">{{ code }}</option>
                </select>
              </label>
            </div>
            <p class="text-[13px] text-muted">
              Si fissa su ogni IM quando si chiude: un cambio vale per gli IM ancora aperti<template v-if="next"> (da IM-{{ next.number }})</template>. Resta su questo computer, mai nei file IM né nel cloud.
            </p>
          </div>
        </div>
        <div v-if="changes.length > 0" class="flex flex-wrap items-center gap-2.5 rounded-b-2xl border-t border-line-strong bg-accent/7 px-4 py-2.5 text-[14px]">
          <span class="min-w-0 flex-1">
            {{ changesText(changes) }}
            <span v-if="formProblem" class="block text-danger">{{ formProblem }}</span>
          </span>
          <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="form = copy(base)">Annulla</button>
          <button type="button" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || formProblem !== null" @click="saveSettings">Salva</button>
        </div>
      </section>

      <!-- EVERY IM -->
      <section v-if="allRows.length === 0" class="flex max-w-2xl flex-col items-start gap-2 rounded-2xl border border-line bg-surface-2 p-4" aria-label="Nessun IM">
        <p class="text-[14.5px]">Questo progetto non ha ancora IM. Scegli giorno e ora qui sopra in «Calendario e prezzo» e salva: il primo IM nasce dal calendario. Oppure crealo a mano dal cardwall.</p>
        <button type="button" class="btn px-2.5 py-1 text-xs" @click="emit('cardwall')"><Icon name="cardwall" :size="13" />Apri il cardwall</button>
      </section>
      <section v-else class="rounded-2xl border border-line bg-surface-2" aria-labelledby="im-list-title">
        <header class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h2 id="im-list-title" class="mr-1.5 text-[16px] font-semibold">IM</h2>
          <button
            v-for="key in FILTERS"
            :key="key"
            type="button"
            class="rounded-full border px-2.5 py-0.5 text-[13px]"
            :class="filter === key ? 'border-accent bg-accent/14 font-semibold text-ink' : 'border-line-strong text-muted hover:text-ink'"
            :aria-pressed="filter === key"
            @click="filter = key"
          >
            {{ IM_FILTER_TEXT[key] }} · {{ counts[key] }}
          </button>
          <span class="ml-auto text-[13px] text-muted">
            <template v-if="toInvoice.length === 0">nessun IM da fatturare</template>
            <template v-else-if="chosen.size === 0">{{ toInvoice.length === 1 ? '1 da fatturare' : `${String(toInvoice.length)} da fatturare` }}: sceglili per la fattura</template>
            <template v-else>{{ chosen.size === 1 ? '1 scelto' : `${String(chosen.size)} scelti` }} · {{ total ? moneyText(total.cents, total.currency) : 'valute diverse' }}</template>
          </span>
          <button type="button" class="btn btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold" :disabled="busy || chosen.size === 0 || total === undefined || pendingChosen.length > 0" :title="pendingChosen.length > 0 ? `Salva prima il prezzo di ${imListText(pendingChosen)}` : undefined" @click="invoicing = true">
            <Icon name="new" :size="13" />Fattura{{ chosen.size > 0 ? ` con ${chosen.size === 1 ? '1 IM' : `${String(chosen.size)} IM`}` : '' }}
          </button>
        </header>

        <p v-if="pendingChosen.length > 0" class="border-b border-line px-4 py-2 text-[13px] text-warn">Il prezzo di {{ imListText(pendingChosen) }} è cambiato ma non salvato: salvalo o annullalo nella barra in fondo alla tabella prima di fare la fattura.</p>
        <InvoiceForm v-if="invoicing" :ims="chosenList" :taxable="total" :busy="busy" @submit="saveInvoice" @cancel="invoicing = false" />

        <p v-if="rows.length === 0" class="p-4 text-[14px] text-muted">Nessun IM {{ IM_FILTER_TEXT[filter].toLowerCase() }}.</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full border-collapse text-[14px]">
            <thead>
              <tr class="border-b border-line-strong text-left text-[13px] text-muted">
                <th class="w-9 py-2 pr-1 pl-4 font-medium">
                  <input type="checkbox" class="size-4 accent-accent" :checked="toInvoice.length > 0 && chosen.size === toInvoice.length" :disabled="busy || toInvoice.length === 0" aria-label="Scegli tutti i da fatturare" @change="chooseAll" />
                </th>
                <th class="px-2 py-2 font-medium">IM</th>
                <th class="px-2 py-2 font-medium">Stato</th>
                <th class="px-2 py-2 font-medium">Voci</th>
                <th class="px-2 py-2 text-right font-medium">Prezzo</th>
                <th class="px-2 py-2 font-medium">Fatturazione</th>
                <th class="w-11 py-2 pr-3"><span class="sr-only">Altro</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.number" class="border-b border-line last:border-b-0" :class="priceChanged(row.number) ? 'bg-accent/5' : ''">
                <td class="py-2 pr-1 pl-4">
                  <input v-if="row.state === 'to-invoice'" type="checkbox" class="size-4 accent-accent" :checked="chosen.has(row.number)" :aria-label="`Scegli IM-${String(row.number)} per la fattura`" :disabled="busy" @change="toggle(row.number)" />
                </td>
                <td class="px-2 py-2 whitespace-nowrap">
                  <b class="font-semibold">IM-{{ row.number }}</b>
                  <span class="ml-1.5 text-[13px] text-muted">{{ imDayText(row.date) }}</span>
                  <LabelBadge v-if="row.label !== 'L1'" :label="row.label" dot class="ml-1.5" />
                  <span v-if="afterEnd(row.date, overview.calendar.end)" class="ml-1.5 text-[12.5px] text-warn">dopo la fine</span>
                </td>
                <td class="px-2 py-2">
                  <span :class="[PILL, row.status === 'chiuso' ? 'border-line-strong text-ink' : 'border-accent/60 text-accent']">{{ IM_STATUS_TEXT[row.status] }}</span>
                </td>
                <td class="px-2 py-2 whitespace-nowrap text-muted">
                  {{ doneText(row) }}
                  <span class="ml-2 inline-block h-[5px] w-14 overflow-hidden rounded-full bg-bg align-middle" aria-hidden="true"><span class="block h-full bg-accent" :style="{ width: `${String(donePercent(row))}%` }" /></span>
                </td>
                <td class="px-2 py-2 text-right">
                  <span class="inline-flex flex-col items-end">
                    <input
                      v-if="cell?.number === row.number"
                      id="im-price-cell"
                      v-model="cell.text"
                      inputmode="decimal"
                      class="field w-28 px-2 py-1 text-right text-[14px] tabular-nums"
                      :aria-label="`Prezzo di IM-${String(row.number)}; vuoto: ${resetText(row).replace('usa ', '')}`"
                      @keydown.enter.prevent="endCell(true)"
                      @keydown.esc.prevent="endCell(false)"
                      @blur="endCell(true)"
                    />
                    <button
                      v-else-if="priceEditable(row)"
                      type="button"
                      class="rounded-md border border-dashed border-transparent px-2 py-0.5 font-semibold whitespace-nowrap tabular-nums hover:border-line-strong hover:bg-surface"
                      :class="priceChanged(row.number) && priceList.find((change) => change.number === row.number)?.invalid ? 'text-danger' : ''"
                      title="Clic per cambiare il prezzo di questo IM"
                      :disabled="busy"
                      @click="startCell(row)"
                    >
                      {{ cellAmount(row) }}
                    </button>
                    <span
                      v-else-if="row.invoice"
                      class="inline-flex items-center gap-1 px-2 py-0.5 whitespace-nowrap text-ink tabular-nums"
                      :title="`È nella fattura ${row.invoice.number}: per cambiarlo togli l’IM dalla fattura o annullala`"
                      ><Icon name="private" :size="12" class="text-muted" />{{ cellAmount(row) }}</span
                    >
                    <span v-else class="px-2 py-0.5 text-muted">—</span>
                    <span class="px-2 text-[12.5px] whitespace-nowrap text-muted">
                      <template v-if="priceChanged(row.number)">da salvare</template>
                      <template v-else>
                        {{ priceSourceText(row) }}<template v-if="row.overrideCents !== null && priceEditable(row)"> · <button type="button" class="text-accent hover:underline" :disabled="busy" @click="setEdit(row.number, '')">{{ resetText(row) }}</button></template>
                      </template>
                    </span>
                  </span>
                </td>
                <td class="px-2 py-2">
                  <span :class="[PILL, STATE_PILL[row.state]]">{{ billingText(row) }}</span>
                </td>
                <td class="py-2 pr-3 text-right">
                  <RowMenu :items="rowMenu(row)" :label="`Altro per IM-${String(row.number)}`" :disabled="busy" @choose="chooseRow(row, $event)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="priceList.length > 0" class="flex flex-wrap items-center gap-2.5 rounded-b-2xl border-t border-line-strong bg-accent/7 px-4 py-2.5 text-[14px]">
          <span class="min-w-0 flex-1">
            {{ priceBarText }}
            <span v-if="priceInvalid" class="block text-danger">Scrivi i prezzi come 450 o 450,50; vuoto torna al prezzo del progetto.</span>
          </span>
          <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="edits = new Map()">Annulla</button>
          <button type="button" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || priceInvalid" @click="savePrices">Salva</button>
        </div>
      </section>

      <!-- THE INVOICES -->
      <section class="rounded-2xl border border-line bg-surface-2" aria-labelledby="im-invoices-title">
        <header class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h2 id="im-invoices-title" class="text-[16px] font-semibold">Fatture</h2>
          <LabelBadge label="L2" />
          <span class="ml-auto text-[13px] text-muted">{{ overview.invoices.length === 1 ? '1 fattura' : `${String(overview.invoices.length)} fatture` }} · al totale documento</span>
        </header>
        <div v-if="firstOverdue && firstOverdue.due" class="mx-4 mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-warn/50 bg-warn/10 px-3 py-2 text-[14px]">
          <span class="text-warn"><Icon name="warning" :size="15" /></span>
          <span class="min-w-0 flex-1">
            <b>{{ firstOverdue.number }} è scaduta il {{ shortDay(firstOverdue.due) }}</b>: {{ moneyText(firstOverdue.documentCents ?? firstOverdue.totalCents, firstOverdue.currency) }} da incassare<template v-if="overdue.length > 1">, e altre {{ overdue.length - 1 }} scadute</template>. Quando arriva il pagamento segnala pagata.
          </span>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="startPaying(firstOverdue)">Segna pagata…</button>
        </div>
        <p v-if="overview.invoices.length === 0" class="p-4 text-[14px] text-muted">Nessuna fattura registrata: scegli gli IM da fatturare qui sopra e premi «Fattura».</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full border-collapse text-[14px]">
            <thead>
              <tr class="border-b border-line-strong text-left text-[13px] text-muted">
                <th class="py-2 pr-2 pl-4 font-medium">Numero</th>
                <th class="px-2 py-2 font-medium">Data</th>
                <th class="px-2 py-2 font-medium">IM</th>
                <th class="px-2 py-2 text-right font-medium">Imponibile</th>
                <th class="px-2 py-2 text-right font-medium">Totale documento</th>
                <th class="px-2 py-2 font-medium">Scadenza</th>
                <th class="px-2 py-2 font-medium">Stato</th>
                <th class="py-2 pr-3"><span class="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="invoice in overview.invoices" :key="invoice.id">
                <tr :id="`im-invoice-${invoice.id}`" class="border-b border-line" :class="amending?.id === invoice.id || paying?.id === invoice.id || cancelling === invoice.id ? 'bg-surface' : ''">
                  <td class="py-2 pr-2 pl-4">
                    <b class="font-semibold whitespace-nowrap">{{ invoice.number }}</b>
                    <span v-if="invoice.note" class="block max-w-[220px] truncate text-[12.5px] text-muted" :title="invoice.note">{{ invoice.note }}</span>
                  </td>
                  <td class="px-2 py-2 whitespace-nowrap">{{ dayText(invoice.issuedOn) }}</td>
                  <td class="px-2 py-2">
                    <span class="flex flex-wrap gap-1">
                      <span v-for="im in invoice.ims" :key="im" :class="[PILL, 'border-line-strong']">IM-{{ im }}</span>
                    </span>
                  </td>
                  <td class="px-2 py-2 text-right whitespace-nowrap tabular-nums">{{ moneyText(invoice.totalCents, invoice.currency) }}</td>
                  <td class="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                    <b v-if="invoice.documentCents !== null" class="font-semibold">{{ moneyText(invoice.documentCents, invoice.currency) }}</b>
                    <span v-else class="text-warn" title="Registrata prima del totale documento: conta l’imponibile. «Totale e scadenza…» nel menu ⋯ lo scrive.">manca</span>
                  </td>
                  <td class="px-2 py-2 whitespace-nowrap">{{ invoice.due ? dayText(invoice.due) : '—' }}</td>
                  <td class="px-2 py-2"><span :class="[PILL, invoiceState(invoice).class]">{{ invoiceState(invoice).text }}</span></td>
                  <td class="py-2 pr-3 text-right whitespace-nowrap">
                    <span class="inline-flex items-center gap-1">
                      <button v-if="invoice.paidOn" type="button" class="btn px-2.5 py-0.5 text-xs" :disabled="busy" @click="markUnpaid(invoice)">Non ancora pagata</button>
                      <button v-else type="button" class="btn px-2.5 py-0.5 text-xs" :disabled="busy" @click="startPaying(invoice)">Pagata…</button>
                      <RowMenu :items="invoiceMenu(invoice)" :label="`Altro per la fattura ${invoice.number}`" :disabled="busy" @choose="chooseInvoice(invoice, $event)" />
                    </span>
                  </td>
                </tr>
                <tr v-if="amending?.id === invoice.id || paying?.id === invoice.id || cancelling === invoice.id" class="border-b border-line bg-surface">
                  <td colspan="8" class="px-4 py-2.5">
                    <div v-if="amending?.id === invoice.id" class="flex flex-wrap items-end gap-3">
                      <label class="flex flex-col gap-1 text-[13px] text-muted">Totale documento
                        <input v-model="amending.document" inputmode="decimal" class="field w-32 px-2 py-1 text-[14px] text-ink" :aria-invalid="!amendingValid" />
                      </label>
                      <label class="flex flex-col gap-1 text-[13px] text-muted">Scadenza
                        <input v-model="amending.dueOn" type="date" class="field px-2 py-1 text-[14px] text-ink" />
                      </label>
                      <span class="min-w-0 flex-1 pb-1.5 text-[13px] text-muted">Con IVA, ritenuta e bollo. Scadenza vuota: quella dei giorni di pagamento del cliente.</span>
                      <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="amending = null">Annulla</button>
                      <button type="button" class="btn btn-primary px-2.5 py-1 text-xs font-semibold" :disabled="busy || !amendingValid" @click="saveAmending(invoice)">Salva</button>
                    </div>
                    <div v-else-if="cancelling === invoice.id" class="flex flex-wrap items-center gap-2.5">
                      <span class="flex-1 text-[14px] text-danger">Annullo la fattura {{ invoice.number }}? I suoi IM tornano da fatturare.</span>
                      <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="cancelling = null">No</button>
                      <button type="button" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busy" @click="cancel(invoice)">Sì, annulla</button>
                    </div>
                    <div v-else-if="paying" class="flex flex-wrap items-end gap-3">
                      <label class="flex flex-col gap-1 text-[13px] text-muted">Pagata il
                        <input v-model="paying.day" type="date" class="field px-2 py-1 text-[14px] text-ink" aria-label="Data del pagamento" />
                      </label>
                      <span class="flex-1" />
                      <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="paying = null">Annulla</button>
                      <button type="button" class="btn btn-primary px-2.5 py-1 text-xs font-semibold" :disabled="busy || paying.day === ''" @click="markPaid(invoice)">Segna pagata</button>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>
      <p class="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
        <Icon name="private" :size="13" />Privato: prezzi e fatture restano su questo computer, mai nei file IM che legge il Coder. Le voci di ogni IM si spostano nel
        <button type="button" class="text-accent hover:underline" @click="emit('cardwall')">Cardwall</button>.
      </p>
    </template>
  </div>
</template>

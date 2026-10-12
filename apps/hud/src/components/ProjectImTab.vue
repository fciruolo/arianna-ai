<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { cancelImInvoice, createImInvoice, readImOverview, removeFromImInvoice, saveImBilling, saveImCalendar, saveImEnd, saveImPrice, updateImInvoice } from '../lib/api.ts';
import { ApiError } from '../lib/api.ts';
import {
  afterEnd,
  amountInput,
  billingText,
  billingErrorText,
  CALENDAR_ISSUE_TEXT,
  calendarText,
  chosenTotal,
  dayText,
  dueText,
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
import { imDateText, IM_STATUS_TEXT } from '../lib/im.ts';
import type { BrowsableContainer } from '../lib/projects.ts';
import Icon from './Icon.vue';
import InvoiceForm from './InvoiceForm.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * The tab "IM" of "Progetti" (I-11 tappa P4d, D-167 punti 3-5, D-169): the
 * calendar of the meetings, written in `IM/calendario.md` (the file is the
 * source, Obsidian edits it too), the price of one IM, every IM with its
 * state and money, and the invoices: one project, one or more closed IM.
 * Prices and invoices are Privati (L2): in the database on this computer,
 * never in the files IM, which the Coder reads.
 */
const props = defineProps<{ container: BrowsableContainer }>();

const overview = ref<ImOverview | null>(null);
const problem = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

async function load(): Promise<void> {
  const name = props.container.name;
  try {
    const found = await readImOverview(name);
    if (props.container.name !== name) return;
    overview.value = found;
    problem.value = null;
    fillForms(found);
  } catch (cause) {
    if (props.container.name === name) problem.value = billingErrorText(cause);
  }
}

/** Every change: the new overview from the core, or the error in words (a stale calendar is read again). */
async function run(action: () => Promise<ImOverview>, done?: string): Promise<boolean> {
  const name = props.container.name;
  busy.value = true;
  notice.value = null;
  try {
    const next = await action();
    if (props.container.name !== name) return false;
    overview.value = next;
    fillForms(next);
    if (done !== undefined) notice.value = done;
    return true;
  } catch (cause) {
    if (props.container.name !== name) return false;
    notice.value = billingErrorText(cause);
    if (cause instanceof ApiError && cause.status === 409) await load();
    return false;
  } finally {
    busy.value = false;
  }
}

// --- Calendar: in IM/calendario.md
const calendarForm = ref({ weekday: 4, time: '10:00', every: 1 });
// --- Price of one IM
const priceText = ref('');
const currency = ref('EUR');
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];
const currencies = computed(() => (CURRENCIES.includes(currency.value) ? CURRENCIES : [...CURRENCIES, currency.value]));

function fillForms(next: ImOverview): void {
  // Without a calendar, the form starts from Thursday at 10:00 (not from another project).
  calendarForm.value = next.calendar.calendar === null ? { weekday: 4, time: '10:00', every: 1 } : { ...next.calendar.calendar };
  endText.value = next.calendar.end ?? '';
  priceText.value = amountInput(next.price?.amountCents ?? null);
  currency.value = next.price?.currency ?? 'EUR';
}

const calendarValid = computed(() => /^([01]\d|2[0-3]):[0-5]\d$/.test(calendarForm.value.time) && Number.isInteger(calendarForm.value.every) && calendarForm.value.every >= 1 && calendarForm.value.every <= MAX_EVERY);

function saveCalendar(): void {
  const current = overview.value;
  if (current === null || !calendarValid.value) return;
  void run(() => saveImCalendar(props.container.name, { ...calendarForm.value }, current.calendar.version), `Calendario salvato in ${current.calendar.path}.`);
}

// --- The last day of the IM (D-169): `fine` in the same file
const endText = ref('');

function saveEnd(end: string | null): void {
  const current = overview.value;
  if (current === null) return;
  void run(() => saveImEnd(props.container.name, end, current.calendar.version), end === null ? 'Data di fine tolta: gli IM vanno avanti.' : `Gli IM finiscono il ${dayText(end)}: dopo non ne nasce nessuno.`);
}

const priceCents = computed(() => parseAmount(priceText.value));

function savePrice(): void {
  const cents = priceCents.value;
  if (cents === undefined) return;
  void run(() => saveImPrice(props.container.name, cents, currency.value), cents === null ? 'Prezzo tolto.' : 'Prezzo salvato: vale per gli IM ancora aperti.');
}

// --- The IM, with the exception of one of them
const rows = computed(() => [...(overview.value?.ims ?? [])].reverse());
const editing = ref<{ number: number; text: string; notBilled: boolean } | null>(null);
const editingCents = computed(() => (editing.value === null ? undefined : parseAmount(editing.value.text)));

function startEditing(row: ImBillingRow): void {
  editing.value = { number: row.number, text: amountInput(row.overrideCents), notBilled: row.notBilled };
}

async function saveEditing(): Promise<void> {
  const edit = editing.value;
  const cents = editingCents.value;
  if (edit === null || cents === undefined) return;
  if (await run(() => saveImBilling(props.container.name, edit.number, cents, edit.notBilled), `IM-${String(edit.number)} aggiornato.`)) editing.value = null;
}

const doneText = (row: ImBillingRow): string => {
  const total = row.counts.todo + row.counts.doing + row.counts.done + row.counts.postponed;
  return total === 0 ? 'nessuna voce' : `${String(row.counts.done)}/${String(total)} fatte`;
};

const STATE_CLASS: Record<ImBillingState, string> = {
  open: 'text-muted',
  'no-price': 'text-warn',
  'not-billed': 'text-muted',
  'to-invoice': 'text-accent',
  invoiced: 'text-ink',
  paid: 'text-ok',
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

async function saveInvoice(invoice: NewInvoice): Promise<void> {
  if (chosen.value.size === 0) return;
  const ims = chosenList.value;
  const ok = await run(async () => (await createImInvoice(props.container.name, { ...invoice, ims })).overview, `Fattura ${invoice.number} registrata.`);
  if (ok) {
    invoicing.value = false;
    chosen.value = new Set();
  }
}

// --- The invoices
const paying = ref<{ id: string; day: string } | null>(null);
const cancelling = ref<string | null>(null);

// The total of the document and the due date of an invoice already registered (D-170).
const amending = ref<{ id: string; document: string; dueOn: string } | null>(null);
// An invoice registered before D-170 may get only its due date: its total of the document stays empty.
const amendingCents = computed(() => (amending.value === null ? undefined : parseAmount(amending.value.document)));
const amendingValid = computed(() => typeof amendingCents.value === 'number' || (amendingCents.value === null && overview.value?.invoices.find((invoice) => invoice.id === amending.value?.id)?.documentCents === null));

function startAmending(invoice: ImInvoice): void {
  amending.value = { id: invoice.id, document: amountInput(invoice.documentCents), dueOn: invoice.dueOn ?? '' };
}

async function saveAmending(invoice: ImInvoice): Promise<void> {
  const edit = amending.value;
  const cents = amendingCents.value;
  if (edit === null || !amendingValid.value) return;
  const change = { dueOn: edit.dueOn === '' ? null : edit.dueOn, ...(typeof cents === 'number' ? { documentCents: cents } : {}) };
  if (await run(() => updateImInvoice(props.container.name, invoice.id, change), `Fattura ${invoice.number} aggiornata.`)) amending.value = null;
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

// Last: the immediate watch reads the state declared above.
watch(
  () => props.container.name,
  () => {
    overview.value = null;
    chosen.value = new Set();
    invoicing.value = false;
    amending.value = null;
    editing.value = null;
    notice.value = null;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-1 flex-col gap-4">
    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-else-if="overview === null" class="text-sm text-muted">Leggo gli IM…</p>
    <template v-else>
      <p v-if="notice" class="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[14px]" role="status">{{ notice }}</p>

      <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <!-- Calendar: the file IM/calendario.md -->
        <section class="rounded-2xl border border-line bg-surface" aria-labelledby="im-calendar-title">
          <header class="flex items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="calendar" :size="15" class="text-muted" />
            <h2 id="im-calendar-title" class="hud-title flex-1">Calendario</h2>
            <LabelBadge label="L1" class="text-xs" />
          </header>
          <div class="flex flex-col gap-3 px-4 py-3">
            <p v-if="overview.calendar.calendar" class="text-[14px]">IM {{ calendarText(overview.calendar.calendar) }}.</p>
            <p v-else-if="overview.calendar.issue" class="text-[14px] text-warn">Il file c’è ma non vale: {{ CALENDAR_ISSUE_TEXT[overview.calendar.issue] }}. Ogni IM nuovo arriva sette giorni dopo l’ultimo finché non lo correggi.</p>
            <p v-else class="text-[14px] text-muted">Nessun calendario: ogni IM nuovo arriva sette giorni dopo l’ultimo.</p>
            <p v-if="overview.calendar.calendar && overview.calendar.issue" class="text-[14px] text-warn">Attenzione: {{ CALENDAR_ISSUE_TEXT[overview.calendar.issue] }}, quindi gli IM vanno avanti senza fine. Correggila qui sotto o in Obsidian.</p>
            <form class="flex flex-col gap-2" @submit.prevent="saveCalendar">
              <div class="grid grid-cols-3 gap-2">
                <label class="flex flex-col gap-1 text-xs text-muted">Giorno
                  <select v-model.number="calendarForm.weekday" class="field px-2 py-1.5 text-[14px] text-ink">
                    <option v-for="day in WEEKDAY_ORDER" :key="day" :value="day">{{ WEEKDAY_TEXT[day] }}</option>
                  </select>
                </label>
                <label class="flex flex-col gap-1 text-xs text-muted">Ora
                  <input v-model="calendarForm.time" type="time" class="field px-2 py-1.5 text-[14px] text-ink" />
                </label>
                <label class="flex flex-col gap-1 text-xs text-muted">Ogni (settimane)
                  <input v-model.number="calendarForm.every" type="number" min="1" :max="MAX_EVERY" class="field px-2 py-1.5 text-[14px] text-ink" />
                </label>
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="font-mono text-[12.5px] text-muted">{{ overview.calendar.path }}</span>
                <button type="submit" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || !calendarValid">Salva nel file</button>
              </div>
            </form>
            <div class="flex flex-col gap-2 border-t border-line pt-3">
              <p v-if="overview.calendar.end" class="text-[14px] text-warn">Gli IM finiscono il {{ dayText(overview.calendar.end) }}: dopo non ne nasce nessuno, e all’ultimo le voci non finite restano come card nel cardwall.</p>
              <div class="flex flex-wrap items-end gap-2">
                <label class="flex flex-col gap-1 text-xs text-muted">Fine degli IM (facoltativa)
                  <input v-model="endText" type="date" class="field px-2 py-1.5 text-[14px] text-ink" />
                </label>
                <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy || endText === '' || endText === overview.calendar.end" @click="saveEnd(endText)">Salva la fine</button>
                <button v-if="overview.calendar.end" type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="saveEnd(null)">Togli la fine</button>
              </div>
            </div>
            <p class="text-xs text-muted">Il file è la fonte: lo cambi anche in Obsidian. È Interno come gli IM; il prezzo non ci va mai.</p>
          </div>
        </section>

        <!-- Price of one IM: private -->
        <section class="rounded-2xl border border-line bg-surface" aria-labelledby="im-price-title">
          <header class="flex items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="private" :size="15" class="text-muted" />
            <h2 id="im-price-title" class="hud-title flex-1">Prezzo per IM</h2>
            <LabelBadge label="L2" class="text-xs" />
          </header>
          <form class="flex flex-col gap-2 px-4 py-3" @submit.prevent="savePrice">
            <div class="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
              <label class="flex flex-col gap-1 text-xs text-muted">Imponibile, IVA esclusa
                <input v-model="priceText" inputmode="decimal" class="field px-2 py-1.5 text-[14px] text-ink" placeholder="450" />
              </label>
              <label class="flex flex-col gap-1 text-xs text-muted">Valuta
                <select v-model="currency" class="field px-2 py-1.5 text-[14px] text-ink">
                  <option v-for="code in currencies" :key="code" :value="code">{{ code }}</option>
                </select>
              </label>
            </div>
            <p v-if="priceCents === undefined" class="text-xs text-danger">Scrivi un importo come 450 o 450,50.</p>
            <div class="flex justify-end">
              <button type="submit" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || priceCents === undefined">Salva il prezzo</button>
            </div>
            <p class="text-xs text-muted">Si fissa su ogni IM quando si chiude: un cambio vale per gli IM ancora aperti. Resta su questo computer, mai nei file IM né nel cloud.</p>
          </form>
        </section>

        <!-- Totals -->
        <section class="rounded-2xl border border-line bg-surface" aria-labelledby="im-totals-title">
          <header class="flex items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="dashboard" :size="15" class="text-muted" />
            <h2 id="im-totals-title" class="hud-title flex-1">Totali</h2>
            <LabelBadge label="L2" class="text-xs" />
          </header>
          <dl class="grid gap-2 px-4 py-3 text-[14px]">
            <div class="flex items-baseline justify-between gap-2"><dt class="text-muted">Da fatturare</dt><dd class="font-semibold text-accent">{{ totalsText(overview.totals.toInvoice) }}</dd></div>
            <div class="flex items-baseline justify-between gap-2"><dt class="text-muted">In attesa di pagamento</dt><dd class="font-semibold">{{ totalsText(overview.totals.invoiced) }}</dd></div>
            <div class="flex items-baseline justify-between gap-2"><dt class="text-muted">Incassato</dt><dd class="font-semibold text-ok">{{ totalsText(overview.totals.paid) }}</dd></div>
          </dl>
          <p class="border-t border-line px-4 py-2.5 text-xs text-muted">Da fatturare senza IVA; fatture al totale documento. Una fattura comprende gli IM del solo progetto, con il lavoro di tutte le sue parti.</p>
        </section>
      </div>

      <!-- Every IM -->
      <section class="rounded-2xl border border-line bg-surface" aria-labelledby="im-list-title">
        <header class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="checklist" :size="15" class="text-muted" />
          <h2 id="im-list-title" class="hud-title flex-1">IM</h2>
          <template v-if="toInvoice.length > 0">
            <span class="text-xs text-muted">{{ chosen.size === 0 ? `${String(toInvoice.length)} da fatturare` : `${String(chosen.size)} scelti${total ? ` · ${moneyText(total.cents, total.currency)}` : ' · valute diverse'}` }}</span>
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="chooseAll">{{ chosen.size === toInvoice.length ? 'Nessuno' : 'Tutti i da fatturare' }}</button>
            <button type="button" class="btn btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold" :disabled="busy || chosen.size === 0 || total === undefined" @click="invoicing = true">
              <Icon name="new" :size="13" />Fattura
            </button>
          </template>
        </header>

        <InvoiceForm v-if="invoicing" :ims="chosenList" :taxable="total" :busy="busy" @submit="saveInvoice" @cancel="invoicing = false" />

        <p v-if="rows.length === 0" class="p-4 text-sm text-muted">Nessun IM ancora: il primo nasce dal cardwall con “Nuovo IM”, o dal calendario.</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-[14px]">
            <thead>
              <tr class="border-b border-line text-left text-xs text-muted">
                <th class="w-8 px-4 py-2 font-normal"><span class="sr-only">Scegli</span></th>
                <th class="px-2 py-2 font-normal">IM</th>
                <th class="px-2 py-2 font-normal">Stato</th>
                <th class="px-2 py-2 font-normal">Voci</th>
                <th class="px-2 py-2 text-right font-normal">Importo</th>
                <th class="px-2 py-2 font-normal">Fatturazione</th>
                <th class="px-4 py-2"><span class="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              <template v-for="row in rows" :key="row.number">
                <tr>
                  <td class="px-4 py-2">
                    <input v-if="row.state === 'to-invoice'" type="checkbox" :checked="chosen.has(row.number)" :aria-label="`Scegli IM-${String(row.number)} per la fattura`" :disabled="busy" @change="toggle(row.number)" />
                  </td>
                  <td class="px-2 py-2 whitespace-nowrap">
                    <span class="font-semibold">IM-{{ row.number }}</span>
                    <span class="ml-1.5 text-muted">{{ imDateText(row.date) }}</span>
                    <LabelBadge v-if="row.label !== 'L1'" :label="row.label" dot class="ml-1.5" />
                    <span v-if="afterEnd(row.date, overview.calendar.end)" class="ml-1.5 text-xs text-warn">dopo la fine</span>
                  </td>
                  <td class="px-2 py-2 whitespace-nowrap">{{ IM_STATUS_TEXT[row.status] }}</td>
                  <td class="px-2 py-2 whitespace-nowrap text-muted">{{ doneText(row) }}</td>
                  <td class="px-2 py-2 text-right whitespace-nowrap">
                    <span class="block">{{ row.amountCents === null ? '—' : moneyText(row.amountCents, row.currency) }}</span>
                    <span class="block text-[12.5px] text-muted">{{ priceSourceText(row) }}</span>
                  </td>
                  <td class="px-2 py-2 whitespace-nowrap" :class="STATE_CLASS[row.state]">
                    {{ billingText(row) }}
                  </td>
                  <td class="px-4 py-2 text-right">
                    <button v-if="row.invoice === null && editing?.number !== row.number" type="button" class="btn px-2 py-0.5 text-xs" :disabled="busy" @click="startEditing(row)">Prezzo</button>
                  </td>
                </tr>
                <tr v-if="editing?.number === row.number">
                  <td colspan="7" class="bg-surface-2 px-4 py-3">
                    <form class="flex flex-wrap items-end gap-3" @submit.prevent="saveEditing">
                      <label class="flex flex-col gap-1 text-xs text-muted">Prezzo di questo IM (vuoto: quello del progetto)
                        <input v-model="editing.text" inputmode="decimal" class="field w-40 px-2 py-1.5 text-[14px] text-ink" :disabled="editing.notBilled" placeholder="come il progetto" />
                      </label>
                      <label class="flex items-center gap-2 pb-1.5 text-[14px]"><input v-model="editing.notBilled" type="checkbox" />Non fatturato</label>
                      <span v-if="editingCents === undefined && !editing.notBilled" class="pb-1.5 text-xs text-danger">Scrivi un importo come 450 o 450,50.</span>
                      <span class="flex-1" />
                      <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="editing = null">Annulla</button>
                      <button type="submit" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || (editingCents === undefined && !editing.notBilled)">Salva</button>
                    </form>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <!-- The invoices -->
      <section class="rounded-2xl border border-line bg-surface" aria-labelledby="im-invoices-title">
        <header class="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="file" :size="15" class="text-muted" />
          <h2 id="im-invoices-title" class="hud-title flex-1">Fatture</h2>
          <LabelBadge label="L2" class="text-xs" />
        </header>
        <p v-if="overview.invoices.length === 0" class="p-4 text-sm text-muted">Nessuna fattura registrata: scegli gli IM da fatturare qui sopra e premi “Fattura”.</p>
        <ul v-else class="divide-y divide-line">
          <li v-for="invoice in overview.invoices" :key="invoice.id" class="flex flex-col gap-2 px-4 py-3">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span class="font-semibold">Fattura {{ invoice.number }}</span>
              <span class="text-muted">del {{ dayText(invoice.issuedOn) }}</span>
              <span class="font-semibold">{{ moneyText(invoice.documentCents ?? invoice.totalCents, invoice.currency) }}</span>
              <span class="text-muted">{{ invoice.documentCents === null ? 'imponibile: manca il totale documento' : `imponibile ${moneyText(invoice.totalCents, invoice.currency)}` }}</span>
              <span :class="invoice.paidOn ? 'text-ok' : invoice.due !== null && invoice.due < todayInput() ? 'text-danger' : 'text-warn'">{{ invoice.paidOn ? `Pagata il ${dayText(invoice.paidOn)}` : `In attesa di pagamento${dueText(invoice, todayInput()) ? ` · ${dueText(invoice, todayInput()) ?? ''}` : ''}` }}</span>
              <span v-if="invoice.note" class="text-muted">· {{ invoice.note }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span v-for="im in invoice.ims" :key="im" class="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs">
                IM-{{ im }}
                <button v-if="invoice.ims.length > 1" type="button" class="text-muted hover:text-danger" :aria-label="`Togli IM-${String(im)} dalla fattura ${invoice.number}`" :disabled="busy" @click="removeIm(invoice, im)"><Icon name="close" :size="11" /></button>
              </span>
              <span class="flex-1" />
              <template v-if="amending?.id === invoice.id">
                <label class="flex items-center gap-1 text-xs text-muted">Totale documento
                  <input v-model="amending.document" inputmode="decimal" class="field w-28 px-2 py-1 text-xs text-ink" :aria-invalid="!amendingValid" />
                </label>
                <label class="flex items-center gap-1 text-xs text-muted">Scadenza
                  <input v-model="amending.dueOn" type="date" class="field px-2 py-1 text-xs text-ink" />
                </label>
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="amending = null">Annulla</button>
                <button type="button" class="btn btn-primary px-2.5 py-1 text-xs font-semibold" :disabled="busy || !amendingValid" @click="saveAmending(invoice)">Salva</button>
              </template>
              <template v-else-if="cancelling === invoice.id">
                <span class="text-xs text-danger">Annullo la fattura? I suoi IM tornano da fatturare.</span>
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="cancelling = null">No</button>
                <button type="button" class="btn px-2.5 py-1 text-xs text-danger" :disabled="busy" @click="cancel(invoice)">Sì, annulla</button>
              </template>
              <template v-else-if="paying?.id === invoice.id">
                <input v-model="paying.day" type="date" class="field px-2 py-1 text-xs text-ink" aria-label="Data del pagamento" />
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="paying = null">Annulla</button>
                <button type="button" class="btn btn-primary px-2.5 py-1 text-xs font-semibold" :disabled="busy || paying.day === ''" @click="markPaid(invoice)">Segna pagata</button>
              </template>
              <template v-else>
                <button v-if="invoice.paidOn" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="markUnpaid(invoice)">Non ancora pagata</button>
                <button v-else type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="paying = { id: invoice.id, day: todayInput() }">Pagata…</button>
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="startAmending(invoice)">Totale e scadenza…</button>
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="cancelling = invoice.id">Annulla fattura</button>
              </template>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

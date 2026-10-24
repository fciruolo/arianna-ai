<script setup lang="ts">
import { computed, ref } from 'vue';

import { deleteInvoice, importInvoice, listDeadlines, listInvoices, readInvoice, setDeadlinePaid } from '../lib/api.ts';
import { bytesToBase64, dayOf, formatCents, formatDay, formatMoment } from '../lib/finance.ts';
import {
  DEADLINE_GROUP_TEXT,
  documentTypeText,
  groupDeadlines,
  importText,
  invoiceErrorText,
  invoiceFileProblem,
  paymentMethodText,
  vatRateText,
  type Deadline,
  type InvoiceDetail,
  type InvoiceSummary,
} from '../lib/invoices.ts';
import Icon from './Icon.vue';

/**
 * «Fatture e scadenze» of the finances (D-310): FatturaPA invoices (.xml, or
 * the signed .xml.p7m) read in the browser and sent in base64 to the core of
 * this Mac, which reads them with @arianna/invoices and keeps what they say,
 * never the file. Above, the instalments still to pay by due day, each
 * marked paid by hand; below, the invoices with their lines. Nothing here
 * goes to a model or out of this Mac.
 */

const busy = ref(false);
const dragging = ref(false);
const picker = ref<HTMLInputElement | null>(null);
/** One line per file of the last import: its name and what happened. */
const results = ref<{ name: string; text: string; ok: boolean }[]>([]);

const deadlines = ref<Deadline[] | null>(null);
const showPaid = ref(false);
const deadlinesProblem = ref<string | null>(null);

const invoices = ref<InvoiceSummary[] | null>(null);
const invoicesProblem = ref<string | null>(null);
const search = ref('');
const opened = ref<InvoiceDetail | null>(null);
const removing = ref<string | null>(null);

/** Today, read again at every load: a page left open past midnight groups by the new day. */
const today = ref(dayOf(new Date()));
const groups = computed(() => groupDeadlines(deadlines.value ?? [], today.value));
const paid = computed(() => (deadlines.value ?? []).filter((item) => item.paidOn !== null));

async function loadDeadlines(): Promise<void> {
  try {
    today.value = dayOf(new Date());
    deadlines.value = await listDeadlines(showPaid.value ? 'all' : 'open');
    deadlinesProblem.value = null;
  } catch (cause) {
    deadlinesProblem.value = invoiceErrorText(cause);
  }
}

async function loadInvoices(): Promise<void> {
  try {
    invoices.value = await listInvoices({ q: search.value.trim() });
    invoicesProblem.value = null;
  } catch (cause) {
    invoicesProblem.value = invoiceErrorText(cause);
  }
}

function reload(): void {
  void loadDeadlines();
  void loadInvoices();
}
reload();

async function choose(files: FileList | null | undefined): Promise<void> {
  const chosen = files === null || files === undefined ? [] : Array.from(files);
  // One import at a time: a drop while files are being read is ignored.
  if (chosen.length === 0 || busy.value) return;
  busy.value = true;
  results.value = [];
  try {
    for (const file of chosen) {
      const issue = invoiceFileProblem(file.name, file.size);
      if (issue !== null) {
        results.value.push({ name: file.name, text: issue, ok: false });
        continue;
      }
      try {
        const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        results.value.push({ name: file.name, text: importText(await importInvoice(file.name, data)), ok: true });
      } catch (cause) {
        results.value.push({ name: file.name, text: invoiceErrorText(cause), ok: false });
      }
    }
  } finally {
    busy.value = false;
  }
  if (picker.value !== null) picker.value.value = '';
  reload();
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  void choose(event.dataTransfer?.files);
}

async function markPaid(item: Deadline, isPaid: boolean): Promise<void> {
  const paidOn = isPaid ? dayOf(new Date()) : null;
  busy.value = true;
  try {
    await setDeadlinePaid(item.id, paidOn);
    await loadDeadlines();
    await loadInvoices();
    if (opened.value?.id === item.invoice) opened.value = await readInvoice(item.invoice);
  } catch (cause) {
    deadlinesProblem.value = invoiceErrorText(cause);
  } finally {
    busy.value = false;
  }
}

async function toggle(invoice: InvoiceSummary): Promise<void> {
  if (opened.value?.id === invoice.id) {
    opened.value = null;
    return;
  }
  try {
    opened.value = await readInvoice(invoice.id);
  } catch (cause) {
    invoicesProblem.value = invoiceErrorText(cause);
  }
}

async function remove(invoice: InvoiceSummary): Promise<void> {
  busy.value = true;
  try {
    await deleteInvoice(invoice.id);
    removing.value = null;
    if (opened.value?.id === invoice.id) opened.value = null;
    reload();
  } catch (cause) {
    invoicesProblem.value = invoiceErrorText(cause);
  } finally {
    busy.value = false;
  }
}

function toggleShowPaid(): void {
  showPaid.value = !showPaid.value;
  void loadDeadlines();
}

function partyText(invoice: InvoiceSummary): string {
  return `${invoice.supplier.name} → ${invoice.customer.name}`;
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- THE FILES -->
    <div
      class="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm"
      :class="dragging ? 'border-accent bg-accent/10' : 'border-line-strong bg-surface'"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <Icon name="upload" :size="22" />
      <p class="text-muted max-md:hidden">Trascina qui le fatture elettroniche</p>
      <p class="text-xs text-muted">File .xml o firmati .xml.p7m, anche più di uno, al massimo 10 MB ciascuno. Il file non viene conservato: Arianna tiene solo i dati letti.</p>
      <input ref="picker" type="file" accept=".xml,.p7m" multiple class="sr-only" aria-label="Scegli le fatture" @change="choose(($event.target as HTMLInputElement).files)" />
      <button type="button" class="btn px-3 py-1 text-xs" :disabled="busy" @click="picker?.click()">Scegli i file</button>
    </div>
    <p v-if="busy && results.length === 0" class="text-sm text-muted">Leggo le fatture…</p>
    <ul v-if="results.length > 0" class="grid gap-1 text-sm" role="status">
      <li v-for="(item, index) in results" :key="index" class="rounded-lg border px-3 py-1.5" :class="item.ok ? 'border-ok/50 bg-ok/10' : 'border-danger/50 bg-danger/10'">
        <b class="font-medium">{{ item.name }}</b>: {{ item.text }}
      </li>
    </ul>

    <!-- THE DEADLINES -->
    <section class="hud-card flex flex-col gap-3 p-4" aria-label="Scadenze delle fatture">
      <header class="flex flex-wrap items-center gap-2">
        <h3 class="hud-title">Scadenze</h3>
        <button type="button" class="ml-auto rounded-md px-2 py-1 text-xs text-muted hover:text-ink touch:min-h-11" @click="toggleShowPaid">
          {{ showPaid ? 'Nascondi le pagate' : 'Mostra anche le pagate' }}
        </button>
      </header>
      <p v-if="deadlinesProblem" class="text-sm text-danger" role="alert">{{ deadlinesProblem }}</p>
      <p v-else-if="deadlines === null" class="text-sm text-muted">Carico le scadenze…</p>
      <p v-else-if="groups.length === 0 && paid.length === 0" class="text-sm text-muted">Nessuna rata da pagare. Le scadenze arrivano dalle fatture importate (DatiPagamento).</p>
      <template v-else>
        <div v-for="entry in groups" :key="entry.group" class="flex flex-col gap-1">
          <h4 class="text-xs font-medium" :class="entry.group === 'overdue' ? 'text-danger' : 'text-muted'">{{ DEADLINE_GROUP_TEXT[entry.group] }}</h4>
          <ul class="grid gap-1">
            <li v-for="item in entry.items" :key="item.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-[14px]">
              <span class="w-24 shrink-0 tabular-nums" :class="entry.group === 'overdue' ? 'text-danger' : ''">{{ formatDay(item.dueOn) }}</span>
              <span class="min-w-0 flex-1">
                <b class="block truncate font-medium">{{ item.supplier }} → {{ item.customer }}</b>
                <span class="block text-[13px] text-muted">{{ documentTypeText(item.documentType) }} n. {{ item.number }} del {{ formatDay(item.issuedOn) }} · {{ paymentMethodText(item.method) }}</span>
              </span>
              <span class="whitespace-nowrap tabular-nums">{{ formatCents(item.amountCents, { currency: item.currency }) }}</span>
              <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="markPaid(item, true)"><Icon name="approve" :size="13" />Segna pagata</button>
            </li>
          </ul>
        </div>
        <div v-if="showPaid && paid.length > 0" class="flex flex-col gap-1">
          <h4 class="text-xs font-medium text-muted">Pagate</h4>
          <ul class="grid gap-1">
            <li v-for="item in paid" :key="item.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-[14px] text-muted">
              <span class="w-24 shrink-0 tabular-nums">{{ formatDay(item.dueOn) }}</span>
              <span class="min-w-0 flex-1 truncate">{{ item.supplier }} · n. {{ item.number }} · pagata il {{ formatDay(item.paidOn) }}</span>
              <span class="whitespace-nowrap tabular-nums">{{ formatCents(item.amountCents, { currency: item.currency }) }}</span>
              <button type="button" class="rounded-md px-2 py-1 text-xs hover:text-ink touch:min-h-11" :disabled="busy" @click="markPaid(item, false)"><Icon name="retry" :size="13" class="mr-1 inline" />Non è pagata</button>
            </li>
          </ul>
        </div>
      </template>
    </section>

    <!-- THE INVOICES -->
    <section class="flex flex-col gap-2" aria-label="Fatture importate">
      <div class="flex flex-wrap items-end gap-3">
        <h3 class="hud-title">Fatture</h3>
        <label class="ml-auto flex items-center gap-2 text-xs text-muted">
          Cerca
          <input v-model="search" type="search" class="field touch:min-h-11 px-2 py-1 text-[14px]" placeholder="Fornitore, cliente o numero" @keyup.enter="loadInvoices" @search="loadInvoices" />
        </label>
      </div>
      <p v-if="invoicesProblem" class="text-sm text-danger" role="alert">{{ invoicesProblem }}</p>
      <p v-else-if="invoices === null" class="text-sm text-muted">Carico le fatture…</p>
      <p v-else-if="invoices.length === 0" class="text-sm text-muted">{{ search.trim() === '' ? 'Ancora nessuna fattura importata.' : 'Nessuna fattura trovata.' }}</p>
      <ul v-else class="grid gap-2">
        <li v-for="invoice in invoices" :key="invoice.id" class="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2">
          <div class="flex flex-wrap items-center gap-3">
            <button type="button" class="min-w-0 flex-1 text-left touch:min-h-11" :aria-expanded="opened?.id === invoice.id" @click="toggle(invoice)">
              <b class="block truncate text-[14px] font-medium">{{ partyText(invoice) }}</b>
              <span class="block text-[13px] text-muted">
                {{ documentTypeText(invoice.documentType) }} n. {{ invoice.number }} del {{ formatDay(invoice.issuedOn) }}<template v-if="invoice.signed"> · firmata</template>
              </span>
            </button>
            <span v-if="invoice.open > 0" class="chip">{{ invoice.open === 1 ? '1 rata da pagare' : `${invoice.open} rate da pagare` }}</span>
            <span class="whitespace-nowrap tabular-nums">{{ formatCents(invoice.totalCents ?? invoice.taxableCents + invoice.vatCents, { currency: invoice.currency }) }}</span>
            <button v-if="removing !== invoice.id" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="removing = invoice.id"><Icon name="delete" :size="13" />Togli</button>
          </div>
          <div v-if="removing === invoice.id" class="flex flex-col gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm" role="group" aria-label="Conferma della rimozione">
            <p>Tolgo questa fattura con le sue righe e le sue scadenze? Si può reimportare dal file.</p>
            <div class="flex gap-2">
              <button type="button" class="btn btn-danger px-2 py-1 text-xs" :disabled="busy" @click="remove(invoice)"><Icon name="delete" :size="13" />Sì, togli</button>
              <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink touch:min-h-11" :disabled="busy" @click="removing = null">No, lascia</button>
            </div>
          </div>

          <div v-if="opened?.id === invoice.id" class="flex flex-col gap-3 border-t border-line pt-2 text-[13.5px]">
            <p class="flex flex-wrap gap-x-4 gap-y-1 text-muted">
              <span>Fornitore: <b class="text-ink">{{ opened.supplier.name }}</b> {{ opened.supplier.vat ?? opened.supplier.taxCode ?? '' }}</span>
              <span>Cliente: <b class="text-ink">{{ opened.customer.name }}</b> {{ opened.customer.vat ?? opened.customer.taxCode ?? '' }}</span>
            </p>
            <div v-if="opened.lines.length > 0" class="max-h-[360px] overflow-auto rounded-lg border border-line">
              <table class="w-full text-left">
                <thead class="sticky top-0 bg-surface-2 text-xs text-muted">
                  <tr>
                    <th class="px-2 py-1.5 font-medium">N.</th>
                    <th class="px-2 py-1.5 font-medium">Descrizione</th>
                    <th class="px-2 py-1.5 text-right font-medium">Quantità</th>
                    <th class="px-2 py-1.5 text-right font-medium">Prezzo</th>
                    <th class="px-2 py-1.5 text-right font-medium">IVA</th>
                    <th class="px-2 py-1.5 text-right font-medium">Totale</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(line, index) in opened.lines" :key="index" class="border-t border-line">
                    <td class="px-2 py-1 text-muted">{{ line.number }}</td>
                    <td class="px-2 py-1">{{ line.description }}</td>
                    <td class="px-2 py-1 text-right tabular-nums">{{ line.quantity ?? '' }}</td>
                    <td class="px-2 py-1 text-right tabular-nums">{{ line.unitPrice }}</td>
                    <td class="px-2 py-1 text-right whitespace-nowrap">{{ vatRateText(line.vatRate, line.nature) }}</td>
                    <td class="px-2 py-1 text-right whitespace-nowrap tabular-nums">{{ formatCents(line.totalCents, { currency: opened.currency }) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="flex flex-wrap gap-x-4 gap-y-1">
              <span v-for="(row, index) in opened.vatSummary" :key="index">
                {{ vatRateText(row.vatRate, row.nature) }}: imponibile {{ formatCents(row.taxableCents, { currency: opened.currency }) }}, IVA {{ formatCents(row.vatCents, { currency: opened.currency }) }}
              </span>
              <span v-if="opened.totalCents !== null">Totale documento <b>{{ formatCents(opened.totalCents, { currency: opened.currency }) }}</b></span>
            </p>
            <ul v-if="opened.payments.length > 0" class="grid gap-1">
              <li v-for="item in opened.payments" :key="item.id" class="flex flex-wrap items-center gap-x-3">
                <span>Rata del {{ formatDay(item.dueOn) }}, {{ paymentMethodText(item.method) }}: {{ formatCents(item.amountCents, { currency: item.currency }) }}</span>
                <span class="text-muted">{{ item.paidOn === null ? 'da pagare' : `pagata il ${formatDay(item.paidOn)}` }}</span>
              </li>
            </ul>
            <p v-else class="text-muted">La fattura non indica rate né scadenze.</p>
            <p class="text-xs text-muted">Dal file {{ opened.fileName }}, importato il {{ formatMoment(opened.importedAt) }}<template v-if="opened.signed"> (firmato: la firma non viene verificata)</template>.</p>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

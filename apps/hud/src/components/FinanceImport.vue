<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { ApiError, listFinanceImports, previewFinanceImport, runFinanceImport, undoFinanceImport, type ImportRequest } from '../lib/api.ts';
import {
  amountClass,
  bytesToBase64,
  DATE_FORMAT_TEXT,
  DECIMAL_TEXT,
  draftOf,
  draftProblems,
  fileProblem,
  financeErrorText,
  formatCents,
  formatDay,
  formatMoment,
  headerChoices,
  profileOf,
  rejectText,
  type Account,
  type BankProfile,
  type DateFormat,
  type DecimalMark,
  type FinanceTab,
  type ImportRecord,
  type Preview,
  type ProfileDraft,
} from '../lib/finance.ts';
import Icon from './Icon.vue';

/**
 * "Importa" of the finances (I-18, D-183): a bank statement (.csv or .xlsx)
 * read in the browser and sent in base64 to the core of this Mac, which reads
 * it with its own readers. First a preview with the profile of the bank,
 * guessed or remembered, that the user corrects with the selects; then the
 * import. The file is not kept. The imports of the account can be undone.
 */
const props = defineProps<{ accounts: Account[] }>();
const emit = defineEmits<{ changed: []; tab: [tab: FinanceTab] }>();

const open = computed(() => props.accounts.filter((account) => !account.archived));
const accountId = ref<string>(open.value[0]?.id ?? '');
const account = computed(() => props.accounts.find((item) => item.id === accountId.value));

watch(open, (list) => {
  if (!list.some((item) => item.id === accountId.value)) accountId.value = list[0]?.id ?? '';
});

const file = ref<{ name: string; data: string } | null>(null);
const preview = ref<Preview | null>(null);
const draft = ref<ProfileDraft>(draftOf(null));
const sheet = ref<string | null>(null);
const busy = ref(false);
const problem = ref<string | null>(null);
const done = ref<string | null>(null);
const dragging = ref(false);
const picker = ref<HTMLInputElement | null>(null);

const columns = computed(() => headerChoices(preview.value?.header ?? []));
const problems = computed(() => draftProblems(draft.value));
/** The selects say something the preview on screen was not made with. */
const stale = computed(() => {
  const chosen = profileOf(draft.value);
  // Both through the same shape, so the order of the keys of the core does not matter.
  const shownProfile = preview.value === null ? null : profileOf(draftOf(preview.value.profile));
  return preview.value !== null && chosen !== null && JSON.stringify(chosen) !== JSON.stringify(shownProfile);
});
const canImport = computed(() => preview.value !== null && problems.value.length === 0 && !stale.value && !busy.value && accountId.value !== '');

const DATE_FORMATS = Object.entries(DATE_FORMAT_TEXT) as [DateFormat, string][];
const DECIMALS = Object.entries(DECIMAL_TEXT) as [DecimalMark, string][];

function reset(): void {
  file.value = null;
  preview.value = null;
  sheet.value = null;
  draft.value = draftOf(null);
  if (picker.value !== null) picker.value.value = '';
}

async function choose(chosen: File | undefined): Promise<void> {
  if (chosen === undefined) return;
  done.value = null;
  const issue = fileProblem(chosen.name, chosen.size);
  if (issue !== null) {
    reset();
    problem.value = issue;
    return;
  }
  busy.value = true;
  try {
    file.value = { name: chosen.name, data: bytesToBase64(new Uint8Array(await chosen.arrayBuffer())) };
  } catch {
    busy.value = false;
    problem.value = 'Non riesco a leggere il file.';
    return;
  }
  busy.value = false;
  preview.value = null;
  sheet.value = null;
  await runPreview(account.value?.profile ?? undefined, true);
}

function request(profile: BankProfile | undefined): ImportRequest | null {
  if (file.value === null || accountId.value === '') return null;
  const body: ImportRequest = { account: accountId.value, name: file.value.name, data: file.value.data };
  if (profile !== undefined) body.profile = profile;
  if (sheet.value !== null) body.sheet = sheet.value;
  return body;
}

/** `remembered`: the profile is the account's; when it no longer fits the file, the core guesses one. */
async function runPreview(profile: BankProfile | undefined, remembered = false): Promise<void> {
  const body = request(profile);
  if (body === null) return;
  busy.value = true;
  problem.value = null;
  try {
    preview.value = await previewFinanceImport(body);
    sheet.value = preview.value.sheet;
    draft.value = draftOf(preview.value.profile);
  } catch (cause) {
    if (remembered && profile !== undefined && cause instanceof ApiError && cause.message === 'profile-mismatch') {
      busy.value = false;
      await runPreview(undefined);
      return;
    }
    preview.value = null;
    problem.value = financeErrorText(cause);
  } finally {
    busy.value = false;
  }
}

function again(): void {
  const profile = profileOf(draft.value);
  if (profile !== null) void runPreview(profile);
}

function changeSheet(name: string): void {
  sheet.value = name;
  void runPreview(undefined);
}

watch(accountId, () => {
  done.value = null;
  void loadImports();
  if (file.value !== null) void runPreview(profileOf(draft.value) ?? undefined);
});

async function confirmImport(): Promise<void> {
  const profile = profileOf(draft.value);
  const body = request(profile ?? undefined);
  if (body === null || profile === null) return;
  busy.value = true;
  problem.value = null;
  try {
    const record = await runFinanceImport({ ...body, profile });
    done.value = importSummary(record);
    reset();
    emit('changed');
    await loadImports();
  } catch (cause) {
    problem.value = financeErrorText(cause);
  } finally {
    busy.value = false;
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count.toLocaleString('it-IT')} ${many}`;
}

function importSummary(record: ImportRecord): string {
  return `${plural(record.imported, 'movimento importato', 'movimenti importati')}, ${plural(record.duplicates, 'doppione saltato', 'doppioni saltati')}, ${plural(record.rejected, 'riga scartata', 'righe scartate')}.`;
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  void choose(event.dataTransfer?.files[0]);
}

function onPick(event: Event): void {
  void choose((event.target as HTMLInputElement).files?.[0]);
}

// The imports of the account, with "Annulla".
const imports = ref<ImportRecord[] | null>(null);
const importsProblem = ref<string | null>(null);
const undoing = ref<string | null>(null);

async function loadImports(): Promise<void> {
  if (accountId.value === '') {
    imports.value = [];
    return;
  }
  try {
    imports.value = await listFinanceImports(accountId.value);
    importsProblem.value = null;
  } catch (cause) {
    importsProblem.value = financeErrorText(cause);
  }
}
void loadImports();

async function undo(record: ImportRecord): Promise<void> {
  busy.value = true;
  try {
    await undoFinanceImport(record.id);
    undoing.value = null;
    emit('changed');
    await loadImports();
  } catch (cause) {
    importsProblem.value = financeErrorText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex max-w-5xl flex-col gap-4">
    <div v-if="open.length === 0" class="rounded-xl border border-line bg-surface p-4 text-sm">
      Per importare un estratto conto serve prima un conto.
      <button type="button" class="btn ml-2 px-2.5 py-1 text-xs" @click="emit('tab', 'conti')">Crea un conto</button>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-xs text-muted">
          Conto
          <select v-model="accountId" class="field px-2 py-1.5 text-[13px]">
            <option v-for="item in open" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <p class="pb-1.5 text-xs text-muted">File .csv o .xlsx esportati dalla banca, al massimo 10 MB. Il file non viene conservato.</p>
      </div>

      <div
        class="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm"
        :class="dragging ? 'border-accent bg-accent/10' : 'border-line-strong bg-surface'"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <Icon name="upload" :size="22" />
        <p v-if="file">{{ file.name }}</p>
        <p v-else class="text-muted">Trascina qui l’estratto conto</p>
        <input ref="picker" type="file" accept=".csv,.xlsx,.tsv,.txt" class="sr-only" aria-label="Scegli l’estratto conto" @change="onPick" />
        <button type="button" class="btn px-3 py-1 text-xs" :disabled="busy" @click="picker?.click()">{{ file ? 'Scegli un altro file' : 'Scegli un file' }}</button>
      </div>

      <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
      <p v-if="done" class="rounded-lg border border-ok/50 bg-ok/10 px-3 py-2 text-sm" role="status"><Icon name="saved" :size="14" class="mr-1 inline" />{{ done }}</p>
      <p v-if="busy && file" class="text-sm text-muted">Leggo il file…</p>

      <!-- THE PREVIEW -->
      <section v-if="preview" class="hud-card flex flex-col gap-3 p-4" aria-label="Anteprima dell'importazione">
        <header class="flex flex-wrap items-center gap-2">
          <h3 class="hud-title">Anteprima</h3>
          <span class="chip">{{ preview.kind === 'csv' ? 'CSV' : 'Excel' }}</span>
          <span v-if="preview.profile && preview.guessed" class="chip text-warn">Colonne indovinate: controllale</span>
          <span v-else-if="preview.profile" class="chip">Profilo ricordato per questo conto</span>
          <span v-if="preview.headerLine !== null" class="text-xs text-muted">intestazione alla riga {{ preview.headerLine }}</span>
          <label v-if="preview.sheets && preview.sheets.length > 1" class="ml-auto flex items-center gap-2 text-xs text-muted">
            Foglio
            <select class="field px-2 py-1 text-[13px]" :value="sheet ?? ''" :disabled="busy" @change="changeSheet(($event.target as HTMLSelectElement).value)">
              <option v-for="name in preview.sheets" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
        </header>

        <p v-if="preview.profile === null" class="text-sm text-warn">Non riconosco le colonne del file: sceglile qui sotto, poi rifai l’anteprima.</p>

        <!-- The profile of the bank, corrected by hand. -->
        <fieldset class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" :disabled="busy">
          <legend class="sr-only">Profilo della banca</legend>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Data (contabile)
            <select v-model="draft.booked" class="field px-2 py-1.5 text-[13px]">
              <option value="">—</option>
              <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Data valuta
            <select v-model="draft.value" class="field px-2 py-1.5 text-[13px]">
              <option value="">Nessuna</option>
              <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Descrizione
            <select v-model="draft.description" class="field px-2 py-1.5 text-[13px]">
              <option value="">—</option>
              <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Descrizione, seconda colonna
            <select v-model="draft.description2" class="field px-2 py-1.5 text-[13px]">
              <option value="">Nessuna</option>
              <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Importo
            <select v-model="draft.amountKind" class="field px-2 py-1.5 text-[13px]">
              <option value="single">Una colonna con il segno</option>
              <option value="split">Due colonne: dare e avere</option>
            </select>
          </label>
          <label v-if="draft.amountKind === 'single'" class="flex flex-col gap-1 text-xs text-muted">
            Colonna dell’importo
            <select v-model="draft.amount" class="field px-2 py-1.5 text-[13px]">
              <option value="">—</option>
              <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <template v-else>
            <label class="flex flex-col gap-1 text-xs text-muted">
              Dare (uscite)
              <select v-model="draft.debit" class="field px-2 py-1.5 text-[13px]">
                <option value="">—</option>
                <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">
              Avere (entrate)
              <select v-model="draft.credit" class="field px-2 py-1.5 text-[13px]">
                <option value="">—</option>
                <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
              </select>
            </label>
          </template>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Saldo
            <select v-model="draft.balance" class="field px-2 py-1.5 text-[13px]">
              <option value="">Nessuno</option>
              <option v-for="name in columns" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Formato della data
            <select v-model="draft.dateFormat" class="field px-2 py-1.5 text-[13px]">
              <option v-for="[value, text] in DATE_FORMATS" :key="value" :value="value">{{ text }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Separatore dei decimali
            <select v-model="draft.decimal" class="field px-2 py-1.5 text-[13px]">
              <option v-for="[value, text] in DECIMALS" :key="value" :value="value">{{ text }}</option>
            </select>
          </label>
        </fieldset>
        <ul v-if="problems.length > 0" class="text-xs text-warn">
          <li v-for="text in problems" :key="text">{{ text }}</li>
        </ul>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="btn px-3 py-1.5 text-[13px]" :disabled="busy || problems.length > 0" @click="again"><Icon name="retry" :size="14" />Rifai l’anteprima</button>
          <span v-if="stale" class="text-xs text-warn">Hai cambiato le colonne: rifai l’anteprima prima di importare.</span>
        </div>

        <template v-if="preview.profile">
          <p class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span><b>{{ preview.totals.count.toLocaleString('it-IT') }}</b> movimenti nuovi</span>
            <span>entrate <b class="text-ok">{{ formatCents(preview.totals.income) }}</b></span>
            <span>uscite <b>{{ formatCents(preview.totals.expenses) }}</b></span>
            <span class="text-muted">{{ preview.duplicates === 1 ? '1 doppione già presente, saltato' : `${preview.duplicates.toLocaleString('it-IT')} doppioni già presenti, saltati` }}</span>
            <span v-if="preview.newestFirst" class="text-muted">il file andava dal più recente: rimesso in ordine</span>
          </p>

          <details v-if="preview.rejected.length > 0" class="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
            <summary class="cursor-pointer">{{ preview.rejected.length === 1 ? '1 riga scartata' : `${preview.rejected.length.toLocaleString('it-IT')} righe scartate` }}</summary>
            <ul class="mt-1 max-h-48 overflow-auto text-xs">
              <li v-for="item in preview.rejected" :key="item.line">Riga {{ item.line }}: {{ rejectText(item.code) }}</li>
            </ul>
          </details>

          <div v-if="preview.rows.length > 0" class="max-h-[360px] overflow-auto rounded-lg border border-line">
            <table class="w-full text-left text-[12.5px]">
              <thead class="sticky top-0 bg-surface-2 text-xs text-muted">
                <tr>
                  <th class="px-2 py-1.5 font-medium">Riga</th>
                  <th class="px-2 py-1.5 font-medium">Data</th>
                  <th class="px-2 py-1.5 font-medium">Descrizione</th>
                  <th class="px-2 py-1.5 text-right font-medium">Importo</th>
                  <th class="px-2 py-1.5 text-right font-medium">Saldo</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in preview.rows" :key="row.line" class="border-t border-line">
                  <td class="px-2 py-1 text-muted">{{ row.line }}</td>
                  <td class="px-2 py-1 whitespace-nowrap">{{ formatDay(row.booked) }}</td>
                  <td class="px-2 py-1">{{ row.description }}</td>
                  <td class="px-2 py-1 text-right whitespace-nowrap tabular-nums" :class="amountClass(row.amount)">{{ formatCents(row.amount, { currency: row.currency }) }}</td>
                  <td class="px-2 py-1 text-right whitespace-nowrap text-muted tabular-nums">{{ row.balance === null ? '' : formatCents(row.balance, { currency: row.currency }) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="preview.rows.length < preview.totals.count" class="text-xs text-muted">Qui le prime {{ preview.rows.length }} righe nuove; si importano tutte.</p>

          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn btn-primary px-3 py-1.5 text-[13px]" :disabled="!canImport || preview.totals.count === 0" @click="confirmImport"><Icon name="approve" :size="14" />Importa</button>
            <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink" :disabled="busy" @click="reset">Lascia stare</button>
            <span v-if="preview.totals.count === 0" class="text-xs text-muted">Nessun movimento nuovo da importare.</span>
          </div>
        </template>
      </section>

      <!-- THE IMPORTS OF THE ACCOUNT -->
      <section class="flex flex-col gap-2" aria-label="Importazioni del conto">
        <h3 class="hud-title">Importazioni di {{ account?.name ?? 'questo conto' }}</h3>
        <p v-if="importsProblem" class="text-sm text-danger" role="alert">{{ importsProblem }}</p>
        <p v-else-if="imports === null" class="text-sm text-muted">Carico le importazioni…</p>
        <p v-else-if="imports.length === 0" class="text-sm text-muted">Ancora nessuna importazione su questo conto.</p>
        <ul v-else class="grid gap-2">
          <li v-for="record in imports" :key="record.id" class="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <div class="flex flex-wrap items-center gap-3">
              <span class="min-w-0 flex-1">
                <b class="block truncate text-[13px] font-medium">{{ record.name }}</b>
                <span class="block text-[12px] text-muted">{{ formatMoment(record.at) }} · {{ importSummary(record) }}</span>
              </span>
              <button v-if="undoing !== record.id" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="undoing = record.id"><Icon name="retry" :size="13" />Annulla</button>
            </div>
            <div v-if="undoing === record.id" class="flex flex-col gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm" role="group" aria-label="Conferma dell'annullamento">
              <p>Tolgo i {{ record.imported.toLocaleString('it-IT') }} movimenti entrati con questa importazione? Le categorie scelte a mano su quei movimenti si perdono.</p>
              <div class="flex gap-2">
                <button type="button" class="btn btn-danger px-2 py-1 text-xs" :disabled="busy" @click="undo(record)"><Icon name="delete" :size="13" />Sì, annulla l’importazione</button>
                <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink" :disabled="busy" @click="undoing = null">No, lascia</button>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

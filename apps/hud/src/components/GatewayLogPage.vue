<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { loadGatewayLog } from '../lib/api.ts';
import {
  appendPage,
  askerText,
  bytesText,
  DECISION_TEXT,
  destinationOptions,
  EMPTY_FILTERS,
  emptyText,
  filtersActive,
  GATEWAY_LOG_INTRO,
  GATEWAY_LOG_TITLE,
  isPrivateOut,
  originText,
  periodProblem,
  queryOf,
  ruleText,
  targetText,
  timeText,
  type GatewayLogEntry,
  type GatewayLogFilters,
  type GatewayLogTarget,
} from '../lib/gateway-log.ts';
import { LABEL_OPTION } from '../lib/labels.ts';
import type { Label } from '../lib/types.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import PageHeader from './PageHeader.vue';

/**
 * «Registro del gateway» (D-296): one row per decision of the gateway, the
 * newest first, with filters and «Carica altre». A row opens its detail,
 * metadata only: the core never sends the text that left or was stopped.
 * On a phone each row is a card (D-293) and the filters fold under «Filtri».
 */
const emit = defineEmits<{ open: [conversationId: string] }>();

const filters = ref<GatewayLogFilters>({ ...EMPTY_FILTERS });
const entries = ref<GatewayLogEntry[] | null>(null);
const targets = ref<GatewayLogTarget[]>([]);
const next = ref<string | null>(null);
const loading = ref(false);
const problem = ref<string | null>(null);
const selected = ref<GatewayLogEntry | null>(null);
const filtersOpen = ref(false);
const detail = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
/** Each read has a number: an answer to filters already changed is dropped. */
let generation = 0;

const groups = computed(() => destinationOptions(targets.value));
const active = computed(() => filtersActive(filters.value));
const period = computed(() => periodProblem(filters.value));
const empty = computed(() => emptyText(filters.value));
const LABELS: readonly Label[] = ['L0', 'L1', 'L2', 'L3'];

async function load(more = false): Promise<void> {
  if (period.value !== null) {
    entries.value = [];
    next.value = null;
    return;
  }
  const mine = ++generation;
  loading.value = true;
  problem.value = null;
  try {
    const page = await loadGatewayLog(queryOf(filters.value, more ? next.value : null));
    if (mine !== generation) return;
    entries.value = more ? appendPage(entries.value ?? [], page.entries) : page.entries;
    next.value = page.next;
    if (page.targets !== undefined) targets.value = page.targets;
  } catch {
    if (mine !== generation) return;
    problem.value = 'Non riesco a leggere il registro: controlla che il core sia acceso e riprova.';
    if (!more) entries.value = entries.value ?? [];
  } finally {
    if (mine === generation) loading.value = false;
  }
}

function clearFilters(): void {
  filters.value = { ...EMPTY_FILTERS };
}

watch(filters, () => void load(), { deep: true });
onMounted(() => void load());

function openDetail(entry: GatewayLogEntry, event: Event): void {
  // The button of the row gets the focus back, also when the row itself was clicked.
  const row = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  opener = row?.querySelector<HTMLElement>('button') ?? row;
  selected.value = entry;
  void nextTick(() => detail.value?.focus({ preventScroll: true }));
}

function closeDetail(): void {
  selected.value = null;
  if (opener?.isConnected === true) opener.focus({ preventScroll: true });
  opener = null;
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Esc closes the detail; Tab stays inside it, as in PhoneSheet (D-294). */
function onDetailKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeDetail();
    return;
  }
  if (event.key !== 'Tab' || detail.value === null) return;
  const items = [...detail.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === detail.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openConversation(id: string): void {
  selected.value = null;
  emit('open', id);
}

function fullTime(ts: string): string {
  return new Date(ts).toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1100px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
        <PageHeader :title="GATEWAY_LOG_TITLE" title-id="gateway-log-title">
          <template #icon><span class="text-accent"><Icon name="gateway" :size="20" /></span></template>
          {{ GATEWAY_LOG_INTRO }}
          <template #actions>
            <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="loading" @click="load()"><Icon name="retry" :size="14" />Aggiorna</button>
          </template>
        </PageHeader>

        <div class="flex flex-wrap items-end gap-2" role="group" aria-label="Filtri del registro">
          <button type="button" class="btn px-3 py-1.5 text-[14px] md:hidden" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen">
            <Icon name="filter" :size="14" />Filtri<template v-if="active > 0"> · {{ active }}</template>
          </button>
          <div class="contents" :class="filtersOpen ? '' : 'max-md:hidden'">
            <label class="flex flex-col gap-1 text-xs text-muted max-md:w-full">
              Esito
              <select v-model="filters.decision" class="field touch:min-h-11 px-2 py-1.5 text-[14px]">
                <option value="">Tutti</option>
                <option value="allow">Ammesse</option>
                <option value="block">Bloccate</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted max-md:w-full">
              Destinazione
              <select v-model="filters.destination" class="field touch:min-h-11 max-w-[260px] px-2 py-1.5 text-[14px] max-md:max-w-none">
                <option value="">Tutte</option>
                <optgroup v-for="group in groups" :key="group.group" :label="group.group">
                  <option v-for="option in group.options" :key="option.value" :value="option.value">{{ option.text }}</option>
                </optgroup>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted max-md:w-full">
              Etichetta
              <select v-model="filters.label" class="field touch:min-h-11 px-2 py-1.5 text-[14px]">
                <option value="">Tutte</option>
                <option v-for="label in LABELS" :key="label" :value="label">{{ LABEL_OPTION[label].split(' · ')[0] }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted max-md:flex-1">
              Dal
              <input v-model="filters.from" type="date" class="field touch:min-h-11 px-2 py-1.5 text-[14px]" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted max-md:flex-1">
              Al
              <input v-model="filters.to" type="date" class="field touch:min-h-11 px-2 py-1.5 text-[14px]" />
            </label>
          </div>
          <button v-if="active > 0" type="button" class="rounded-md px-2 py-1.5 text-xs text-muted hover:text-ink touch:min-h-11" @click="clearFilters">Togli i filtri</button>
        </div>

        <p v-if="period" class="text-sm text-danger" role="alert">{{ period }}</p>
        <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
        <p v-if="entries === null && problem === null" class="text-sm text-muted">Leggo il registro…</p>
        <div v-else-if="entries !== null && entries.length === 0 && period === null && problem === null" class="flex flex-col items-start gap-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6">
          <p class="flex items-center gap-2 font-medium"><Icon name="gateway" :size="16" />{{ empty.title }}</p>
          <p class="max-w-[620px] text-sm text-muted">{{ empty.text }}</p>
          <button v-if="active > 0" type="button" class="btn mt-1 px-3 py-1.5 text-[14px]" @click="clearFilters">Togli i filtri</button>
        </div>

        <template v-if="entries !== null && entries.length > 0">
          <p class="text-xs text-muted">{{ entries.length === 1 ? '1 decisione' : `${entries.length.toLocaleString('it-IT')} decisioni` }}{{ next !== null ? ' finora' : '' }}, dalla più recente · tocca o clicca una riga per il dettaglio</p>
          <!-- On a phone each decision is a card (D-293): time and outcome, then where, who and the label. -->
          <div class="rounded-xl border border-line bg-surface-2">
            <table class="w-full text-left text-[14px] max-md:block" aria-labelledby="gateway-log-title">
              <thead class="text-xs text-muted max-md:hidden">
                <tr class="border-b border-line-strong">
                  <th class="w-[120px] px-3 py-2 font-medium">Ora</th>
                  <th class="px-3 py-2 font-medium">Destinazione</th>
                  <th class="px-3 py-2 font-medium">Chi l’ha chiesta</th>
                  <th class="w-[110px] px-3 py-2 font-medium">Etichetta</th>
                  <th class="w-[110px] px-3 py-2 font-medium">Esito</th>
                  <th class="w-[100px] px-3 py-2 text-right font-medium">Dimensione</th>
                </tr>
              </thead>
              <tbody class="max-md:block">
                <tr
                  v-for="entry in entries"
                  :key="entry.id"
                  class="cursor-pointer border-t border-line align-middle first:border-t-0 hover:bg-surface focus-within:bg-surface max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:px-3 max-md:py-2.5"
                  :class="selected?.id === entry.id ? 'bg-surface' : ''"
                  @click="openDetail(entry, $event)"
                >
                  <td class="px-3 py-2 whitespace-nowrap text-muted tabular-nums max-md:order-1 max-md:p-0 max-md:text-xs">
                    <!-- The whole row opens the detail with the mouse or a finger; the keyboard and the screen readers use this button. -->
                    <button
                      type="button"
                      class="rounded text-left"
                      :aria-label="`${timeText(entry.ts)}: dettaglio della decisione verso ${targetText(entry.targetKind, entry.target)}`"
                      :aria-expanded="selected?.id === entry.id"
                    >{{ timeText(entry.ts) }}</button>
                  </td>
                  <td class="px-3 py-2 max-md:order-3 max-md:col-span-2 max-md:p-0">
                    <span class="block font-medium">{{ targetText(entry.targetKind, entry.target) }}</span>
                    <span class="block text-xs text-muted">{{ entry.locality === 'cloud' ? 'fuori dal Mac' : 'sul Mac' }}</span>
                  </td>
                  <td class="min-w-0 px-3 py-2 max-md:order-4 max-md:col-span-2 max-md:p-0">
                    <span class="block">{{ askerText(entry) }}<template v-if="entry.model"> · <span class="text-muted">{{ entry.model }}</span></template></span>
                    <span v-if="originText(entry)" class="block max-w-[320px] truncate text-xs text-muted max-md:max-w-none">{{ originText(entry) }}</span>
                  </td>
                  <td class="px-3 py-2 max-md:order-5 max-md:p-0 max-md:text-xs"><LabelBadge :label="entry.label" /></td>
                  <td class="px-3 py-2 whitespace-nowrap max-md:order-2 max-md:p-0 max-md:text-right">
                    <span
                      class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                      :class="entry.decision === 'block' ? 'border-warn/60 text-warn' : isPrivateOut(entry) ? 'border-danger/60 text-danger' : 'border-ok/50 text-ok'"
                    >{{ DECISION_TEXT[entry.decision] }}</span>
                  </td>
                  <td class="px-3 py-2 text-right whitespace-nowrap text-muted tabular-nums max-md:order-6 max-md:p-0 max-md:text-xs">{{ entry.bytes === null ? '—' : bytesText(entry.bytes) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button v-if="next !== null" type="button" class="btn self-start px-3 py-1.5 text-[14px] touch:min-h-11" :disabled="loading" @click="load(true)">{{ loading ? 'Carico…' : 'Carica altre' }}</button>
          <p v-else class="text-xs text-muted">Non ci sono decisioni più vecchie{{ active > 0 ? ' con questi filtri' : '' }}.</p>
        </template>
      </div>
    </div>

    <aside
      v-if="selected !== null"
      ref="detail"
      tabindex="-1"
      aria-modal="true"
      class="phone-panel fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-[0_14px_40px_#0006] outline-none md:max-w-[420px]"
      role="dialog"
      aria-labelledby="gateway-detail-title"
      @keydown="onDetailKey"
    >
      <header class="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 id="gateway-detail-title" class="min-w-0 flex-1 truncate text-[16px] font-semibold">Decisione delle {{ timeText(selected.ts) }}</h2>
        <button type="button" class="btn grid size-8 place-items-center p-0 touch:size-11" aria-label="Chiudi il dettaglio" @click="closeDetail"><Icon name="close" :size="16" /></button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[14px]">
          <dt class="text-muted">Quando</dt>
          <dd>{{ fullTime(selected.ts) }}</dd>
          <dt class="text-muted">Esito</dt>
          <dd :class="selected.decision === 'block' ? 'text-warn' : isPrivateOut(selected) ? 'text-danger' : 'text-ok'" class="font-medium">{{ DECISION_TEXT[selected.decision] }}</dd>
          <dt class="text-muted">Perché</dt>
          <dd>{{ ruleText(selected.rule) }} <span class="font-mono text-xs text-muted">{{ selected.rule }}</span></dd>
          <dt class="text-muted">Destinazione</dt>
          <dd>{{ targetText(selected.targetKind, selected.target) }} · {{ selected.locality === 'cloud' ? 'fuori dal Mac' : 'sul Mac' }} <span class="font-mono text-xs text-muted">{{ selected.target }}</span></dd>
          <dt class="text-muted">Etichetta</dt>
          <dd><LabelBadge :label="selected.label" /></dd>
          <dt class="text-muted">Dimensione</dt>
          <dd>{{ bytesText(selected.bytes) }}</dd>
          <dt class="text-muted">Chi</dt>
          <dd>{{ askerText(selected) }}<template v-if="selected.model"> · {{ selected.model }}</template></dd>
          <template v-if="originText(selected)">
            <dt class="text-muted">Da dove</dt>
            <dd class="break-words">{{ originText(selected) }}</dd>
          </template>
        </dl>
        <button v-if="selected.conversation?.open" type="button" class="btn mt-4 px-3 py-1.5 text-[14px] touch:min-h-11" @click="openConversation(selected.conversation.id)">
          <Icon name="chat" :size="14" />Apri la conversazione
        </button>
        <p class="mt-5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
          Questa pagina non mostra mai il testo uscito o fermato, né un suo riassunto: solo questi dati. Per sapere cosa è stato detto apri la conversazione.
        </p>
      </div>
    </aside>
  </div>
</template>

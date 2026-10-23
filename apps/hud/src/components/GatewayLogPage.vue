<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, loadGatewayLog, loadGatewaySubjects, loadGatewayText } from '../lib/api.ts';
import { copyText, COPY_FEEDBACK_MS, type CopyResult } from '../lib/clipboard.ts';
import {
  appendGroups,
  appendPage,
  askerText,
  bytesText,
  copyOfText,
  DECISION_TEXT,
  destinationOptions,
  EMPTY_FILTERS,
  emptyText,
  exitText,
  filtersActive,
  GATEWAY_LOG_INTRO,
  GATEWAY_LOG_TITLE,
  groupCounts,
  groupDecision,
  groupHeadline,
  isPrivateOut,
  originText,
  periodProblem,
  queryOf,
  ruleText,
  runQuery,
  targetText,
  TEXT_FROM_MAC,
  textNotice,
  textSizeText,
  textStateNotice,
  timeText,
  verifiedText,
  whatText,
  type GatewayLogEntry,
  type GatewayLogFilters,
  type GatewayLogGroup,
  type GatewayLogTarget,
  type GatewayText,
} from '../lib/gateway-log.ts';
import { onRemoteOrigin } from '../lib/remote.ts';
import { LABEL_OPTION } from '../lib/labels.ts';
import type { Label } from '../lib/types.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import PageHeader from './PageHeader.vue';

/**
 * «Registro del gateway» (D-296): one line per run of an agent (D-297, «una
 * riga per richiesta»; a decision without a run alone), the newest first,
 * with filters and «Carica altre». A line of several exits opens their list,
 * each with what it was («Cosa era»: its kind, and from the Mac its subject);
 * an exit opens its detail,
 * with its metadata and «Cosa è uscito» (D-297): the exact text of an exit
 * allowed to the cloud up to Interno, asked only from the Mac and shown as
 * text (never HTML); a blocked one says only its label.
 * On a phone each row is a card (D-293) and the filters fold under «Filtri».
 */
const emit = defineEmits<{ open: [conversationId: string] }>();

const filters = ref<GatewayLogFilters>({ ...EMPTY_FILTERS });
const lines = ref<GatewayLogGroup[] | null>(null);
const targets = ref<GatewayLogTarget[]>([]);
const next = ref<string | null>(null);
const loading = ref(false);
const problem = ref<string | null>(null);
const selected = ref<GatewayLogEntry | null>(null);
/** The line of several exits open in the panel, its exits and, from the Mac, their subjects. */
const opened = ref<GatewayLogGroup | null>(null);
const exits = ref<GatewayLogEntry[] | null>(null);
const exitsNext = ref<string | null>(null);
const exitsProblem = ref<string | null>(null);
const exitsLoading = ref(false);
const subjects = ref<Record<string, string>>({});
let groupGeneration = 0;
const filtersOpen = ref(false);
const detail = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
/** Each read has a number: an answer to filters already changed is dropped. */
let generation = 0;

const destinationGroups = computed(() => destinationOptions(targets.value));
const active = computed(() => filtersActive(filters.value));
const period = computed(() => periodProblem(filters.value));
const empty = computed(() => emptyText(filters.value));
const LABELS: readonly Label[] = ['L0', 'L1', 'L2', 'L3'];

async function load(more = false): Promise<void> {
  if (period.value !== null) {
    lines.value = [];
    next.value = null;
    return;
  }
  const mine = ++generation;
  loading.value = true;
  problem.value = null;
  try {
    const page = await loadGatewayLog(queryOf(filters.value, more ? next.value : null, undefined, true));
    if (mine !== generation) return;
    const groups = page.groups ?? [];
    lines.value = more ? appendGroups(lines.value ?? [], groups) : groups;
    next.value = page.next;
    if (page.targets !== undefined) targets.value = page.targets;
  } catch {
    if (mine !== generation) return;
    problem.value = 'Non riesco a leggere il registro: controlla che il core sia acceso e riprova.';
    if (!more) lines.value = lines.value ?? [];
  } finally {
    if (mine === generation) loading.value = false;
  }
}

function clearFilters(): void {
  filters.value = { ...EMPTY_FILTERS };
}

watch(filters, () => void load(), { deep: true });
onMounted(() => void load());

const remote = onRemoteOrigin(window.location);
/** «Cosa è uscito» of the open detail: the answer of the core, or why there is none. */
const shown = ref<GatewayText | null>(null);
const textProblem = ref<string | null>(null);
const textLoading = ref(false);
const copyState = ref<'idle' | CopyResult>('idle');
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let textGeneration = 0;

const notice = computed(() => (selected.value === null ? null : textNotice(selected.value, remote)));
const stateNotice = computed(() => (shown.value === null ? null : textStateNotice(shown.value)));

async function loadText(entry: GatewayLogEntry): Promise<void> {
  const mine = ++textGeneration;
  shown.value = null;
  textProblem.value = null;
  textLoading.value = false;
  copyState.value = 'idle';
  // From the phone nothing is asked: the core refuses it. On the Mac a blocked or local exit is asked too, for its
  // subject (D-297, «Cosa era»): the core sends no text for it, and the notice says why.
  if (remote) return;
  textLoading.value = textNotice(entry, remote) === null;
  try {
    const text = await loadGatewayText(entry.id);
    if (mine === textGeneration) shown.value = text;
  } catch (error) {
    if (mine !== textGeneration) return;
    textProblem.value =
      error instanceof ApiError && error.status === 403
        ? TEXT_FROM_MAC
        : error instanceof ApiError && error.status === 404
          ? 'Testo non disponibile.'
          : 'Non riesco a leggere il testo: controlla che il core sia acceso e riprova.';
  } finally {
    if (mine === textGeneration) textLoading.value = false;
  }
}

async function copyShown(): Promise<void> {
  if (shown.value?.parts === undefined) return;
  copyState.value = await copyText(copyOfText(shown.value.parts), typeof navigator === 'undefined' ? undefined : navigator.clipboard);
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copyState.value = 'idle'), COPY_FEEDBACK_MS);
}

onBeforeUnmount(() => clearTimeout(copyTimer));

/** The exits of the open line, a page at a time, and from the Mac what each was about. */
async function loadExits(group: GatewayLogGroup, more = false): Promise<void> {
  const runId = group.entry.runId;
  if (runId === null) return;
  const mine = ++groupGeneration;
  exitsProblem.value = null;
  exitsLoading.value = true;
  try {
    const [page, found] = await Promise.all([
      loadGatewayLog(runQuery(runId, more ? exitsNext.value : null, filters.value)),
      // The subjects never from the phone: the core refuses them there.
      more || remote ? Promise.resolve(undefined) : loadGatewaySubjects(runId).catch(() => undefined),
    ]);
    if (mine !== groupGeneration) return;
    exits.value = more ? appendPage(exits.value ?? [], page.entries) : page.entries;
    exitsNext.value = page.next;
    if (found !== undefined) subjects.value = found;
  } catch {
    if (mine === groupGeneration) exitsProblem.value = 'Non riesco a leggere le uscite di questo lavoro: riprova.';
  } finally {
    if (mine === groupGeneration) exitsLoading.value = false;
  }
}

function remember(event: Event): void {
  // The button of the line gets the focus back, also when the line itself was clicked.
  const row = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  opener = row?.querySelector<HTMLElement>('button') ?? row;
}

/** A line: its exits when they are more than one, its detail when alone. */
function openLine(group: GatewayLogGroup, event: Event): void {
  remember(event);
  if (group.count === 1 || group.entry.runId === null) {
    opened.value = null;
    openExit(group.entry);
    return;
  }
  textGeneration += 1;
  selected.value = null;
  opened.value = group;
  exits.value = null;
  exitsNext.value = null;
  subjects.value = {};
  void loadExits(group);
  void nextTick(() => detail.value?.focus({ preventScroll: true }));
}

function openExit(entry: GatewayLogEntry): void {
  selected.value = entry;
  void loadText(entry);
  void nextTick(() => detail.value?.focus({ preventScroll: true }));
}

/** From an exit back to the list of its line. */
function backToExits(): void {
  textGeneration += 1;
  shown.value = null;
  textLoading.value = false;
  selected.value = null;
  void nextTick(() => detail.value?.focus({ preventScroll: true }));
}

function closeDetail(): void {
  textGeneration += 1;
  groupGeneration += 1;
  shown.value = null;
  textLoading.value = false;
  selected.value = null;
  opened.value = null;
  exits.value = null;
  if (opener?.isConnected === true) opener.focus({ preventScroll: true });
  opener = null;
}

/** What the open exit was, with its subject when the Mac has it. */
const selectedWhat = computed(() => (selected.value === null ? '' : exitText(selected.value, shown.value?.subject ?? subjects.value[selected.value.id])));

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
  opened.value = null;
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
                <optgroup v-for="group in destinationGroups" :key="group.group" :label="group.group">
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
        <p v-if="lines === null && problem === null" class="text-sm text-muted">Leggo il registro…</p>
        <div v-else-if="lines !== null && lines.length === 0 && period === null && problem === null" class="flex flex-col items-start gap-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6">
          <p class="flex items-center gap-2 font-medium"><Icon name="gateway" :size="16" />{{ empty.title }}</p>
          <p class="max-w-[620px] text-sm text-muted">{{ empty.text }}</p>
          <button v-if="active > 0" type="button" class="btn mt-1 px-3 py-1.5 text-[14px]" @click="clearFilters">Togli i filtri</button>
        </div>

        <template v-if="lines !== null && lines.length > 0">
          <p class="text-xs text-muted">{{ lines.length === 1 ? '1 richiesta' : `${lines.length.toLocaleString('it-IT')} richieste` }}{{ next !== null ? ' finora' : '' }}, dalla più recente · una riga per ogni lavoro di un agente, con tutte le sue uscite · tocca o clicca una riga</p>
          <!-- On a phone each line is a card (D-293): time and outcome, then what, who and the counts. -->
          <div class="rounded-xl border border-line bg-surface-2">
            <table class="w-full text-left text-[14px] max-md:block" aria-labelledby="gateway-log-title">
              <thead class="text-xs text-muted max-md:hidden">
                <tr class="border-b border-line-strong">
                  <th class="w-[120px] px-3 py-2 font-medium">Ora</th>
                  <th class="px-3 py-2 font-medium">Destinazione</th>
                  <th class="px-3 py-2 font-medium">Chi l’ha chiesta</th>
                  <th class="w-[110px] px-3 py-2 font-medium">Etichetta</th>
                  <th class="w-[120px] px-3 py-2 font-medium">Esito</th>
                  <th class="w-[100px] px-3 py-2 text-right font-medium">Dimensione</th>
                </tr>
              </thead>
              <tbody class="max-md:block">
                <tr
                  v-for="line in lines"
                  :key="line.entry.id"
                  class="cursor-pointer border-t border-line align-middle first:border-t-0 hover:bg-surface focus-within:bg-surface max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:px-3 max-md:py-2.5"
                  :class="opened?.entry.id === line.entry.id || (opened === null && selected?.id === line.entry.id) ? 'bg-surface' : ''"
                  @click="openLine(line, $event)"
                >
                  <td class="px-3 py-2 whitespace-nowrap text-muted tabular-nums max-md:order-1 max-md:p-0 max-md:text-xs">
                    <!-- The whole line opens with the mouse or a finger; the keyboard and the screen readers use this button. -->
                    <button
                      type="button"
                      class="rounded text-left"
                      :aria-label="line.count > 1 ? `${timeText(line.entry.ts)}: le ${line.count} uscite di questo lavoro verso ${groupHeadline(line).target}` : `${timeText(line.entry.ts)}: dettaglio della decisione verso ${targetText(line.entry.targetKind, line.entry.target)}`"
                      :aria-expanded="opened?.entry.id === line.entry.id || (opened === null && selected?.id === line.entry.id)"
                    >{{ timeText(line.entry.ts) }}</button>
                  </td>
                  <td class="px-3 py-2 max-md:order-3 max-md:col-span-2 max-md:p-0">
                    <span class="block font-medium">{{ groupHeadline(line).target }}</span>
                    <span class="block text-xs text-muted">{{ groupHeadline(line).place }}<template v-if="line.count > 1"> · {{ groupCounts(line) }}</template><template v-else-if="line.entry.what"> · {{ whatText(line.entry) }}</template></span>
                  </td>
                  <td class="min-w-0 px-3 py-2 max-md:order-4 max-md:col-span-2 max-md:p-0">
                    <span class="block">{{ askerText(line.entry) }}<template v-if="line.entry.model"> · <span class="text-muted">{{ line.entry.model }}</span></template></span>
                    <span v-if="originText(line.entry)" class="block max-w-[320px] truncate text-xs text-muted max-md:max-w-none">{{ originText(line.entry) }}</span>
                  </td>
                  <td class="px-3 py-2 max-md:order-5 max-md:p-0 max-md:text-xs"><LabelBadge :label="line.label" /></td>
                  <td class="px-3 py-2 whitespace-nowrap max-md:order-2 max-md:p-0 max-md:text-right">
                    <span
                      v-if="line.count === 1"
                      class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                      :class="line.entry.decision === 'block' ? 'border-warn/60 text-warn' : isPrivateOut(line.entry) ? 'border-danger/60 text-danger' : 'border-ok/50 text-ok'"
                    >{{ DECISION_TEXT[line.entry.decision] }}</span>
                    <span
                      v-else
                      class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                      :class="line.privateOut > 0 ? 'border-danger/60 text-danger' : line.blocked > 0 ? 'border-warn/60 text-warn' : 'border-ok/50 text-ok'"
                    >{{ groupDecision(line) }}</span>
                  </td>
                  <td class="px-3 py-2 text-right whitespace-nowrap text-muted tabular-nums max-md:order-6 max-md:p-0 max-md:text-xs">{{ line.bytes === null ? '—' : bytesText(line.bytes) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button v-if="next !== null" type="button" class="btn self-start px-3 py-1.5 text-[14px] touch:min-h-11" :disabled="loading" @click="load(true)">{{ loading ? 'Carico…' : 'Carica altre' }}</button>
          <p v-else class="text-xs text-muted">Non ci sono richieste più vecchie{{ active > 0 ? ' con questi filtri' : '' }}.</p>
        </template>
      </div>
    </div>

    <aside
      v-if="selected !== null || opened !== null"
      ref="detail"
      tabindex="-1"
      aria-modal="true"
      class="phone-panel fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-[0_14px_40px_#0006] outline-none md:max-w-[420px]"
      role="dialog"
      aria-labelledby="gateway-detail-title"
      @keydown="onDetailKey"
    >
      <header class="flex items-center gap-2 border-b border-line px-4 py-3">
        <button v-if="selected !== null && opened !== null" type="button" class="btn grid size-8 place-items-center p-0 touch:size-11" aria-label="Torna alle uscite del lavoro" @click="backToExits">‹</button>
        <h2 id="gateway-detail-title" class="min-w-0 flex-1 truncate text-[16px] font-semibold">{{ selected !== null ? `Decisione delle ${timeText(selected.ts)}` : opened !== null ? `Lavoro delle ${timeText(opened.entry.ts)}` : '' }}</h2>
        <button type="button" class="btn grid size-8 place-items-center p-0 touch:size-11" aria-label="Chiudi il dettaglio" @click="closeDetail"><Icon name="close" :size="16" /></button>
      </header>
      <div v-if="selected === null && opened !== null" class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[14px]">
          <dt class="text-muted">Chi</dt>
          <dd>{{ askerText(opened.entry) }}<template v-if="opened.entry.model"> · {{ opened.entry.model }}</template></dd>
          <template v-if="originText(opened.entry)">
            <dt class="text-muted">Da dove</dt>
            <dd class="break-words">{{ originText(opened.entry) }}</dd>
          </template>
          <dt class="text-muted">Uscite</dt>
          <dd>{{ groupCounts(opened) }}</dd>
          <dt class="text-muted">Quando</dt>
          <dd>{{ timeText(opened.firstTs) }} – {{ timeText(opened.entry.ts) }}</dd>
        </dl>
        <button v-if="opened.entry.conversation?.open" type="button" class="btn mt-4 px-3 py-1.5 text-[14px] touch:min-h-11" @click="openConversation(opened.entry.conversation.id)">
          <Icon name="chat" :size="14" />Apri la conversazione
        </button>
        <h3 class="mt-6 text-[14px] font-semibold">Cosa è uscito, dalla più recente</h3>
        <p v-if="remote" class="mt-1 text-xs text-muted">Note, ricerche e siti di ogni uscita si leggono dal Mac.</p>
        <p v-if="exitsProblem" class="mt-2 text-sm text-danger" role="alert">{{ exitsProblem }}</p>
        <p v-else-if="exits === null" class="mt-2 text-[13px] text-muted">Leggo le uscite…</p>
        <ol v-else class="mt-2 flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2">
          <li v-for="exit in exits" :key="exit.id">
            <button type="button" class="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface touch:min-h-11" @click="openExit(exit)">
              <span class="w-[44px] shrink-0 pt-0.5 text-xs text-muted tabular-nums">{{ timeText(exit.ts) }}</span>
              <span class="min-w-0 flex-1">
                <span class="block break-words text-[13px]">{{ exitText(exit, subjects[exit.id]) }}</span>
                <span class="block text-xs text-muted">{{ targetText(exit.targetKind, exit.target) }}<template v-if="exit.bytes !== null"> · {{ bytesText(exit.bytes) }}</template></span>
              </span>
              <span class="shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium" :class="exit.decision === 'block' ? 'border-warn/60 text-warn' : isPrivateOut(exit) ? 'border-danger/60 text-danger' : 'border-ok/50 text-ok'">{{ DECISION_TEXT[exit.decision] }}</span>
            </button>
          </li>
        </ol>
        <button v-if="exitsNext !== null" type="button" class="btn mt-3 px-3 py-1.5 text-[14px] touch:min-h-11" :disabled="exitsLoading" @click="loadExits(opened, true)">{{ exitsLoading ? 'Carico…' : 'Carica le più vecchie' }}</button>
      </div>
      <div v-else-if="selected !== null" class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[14px]">
          <dt class="text-muted">Cosa era</dt>
          <dd class="break-words">{{ selectedWhat }}</dd>
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

        <!-- «Cosa è uscito» (D-297): text interpolation only, never v-html: what left is data. -->
        <section class="mt-6 flex flex-col gap-2" aria-labelledby="gateway-text-title">
          <div class="flex items-center gap-2">
            <h3 id="gateway-text-title" class="min-w-0 flex-1 text-[14px] font-semibold">Cosa è uscito</h3>
            <button
              v-if="shown?.state === 'text'"
              type="button"
              class="btn px-2.5 py-1 text-xs touch:min-h-11"
              :aria-label="copyState === 'copied' ? 'Testo copiato' : 'Copia il testo uscito'"
              @click="copyShown"
            ><Icon name="copy" :size="13" />{{ copyState === 'copied' ? 'Copiato' : copyState === 'unavailable' ? 'Copia non disponibile' : 'Copia' }}</button>
          </div>
          <p v-if="notice" class="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-muted">{{ notice }}</p>
          <p v-else-if="textLoading" class="text-[13px] text-muted">Leggo il testo…</p>
          <p v-else-if="textProblem" class="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-muted" role="status">{{ textProblem }}</p>
          <p v-else-if="stateNotice" class="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-muted">{{ stateNotice }}</p>
          <template v-else-if="shown?.state === 'text' && shown.parts">
            <p class="text-xs text-muted">{{ textSizeText(shown) }} · esattamente come è uscito, nell’ordine in cui è uscito</p>
            <div
              v-for="(part, index) in shown.parts"
              :key="index"
              class="flex flex-col gap-1"
            >
              <p v-if="shown.parts.length > 1" class="text-xs text-muted">Parte {{ index + 1 }} di {{ shown.parts.length }} · {{ bytesText(part.bytes) }}<template v-if="part.truncated"> · troncato a 1 MB</template></p>
              <pre
                class="max-h-[50vh] overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2.5 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
                tabindex="0"
                :aria-label="shown.parts.length > 1 ? `Parte ${index + 1} del testo uscito` : 'Testo uscito'"
              >{{ part.text }}</pre>
              <p v-if="part.truncated" class="text-xs text-warn">Troncato a 1 MB: qui c’è solo il primo MB di {{ bytesText(part.bytes) }}.</p>
            </div>
            <p class="text-xs" :class="shown.verified === false ? 'text-danger' : 'text-muted'">{{ verifiedText(shown.verified) }}</p>
          </template>
          <p class="text-xs text-muted">Il testo si conserva solo per le uscite ammesse verso il cloud fino a Interno, mai in incognito; si cancella con la conversazione e da solo dopo 30 giorni.</p>
        </section>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * Impostazioni → Modelli (I-3, D-137, revised in D-192): three numbers on
 * top, then «Chi fa cosa» (which model does each task, and the model of the
 * characters), then every model, local and cloud, in a list on the left with
 * the chosen one in a card on the right (below on a phone); the search on
 * Hugging Face closed at the bottom. Roles, the model of the characters and
 * the cloud switches (one per model, in its row of the list) are the parts of
 * the settings the old sections edited (`roles`, `sprites`, `cloudModels`):
 * one bar saves them in one write. Trials of the orchestrator (D-081) start
 * from the card. Read from GET /api/models/overview, all L0. The actions on a
 * local model (stage M4: download, verify, unload, remove into the bin, empty
 * the bin) ask for a confirmation that says how much and where; a removal
 * needs the id typed. I-10 (D-139): models are searched on Hugging Face and
 * added to the user catalog; the card of one added that way promotes it to
 * roles or takes it out of the catalog.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { cancelModelAction, cancelModelEval, dismissModelReload, emptyModelTrash, listModelEvals, loadModelsOverview, removeModel, requestModelEval, startModelAction, unloadLocalModel } from '../lib/api.ts';
import { errorText, MODEL_EVAL_STATUS_TEXT, modelEvalErrorText } from '../lib/italian.ts';
import {
  actionButtons,
  actionErrorText,
  blockedReasons,
  canConfirm,
  confirmationOf,
  emptyTrashConfirmation,
  outcomeText,
  progressOf,
  reloadDismissable,
  reloadInProgress,
  reloadText,
  runningAction,
  trashText,
  type ButtonKind,
  type Confirmation,
} from '../lib/model-actions.ts';
import { anyOpen, canTry, dateText, isOpen, latencyText, promotionHint, scoreText, type ModelEval } from '../lib/model-evals.ts';
import {
  canChatTrial,
  cardSources,
  chosenKey,
  cloudNotice,
  countText,
  EMPTY_FILTER,
  filterModels,
  memorySummary,
  modelEntries,
  overviewErrorText,
  pagesText,
  privacyText,
  providersOf,
  reliabilityText,
  ROLE_NAME,
  shownName,
  sizeText,
  toggleRole,
  unsavedCount,
  unsavedKeys,
  usageLines,
  USE_CHOICES,
  type CloudModelView,
  type LocalModelView,
  type ModelFilter,
  type ModelsOverview,
  type Tone,
} from '../lib/models-page.ts';
import { MODEL_ROLES, ROLE_TEXT, roleOptions, type CatalogModel, type CloudModelsForm, type ModelRole, type SettingsValues } from '../lib/settings.ts';
import type { OmlxReleaseView } from '../lib/omlx-release.ts';
import HubEntryPanel from './HubEntryPanel.vue';
import HuggingFaceSearch from './HuggingFaceSearch.vue';
import Icon from './Icon.vue';
import AdvisorSettings from './AdvisorSettings.vue';
import ModelsCompare from './ModelsCompare.vue';
import OmlxRelease from './OmlxRelease.vue';
import SettingsSaveBar from './SettingsSaveBar.vue';

interface ModelParts {
  roles: Partial<Record<ModelRole, string>>;
  sprites: SettingsValues['sprites'];
  cloudModels: CloudModelsForm;
}

/**
 * `form`/`base`: the parts edited here, edited and as read (the settings page owns them).
 * `catalog`: the catalog of the settings, for the menus of the roles. `save`: one write; false when refused.
 */
const props = defineProps<{
  form: ModelParts;
  base: ModelParts;
  catalog: CatalogModel[];
  busy: boolean;
  error: string | undefined;
  save: () => Promise<boolean>;
}>();
/** `cancel`: the parts back to what was read. `section`: another section of the settings. `catalog`: the catalog changed (I-10): read the settings again. */
const emit = defineEmits<{ cancel: []; section: [slug: string]; catalog: []; chatTrial: [modelId: string]; omlx: [view: OmlxReleaseView] }>();

// «Elenco» and «Confronto» (D-199): the trials of every model, those gone too, side by side.
const PAGE_TABS = [
  { id: 'list', text: 'Elenco' },
  { id: 'compare', text: 'Confronto' },
] as const;
const tab = ref<(typeof PAGE_TABS)[number]['id']>('list');

// The list
const overview = ref<ModelsOverview | null>(null);
const loadError = ref<string | null>(null);
const retrying = ref(false);
async function load(): Promise<void> {
  try {
    overview.value = await loadModelsOverview();
    loadError.value = null;
  } catch (error) {
    loadError.value = errorText(error);
  }
}
async function retry(): Promise<void> {
  retrying.value = true;
  try {
    await load();
  } finally {
    retrying.value = false;
  }
}

const filter = ref<ModelFilter>({ ...EMPTY_FILTER });
const entries = computed(() => modelEntries(overview.value));
const providers = computed(() => providersOf(entries.value));
const visible = computed(() => filterModels(entries.value, filter.value));
const WHERE: { id: ModelFilter['where']; text: string }[] = [
  { id: 'all', text: 'Tutti' },
  { id: 'local', text: 'Sul Mac' },
  { id: 'cloud', text: 'Cloud' },
];

const wanted = ref<string | null>(null);
const currentKey = computed(() => chosenKey(visible.value, wanted.value));
const current = computed(() => entries.value.find((entry) => entry.key === currentKey.value));
const detail = ref<HTMLElement | null>(null);
/** The grid of list and card: one column when the page is narrow (a container query, D-150). */
const pair = ref<HTMLElement | null>(null);
async function choose(key: string): Promise<void> {
  wanted.value = key;
  // When the card is under the list (narrow page, not only narrow window): bring it into view.
  if (pair.value === null) return;
  if (window.getComputedStyle(pair.value).gridTemplateColumns.trim().split(/\s+/).length < 2) {
    await nextTick();
    detail.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const unsaved = computed(() => unsavedKeys(props.form, props.base));
const dirty = computed(() => unsaved.value.size > 0 || props.form.sprites !== props.base.sprites);
const changes = computed(() => unsavedCount(props.form, props.base));
const memory = computed(() => (overview.value === null ? null : memorySummary(overview.value.memory, overview.value.local)));
const localCount = computed(() => {
  const local = overview.value?.local ?? [];
  return { total: local.length, present: local.filter((model) => model.present).length, loaded: local.filter((model) => model.state === 'loaded').length, missing: local.filter((model) => !model.present).map((model) => model.id) };
});
const cloudCount = computed(() => {
  const cloud = overview.value?.cloud ?? [];
  return {
    total: cloud.length,
    on: cloud.filter((model) => model.state === 'on').length,
    missing: cloud.filter((model) => model.state === 'not-connected').map((model) => model.alias),
    executorOff: cloud.some((model) => model.state === 'executor-off'),
  };
});
const catalogErrors = computed(() => {
  const errors = overview.value?.errors;
  return errors === undefined ? [] : [errors.catalog, errors.cloudCatalog, errors.evals].filter((error): error is string => error !== null).map(overviewErrorText);
});

const TONE_CLASS: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', info: 'text-info', muted: 'text-muted', danger: 'text-danger' };
const PILL_CLASS: Record<Tone, string> = { ok: 'text-ok border-ok/50', warn: 'text-warn border-warn/55', info: 'text-info border-info/50', muted: '', danger: 'text-danger border-danger/50' };
function badgeClass(view: LocalModelView | CloudModelView): string {
  if (view.locality === 'local') return 'text-ok';
  return view.executor === 'claude' ? 'text-accent' : 'text-info';
}

// Models from Hugging Face (I-10): a new or changed entry of the user catalog is read again here and in the role menus.
async function catalogChanged(select?: string): Promise<void> {
  emit('catalog');
  await load();
  if (select !== undefined) {
    filter.value = { ...EMPTY_FILTER };
    await choose(`local:${select}`);
  }
}
/** The roles `[roles]` gives a model as saved: a promotion cannot take them away. */
function savedRoles(id: string): ModelRole[] {
  return MODEL_ROLES.filter((role) => props.base.roles[role] === id);
}

// Roles of a local model, from its card: the same form as «Chi fa cosa».
function holder(role: ModelRole): string | undefined {
  return props.form.roles[role];
}
function flipRole(role: ModelRole, id: string): void {
  const next = toggleRole(props.form.roles, role, id)[role];
  if (next === undefined) delete props.form.roles[role];
  else props.form.roles[role] = next;
}
/** The row of a cloud model in the form: its switch in the list, its exact name in the card. */
function rowOf(alias: string): CloudModelsForm['rows'][number] | undefined {
  return props.form.cloudModels.rows.find((row) => row.alias === alias);
}
function setEnabled(alias: string, event: Event): void {
  const row = rowOf(alias);
  if (row !== undefined) row.enabled = (event.target as HTMLInputElement).checked;
}
const currentRow = computed(() => {
  const view = current.value?.view;
  return view?.locality === 'cloud' ? rowOf(view.alias) : undefined;
});
/** The exact name the card describes (context, output): the saved one, else the first of the catalog. */
const currentName = computed(() => {
  const view = current.value?.view;
  return view?.locality === 'cloud' ? shownName(view.card, view.name ?? '') : undefined;
});

// Trials of the chosen local model (D-081): only the orchestrator has evals today.
const trials = ref<ModelEval[]>([]);
const trialError = ref<string | null>(null);
const trialBusy = ref(false);
const triable = computed(() => (current.value?.view.locality === 'local' && current.value.view.suitedRoles.includes('orchestrator') ? current.value.view : undefined));
async function loadTrials(): Promise<void> {
  const model = triable.value;
  if (model === undefined) return;
  try {
    const list = await listModelEvals(10, model.id);
    if (triable.value?.id !== model.id) return;
    trials.value = list;
    trialError.value = null;
  } catch (error) {
    if (triable.value?.id === model.id) trialError.value = errorText(error);
  }
}
// Another model: the trials of the one before never show under it, not even while the new ones load.
watch(
  () => triable.value?.id,
  () => {
    trials.value = [];
    trialError.value = null;
    void loadTrials();
  },
  { immediate: true },
);
async function tryModel(id: string): Promise<void> {
  trialBusy.value = true;
  trialError.value = null;
  try {
    await requestModelEval(id);
    await Promise.all([loadTrials(), load()]);
  } catch (error) {
    trialError.value = errorText(error);
  } finally {
    trialBusy.value = false;
  }
}
async function cancelTrial(id: string): Promise<void> {
  trialBusy.value = true;
  trialError.value = null;
  try {
    await cancelModelEval(id);
    await Promise.all([loadTrials(), load()]);
  } catch (error) {
    trialError.value = errorText(error);
  } finally {
    trialBusy.value = false;
  }
}
const TRIAL_CLASS: Record<ModelEval['status'], string> = {
  queued: 'text-muted',
  running: 'text-warn',
  passed: 'text-ok',
  failed: 'text-danger',
  error: 'text-danger',
  cancelled: 'text-muted',
};

// Actions on a local model (stage M4): always after a confirmation that says what happens.
const running = computed(() => runningAction(overview.value?.local ?? []));
const trash = computed(() => overview.value?.trash ?? null);
const reload = computed(() => reloadText(overview.value?.reload ?? null));
const reloadClosable = computed(() => reloadDismissable(overview.value?.reload ?? null));
async function closeReload(): Promise<void> {
  try {
    await dismissModelReload();
    await load();
  } catch (error) {
    loadError.value = errorText(error);
  }
}
const confirming = ref<Confirmation | null>(null);
const typed = ref('');
const actionBusy = ref(false);
const actionError = ref<string | null>(null);
const actionNotice = ref<string | null>(null);
watch(currentKey, () => {
  actionNotice.value = null;
});
function ask(kind: ButtonKind, view: LocalModelView): void {
  confirming.value = confirmationOf(kind, view);
  typed.value = '';
  actionError.value = null;
  actionNotice.value = null;
}
function askEmptyTrash(): void {
  if (trash.value === null) return;
  confirming.value = emptyTrashConfirmation(trash.value);
  typed.value = '';
  actionError.value = null;
}
function closeConfirmation(): void {
  confirming.value = null;
  actionError.value = null;
}
async function confirmAction(): Promise<void> {
  const shown = confirming.value;
  if (shown === null || !canConfirm(shown, typed.value) || actionBusy.value) return;
  actionBusy.value = true;
  actionError.value = null;
  const id = shown.modelId ?? '';
  try {
    if (shown.kind === 'download' || shown.kind === 'verify') await startModelAction(id, shown.kind);
    else if (shown.kind === 'cancel') await cancelModelAction(id);
    else if (shown.kind === 'unload') {
      const outcome = await unloadLocalModel(id);
      actionNotice.value = outcome === 'unloaded' ? `${id} non è più in memoria.` : 'Il server dei modelli non ha confermato: riprova fra poco, o riavvialo da Server dei modelli.';
    } else if (shown.kind === 'remove') {
      const folder = await removeModel(id, typed.value.trim());
      actionNotice.value = `Tolto dal disco: i file sono nel cestino, in ${folder}.`;
    } else {
      const emptied = await emptyModelTrash();
      actionNotice.value = emptied.removed === 0 ? 'Il cestino era già vuoto.' : `Cestino svuotato: liberati ${sizeText(Math.max(emptied.sizeBytes, 1))}.`;
    }
    confirming.value = null;
    await load();
    // A download or verification just started: the progress is read more often.
    schedule();
  } catch (error) {
    actionError.value = actionErrorText(error);
  } finally {
    actionBusy.value = false;
  }
}

// The bar: one write for roles, characters and switches.
const working = ref(false);
const savedNow = ref(false);
let savedTimer: number | undefined;
async function saveAll(): Promise<void> {
  working.value = true;
  try {
    if (await props.save()) {
      savedNow.value = true;
      window.clearTimeout(savedTimer);
      savedTimer = window.setTimeout(() => {
        savedNow.value = false;
      }, 4000);
      await load();
    }
  } finally {
    working.value = false;
  }
}

// Memory and trials change by themselves: read again every 10 s, every 1.5 s while a download or verification runs or oMLX reloads (D-201).
let timer: number | undefined;
let unmounted = false;
function schedule(): void {
  window.clearTimeout(timer);
  if (unmounted) return;
  timer = window.setTimeout(
    () => {
      void (async () => {
        await load();
        if (anyOpen(trials.value)) await loadTrials();
        schedule();
      })();
    },
    running.value === undefined && !reloadInProgress(overview.value?.reload ?? null) ? 10_000 : 1_500,
  );
}
onMounted(() => {
  void load().then(schedule);
});
onBeforeUnmount(() => {
  unmounted = true;
  window.clearTimeout(timer);
  window.clearTimeout(savedTimer);
});

const card = 'min-w-0 rounded-xl border border-line bg-surface-2 p-4';
const fact = 'flex flex-col gap-0.5 bg-surface px-3 py-2';
const factKey = 'text-[13px] text-muted';
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <!-- «Elenco» and «Confronto» (D-199) -->
    <div class="flex gap-1 border-b border-line" role="tablist" aria-label="Viste dei modelli">
      <button
        v-for="item in PAGE_TABS"
        :key="item.id"
        :id="`models-tab-${item.id}`"
        type="button"
        role="tab"
        class="-mb-px border-b-2 px-3 py-1.5 text-[14px] whitespace-nowrap"
        :class="tab === item.id ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'"
        :aria-selected="tab === item.id"
        :aria-controls="`models-panel-${item.id}`"
        @click="tab = item.id"
      >
        {{ item.text }}
      </button>
    </div>

    <ModelsCompare v-if="tab === 'compare'" id="models-panel-compare" role="tabpanel" aria-labelledby="models-tab-compare" />

    <div v-if="tab === 'list'" id="models-panel-list" role="tabpanel" aria-labelledby="models-tab-list" class="flex flex-col gap-3.5">
    <!-- oMLX reloading after a download (D-201) -->
    <div v-if="reload !== null" role="status" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-[14px] text-warn">
      <span class="min-w-0 flex-1">{{ reload }}</span>
      <button v-if="reloadClosable" type="button" class="btn px-2 py-0.5 text-[13px]" @click="closeReload">Fatto</button>
    </div>
    <!-- Three numbers -->
    <div class="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
      <div :class="card" class="flex flex-col gap-1">
        <span class="text-[13.5px] text-muted">Memoria del Mac per i modelli</span>
        <template v-if="memory !== null">
          <span class="text-[22px] leading-tight font-semibold tabular-nums">{{ memory.value }}</span>
          <div class="my-1 h-1.5 overflow-hidden rounded-[3px] border border-line bg-bg">
            <i class="block h-full" :class="memory.ratio > 0.85 ? 'bg-warn' : 'bg-accent'" :style="{ width: `${Math.round(memory.ratio * 100)}%` }" />
          </div>
          <span class="text-[13.5px] text-muted">{{ memory.detail }}</span>
        </template>
        <span v-else class="text-[13.5px] text-muted">Arianna non tiene il conto della memoria dei server dei modelli.</span>
      </div>
      <div :class="card" class="flex flex-col gap-1">
        <span class="text-[13.5px] text-muted">Modelli sul Mac</span>
        <span class="text-[22px] leading-tight font-semibold">{{ localCount.present }} di {{ localCount.total }} scaricati</span>
        <span class="text-[13.5px] text-muted">
          <template v-if="localCount.missing.length === 1">Manca {{ localCount.missing[0] }}: si scarica dalla sua scheda.</template>
          <template v-else-if="localCount.missing.length > 1">Ne mancano {{ localCount.missing.length }}: si scaricano dalla loro scheda.</template>
          <template v-else>{{ localCount.loaded === 1 ? '1 in memoria' : `${localCount.loaded} in memoria` }}.</template>
        </span>
        <span v-if="trash !== null" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-muted">
          Cestino: {{ trashText(trash) }}
          <button v-if="trash.entries.length > 0" type="button" class="btn btn-danger px-2 py-0.5 text-[13px]" :disabled="actionBusy" @click="askEmptyTrash">Svuota il cestino…</button>
        </span>
      </div>
      <div :class="card" class="flex flex-col gap-1">
        <span class="text-[13.5px] text-muted">Modelli cloud</span>
        <span class="text-[22px] leading-tight font-semibold">{{ cloudCount.on }} di {{ cloudCount.total }} accesi</span>
        <span class="text-[13.5px] text-muted">
          <template v-if="cloudCount.missing.length > 0">Non collegati: {{ cloudCount.missing.join(', ') }}. </template>
          <template v-if="cloudCount.executorOff">
            Uno è spento in
            <a href="/impostazioni/claude-e-codex" class="text-accent hover:underline" @click.prevent="emit('section', 'claude-e-codex')">Claude e Codex</a>.
          </template>
          <template v-else-if="cloudCount.missing.length === 0">Si accendono e spengono nell’elenco qui sotto.</template>
        </span>
      </div>
    </div>

    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">Non riesco a leggere i modelli: {{ loadError }}. Se il server dei modelli non risponde, riavvialo.</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="retrying" @click="retry">{{ retrying ? 'Riprovo…' : 'Riprova' }}</button>
      <a href="/impostazioni/server-dei-modelli" class="btn px-2.5 py-1 text-[13px]" @click.prevent="emit('section', 'server-dei-modelli')">Apri Server dei modelli</a>
    </div>
    <p v-for="problem in catalogErrors" :key="problem" role="alert" class="rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2.5 text-[14px]">{{ problem }}</p>

    <!-- Who does what: roles and the model of the characters -->
    <section :class="card" aria-labelledby="models-roles">
      <h2 id="models-roles" class="mb-1 text-[16px] font-semibold">Chi fa cosa</h2>
      <p class="mb-3 text-[14px] text-muted">Un compito ha un solo modello. Cambiarlo qui lo toglie a quello di prima; il nuovo si carica alla prossima richiesta.</p>
      <div class="grid gap-x-3.5 gap-y-3 sm:grid-cols-6">
        <div v-for="role in MODEL_ROLES" :key="role" class="grid content-start gap-1 sm:col-span-3">
          <label :for="`models-role-${role}`" class="text-[14px] font-medium">{{ ROLE_TEXT[role].task }}</label>
          <select :id="`models-role-${role}`" v-model="form.roles[role]" class="field min-w-0 px-2.5 py-1.5 text-[14px]">
            <option :value="undefined">— nessuno —</option>
            <option v-for="model in roleOptions(catalog, role)" :key="model.id" :value="model.id">{{ model.id }}{{ model.present ? '' : ' (da scaricare)' }}</option>
            <!-- A model of the file the catalog no longer has stays visible. -->
            <option v-if="form.roles[role] !== undefined && !roleOptions(catalog, role).some((model) => model.id === form.roles[role])" :value="form.roles[role]">
              {{ form.roles[role] }} (non più nel catalogo)
            </option>
          </select>
          <span class="text-[12.5px] text-muted">{{ ROLE_TEXT[role].hint }}</span>
        </div>
        <!-- D-123: the model that draws a character; Claude Opus unless the user chooses (D-132) -->
        <div class="grid content-start gap-1 sm:col-span-3">
          <label for="models-role-sprites" class="text-[14px] font-medium">Disegna i personaggi</label>
          <select id="models-role-sprites" v-model="form.sprites" class="field min-w-0 px-2.5 py-1.5 text-[14px]">
            <option value="opus">Claude Opus (consigliato)</option>
            <option value="sonnet">Claude Sonnet</option>
            <option value="local">Il modello sul Mac</option>
          </select>
          <span class="text-[12.5px] text-muted">Con Claude escono nome e descrizione dell’agente, non i tuoi dati, e si usa l’abbonamento. Con il modello sul Mac non esce nulla.</span>
        </div>
      </div>
    </section>

    <!-- Claude's opinion on the difficulty of an unsure step (D-207) -->
    <AdvisorSettings />

    <!-- Every model -->
    <section :class="card" aria-labelledby="models-all">
      <h2 class="flex flex-wrap items-center gap-2.5 text-[16px] font-semibold">
        <span id="models-all">Tutti i modelli</span>
        <span class="ml-auto flex flex-wrap items-center gap-2 text-[14px] font-normal" role="search">
          <span class="inline-flex overflow-hidden rounded-[9px] border border-line-strong" role="group" aria-label="Dove gira">
            <button
              v-for="item in WHERE"
              :key="item.id"
              type="button"
              class="px-3 py-1 text-[14px]"
              :class="filter.where === item.id ? 'bg-surface font-semibold text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
              :aria-pressed="filter.where === item.id"
              @click="filter.where = item.id"
            >
              {{ item.text }}
            </button>
          </span>
          <select v-model="filter.provider" class="field px-2 py-1 text-[14px]" aria-label="Fornitore">
            <option value="">Ogni fornitore</option>
            <option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option>
          </select>
          <select v-model="filter.use" class="field px-2 py-1 text-[14px]" aria-label="Compito">
            <option value="">Ogni compito</option>
            <option v-for="choice in USE_CHOICES" :key="choice.value" :value="choice.value">{{ choice.text }}</option>
          </select>
          <label class="inline-flex items-center gap-1.5 text-muted"><input v-model="filter.inUse" type="checkbox" />solo in uso</label>
          <input v-model="filter.query" type="search" class="field w-[200px] max-w-full px-2.5 py-1 text-[14px]" placeholder="Cerca un modello" aria-label="Cerca un modello" />
        </span>
      </h2>

      <div ref="pair" class="mt-3 grid grid-cols-1 items-start gap-4 @4xl:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <!-- The list -->
        <div class="flex flex-col overflow-hidden rounded-xl border border-line bg-surface-2" :aria-label="`Elenco dei modelli, ${countText(visible.length)}`">
          <p v-if="overview === null && loadError === null" class="px-3.5 py-3 text-[14px] text-muted">Leggo i modelli…</p>
          <p v-else-if="visible.length === 0 && entries.length > 0" class="px-3.5 py-3 text-[14px] text-muted">Nessun modello con questi filtri: togline uno o svuota la ricerca.</p>
          <div
            v-for="entry in visible"
            :key="entry.key"
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-line first-of-type:border-t-0"
            :class="entry.key === currentKey ? 'bg-surface shadow-[inset_3px_0_0_var(--accent)]' : 'hover:bg-surface'"
          >
            <button type="button" class="grid min-w-0 grid-cols-[34px_minmax(0,1fr)] items-center gap-x-2.5 py-2.5 pl-3 text-left" :aria-current="entry.key === currentKey ? 'true' : undefined" @click="choose(entry.key)">
              <span class="grid size-[34px] place-items-center rounded-[9px] border border-line-strong bg-surface text-[12px] font-semibold" :class="badgeClass(entry.view)">{{ entry.badge }}</span>
              <span class="min-w-0">
                <!-- The whole name, wrapped: a long id is never cut. -->
                <span class="block text-[14.5px] font-semibold [overflow-wrap:anywhere]">
                  {{ entry.name }}<span v-if="unsaved.has(entry.key)" class="text-warn" title="Modifiche non salvate">&nbsp;<span aria-hidden="true">•</span><span class="sr-only">modifiche non salvate</span></span>
                </span>
                <span class="block text-[13px] text-muted">
                  {{ entry.view.locality === 'local' ? 'Sul Mac' : 'Cloud' }} · <span :class="TONE_CLASS[entry.state.tone]">{{ entry.state.text }}</span
                  ><template v-if="entry.roles.length > 0"> · {{ entry.roles.map((role) => ROLE_NAME[role].toLowerCase()).join(', ') }}</template
                  ><template v-if="entry.view.locality === 'local' && entry.view.lastEval !== null"> · prova: {{ MODEL_EVAL_STATUS_TEXT[entry.view.lastEval.status] }}</template>
                </span>
              </span>
            </button>
            <!-- The one switch of a cloud model (D-192) -->
            <span class="pr-3">
              <input
                v-if="entry.view.locality === 'cloud' && rowOf(entry.view.alias) !== undefined"
                :checked="rowOf(entry.view.alias)?.enabled"
                type="checkbox"
                role="switch"
                class="switch"
                :aria-label="`${entry.name} acceso`"
                :title="rowOf(entry.view.alias)?.enabled ? 'Acceso' : 'Spento'"
                @change="setEnabled(entry.view.alias, $event)"
              />
            </span>
          </div>
        </div>

        <!-- The card -->
        <div ref="detail" class="min-w-0 scroll-mt-4" aria-live="polite">
          <!-- A local model -->
          <section v-if="current?.view.locality === 'local'" class="flex flex-col gap-3" :aria-label="`Scheda di ${current.name}`">
            <div class="flex items-center gap-3">
              <span class="grid size-[44px] shrink-0 place-items-center rounded-[10px] border border-line-strong bg-surface text-sm font-semibold text-ok">{{ current.badge }}</span>
              <div class="min-w-0">
                <h3 class="text-[18px] font-semibold [overflow-wrap:anywhere]">{{ current.name }}</h3>
                <p class="text-[13px] text-muted">
                  {{ current.view.provider ?? 'Fornitore non indicato' }} · sul Mac · <span class="font-mono text-[12.5px] [overflow-wrap:anywhere]">{{ current.view.id }}</span>
                  <template v-if="current.view.origin === 'huggingface'"> · <span class="pill border-info/50 text-info">da Hugging Face</span></template>
                </p>
              </div>
            </div>
            <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line @2xl:grid-cols-3">
              <div :class="fact"><dt :class="factKey">Spazio su disco</dt><dd class="text-[14.5px]">{{ sizeText(current.view.sizeBytes) }}<span v-if="!current.view.present" class="text-warn"> · da scaricare</span></dd></div>
              <div :class="fact"><dt :class="factKey">Memoria che occupa</dt><dd class="text-[14.5px]">almeno {{ current.view.ramMinGib }} GB</dd></div>
              <div :class="fact"><dt :class="factKey">Quanto testo ricorda</dt><dd class="text-[14.5px]" :class="{ 'text-muted': current.view.contextTokens === null }">{{ pagesText(current.view.contextTokens) }}</dd></div>
              <div :class="fact"><dt :class="factKey">Affidabilità</dt><dd class="text-[14.5px]" :class="current.view.status === 'verified' ? '' : 'text-warn'">{{ reliabilityText(current.view.status) }}</dd></div>
              <div :class="fact"><dt :class="factKey">Licenza</dt><dd class="text-[14.5px]" :class="{ 'text-muted': current.view.license === null }">{{ current.view.license ?? 'non indicata' }}</dd></div>
              <div :class="fact"><dt :class="factKey">Costo</dt><dd class="text-[14.5px]">nessuno, gira sul Mac</dd></div>
            </dl>
            <p class="text-[13.5px] text-muted">
              <template v-if="current.view.loaded.length > 0">
                <template v-for="(place, index) in current.view.loaded" :key="place.endpoint">
                  <template v-if="index > 0"> · </template>In memoria su <span class="font-mono text-[12.5px]">{{ place.endpoint }}</span
                  ><template v-if="place.gib !== null">, circa {{ place.gib }} GB</template><template v-if="place.busy">, sta lavorando adesso</template>
                </template>
              </template>
              <template v-else-if="current.view.present">Sul disco, non in memoria: si carica alla prima richiesta.</template>
              <template v-else>I file non sono ancora sul Mac: «Scarica» li prende da internet.<template v-if="current.view.suitedRoles.length > 0"> Si può già scegliere in «Chi fa cosa».</template></template>
            </p>

            <!-- Actions on the files and the memory (stage M4) and «Prova in chat» (D-142) -->
            <div v-if="current.view.action?.status === 'running'" class="flex flex-col gap-1" role="status">
              <div class="h-1.5 overflow-hidden rounded-[3px] border border-line bg-bg">
                <i class="block h-full bg-accent transition-[width]" :style="{ width: `${Math.round(progressOf(current.view.action).ratio * 100)}%` }" />
              </div>
              <span class="text-[13px] text-muted">{{ progressOf(current.view.action).text }}</span>
            </div>
            <p v-if="outcomeText(current.view.action) !== undefined" class="text-[13.5px]" :class="TONE_CLASS[outcomeText(current.view.action)?.tone ?? 'muted']">{{ outcomeText(current.view.action)?.text }}</p>
            <div class="flex flex-wrap items-center gap-2" aria-label="Azioni sul modello">
              <button v-if="canChatTrial(current.view)" type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="current.view.action?.status === 'running'" @click="emit('chatTrial', current.view.id)">Prova in chat</button>
              <button
                v-for="button in actionButtons(current.view, running)"
                :key="button.kind"
                type="button"
                class="btn px-3 py-1.5 text-[14px]"
                :class="button.danger ? 'border-danger/50 text-danger' : ''"
                :disabled="button.blocked !== undefined || actionBusy"
                @click="ask(button.kind, current.view)"
              >
                {{ button.text }}
              </button>
            </div>
            <p v-if="canChatTrial(current.view)" class="-mt-1 text-[13px] text-muted">«Prova in chat» apre una conversazione in incognito dove risponde solo questo modello.</p>
            <p v-for="reason in blockedReasons(actionButtons(current.view, running))" :key="reason" class="text-[13px] text-muted">{{ reason }}</p>
            <p v-if="actionNotice !== null" class="text-[13.5px] text-ok" role="status">{{ actionNotice }}</p>
            <HubEntryPanel v-if="current.view.origin === 'huggingface'" :view="current.view" :assigned="savedRoles(current.view.id)" @changed="catalogChanged()" @forgotten="catalogChanged()" />

            <template v-if="current.view.strengths.length > 0">
              <h4 class="mt-1 text-[15px] font-semibold">Punti di forza</h4>
              <ul class="flex list-disc flex-col gap-0.5 pl-5 text-[14px]">
                <li v-for="line in current.view.strengths" :key="line">{{ line }}</li>
              </ul>
            </template>
            <p v-if="current.view.notes !== null" class="text-[14px] text-muted">{{ current.view.notes }}</p>

            <h4 class="mt-1 text-[15px] font-semibold">Cosa fa in Arianna</h4>
            <ul v-if="usageLines(current.view).length > 0" class="flex list-disc flex-col gap-0.5 pl-5 text-[14px]">
              <li v-for="line in usageLines(current.view)" :key="line">{{ line }}</li>
            </ul>
            <p v-else class="text-[14px] text-muted">Nessun compito: oggi Arianna non lo usa.</p>
            <div v-if="current.view.suitedRoles.length > 0" class="flex flex-col gap-1.5">
              <span class="text-[13px] text-muted">Può fare questi compiti; sceglierne uno qui lo toglie al modello che lo ha ora:</span>
              <div class="flex flex-wrap gap-1.5" role="group" aria-label="Compiti del modello">
                <button
                  v-for="role in current.view.suitedRoles"
                  :key="role"
                  type="button"
                  class="rounded-full border px-2.5 py-0.5 text-[13px]"
                  :class="holder(role) === current.view.id ? 'border-accent bg-accent/10 text-ink' : 'border-line-strong text-muted hover:text-ink'"
                  :aria-pressed="holder(role) === current.view.id"
                  :title="holder(role) !== undefined && holder(role) !== current.view.id ? `Ora: ${holder(role)}` : undefined"
                  @click="flipRole(role, current.view.id)"
                >
                  {{ ROLE_TEXT[role].task }}<template v-if="holder(role) !== undefined && holder(role) !== current.view.id"> · ora {{ holder(role) }}</template>
                </button>
              </div>
            </div>

            <!-- Trials (D-081) -->
            <template v-if="triable !== undefined">
              <h4 class="mt-1 text-[15px] font-semibold">Prove</h4>
              <p class="text-[13.5px] text-muted">Una prova fa rispondere il modello a domande finte e conta quante ne azzecca. Non cambia il modello in uso; chiamate e lavori hanno la precedenza.</p>
              <p v-if="promotionHint(trials, triable.id, triable.status)" class="text-[13.5px] text-ok">{{ promotionHint(trials, triable.id, triable.status) }}</p>
              <p v-if="trialError !== null" role="alert" class="text-[13.5px] text-danger">{{ trialError }}</p>
              <div v-if="trials.length > 0" class="overflow-x-auto">
                <table class="w-full border-collapse text-[14px]">
                  <thead>
                    <tr class="text-left text-[13px] text-muted">
                      <th class="border-b border-line-strong py-1.5 pr-2 font-semibold">Data</th>
                      <th class="border-b border-line-strong px-2 py-1.5 font-semibold">Esito</th>
                      <th class="border-b border-line-strong px-2 py-1.5 font-semibold">Risposte giuste</th>
                      <th class="border-b border-line-strong px-2 py-1.5 font-semibold">Tempo medio</th>
                      <th class="border-b border-line-strong py-1.5 pl-2" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="trial in trials" :key="trial.id" class="border-b border-line align-top">
                      <td class="py-1.5 pr-2 whitespace-nowrap">{{ dateText(trial.requestedAt) }}</td>
                      <td class="px-2 py-1.5">
                        <span :class="TRIAL_CLASS[trial.status]">{{ MODEL_EVAL_STATUS_TEXT[trial.status] }}</span>
                        <small v-if="modelEvalErrorText(trial.error) !== undefined" class="block text-[12.5px] text-muted">{{ modelEvalErrorText(trial.error) }}</small>
                      </td>
                      <td class="px-2 py-1.5 whitespace-nowrap tabular-nums">{{ scoreText(trial) }}</td>
                      <td class="px-2 py-1.5 whitespace-nowrap tabular-nums">{{ latencyText(trial.latencyMedianMs) }}</td>
                      <td class="py-1.5 pl-2 text-right">
                        <button v-if="isOpen(trial)" type="button" class="btn px-2.5 py-0.5 text-[13px]" :disabled="trialBusy" @click="cancelTrial(trial.id)">Annulla</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else-if="trialError === null" class="text-[13.5px] text-muted">Nessuna prova finora: «Nuova prova» la fa partire.</p>
              <p v-if="current.view.lastEval !== null && !current.view.lastEval.sameWeights" class="text-[13.5px] text-warn">L’ultima prova è stata fatta su file del modello diversi da quelli di adesso.</p>
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="!canTry(trials, triable) || trialBusy" @click="tryModel(triable.id)">Nuova prova</button>
                <span v-if="!triable.present" class="text-[13px] text-muted">Prima scarica i file.</span>
                <span v-else-if="trials.some(isOpen)" class="text-[13px] text-muted">Una prova è già in corso.</span>
              </div>
            </template>

            <p class="rounded-[9px] border border-dashed border-line-strong px-3 py-2 text-[13.5px]">{{ privacyText(current.view) }}</p>
            <p v-if="current.view.source !== null" class="text-[12.5px] text-muted">
              Pagina del modello:
              <a :href="current.view.source" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 hover:text-ink hover:underline">{{ current.view.source }}<Icon name="external" :size="11" /></a>
            </p>
          </section>

          <!-- A cloud model -->
          <section v-else-if="current?.view.locality === 'cloud'" class="flex flex-col gap-3" :aria-label="`Scheda di ${current.name}`">
            <div class="flex items-center gap-3">
              <span class="grid size-[44px] shrink-0 place-items-center rounded-[10px] border border-line-strong bg-surface text-sm font-semibold" :class="badgeClass(current.view)">{{ current.badge }}</span>
              <div class="min-w-0">
                <h3 class="text-[18px] font-semibold">{{ current.name }}</h3>
                <p class="text-[13px] text-muted">
                  {{ current.provider }}<template v-if="current.view.card !== null"> · {{ current.view.card.family }}</template> · cloud, abbonamento {{ current.view.executor === 'codex' ? 'ChatGPT' : 'Claude' }}
                </p>
              </div>
            </div>
            <p v-if="cloudNotice(current.view) !== undefined" class="rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2 text-[13.5px]">
              {{ cloudNotice(current.view) }}
              <a v-if="current.view.state === 'executor-off'" href="/impostazioni/claude-e-codex" class="text-accent hover:underline" @click.prevent="emit('section', 'claude-e-codex')">Apri Claude e Codex</a>
              <template v-else-if="current.view.state === 'off'"> Si accende con l’interruttore nella sua riga dell’elenco.</template>
            </p>
            <p v-if="current.view.card === null" class="text-[14px] text-muted">Per questo modello non c’è ancora una scheda descrittiva.</p>
            <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line">
              <div :class="fact"><dt :class="factKey">Quanto testo ricorda</dt><dd class="text-[14.5px]">{{ pagesText(currentName?.contextTokens) }}</dd></div>
              <div :class="fact"><dt :class="factKey">Risposta più lunga</dt><dd class="text-[14.5px]">{{ pagesText(currentName?.maxOutputTokens) }}</dd></div>
              <div :class="fact"><dt :class="factKey">Approvazione</dt><dd class="text-[14.5px]">{{ current.view.budgetApproval ? 'ogni passo aspetta il tuo sì' : 'non serve' }}</dd></div>
              <div :class="fact"><dt :class="factKey">Costo</dt><dd class="text-[14.5px]">dentro l’abbonamento</dd></div>
              <div v-if="current.view.card?.quotaRatio !== undefined" :class="fact" class="col-span-2">
                <dt :class="factKey">Abbonamento consumato rispetto a {{ current.view.card.quotaRatio.relativeTo }}</dt>
                <dd class="text-[14.5px]">circa {{ current.view.card.quotaRatio.times }} volte</dd>
              </div>
            </dl>

            <template v-if="current.view.card !== null && current.view.card.strengths.length > 0">
              <h4 class="mt-1 text-[15px] font-semibold">Punti di forza</h4>
              <ul class="flex list-disc flex-col gap-0.5 pl-5 text-[14px]">
                <li v-for="line in current.view.card.strengths" :key="line.text">{{ line.text }}</li>
              </ul>
            </template>
            <p v-if="current.view.card?.notes" class="text-[14px] text-muted">{{ current.view.card.notes }}</p>

            <h4 class="mt-1 text-[15px] font-semibold">Cosa fa in Arianna</h4>
            <ul v-if="usageLines(current.view).length > 0" class="flex list-disc flex-col gap-0.5 pl-5 text-[14px]">
              <li v-for="line in usageLines(current.view)" :key="line">{{ line }}</li>
            </ul>
            <p v-else class="text-[14px] text-muted">Per ora nessun lavoro lo usa.</p>

            <p class="rounded-[9px] border border-dashed border-line-strong px-3 py-2 text-[13.5px]">{{ privacyText(current.view) }}</p>

            <!-- The exact name of the model: rarely needed, closed -->
            <details v-if="currentRow !== undefined" class="border-t border-line pt-2.5">
              <summary class="cursor-pointer text-[14px] text-muted">Avanzate: versione esatta del modello</summary>
              <div class="mt-2.5 grid content-start gap-1">
                <label :for="`cloud-name-${current.view.alias}`" class="text-[14px] font-medium">Versione</label>
                <input
                  :id="`cloud-name-${current.view.alias}`"
                  v-model="currentRow.name"
                  :list="`names-${current.view.alias}`"
                  class="field min-w-0 px-2.5 py-1.5 font-mono text-[12.5px]"
                  :disabled="!currentRow.enabled"
                  :placeholder="current.view.executor === 'codex' ? 'la prima della scheda' : 'la più recente'"
                />
                <datalist :id="`names-${current.view.alias}`">
                  <option v-for="item in current.view.card?.names ?? []" :key="item.name" :value="item.name">{{ item.description }}</option>
                </datalist>
                <span class="text-[12.5px] text-muted">Vuoto: la più recente. Il modello con cui parte ogni agente si sceglie in
                  <a href="/impostazioni/agenti" class="text-accent hover:underline" @click.prevent="emit('section', 'agenti')">Agenti</a>.</span>
              </div>
              <ul v-if="current.view.card !== null && current.view.card.names.length > 0" class="mt-2 flex flex-col gap-1 text-[13.5px]">
                <li v-for="item in current.view.card.names" :key="item.name">
                  <span class="font-mono text-[12.5px]">{{ item.name }}</span><span v-if="item.description" class="text-muted"> — {{ item.description }}</span>
                </li>
              </ul>
            </details>
            <p v-if="cardSources(current.view.card, overview?.sources ?? []).length > 0" class="text-[12.5px] text-muted">
              Fonti della scheda:
              <template v-for="(source, index) in cardSources(current.view.card, overview?.sources ?? [])" :key="source.id">
                <template v-if="index > 0">; </template>
                <a :href="source.url" target="_blank" rel="noopener noreferrer" class="hover:text-ink hover:underline">{{ source.url }}</a> (letta il {{ source.read }})
              </template>
              <template v-if="current.view.card?.terms">
                · <a :href="current.view.card.terms" target="_blank" rel="noopener noreferrer" class="hover:text-ink hover:underline">condizioni del fornitore</a>
              </template>
            </p>
          </section>
          <p v-else-if="overview !== null" class="text-[14px] text-muted">Scegli un modello dall’elenco.</p>
        </div>
      </div>
    </section>

    <!-- The server of the models and its releases (D-265) -->
    <OmlxRelease @changed="emit('omlx', $event)" />

    <HuggingFaceSearch @added="(id) => catalogChanged(id)" />
    </div>

    <!-- The confirmation of an action: what happens, how much, where -->
    <div v-if="confirming" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="model-action-title">
      <form class="flex max-w-lg flex-col gap-3 rounded-[14px] border border-line-strong bg-surface-2 p-4" @submit.prevent="confirmAction">
        <h2 id="model-action-title" class="text-[16px] font-semibold [overflow-wrap:anywhere]">{{ confirming.title }}</h2>
        <p v-for="line in confirming.lines" :key="line" class="text-[14px]">{{ line }}</p>
        <label v-if="confirming.typed !== undefined" class="flex flex-col gap-1 text-[13px] text-muted">
          Per confermare scrivi l’id del modello
          <input v-model="typed" class="field px-2 py-1.5 font-mono text-[14px] text-ink" :placeholder="confirming.typed" autocomplete="off" spellcheck="false" />
        </label>
        <p v-if="actionError !== null" class="text-[13.5px] text-danger" role="alert">{{ actionError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-3 py-1.5 text-[14px]" @click="closeConfirmation">Annulla</button>
          <button type="submit" class="btn px-3 py-1.5 text-[14px]" :class="confirming.danger ? 'btn-danger' : 'btn-primary'" :disabled="actionBusy || !canConfirm(confirming, typed)">{{ confirming.button }}</button>
        </div>
      </form>
    </div>

    <!-- One bar for roles, characters and switches (D-192) -->
    <SettingsSaveBar :dirty="dirty" :count="changes" :busy="working || busy" :saved="savedNow" :error="error" @cancel="emit('cancel')" @save="saveAll" />
  </div>
</template>

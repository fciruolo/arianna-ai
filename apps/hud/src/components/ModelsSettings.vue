<script setup lang="ts">
/**
 * Impostazioni → Modelli (I-3, D-137, stage M3): every model, local and
 * cloud, in a list on the left with filters and search, the chosen one in a
 * card on the right (below on a phone). Roles, the model of the characters
 * and the cloud switches are the parts of the settings the old sections
 * edited (`roles`, `sprites`, `cloudModels`): the card and the compact
 * panels below edit the same forms, one bar saves them in one write. Trials
 * of the orchestrator (D-081) start from the card. Read from
 * GET /api/models/overview, all L0. The actions on a local model (stage M4:
 * download, verify, unload, remove into the bin, empty the bin) ask for a
 * confirmation that says how much and where; a removal needs the id typed.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { cancelModelAction, cancelModelEval, emptyModelTrash, listModelEvals, loadModelsOverview, removeModel, requestModelEval, startModelAction, unloadLocalModel } from '../lib/api.ts';
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
  runningAction,
  trashText,
  type ButtonKind,
  type Confirmation,
} from '../lib/model-actions.ts';
import { anyOpen, canTry, dateText, isOpen, latencyText, promotionHint, scoreText, type ModelEval } from '../lib/model-evals.ts';
import {
  cardSources,
  chosenKey,
  cloudNotice,
  contextText,
  countText,
  EMPTY_FILTER,
  filterModels,
  memorySummary,
  modelEntries,
  overviewErrorText,
  priceText,
  privacyText,
  providersOf,
  ROLE_NAME,
  shownName,
  sizeText,
  toggleRole,
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
import Icon from './Icon.vue';

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
/** `cancel`: the parts back to what was read. `section`: another section of the settings. */
const emit = defineEmits<{ cancel: []; section: [slug: string] }>();

// The list
const overview = ref<ModelsOverview | null>(null);
const loadError = ref<string | null>(null);
async function load(): Promise<void> {
  try {
    overview.value = await loadModelsOverview();
    loadError.value = null;
  } catch (error) {
    loadError.value = errorText(error);
  }
}

const filter = ref<ModelFilter>({ ...EMPTY_FILTER });
const entries = computed(() => modelEntries(overview.value));
const providers = computed(() => providersOf(entries.value));
const visible = computed(() => filterModels(entries.value, filter.value));
const WHERE: { id: ModelFilter['where']; text: string }[] = [
  { id: 'all', text: 'Tutti' },
  { id: 'local', text: 'Locali' },
  { id: 'cloud', text: 'Cloud' },
];

const wanted = ref<string | null>(null);
const currentKey = computed(() => chosenKey(visible.value, wanted.value));
const current = computed(() => entries.value.find((entry) => entry.key === currentKey.value));
const detail = ref<HTMLElement | null>(null);
async function choose(key: string): Promise<void> {
  wanted.value = key;
  // On a narrow screen the card is under the list: bring it into view.
  if (window.matchMedia('(max-width: 1023px)').matches) {
    await nextTick();
    detail.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const unsaved = computed(() => unsavedKeys(props.form, props.base));
const dirty = computed(() => unsaved.value.size > 0 || props.form.sprites !== props.base.sprites);
const memory = computed(() => (overview.value === null ? null : memorySummary(overview.value.memory, overview.value.local)));
const localCount = computed(() => {
  const local = overview.value?.local ?? [];
  return { total: local.length, present: local.filter((model) => model.present).length, loaded: local.filter((model) => model.state === 'loaded').length };
});
const cloudCount = computed(() => {
  const cloud = overview.value?.cloud ?? [];
  return { total: cloud.length, on: cloud.filter((model) => model.state === 'on').length, missing: cloud.filter((model) => model.state === 'not-connected').map((model) => model.alias) };
});
const catalogErrors = computed(() => {
  const errors = overview.value?.errors;
  return errors === undefined ? [] : [errors.catalog, errors.cloudCatalog, errors.evals].filter((error): error is string => error !== null).map(overviewErrorText);
});

const TONE_CLASS: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', info: 'text-info', muted: 'text-muted', danger: 'text-danger' };
function badgeClass(view: LocalModelView | CloudModelView): string {
  if (view.locality === 'local') return 'text-ok';
  return view.executor === 'claude' ? 'text-accent' : 'text-info';
}

// Roles of a local model, from its card: the same form as the panel below.
function holder(role: ModelRole): string | undefined {
  return props.form.roles[role];
}
function flipRole(role: ModelRole, id: string): void {
  const next = toggleRole(props.form.roles, role, id)[role];
  if (next === undefined) delete props.form.roles[role];
  else props.form.roles[role] = next;
}
/** The switch and exact name of the chosen cloud model: the same row as the panel below. */
const currentRow = computed(() => {
  const view = current.value?.view;
  return view?.locality === 'cloud' ? props.form.cloudModels.rows.find((row) => row.alias === view.alias) : undefined;
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
      actionNotice.value = outcome === 'unloaded' ? `${id} non è più in memoria.` : 'Il server locale non ha confermato: riprova fra poco, o riavvialo da Server locali.';
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

// Memory and trials change by themselves: read again every 10 s, every 1.5 s while a download or verification runs.
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
    running.value === undefined ? 10_000 : 1_500,
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
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-[13px] text-muted">Locali e cloud in un posto solo: cosa sono, chi li usa e come sono andati alle prove. Tutto ciò che vedi qui è Pubblico: numeri e nomi, nessun testo.</p>

    <!-- Summary -->
    <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div class="hud-card flex flex-col gap-1.5 px-3.5 py-3">
        <span class="hud-title text-[10px]">Memoria dei modelli locali</span>
        <template v-if="memory !== null">
          <span class="font-hud text-lg leading-tight font-medium">{{ memory.value }}</span>
          <div class="h-1.5 overflow-hidden rounded-[3px] border border-line bg-surface-2">
            <i class="block h-full" :class="memory.ratio > 0.85 ? 'bg-warn' : 'bg-accent'" :style="{ width: `${Math.round(memory.ratio * 100)}%` }" />
          </div>
          <span class="text-xs text-muted">{{ memory.detail }}</span>
        </template>
        <span v-else class="text-xs text-muted">Il nucleo non tiene il conto della memoria dei server locali.</span>
      </div>
      <div class="hud-card flex flex-col gap-1.5 px-3.5 py-3">
        <span class="hud-title text-[10px]">Modelli locali</span>
        <span class="font-hud text-lg leading-tight font-medium">{{ localCount.present }} di {{ localCount.total }} sul disco</span>
        <span class="text-xs text-muted">{{ localCount.loaded === 1 ? '1 in memoria' : `${localCount.loaded} in memoria` }} · i mancanti si scaricano dalla loro scheda</span>
        <span v-if="trash !== null" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          Cestino: {{ trashText(trash) }}
          <button v-if="trash.entries.length > 0" type="button" class="btn btn-danger px-2 py-0.5 text-xs" :disabled="actionBusy" @click="askEmptyTrash">Svuota il cestino…</button>
        </span>
      </div>
      <div class="hud-card flex flex-col gap-1.5 px-3.5 py-3">
        <span class="hud-title text-[10px]">Modelli cloud</span>
        <span class="font-hud text-lg leading-tight font-medium">{{ cloudCount.on }} di {{ cloudCount.total }} accesi</span>
        <span class="text-xs text-muted">
          <template v-if="cloudCount.missing.length > 0">Non collegato: {{ cloudCount.missing.join(', ') }}. </template>La quota dell’abbonamento si misurerà qui più avanti.
        </span>
      </div>
    </div>

    <p v-if="loadError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">Non riesco a leggere i modelli: {{ loadError }}</p>
    <p v-for="problem in catalogErrors" :key="problem" role="alert" class="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-[13px]">
      <span class="font-mono text-xs">{{ problem }}</span>
    </p>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-2" role="search">
      <div class="inline-flex overflow-hidden rounded-[9px] border border-line-strong" role="group" aria-label="Dove gira">
        <button
          v-for="item in WHERE"
          :key="item.id"
          type="button"
          class="border-line-strong px-3 py-1 text-[13px] not-first:border-l"
          :class="filter.where === item.id ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'"
          :aria-pressed="filter.where === item.id"
          @click="filter.where = item.id"
        >
          {{ item.text }}
        </button>
      </div>
      <select v-model="filter.provider" class="field px-2 py-1 text-[13px]" aria-label="Fornitore">
        <option value="">Tutti i fornitori</option>
        <option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option>
      </select>
      <select v-model="filter.use" class="field px-2 py-1 text-[13px]" aria-label="Ruolo o passo">
        <option value="">Tutti i ruoli e i passi</option>
        <option v-for="choice in USE_CHOICES" :key="choice.value" :value="choice.value">{{ choice.text }}</option>
      </select>
      <label class="inline-flex items-center gap-1.5 text-[13px] text-muted"><input v-model="filter.inUse" type="checkbox" />solo in uso</label>
      <input v-model="filter.query" type="search" class="field min-w-[160px] flex-1 px-2.5 py-1 text-[13px]" placeholder="Cerca un modello" aria-label="Cerca un modello" />
    </div>

    <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
      <!-- The list -->
      <section class="hud-card flex flex-col" aria-label="Elenco dei modelli">
        <header class="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
          <h2 class="hud-title flex-1">Elenco</h2>
          <span class="text-xs text-muted">{{ countText(visible.length) }}</span>
        </header>
        <p v-if="overview === null && loadError === null" class="px-3.5 py-3 text-sm text-muted">Leggo i modelli…</p>
        <p v-else-if="visible.length === 0 && entries.length > 0" class="px-3.5 py-3 text-xs text-muted">Nessun modello con questi filtri.</p>
        <button
          v-for="entry in visible"
          :key="entry.key"
          type="button"
          class="grid grid-cols-[34px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1 border-t border-line px-3.5 py-2.5 text-left first-of-type:border-t-0 hover:bg-surface-2"
          :class="entry.key === currentKey ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--accent)]' : ''"
          :aria-current="entry.key === currentKey ? 'true' : undefined"
          @click="choose(entry.key)"
        >
          <span class="grid size-[34px] place-items-center rounded-[9px] border border-line-strong bg-surface-2 font-hud text-xs font-semibold" :class="badgeClass(entry.view)">{{ entry.badge }}</span>
          <span class="min-w-0">
            <!-- The whole id, wrapped: the chips sit on their own line below, so a long id is never cut or squeezed out. -->
            <span class="block font-medium [overflow-wrap:anywhere]" :class="entry.view.locality === 'local' ? 'font-mono text-[12.5px]' : ''">
              {{ entry.name }}<span v-if="unsaved.has(entry.key)" class="text-warn" title="Modifiche non salvate">&nbsp;<span aria-hidden="true">•</span><span class="sr-only">modifiche non salvate</span></span>
            </span>
            <span class="block truncate text-xs text-muted">{{ entry.sub }}</span>
          </span>
          <span class="col-start-2 flex flex-wrap gap-1">
            <span class="chip" :class="TONE_CLASS[entry.state.tone]">{{ entry.state.text }}</span>
            <span v-for="role in entry.roles" :key="role" class="chip text-accent">{{ ROLE_NAME[role].toLowerCase() }}</span>
            <span v-if="entry.view.locality === 'local' && entry.view.lastEval !== null" class="chip" :class="TRIAL_CLASS[entry.view.lastEval.status]" title="Ultima prova">
              prova: {{ MODEL_EVAL_STATUS_TEXT[entry.view.lastEval.status] }}
            </span>
          </span>
        </button>
      </section>

      <!-- The card -->
      <div ref="detail" class="min-w-0 scroll-mt-4" aria-live="polite">
        <!-- A local model -->
        <section v-if="current?.view.locality === 'local'" class="hud-card flex flex-col gap-3.5 px-4 py-4" :aria-label="`Scheda di ${current.name}`">
          <div class="flex items-center gap-3">
            <span class="grid size-[42px] shrink-0 place-items-center rounded-[10px] border border-line-strong bg-surface-2 font-hud text-sm font-semibold text-ok">{{ current.badge }}</span>
            <div class="min-w-0">
              <h2 class="font-mono text-[15px] font-semibold break-all">{{ current.view.id }}</h2>
              <p class="text-[12.5px] text-muted">{{ current.view.provider ?? 'Fornitore non indicato' }} · famiglia {{ current.view.family }} · runtime {{ current.view.runtime }}</p>
            </div>
          </div>
          <dl class="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-2">
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">Peso su disco</dt><dd class="text-[13px]">{{ sizeText(current.view.sizeBytes) }}</dd></div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">RAM minima</dt><dd class="text-[13px]">{{ current.view.ramMinGib }} GiB</dd></div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">Contesto</dt><dd class="text-[13px]" :class="{ 'text-muted': current.view.contextTokens === null }">{{ contextText(current.view.contextTokens) }}</dd></div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2">
              <dt class="hud-title text-[9.5px]">Stato del catalogo</dt>
              <dd><span class="chip" :class="current.view.status === 'verified' ? 'text-ok' : 'text-warn'">{{ current.view.status === 'verified' ? 'verificato' : 'sperimentale' }}</span></dd>
            </div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2">
              <dt class="hud-title text-[9.5px]">File</dt>
              <dd class="text-[13px]">
                <span class="chip" :class="current.view.present ? 'text-ok' : 'text-warn'">{{ current.view.present ? 'presenti' : 'da scaricare' }}</span>
              </dd>
            </div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2">
              <dt class="hud-title text-[9.5px]">In memoria</dt>
              <dd class="text-[13px]">
                <template v-if="current.view.loaded.length > 0">
                  <span v-for="place in current.view.loaded" :key="place.endpoint" class="block">
                    <span class="chip text-ok">caricato da Arianna</span>
                    su <span class="font-mono text-xs">{{ place.endpoint }}</span><template v-if="place.gib !== null"> · ≈ {{ place.gib }} GiB</template><template v-if="place.busy"> · in uso adesso</template>
                  </span>
                </template>
                <span v-else class="text-muted">non caricato</span>
              </dd>
            </div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">Licenza</dt><dd class="text-[13px]" :class="{ 'text-muted': current.view.license === null }">{{ current.view.license ?? 'non indicata' }}</dd></div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">Costo</dt><dd class="text-[13px]">nessuna quota: gira sul Mac</dd></div>
          </dl>
          <!-- Actions on the files and the memory (stage M4) -->
          <div class="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5" aria-label="Azioni sul modello">
            <h3 class="hud-title text-[10.5px]">File e memoria</h3>
            <p v-if="!current.view.present && current.view.action?.status !== 'running'" class="text-xs text-muted">
              I file mancano in <code class="font-mono">data/models/{{ current.view.id }}</code>: «Scarica» li prende dagli indirizzi del catalogo. Si può già assegnare a un ruolo.
            </p>
            <div v-if="current.view.action?.status === 'running'" class="flex flex-col gap-1" role="status">
              <div class="h-1.5 overflow-hidden rounded-[3px] border border-line bg-surface-2">
                <i class="block h-full bg-accent transition-[width]" :style="{ width: `${Math.round(progressOf(current.view.action).ratio * 100)}%` }" />
              </div>
              <span class="text-xs text-muted">{{ progressOf(current.view.action).text }}</span>
            </div>
            <p v-if="outcomeText(current.view.action) !== undefined" class="text-xs" :class="TONE_CLASS[outcomeText(current.view.action)?.tone ?? 'muted']">{{ outcomeText(current.view.action)?.text }}</p>
            <div v-if="actionButtons(current.view, running).length > 0" class="flex flex-wrap items-center gap-2">
              <button
                v-for="button in actionButtons(current.view, running)"
                :key="button.kind"
                type="button"
                class="btn px-3 py-1 text-[13px]"
                :class="button.danger ? 'btn-danger' : ''"
                :disabled="button.blocked !== undefined || actionBusy"
                @click="ask(button.kind, current.view)"
              >
                {{ button.text }}
              </button>
            </div>
            <p v-for="reason in blockedReasons(actionButtons(current.view, running))" :key="reason" class="text-xs text-muted">{{ reason }}</p>
            <p v-if="actionNotice !== null" class="text-xs text-ok" role="status">{{ actionNotice }}</p>
          </div>

          <template v-if="current.view.strengths.length > 0">
            <h3 class="hud-title text-[10.5px]">Punti di forza</h3>
            <ul class="flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
              <li v-for="line in current.view.strengths" :key="line">{{ line }}</li>
            </ul>
          </template>
          <p v-if="current.view.notes !== null" class="text-[13px] text-muted">{{ current.view.notes }}</p>

          <h3 class="hud-title text-[10.5px]">Ruoli e uso in Arianna</h3>
          <ul v-if="usageLines(current.view).length > 0" class="flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
            <li v-for="line in usageLines(current.view)" :key="line">{{ line }}</li>
          </ul>
          <p v-else class="text-[13px] text-muted">Nessun ruolo: oggi Arianna non lo usa.</p>
          <p class="text-xs text-muted">Dopo il salvataggio l’uso si aggiorna con i ruoli nuovi.</p>
          <div v-if="current.view.suitedRoles.length > 0" class="flex flex-col gap-1.5">
            <span class="text-xs text-muted">Adatto a questi ruoli (un ruolo ha un solo modello: sceglierlo qui lo toglie a quello di prima):</span>
            <div class="flex flex-wrap gap-1.5" role="group" aria-label="Ruoli del modello">
              <button
                v-for="role in current.view.suitedRoles"
                :key="role"
                type="button"
                class="rounded-full border px-2.5 py-0.5 text-xs"
                :class="holder(role) === current.view.id ? 'border-accent bg-glow text-ink' : 'border-line-strong text-muted hover:text-ink'"
                :aria-pressed="holder(role) === current.view.id"
                :title="holder(role) !== undefined && holder(role) !== current.view.id ? `Ora: ${holder(role)}` : undefined"
                @click="flipRole(role, current.view.id)"
              >
                {{ ROLE_NAME[role] }}<template v-if="holder(role) !== undefined && holder(role) !== current.view.id"> · ora {{ holder(role) }}</template>
              </button>
            </div>
          </div>

          <!-- Trials (D-081) -->
          <template v-if="triable !== undefined">
            <h3 class="hud-title text-[10.5px]">Prove dell’orchestratore</h3>
            <p class="text-xs text-muted">
              Una prova fa girare i casi dell’orchestratore (<code class="font-mono">evals/orchestrator</code>, dati finti) su questo modello, senza cambiare quello in uso. Chiamate e task
              hanno la precedenza. Il catalogo non viene mai modificato.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="!canTry(trials, triable) || trialBusy" @click="tryModel(triable.id)">Prova</button>
              <span v-if="!triable.present" class="text-xs text-muted">Serve avere i file sul disco.</span>
              <span v-else-if="trials.some(isOpen)" class="text-xs text-muted">Una prova è già in corso.</span>
            </div>
            <p v-if="promotionHint(trials, triable.id, triable.status)" class="text-xs text-ok">{{ promotionHint(trials, triable.id, triable.status) }}</p>
            <p v-if="trialError !== null" role="alert" class="text-xs text-danger">{{ trialError }}</p>
            <div v-if="trials.length > 0" class="overflow-x-auto">
              <table class="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr class="hud-title text-left">
                    <th class="pr-2 pb-1.5 font-semibold">Data</th>
                    <th class="px-2 pb-1.5 font-semibold">Esito</th>
                    <th class="px-2 pb-1.5 font-semibold">Punteggio</th>
                    <th class="px-2 pb-1.5 font-semibold">Mediana</th>
                    <th class="px-2 pb-1.5 font-semibold">Pesi</th>
                    <th class="pb-1.5 pl-2" />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="trial in trials" :key="trial.id" class="border-t border-line align-top">
                    <td class="py-1.5 pr-2 whitespace-nowrap">{{ dateText(trial.requestedAt) }}</td>
                    <td class="px-2 py-1.5">
                      <span :class="TRIAL_CLASS[trial.status]">{{ MODEL_EVAL_STATUS_TEXT[trial.status] }}</span>
                      <small v-if="modelEvalErrorText(trial.error) !== undefined" class="block text-[11.5px] text-muted">{{ modelEvalErrorText(trial.error) }}</small>
                    </td>
                    <td class="px-2 py-1.5 whitespace-nowrap">{{ scoreText(trial) }}</td>
                    <td class="px-2 py-1.5 whitespace-nowrap">{{ latencyText(trial.latencyMedianMs) }}</td>
                    <td class="px-2 py-1.5 font-mono text-xs">{{ trial.weightsSha256?.slice(0, 8) ?? '—' }}</td>
                    <td class="py-1.5 pl-2 text-right">
                      <button v-if="isOpen(trial)" type="button" class="btn px-2.5 py-0.5 text-xs" :disabled="trialBusy" @click="cancelTrial(trial.id)">Annulla</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else-if="trialError === null" class="text-xs text-muted">Nessuna prova finora.</p>
            <p v-if="current.view.lastEval !== null && !current.view.lastEval.sameWeights" class="text-xs text-warn">L’ultima prova è stata fatta su pesi diversi da quelli che il catalogo indica ora.</p>
          </template>

          <p class="rounded-[9px] border border-dashed border-line-strong px-3 py-2 text-[12.5px]">{{ privacyText(current.view) }}</p>
          <p v-if="current.view.source !== null" class="text-[11.5px] text-muted">
            Pagina del modello:
            <a :href="current.view.source" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 hover:text-ink hover:underline">{{ current.view.source }}<Icon name="external" :size="11" /></a>
          </p>
        </section>

        <!-- A cloud model -->
        <section v-else-if="current?.view.locality === 'cloud'" class="hud-card flex flex-col gap-3.5 px-4 py-4" :aria-label="`Scheda di ${current.name}`">
          <div class="flex items-center gap-3">
            <span class="grid size-[42px] shrink-0 place-items-center rounded-[10px] border border-line-strong bg-surface-2 font-hud text-sm font-semibold" :class="badgeClass(current.view)">{{ current.badge }}</span>
            <div class="min-w-0">
              <h2 class="font-hud text-[17px] font-semibold tracking-[0.03em]">{{ current.name }}</h2>
              <p class="text-[12.5px] text-muted">
                {{ current.provider }}<template v-if="current.view.card !== null"> · {{ current.view.card.family }}</template> · esecutore <span class="font-mono">{{ current.view.executor }}</span> · alias
                <span class="font-mono">{{ current.view.alias }}</span>
              </p>
            </div>
          </div>
          <p v-if="cloudNotice(current.view) !== undefined" class="rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2 text-[12.5px]">
            {{ cloudNotice(current.view) }}
            <a v-if="current.view.state === 'executor-off'" href="/impostazioni/esecutori-cloud" class="text-accent hover:underline" @click.prevent="emit('section', 'esecutori-cloud')">Apri Esecutori cloud</a>
          </p>
          <p v-if="current.view.card === null" class="text-[13px] text-muted">Nessuna scheda per questo modello in <code class="font-mono">config/cloud-models.catalog.yaml</code>.</p>
          <dl class="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-2">
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2">
              <dt class="hud-title text-[9.5px]">Nome passato a --model</dt>
              <dd class="text-[13px]" :class="current.view.name === null ? 'text-muted' : 'font-mono text-xs'">{{ current.view.name ?? 'il più recente (alias)' }}</dd>
            </div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2">
              <dt class="hud-title text-[9.5px]">Contesto · uscita massima</dt>
              <dd class="text-[13px]">
                {{ contextText(currentName?.contextTokens) }}<template v-if="currentName?.maxOutputTokens !== undefined"> · {{ contextText(currentName.maxOutputTokens) }}</template>
              </dd>
            </div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2">
              <dt class="hud-title text-[9.5px]">Approvazione di budget</dt>
              <dd class="text-[13px]">{{ current.view.budgetApproval ? 'sì: ogni passo aspetta il tuo sì' : 'no' }}</dd>
            </div>
            <div class="flex flex-col gap-0.5 bg-surface px-3 py-2">
              <dt class="hud-title text-[9.5px]">Costo in quota</dt>
              <dd class="text-[13px] text-muted">non ancora misurato</dd>
            </div>
            <div v-if="priceText(current.view.card?.apiPrice) !== undefined" class="flex flex-col gap-0.5 bg-surface px-3 py-2 sm:col-span-2">
              <dt class="hud-title text-[9.5px]">Prezzo dell’API (solo per confronto)</dt>
              <dd class="text-[13px]">{{ priceText(current.view.card?.apiPrice) }}<small class="block text-[11.5px] text-muted">L’abbonamento non si paga a richiesta: dice solo quanto pesa un modello rispetto a un altro.</small></dd>
            </div>
            <div v-if="current.view.card?.quotaRatio !== undefined" class="flex flex-col gap-0.5 bg-surface px-3 py-2 sm:col-span-2">
              <dt class="hud-title text-[9.5px]">Quota rispetto a {{ current.view.card.quotaRatio.relativeTo }}</dt>
              <dd class="text-[13px]">circa {{ current.view.card.quotaRatio.times }} volte</dd>
            </div>
          </dl>

          <template v-if="current.view.card !== null && current.view.card.names.length > 0">
            <h3 class="hud-title text-[10.5px]">Nomi esatti</h3>
            <ul class="flex flex-col gap-1 text-[13px]">
              <li v-for="item in current.view.card.names" :key="item.name">
                <span class="font-mono text-xs">{{ item.name }}</span><span v-if="item.description" class="text-muted"> — {{ item.description }}</span>
              </li>
            </ul>
          </template>
          <template v-if="current.view.card !== null && current.view.card.strengths.length > 0">
            <h3 class="hud-title text-[10.5px]">Punti di forza</h3>
            <ul class="flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
              <li v-for="line in current.view.card.strengths" :key="line.text">{{ line.text }}</li>
            </ul>
          </template>
          <p v-if="current.view.card?.notes" class="text-[13px] text-muted">{{ current.view.card.notes }}</p>

          <h3 class="hud-title text-[10.5px]">Uso tipico in Arianna</h3>
          <ul v-if="usageLines(current.view).length > 0" class="flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
            <li v-for="line in usageLines(current.view)" :key="line">{{ line }}</li>
          </ul>
          <p v-else class="text-[13px] text-muted">Nessun passo del router lo usa.</p>

          <p class="rounded-[9px] border border-dashed border-line-strong px-3 py-2 text-[12.5px]">{{ privacyText(current.view) }}</p>
          <p v-if="cardSources(current.view.card, overview?.sources ?? []).length > 0" class="text-[11.5px] text-muted">
            Fonti della scheda, scritta a mano:
            <template v-for="(source, index) in cardSources(current.view.card, overview?.sources ?? [])" :key="source.id">
              <template v-if="index > 0">; </template>
              <a :href="source.url" target="_blank" rel="noopener noreferrer" class="hover:text-ink hover:underline">{{ source.url }}</a> (letta il {{ source.read }})
            </template>
            <template v-if="current.view.card?.terms">
              · <a :href="current.view.card.terms" target="_blank" rel="noopener noreferrer" class="hover:text-ink hover:underline">condizioni del fornitore</a>
            </template>
          </p>
          <div v-if="currentRow !== undefined" class="flex flex-wrap items-center gap-2.5 border-t border-line pt-3">
            <label class="flex items-center gap-2 text-[13px]">
              <input v-model="currentRow.enabled" type="checkbox" role="switch" class="switch" :aria-label="`${current.name} acceso`" />
              {{ currentRow.enabled ? 'Acceso' : 'Spento' }}
            </label>
            <input
              v-model="currentRow.name"
              :list="`names-${current.view.alias}`"
              class="field min-w-[180px] flex-1 px-2 py-1 font-mono text-xs"
              :disabled="!currentRow.enabled"
              :placeholder="current.view.executor === 'codex' ? 'il primo della scheda' : 'il più recente'"
              :aria-label="`Nome esatto di ${current.view.alias}`"
            />
            <datalist :id="`names-${current.view.alias}`">
              <option v-for="item in current.view.card?.names ?? []" :key="item.name" :value="item.name" />
            </datalist>
          </div>
        </section>
        <p v-else-if="overview !== null" class="text-sm text-muted">Scegli un modello dall’elenco.</p>
      </div>
    </div>

    <!-- Roles and switches, compact: the same forms as the cards -->
    <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <section class="hud-card flex flex-col gap-2.5 px-4 py-3.5" aria-labelledby="models-roles">
        <h2 id="models-roles" class="hud-title">Ruoli dei modelli locali</h2>
        <div class="flex flex-col">
          <div v-for="role in MODEL_ROLES" :key="role" class="grid grid-cols-1 items-center gap-1 border-t border-line py-2 first:border-t-0 first:pt-0 sm:grid-cols-[130px_minmax(0,1fr)] sm:gap-3">
            <label :for="`models-role-${role}`" class="text-[13px] font-medium">
              {{ ROLE_TEXT[role].title }}<small class="block text-[11.5px] font-normal text-muted">{{ ROLE_TEXT[role].hint }}</small>
            </label>
            <select :id="`models-role-${role}`" v-model="form.roles[role]" class="field min-w-0 px-2 py-1 text-[13px]">
              <option :value="undefined">— nessuno —</option>
              <option v-for="model in roleOptions(catalog, role)" :key="model.id" :value="model.id">{{ model.id }}{{ model.present ? '' : ' (da scaricare)' }}</option>
              <!-- A model of the file the catalog no longer has stays visible. -->
              <option v-if="form.roles[role] !== undefined && !roleOptions(catalog, role).some((model) => model.id === form.roles[role])" :value="form.roles[role]">
                {{ form.roles[role] }} (non nel catalogo)
              </option>
            </select>
          </div>
          <!-- D-123: the model that draws a character; Claude Opus unless the user chooses (D-132) -->
          <div class="grid grid-cols-1 items-center gap-1 border-t border-line pt-2 sm:grid-cols-[130px_minmax(0,1fr)] sm:gap-3">
            <label for="models-role-sprites" class="text-[13px] font-medium">Personaggi<small class="block text-[11.5px] font-normal text-muted">disegna l’aspetto degli agenti</small></label>
            <select id="models-role-sprites" v-model="form.sprites" class="field min-w-0 px-2 py-1 text-[13px]">
              <option value="sonnet">Claude Sonnet</option>
              <option value="opus">Claude Opus (predefinito)</option>
              <option value="local">modello locale (quello dell’orchestratore)</option>
            </select>
          </div>
        </div>
        <p class="text-xs text-muted">
          Con Claude, «Genera personaggio» manda verso il cloud, passando dal gateway, nome, descrizione e prompt dell’agente, tono e specializzazione e il tuo suggerimento (Interno), e usa la
          tua quota; serve Claude attivo fra gli esecutori cloud. Con il modello locale non esce nulla. Cambiare modello non riavvia oMLX: lo carica per nome alla prossima richiesta.
        </p>
      </section>

      <section class="hud-card flex flex-col gap-2.5 px-4 py-3.5" aria-labelledby="models-switches">
        <h2 id="models-switches" class="hud-title">Modelli cloud accesi</h2>
        <div class="flex flex-col">
          <div v-for="row in form.cloudModels.rows" :key="row.alias" class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t border-line py-2 first:border-t-0 first:pt-0 sm:grid-cols-[auto_120px_minmax(0,1fr)]" :class="{ 'text-muted': !row.enabled }">
            <input v-model="row.enabled" type="checkbox" role="switch" class="switch" :aria-label="`${row.alias} acceso`" />
            <span class="text-[13px] whitespace-nowrap">{{ entries.find((entry) => entry.key === `cloud:${row.alias}`)?.name ?? row.alias }}</span>
            <input v-model="row.name" class="field col-span-2 min-w-0 px-2 py-1 font-mono text-xs sm:col-span-1" :disabled="!row.enabled" placeholder="il più recente" :aria-label="`Nome esatto di ${row.alias}`" />
          </div>
        </div>
        <p class="text-xs text-muted">
          Un modello spento esce dal router e dal selettore delle conversazioni. Il nome esatto resta nella famiglia del modello (es. <code class="font-mono">opus[1m]</code>); vuoto è il più
          recente. Il modello con cui parte ogni agente si sceglie in
          <a href="/impostazioni/agenti" class="text-accent hover:underline" @click.prevent="emit('section', 'agenti')">Agenti</a>; accendere un esecutore resta in
          <a href="/impostazioni/esecutori-cloud" class="text-accent hover:underline" @click.prevent="emit('section', 'esecutori-cloud')">Esecutori cloud</a>, con la sua conferma.
        </p>
      </section>
    </div>

    <!-- The confirmation of an action: what happens, how much, where -->
    <div v-if="confirming" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="model-action-title">
      <form class="hud-card flex max-w-lg flex-col gap-3 p-4" @submit.prevent="confirmAction">
        <h2 id="model-action-title" class="font-hud text-[12px] font-semibold tracking-[0.14em] uppercase break-all">{{ confirming.title }}</h2>
        <p v-for="line in confirming.lines" :key="line" class="text-[13px]">{{ line }}</p>
        <label v-if="confirming.typed !== undefined" class="flex flex-col gap-1 text-xs text-muted">
          Per confermare scrivi l’id del modello
          <input v-model="typed" class="field px-2 py-1.5 font-mono text-[13px] text-ink" :placeholder="confirming.typed" autocomplete="off" spellcheck="false" />
        </label>
        <p v-if="actionError !== null" class="text-xs text-danger" role="alert">{{ actionError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="closeConfirmation">Annulla</button>
          <button type="submit" class="btn px-2.5 py-1 text-xs" :class="confirming.danger ? 'btn-danger' : 'btn-primary'" :disabled="actionBusy || !canConfirm(confirming, typed)">{{ confirming.button }}</button>
        </div>
      </form>
    </div>

    <!-- One bar for roles, characters and switches -->
    <div
      v-if="dirty || working || savedNow || error"
      class="sticky bottom-4 z-10 mx-auto flex max-w-full flex-wrap items-center gap-3 rounded-xl border bg-surface py-2 pr-3 pl-4 shadow-[0_10px_30px_#0006,0_0_0_4px_var(--glow)]"
      :class="error ? 'border-danger' : 'border-accent'"
      role="status"
    >
      <span class="min-w-0 text-[13px]" :class="{ 'text-danger': error }">
        <template v-if="error">{{ error }}</template>
        <template v-else-if="working || busy">Salvo…</template>
        <template v-else-if="dirty">Modifiche non salvate ai modelli</template>
        <template v-else>Salvato</template>
      </span>
      <template v-if="dirty">
        <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="working || busy" @click="emit('cancel')">Annulla</button>
        <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="working || busy" @click="saveAll">Salva</button>
      </template>
    </div>
  </div>
</template>

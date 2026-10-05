<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  ApiError,
  confirmPrivacy,
  listCopiedVoices,
  loadCharacters,
  loadLocalLog,
  loadSettings,
  loadVoiceTrial,
  preparePrivacy,
  restartLocal,
  saveSettings,
  type CopiedVoice,
  type TrialModel,
} from '../lib/api.ts';
import { agentName } from '../lib/italian.ts';
import { EXECUTOR_TEXT, MODEL_TEXT } from '../lib/labels.ts';
import {
  charactersBody,
  chatId,
  CLOUD_EXECUTORS,
  copy,
  cloudModelsBody,
  cloudModelsForm,
  endpointsBody,
  endpointsForm,
  executorsBody,
  MODEL_ROLES,
  ROLE_TEXT,
  roleOptions,
  rolesBody,
  keptSections,
  pollAction,
  SECTION_TEXT,
  sectionChanged,
  STATE_TEXT,
  telegramBody,
  telegramForm,
  voiceBody,
  voiceForm,
  voiceProblem,
  writeError,
  type CatalogModel,
  type CloudModelRow,
  type CloudModelsForm,
  type EndpointForm,
  type LocalServerStatus,
  type ModelRole,
  type OrdinarySection,
  type PrivacyProposal,
  type PrivacySection,
  type ProjectValues,
  type Section,
  type SettingsValues,
  type SettingsView,
  type TelegramForm,
  type VoiceForm,
  type VoiceValues,
} from '../lib/settings.ts';
import type { CharacterChoice, CharacterListing } from '../lib/types.ts';
import Icon from './Icon.vue';
import ModelEvals from './ModelEvals.vue';
import PixelAgent from './PixelAgent.vue';
import PrivacyConfirm from './PrivacyConfirm.vue';
import SettingsCard from './SettingsCard.vue';

/**
 * The settings page of the web chat (D-071), over /api/settings. Each card
 * edits one section of arianna.toml: the ordinary ones are saved at once,
 * the privacy ones are prepared, shown in a confirmation card and written
 * only on Conferma. Every write carries the fingerprint of the file the page
 * read: a 409 means someone else wrote it, and the page reloads the values.
 */
const emit = defineEmits<{ changed: [sections: string[]] }>();

interface Forms {
  roles: Partial<Record<ModelRole, string>>;
  cloudModels: CloudModelsForm;
  characters: Record<string, string>;
  voice: VoiceForm;
  executors: string[];
  telegram: TelegramForm;
  projects: ProjectValues[];
  endpoints: EndpointForm[];
}

function formsOf(values: SettingsValues, defaults: VoiceValues): Forms {
  return {
    roles: { ...values.roles },
    cloudModels: cloudModelsForm(values.cloudModels),
    characters: { ...values.characters },
    voice: voiceForm(values.voice, defaults),
    executors: [...values.executors],
    telegram: telegramForm(values.telegram),
    projects: values.projects.map((project) => ({ ...project })),
    endpoints: endpointsForm(values.endpoints),
  };
}

const SECTIONS: Section[] = ['roles', 'cloudModels', 'characters', 'voice', 'executors', 'telegram', 'projects', 'endpoints'];

const view = ref<SettingsView | null>(null);
const local = ref<LocalServerStatus[]>([]);
const forms = ref<Forms | null>(null);
const loadError = ref<string | null>(null);
/** The file changed under the page (a 409, or seen by the poll). */
const notice = ref<string | null>(null);
const stale = ref(false);
const busy = ref<Section | null>(null);
const errors = ref<Partial<Record<Section, string>>>({});
const proposal = ref<{ section: PrivacySection; value: PrivacyProposal } | null>(null);
const confirmError = ref<string | null>(null);
/** After a refused confirmation the id is spent: the card asks to review again. */
const confirmSpent = ref(false);
/** Counts writes and applies: a read started before one of them is older than the page. */
let generation = 0;

const base = computed(() => (view.value?.values === null || view.value === null ? null : formsOf(view.value.values, view.value.voiceDefaults)));

function changed(section: Section): boolean {
  return forms.value !== null && base.value !== null && sectionChanged(section, forms.value[section], base.value[section]);
}

function reset(section: Section): void {
  if (forms.value === null || base.value === null) return;
  (forms.value as unknown as Record<Section, unknown>)[section] = copy(base.value[section]);
  delete errors.value[section];
}

/** A new view: changed cards keep their edits unless `all`; the others show the new values. */
function apply(next: SettingsView, keep: readonly Section[] = []): void {
  generation += 1;
  if (next.local !== undefined) local.value = next.local;
  const old = forms.value;
  const kept = old === null ? [] : keptSections(keep, changed);
  view.value = next;
  stale.value = false;
  if (next.values === null) {
    forms.value = null;
    return;
  }
  const fresh = formsOf(next.values, next.voiceDefaults);
  if (old !== null) for (const section of kept) (fresh as unknown as Record<Section, unknown>)[section] = old[section];
  forms.value = fresh;
}

async function reload(): Promise<void> {
  const started = ++generation;
  try {
    const next = await loadSettings();
    if (started !== generation) return;
    apply(next);
    loadError.value = null;
    errors.value = {};
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'errore';
  }
}

function fail(section: Section, error: unknown): void {
  if (!(error instanceof ApiError)) {
    errors.value[section] = error instanceof Error ? error.message : 'errore';
    return;
  }
  const { text, reload: again } = writeError(error.status, error.message);
  if (again) {
    notice.value = text;
    void reload();
  } else {
    errors.value[section] = text;
  }
}

function others(section: Section): Section[] {
  return SECTIONS.filter((item) => item !== section);
}

// The card saved last says "Salvato" for a few seconds: without it a save looked like nothing happened.
const saved = ref<Section | null>(null);
let savedTimer: number | undefined;
function markSaved(section: Section): void {
  saved.value = section;
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => {
    saved.value = null;
  }, 4000);
}

async function save(section: OrdinarySection): Promise<void> {
  const current = forms.value;
  const fingerprint = view.value?.fingerprint;
  if (current === null || fingerprint === null || fingerprint === undefined) return;
  const values: Partial<Pick<SettingsValues, OrdinarySection>> = {};
  if (section === 'roles') values.roles = rolesBody(current.roles);
  if (section === 'cloudModels') values.cloudModels = cloudModelsBody(current.cloudModels);
  if (section === 'characters') values.characters = charactersBody(current.characters);
  if (section === 'voice') values.voice = voiceBody(current.voice);
  generation += 1;
  busy.value = section;
  delete errors.value[section];
  notice.value = null;
  try {
    apply(await saveSettings(fingerprint, values), others(section));
    markSaved(section);
    emit('changed', [section]);
  } catch (error) {
    fail(section, error);
  } finally {
    busy.value = null;
  }
}

async function prepare(section: PrivacySection): Promise<void> {
  const current = forms.value;
  const fingerprint = view.value?.fingerprint;
  if (current === null || fingerprint === null || fingerprint === undefined) return;
  const values: Partial<Pick<SettingsValues, PrivacySection>> = {};
  if (section === 'executors') values.executors = executorsBody(current.executors);
  if (section === 'telegram') values.telegram = telegramBody(current.telegram);
  if (section === 'projects') values.projects = current.projects.map((project) => ({ ...project }));
  if (section === 'endpoints') values.endpoints = endpointsBody(current.endpoints, view.value?.values?.endpoints);
  generation += 1;
  busy.value = section;
  delete errors.value[section];
  notice.value = null;
  try {
    proposal.value = { section, value: await preparePrivacy(fingerprint, values) };
    confirmError.value = null;
    confirmSpent.value = false;
  } catch (error) {
    fail(section, error);
  } finally {
    busy.value = null;
  }
}

async function confirm(): Promise<void> {
  const open = proposal.value;
  if (open === null) return;
  generation += 1;
  busy.value = open.section;
  confirmError.value = null;
  try {
    apply(await confirmPrivacy(open.value.id), others(open.section));
    proposal.value = null;
    markSaved(open.section);
    emit('changed', [open.section]);
    // The local servers restart with the new url or command: their state follows.
    if (open.section === 'endpoints') void poll();
  } catch (error) {
    if (error instanceof ApiError) {
      const { text, reload: again } = writeError(error.status, error.message);
      if (again) {
        proposal.value = null;
        notice.value = text;
        void reload();
      } else {
        confirmError.value = `${text} Chiudi e rivedi di nuovo le uscite.`;
      }
    } else {
      confirmError.value = `${error instanceof Error ? error.message : 'errore'}. Chiudi e rivedi di nuovo le uscite.`;
    }
    // The core spends the id even when it refuses: a second click could only fail.
    confirmSpent.value = true;
  } finally {
    busy.value = null;
  }
}

// The state of the local servers changes by itself; the file may change by hand.
let timer: number | undefined;
async function poll(): Promise<void> {
  const started = generation;
  try {
    const next = await loadSettings();
    if (next.local !== undefined) local.value = next.local;
    const action = pollAction({
      started,
      generation,
      fingerprint: next.fingerprint,
      seen: view.value?.fingerprint ?? null,
      open: proposal.value !== null,
      busy: busy.value !== null,
      dirty: SECTIONS.some(changed),
    });
    if (action === 'stale') stale.value = true;
    else if (action === 'apply') apply(next);
  } catch {
    // The next poll tries again.
  }
}

// Voices of the speech model and pixel characters, for the choices.
const ttsModels = ref<TrialModel[]>([]);
const clones = ref<CopiedVoice[]>([]);
const characters = ref<CharacterListing | null>(null);

onMounted(() => {
  void reload();
  void loadVoiceTrial()
    .then((trial) => {
      ttsModels.value = trial.models.filter((model) => model.kind === 'tts');
    })
    .catch(() => undefined);
  void listCopiedVoices()
    .then((list) => {
      clones.value = list;
    })
    .catch(() => undefined);
  void loadCharacters()
    .then((listing) => {
      characters.value = listing;
    })
    .catch(() => undefined);
  timer = window.setInterval(() => void poll(), 5000);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  window.clearTimeout(savedTimer);
});

const catalog = computed(() => view.value?.catalog ?? []);
/** A model turned off cannot stay the default one. */
function modelToggled(row: CloudModelRow): void {
  if (!row.enabled && forms.value?.cloudModels.default === row.alias) forms.value.cloudModels.default = null;
}
function chosenModel(role: ModelRole): CatalogModel | undefined {
  const id = forms.value?.roles[role];
  return catalog.value.find((model) => model.id === id);
}

/** The voices of the speech model chosen in the card of the models (the saved one until then). */
const voiceChoices = computed(() => {
  const tts = forms.value?.roles.tts ?? view.value?.values?.roles.tts;
  const voices = ttsModels.value.find((model) => model.id === tts)?.voices ?? [];
  return voices.map((voice) => ({ value: voice, label: clones.value.find((clone) => clone.id === voice)?.name ?? voice }));
});

const agentIds = computed(() => {
  const ids = new Set([...Object.keys(characters.value?.agents ?? {}), ...Object.keys(view.value?.values?.characters ?? {})]);
  return [...ids].sort((a, b) => (a === 'arianna' ? -1 : b === 'arianna' ? 1 : a.localeCompare(b)));
});
const characterOptions = computed(() =>
  (characters.value?.packs ?? []).flatMap((pack) => pack.characters.map((character) => ({ value: `${pack.id}/${character.id}`, label: `${pack.name} · ${character.name}`, pack, character }))),
);
function previewOf(agent: string): CharacterChoice | undefined {
  const value = forms.value?.characters[agent] ?? '';
  const option = characterOptions.value.find((item) => item.value === value);
  if (option !== undefined) return { pack: option.pack.id, character: option.character.id, rows: option.character.rows };
  return value === '' ? characters.value?.agents[agent] : undefined;
}

// Telegram chats and projects: added from a small row of fields.
const newChat = ref('');
function addChat(): void {
  const id = chatId(newChat.value);
  if (id === undefined || forms.value === null) return;
  if (!forms.value.telegram.chats.includes(id)) forms.value.telegram.chats.push(id);
  newChat.value = '';
}
const newProject = ref<ProjectValues>({ name: '', path: '', label: 'L1' });
const projectAddable = computed(() => {
  const name = newProject.value.name.trim();
  return name !== '' && newProject.value.path.trim() !== '' && !(forms.value?.projects.some((project) => project.name === name) ?? false);
});
function addProject(): void {
  if (forms.value === null || !projectAddable.value) return;
  forms.value.projects.push({ name: newProject.value.name.trim(), path: newProject.value.path.trim(), label: newProject.value.label });
  newProject.value = { name: '', path: '', label: 'L1' };
}
function addEndpoint(): void {
  forms.value?.endpoints.push({ id: '', url: 'http://127.0.0.1:', command: '' });
}

// Local servers: restart and the end of the log.
const restarting = ref<string | null>(null);
const restartError = ref<Record<string, string>>({});
const logs = ref<Record<string, string | null>>({});
async function restart(id: string): Promise<void> {
  restarting.value = id;
  delete restartError.value[id];
  try {
    await restartLocal(id);
    await poll();
    if (logs.value[id] !== undefined) void readLog(id);
  } catch (error) {
    restartError.value[id] = error instanceof Error ? error.message : 'errore';
  } finally {
    restarting.value = null;
  }
}
async function readLog(id: string): Promise<void> {
  try {
    logs.value[id] = await loadLocalLog(id);
  } catch (error) {
    logs.value[id] = `(non leggibile: ${error instanceof Error ? error.message : 'errore'})`;
  }
  // The newest lines are the ones that matter (a restart, an error): open at the end.
  await nextTick();
  const box = document.getElementById(`log-${id}`);
  if (box !== null) box.scrollTop = box.scrollHeight;
}
function toggleLog(id: string, event: Event): void {
  if ((event.target as HTMLDetailsElement).open) void readLog(id);
}
function restartBlocker(server: LocalServerStatus): string | undefined {
  if (!server.managed) return 'Senza comando: il nucleo lo osserva soltanto.';
  if (server.adopted) return 'Era già acceso prima del nucleo: riavvialo dove l’hai avviato.';
  return undefined;
}

const STATE_CLASS: Record<string, string> = {
  up: 'bg-ok shadow-[0_0_8px_var(--ok)]',
  starting: 'animate-hud-blink bg-warn',
  restarting: 'animate-hud-blink bg-warn',
  down: 'bg-danger',
  failed: 'bg-danger',
  idle: 'bg-muted',
  stopped: 'bg-muted',
};

const INDEX: { group: string; items: { id: string; title: string; privacy?: boolean }[] }[] = [
  {
    group: 'Valgono subito',
    items: [
      { id: 'roles', title: 'Modelli locali' },
      { id: 'model-evals', title: 'Prove dei modelli' },
      { id: 'cloud-models', title: 'Modelli cloud' },
      { id: 'voice', title: 'Voce' },
      { id: 'characters', title: 'Personaggi' },
    ],
  },
  {
    group: 'Uscite · con conferma',
    items: [
      { id: 'executors', title: 'Esecutori cloud', privacy: true },
      { id: 'telegram', title: 'Telegram', privacy: true },
      { id: 'projects', title: 'Progetti', privacy: true },
      { id: 'servers', title: 'Server locali', privacy: true },
    ],
  },
  { group: 'Solo lettura', items: [{ id: 'labels', title: 'Etichette' }] },
];
const scroller = ref<HTMLElement | null>(null);
function go(id: string): void {
  scroller.value?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <nav :inert="proposal !== null" class="hidden w-[210px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line px-3 py-5 lg:flex" aria-label="Indice delle impostazioni">
      <template v-for="group in INDEX" :key="group.group">
        <h2 class="hud-title mx-2.5 mt-3.5 mb-1.5 first:mt-0">{{ group.group }}</h2>
        <a
          v-for="item in group.items"
          :key="item.id"
          :href="`#${item.id}`"
          class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-ink"
          @click.prevent="go(item.id)"
        >
          <Icon v-if="item.privacy" name="gateway" :size="15" class="text-warn" />
          {{ item.title }}
        </a>
      </template>
    </nav>

    <div ref="scroller" :inert="proposal !== null" class="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[860px] flex-col gap-5 px-4 pt-5 pb-24 md:px-6">
        <header>
          <h1 class="font-hud text-xl font-semibold tracking-[0.05em]">Impostazioni</h1>
          <p class="mt-1 text-sm text-muted">Ogni modifica vale subito, senza riavviare Arianna. Le uscite verso il cloud, Telegram e i server locali chiedono una conferma.</p>
        </header>

        <!-- On narrow screens the index is a row of links. -->
        <nav class="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden" aria-label="Indice delle impostazioni">
          <a
            v-for="item in INDEX.flatMap((group) => group.items)"
            :key="item.id"
            :href="`#${item.id}`"
            class="shrink-0 rounded-full border border-line-strong bg-surface-2 px-3 py-1 text-xs whitespace-nowrap"
            :class="item.privacy ? 'text-warn' : 'text-muted'"
            @click.prevent="go(item.id)"
          >{{ item.title }}</a>
        </nav>

        <p v-if="loadError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
          Non riesco a leggere le impostazioni: {{ loadError }}
        </p>
        <p v-if="view === null && loadError === null" class="text-muted">Leggo le impostazioni…</p>

        <template v-if="view !== null">
          <p class="flex items-start gap-2.5 rounded-[10px] border border-info/45 bg-info/9 px-3.5 py-2.5 text-[13px]">
            <Icon name="info" :size="16" class="mt-0.5 text-info" />
            <span>
              Salvare da qui riscrive <code class="font-mono text-xs">config/arianna.toml</code>: i commenti scritti a mano nel file si perdono, come con
              <code class="font-mono text-xs">pnpm arianna:init --reconfigure</code>.
            </span>
          </p>
          <p v-if="view.restartPending.length > 0" class="flex items-start gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[13px]">
            <Icon name="warning" :size="16" class="mt-0.5 text-warn" />
            <span>
              In attesa di riavvio del nucleo: {{ view.restartPending.map((section) => SECTION_TEXT[section] ?? section).join(', ') }}. Sono cambiati nel file e valgono al
              prossimo <code class="font-mono text-xs">pnpm start</code>.
            </span>
          </p>
          <p v-if="notice !== null" role="alert" class="flex items-start gap-2.5 rounded-[10px] border border-danger/50 bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
            <Icon name="warning" :size="16" class="mt-0.5" />
            <span class="flex-1">{{ notice }}</span>
            <button type="button" class="rounded-md p-0.5 hover:bg-danger/20" aria-label="Chiudi" @click="notice = null"><Icon name="close" :size="14" /></button>
          </p>
          <p v-if="stale" role="status" class="flex items-center gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[13px]">
            <Icon name="warning" :size="16" class="text-warn" />
            <span class="flex-1">Il file è cambiato fuori da questa pagina: salvando ora la modifica sarebbe rifiutata.</span>
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="reload">Ricarica i valori</button>
          </p>
          <p v-if="view.error !== null" role="alert" class="rounded-[10px] border border-danger/50 bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
            <code class="font-mono text-xs">config/arianna.toml</code> non è valido, e finché non lo correggi a mano tutte le uscite sono chiuse: {{ view.error }}
          </p>

          <template v-if="forms !== null">
            <!-- Models by role -->
            <SettingsCard id="roles" title="Modelli locali per ruolo" kind="now" :changed="changed('roles')" :saved="saved === 'roles'" :busy="busy === 'roles'" :error="errors.roles" @cancel="reset('roles')" @save="save('roles')">
              <div class="flex flex-col">
                <div v-for="role in MODEL_ROLES" :key="role" class="grid grid-cols-1 items-center gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0 sm:grid-cols-[140px_minmax(0,1fr)] md:grid-cols-[140px_minmax(0,1fr)_auto] md:gap-3">
                  <label :for="`role-${role}`" class="font-medium">
                    {{ ROLE_TEXT[role].title }}<small class="block text-[11.5px] font-normal text-muted">{{ ROLE_TEXT[role].hint }}</small>
                  </label>
                  <select :id="`role-${role}`" v-model="forms.roles[role]" class="field min-w-0 px-2 py-1.5 text-[13px]">
                    <option :value="undefined">— nessuno —</option>
                    <option v-for="model in roleOptions(catalog, role)" :key="model.id" :value="model.id">{{ model.id }}{{ model.present ? '' : ' (da scaricare)' }}</option>
                    <!-- A model of the file the catalog no longer has stays visible. -->
                    <option v-if="forms.roles[role] !== undefined && !roleOptions(catalog, role).some((model) => model.id === forms?.roles[role])" :value="forms.roles[role]">
                      {{ forms.roles[role] }} (non nel catalogo)
                    </option>
                  </select>
                  <div class="flex flex-wrap gap-1.5 sm:col-start-2 md:col-start-auto md:justify-end">
                    <template v-if="chosenModel(role) !== undefined">
                      <span class="chip">≥ {{ chosenModel(role)?.ramMinGib }} GiB</span>
                      <span class="chip" :class="chosenModel(role)?.status === 'verified' ? 'text-ok' : 'text-warn'">{{ chosenModel(role)?.status === 'verified' ? 'verificato' : 'sperimentale' }}</span>
                      <span class="chip" :class="chosenModel(role)?.present ? 'text-ok' : 'text-danger'">{{ chosenModel(role)?.present ? 'file presenti' : 'file mancanti' }}</span>
                    </template>
                    <span v-else-if="roleOptions(catalog, role).length === 0" class="chip">nessun modello del catalogo per questo ruolo</span>
                  </div>
                </div>
              </div>
              <p class="text-xs text-muted">
                Un modello senza file in <code class="font-mono">data/models</code> si può scegliere, ma va scaricato con
                <code class="font-mono">pnpm arianna:models pull</code>. Cambiare modello non riavvia oMLX: lo carica per nome alla prossima richiesta.
              </p>
            </SettingsCard>

            <!-- Trials of the catalog models (D-081) -->
            <ModelEvals :catalog="catalog" :current="view.values?.roles.orchestrator" />

            <!-- Cloud models -->
            <SettingsCard id="cloud-models" title="Modelli cloud" kind="now" :changed="changed('cloudModels')" :saved="saved === 'cloudModels'" :busy="busy === 'cloudModels'" :error="errors.cloudModels" @cancel="reset('cloudModels')" @save="save('cloudModels')">
              <div class="overflow-x-auto">
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr class="hud-title text-left">
                      <th class="pr-2 pb-2 font-semibold">Acceso</th>
                      <th class="px-2 pb-2 font-semibold">Modello</th>
                      <th class="px-2 pb-2 font-semibold">Nome esatto (facoltativo)</th>
                      <th class="pb-2 pl-2 font-semibold">Predefinito</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in forms.cloudModels.rows" :key="row.alias" class="border-t border-line" :class="{ 'text-muted': !row.enabled }">
                      <td class="py-2 pr-2">
                        <input
                          v-model="row.enabled"
                          type="checkbox"
                          role="switch"
                          class="switch"
                          :aria-label="`${MODEL_TEXT[row.alias] ?? row.alias} acceso`"
                          @change="modelToggled(row)"
                        />
                      </td>
                      <td class="px-2 py-2 whitespace-nowrap">{{ MODEL_TEXT[row.alias] ?? row.alias }}</td>
                      <td class="px-2 py-2">
                        <input v-model="row.name" class="field w-full min-w-[150px] px-2 py-1 font-mono text-xs" :disabled="!row.enabled" placeholder="il più recente" :aria-label="`Nome esatto di ${row.alias}`" />
                      </td>
                      <td class="py-2 pl-2 text-center">
                        <input v-model="forms.cloudModels.default" type="radio" name="default-model" :value="row.alias" :disabled="!row.enabled" :aria-label="`${row.alias} predefinito`" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="text-xs text-muted">
                Un modello spento esce dal router e dal selettore delle conversazioni. Il nome esatto resta nella famiglia del modello (es.
                <code class="font-mono">opus[1m]</code>, <code class="font-mono">claude-opus-5-5</code>); vuoto è il più recente. Il predefinito vale per le conversazioni nuove. Per
                Codex la scelta si salva e vale con il suo adattatore.
              </p>
            </SettingsCard>

            <!-- Voice -->
            <SettingsCard id="voice" title="Voce e chiamate" kind="now" :changed="changed('voice')" :saved="saved === 'voice'" :invalid="voiceProblem(forms.voice)" :busy="busy === 'voice'" :error="errors.voice" @cancel="reset('voice')" @save="save('voice')">
              <template #header>
                <label class="flex items-center gap-2 text-xs text-muted">
                  {{ forms.voice.enabled ? 'accese' : 'spente' }}
                  <input v-model="forms.voice.enabled" type="checkbox" role="switch" class="switch" aria-label="Chiamate accese" />
                </label>
              </template>
              <template v-if="forms.voice.enabled">
                <div class="grid grid-cols-1 gap-x-3.5 gap-y-2.5 sm:grid-cols-2">
                  <label class="flex flex-col gap-1 text-xs text-muted">
                    Voce di Arianna
                    <input v-model.trim="forms.voice.values.voice" list="voice-choices" class="field px-2 py-1.5 text-[13px] text-ink" />
                    <datalist id="voice-choices">
                      <option v-for="choice in voiceChoices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
                    </datalist>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted">
                    Porta del servizio della voce
                    <input v-model.number="forms.voice.values.port" type="number" min="1024" max="65535" class="field px-2 py-1.5 text-[13px] text-ink" />
                  </label>
                </div>
                <p class="text-xs text-muted">
                  Le voci proposte sono quelle del modello di sintesi scelto sopra; provale nel provino della voce. Cambiare porta o spegnere le chiamate riavvia solo il servizio della
                  voce, appena non c’è una chiamata in corso.
                </p>

                <h3 class="hud-title mt-1">Limiti di una chiamata</h3>
                <div class="grid grid-cols-2 gap-x-3.5 gap-y-2.5 sm:grid-cols-4">
                  <label class="flex flex-col gap-1 text-xs text-muted">Durata massima (min)<input v-model.number="forms.voice.values.limits.callMinutes" type="number" min="1" max="120" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Avviso prima della fine (s)<input v-model.number="forms.voice.values.limits.warnSeconds" type="number" min="0" max="600" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Deleghe per chiamata<input v-model.number="forms.voice.values.limits.delegations" type="number" min="0" max="50" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Attesa di una delega (s)<input v-model.number="forms.voice.values.limits.delegationSeconds" type="number" min="5" max="600" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                </div>

                <h3 class="hud-title mt-1">Quando ti chiama Arianna</h3>
                <div class="grid grid-cols-2 gap-x-3.5 gap-y-2.5 sm:grid-cols-3">
                  <label class="flex flex-col gap-1 text-xs text-muted">Massimo al giorno<input v-model.number="forms.voice.values.outgoing.maxPerDay" type="number" min="0" max="50" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Silenzio dalle<input v-model="forms.voice.values.outgoing.quietFrom" type="time" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Silenzio fino alle<input v-model="forms.voice.values.outgoing.quietTo" type="time" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Squilla per (s)<input v-model.number="forms.voice.values.outgoing.ringSeconds" type="number" min="5" max="300" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Chiama dopo un’attesa di (min)<input v-model.number="forms.voice.values.outgoing.waitingMinutes" type="number" min="1" max="1440" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                  <label class="flex items-center gap-2 self-end pb-1.5 text-[13px]"><input v-model="forms.voice.values.outgoing.quietWeekend" type="checkbox" />Silenzio nel fine settimana</label>
                </div>

                <h3 class="hud-title mt-1 flex items-center gap-2">
                  Notifiche push
                  <input v-model="forms.voice.push" type="checkbox" role="switch" class="switch" aria-label="Notifiche push accese" />
                </h3>
                <div v-if="forms.voice.push" class="grid grid-cols-1 gap-x-3.5 gap-y-2.5 sm:grid-cols-2">
                  <label class="flex flex-col gap-1 text-xs text-muted">Chiave pubblica VAPID<input v-model="forms.voice.publicKey" class="field px-2 py-1.5 font-mono text-xs text-ink" placeholder="da pnpm voice:vapid" /></label>
                  <label class="flex flex-col gap-1 text-xs text-muted">Contatto (mailto: o https:)<input v-model="forms.voice.subject" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="mailto:tu@example.org" /></label>
                </div>
                <p class="text-xs text-muted">La chiave privata sta nel vault (<code class="font-mono">pnpm vault:edit</code>, chiave <code class="font-mono">vapid-private-key</code>) e non compare qui.</p>
              </template>
              <p v-else class="text-sm text-muted">Le chiamate sono spente: accendile per scegliere voce, limiti e orari.</p>
            </SettingsCard>

            <!-- Characters -->
            <SettingsCard id="characters" title="Personaggi" kind="now" :changed="changed('characters')" :saved="saved === 'characters'" :busy="busy === 'characters'" :error="errors.characters" @cancel="reset('characters')" @save="save('characters')">
              <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div v-for="agent in agentIds" :key="agent" class="flex items-center gap-3 rounded-[10px] border border-line bg-surface-2 p-2.5">
                  <PixelAgent :choice="previewOf(agent)" pose="idle" :scale="1" />
                  <label class="flex min-w-0 flex-1 flex-col gap-1 text-[13px] font-medium">
                    {{ agentName(agent) }}
                    <select v-model="forms.characters[agent]" class="field px-2 py-1 text-xs font-normal">
                      <option :value="undefined">predefinito</option>
                      <option v-for="option in characterOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                      <option v-if="forms.characters[agent] !== undefined && !characterOptions.some((option) => option.value === forms?.characters[agent])" :value="forms.characters[agent]">
                        {{ forms.characters[agent] }} (non disponibile)
                      </option>
                    </select>
                  </label>
                </div>
              </div>
              <p class="text-xs text-muted">Un pacchetto nuovo si copia in <code class="font-mono">data/characters</code>, fuori da git; poi ricarica questa pagina.</p>
            </SettingsCard>

            <p class="flex items-start gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[13px]">
              <Icon name="gateway" :size="16" class="mt-0.5 text-warn" />
              <span>Le sezioni che seguono decidono cosa può uscire da questo computer. Una modifica si applica solo dopo che hai visto e confermato la scheda con le uscite.</span>
            </p>

            <!-- Cloud executors -->
            <SettingsCard id="executors" title="Esecutori cloud" kind="privacy" :changed="changed('executors')" :saved="saved === 'executors'" :busy="busy === 'executors'" :error="errors.executors" @cancel="reset('executors')" @save="prepare('executors')">
              <div class="flex flex-wrap gap-5">
                <label v-for="executor in CLOUD_EXECUTORS" :key="executor" class="flex items-center gap-2">
                  <input v-model="forms.executors" type="checkbox" :value="executor" />{{ EXECUTOR_TEXT[executor] ?? executor }}
                </label>
              </div>
              <p class="text-xs text-muted">Un esecutore acceso può ricevere testi L0-L1 passati dal gateway e lavorare nei progetti qui sotto. Una delega già partita finisce con i valori di prima.</p>
            </SettingsCard>

            <!-- Telegram -->
            <SettingsCard id="telegram" title="Telegram" kind="privacy" :changed="changed('telegram')" :saved="saved === 'telegram'" :busy="busy === 'telegram'" :error="errors.telegram" @cancel="reset('telegram')" @save="prepare('telegram')">
              <template #header>
                <label class="flex items-center gap-2 text-xs text-muted">
                  {{ forms.telegram.enabled ? 'acceso' : 'spento' }}
                  <input v-model="forms.telegram.enabled" type="checkbox" role="switch" class="switch" aria-label="Telegram acceso" />
                </label>
              </template>
              <template v-if="forms.telegram.enabled">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span v-for="(chat, index) in forms.telegram.chats" :key="chat" class="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2 py-1 pr-1.5 pl-2.5 font-mono text-xs">
                    {{ chat }}
                    <button type="button" class="text-muted hover:text-danger" :aria-label="`Togli la chat ${chat}`" @click="forms.telegram.chats.splice(index, 1)"><Icon name="close" :size="13" /></button>
                  </span>
                  <form class="flex items-center gap-1.5" @submit.prevent="addChat">
                    <input v-model="newChat" class="field w-40 px-2 py-1 font-mono text-xs" placeholder="id della chat" aria-label="Id della chat da aggiungere" inputmode="numeric" />
                    <button type="submit" class="btn px-2.5 py-1 text-xs" :disabled="chatId(newChat) === undefined"><Icon name="new" :size="14" />Aggiungi</button>
                  </form>
                </div>
                <p class="text-xs text-muted">Il bot risponde solo a queste chat, al massimo con dati L1 (D-044). Il token del bot sta nel vault e non compare qui.</p>
              </template>
              <p v-else class="text-sm text-muted">Il bot di Telegram è spento.</p>
            </SettingsCard>

            <!-- Projects -->
            <SettingsCard id="projects" title="Progetti" kind="privacy" :changed="changed('projects')" :saved="saved === 'projects'" :busy="busy === 'projects'" :error="errors.projects" @cancel="reset('projects')" @save="prepare('projects')">
              <ul class="flex flex-col gap-2">
                <li v-for="(project, index) in forms.projects" :key="project.name" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2">
                  <Icon name="project" :size="16" class="text-muted" />
                  <span class="font-medium">{{ project.name }}</span>
                  <select v-model="project.label" class="field px-1.5 py-0.5 font-mono text-[11px]" :aria-label="`Etichetta di ${project.name}`">
                    <option value="L0">L0</option>
                    <option value="L1">L1</option>
                  </select>
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="project.path">{{ project.path }}</span>
                  <button type="button" class="btn px-2 py-1 text-xs" @click="forms.projects.splice(index, 1)"><Icon name="delete" :size="14" />Togli</button>
                </li>
              </ul>
              <form class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.6fr_auto_auto]" @submit.prevent="addProject">
                <input v-model="newProject.name" class="field px-2 py-1.5 text-[13px]" placeholder="nome" aria-label="Nome del progetto" />
                <input v-model="newProject.path" class="field px-2 py-1.5 font-mono text-xs" placeholder="~/Progetti/sito o repos/sito" aria-label="Cartella del progetto" />
                <select v-model="newProject.label" class="field px-2 py-1.5 font-mono text-xs" aria-label="Etichetta del progetto">
                  <option value="L0">L0</option>
                  <option value="L1">L1</option>
                </select>
                <button type="submit" class="btn px-2.5 py-1.5 text-xs" :disabled="!projectAddable"><Icon name="new" :size="14" />Aggiungi</button>
              </form>
              <p class="text-xs text-muted">
                Un esecutore cloud vede i file del progetto: l’etichetta dice quanto sono riservati (solo L0 o L1). Un progetto aggiunto da qui non crea il link
                <code class="font-mono">repos/&lt;nome&gt;</code> del wizard: conta la cartella.
              </p>
            </SettingsCard>
          </template>

          <!-- Local servers: state and log even with an invalid file. -->
          <SettingsCard
            id="servers"
            title="Server locali"
            :kind="forms !== null ? 'privacy' : 'read'"
            :changed="changed('endpoints')" :saved="saved === 'endpoints'"
            :busy="busy === 'endpoints'"
            :error="errors.endpoints"
            @cancel="reset('endpoints')"
            @save="prepare('endpoints')"
          >
            <div v-for="server in local" :key="server.id" class="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
              <div class="flex flex-wrap items-center gap-2.5">
                <Icon name="server" :size="16" class="text-muted" />
                <b class="font-mono text-[13px]">{{ server.id }}</b>
                <span class="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.06em] uppercase">
                  <span class="size-2 rounded-full" :class="STATE_CLASS[server.state]" />{{ STATE_TEXT[server.state] ?? server.state }}
                </span>
                <span class="chip">{{ !server.managed ? 'solo osservato' : server.adopted ? 'acceso prima del nucleo' : 'avviato dal nucleo' }}</span>
                <span class="flex-1" />
                <button
                  type="button"
                  class="btn px-2.5 py-1 text-xs"
                  :disabled="restartBlocker(server) !== undefined || restarting === server.id || server.state === 'restarting' || server.state === 'starting'"
                  :title="restartBlocker(server)"
                  @click="restart(server.id)"
                >
                  <Icon name="retry" :size="14" />Riavvia {{ server.id === 'omlx' ? 'oMLX' : server.id }}
                </button>
              </div>
              <p v-if="restartBlocker(server) !== undefined" class="text-xs text-muted">{{ restartBlocker(server) }}</p>
              <p v-if="restartError[server.id]" role="alert" class="text-xs text-danger">{{ restartError[server.id] }}</p>
              <details @toggle="toggleLog(server.id, $event)">
                <summary class="cursor-pointer text-xs text-muted">
                  Ultime righe del log (<code class="font-mono">data/{{ server.id }}.log</code>) · può contenere testi privati: resta in questa pagina
                </summary>
                <div class="mt-2 flex flex-col gap-1.5">
                  <pre :id="`log-${server.id}`" class="max-h-[240px] overflow-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-muted">{{ logs[server.id] ?? 'Leggo…' }}</pre>
                  <button type="button" class="btn self-start px-2.5 py-1 text-xs" @click="readLog(server.id)"><Icon name="retry" :size="14" />Rileggi</button>
                </div>
              </details>
            </div>
            <p v-if="local.length === 0" class="text-sm text-muted">Nessun server locale in uso.</p>

            <template v-if="forms !== null">
              <h3 class="hud-title mt-1">Indirizzo e comando</h3>
              <div v-for="(endpoint, index) in forms.endpoints" :key="index" class="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5">
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
                  <input v-model="endpoint.id" class="field px-2 py-1.5 font-mono text-xs" placeholder="id" aria-label="Id del server" />
                  <input v-model="endpoint.url" class="field px-2 py-1.5 font-mono text-xs" placeholder="http://127.0.0.1:7001/v1" aria-label="Indirizzo del server" />
                  <button type="button" class="btn px-2 py-1 text-xs" @click="forms.endpoints.splice(index, 1)"><Icon name="delete" :size="14" />Togli</button>
                </div>
                <label class="flex flex-col gap-1 text-xs text-muted">
                  Comando, un argomento per riga (vuoto: il nucleo lo osserva soltanto)
                  <textarea v-model="endpoint.command" rows="4" class="field px-2 py-1.5 font-mono text-xs text-ink" spellcheck="false" />
                </label>
              </div>
              <button type="button" class="btn self-start px-2.5 py-1 text-xs" @click="addEndpoint"><Icon name="new" :size="14" />Aggiungi un server</button>
              <p class="text-xs text-muted">
                Un server locale vede i dati L2 in chiaro e il nucleo esegue il suo comando: il comando non deve contenere segreti, perché è mostrato qui. Cambiare indirizzo o comando
                riavvia quel server.
              </p>
            </template>
          </SettingsCard>

          <!-- Label rules: only the file changes them. -->
          <SettingsCard id="labels" title="Regole di etichetta" kind="read">
            <p class="text-xs text-muted">Le regole di etichetta e il gateway si cambiano solo a mano, nel file <code class="font-mono">config/labels.toml</code>.</p>
            <pre v-if="view.labels !== null" class="max-h-[320px] overflow-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap">{{ view.labels }}</pre>
            <p v-else class="text-sm text-danger">Il file delle etichette non si legge: senza regole tutto è L2.</p>
          </SettingsCard>
        </template>
      </div>
    </div>

    <PrivacyConfirm v-if="proposal !== null" :proposal="proposal.value" :busy="busy !== null" :spent="confirmSpent" :error="confirmError" @confirm="confirm" @close="proposal = null" />
  </div>
</template>

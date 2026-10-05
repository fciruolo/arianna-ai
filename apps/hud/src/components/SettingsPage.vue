<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  ApiError,
  confirmPrivacy,
  listCopiedVoices,
  loadChangelog,
  loadCharacters,
  loadLocalLog,
  loadSettings,
  loadVoiceTrial,
  preparePrivacy,
  restartLocal,
  saveSettings,
  sheetUrl,
  type CopiedVoice,
  type TrialModel,
  type UploadedCharacter,
} from '../lib/api.ts';
import { MODE_BADGE, MODE_HINT, type InstallationInfo } from '../lib/installation.ts';
import {
  ADDRESSES,
  characters as countCharacters,
  costText,
  DEFAULT_PERSONA_FORM,
  FIXED_NAMES,
  MAX_DISPLAY_NAME,
  MAX_TEXT,
  PERSONA_NOTICE,
  PERSONA_WHERE,
  personaCost,
  personasBody,
  personasForm,
  personasProblem,
  TONE_EXAMPLE,
  TONE_TEXT,
  TONES,
  type PersonaForm,
} from '../lib/persona.ts';
import { pendingBadge, pendingText } from '../lib/dev-progress.ts';
import { agentName } from '../lib/italian.ts';
import { EXECUTOR_TEXT, MODEL_TEXT } from '../lib/labels.ts';
import { CHANGELOG_PATH, SETTINGS_PATH, settingsPathFor } from '../lib/route.ts';
import { BEHAVIOUR_TEXT, hrefOf, pendingTitles, PRIVACY_HINT, resolveSection, sectionDirty, SETTINGS_INDEX, type IndexItem } from '../lib/settings-index.ts';
import {
  agentsBody,
  agentsForm,
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
  modelBlocker,
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
  type AgentsForm,
  type CloudModelAlias,
  type CatalogModel,
  type CloudModelsForm,
  type EndpointForm,
  type LocalServerStatus,
  type ModelRole,
  type OrdinarySection,
  type PrivacyProposal,
  type PrivacySection,
  type ProjectValues,
  type Section,
  type SettingsBody,
  type SettingsValues,
  type SettingsView,
  type TelegramForm,
  type VoiceForm,
  type VoiceValues,
} from '../lib/settings.ts';
import type { CharacterChoice, CharacterListing } from '../lib/types.ts';
import { listUserAgents, loadUserAgentPrompt } from '../lib/user-agents.ts';
import CharacterGenerate from './CharacterGenerate.vue';
import CharacterUpload from './CharacterUpload.vue';
import Icon from './Icon.vue';
import ModelEvals from './ModelEvals.vue';
import PixelAgent from './PixelAgent.vue';
import PrivacyConfirm from './PrivacyConfirm.vue';
import SettingsCard from './SettingsCard.vue';
import SheetPreview from './SheetPreview.vue';
import UserAgents from './UserAgents.vue';

/**
 * The settings page of the web chat (D-071), over /api/settings. Each card
 * edits one section of arianna.toml: the ordinary ones are saved at once,
 * the privacy ones are prepared, shown in a confirmation card and written
 * only on Conferma. Every write carries the fingerprint of the file the page
 * read: a 409 means someone else wrote it, and the page reloads the values.
 */
/**
 * `installation`: what this installation is (D-098), shown as a read-only row; undefined while unknown.
 * `section`: the slug of the address (D-105), `/impostazioni/<slug>`; the page shows that section only.
 */
/** `devPending`: open questions of "Sviluppo di Arianna" without an answer, a dot on its entry (D-120). */
const props = defineProps<{ installation?: InstallationInfo | undefined; section?: string | undefined; devPending?: number }>();
const devDot = computed(() => pendingBadge(props.devPending ?? 0));
const devLabel = computed(() => pendingText(props.devPending ?? 0));
/** `section`: the user chose another section (undefined: back to the index on a narrow screen). */
/** `dirty`: some section holds edits not saved, for the back button of the browser (App.vue). */
/** `newAgent`: the page "Nuovo agente" (D-119, tappa T3). */
const emit = defineEmits<{ changed: [sections: string[]]; voiceTrial: []; devProgress: []; changelog: []; newAgent: []; section: [slug: string | undefined]; dirty: [dirty: boolean] }>();

interface Forms {
  roles: Partial<Record<ModelRole, string>>;
  cloudModels: CloudModelsForm;
  characters: Record<string, string>;
  personas: Record<string, PersonaForm>;
  agents: AgentsForm;
  sprites: SettingsValues['sprites'];
  voice: VoiceForm;
  executors: string[];
  telegram: TelegramForm;
  projects: ProjectValues[];
  endpoints: EndpointForm[];
}

function formsOf(values: SettingsValues, defaults: VoiceValues, agentModels: SettingsView['agentModels']): Forms {
  return {
    roles: { ...values.roles },
    cloudModels: cloudModelsForm(values.cloudModels),
    characters: { ...values.characters },
    personas: personasForm(values.personas),
    agents: agentsForm(values.agents, agentModels),
    sprites: values.sprites,
    voice: voiceForm(values.voice, defaults),
    executors: [...values.executors],
    telegram: telegramForm(values.telegram),
    projects: values.projects.map((project) => ({ ...project })),
    endpoints: endpointsForm(values.endpoints),
  };
}

const SECTIONS: Section[] = ['roles', 'sprites', 'cloudModels', 'characters', 'personas', 'agents', 'voice', 'executors', 'telegram', 'projects', 'endpoints'];

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

const base = computed(() => (view.value?.values === null || view.value === null ? null : formsOf(view.value.values, view.value.voiceDefaults, view.value.agentModels)));

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
  const fresh = formsOf(next.values, next.voiceDefaults, next.agentModels);
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

function others(parts: readonly Section[]): Section[] {
  return SECTIONS.filter((item) => !parts.includes(item));
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

/** The parts the Agenti card saves together, in one write (D-116); it is known by `agents`. */
const AGENT_PARTS: readonly OrdinarySection[] = ['characters', 'personas', 'agents'];

/** Saves `parts` (by default the section alone) in one write; the card is known by `section`. */
async function save(section: OrdinarySection, parts: readonly OrdinarySection[] = [section]): Promise<void> {
  const current = forms.value;
  const fingerprint = view.value?.fingerprint;
  if (current === null || fingerprint === null || fingerprint === undefined) return;
  const values: SettingsBody = {};
  if (parts.includes('roles')) values.roles = rolesBody(current.roles);
  if (parts.includes('cloudModels')) values.cloudModels = cloudModelsBody(current.cloudModels);
  if (parts.includes('characters')) values.characters = charactersBody(current.characters);
  if (parts.includes('voice')) values.voice = voiceBody(current.voice);
  if (parts.includes('personas')) values.personas = personasBody(current.personas);
  if (parts.includes('agents')) values.agents = agentsBody(current.agents);
  if (parts.includes('sprites')) values.sprites = current.sprites;
  generation += 1;
  busy.value = section;
  delete errors.value[section];
  notice.value = null;
  try {
    apply(await saveSettings(fingerprint, values), others(parts));
    markSaved(section);
    emit('changed', [...parts]);
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
    apply(await confirmPrivacy(open.value.id), others([open.section]));
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
/** "Novità": the current version, in small at the bottom of the index; null until read or when there is none. */
const currentVersion = ref<string | null>(null);

/** Agent → its description and whether it is the user's (its prompt can be read): what "Genera personaggio" sends (D-123). */
const agentTexts = ref<Record<string, { description: string; user: boolean }>>({});

onMounted(() => {
  void reload();
  void listUserAgents()
    .then((listing) => {
      agentTexts.value = Object.fromEntries([
        ...listing.official.map((agent) => [agent.name, { description: agent.description, user: false }] as const),
        ...listing.user.map((agent) => [agent.name, { description: agent.description, user: true }] as const),
      ]);
    })
    .catch(() => undefined);
  void loadChangelog()
    .then((changelog) => {
      currentVersion.value = changelog.current;
    })
    .catch(() => undefined);
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
  const ids = new Set([...Object.keys(characters.value?.agents ?? {}), ...Object.keys(view.value?.values?.characters ?? {}), ...Object.keys(view.value?.agentModels ?? {})]);
  return [...ids].sort((a, b) => (a === 'arianna' ? -1 : b === 'arianna' ? 1 : a.localeCompare(b)));
});
const characterOptions = computed(() =>
  (characters.value?.packs ?? []).flatMap((pack) => pack.characters.map((character) => ({ value: `${pack.id}/${character.id}`, label: `${pack.name} · ${character.name}`, pack, character }))),
);
/** Bumped by an upload: the sheets are asked again, a replaced one included (D-118). */
const sheetVersion = ref(0);
/** The agents whose animations are open. */
const animationsOpen = ref(new Set<string>());
function toggleAnimations(agent: string): void {
  const next = new Set(animationsOpen.value);
  if (!next.delete(agent)) next.add(agent);
  animationsOpen.value = next;
}
/** An agent activated, deactivated or promoted (D-119): its card, character and model show up at once. */
async function onAgentsChanged(): Promise<void> {
  emit('changed', ['userAgents', 'characters']);
  await reload();
  try {
    characters.value = await loadCharacters();
  } catch {
    // The next reload lists it.
  }
}
/** A sheet saved in the pack miei (D-118): listed again and chosen for the agent; the card's Salva keeps it. */
async function onUploaded(agent: string, saved: UploadedCharacter): Promise<void> {
  sheetVersion.value += 1;
  try {
    characters.value = await loadCharacters();
  } catch {
    // The choice below still names it; a reload lists it.
  }
  if (forms.value !== null) forms.value.characters[agent] = `${saved.pack}/${saved.character}`;
}
function resetCharacter(agent: string): void {
  if (forms.value !== null) delete forms.value.characters[agent];
}
/** The character without a choice, as the core picks it: the original of the same name, otherwise the Coder's. */
function defaultOption(agent: string) {
  const originals = characterOptions.value.filter((option) => option.pack.original);
  return originals.find((option) => option.character.id === agent) ?? originals.find((option) => option.character.id === 'coder');
}
function previewOf(agent: string): CharacterChoice | undefined {
  const value = forms.value?.characters[agent] ?? '';
  const option = value === '' ? defaultOption(agent) : characterOptions.value.find((item) => item.value === value);
  if (option !== undefined) return { pack: option.pack.id, character: option.character.id, rows: option.character.rows };
  return value === '' ? characters.value?.agents[agent] : undefined;
}

// Personas (D-107): one form per agent; an agent without a persona gets the
// defaults here, which are no change (compared as sent).
watch(
  // `forms` is replaced by a new view, its `personas` by a reset of the card.
  [agentIds, forms, () => forms.value?.personas],
  () => {
    const personas = forms.value?.personas;
    if (personas === undefined) return;
    for (const agent of agentIds.value) if (!Object.hasOwn(personas, agent)) personas[agent] = { ...DEFAULT_PERSONA_FORM };
  },
  { immediate: true },
);
// Also an agent the file names but the characters do not: its card stays reachable.
const personaAgents = computed(() => {
  const named = Object.keys(forms.value?.personas ?? {}).filter((agent) => !agentIds.value.includes(agent));
  return [...agentIds.value, ...named.sort()].filter((agent) => forms.value?.personas[agent] !== undefined);
});
const personasInvalid = computed(() => (forms.value === null ? undefined : personasProblem(forms.value.personas, agentName)));

// The Agenti card (D-116): look, persona and model of each agent, saved together.
const agentsChanged = computed(() => AGENT_PARTS.some(changed));
function resetAgents(): void {
  for (const part of AGENT_PARTS) reset(part);
  delete errors.value.agents;
}
/** The cloud models the card of an agent allows; none: local only. */
function modelsOf(agent: string): CloudModelAlias[] {
  return view.value?.agentModels[agent] ?? [];
}
/** Why a model would not start a conversation now, from the saved settings. */
function blockerOf(model: CloudModelAlias): string | undefined {
  const values = view.value?.values;
  return values === null || values === undefined ? undefined : modelBlocker(model, values);
}
function openSection(slug: string): void {
  emit('section', slug);
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

/**
 * One section at a time (D-105): the index on the left, the chosen section on
 * the right, chosen by the address. Edits of a section left behind stay in the
 * page (the forms are one object) and are listed until saved or cancelled.
 */
const chosen = computed(() => resolveSection(props.section));
const active = computed(() => chosen.value.item.id);
const pending = computed(() => pendingTitles(active.value, (section) => changed(section as Section)));
function dirty(item: IndexItem): boolean {
  return sectionDirty(item.id, (section) => changed(section as Section));
}
/** Every section holding edits not saved. */
const unsaved = computed(() => pendingTitles('', (section) => changed(section as Section)));
watch(unsaved, (titles) => emit('dirty', titles.length > 0), { immediate: true });
/** Leaving the settings loses the edits not saved: ask first. */
function leave(to: 'voiceTrial' | 'devProgress' | 'changelog'): void {
  const left = unsaved.value;
  if (left.length > 0 && !window.confirm(`Ci sono modifiche non salvate in: ${left.join(', ')}. Uscendo dalle Impostazioni si perdono. Vuoi uscire?`)) return;
  if (to === 'devProgress') emit('devProgress');
  else if (to === 'changelog') emit('changelog');
  else emit('voiceTrial');
}
/** A section opened from the index shown alone (narrow screen): "‹ Impostazioni" goes back in the history. */
let fromIndex = false;
function open(item: IndexItem): void {
  if (item.page !== undefined) {
    leave(item.id === 'dev-progress' ? 'devProgress' : item.id === 'changelog' ? 'changelog' : 'voiceTrial');
    return;
  }
  fromIndex = !chosen.value.explicit;
  emit('section', item.slug);
}
function backToIndex(): void {
  if (fromIndex) {
    fromIndex = false;
    window.history.back();
    return;
  }
  emit('section', undefined);
}
// An unknown section in the address: the first one is shown, and the address says so.
watch(
  () => props.section,
  (slug) => {
    if (slug !== undefined && !chosen.value.explicit) window.history.replaceState(window.history.state, '', SETTINGS_PATH);
    // An old address (Personaggi, Personalità) shows its new section under the new address.
    else if (slug !== undefined && slug !== chosen.value.item.slug) window.history.replaceState(window.history.state, '', settingsPathFor(chosen.value.item.slug));
  },
  { immediate: true },
);
/** Closing or reloading the tab with edits not saved: the browser asks. */
function beforeUnload(event: BeforeUnloadEvent): void {
  if (unsaved.value.length === 0) return;
  event.preventDefault();
  event.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  emit('dirty', false);
});
const pane = ref<HTMLElement | null>(null);
watch(active, () => {
  if (pane.value !== null) pane.value.scrollTop = 0;
});
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <!-- The index (D-105): always on wide screens; on narrow ones it is the page until a section is chosen. -->
    <nav
      :inert="proposal !== null"
      class="min-h-0 shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-5 lg:flex lg:w-[230px] lg:border-r lg:border-line"
      :class="chosen.explicit ? 'hidden' : 'flex w-full'"
      aria-label="Indice delle impostazioni"
    >
      <h1 class="mx-2.5 mb-2 font-hud text-xl font-semibold tracking-[0.05em] lg:hidden">Impostazioni</h1>
      <template v-for="group in SETTINGS_INDEX" :key="group.group">
        <h2 class="hud-title mx-2.5 mt-3.5 mb-1.5 first:mt-0">{{ group.group }}</h2>
        <a
          v-for="item in group.items"
          :key="item.id"
          :href="hrefOf(item)"
          class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-surface-2 hover:text-ink lg:py-1.5"
          :class="active === item.id ? 'text-muted lg:bg-surface-2 lg:font-medium lg:text-ink' : 'text-muted'"
          :aria-current="active === item.id ? 'page' : undefined"
          @click.prevent="open(item)"
        >
          <span class="min-w-0 flex-1">{{ item.title }}</span>
          <span
            v-if="item.id === 'dev-progress' && devDot !== null"
            role="img"
            class="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 font-mono text-[10.5px] leading-5 font-semibold text-accent-ink"
            :title="devLabel ?? undefined"
            :aria-label="devLabel ?? undefined"
          >{{ devDot }}</span>
          <span v-if="dirty(item)" role="img" class="size-[7px] rounded-full bg-warn" title="Modifiche non salvate" aria-label="modifiche non salvate" />
          <span v-if="item.privacy" role="img" class="inline-flex text-warn" :title="PRIVACY_HINT" :aria-label="PRIVACY_HINT"><Icon name="gateway" :size="14" /></span>
          <span v-if="item.page !== undefined" class="inline-flex -rotate-90 opacity-60" aria-hidden="true"><Icon name="expand" :size="13" /></span>
        </a>
      </template>
      <!-- "Novità": the current version, in small at the bottom of the index. -->
      <p class="mx-2.5 mt-auto pt-6 font-mono text-[11px] text-muted">
        <span v-if="currentVersion !== null">Arianna {{ currentVersion }} · </span>
        <a :href="CHANGELOG_PATH" class="hover:text-ink hover:underline" @click.prevent="leave('changelog')">Novità</a>
      </p>
    </nav>

    <div ref="pane" :inert="proposal !== null" class="min-h-0 min-w-0 flex-1 overflow-y-auto lg:block" :class="chosen.explicit ? 'block' : 'hidden'">
      <div class="mx-auto flex max-w-[860px] flex-col gap-5 px-4 pt-5 pb-24 md:px-6">
        <header>
          <button type="button" class="mb-2 text-sm text-muted hover:text-ink lg:hidden" @click="backToIndex">‹ Impostazioni</button>
          <h1 class="font-hud text-xl font-semibold tracking-[0.05em]">{{ chosen.item.title }}</h1>
          <p class="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <span v-if="chosen.item.privacy" class="inline-flex text-warn"><Icon name="gateway" :size="13" /></span>{{ BEHAVIOUR_TEXT[chosen.item.behaviour] }}
          </p>
        </header>

        <p v-if="pending.length > 0" role="status" class="flex items-start gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[13px]">
          <Icon name="warning" :size="16" class="mt-0.5 text-warn" />
          <span>Modifiche non salvate in: {{ pending.join(', ') }}. Restano lì finché non le salvi o le annulli; uscendo dalle Impostazioni si perdono.</span>
        </p>

        <p v-if="loadError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
          Non riesco a leggere le impostazioni: {{ loadError }}
        </p>
        <p v-if="view === null && loadError === null" class="text-muted">Leggo le impostazioni…</p>

        <template v-if="view !== null">
          <p v-if="chosen.item.behaviour === 'now' || chosen.item.behaviour === 'confirm'" class="flex items-start gap-2.5 rounded-[10px] border border-info/45 bg-info/9 px-3.5 py-2.5 text-[13px]">
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
            <SettingsCard
              v-if="active === 'roles'"
              id="roles"
              title="Modelli locali per ruolo"
              kind="now"
              :changed="changed('roles') || changed('sprites')"
              :saved="saved === 'roles'"
              :busy="busy === 'roles'"
              :error="errors.roles"
              @cancel="reset('roles'); reset('sprites')"
              @save="save('roles', ['roles', 'sprites'])"
            >
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
              <!-- D-123: the model that draws a character; Claude Sonnet unless the user chooses -->
              <div class="grid grid-cols-1 items-center gap-1.5 border-t border-line pt-2.5 sm:grid-cols-[140px_minmax(0,1fr)] md:gap-3">
                <label for="role-sprites" class="font-medium">Personaggi<small class="block text-[11.5px] font-normal text-muted">disegna l’aspetto degli agenti</small></label>
                <select id="role-sprites" v-model="forms.sprites" class="field min-w-0 px-2 py-1.5 text-[13px]">
                  <option value="sonnet">Claude Sonnet (predefinito)</option>
                  <option value="opus">Claude Opus</option>
                  <option value="local">modello locale (quello dell’orchestratore)</option>
                </select>
              </div>
              <p class="text-xs text-muted">
                Con Claude, «Genera personaggio» manda verso il cloud, passando dal gateway, nome, descrizione e prompt dell’agente, tono e specializzazione e il tuo suggerimento (L1), e usa
                la tua quota; serve Claude attivo fra gli esecutori cloud. Con il modello locale non esce nulla.
              </p>
              <p class="text-xs text-muted">
                Un modello senza file in <code class="font-mono">data/models</code> si può scegliere, ma va scaricato con
                <code class="font-mono">pnpm arianna:models pull</code>. Cambiare modello non riavvia oMLX: lo carica per nome alla prossima richiesta.
              </p>
            </SettingsCard>

            <!-- Trials of the catalog models (D-081) -->
            <ModelEvals v-if="active === 'model-evals'" :catalog="catalog" :current="view.values?.roles.orchestrator" />

            <!-- Cloud models -->
            <SettingsCard v-if="active === 'cloud-models'" id="cloud-models" title="Modelli cloud" kind="now" :changed="changed('cloudModels')" :saved="saved === 'cloudModels'" :busy="busy === 'cloudModels'" :error="errors.cloudModels" @cancel="reset('cloudModels')" @save="save('cloudModels')">
              <div class="overflow-x-auto">
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr class="hud-title text-left">
                      <th class="pr-2 pb-2 font-semibold">Acceso</th>
                      <th class="px-2 pb-2 font-semibold">Modello</th>
                      <th class="pb-2 pl-2 font-semibold">Nome esatto (facoltativo)</th>
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
                        />
                      </td>
                      <td class="px-2 py-2 whitespace-nowrap">{{ MODEL_TEXT[row.alias] ?? row.alias }}</td>
                      <td class="py-2 pl-2">
                        <input v-model="row.name" class="field w-full min-w-[150px] px-2 py-1 font-mono text-xs" :disabled="!row.enabled" placeholder="il più recente" :aria-label="`Nome esatto di ${row.alias}`" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="text-xs text-muted">
                Un modello spento esce dal router e dal selettore delle conversazioni. Il nome esatto resta nella famiglia del modello (es.
                <code class="font-mono">opus[1m]</code>, <code class="font-mono">claude-opus-5-5</code>); vuoto è il più recente. Per Codex la scelta si salva e vale con il suo adattatore.
                Il modello con cui parte ogni agente si sceglie in <a href="/impostazioni/agenti" class="text-accent hover:underline" @click.prevent="openSection('agenti')">Agenti</a>.
              </p>
            </SettingsCard>

            <!-- Voice -->
            <SettingsCard v-if="active === 'voice'" id="voice" title="Voce e chiamate" kind="now" :changed="changed('voice')" :saved="saved === 'voice'" :invalid="voiceProblem(forms.voice)" :busy="busy === 'voice'" :error="errors.voice" @cancel="reset('voice')" @save="save('voice')">
              <template #header>
                <label class="flex items-center gap-2 text-xs text-muted">
                  {{ forms.voice.enabled ? 'accese' : 'spente' }}
                  <input v-model="forms.voice.enabled" type="checkbox" role="switch" class="switch" aria-label="Chiamate accese" />
                </label>
              </template>
              <p class="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span class="min-w-0 flex-1">Scegli a orecchio chi ascolta e chi parla nelle chiamate.</span>
                <button type="button" class="btn px-2.5 py-1 text-xs" @click="leave('voiceTrial')"><Icon name="mic" :size="14" />Provino della voce</button>
              </p>
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

            <!-- Agents (D-116): look, persona and model of each agent, saved together -->
            <SettingsCard v-if="active === 'agents'" id="agents" title="Agenti" kind="now" :changed="agentsChanged" :saved="saved === 'agents'" :invalid="personasInvalid" :busy="busy === 'agents'" :error="errors.agents" @cancel="resetAgents" @save="save('agents', AGENT_PARTS)">
              <p class="text-xs text-muted">
                Aspetto, modello e stile di ogni agente. Strumenti, permessi, etichette e limiti non cambiano: restano nelle schede <code class="font-mono">agents/*.yaml</code>.
              </p>
              <div v-for="agent in personaAgents" :key="agent" class="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface-2 p-3">
                <div class="flex items-center gap-3">
                  <PixelAgent :choice="previewOf(agent)" pose="idle" :scale="1" :version="sheetVersion" />
                  <h3 class="hud-title">{{ agentName(agent) }}</h3>
                  <div v-if="previewOf(agent)" class="ml-auto flex flex-wrap gap-2">
                    <!-- The character comes from Genera personaggio or Carica PNG; a chosen one can go back to the default. -->
                    <button v-if="forms.characters[agent] !== undefined" type="button" class="btn px-2.5 py-1 text-xs" @click="resetCharacter(agent)">Torna al predefinito</button>
                    <button type="button" class="btn px-2.5 py-1 text-xs" :aria-expanded="animationsOpen.has(agent)" @click="toggleAnimations(agent)">
                      {{ animationsOpen.has(agent) ? 'Chiudi animazioni' : 'Animazioni' }}
                    </button>
                    <a class="btn px-2.5 py-1 text-xs" :href="sheetUrl(previewOf(agent)!, sheetVersion)" :download="`${previewOf(agent)!.character}.png`">Scarica PNG</a>
                  </div>
                </div>
                <SheetPreview v-if="animationsOpen.has(agent) && previewOf(agent)" :src="sheetUrl(previewOf(agent)!, sheetVersion)" :rows="previewOf(agent)!.rows" />
                <CharacterGenerate
                  v-if="agentTexts[agent]"
                  :agent-label="agentName(agent)"
                  :name="agent"
                  :description="agentTexts[agent].description"
                  prompt=""
                  :fetch-prompt="agentTexts[agent].user ? () => loadUserAgentPrompt(agent) : undefined"
                  @uploaded="(saved) => onUploaded(agent, saved)"
                />
                <CharacterUpload :agent-label="agentName(agent)" @uploaded="(saved) => onUploaded(agent, saved)" />
                <div class="grid grid-cols-1 gap-x-3.5 gap-y-2.5 sm:grid-cols-2">
                  <!-- Arianna: the orchestrator of Modelli locali, one place to set it, local only. -->
                  <div v-if="agent === 'arianna'" class="flex flex-col gap-1 text-xs text-muted">
                    Modello
                    <p class="flex flex-wrap items-center gap-2 py-1.5 text-[13px] text-ink">
                      <span class="font-mono text-xs">{{ view.values?.roles.orchestrator ?? 'nessuno' }}</span><span class="chip">locale</span>
                      <a href="/impostazioni/modelli-locali" class="text-xs text-accent hover:underline" @click.prevent="openSection('modelli-locali')">Si cambia in Modelli locali</a>
                    </p>
                  </div>
                  <label v-else-if="forms.agents[agent] !== undefined && modelsOf(agent).length > 0" class="flex flex-col gap-1 text-xs text-muted">
                    Modello delle conversazioni nuove
                    <select v-model="forms.agents[agent]" class="field px-2 py-1.5 text-[13px] text-ink">
                      <option value="">automatico (sceglie il router)</option>
                      <option v-for="model in modelsOf(agent)" :key="model" :value="model">{{ MODEL_TEXT[model] ?? model }}{{ blockerOf(model) === undefined ? '' : ` (${blockerOf(model)})` }}</option>
                      <!-- A model of the file the card no longer allows stays visible: it is kept, and ignored. -->
                      <option v-if="forms.agents[agent] !== '' && !modelsOf(agent).includes(forms.agents[agent] as CloudModelAlias)" :value="forms.agents[agent]">
                        {{ MODEL_TEXT[forms.agents[agent] ?? ''] ?? forms.agents[agent] }} (non consentito dalla scheda)
                      </option>
                    </select>
                  </label>
                  <div v-else class="flex flex-col gap-1 text-xs text-muted">
                    Modello
                    <p class="py-1.5 text-[13px] text-ink">solo modelli locali: sceglie il router</p>
                  </div>
                </div>
                <template v-if="forms.personas[agent]">
                  <fieldset class="flex flex-col gap-1 text-xs text-muted">
                    <legend class="mb-1">Tono</legend>
                    <div class="flex flex-wrap gap-1.5">
                      <label
                        v-for="tone in TONES"
                        :key="tone"
                        class="cursor-pointer rounded-[9px] border px-2.5 py-1 text-[13px] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
                        :class="forms.personas[agent].tone === tone ? 'border-accent bg-accent/15 text-ink' : 'border-line-strong text-muted hover:text-ink'"
                      >
                        <input v-model="forms.personas[agent].tone" type="radio" :name="`tone-${agent}`" :value="tone" class="sr-only" />{{ TONE_TEXT[tone] }}
                      </label>
                    </div>
                  </fieldset>
                  <div class="grid grid-cols-1 gap-x-3.5 gap-y-2.5 sm:grid-cols-2">
                    <label class="flex flex-col gap-1 text-xs text-muted">
                      Ti dà del
                      <select v-model="forms.personas[agent].address" class="field px-2 py-1.5 text-[13px] text-ink">
                        <option v-for="address in ADDRESSES" :key="address" :value="address">{{ address }}</option>
                      </select>
                    </label>
                    <label class="flex flex-col gap-1 text-xs text-muted">
                      Nome visualizzato
                      <input
                        v-model="forms.personas[agent].displayName"
                        :maxlength="MAX_DISPLAY_NAME"
                        :disabled="FIXED_NAMES.includes(agent)"
                        :placeholder="FIXED_NAMES.includes(agent) ? 'non si cambia' : agentName(agent)"
                        class="field px-2 py-1.5 text-[13px] text-ink disabled:opacity-60"
                      />
                    </label>
                  </div>
                  <p class="text-xs text-muted">Esempio: <span class="italic text-ink">«{{ TONE_EXAMPLE[forms.personas[agent].tone] }}»</span></p>
                  <label class="flex flex-col gap-1 text-xs text-muted">
                    <span class="flex justify-between gap-2"
                      >Specializzazione: ruolo e competenze<span class="font-mono" :class="countCharacters(forms.personas[agent].specialization) > MAX_TEXT ? 'text-danger' : ''"
                        >{{ countCharacters(forms.personas[agent].specialization) }}/{{ MAX_TEXT }}</span
                      ></span
                    >
                    <textarea v-model="forms.personas[agent].specialization" rows="3" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="Es. sviluppatore senior TypeScript, attento ai test e alla leggibilità." />
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted">
                    <span class="flex justify-between gap-2"
                      >Personalità: come parla<span class="font-mono" :class="countCharacters(forms.personas[agent].traits) > MAX_TEXT ? 'text-danger' : ''"
                        >{{ countCharacters(forms.personas[agent].traits) }}/{{ MAX_TEXT }}</span
                      ></span
                    >
                    <textarea v-model="forms.personas[agent].traits" rows="3" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="Es. precisa e calma, con un debole per le metafore di cucina." />
                  </label>
                  <p class="flex items-start gap-2 text-xs text-warn"><Icon name="gateway" :size="14" class="mt-px" />{{ PERSONA_NOTICE }}</p>
                  <p class="text-xs text-muted">{{ costText(personaCost(forms.personas[agent])) }}</p>
                </template>
              </div>
              <p class="text-xs text-muted">
                Il modello vale per le conversazioni nuove (per ora quelle di lavoro, con il Coder; gli altri agenti quando si potranno scegliere in «+ Nuovo»): il selettore della chat
                lo cambia per una conversazione, e il router lo usa finché nessuna regola lo esclude. Un
                modello spento o con l’esecutore spento si può scegliere, ma vale solo quando è acceso; non accende mai un esecutore. Per Arianna solo modelli locali.
              </p>
              <p class="text-xs text-muted">
                {{ PERSONA_WHERE }} La specializzazione si aggiunge al ruolo scritto nella scheda dell’agente, non lo sostituisce. Al salvataggio un testo con IBAN, codici fiscali,
                carte, chiavi o valori del vault viene rifiutato. Un foglio caricato con «Carica PNG» va nel pacchetto
                <code class="font-mono">data/characters/miei</code>, fuori da git; un pacchetto intero si copia a mano in <code class="font-mono">data/characters</code>, poi si ricarica questa pagina.
              </p>
            </SettingsCard>
            <UserAgents v-if="active === 'agents'" @changed="onAgentsChanged" @new-agent="emit('newAgent')" />

            <p v-if="chosen.item.behaviour === 'confirm'" class="flex items-start gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[13px]">
              <Icon name="gateway" :size="16" class="mt-0.5 text-warn" />
              <span>Questa sezione decide cosa può uscire da questo computer. Una modifica si applica solo dopo che hai visto e confermato la scheda con le uscite.</span>
            </p>

            <!-- Cloud executors -->
            <SettingsCard v-if="active === 'executors'" id="executors" title="Esecutori cloud" kind="privacy" :changed="changed('executors')" :saved="saved === 'executors'" :busy="busy === 'executors'" :error="errors.executors" @cancel="reset('executors')" @save="prepare('executors')">
              <div class="flex flex-wrap gap-5">
                <label v-for="executor in CLOUD_EXECUTORS" :key="executor" class="flex items-center gap-2">
                  <input v-model="forms.executors" type="checkbox" :value="executor" />{{ EXECUTOR_TEXT[executor] ?? executor }}
                </label>
              </div>
              <p class="text-xs text-muted">Un esecutore acceso può ricevere testi L0-L1 passati dal gateway e lavorare nei progetti qui sotto. Una delega già partita finisce con i valori di prima.</p>
            </SettingsCard>

            <!-- Telegram: off by the user's choice (D-110, question 12), not in the settings index, so unreachable; kept to turn back on -->
            <SettingsCard v-if="active === 'telegram'" id="telegram" title="Telegram" kind="privacy" :changed="changed('telegram')" :saved="saved === 'telegram'" :busy="busy === 'telegram'" :error="errors.telegram" @cancel="reset('telegram')" @save="prepare('telegram')">
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
            <SettingsCard v-if="active === 'projects'" id="projects" title="Progetti" kind="privacy" :changed="changed('projects')" :saved="saved === 'projects'" :busy="busy === 'projects'" :error="errors.projects" @cancel="reset('projects')" @save="prepare('projects')">
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
            v-if="active === 'servers'"
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
          <SettingsCard v-if="active === 'labels'" id="labels" title="Regole di etichetta" kind="read">
            <p class="text-xs text-muted">Le regole di etichetta e il gateway si cambiano solo a mano, nel file <code class="font-mono">config/labels.toml</code>.</p>
            <pre v-if="view.labels !== null" class="max-h-[320px] overflow-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap">{{ view.labels }}</pre>
            <p v-else class="text-sm text-danger">Il file delle etichette non si legge: senza regole tutto è L2.</p>
          </SettingsCard>
        </template>

        <!-- What this installation is (D-098): read from the core, even when the settings do not load. -->
        <SettingsCard v-if="active === 'installation'" id="installation" title="Installazione" kind="read">
          <template v-if="installation !== undefined">
            <div class="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
              <span class="text-muted">Tipo</span>
              <span class="flex flex-wrap items-center gap-2">
                <span
                  class="rounded-[5px] border px-1.5 py-1 font-mono text-[10px] leading-none font-semibold tracking-[0.1em]"
                  :class="installation.mode === 'development' ? 'border-warn/70 bg-warn/10 text-warn' : 'border-ok/60 text-ok'"
                >{{ MODE_BADGE[installation.mode] }}</span>
                <span class="text-xs text-muted">{{ MODE_HINT[installation.mode] }}</span>
              </span>
              <span class="text-muted">Cartella</span>
              <span class="font-mono text-xs">{{ installation.home }}</span>
              <span class="text-muted">Versione</span>
              <span class="font-mono text-xs">{{ installation.version ?? 'non letta' }}</span>
            </div>
            <p class="text-xs text-muted">
              È di sviluppo con le password di sviluppo o con <code class="font-mono">[installation] mode = "development"</code> in
              <code class="font-mono">arianna.toml</code>; altrimenti è di produzione.
            </p>
          </template>
          <p v-else class="text-sm text-muted">Il nucleo non dice che installazione è.</p>
        </SettingsCard>
      </div>
    </div>

    <PrivacyConfirm v-if="proposal !== null" :proposal="proposal.value" :busy="busy !== null" :spent="confirmSpent" :error="confirmError" @confirm="confirm" @close="proposal = null" />
  </div>
</template>

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
  type CopiedVoice,
  type TrialModel,
  type UploadedCharacter,
} from '../lib/api.ts';
import { MODE_BADGE, MODE_HINT, type InstallationInfo } from '../lib/installation.ts';
import { personasBody, personasForm, personasProblem, type PersonaForm } from '../lib/persona.ts';
import { pendingBadge, pendingText } from '../lib/dev-progress.ts';
import { agentName } from '../lib/italian.ts';
import { EXECUTOR_TEXT } from '../lib/labels.ts';
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
  notificationsBody,
  notificationsForm,
  notificationsProblem,
  rolesBody,
  DEFAULT_SECRETARY,
  secretaryBody,
  secretaryProblem,
  WEEKDAY_TEXT,
  WEEKDAYS,
  keptSections,
  leaveAfterProblem,
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
  type CloudModelsForm,
  type EndpointForm,
  type LocalServerStatus,
  type ModelRole,
  type NotificationsForm,
  type OrdinarySection,
  type PrivacyProposal,
  type PrivacySection,
  type ProjectValues,
  type SecretaryValues,
  type Section,
  type SettingsBody,
  type SettingsValues,
  type SettingsView,
  type TelegramForm,
  type VoiceForm,
  type VoiceValues,
} from '../lib/settings.ts';
import type { CharacterListing, DirectAgent } from '../lib/types.ts';
import AgentsSettings from './AgentsSettings.vue';
import Icon from './Icon.vue';
import ModelsSettings from './ModelsSettings.vue';
import NotificationDevice from './NotificationDevice.vue';
import PrivacyConfirm from './PrivacyConfirm.vue';
import SettingsCard from './SettingsCard.vue';

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
/** `directAgents`: the agents one can talk with directly (D-111d), for "Apri una chat" in Agenti (D-133). */
const props = defineProps<{ installation?: InstallationInfo | undefined; section?: string | undefined; devPending?: number; directAgents?: DirectAgent[] }>();
const devDot = computed(() => pendingBadge(props.devPending ?? 0));
const devLabel = computed(() => pendingText(props.devPending ?? 0));
/** `section`: the user chose another section (undefined: back to the index on a narrow screen). */
/** `dirty`: some section holds edits not saved, for the back button of the browser (App.vue). */
/** `newAgent`: the page "Nuovo agente" (D-119, tappa T3). `chat`: "+ Nuovo" opened on an agent (D-133). */
const emit = defineEmits<{
  changed: [sections: string[]];
  voiceTrial: [];
  devProgress: [];
  changelog: [];
  newAgent: [];
  chat: [agent: string];
  chatTrial: [modelId: string];
  section: [slug: string | undefined];
  dirty: [dirty: boolean];
}>();

interface Forms {
  roles: Partial<Record<ModelRole, string>>;
  cloudModels: CloudModelsForm;
  characters: Record<string, string>;
  personas: Record<string, PersonaForm>;
  agents: AgentsForm;
  sprites: SettingsValues['sprites'];
  participants: number;
  voice: VoiceForm;
  notifications: NotificationsForm;
  secretary: SecretaryValues;
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
    participants: values.participants,
    voice: voiceForm(values.voice, defaults),
    notifications: notificationsForm(values.notifications),
    secretary: copy(values.secretary ?? DEFAULT_SECRETARY),
    executors: [...values.executors],
    telegram: telegramForm(values.telegram),
    projects: values.projects.map((project) => ({ ...project })),
    endpoints: endpointsForm(values.endpoints),
  };
}

const SECTIONS: Section[] = ['roles', 'sprites', 'cloudModels', 'characters', 'personas', 'agents', 'participants', 'voice', 'notifications', 'secretary', 'executors', 'telegram', 'projects', 'endpoints'];

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
const AGENT_PARTS: readonly OrdinarySection[] = ['characters', 'personas', 'agents', 'participants'];

/** Saves `parts` (by default the section alone) in one write; the card is known by `section`. False: not saved. */
async function save(section: OrdinarySection, parts: readonly OrdinarySection[] = [section]): Promise<boolean> {
  const current = forms.value;
  const fingerprint = view.value?.fingerprint;
  if (current === null || fingerprint === null || fingerprint === undefined) return false;
  const values: SettingsBody = {};
  if (parts.includes('roles')) values.roles = rolesBody(current.roles);
  if (parts.includes('cloudModels')) values.cloudModels = cloudModelsBody(current.cloudModels);
  if (parts.includes('characters')) values.characters = charactersBody(current.characters);
  if (parts.includes('voice')) values.voice = voiceBody(current.voice);
  if (parts.includes('personas')) values.personas = personasBody(current.personas);
  if (parts.includes('agents')) values.agents = agentsBody(current.agents);
  if (parts.includes('sprites')) values.sprites = current.sprites;
  if (parts.includes('participants')) values.participants = current.participants;
  if (parts.includes('notifications')) values.notifications = notificationsBody(current.notifications);
  if (parts.includes('secretary')) values.secretary = secretaryBody(current.secretary);
  generation += 1;
  busy.value = section;
  delete errors.value[section];
  notice.value = null;
  try {
    apply(await saveSettings(fingerprint, values), others(parts));
    markSaved(section);
    emit('changed', [...parts]);
    return true;
  } catch (error) {
    fail(section, error);
    return false;
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

onMounted(() => {
  void reload();
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

/** The parts the Modelli page saves together, in one write (D-137); it is known by `roles`. */
const MODEL_PARTS: readonly OrdinarySection[] = ['roles', 'sprites', 'cloudModels'];
function resetModels(): void {
  for (const part of MODEL_PARTS) reset(part);
  delete errors.value.roles;
}

/** The voices of the speech model chosen in the card of the models (the saved one until then). */
const voiceChoices = computed(() => {
  const tts = forms.value?.roles.tts ?? view.value?.values?.roles.tts;
  const voices = ttsModels.value.find((model) => model.id === tts)?.voices ?? [];
  return voices.map((voice) => ({ value: voice, label: clones.value.find((clone) => clone.id === voice)?.name ?? voice }));
});

/** Bumped by an upload: the sheets are asked again, a replaced one included (D-118). */
const sheetVersion = ref(0);
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
/** A sheet saved in the pack miei (D-118): listed again and chosen for the agent; the bar's Salva keeps it. */
async function onUploaded(agent: string, saved: UploadedCharacter): Promise<void> {
  sheetVersion.value += 1;
  try {
    characters.value = await loadCharacters();
  } catch {
    // The choice still names it; a reload lists it.
  }
  if (forms.value !== null) forms.value.characters[agent] = `${saved.pack}/${saved.character}`;
}
const personasInvalid = computed(() => (forms.value === null ? undefined : personasProblem(forms.value.personas, agentName)));

// The Agenti page (D-116, D-133): look, persona and model of every agent, saved together.
function resetAgents(): void {
  for (const part of AGENT_PARTS) reset(part);
  delete errors.value.agents;
}
/** Description and prompt of a user's agent changed and not saved: they live in the Agenti page only. */
const agentTextsDirty = ref(false);
/** "Apri una chat" from Agenti: the edits not saved are lost on the way, as when leaving the settings. */
function openChat(agent: string): void {
  if (!confirmLeave()) return;
  emit('chat', agent);
}
/** Another section from inside Agenti: the texts of the user's agents not saved are lost, so ask first (D-133). */
function textsLeft(): boolean {
  return !agentTextsDirty.value || window.confirm('Descrizione e prompt cambiati di un tuo agente non sono salvati: cambiando sezione si perdono. Vuoi cambiare?');
}
function openSection(slug: string): void {
  if (textsLeft()) emit('section', slug);
}
/** "Nuovo agente" is a page of its own: leaving the settings, as with the other pages. */
function openNewAgent(): void {
  if (confirmLeave()) emit('newAgent');
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
  return sectionDirty(item.id, (section) => changed(section as Section)) || (item.id === 'agents' && agentTextsDirty.value);
}
/** Every section holding edits not saved; the texts of the user's agents too (D-133). */
const unsaved = computed(() => {
  const titles = pendingTitles('', (section) => changed(section as Section));
  return agentTextsDirty.value ? [...titles, 'Agenti (descrizione e prompt)'] : titles;
});
watch(unsaved, (titles) => emit('dirty', titles.length > 0), { immediate: true });
/** Leaving the settings loses the edits not saved: true when there are none, or the user says to go anyway. */
function confirmLeave(): boolean {
  const left = unsaved.value;
  return left.length === 0 || window.confirm(`Ci sono modifiche non salvate in: ${left.join(', ')}. Uscendo dalle Impostazioni si perdono. Vuoi uscire?`);
}
function leave(to: 'voiceTrial' | 'devProgress' | 'changelog'): void {
  if (!confirmLeave()) return;
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
  // The texts of the user's agents live in the Agenti page only: another section drops them.
  if (active.value === 'agents' && item.id !== 'agents' && !textsLeft()) return;
  fromIndex = !chosen.value.explicit;
  emit('section', item.slug);
}
function backToIndex(): void {
  if (!textsLeft()) return;
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
      class="min-h-0 shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-5 lg:flex lg:w-[196px] lg:border-r lg:border-line lg:px-2 lg:py-4 3xl:w-[230px] 3xl:px-3 3xl:py-5"
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
          <span class="min-w-0 flex-1 truncate" :title="item.title">{{ item.title }}</span>
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
      <div :class="active === 'agents' || active === 'models' ? 'max-w-[1240px]' : 'max-w-[860px]'" class="@container mx-auto flex flex-col gap-5 px-4 pt-5 pb-24 md:px-6 short:gap-4 short:pt-4">
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
          <p v-if="chosen.item.behaviour === 'now' || chosen.item.behaviour === 'confirm'" class="flex items-start gap-2 rounded-[10px] border border-info/45 bg-info/9 px-3 py-1.5 text-xs 3xl:gap-2.5 3xl:px-3.5 3xl:py-2.5 3xl:text-[13px]">
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
            <!-- Modelli (I-3, D-137): every model in one list, the card, roles and switches; one bar saves -->
            <ModelsSettings
              v-if="active === 'models'"
              :form="forms"
              :base="base ?? forms"
              :catalog="catalog"
              :busy="busy === 'roles'"
              :error="errors.roles"
              :save="() => save('roles', MODEL_PARTS)"
              @cancel="resetModels"
              @section="openSection"
              @catalog="reload"
              @chat-trial="emit('chatTrial', $event)"
            />

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

            <!-- Notifications (I-1): kinds and quiet hours in arianna.toml; this browser below -->
            <SettingsCard v-if="active === 'notifications'" id="notifications" title="Notifiche" kind="now" :changed="changed('notifications')" :saved="saved === 'notifications'" :invalid="notificationsProblem(forms.notifications)" :busy="busy === 'notifications'" :error="errors.notifications" @cancel="reset('notifications')" @save="save('notifications')">
              <p class="text-xs text-muted">Quando la chat risponde e non la stai guardando. Valgono per ogni browser e telefono che hai consentito qui sotto.</p>
              <div class="flex flex-col gap-2">
                <label class="flex items-center gap-2 text-[13px]"><input v-model="forms.notifications.replies" type="checkbox" role="switch" class="switch" />Risposte nelle chat</label>
                <label class="flex items-center gap-2 text-[13px]"><input v-model="forms.notifications.approvals" type="checkbox" role="switch" class="switch" />Approvazioni in attesa</label>
                <label class="flex items-center gap-2 text-[13px]"><input v-model="forms.notifications.failures" type="checkbox" role="switch" class="switch" />Lavori falliti</label>
              </div>
              <h3 class="hud-title mt-1 flex items-center gap-2">
                Ore di silenzio
                <input v-model="forms.notifications.quiet" type="checkbox" role="switch" class="switch" aria-label="Ore di silenzio accese" />
              </h3>
              <div v-if="forms.notifications.quiet" class="grid grid-cols-2 gap-x-3.5 gap-y-2.5 sm:grid-cols-3">
                <label class="flex flex-col gap-1 text-xs text-muted">Silenzio dalle<input v-model="forms.notifications.quietFrom" type="time" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                <label class="flex flex-col gap-1 text-xs text-muted">Silenzio fino alle<input v-model="forms.notifications.quietTo" type="time" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
              </div>
              <p class="text-xs text-muted">{{ forms.notifications.quiet ? 'Ora locale; può passare la mezzanotte (per esempio dalle 22:00 alle 07:00).' : 'Nessuna ora di silenzio.' }} Le chiamate seguono i loro orari, in Voce.</p>
            </SettingsCard>
            <NotificationDevice v-if="active === 'notifications'" />

            <!-- The secretary (I-12, D-144): reminders on or off, the three moments, the days; saved in arianna.toml -->
            <SettingsCard v-if="active === 'secretary'" id="secretary" title="Segretaria" kind="now" :changed="changed('secretary')" :saved="saved === 'secretary'" :invalid="secretaryProblem(forms.secretary)" :busy="busy === 'secretary'" :error="errors.secretary" @cancel="reset('secretary')" @save="save('secretary')">
              <p class="text-xs text-muted">
                Dici ad Arianna le cose da fare con il pulsante «Segretaria» della barra a sinistra: le segna con il giorno, dopo che l’hai confermato. Qui scegli quando ricordartele.
              </p>
              <label class="flex items-center gap-2 text-[13px]"><input v-model="forms.secretary.enabled" type="checkbox" role="switch" class="switch" />Promemoria accesi</label>
              <div class="grid grid-cols-1 gap-x-3.5 gap-y-2.5 sm:grid-cols-3" :class="{ 'opacity-55': !forms.secretary.enabled }">
                <label class="flex flex-col gap-1 text-xs text-muted">Mattina: gli impegni del giorno<input v-model="forms.secretary.morning" type="time" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                <label class="flex flex-col gap-1 text-xs text-muted">Dopo pranzo: quelli ancora aperti<input v-model="forms.secretary.afternoon" type="time" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
                <label class="flex flex-col gap-1 text-xs text-muted">Fine giornata: cosa non è fatto<input v-model="forms.secretary.evening" type="time" class="field px-2 py-1.5 text-[13px] text-ink" /></label>
              </div>
              <fieldset class="flex flex-col gap-1.5" :class="{ 'opacity-55': !forms.secretary.enabled }">
                <legend class="mb-1 text-xs text-muted">Giorni</legend>
                <div class="flex flex-wrap gap-1.5">
                  <label v-for="day in WEEKDAYS" :key="day" class="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12.5px]">
                    <input v-model="forms.secretary.days" type="checkbox" :value="day" />{{ WEEKDAY_TEXT[day] }}
                  </label>
                </div>
              </fieldset>
              <p class="text-xs text-muted">
                A ogni orario Arianna scrive il promemoria nella conversazione «Segretaria» e ti avvisa con una notifica; se non c'è niente da ricordare non scrive. Se il
                Mac era spento, un promemoria perso arriva all'accensione solo fino all'orario successivo. Nelle ore di silenzio la notifica non suona, il messaggio resta.
              </p>
              <p class="text-xs text-muted">Ora locale di questo Mac. Il testo di un impegno resta qui: non va mai al cloud né nelle notifiche fuori dal Mac.</p>
            </SettingsCard>

            <!-- Agents (D-116, D-133): the cards on the left, the chosen agent in tabs, one bar to save -->
            <AgentsSettings
              v-if="active === 'agents'"
              :form="forms"
              :base="base ?? forms"
              :view="view"
              :characters="characters"
              :sheet-version="sheetVersion"
              :busy="busy === 'agents'"
              :error="errors.agents"
              :invalid="personasInvalid ?? leaveAfterProblem(forms.participants)"
              :direct-agents="directAgents ?? []"
              :save="() => save('agents', AGENT_PARTS)"
              @cancel="resetAgents"
              @uploaded="onUploaded"
              @changed="onAgentsChanged"
              @new-agent="openNewAgent"
              @section="openSection"
              @chat="openChat"
              @dirty="agentTextsDirty = $event"
            />

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
              <p class="text-xs text-muted">Un esecutore acceso può ricevere testi Pubblici o Interni passati dal gateway e lavorare nei progetti qui sotto. Una delega già partita finisce con i valori di prima.</p>
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
                <p class="text-xs text-muted">Il bot risponde solo a queste chat, al massimo con dati Interni (D-044). Il token del bot sta nel vault e non compare qui.</p>
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
                    <option value="L0">Pubblico</option>
                    <option value="L1">Interno</option>
                  </select>
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="project.path">{{ project.path }}</span>
                  <button type="button" class="btn px-2 py-1 text-xs" @click="forms.projects.splice(index, 1)"><Icon name="delete" :size="14" />Togli</button>
                </li>
              </ul>
              <form class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.6fr_auto_auto]" @submit.prevent="addProject">
                <input v-model="newProject.name" class="field px-2 py-1.5 text-[13px]" placeholder="nome" aria-label="Nome del progetto" />
                <input v-model="newProject.path" class="field px-2 py-1.5 font-mono text-xs" placeholder="~/Progetti/sito o repos/sito" aria-label="Cartella del progetto" />
                <select v-model="newProject.label" class="field px-2 py-1.5 font-mono text-xs" aria-label="Etichetta del progetto">
                  <option value="L0">Pubblico</option>
                  <option value="L1">Interno</option>
                </select>
                <button type="submit" class="btn px-2.5 py-1.5 text-xs" :disabled="!projectAddable"><Icon name="new" :size="14" />Aggiungi</button>
              </form>
              <p class="text-xs text-muted">
                Un esecutore cloud vede i file del progetto: l’etichetta dice quanto sono riservati (solo Pubblico o Interno). Un progetto aggiunto da qui non crea il link
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
                Un server locale vede i dati Privati in chiaro e il nucleo esegue il suo comando: il comando non deve contenere segreti, perché è mostrato qui. Cambiare indirizzo o comando
                riavvia quel server.
              </p>
            </template>
          </SettingsCard>

          <!-- Label rules: only the file changes them. -->
          <SettingsCard v-if="active === 'labels'" id="labels" title="Regole di etichetta" kind="read">
            <p class="text-xs text-muted">Le regole di etichetta e il gateway si cambiano solo a mano, nel file <code class="font-mono">config/labels.toml</code>.</p>
            <pre v-if="view.labels !== null" class="max-h-[320px] overflow-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap">{{ view.labels }}</pre>
            <p v-else class="text-sm text-danger">Il file delle etichette non si legge: senza regole tutto è Privato.</p>
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

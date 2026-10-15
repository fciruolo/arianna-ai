<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';

import {
  ApiError,
  confirmPrivacy,
  listCopiedVoices,
  loadChangelog,
  loadCharacters,
  loadLocalLog,
  loadSettings,
  loadThemes,
  loadVoiceTrial,
  preparePrivacy,
  restartLocal,
  saveSettings,
  type CopiedVoice,
  type TrialModel,
  type UploadedCharacter,
} from '../lib/api.ts';
import { MODE_HINT, type InstallationInfo } from '../lib/installation.ts';
import { personasBody, personasForm, personasProblem, type PersonaForm } from '../lib/persona.ts';
import { pendingBadge, pendingText } from '../lib/dev-progress.ts';
import { agentName } from '../lib/italian.ts';
import { SETTINGS_PATH, settingsPathFor } from '../lib/route.ts';
import { THEME_ICON, THEME_TEXT, THEMES, type Theme } from '../lib/theme.ts';
import { BEHAVIOUR_TEXT, hrefOf, pendingTitles, PRIVACY_HINT, resolveSection, sectionDirty, SETTINGS_INDEX, type IndexItem } from '../lib/settings-index.ts';
import { EXECUTOR_CARD, executorReceives, KEEP_ON_MAC, labelWord, restartBlocker, serverDown, serverName, serverStatus, type ServerTone } from '../lib/settings-copy.ts';
import {
  agentsBody,
  agentsForm,
  skillsBody,
  skillsForm,
  callsChanged,
  charactersBody,
  chatId,
  fetchSiteOf,
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
  pushChanged,
  pushProblem,
  rolesBody,
  DEFAULT_APPEARANCE,
  DEFAULT_SECRETARY,
  secretaryBody,
  projectRulesBody,
  projectRulesForm,
  projectRulesProblem,
  MAX_PROJECT_RULES,
  type ProjectRulesForm,
  secretaryProblem,
  WEEKDAY_TEXT,
  WEEKDAYS,
  keptSections,
  leaveAfterProblem,
  pollAction,
  SECTION_TEXT,
  sectionChanged,
  telegramBody,
  telegramForm,
  voiceAfterSave,
  voiceForm,
  voiceProblem,
  voiceSent,
  withPush,
  writeError,
  type AgentsForm,
  type SkillsForm,
  type CloudModelsForm,
  type EndpointForm,
  type LocalServerStatus,
  type ModelRole,
  type NotificationsForm,
  type OrdinarySection,
  type PrivacyProposal,
  type PrivacySection,
  type ProjectValues,
  type AppearanceValues,
  type SecretaryValues,
  type Section,
  type SeriesValues,
  type SettingsBody,
  type SettingsValues,
  type SettingsView,
  type TelegramForm,
  type VoiceForm,
  type VoiceValues,
} from '../lib/settings.ts';
import type { CharacterListing, DirectAgent } from '../lib/types.ts';
import AgentsSettings from './AgentsSettings.vue';
import ChangelogPage from './ChangelogPage.vue';
import DesignCatalog from './DesignCatalog.vue';
import DevProgressPage from './DevProgressPage.vue';
import UsagePage from './UsagePage.vue';
import FormField from './FormField.vue';
import InstallationReadiness from './InstallationReadiness.vue';
import SkillsCatalog from './SkillsCatalog.vue';
import AgentsCatalog from './AgentsCatalog.vue';
import Icon from './Icon.vue';
import ProfileFacts from './ProfileFacts.vue';
import ModelsSettings from './ModelsSettings.vue';
import NotificationDevice from './NotificationDevice.vue';
import OdNews from './OdNews.vue';
import PrivacyConfirm from './PrivacyConfirm.vue';
import SettingsCard from './SettingsCard.vue';
import ThemePicker from './ThemePicker.vue';
import type { ThemeListing } from '../lib/themes.ts';
import SettingsSaveBar from './SettingsSaveBar.vue';
import VoiceListen from './VoiceListen.vue';

/**
 * The settings page of the web chat (D-071, revised in D-192), over
 * /api/settings. One section at a time, every section as wide (1120 px):
 * title, one pill, a sentence with an example, cards with the fields on a
 * grid of six columns, one save bar shown only with edits. The ordinary
 * sections are saved at once; those that let data out are prepared, shown in
 * the confirmation of the exits and written only on «Conferma e salva». Every
 * write carries the fingerprint of the file the page read: a 409 means
 * someone else wrote it, and the page reloads the values.
 */
/**
 * `installation`: what this installation is (D-098); undefined while unknown.
 * `section`: the slug of the address (D-105), `/impostazioni/<slug>`; the page shows that section only.
 * `devPending`: open questions of "Sviluppo di Arianna" without an answer, a badge on its entry (D-120).
 * `directAgents`: the agents one can talk with directly (D-111d), for "Apri una chat" in Agenti (D-133).
 * `theme`: the theme of this browser (D-158), the same choice as the button of the top bar.
 * `callBusy`: a call is starting, ringing or on (D-192): «Ascolta» waits for it to end.
 */
const props = defineProps<{ installation?: InstallationInfo | undefined; section?: string | undefined; devPending?: number; directAgents?: DirectAgent[]; theme?: Theme; callBusy?: boolean }>();
const devDot = computed(() => pendingBadge(props.devPending ?? 0));
const devLabel = computed(() => pendingText(props.devPending ?? 0));
/**
 * `section`: the user chose another section (undefined: back to the index on a narrow screen).
 * `dirty`: some section holds edits not saved, for the back button of the browser (App.vue).
 * `newAgent`: the page "Nuovo agente" (D-119). `chat`: "Apri una chat" on an agent (D-133).
 * `devPending`, `knowledge`: from "Sviluppo di Arianna" (D-102), now a section (D-192).
 * `open`: a conversation with GOD opened from «Novità» (D-178).
 */
const emit = defineEmits<{
  changed: [sections: string[]];
  voiceTrial: [];
  newAgent: [];
  chat: [agent: string];
  chatTrial: [modelId: string];
  section: [slug: string | undefined];
  dirty: [dirty: boolean];
  theme: [theme: Theme];
  devPending: [count: number];
  knowledge: [];
  open: [id: string];
}>();

interface Forms {
  roles: Partial<Record<ModelRole, string>>;
  cloudModels: CloudModelsForm;
  characters: Record<string, string>;
  personas: Record<string, PersonaForm>;
  series: Record<string, SeriesValues>;
  projectRules: ProjectRulesForm;
  agents: AgentsForm;
  skills: SkillsForm;
  sprites: SettingsValues['sprites'];
  participants: number;
  voice: VoiceForm;
  notifications: NotificationsForm;
  secretary: SecretaryValues;
  appearance: AppearanceValues;
  executors: string[];
  telegram: TelegramForm;
  projects: ProjectValues[];
  endpoints: EndpointForm[];
  fetchSites: string[];
}

function formsOf(values: SettingsValues, defaults: VoiceValues, agentModels: SettingsView['agentModels'], agentSkills: SettingsView['agentSkills']): Forms {
  return {
    roles: { ...values.roles },
    cloudModels: cloudModelsForm(values.cloudModels),
    characters: { ...values.characters },
    personas: personasForm(values.personas),
    series: copy(values.series ?? {}),
    projectRules: projectRulesForm(values.projectRules),
    agents: agentsForm(values.agents, agentModels),
    skills: skillsForm(values.skills, agentSkills),
    sprites: values.sprites,
    participants: values.participants,
    voice: voiceForm(values.voice, defaults),
    notifications: notificationsForm(values.notifications),
    secretary: copy(values.secretary ?? DEFAULT_SECRETARY),
    appearance: copy(values.appearance ?? DEFAULT_APPEARANCE),
    executors: [...values.executors],
    telegram: telegramForm(values.telegram),
    projects: values.projects.map((project) => ({ ...project })),
    endpoints: endpointsForm(values.endpoints),
    fetchSites: [...(values.fetchSites ?? [])],
  };
}

const SECTIONS: Section[] = ['roles', 'sprites', 'cloudModels', 'characters', 'personas', 'series', 'projectRules', 'agents', 'skills', 'participants', 'voice', 'notifications', 'secretary', 'appearance', 'executors', 'telegram', 'projects', 'endpoints', 'fetchSites'];

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

const base = computed(() => (view.value?.values === null || view.value === null ? null : formsOf(view.value.values, view.value.voiceDefaults, view.value.agentModels, view.value.agentSkills)));

function changed(section: Section): boolean {
  return forms.value !== null && base.value !== null && sectionChanged(section, forms.value[section], base.value[section]);
}

/**
 * A part changed, as the index counts them: `voice` is Voce e chiamate
 * without the push keys, `push` the keys shown in Notifiche (D-192).
 */
function isChanged(name: string): boolean {
  if (forms.value === null || base.value === null) return false;
  if (name === 'push') return pushChanged(forms.value.voice, base.value.voice);
  if (name === 'voice') return callsChanged(forms.value.voice, base.value.voice);
  return changed(name as Section);
}

function reset(section: Section): void {
  if (forms.value === null || base.value === null) return;
  (forms.value as unknown as Record<Section, unknown>)[section] = copy(base.value[section]);
  delete errors.value[section];
}

/** One part of [voice] back to what was read, the other part left as edited. */
function resetVoice(part: 'calls' | 'push'): void {
  if (forms.value === null || base.value === null) return;
  forms.value.voice = part === 'push' ? withPush(forms.value.voice, base.value.voice) : withPush(base.value.voice, forms.value.voice);
  delete errors.value[part === 'push' ? 'notifications' : 'voice'];
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
  const fresh = formsOf(next.values, next.voiceDefaults, next.agentModels, next.agentSkills);
  if (old !== null) for (const section of kept) (fresh as unknown as Record<Section, unknown>)[section] = old[section];
  forms.value = fresh;
}

const reloading = ref(false);
async function reload(): Promise<void> {
  const started = ++generation;
  reloading.value = true;
  try {
    const next = await loadSettings();
    if (started !== generation) return;
    apply(next);
    loadError.value = null;
    errors.value = {};
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'errore';
  } finally {
    reloading.value = false;
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

// The section saved last says "Salvato" for a few seconds: without it a save looked like nothing happened.
const saved = ref<Section | null>(null);
let savedTimer: number | undefined;
function markSaved(section: Section): void {
  saved.value = section;
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => {
    saved.value = null;
  }, 4000);
}

/** The parts the Agenti page saves together, in one write (D-116); it is known by `agents`. */
const AGENT_PARTS: readonly OrdinarySection[] = ['characters', 'personas', 'agents', 'skills', 'participants'];

/**
 * Saves `parts` (by default the section alone) in one write; the section is
 * known by `section`. With `voice` among the parts, `voicePart` says which
 * part of [voice] is sent (D-192): the other one goes as read and keeps its
 * edits in the page. False: not saved.
 */
async function save(section: OrdinarySection, parts: readonly OrdinarySection[] = [section], voicePart: 'calls' | 'push' = 'calls'): Promise<boolean> {
  const current = forms.value;
  const read = base.value;
  const fingerprint = view.value?.fingerprint;
  if (current === null || read === null || fingerprint === null || fingerprint === undefined) return false;
  const values: SettingsBody = {};
  if (parts.includes('roles')) values.roles = rolesBody(current.roles);
  if (parts.includes('cloudModels')) values.cloudModels = cloudModelsBody(current.cloudModels);
  if (parts.includes('characters')) values.characters = charactersBody(current.characters);
  if (parts.includes('voice')) values.voice = voiceSent(voicePart, current.voice, read.voice);
  if (parts.includes('personas')) values.personas = personasBody(current.personas);
  // An older core has no rewrites of the people of the series (D-223): nothing to send.
  if (parts.includes('series') && view.value?.values?.series !== undefined) values.series = copy(current.series);
  if (parts.includes('agents')) values.agents = agentsBody(current.agents);
  // An older core has no skills (D-161): nothing to send.
  if (parts.includes('skills') && view.value?.values?.skills !== undefined) values.skills = skillsBody(current.skills);
  if (parts.includes('sprites')) values.sprites = current.sprites;
  if (parts.includes('participants')) values.participants = current.participants;
  if (parts.includes('notifications')) values.notifications = notificationsBody(current.notifications);
  if (parts.includes('secretary')) values.secretary = secretaryBody(current.secretary);
  // An older core has no themes (D-103): nothing to send.
  if (parts.includes('appearance') && view.value?.values?.appearance !== undefined) values.appearance = { theme: current.appearance.theme };
  // An older core has no rules of the projects (D-174): nothing to send.
  if (parts.includes('projectRules') && view.value?.values?.projectRules !== undefined) values.projectRules = projectRulesBody(current.projectRules);
  generation += 1;
  busy.value = section;
  delete errors.value[section];
  notice.value = null;
  const before = current.voice;
  try {
    apply(await saveSettings(fingerprint, values), others(parts));
    // The part of [voice] not sent keeps what the page holds for it.
    if (parts.includes('voice') && forms.value !== null) forms.value.voice = voiceAfterSave(voicePart, before, read.voice, forms.value.voice);
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
  if (section === 'fetchSites') values.fetchSites = [...current.fetchSites];
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
/** "Novità": the current version, at the bottom of the index and next to its title; null until read or when there is none. */
const currentVersion = ref<string | null>(null);

/** The themes (D-103): read with the page and again after a choice. */
const themeListing = ref<ThemeListing | null>(null);
function readThemes(): void {
  void loadThemes()
    .then((listing) => {
      themeListing.value = listing;
    })
    .catch(() => undefined);
}

/** The mode on screen, for the preview of the themes: the choice of this browser, or the system's. */
const lightQuery = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: light)');
const systemLight = ref(lightQuery?.matches ?? false);
function followSystem(event: MediaQueryListEvent): void {
  systemLight.value = event.matches;
}
lightQuery?.addEventListener('change', followSystem);
onBeforeUnmount(() => lightQuery?.removeEventListener('change', followSystem));
const screenMode = computed<'dark' | 'light'>(() => {
  const mode = props.theme ?? 'system';
  return mode === 'system' ? (systemLight.value ? 'light' : 'dark') : mode;
});

/** A theme chosen (D-103): saved at once in [appearance], the other edits of the page kept. */
async function chooseTheme(id: string): Promise<void> {
  if (forms.value === null || forms.value.appearance.theme === id) return;
  forms.value.appearance.theme = id;
  if (!(await save('appearance'))) {
    reset('appearance');
    return;
  }
  readThemes();
  characters.value = await loadCharacters().catch(() => characters.value);
}

onMounted(() => {
  void reload();
  readThemes();
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

/** The voices of the speech model chosen in Modelli (the saved one until then). */
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
/** A pack downloaded (D-206): the characters listed again, the sheets asked again. */
async function onPacks(): Promise<void> {
  sheetVersion.value += 1;
  try {
    characters.value = await loadCharacters();
  } catch {
    // A reload lists them.
  }
}
/** A sheet saved in the pack miei (D-118): listed again and chosen for the agent; the bar's Salva keeps it. */
async function onUploaded(agent: string, uploaded: UploadedCharacter): Promise<void> {
  sheetVersion.value += 1;
  try {
    characters.value = await loadCharacters();
  } catch {
    // The choice still names it; a reload lists it.
  }
  if (forms.value !== null) forms.value.characters[agent] = `${uploaded.pack}/${uploaded.character}`;
}
const personasInvalid = computed(() => (forms.value === null ? undefined : personasProblem(forms.value.personas, agentName)));

// The Agenti page (D-116, D-133): look, persona and model of every agent, saved together.
function resetAgents(): void {
  for (const part of AGENT_PARTS) reset(part);
  delete errors.value.agents;
}
/** The Agenti page: told when the catalog of skills changes, so its tab Skill reads it again (D-161). */
const agentsPage = useTemplateRef<InstanceType<typeof AgentsSettings>>('agentsPage');
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
/** A conversation with GOD from «Novità» (D-178): leaving the settings. */
function openConversation(id: string): void {
  if (confirmLeave()) emit('open', id);
}
function openKnowledge(): void {
  if (confirmLeave()) emit('knowledge');
}

// Telegram chats and projects: added from a small row of fields.
const newChat = ref('');
function addChat(): void {
  const id = chatId(newChat.value);
  if (id === undefined || forms.value === null) return;
  if (!forms.value.telegram.chats.includes(id)) forms.value.telegram.chats.push(id);
  newChat.value = '';
}
// Sites whose links are downloaded by themselves (D-154): an address or a name, kept as the host name.
const newSite = ref('');
function addSite(): void {
  const site = fetchSiteOf(newSite.value);
  if (site === undefined || forms.value === null) return;
  if (!forms.value.fetchSites.includes(site)) forms.value.fetchSites.push(site);
  newSite.value = '';
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
/** The rules of the projects: lines and characters used, said under the field. */
const rulesCount = computed(() => {
  const text = forms.value?.projectRules.template ?? '';
  const lines = text.split('\n').filter((line) => line.trim() !== '').length;
  return `${lines === 1 ? '1 riga' : `${String(lines)} righe`} · ${text.length.toLocaleString('it-IT')} di ${MAX_PROJECT_RULES.toLocaleString('it-IT')} caratteri.`;
});
const rulesOwn = computed(() => Object.keys(forms.value?.projectRules.projects ?? {}).sort());

// Local servers: restart and the end of the log.
const restarting = ref<string | null>(null);
const restartError = ref<Record<string, string>>({});
const logs = ref<Record<string, string | null>>({});
const logOpen = ref<Record<string, boolean>>({});
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
  const open = (event.target as HTMLDetailsElement).open;
  logOpen.value[id] = open;
  if (open) void readLog(id);
}
function showLog(id: string): void {
  logOpen.value[id] = true;
  void readLog(id);
}
const LED_CLASS: Record<ServerTone, string> = { ok: 'bg-ok', warn: 'animate-hud-blink bg-warn', danger: 'bg-danger', muted: 'bg-muted' };
const PILL_CLASS: Record<ServerTone, string> = { ok: 'text-ok border-ok/50', warn: 'text-warn border-warn/55', danger: 'text-danger border-danger/50', muted: '' };
const GRADE_CLASS: Record<string, string> = { L0: 'text-ok border-ok/50', L1: 'text-warn border-warn/55', L2: 'text-danger border-danger/50', L3: 'text-danger border-danger/50' };

/**
 * One section at a time (D-105): the index on the left, the chosen section on
 * the right, chosen by the address. Edits of a section left behind stay in the
 * page (the forms are one object) and are listed until saved or cancelled.
 */
const chosen = computed(() => resolveSection(props.section));
const active = computed(() => chosen.value.item.id);
const pending = computed(() => pendingTitles(active.value, isChanged));
function dirty(item: IndexItem): boolean {
  return sectionDirty(item.id, isChanged) || (item.id === 'agents' && agentTextsDirty.value);
}
/** Every section holding edits not saved; the texts of the user's agents too (D-133). */
const unsaved = computed(() => {
  const titles = pendingTitles('', isChanged);
  return agentTextsDirty.value ? [...titles, 'Agenti (descrizione e prompt)'] : titles;
});
watch(unsaved, (titles) => emit('dirty', titles.length > 0), { immediate: true });
/** Leaving the settings loses the edits not saved: true when there are none, or the user says to go anyway. */
function confirmLeave(): boolean {
  const left = unsaved.value;
  return left.length === 0 || window.confirm(`Ci sono modifiche non salvate in: ${left.join(', ')}. Uscendo dalle Impostazioni si perdono. Vuoi uscire?`);
}
function leave(): void {
  if (confirmLeave()) emit('voiceTrial');
}
/** A section opened from the index shown alone (narrow screen): "‹ Impostazioni" goes back in the history. */
let fromIndex = false;
function open(item: IndexItem): void {
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
    // An old address (Personaggi, Esecutori cloud, Etichette…) shows its new section under the new address.
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

/** The pill under the title: «Arianna 0.83.0» in Novità, else how the section takes effect. */
const pill = computed(() => (active.value === 'changelog' ? (currentVersion.value === null ? null : `Arianna ${currentVersion.value}`) : BEHAVIOUR_TEXT[chosen.value.item.behaviour]));
const PILL_TONE: Record<string, string> = { now: 'text-ok border-ok/50', confirm: 'text-warn border-warn/55' };

/** The save bar of the sections the page edits itself (Modelli and Agenti have their own). */
interface Bar {
  dirty: boolean;
  count: number;
  privacy: boolean;
  busy: boolean;
  saved: boolean;
  error: string | undefined;
  invalid: string | undefined;
  save: () => void;
  cancel: () => void;
}
function ordinary(section: OrdinarySection, invalid?: string): Bar {
  return {
    dirty: isChanged(section),
    count: 1,
    privacy: false,
    busy: busy.value === section,
    saved: saved.value === section,
    error: errors.value[section],
    invalid,
    save: () => void save(section),
    cancel: () => reset(section),
  };
}
function exits(section: PrivacySection): Bar {
  return {
    dirty: changed(section),
    count: 1,
    privacy: true,
    busy: busy.value === section,
    saved: saved.value === section,
    error: errors.value[section],
    invalid: undefined,
    save: () => void prepare(section),
    cancel: () => reset(section),
  };
}
const bar = computed<Bar | null>(() => {
  const current = forms.value;
  if (current === null) return null;
  switch (active.value) {
    case 'voice':
      return {
        ...ordinary('voice', voiceProblem(current.voice)),
        save: () => void save('voice', ['voice'], 'calls'),
        cancel: () => resetVoice('calls'),
      };
    case 'notifications': {
      const keys = isChanged('push');
      const kinds = changed('notifications');
      return {
        dirty: keys || kinds,
        count: Number(keys) + Number(kinds),
        privacy: false,
        busy: busy.value === 'notifications',
        saved: saved.value === 'notifications',
        error: errors.value.notifications,
        invalid: notificationsProblem(current.notifications) ?? (keys ? pushProblem(current.voice) : undefined),
        save: () => void save('notifications', keys ? ['notifications', 'voice'] : ['notifications'], 'push'),
        cancel: () => {
          reset('notifications');
          resetVoice('push');
        },
      };
    }
    case 'secretary':
      return ordinary('secretary', secretaryProblem(current.secretary));
    case 'project-rules':
      return ordinary('projectRules', projectRulesProblem(current.projectRules));
    case 'executors':
      return exits('executors');
    case 'projects':
      return exits('projects');
    case 'links':
      return exits('fetchSites');
    case 'servers':
      return exits('endpoints');
    default:
      return null;
  }
});
/** The section's fields locked while it saves. */
const locked = computed(() => bar.value?.busy ?? false);
const input = 'field w-full min-w-0 px-2.5 py-1.5 text-[14px] text-ink';
const grid = 'grid gap-3 sm:grid-cols-6';
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <!-- The index (D-105, D-192): always on wide screens; on narrow ones it is the page until a section is chosen. -->
    <nav
      :inert="proposal !== null"
      class="min-h-0 shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-5 lg:flex lg:w-[240px] lg:border-r lg:border-line lg:px-2.5 lg:py-4"
      :class="chosen.explicit ? 'hidden' : 'flex w-full'"
      aria-label="Indice delle impostazioni"
    >
      <h1 class="mx-2.5 mb-2 text-xl font-semibold lg:hidden">Impostazioni</h1>
      <template v-for="group in SETTINGS_INDEX" :key="group.group">
        <h2 class="mx-2.5 mt-4 mb-1 text-[12.5px] font-semibold text-muted first:mt-0">{{ group.group }}</h2>
        <a
          v-for="item in group.items"
          :key="item.id"
          :href="hrefOf(item)"
          class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[14.5px] hover:bg-surface-2 hover:text-ink lg:py-1.5"
          :class="active === item.id ? 'text-muted lg:bg-surface-2 lg:font-semibold lg:text-ink lg:shadow-[inset_3px_0_0_var(--accent)]' : 'text-muted'"
          :aria-current="active === item.id ? 'page' : undefined"
          @click.prevent="open(item)"
        >
          <span class="min-w-0 flex-1 truncate" :title="item.title">{{ item.title }}</span>
          <span
            v-if="item.id === 'dev-progress' && devDot !== null"
            role="img"
            class="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[12px] leading-5 font-semibold text-accent-ink"
            :title="devLabel ?? undefined"
            :aria-label="devLabel ?? undefined"
          >{{ devDot }}</span>
          <span v-if="dirty(item)" role="img" class="size-[7px] rounded-full bg-warn" title="Modifiche non salvate" aria-label="modifiche non salvate" />
          <span v-if="item.privacy" role="img" class="inline-flex text-warn" :title="PRIVACY_HINT" :aria-label="PRIVACY_HINT"><Icon name="private" :size="14" /></span>
        </a>
      </template>
      <p v-if="currentVersion !== null || installation !== undefined" class="mx-2.5 mt-auto pt-6 text-[13px] text-muted">
        <template v-if="currentVersion !== null">Arianna {{ currentVersion }}</template><template v-if="currentVersion !== null && installation !== undefined"> · </template>
        <template v-if="installation !== undefined">installazione di {{ installation.mode === 'development' ? 'sviluppo' : 'produzione' }}</template>
      </p>
    </nav>

    <div ref="pane" :inert="proposal !== null" class="min-h-0 min-w-0 flex-1 overflow-y-auto lg:block" :class="chosen.explicit ? 'block' : 'hidden'">
      <div class="@container mx-auto flex max-w-[1120px] flex-col gap-3.5 px-4 pt-5 pb-24 md:px-6">
        <header class="flex flex-col gap-1.5">
          <button type="button" class="mb-1 self-start text-sm text-muted hover:text-ink lg:hidden" @click="backToIndex"><span aria-hidden="true">‹ </span>Impostazioni</button>
          <div class="flex flex-wrap items-center gap-2.5">
            <h1 class="text-[22px] font-semibold">{{ chosen.item.title }}</h1>
            <span v-if="pill !== null" class="pill" :class="PILL_TONE[chosen.item.behaviour] ?? ''">
              <Icon v-if="chosen.item.privacy" name="private" :size="13" />{{ pill }}
            </span>
            <!-- What switches the whole section on or off sits next to its title. -->
            <label v-if="active === 'voice' && forms !== null" class="ml-auto flex items-center gap-2.5 text-[14.5px]">
              Chiamate accese
              <input v-model="forms.voice.enabled" type="checkbox" role="switch" class="switch" :disabled="locked" />
            </label>
            <label v-if="active === 'secretary' && forms !== null" class="ml-auto flex items-center gap-2.5 text-[14.5px]">
              Promemoria accesi
              <input v-model="forms.secretary.enabled" type="checkbox" role="switch" class="switch" :disabled="locked" />
            </label>
          </div>
          <p class="max-w-[78ch] text-muted">
            {{ chosen.item.lead }}
            <span v-if="chosen.item.example !== undefined" class="mt-1 block text-[14px]"><b class="font-semibold text-ink">Esempio:</b> {{ chosen.item.example }}</span>
          </p>
        </header>

        <p v-if="pending.length > 0" role="status" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2.5 text-[14px]">
          <Icon name="warning" :size="16" class="text-warn" />
          <span class="min-w-[220px] flex-1">Modifiche non salvate in: {{ pending.join(', ') }}. Restano lì finché non le salvi o le annulli; uscendo dalle Impostazioni si perdono.</span>
        </p>

        <!-- Sections that do not need the values of the file: they work even when it does not load. -->
        <div v-if="active === 'skills'" class="flex flex-col gap-3.5">
          <!-- The catalog of Open Design (D-160) with its news (I-21, D-186), then the catalog of skills (D-161) -->
          <DesignCatalog />
          <OdNews />
          <SkillsCatalog @changed="agentsPage?.skillsCatalogChanged()" />
        </div>
        <!-- The catalog of agents (D-079): roles from GitHub -->
        <AgentsCatalog v-else-if="active === 'agents-catalog'" />
        <!-- «Su di te» (D-114): the facts of the profile, in the database, not in arianna.toml -->
        <ProfileFacts v-else-if="active === 'about-you'" />
        <ChangelogPage v-else-if="active === 'changelog'" @open="openConversation" />
        <UsagePage v-else-if="active === 'usage'" />
        <DevProgressPage v-else-if="active === 'dev-progress'" @pending="emit('devPending', $event)" @knowledge="openKnowledge" />

        <!-- Aspetto e installazione: the theme of this browser (D-158) and what this installation is (D-098) -->
        <template v-else-if="active === 'system'">
          <SettingsCard id="theme" title="Tema" :busy="busy === 'appearance'">
            <template #header>
              <span v-if="saved === 'appearance'" class="pill text-ok border-ok/50">Salvato</span>
              <span v-else class="pill text-ok border-ok/50">Vale subito, su tutti i dispositivi</span>
            </template>
            <ThemePicker v-if="forms !== null" :listing="themeListing" :chosen="forms.appearance.theme" :characters="characters" :mode="screenMode" :busy="busy !== null || locked" @choose="chooseTheme" />
            <p v-else class="text-[14px] text-muted">Le impostazioni non sono lette: il tema si sceglie quando tornano.</p>
            <p v-if="errors.appearance !== undefined" class="text-[14px] text-danger">{{ errors.appearance }}</p>
          </SettingsCard>
          <SettingsCard id="mode" title="Modalità">
            <template #header><span class="pill text-ok border-ok/50">Vale subito, solo in questo browser</span></template>
            <div class="inline-flex self-start overflow-hidden rounded-[9px] border border-line-strong" role="group" aria-label="Modalità">
              <button
                v-for="option in THEMES"
                :key="option"
                type="button"
                :aria-pressed="(theme ?? 'system') === option"
                class="inline-flex items-center gap-1.5 border-line-strong px-3 py-1.5 text-[14px] not-first:border-l"
                :class="(theme ?? 'system') === option ? 'bg-surface font-semibold text-ink' : 'text-muted hover:text-ink'"
                @click="emit('theme', option)"
              >
                <Icon :name="THEME_ICON[option]" :size="14" />{{ THEME_TEXT[option] }}
              </button>
            </div>
            <p class="text-[13px] text-muted">Automatico segue il Mac. Lo cambi anche dal pulsante in alto a destra.</p>
          </SettingsCard>
          <SettingsCard id="installation" title="Installazione">
            <template #header>sola lettura</template>
            <dl v-if="installation !== undefined" class="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3">
              <div class="bg-surface px-3 py-2">
                <dt class="text-[13px] text-muted">Tipo</dt>
                <dd><span class="pill" :class="installation.mode === 'development' ? 'text-warn border-warn/55' : 'text-ok border-ok/50'">{{ installation.mode === 'development' ? 'Sviluppo' : 'Produzione' }}</span></dd>
              </div>
              <div class="bg-surface px-3 py-2">
                <dt class="text-[13px] text-muted">Versione</dt>
                <dd class="text-[14.5px]">{{ currentVersion ?? 'non letta' }}<span v-if="installation.version !== null" class="ml-1.5 font-mono text-[12.5px] text-muted">{{ installation.version }}</span></dd>
              </div>
              <div class="bg-surface px-3 py-2">
                <dt class="text-[13px] text-muted">Cartella</dt>
                <dd class="font-mono text-[12.5px] break-all">{{ installation.home }}</dd>
              </div>
            </dl>
            <p v-if="installation !== undefined" class="text-[13px] text-muted">
              {{ MODE_HINT[installation.mode] }}.<template v-if="installation.mode === 'development'"> Diventa pronta per i dati veri quando le password vere sono nella cassaforte e il controllo qui sotto la dà pronta.</template>
            </p>
            <p v-else class="text-[14px] text-muted">Arianna non dice che installazione è: riprova fra poco, o riavviala.</p>
            <InstallationReadiness />
          </SettingsCard>
          <p class="flex items-start gap-2.5 rounded-[10px] border border-info/45 bg-info/8 px-3 py-2.5 text-[14px]">
            <Icon name="info" :size="16" class="mt-0.5 shrink-0 text-info" />
            <span>Le impostazioni stanno in un file sul Mac. Se lo modifichi a mano e poi salvi da qui, le tue note dentro il file si perdono.</span>
          </p>
        </template>

        <template v-else>
          <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
            <span class="min-w-[220px] flex-1">Non riesco a leggere le impostazioni: {{ loadError }}</span>
            <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="reloading" @click="reload">Riprova</button>
          </div>
          <p v-if="view === null && loadError === null" class="text-muted">Leggo le impostazioni…</p>

          <template v-if="view !== null">
            <p v-if="view.restartPending.length > 0" class="flex items-start gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2.5 text-[14px]">
              <Icon name="warning" :size="16" class="mt-0.5 shrink-0 text-warn" />
              <span>Cambiati nel file e in attesa che Arianna si riavvii: {{ view.restartPending.map((part) => SECTION_TEXT[part] ?? part).join(', ') }}.</span>
            </p>
            <div v-if="notice !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
              <span class="min-w-[220px] flex-1">{{ notice }}</span>
              <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="notice = null">Chiudi</button>
            </div>
            <div v-if="stale" role="status" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2.5 text-[14px]">
              <span class="min-w-[220px] flex-1">Il file delle impostazioni è cambiato fuori da questa pagina: salvando ora la modifica sarebbe rifiutata.</span>
              <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="reload">Ricarica i valori</button>
            </div>
            <p v-if="view.error !== null" role="alert" class="rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
              Il file delle impostazioni non è valido, e finché non lo correggi tutte le uscite sono chiuse: {{ view.error }}. Chiedi a Claude Code di correggerlo, poi premi
              <button type="button" class="font-semibold text-accent hover:underline" @click="reload">Riprova</button>.
            </p>

            <template v-if="forms !== null">
              <!-- Modelli (I-3, D-137): roles first, every model in a list with its card; its own save bar -->
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

              <!-- Agenti (D-116, D-133): the cards on the left, the chosen agent in tabs; its own save bar -->
              <AgentsSettings
                v-if="active === 'agents'"
                ref="agentsPage"
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
                :save-series="view?.values?.series === undefined ? undefined : () => save('series', ['series'])"
                :series-busy="busy === 'series'"
                :series-error="errors.series"
                @cancel="resetAgents"
                @uploaded="onUploaded"
                @packs="onPacks"
                @changed="onAgentsChanged"
                @new-agent="openNewAgent"
                @section="openSection"
                @chat="openChat"
                @dirty="agentTextsDirty = $event"
              />

              <!-- Voce e chiamate -->
              <template v-if="active === 'voice'">
                <template v-if="forms.voice.enabled">
                  <SettingsCard id="voice-own" title="La sua voce" :busy="locked">
                    <div :class="grid">
                      <FormField id="voice-name" label="Voce di Arianna" :span="2" hint="Quelle del modello scelto in Modelli per «Parla con la sua voce».">
                        <input id="voice-name" v-model.trim="forms.voice.values.voice" list="voice-choices" :class="input" />
                        <datalist id="voice-choices">
                          <option v-for="choice in voiceChoices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
                        </datalist>
                      </FormField>
                      <div class="pt-6 max-sm:pt-0 sm:col-span-4">
                        <VoiceListen :model="forms.roles.tts" :voice="forms.voice.values.voice" :call-busy="callBusy === true" @trial="leave" />
                      </div>
                    </div>
                  </SettingsCard>
                  <SettingsCard id="voice-call" title="Durante una chiamata" :busy="locked">
                    <div :class="grid">
                      <FormField id="voice-minutes" label="Durata massima" :span="1">
                        <span class="flex items-center gap-1.5"><input id="voice-minutes" v-model.number="forms.voice.values.limits.callMinutes" type="number" min="1" max="120" :class="input" /><span class="text-[13px] text-muted">min</span></span>
                      </FormField>
                      <FormField id="voice-warn" label="Avviso prima" :span="1">
                        <span class="flex items-center gap-1.5"><input id="voice-warn" v-model.number="forms.voice.values.limits.warnSeconds" type="number" min="0" max="600" :class="input" /><span class="text-[13px] text-muted">s</span></span>
                      </FormField>
                      <FormField id="voice-delegations" label="Lavori che può passare agli agenti" :span="2">
                        <span class="flex items-center gap-1.5"><input id="voice-delegations" v-model.number="forms.voice.values.limits.delegations" type="number" min="0" max="50" :class="input" /><span class="text-[13px] whitespace-nowrap text-muted">per chiamata</span></span>
                      </FormField>
                      <FormField id="voice-delegation-wait" label="Attesa massima di un lavoro" :span="2">
                        <span class="flex items-center gap-1.5"><input id="voice-delegation-wait" v-model.number="forms.voice.values.limits.delegationSeconds" type="number" min="5" max="600" :class="input" /><span class="text-[13px] text-muted">s</span></span>
                      </FormField>
                    </div>
                  </SettingsCard>
                  <SettingsCard id="voice-outgoing" title="Quando ti chiama Arianna" :busy="locked">
                    <div :class="grid">
                      <FormField id="voice-per-day" label="Al giorno" :span="1">
                        <span class="flex items-center gap-1.5"><input id="voice-per-day" v-model.number="forms.voice.values.outgoing.maxPerDay" type="number" min="0" max="50" :class="input" /><span class="text-[13px] text-muted">max</span></span>
                      </FormField>
                      <FormField id="voice-quiet-from" label="Silenzio dalle" :span="1">
                        <input id="voice-quiet-from" v-model="forms.voice.values.outgoing.quietFrom" type="time" :class="input" />
                      </FormField>
                      <FormField id="voice-quiet-to" label="alle" :span="1">
                        <input id="voice-quiet-to" v-model="forms.voice.values.outgoing.quietTo" type="time" :class="input" />
                      </FormField>
                      <FormField id="voice-ring" label="Squilla per" :span="1">
                        <span class="flex items-center gap-1.5"><input id="voice-ring" v-model.number="forms.voice.values.outgoing.ringSeconds" type="number" min="5" max="300" :class="input" /><span class="text-[13px] text-muted">s</span></span>
                      </FormField>
                      <FormField id="voice-waiting" label="Ti chiama se aspetta una risposta da" :span="2">
                        <span class="flex items-center gap-1.5"><input id="voice-waiting" v-model.number="forms.voice.values.outgoing.waitingMinutes" type="number" min="1" max="1440" :class="input" /><span class="text-[13px] text-muted">min</span></span>
                      </FormField>
                      <label class="flex items-center gap-2.5 text-[14.5px] sm:col-span-6"><input v-model="forms.voice.values.outgoing.quietWeekend" type="checkbox" role="switch" class="switch" />Mai nel fine settimana</label>
                    </div>
                    <details class="mt-1 border-t border-line pt-2.5">
                      <summary class="cursor-pointer text-[14px] text-muted">Avanzate</summary>
                      <div class="mt-3" :class="grid">
                        <FormField id="voice-port" label="Porta" :span="1">
                          <input id="voice-port" v-model.number="forms.voice.values.port" type="number" min="1024" max="65535" :class="input" />
                        </FormField>
                        <p class="self-end pb-1.5 text-[13px] text-muted sm:col-span-5">
                          Il numero con cui la chat trova il servizio della voce sul Mac. Cambialo solo se un altro programma usa già {{ base?.voice.values.port ?? forms.voice.values.port }}: il servizio della voce si riavvia appena non c’è una chiamata in corso.
                        </p>
                      </div>
                    </details>
                  </SettingsCard>
                </template>
                <p v-else class="rounded-[10px] border border-dashed border-line-strong p-3.5 text-[14px] text-muted">
                  <b class="font-semibold text-ink">Le chiamate sono spente.</b> Accendile in alto per scegliere voce, durata e orari: il servizio della voce parte appena salvi.
                </p>
              </template>

              <!-- Notifiche (I-1): kinds and quiet hours in the file; this browser below, with the keys for the chat closed (D-192) -->
              <template v-if="active === 'notifications'">
                <SettingsCard id="notifications" title="Cosa ti avvisa" :busy="locked">
                  <div class="flex flex-col">
                    <label class="flex items-center gap-2.5 py-2 text-[14.5px] first:pt-0">
                      <input v-model="forms.notifications.replies" type="checkbox" role="switch" class="switch" /><span>Risposte nelle chat<small class="block text-[13px] text-muted">«Arianna ha risposto»</small></span>
                    </label>
                    <label class="flex items-center gap-2.5 border-t border-line py-2 text-[14.5px]">
                      <input v-model="forms.notifications.approvals" type="checkbox" role="switch" class="switch" /><span>Approvazioni in attesa<small class="block text-[13px] text-muted">«Arianna aspetta una tua decisione»</small></span>
                    </label>
                    <label class="flex items-center gap-2.5 border-t border-line py-2 text-[14.5px]">
                      <input v-model="forms.notifications.failures" type="checkbox" role="switch" class="switch" /><span>Lavori falliti<small class="block text-[13px] text-muted">«Un lavoro è fallito»</small></span>
                    </label>
                  </div>
                  <div class="border-t border-line pt-3" :class="grid">
                    <label class="flex items-center gap-2.5 self-end pb-1.5 text-[14.5px] sm:col-span-2"><input v-model="forms.notifications.quiet" type="checkbox" role="switch" class="switch" />Ore di silenzio</label>
                    <FormField id="notifications-from" label="dalle" :span="1">
                      <input id="notifications-from" v-model="forms.notifications.quietFrom" type="time" :class="input" :disabled="!forms.notifications.quiet" />
                    </FormField>
                    <FormField id="notifications-to" label="alle" :span="1">
                      <input id="notifications-to" v-model="forms.notifications.quietTo" type="time" :class="input" :disabled="!forms.notifications.quiet" />
                    </FormField>
                    <p class="self-end pb-1.5 text-[13px] text-muted sm:col-span-2">
                      Può passare la mezzanotte. Le chiamate hanno i loro orari, in
                      <a href="/impostazioni/voce" class="text-accent hover:underline" @click.prevent="openSection('voce')">Voce e chiamate</a>.
                    </p>
                  </div>
                </SettingsCard>
                <NotificationDevice>
                  <details class="mt-1 border-t border-line pt-2.5">
                    <summary class="cursor-pointer text-[14px] text-muted">Avanzate: chiave per le notifiche a chat chiusa</summary>
                    <div class="mt-3 flex flex-col gap-3">
                      <p class="text-[13px] text-muted">
                        Serve una coppia di chiavi creata una volta sola: chiedi a Claude Code di prepararla. Qui va la parte pubblica; quella segreta resta nella cassaforte delle password e
                        non compare mai.
                      </p>
                      <template v-if="base?.voice.enabled">
                        <fieldset :disabled="locked" class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
                          <label class="flex items-center gap-2.5 text-[14.5px]"><input v-model="forms.voice.push" type="checkbox" role="switch" class="switch" />Notifiche anche a chat chiusa</label>
                          <div v-if="forms.voice.push" :class="grid">
                            <FormField id="push-key" label="Chiave pubblica" :span="4">
                              <input id="push-key" v-model.trim="forms.voice.publicKey" :class="input" class="font-mono text-[12.5px]" placeholder="BMx3…" spellcheck="false" autocomplete="off" />
                            </FormField>
                            <FormField id="push-subject" label="Email di contatto" :span="2" hint="Con mailto: davanti, o un indirizzo https.">
                              <input id="push-subject" v-model.trim="forms.voice.subject" :class="input" placeholder="mailto:tu@esempio.it" autocomplete="off" />
                            </FormField>
                          </div>
                        </fieldset>
                      </template>
                      <p v-else class="text-[14px] text-muted">
                        La chiave sta con le chiamate: accendile prima in
                        <a href="/impostazioni/voce" class="text-accent hover:underline" @click.prevent="openSection('voce')">Voce e chiamate</a>.
                      </p>
                    </div>
                  </details>
                </NotificationDevice>
              </template>

              <!-- Segretaria (I-12, D-144): the three moments and the days -->
              <SettingsCard v-if="active === 'secretary'" id="secretary" :busy="locked">
                <div :class="[grid, { 'opacity-55': !forms.secretary.enabled }]">
                  <FormField id="secretary-morning" label="Mattina" hint="gli impegni del giorno" :span="1">
                    <input id="secretary-morning" v-model="forms.secretary.morning" type="time" :class="input" />
                  </FormField>
                  <FormField id="secretary-afternoon" label="Dopo pranzo" hint="quelli ancora aperti" :span="1">
                    <input id="secretary-afternoon" v-model="forms.secretary.afternoon" type="time" :class="input" />
                  </FormField>
                  <FormField id="secretary-evening" label="Sera" hint="cosa non è fatto" :span="1">
                    <input id="secretary-evening" v-model="forms.secretary.evening" type="time" :class="input" />
                  </FormField>
                  <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0 sm:col-span-6">
                    <legend class="mb-1 text-[13px] font-medium text-muted">Giorni</legend>
                    <div class="flex flex-wrap gap-1.5">
                      <label
                        v-for="day in WEEKDAYS"
                        :key="day"
                        class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[14px]"
                        :class="forms.secretary.days.includes(day) ? 'border-accent bg-accent/10 text-ink' : 'border-line-strong text-muted'"
                      >
                        <input v-model="forms.secretary.days" type="checkbox" :value="day" class="accent-[var(--accent)]" />{{ WEEKDAY_TEXT[day].toLowerCase() }}
                      </label>
                    </div>
                  </fieldset>
                </div>
                <p class="text-[13px] text-muted">
                  Se il Mac era spento, il promemoria perso arriva all’accensione. Il testo degli impegni resta sul Mac: non va al cloud né nelle notifiche.
                </p>
              </SettingsCard>

              <!-- Progetti: the folders Claude and Codex may work in, with how reserved each is -->
              <SettingsCard v-if="active === 'projects'" id="projects" :busy="locked">
                <ul v-if="forms.projects.length > 0" class="flex flex-col">
                  <li v-for="(project, index) in forms.projects" :key="project.name" class="flex flex-wrap items-center gap-3 border-t border-line py-2.5 first:border-t-0 first:pt-0">
                    <span class="min-w-[160px] flex-1">
                      <b class="font-semibold">{{ project.name }}</b>
                      <span class="block truncate font-mono text-[12.5px] text-muted" :title="project.path">{{ project.path }}</span>
                    </span>
                    <select v-model="project.label" class="field w-[150px] px-2 py-1.5 text-[14px]" :aria-label="`Riservatezza di ${project.name}`">
                      <option value="L0">Pubblico</option>
                      <option value="L1">Interno</option>
                    </select>
                    <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="forms.projects.splice(index, 1)">Togli</button>
                  </li>
                </ul>
                <p v-else class="rounded-[10px] border border-dashed border-line-strong p-3.5 text-[14px] text-muted">
                  <b class="font-semibold text-ink">Nessun progetto.</b> Aggiungine uno qui sotto, per esempio la cartella del sito di un cliente: Claude e Codex lavorano solo nelle cartelle
                  elencate qui.
                </p>
                <form class="border-t border-line pt-3" @submit.prevent="addProject">
                  <h3 class="mb-2 text-[14.5px] font-semibold">Aggiungi un progetto</h3>
                  <div :class="grid">
                    <FormField id="project-name" label="Nome" :span="2">
                      <input id="project-name" v-model="newProject.name" :class="input" placeholder="sito-verdi" />
                    </FormField>
                    <FormField id="project-path" label="Cartella" :span="2">
                      <input id="project-path" v-model="newProject.path" :class="input" class="font-mono text-[12.5px]" placeholder="repos/sito-verdi" spellcheck="false" />
                    </FormField>
                    <FormField id="project-label" label="Riservatezza" :span="1">
                      <select id="project-label" v-model="newProject.label" :class="input">
                        <option value="L1">Interno</option>
                        <option value="L0">Pubblico</option>
                      </select>
                    </FormField>
                    <div class="flex items-end sm:col-span-1">
                      <button type="submit" class="btn w-full px-3 py-1.5 text-[14px]" :disabled="!projectAddable">Aggiungi</button>
                    </div>
                  </div>
                </form>
              </SettingsCard>

              <!-- Regole dei progetti (I-14, D-174): the common template; each project's own in the page Progetti -->
              <SettingsCard v-if="active === 'project-rules'" id="project-rules" :busy="locked">
                <FormField id="project-rules-text" label="Regole per tutti i progetti" :hint="`${rulesCount}${rulesOwn.length > 0 ? ` Valgono per tutti tranne ${rulesOwn.join(', ')}, che ${rulesOwn.length === 1 ? 'ha regole sue' : 'hanno regole loro'}.` : ''}`">
                  <textarea
                    id="project-rules-text"
                    v-model="forms.projectRules.template"
                    rows="9"
                    :maxlength="MAX_PROJECT_RULES"
                    :class="input"
                    class="resize-y leading-relaxed"
                    placeholder="Commenti in inglese.&#10;Niente firme o commenti tipo «generato da».&#10;Nomi e formattazione come il codice che c’è già."
                  />
                </FormField>
                <p class="text-[13px] text-warn">Questo testo va a Claude e Codex: niente nomi di clienti, importi o password (Arianna rifiuta il salvataggio se ne trova).</p>
                <p class="text-[13px] text-muted">Qualunque cosa dicano le regole, gli agenti non salvano mai una versione nel progetto (commit): le modifiche restano da rivedere a te.</p>
              </SettingsCard>

              <!-- Claude e Codex: the cloud helpers, and what stays on the Mac (D-192, it took the place of Etichette) -->
              <template v-if="active === 'executors'">
                <div class="grid grid-cols-1 gap-3.5 @3xl:grid-cols-2">
                  <SettingsCard v-for="executor in CLOUD_EXECUTORS" :id="`executor-${executor}`" :key="executor" :busy="locked">
                    <div class="flex flex-wrap items-center gap-2.5">
                      <label class="flex items-center gap-2.5 text-[16px] font-semibold">
                        <input v-model="forms.executors" type="checkbox" role="switch" class="switch" :value="executor" />{{ EXECUTOR_CARD[executor]?.title ?? executor }}
                      </label>
                      <span class="ml-auto text-[14px] text-muted">{{ EXECUTOR_CARD[executor]?.plan }}</span>
                    </div>
                    <p class="text-[14px]">{{ executorReceives(forms.executors.includes(executor), base?.projects ?? []) }}</p>
                    <p v-if="executor === 'claude'" class="text-[13px] text-muted">
                      I modelli di Claude si accendono e si scelgono in
                      <a href="/impostazioni/modelli" class="text-accent hover:underline" @click.prevent="openSection('modelli')">Modelli</a>.
                    </p>
                    <p v-else-if="!forms.executors.includes(executor)" class="text-[13px] text-muted">Spento: nessun lavoro va a {{ EXECUTOR_CARD[executor]?.company }}.</p>
                  </SettingsCard>
                </div>
                <p class="text-[13px] text-muted">Un lavoro già partito finisce con i valori di prima.</p>
                <SettingsCard id="keep-on-mac" title="Cosa resta sempre sul Mac" description="Ogni dato ha un grado di riservatezza. Solo Pubblico e Interno possono uscire, e solo verso Claude o Codex accesi.">
                  <template #header>sola lettura</template>
                  <table class="w-full border-collapse text-[14px]">
                    <thead>
                      <tr class="text-left text-[13px] text-muted">
                        <th class="border-b border-line-strong py-1.5 pr-2 font-semibold">Dati</th>
                        <th class="border-b border-line-strong px-2 py-1.5 font-semibold">Riservatezza</th>
                        <th class="hidden border-b border-line-strong py-1.5 pl-2 font-semibold sm:table-cell">Cosa vuol dire</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in KEEP_ON_MAC" :key="row.data" class="align-top">
                        <td class="border-b border-line py-2 pr-2">{{ row.data }}<span class="mt-0.5 block text-[13px] text-muted sm:hidden">{{ row.meaning }}</span></td>
                        <td class="border-b border-line px-2 py-2"><span class="pill" :class="GRADE_CLASS[row.label]">{{ labelWord(row.label) }}</span></td>
                        <td class="hidden border-b border-line py-2 pl-2 text-muted sm:table-cell">{{ row.meaning }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-if="view.labels === null" role="alert" class="text-[14px] text-danger">Il file delle regole di riservatezza non si legge: finché non torna, tutto vale Privato e non esce.</p>
                  <p class="text-[13px] text-muted">Queste regole si cambiano solo a mano, con Claude Code, perché decidono cosa esce dal Mac.</p>
                </SettingsCard>
              </template>

              <!-- Link da riassumere (D-154): the sites whose links Arianna downloads by itself -->
              <SettingsCard v-if="active === 'links'" id="links" :busy="locked">
                <div v-if="forms.fetchSites.length > 0" class="flex flex-wrap gap-1.5">
                  <span v-for="(site, index) in forms.fetchSites" :key="site" class="inline-flex items-center gap-1 rounded-full border border-line-strong py-0.5 pr-1.5 pl-3 text-[14px]">
                    {{ site }}
                    <button type="button" class="rounded-full p-0.5 text-muted hover:text-danger" :aria-label="`Togli ${site}`" @click="forms.fetchSites.splice(index, 1)"><Icon name="close" :size="13" /></button>
                  </span>
                </div>
                <p v-else class="rounded-[10px] border border-dashed border-line-strong p-3.5 text-[14px] text-muted">
                  <b class="font-semibold text-ink">Nessun sito.</b> Aggiungi per esempio x.com: i link che salvi da lì verranno riassunti da soli.
                </p>
                <form :class="grid" @submit.prevent="addSite">
                  <FormField id="site-new" label="Aggiungi un sito" :span="2">
                    <input id="site-new" v-model="newSite" :class="input" placeholder="per esempio youtube.com" autocomplete="off" />
                  </FormField>
                  <div class="flex items-end sm:col-span-1">
                    <button type="submit" class="btn w-full px-3 py-1.5 text-[14px]" :disabled="fetchSiteOf(newSite) === undefined">Aggiungi</button>
                  </div>
                </form>
                <p class="text-[13px] text-muted">Vale anche per i sottodomini (mobile.x.com). I link degli altri siti restano link: nel pensiero c’è «Scarica e riassumi».</p>
              </SettingsCard>

              <!-- Telegram: off by the user's choice (D-110, question 12), not in the settings index, so unreachable; kept to turn back on -->
              <SettingsCard v-if="active === 'telegram'" id="telegram" title="Telegram" :busy="locked">
                <template #header>
                  <label class="flex items-center gap-2">
                    {{ forms.telegram.enabled ? 'acceso' : 'spento' }}
                    <input v-model="forms.telegram.enabled" type="checkbox" role="switch" class="switch" aria-label="Telegram acceso" />
                  </label>
                </template>
                <template v-if="forms.telegram.enabled">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span v-for="(chat, index) in forms.telegram.chats" :key="chat" class="inline-flex items-center gap-1 rounded-full border border-line-strong py-0.5 pr-1.5 pl-3 text-[14px]">
                      {{ chat }}
                      <button type="button" class="text-muted hover:text-danger" :aria-label="`Togli la chat ${chat}`" @click="forms.telegram.chats.splice(index, 1)"><Icon name="close" :size="13" /></button>
                    </span>
                    <form class="flex items-center gap-1.5" @submit.prevent="addChat">
                      <input v-model="newChat" class="field w-40 px-2 py-1 text-[14px]" placeholder="id della chat" aria-label="Id della chat da aggiungere" inputmode="numeric" />
                      <button type="submit" class="btn px-2.5 py-1 text-[13px]" :disabled="chatId(newChat) === undefined">Aggiungi</button>
                    </form>
                  </div>
                  <p class="text-[13px] text-muted">Il bot risponde solo a queste chat, al massimo con dati Interni. Il token del bot sta nella cassaforte delle password e non compare qui.</p>
                </template>
                <p v-else class="text-[14px] text-muted">Il bot di Telegram è spento.</p>
              </SettingsCard>
            </template>

            <!-- Server dei modelli: state and log even with an invalid file. -->
            <template v-if="active === 'servers'">
              <section v-for="server in local" :key="server.id" class="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5" :aria-label="serverName(server.id)">
                <div class="flex flex-wrap items-center gap-2.5">
                  <span class="size-[9px] rounded-full" :class="LED_CLASS[serverStatus(server).tone]" aria-hidden="true" />
                  <b class="font-semibold">{{ serverName(server.id) }}</b>
                  <span class="pill" :class="PILL_CLASS[serverStatus(server).tone]">{{ serverStatus(server).text }}</span>
                  <span class="text-[13px] text-muted">{{ serverStatus(server).who }}</span>
                  <span class="flex-1" />
                  <button
                    v-if="restartBlocker(server) === undefined"
                    type="button"
                    class="btn px-2.5 py-1 text-[13px]"
                    :class="{ 'btn-primary': serverDown(server) !== undefined }"
                    :disabled="restarting === server.id || server.state === 'restarting' || server.state === 'starting'"
                    @click="restart(server.id)"
                  >
                    <Icon name="retry" :size="14" />{{ restarting === server.id ? 'Riavvio…' : 'Riavvia' }}
                  </button>
                </div>
                <p v-if="restartBlocker(server) !== undefined" class="text-[13px] text-muted">{{ restartBlocker(server) }}</p>
                <div v-if="serverDown(server) !== undefined" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
                  <span class="min-w-[220px] flex-1">{{ serverDown(server) }}</span>
                  <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="showLog(server.id)">Vedi il registro</button>
                </div>
                <p v-if="restartError[server.id]" role="alert" class="text-[13px] text-danger">Non riavviato: {{ restartError[server.id] }}</p>
                <details :open="logOpen[server.id] === true" @toggle="toggleLog(server.id, $event)">
                  <summary class="cursor-pointer text-[13px] text-muted">Ultime righe del registro (possono contenere testi privati: restano qui)</summary>
                  <div class="mt-2 flex flex-col gap-1.5">
                    <pre :id="`log-${server.id}`" class="max-h-[200px] overflow-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap text-muted">{{ logs[server.id] ?? 'Leggo…' }}</pre>
                    <button type="button" class="btn self-start px-2.5 py-1 text-[13px]" @click="readLog(server.id)"><Icon name="retry" :size="14" />Rileggi</button>
                  </div>
                </details>
              </section>
              <p v-if="local.length === 0" class="rounded-[10px] border border-dashed border-line-strong p-3.5 text-[14px] text-muted">
                <b class="font-semibold text-ink">Nessun server dei modelli in uso.</b> Aggiungine uno in Avanzate, per esempio oMLX, con il suo indirizzo e il comando che lo avvia.
              </p>

              <details v-if="forms !== null" class="rounded-xl border border-line bg-surface-2 p-4">
                <summary class="cursor-pointer text-[14px] text-muted">Avanzate: indirizzo e comando di avvio</summary>
                <fieldset :disabled="locked" class="m-0 mt-3 flex min-w-0 flex-col gap-3 border-0 p-0">
                  <div v-for="(endpoint, index) in forms.endpoints" :key="index" class="border-t border-line pt-3 first:border-t-0 first:pt-0" :class="grid">
                    <FormField :id="`endpoint-id-${index}`" label="Nome" :span="1">
                      <input :id="`endpoint-id-${index}`" v-model="endpoint.id" :class="input" placeholder="omlx" spellcheck="false" />
                    </FormField>
                    <FormField :id="`endpoint-url-${index}`" label="Indirizzo" :span="4">
                      <input :id="`endpoint-url-${index}`" v-model="endpoint.url" :class="input" class="font-mono text-[12.5px]" placeholder="http://127.0.0.1:7001/v1" spellcheck="false" />
                    </FormField>
                    <div class="flex items-end sm:col-span-1">
                      <button type="button" class="btn w-full px-2.5 py-1.5 text-[13px]" @click="forms.endpoints.splice(index, 1)">Togli</button>
                    </div>
                    <FormField :id="`endpoint-command-${index}`" label="Comando di avvio" :span="6" hint="Un pezzo per riga. Vuoto: Arianna lo controlla ma non lo avvia. Non scriverci password: è mostrato qui.">
                      <textarea :id="`endpoint-command-${index}`" v-model="endpoint.command" rows="3" :class="input" class="resize-y font-mono text-[12.5px]" spellcheck="false" />
                    </FormField>
                  </div>
                  <button type="button" class="btn self-start px-2.5 py-1 text-[13px]" @click="addEndpoint"><Icon name="new" :size="14" />Aggiungi un server</button>
                  <p class="text-[13px] text-muted">Cambiare indirizzo o comando riavvia quel server.</p>
                </fieldset>
              </details>
            </template>
          </template>

          <!-- The one save bar of the section: only with edits; amber with «Rivedi cosa esce…» where data may leave the Mac -->
          <SettingsSaveBar
            v-if="bar !== null"
            :dirty="bar.dirty"
            :count="bar.count"
            :privacy="bar.privacy"
            :busy="bar.busy"
            :saved="bar.saved"
            :error="bar.error"
            :invalid="bar.invalid"
            @save="bar.save()"
            @cancel="bar.cancel()"
          />
        </template>
      </div>
    </div>

    <PrivacyConfirm v-if="proposal !== null" :proposal="proposal.value" :busy="busy !== null" :spent="confirmSpent" :error="confirmError" @confirm="confirm" @close="proposal = null" />
  </div>
</template>

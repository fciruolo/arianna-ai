<script setup lang="ts">
/**
 * Impostazioni → Agenti (D-133): the agents as small cards on the left
 * (Ufficiali, I miei, search and filters), the chosen one on the right in
 * tabs: Personalità, Aspetto, Modello, Permessi and, for the user's agents,
 * Scheda e prompt. One bar "Modifiche non salvate" saves look, persona and
 * model of every agent (one write of the settings) and the texts of the
 * user's agents. Immediate, as before: Attivo/Spento, the permissions (after
 * the confirmation of what changes), promotion, deletion.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { listSkills, sheetUrl, type UploadedCharacter } from '../lib/api.ts';
import { dayText } from '../lib/design-catalog.ts';
import { agentEntries, catalogStateText, changedAgents, diffRows, filterEntries, lengthText, needsUpdate, permissionWords, tabLabel, tabsOf, unsavedNames, type AgentEntry, type AgentFilter, type AgentParts, type AgentTab } from '../lib/agents-page.ts';
import { agentName } from '../lib/italian.ts';
import { MODEL_TEXT } from '../lib/labels.ts';
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
  TONE_EXAMPLE,
  TONE_TEXT,
  TONES,
} from '../lib/persona.ts';
import { leaveAfterProblem, MAX_LEAVE_AFTER, modelBlocker, type CloudModelAlias, type SettingsView } from '../lib/settings.ts';
import { useSkillTranslations } from '../lib/skill-translations.ts';
import { activationAsk, redoSafetyReport, safetyDot, safetyPill, type SafetyView } from '../lib/safety-report.ts';
import { filterSkills, skillLicenseText, skillRefusalText, skillsErrorText, translationsNoteText, withoutSkill, withSkill, type SkillSummary } from '../lib/skills-catalog.ts';
import type { CharacterChoice, CharacterListing, DirectAgent } from '../lib/types.ts';
import {
  activateUserAgent,
  deactivateUserAgent,
  deleteUserAgent,
  demoteUserAgent,
  editUserAgent,
  listUserAgents,
  loadSources,
  loadUserAgentPrompt,
  MAX_USER_PROMPT,
  permissionLines,
  prepareReapply,
  prepareUserAgentEdit,
  promoteUserAgent,
  reapplyAgent,
  UserAgentApiError,
  userAgentErrorText,
  workText,
  type AgentProposal,
  type ReapplyProposal,
  type UserAgentEdit,
  type UserAgentListing,
  type UserAgentSources,
  type UserAgentView,
  type UserPermissions,
} from '../lib/user-agents.ts';
import CharacterGenerate from './CharacterGenerate.vue';
import CharacterUpload from './CharacterUpload.vue';
import FormField from './FormField.vue';
import Icon from './Icon.vue';
import PermissionConfirm from './PermissionConfirm.vue';
import PermissionsPicker from './PermissionsPicker.vue';
import PixelAgent from './PixelAgent.vue';
import SafetyReportCard from './SafetyReportCard.vue';
import SettingsSaveBar from './SettingsSaveBar.vue';
import SheetPreview from './SheetPreview.vue';

/**
 * `form`/`base`: look, persona and model of every agent, edited and as read (the settings page owns them).
 * `save`: writes them in one go; false when the core refused, the reason in `error`.
 */
const props = defineProps<{
  form: AgentParts & { participants: number };
  base: AgentParts & { participants: number };
  view: SettingsView;
  characters: CharacterListing | null;
  sheetVersion: number;
  busy: boolean;
  error: string | undefined;
  invalid: string | undefined;
  directAgents: DirectAgent[];
  save: () => Promise<boolean>;
}>();
/**
 * `cancel`: the settings parts back to what was read. `changed`: an agent changed state or card, the rest reads again.
 * `chat`: "Apri una chat" with the agent. `dirty`: texts of the user's agents not saved.
 */
const emit = defineEmits<{
  cancel: [];
  uploaded: [agent: string, saved: UploadedCharacter];
  changed: [];
  newAgent: [];
  section: [slug: string];
  chat: [agent: string];
  dirty: [dirty: boolean];
}>();

// The agents
const listing = ref<UserAgentListing | null>(null);
const loadError = ref('');
const sources = ref<UserAgentSources | null>(null);

async function load(): Promise<void> {
  try {
    listing.value = await listUserAgents();
    loadError.value = '';
  } catch (cause) {
    loadError.value = userAgentErrorText(cause);
  }
}
onMounted(async () => {
  await load();
  try {
    sources.value = await loadSources();
  } catch {
    // Without the list the permissions are shown, not changed.
  }
});

/** The agents the settings name: one the core does not list keeps its card. */
const known = computed(() => [...new Set([...Object.keys(props.characters?.agents ?? {}), ...Object.keys(props.base.characters), ...Object.keys(props.view.agentModels)])]);
const entries = computed(() => agentEntries(listing.value, known.value));
// Every agent gets a persona form; the defaults are no change.
watch(
  [entries, () => props.form.personas],
  () => {
    for (const entry of entries.value) if (!Object.hasOwn(props.form.personas, entry.id)) props.form.personas[entry.id] = { ...DEFAULT_PERSONA_FORM };
  },
  { immediate: true },
);

/** The name on the card: the one chosen in Personalità, else the usual one. */
function nameOf(id: string): string {
  const chosen = props.form.personas[id]?.displayName.trim() ?? '';
  return chosen === '' || FIXED_NAMES.includes(id) ? agentName(id) : chosen;
}

const query = ref('');
const filter = ref<AgentFilter>('all');
// «Tieni la versione di adesso» (D-079, tappa 4): remembered in this browser only, per agent and newer role.
const KEPT_KEY = 'arianna.agents.kept-versions';
function readKept(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(KEPT_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
const keptVersions = ref<Record<string, string>>(readKept());
const isKept = (agent: string, sha256: string): boolean => keptVersions.value[agent] === sha256;
function keepVersion(agent: string, sha256: string): void {
  keptVersions.value = { ...keptVersions.value, [agent]: sha256 };
  try {
    window.localStorage.setItem(KEPT_KEY, JSON.stringify(keptVersions.value));
  } catch {
    // Not remembered: the badge comes back at the next visit.
  }
}
const updates = computed(() => entries.value.filter((entry) => needsUpdate(entry, isKept)).length);
const FILTERS = computed((): { id: AgentFilter; text: string }[] => [
  { id: 'all', text: 'Tutti' },
  { id: 'on', text: 'Attivi' },
  { id: 'off', text: 'Spenti' },
  ...(updates.value > 0 || filter.value === 'update' ? [{ id: 'update' as const, text: `Da aggiornare · ${String(updates.value)}` }] : []),
]);
const visible = computed(() => filterEntries(entries.value, query.value, filter.value, nameOf, isKept));

// Adopting a role again (D-079, tappa 4): the lines that change, then the confirmation; the agent turns off.
const reapplying = ref<{ name: string; proposal: ReapplyProposal; licenseAccepted: boolean } | null>(null);
const reapplyError = ref('');
const reapplyBusy = ref(false);
async function openReapply(name: string): Promise<void> {
  if (reapplyBusy.value) return;
  reapplyBusy.value = true;
  reapplyError.value = '';
  try {
    reapplying.value = { name, proposal: await prepareReapply(name), licenseAccepted: false };
  } catch (cause) {
    reapplyError.value = userAgentErrorText(cause);
  } finally {
    reapplyBusy.value = false;
  }
}
async function confirmReapply(): Promise<void> {
  const shown = reapplying.value;
  if (shown === null || reapplyBusy.value) return;
  reapplyBusy.value = true;
  reapplyError.value = '';
  try {
    await reapplyAgent(shown.name, shown.proposal.confirmation, shown.licenseAccepted);
    reapplying.value = null;
    notice.value = `${nameOf(shown.name)} ha il ruolo nuovo ed è spento: riaccendilo quando hai riletto il testo.`;
    delete texts.value[shown.name];
    await load();
    void loadTexts(shown.name);
    emit('changed');
  } catch (cause) {
    reapplyError.value = userAgentErrorText(cause);
  } finally {
    reapplyBusy.value = false;
  }
}
const groups = computed(() => [
  { id: 'official', title: 'Ufficiali', items: visible.value.filter((entry) => entry.official) },
  { id: 'mine', title: 'I miei', items: visible.value.filter((entry) => !entry.official) },
]);

const selected = ref('arianna');
const current = computed<AgentEntry | undefined>(() => entries.value.find((entry) => entry.id === selected.value) ?? entries.value[0]);
const tab = ref<AgentTab>('persona');
const tabs = computed(() => (current.value === undefined ? [] : tabsOf(current.value)));
/** "Genera personaggio" drawing, or a drawing not kept: agent and tab stay, or the drawing would be lost. */
const generating = ref(false);
const HOLD_TEXT = 'Prima tieni o scarta il personaggio disegnato';
function choose(id: string): void {
  if (generating.value) return;
  selected.value = id;
  if (!tabs.value.includes(tab.value)) tab.value = 'persona';
  editingPermissions.value = null;
  error.value = '';
  notice.value = '';
}
// An agent of the user opened on "Scheda e prompt": its texts are read from the core.
watch([current, tab], () => {
  const entry = current.value;
  if (entry !== undefined && !entry.official && tab.value === 'card') void loadTexts(entry.id);
  if (tab.value === 'skills' && skillCatalog.value === null) void loadSkillCatalog();
});

// Skill (D-161): the skills of the catalog assigned to the agent, saved with the bar in [agents.<id>] skills
const skillCatalog = ref<SkillSummary[] | null>(null);
const skillCatalogError = ref('');
const skillQuery = ref('');
// The Italian descriptions (D-185), as in the Studio: asked when the list is read, the English one meanwhile.
const { status: skillTranslations, text: skillText, open: openSkillTranslations } = useSkillTranslations();
async function loadSkillCatalog(): Promise<void> {
  try {
    skillCatalog.value = (await listSkills()).skills;
    skillCatalogError.value = '';
    void openSkillTranslations();
  } catch (cause) {
    skillCatalogError.value = skillsErrorText(cause);
  }
}
/** The catalog changed (a source added, adopted or removed): read again when the tab is shown. */
function skillsCatalogChanged(): void {
  skillCatalog.value = null;
  if (tab.value === 'skills') void loadSkillCatalog();
}
defineExpose({ skillsCatalogChanged });
const skillsOf = (agent: string): string[] => props.form.skills?.[agent] ?? [];
/** Why the agent takes no skills; undefined when it may (an older core says nothing: no tab content). */
const skillRefusal = (agent: string): string | undefined => (props.view.agentSkills === undefined ? 'Arianna non gestisce ancora le skill: riavviala dopo l’aggiornamento.' : skillRefusalText(props.view.agentSkills[agent]));
const skillOf = (id: string): SkillSummary | undefined => skillCatalog.value?.find((item) => item.id === id);
/** The description of an assigned skill, Italian when it is there; empty when the skill is not in the catalog. */
const assignedText = (id: string): string => {
  const found = skillOf(id);
  return found === undefined ? '' : skillText(found);
};
const skillChoices = computed(() => {
  const agent = current.value?.id;
  if (agent === undefined) return [];
  const taken = skillsOf(agent);
  return filterSkills(skillCatalog.value ?? [], skillQuery.value, skillTranslations.value?.translations).filter((item) => !taken.includes(item.id)).slice(0, 40);
});
function assignSkill(agent: string, id: string): void {
  if (props.form.skills === undefined) return;
  props.form.skills[agent] = withSkill(skillsOf(agent), id);
}
function unassignSkill(agent: string, id: string): void {
  if (props.form.skills === undefined) return;
  props.form.skills[agent] = withoutSkill(skillsOf(agent), id);
}

// Look (D-118, D-123, D-132)
const characterOptions = computed(() =>
  (props.characters?.packs ?? []).flatMap((pack) => pack.characters.map((character) => ({ value: `${pack.id}/${character.id}`, pack, character }))),
);
/** The character without a choice, as the core picks it: the original of the same name, otherwise the Coder's. */
function defaultOption(agent: string) {
  const originals = characterOptions.value.filter((option) => option.pack.original);
  return originals.find((option) => option.character.id === agent) ?? originals.find((option) => option.character.id === 'coder');
}
function previewOf(agent: string): CharacterChoice | undefined {
  const value = props.form.characters[agent] ?? '';
  const option = value === '' ? defaultOption(agent) : characterOptions.value.find((item) => item.value === value);
  if (option !== undefined) return { pack: option.pack.id, character: option.character.id, rows: option.character.rows };
  return value === '' ? props.characters?.agents[agent] : undefined;
}
const animationsOpen = ref(false);
const POSES = [
  { pose: 'idle', text: 'fermo' },
  { pose: 'thinking', text: 'pensa' },
  { pose: 'working', text: 'lavora' },
] as const;

// Model
function modelsOf(agent: string): CloudModelAlias[] {
  return props.view.agentModels[agent] ?? [];
}
function blockerOf(model: CloudModelAlias): string | undefined {
  const values = props.view.values;
  return values === null ? undefined : modelBlocker(model, values);
}
/** The model in a few words, for the head of the detail. */
function modelText(entry: AgentEntry): string {
  if (entry.id === 'arianna') return props.view.values?.roles.orchestrator ?? 'nessuno';
  const chosen = props.form.agents[entry.id] ?? '';
  if (chosen !== '') return MODEL_TEXT[chosen] ?? chosen;
  return modelsOf(entry.id).length > 0 ? 'automatico' : 'solo locali';
}

// Texts of the user's agents: changed here, saved by the bar.
interface Texts {
  description: string;
  prompt: string;
  savedDescription: string;
  savedPrompt: string;
}
const texts = ref<Record<string, Texts | null>>({});
async function loadTexts(name: string): Promise<void> {
  if (texts.value[name] !== undefined) return;
  texts.value[name] = null;
  try {
    const prompt = (await loadUserAgentPrompt(name)).trimEnd();
    const description = listing.value?.user.find((agent) => agent.name === name)?.description ?? '';
    texts.value[name] = { description, prompt, savedDescription: description, savedPrompt: prompt };
  } catch (cause) {
    delete texts.value[name];
    error.value = userAgentErrorText(cause);
  }
}
const changedTexts = computed(() =>
  Object.entries(texts.value)
    .filter((pair): pair is [string, Texts] => pair[1] !== null && (pair[1].description.trim() !== pair[1].savedDescription || pair[1].prompt !== pair[1].savedPrompt))
    .map(([name]) => name),
);
watch(changedTexts, (names) => emit('dirty', names.length > 0), { immediate: true });
// Another section: the texts not saved are gone with the page.
onBeforeUnmount(() => {
  emit('dirty', false);
  window.clearTimeout(savedTimer);
});
const textsInvalid = computed(() => {
  for (const name of changedTexts.value) {
    const draft = texts.value[name];
    if (draft && (draft.description.trim() === '' || draft.prompt.trim() === '')) return `${name}: descrizione e prompt non possono restare vuoti`;
  }
  return undefined;
});

// The bar
const changedSettings = computed(() => changedAgents(props.form, props.base));
const dirtyIds = computed(() => new Set([...changedSettings.value, ...changedTexts.value]));
// When an idle agent leaves a conversation (I-8, D-130): one number for every agent, saved with the rest.
const leaveChanged = computed(() => props.form.participants !== props.base.participants);
const dirty = computed(() => dirtyIds.value.size > 0 || leaveChanged.value);
const unsaved = computed(() =>
  unsavedNames([...[...dirtyIds.value].map(nameOf).sort((a, b) => a.localeCompare(b)), ...(leaveChanged.value ? ['uscita degli agenti'] : [])]),
);
const working = ref(false);
const saveError = ref('');
const saved = ref(false);
let savedTimer: number | undefined;
watch(dirty, (now) => {
  if (now) saved.value = false;
});
const blocked = computed(() => (changedSettings.value.length > 0 || leaveChanged.value ? props.invalid : undefined) ?? textsInvalid.value);

async function saveAll(): Promise<void> {
  if (working.value || props.busy || blocked.value !== undefined) return;
  working.value = true;
  saveError.value = '';
  try {
    if (changedSettings.value.length > 0 || leaveChanged.value) {
      if (!(await props.save())) return;
      // Skills changed on an agent of the catalog make its safety report again (D-196): shown at once as running.
      void load();
    }
    for (const name of changedTexts.value) {
      const draft = texts.value[name];
      if (!draft) continue;
      // The prompt of a role of the catalog is never sent back: it stays the third party's text as written.
      const agency = listing.value?.user.find((agent) => agent.name === name)?.origin === 'agency';
      const edit: UserAgentEdit = agency ? { description: draft.description.trim() } : { description: draft.description.trim(), prompt: draft.prompt };
      const proposal = await prepareUserAgentEdit(name, edit);
      // A text that changes what the card allows (its label): the window of the permissions saves it.
      if (proposal.confirmation !== null) {
        notice.value = `Il resto fino a qui è salvato; i testi di ${name} aspettano la tua conferma. Se restano altre modifiche, dopo premi di nuovo Salva.`;
        confirming.value = { name, edit, proposal };
        return;
      }
      await editUserAgent(name, edit, null);
      textsSaved(name, edit);
    }
    saved.value = true;
    window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => {
      saved.value = false;
    }, 4000);
  } catch (cause) {
    saveError.value = userAgentErrorText(cause);
  } finally {
    working.value = false;
  }
}
function textsSaved(name: string, edit: UserAgentEdit): void {
  const draft = texts.value[name];
  // A role of the catalog sends no prompt: the one saved stays.
  if (draft && edit.description !== undefined) texts.value[name] = { ...draft, savedDescription: edit.description, savedPrompt: edit.prompt ?? draft.savedPrompt };
  void load();
  emit('changed');
}
function undo(): void {
  emit('cancel');
  for (const [name, draft] of Object.entries(texts.value)) if (draft) texts.value[name] = { ...draft, description: draft.savedDescription, prompt: draft.savedPrompt };
  saveError.value = '';
}

// Immediate actions on the user's agents (D-119)
const busyName = ref('');
const error = ref('');
const notice = ref('');
const promoting = ref<UserAgentView | null>(null);
const demoting = ref<UserAgentView | null>(null);
/** The agent to delete; `typed` must be its name. */
const deleting = ref<{ name: string; typed: string } | null>(null);
const editingPermissions = ref<{ name: string; permissions: UserPermissions } | null>(null);
/** A change shown before it is saved: permissions, or texts that change the card's label. */
const confirming = ref<{ name: string; edit: UserAgentEdit; proposal: AgentProposal } | null>(null);

async function run(name: string, action: () => Promise<unknown>): Promise<boolean> {
  busyName.value = name;
  error.value = '';
  notice.value = '';
  try {
    await action();
    await load();
    emit('changed');
    return true;
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    return false;
  } finally {
    busyName.value = '';
  }
}
/**
 * Attivo/Spento at once; a refusal puts the switch back where the agent is.
 * An agent of the catalog whose safety report is not «nessun problema» asks
 * one more confirmation first (D-196): never a block.
 */
async function toggle(entry: AgentEntry, event: Event): Promise<void> {
  const box = event.target as HTMLInputElement;
  if (!entry.on && activationAsk(safetyOf(entry)) !== undefined) {
    box.checked = false;
    askActivation(entry.id);
    return;
  }
  if (!(await run(entry.id, () => (entry.on ? deactivateUserAgent(entry.id) : activateUserAgent(entry.id))))) box.checked = entry.on;
}

// The safety report of Opus (D-196): above «Accendi», read again while one is running.
const activating = ref<{ name: string; ask: NonNullable<ReturnType<typeof activationAsk>> } | null>(null);
function askActivation(name: string): void {
  const ask = activationAsk(safetyOf(entries.value.find((entry) => entry.id === name)));
  error.value = '';
  if (ask === undefined) void turnOn(name);
  else activating.value = { name, ask };
}
async function turnOn(name: string): Promise<void> {
  if (await run(name, () => activateUserAgent(name))) activating.value = null;
}
const redoing = ref('');
async function redoReport(name: string): Promise<void> {
  if (redoing.value !== '') return;
  redoing.value = name;
  error.value = '';
  try {
    await redoSafetyReport({ agent: name });
    await load();
  } catch {
    error.value = 'Il rapporto non è ripartito: riprova fra poco.';
  } finally {
    redoing.value = '';
  }
}
function safetyOf(entry: AgentEntry | undefined): SafetyView | undefined {
  return entry?.official === false ? entry.view?.safety : undefined;
}
const reportRunning = computed(() => entries.value.some((entry) => safetyOf(entry)?.state === 'running'));
let reportTimer: number | undefined;
watch(
  reportRunning,
  (running) => {
    window.clearInterval(reportTimer);
    if (running) reportTimer = window.setInterval(() => void load(), 4000);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  window.clearInterval(reportTimer);
});
async function promote(): Promise<void> {
  const agent = promoting.value;
  if (agent === null || !(await run(agent.name, () => promoteUserAgent(agent.name)))) return;
  promoting.value = null;
  // Official now: no "Scheda e prompt", and its texts are the card's.
  delete texts.value[agent.name];
  if (selected.value === agent.name) tab.value = 'persona';
}
async function demote(): Promise<void> {
  const agent = demoting.value;
  if (agent !== null && (await run(agent.name, () => demoteUserAgent(agent.name)))) demoting.value = null;
}
async function remove(): Promise<void> {
  const target = deleting.value;
  if (target === null || target.typed !== target.name) return;
  let folder = '';
  const ok = await run(target.name, async () => {
    folder = (await deleteUserAgent(target.name, target.typed)).folder;
  });
  if (ok) {
    deleting.value = null;
    delete texts.value[target.name];
    if (selected.value === target.name) selected.value = 'arianna';
    notice.value = `Eliminato: i due file sono in ${folder}, da cui si recuperano a mano.`;
  }
}

function startPermissions(agent: UserAgentView): void {
  if (agent.permissions !== null) editingPermissions.value = { name: agent.name, permissions: { ...agent.permissions, tools: [...agent.permissions.tools] } };
}
/** The permissions alone: what changes is shown first, then saved on the user's click (D-119, tappa T3b). */
async function reviewPermissions(): Promise<void> {
  const draft = editingPermissions.value;
  if (draft === null || busyName.value !== '') return;
  const edit: UserAgentEdit = { permissions: draft.permissions };
  busyName.value = draft.name;
  error.value = '';
  try {
    const proposal = await prepareUserAgentEdit(draft.name, edit);
    busyName.value = '';
    if (proposal.confirmation === null) await saveEdit(draft.name, edit, null);
    else confirming.value = { name: draft.name, edit, proposal };
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    busyName.value = '';
  }
}
/** Writes an edit; returns the error of the core, or null when it is saved. */
async function saveEdit(name: string, edit: UserAgentEdit, confirmation: string | null): Promise<unknown> {
  busyName.value = name;
  error.value = '';
  notice.value = '';
  try {
    await editUserAgent(name, edit, confirmation);
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    busyName.value = '';
    return cause;
  }
  confirming.value = null;
  if (edit.permissions !== undefined) {
    editingPermissions.value = null;
    notice.value = `Salvato: ${name} usa i permessi nuovi dal prossimo lavoro.`;
  }
  busyName.value = '';
  textsSaved(name, edit);
  return null;
}
async function confirmEdit(): Promise<void> {
  const shown = confirming.value;
  if (shown === null || busyName.value !== '') return;
  const failure = await saveEdit(shown.name, shown.edit, shown.proposal.confirmation);
  if (failure === null) return;
  // Any other error: the window closes, the error stays on the page.
  if (!(failure instanceof UserAgentApiError && failure.status === 409 && /prepare the change again/.test(failure.message))) {
    confirming.value = null;
    return;
  }
  // Expired or changed meanwhile: shown again with a new confirmation (the old id is spent).
  busyName.value = shown.name;
  try {
    confirming.value = { ...shown, proposal: await prepareUserAgentEdit(shown.name, shown.edit) };
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    confirming.value = null;
  } finally {
    busyName.value = '';
  }
}

/** One line of what a card allows, split at its first colon: the subject in bold. */
function splitLine(line: string): [string, string] {
  const at = line.indexOf(': ');
  return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 2)];
}
/** The safety report of the agent shown (D-196). */
const safety = computed(() => safetyOf(current.value));
const PILL_TONE: Record<'ok' | 'warn' | 'plain', string> = { ok: 'border-ok/60 bg-ok/10 text-ok', warn: 'border-warn/60 bg-warn/10 text-warn', plain: '' };
const canChat = computed(() => current.value !== undefined && current.value.on && props.directAgents.some((agent) => agent.agent === current.value?.id));
/** The text of the save bar: who holds edits not saved. */
const barLabel = computed(() => `Modifiche non salvate a ${unsaved.value}`);
const barError = computed(() => saveError.value || props.error || undefined);
/** A plain card of the settings (D-192). */
const CARD = 'flex flex-col gap-3.5 rounded-xl border border-line bg-surface-2 p-4';
const INPUT = 'field w-full px-2.5 py-1.5 text-[14px] text-ink disabled:opacity-60';
</script>

<template>
  <div class="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
    <!-- The list -->
    <aside class="flex flex-col gap-2.5 @3xl:sticky @3xl:top-0" aria-label="Elenco degli agenti">
      <div class="flex items-center gap-2">
        <input v-model="query" type="search" class="field min-w-0 flex-1 px-2.5 py-1.5 text-[14px]" placeholder="Cerca un agente" aria-label="Cerca un agente" />
        <a href="/impostazioni/agenti/nuovo" class="btn btn-primary shrink-0 px-3 py-1.5 text-[14px]" @click.prevent="emit('newAgent')">+ Nuovo agente</a>
      </div>
      <div class="flex gap-1.5" role="group" aria-label="Filtra">
        <button
          v-for="item in FILTERS"
          :key="item.id"
          type="button"
          class="rounded-full border px-2.5 py-0.5 text-[13px]"
          :class="filter === item.id ? 'border-accent bg-accent/10 text-ink' : 'border-line-strong text-muted hover:text-ink'"
          :aria-pressed="filter === item.id"
          @click="filter = item.id"
        >
          {{ item.text }}
        </button>
      </div>
      <p v-if="loadError" class="flex flex-wrap items-center gap-2 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2 text-[14px]" role="alert">
        <span class="min-w-0 flex-1">{{ loadError }}</span>
        <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="load">Riprova</button>
      </p>
      <template v-for="group in groups" :key="group.id">
        <template v-if="group.items.length > 0 || group.id === 'mine'">
          <p class="mt-1 text-[14px] font-semibold">{{ group.title }}</p>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="entry in group.items"
              :key="entry.id"
              type="button"
              class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 rounded-xl border bg-surface-2 px-2.5 py-2 text-left transition-[border-color]"
              :class="[entry.id === current?.id ? 'border-accent shadow-[0_0_0_3px_var(--glow)]' : 'border-line hover:border-line-strong', { 'opacity-60': !entry.on }]"
              :aria-current="entry.id === current?.id ? 'true' : undefined"
              :disabled="generating && entry.id !== current?.id"
              :title="generating && entry.id !== current?.id ? HOLD_TEXT : undefined"
              @click="choose(entry.id)"
            >
              <span class="row-span-2"><PixelAgent :choice="previewOf(entry.id)" pose="idle" :scale="1" :version="sheetVersion" /></span>
              <span class="truncate text-[14.5px] font-semibold">
                {{ nameOf(entry.id) }}<span v-if="dirtyIds.has(entry.id)" class="text-warn" title="Modifiche non salvate" aria-label="modifiche non salvate"> •</span><span v-if="needsUpdate(entry, isKept)" class="text-warn" title="Aggiornamento disponibile del ruolo" aria-label="aggiornamento disponibile"> ●</span><span v-if="safetyDot(safetyOf(entry))" class="text-warn" title="Rapporto di sicurezza: da guardare" aria-label="rapporto di sicurezza da guardare"> ●</span>
              </span>
              <span class="truncate text-[13px] text-muted">{{ entry.on ? '' : 'spento · ' }}{{ entry.where === 'cloud' ? 'con Claude' : 'sul Mac' }}</span>
            </button>
            <a
              v-if="group.id === 'mine'"
              href="/impostazioni/agenti/nuovo"
              class="grid min-h-[56px] place-items-center rounded-xl border border-dashed border-line-strong text-[14px] font-semibold text-muted hover:border-accent hover:text-accent"
              @click.prevent="emit('newAgent')"
            >+ Nuovo agente</a>
          </div>
          <p v-if="group.id === 'mine' && group.items.length === 0 && query === '' && filter === 'all'" class="text-[13px] text-muted">
            Non hai ancora agenti tuoi: con «+ Nuovo agente» ne crei uno, per esempio un revisore che rilegge i testi prima che li mandi.
          </p>
        </template>
      </template>
      <p v-if="visible.length === 0 && entries.length > 0" class="text-[13px] text-muted">Nessun agente con questa ricerca: cambia il testo o scegli «Tutti».</p>
      <!-- Cards that could not be read: never loaded; a disabled one can be deleted -->
      <div v-for="item in listing?.refused ?? []" :key="`${item.state}-${item.name}`" class="flex flex-wrap items-center gap-2 rounded-[10px] border border-danger/50 px-2.5 py-2 text-[13px]">
        <span class="min-w-0 flex-1">
          <b class="font-semibold">{{ item.name }}</b> ({{ item.state === 'active' ? 'attivo' : 'spento' }}) non si legge, e Arianna non lo usa: <span class="text-muted">{{ item.reason }}</span>
        </span>
        <button v-if="item.state === 'disabled'" type="button" class="btn btn-danger px-2 py-0.5 text-[13px]" :disabled="busyName !== ''" @click="deleting = { name: item.name, typed: '' }; error = ''">Elimina…</button>
      </div>
      <!-- For every agent: when one that entered a conversation leaves by itself (I-8, D-130) -->
      <div class="flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2 p-3">
        <p class="text-[14.5px] font-semibold">Per tutti gli agenti</p>
        <label for="leave-after" class="flex flex-wrap items-center gap-1.5 text-[13.5px]">
          Esce da una conversazione dopo
          <input id="leave-after" v-model.number="form.participants" type="number" min="0" :max="MAX_LEAVE_AFTER" step="1" class="field w-16 px-2 py-1 text-[14px]" />
          tuoi messaggi senza lavoro per lui
        </label>
        <p class="text-[13px] text-muted">Saluta e rientra quando gli serve un lavoro. 0 = resta sempre. Il Coder non esce da solo: lo togli tu.</p>
        <p v-if="leaveAfterProblem(form.participants) !== undefined" class="text-[13px] text-warn">{{ leaveAfterProblem(form.participants) }}</p>
      </div>
    </aside>

    <!-- The detail -->
    <div v-if="current !== undefined" class="flex min-w-0 flex-col gap-3.5" aria-live="polite">
      <section class="grid grid-cols-1 items-center gap-4 rounded-xl border border-line bg-surface-2 p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div class="grid h-[120px] w-[104px] place-items-end justify-center rounded-xl border border-line bg-surface pb-2">
          <PixelAgent :choice="previewOf(current.id)" pose="idle" :scale="3" :version="sheetVersion" />
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="pill">{{ current.official ? 'Ufficiale' : 'Mio' }}</span>
            <span class="pill" :class="current.where === 'cloud' ? 'border-info/50 text-info' : 'border-ok/50 text-ok'">{{ current.where === 'cloud' ? 'Lavora con Claude (cloud)' : 'Lavora sul Mac' }}</span>
            <template v-if="current.view">
              <span class="pill">{{ permissionWords(current.view.card).sees }}</span>
              <span class="pill">{{ permissionWords(current.view.card).can }}</span>
              <span v-if="current.view.catalog" class="pill">Dal catalogo</span>
              <span v-if="safety" class="pill" :class="PILL_TONE[safetyPill(safety).tone]">{{ safetyPill(safety).text }}</span>
              <span v-if="needsUpdate(current, isKept)" class="pill border-warn/60 bg-warn/10 text-warn">● Aggiornamento disponibile</span>
              <span v-else-if="catalogStateText(current.view.catalog?.state)" class="pill">{{ catalogStateText(current.view.catalog?.state)?.badge }}</span>
            </template>
            <label class="ml-auto flex items-center gap-2 text-[14px]" :title="current.official ? (current.id === 'arianna' ? 'Arianna è sempre attiva' : 'Gli agenti ufficiali sono sempre attivi') : undefined">
              {{ current.on ? 'Attivo' : 'Spento' }}
              <input type="checkbox" role="switch" class="switch" :checked="current.on" :disabled="current.official || busyName !== ''" :aria-label="`${nameOf(current.id)} attivo`" @change="toggle(current, $event)" />
            </label>
          </div>
          <h2 class="text-[22px] leading-tight font-semibold">{{ nameOf(current.id) }}</h2>
          <p v-if="current.description" class="max-w-[60ch] text-[14.5px] text-muted">{{ current.description }}</p>
          <div class="flex flex-wrap items-center gap-2 text-[13.5px] text-muted">
            <span>Modello: <span :class="current.id === 'arianna' ? 'font-mono text-[12.5px]' : ''">{{ modelText(current) }}</span></span>
            <button v-if="canChat" type="button" class="btn px-2.5 py-1 text-[13px]" @click="emit('chat', current.id)">Apri una chat</button>
          </div>
          <p v-if="!current.official && current.view" class="text-[13px]" :class="current.view.works === null ? 'text-warn' : 'text-muted'">
            {{ current.on ? 'Da attivo' : 'Quando è attivo' }} {{ workText(current.view.works) }}.
          </p>
        </div>
      </section>

      <!-- The role of this agent changed in its source (D-079, tappa 4): kept as it is until the user adopts it again -->
      <section v-if="current.view?.catalog && needsUpdate(current, isKept)" class="flex flex-col gap-2.5 rounded-xl border border-warn/60 bg-surface-2 p-4">
        <h3 class="text-[16px] font-semibold">Il ruolo è cambiato nella sua raccolta</h3>
        <p class="text-[14px] text-muted">
          La raccolta {{ current.view.catalog.id.split('/').slice(0, 2).join('/') }} ha una versione nuova di questo ruolo<template v-if="current.view.catalog.latest?.committedAt">
            (versione del {{ dayText(current.view.catalog.latest.committedAt) }})</template
          >. L’agente lavora ancora con il testo di prima e continua così finché non lo riadotti; nome, personaggio, permessi e modello non cambiano.
        </p>
        <p v-if="reapplyError && !reapplying" class="text-[13px] text-danger" role="alert">{{ reapplyError }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn px-3 py-1.5 text-[14px]" @click="keepVersion(current.id, current.view.catalog.latest?.sha256 ?? '')">Tieni la versione di adesso</button>
          <button type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="reapplyBusy" @click="openReapply(current.id)">Riadotta…</button>
        </div>
        <p class="text-[12.5px] text-muted">«Tieni la versione di adesso» nasconde l’avviso in questo browser fino alla prossima versione del ruolo.</p>
      </section>
      <section v-else-if="current.view?.catalog && catalogStateText(current.view.catalog.state)" class="flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2 p-4 text-[14px]">
        <h3 class="text-[16px] font-semibold">{{ catalogStateText(current.view.catalog.state)?.title }}</h3>
        <p class="text-muted">{{ catalogStateText(current.view.catalog.state)?.text }}</p>
      </section>
      <!-- The safety report (D-196), above «Accendi»: the reports of its role and skills together; turning on stays the user's choice -->
      <SafetyReportCard
        v-if="safety"
        :safety="safety"
        :gate="{ on: current.on, maxLabel: current.view?.card.maxLabel ?? 'L0', busy: busyName !== '' }"
        lines
        :redoing="redoing !== ''"
        @activate="askActivation(current.id)"
        @redo="redoReport(current.id)"
        @lines="tab = 'card'"
      />
      <p v-if="error && !promoting && !demoting && !deleting && !confirming && !activating" class="text-[13px] text-danger" role="alert">{{ error }}</p>
      <p v-if="notice" class="text-[13px] text-ok" role="status">{{ notice }}</p>

      <div class="flex gap-1 overflow-x-auto border-b border-line" role="tablist" aria-label="Sezioni dell’agente">
        <button
          v-for="item in tabs"
          :key="item"
          type="button"
          role="tab"
          class="-mb-px border-b-2 px-3 py-2 text-[14px] whitespace-nowrap"
          :class="tab === item ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'"
          :aria-selected="tab === item"
          :disabled="generating && tab !== item"
          :title="generating && tab !== item ? HOLD_TEXT : undefined"
          @click="tab = item"
        >
          {{ tabLabel(item, skillsOf(current.id).length) }}
        </button>
      </div>

      <fieldset :disabled="busy || working" class="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
        <!-- Personalità (D-107) -->
        <section v-if="tab === 'persona' && form.personas[current.id]" :class="CARD" role="tabpanel">
          <div class="grid gap-3 sm:grid-cols-6">
            <div class="grid content-start gap-1 sm:col-span-6">
              <span class="text-[13px] font-medium text-muted">Tono</span>
              <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tono">
                <label
                  v-for="tone in TONES"
                  :key="tone"
                  class="cursor-pointer rounded-full border px-3 py-1 text-[14px] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
                  :class="form.personas[current.id]?.tone === tone ? 'border-accent bg-accent/10 text-ink' : 'border-line-strong text-muted hover:text-ink'"
                >
                  <input v-model="form.personas[current.id]!.tone" type="radio" :name="`tone-${current.id}`" :value="tone" class="sr-only" />{{ TONE_TEXT[tone] }}
                </label>
              </div>
              <p class="text-[12.5px] text-muted">Così risponde: <span class="text-ink italic">«{{ TONE_EXAMPLE[form.personas[current.id]!.tone] }}»</span></p>
            </div>
            <FormField :id="`address-${current.id}`" label="Ti dà del" :span="1">
              <select :id="`address-${current.id}`" v-model="form.personas[current.id]!.address" :class="INPUT">
                <option v-for="address in ADDRESSES" :key="address" :value="address">{{ address }}</option>
              </select>
            </FormField>
            <FormField :id="`display-${current.id}`" label="Nome in chat" :hint="FIXED_NAMES.includes(current.id) ? 'Questo nome non si cambia.' : 'Anche nell’ufficio.'" :span="2">
              <input
                :id="`display-${current.id}`"
                v-model="form.personas[current.id]!.displayName"
                :maxlength="MAX_DISPLAY_NAME"
                :disabled="FIXED_NAMES.includes(current.id)"
                :placeholder="agentName(current.id)"
                :class="INPUT"
              />
            </FormField>
            <div class="hidden sm:col-span-3 sm:block" />
            <FormField
              :id="`spec-${current.id}`"
              label="Specializzazione"
              :problem="countCharacters(form.personas[current.id]!.specialization) > MAX_TEXT ? `Troppo lungo: ${lengthText(countCharacters(form.personas[current.id]!.specialization), MAX_TEXT)}.` : undefined"
              :hint="`Si aggiunge al suo ruolo. ${lengthText(countCharacters(form.personas[current.id]!.specialization), MAX_TEXT)}.`"
              :span="6"
            >
              <textarea :id="`spec-${current.id}`" v-model="form.personas[current.id]!.specialization" rows="2" :class="INPUT" placeholder="Per esempio: sviluppatore senior TypeScript, attento ai test e alla leggibilità." />
            </FormField>
            <FormField
              :id="`traits-${current.id}`"
              label="Come parla"
              :problem="countCharacters(form.personas[current.id]!.traits) > MAX_TEXT ? `Troppo lungo: ${lengthText(countCharacters(form.personas[current.id]!.traits), MAX_TEXT)}.` : undefined"
              :hint="`${lengthText(countCharacters(form.personas[current.id]!.traits), MAX_TEXT)}.`"
              :span="6"
            >
              <textarea :id="`traits-${current.id}`" v-model="form.personas[current.id]!.traits" rows="2" :class="INPUT" placeholder="Per esempio: precisa e calma, frasi brevi." />
            </FormField>
          </div>
          <p class="flex items-start gap-2 text-[13px] text-warn"><Icon name="gateway" :size="14" class="mt-0.5 shrink-0" />{{ PERSONA_NOTICE }}</p>
          <p class="text-[12.5px] text-muted">{{ PERSONA_WHERE }} {{ costText(personaCost(form.personas[current.id]!)) }}</p>
        </section>

        <!-- Aspetto (D-118, D-123, D-132) -->
        <section v-if="tab === 'look'" :class="CARD" role="tabpanel">
          <div class="grid grid-cols-1 gap-4 md:grid-cols-[auto_minmax(0,1fr)]">
            <div class="flex flex-wrap gap-2.5">
              <div v-for="item in POSES" :key="item.pose" class="flex flex-col items-center gap-1 rounded-[10px] border border-line px-2.5 pt-2 pb-1.5 text-[12.5px] text-muted">
                <PixelAgent :choice="previewOf(current.id)" :pose="item.pose" :scale="2" :version="sheetVersion" />{{ item.text }}
              </div>
            </div>
            <div class="flex min-w-0 flex-col gap-2.5">
              <CharacterGenerate
                v-if="current.view"
                :key="current.id"
                :agent-label="nameOf(current.id)"
                :name="current.id"
                :description="current.description"
                prompt=""
                keep="premi Salva nella barra in basso per tenerlo"
                :fetch-prompt="current.official ? undefined : () => loadUserAgentPrompt(current!.id)"
                @busy="generating = $event"
                @uploaded="(item) => emit('uploaded', current!.id, item)"
              />
              <CharacterUpload :key="`upload-${current.id}`" :agent-label="nameOf(current.id)" keep="premi Salva nella barra in basso per tenerlo" @uploaded="(item) => emit('uploaded', current!.id, item)" />
              <div v-if="previewOf(current.id) || form.characters[current.id] !== undefined" class="flex flex-wrap gap-2">
                <button v-if="previewOf(current.id)" type="button" class="btn px-2.5 py-1 text-[13px]" :aria-expanded="animationsOpen" @click="animationsOpen = !animationsOpen">
                  {{ animationsOpen ? 'Chiudi le animazioni' : 'Tutte le animazioni' }}
                </button>
                <a v-if="previewOf(current.id)" class="btn px-2.5 py-1 text-[13px]" :href="sheetUrl(previewOf(current.id)!, sheetVersion)" :download="`${previewOf(current.id)!.character}.png`">Scarica PNG</a>
                <button v-if="form.characters[current.id] !== undefined" type="button" class="btn px-2.5 py-1 text-[13px]" @click="delete form.characters[current.id]">Torna al predefinito</button>
              </div>
            </div>
          </div>
          <SheetPreview v-if="animationsOpen && previewOf(current.id)" :src="sheetUrl(previewOf(current.id)!, sheetVersion)" :rows="previewOf(current.id)!.rows" />
          <p class="text-[12.5px] text-muted">Un personaggio caricato o disegnato qui resta sul Mac, fra i tuoi, e si può dare anche ad altri agenti.</p>
        </section>

        <!-- Modello -->
        <section v-if="tab === 'model'" :class="CARD" role="tabpanel">
          <template v-if="current.id === 'arianna'">
            <p class="flex flex-wrap items-center gap-2 text-[14px]">Modello: <span class="font-mono text-[12.5px]">{{ view.values?.roles.orchestrator ?? 'nessuno' }}</span><span class="pill border-ok/50 text-ok">sul Mac</span></p>
            <p class="text-[13px] text-muted">
              Si cambia in
              <a href="/impostazioni/modelli" class="text-accent hover:underline" @click.prevent="emit('section', 'modelli')">Modelli</a>, alla voce «Ragiona e risponde in chat»: Arianna usa solo modelli sul Mac.
            </p>
          </template>
          <div v-else-if="form.agents[current.id] !== undefined && modelsOf(current.id).length > 0" class="grid gap-3 sm:grid-cols-6">
            <FormField
              :id="`model-${current.id}`"
              label="Modello delle conversazioni nuove"
              hint="Nella chat lo cambi per una sola conversazione. Un modello spento si può scegliere, ma vale solo quando è acceso."
              :span="3"
            >
              <select :id="`model-${current.id}`" v-model="form.agents[current.id]" :class="INPUT">
                <option value="">automatico (sceglie Arianna)</option>
                <option v-for="model in modelsOf(current.id)" :key="model" :value="model">{{ MODEL_TEXT[model] ?? model }}{{ blockerOf(model) === undefined ? '' : ` (${blockerOf(model)})` }}</option>
                <!-- A model of the file the card no longer allows stays visible: it is kept, and ignored. -->
                <option v-if="form.agents[current.id] !== '' && !modelsOf(current.id).includes(form.agents[current.id] as CloudModelAlias)" :value="form.agents[current.id]">
                  {{ MODEL_TEXT[form.agents[current.id] ?? ''] ?? form.agents[current.id] }} (non consentito per questo agente)
                </option>
              </select>
            </FormField>
          </div>
          <template v-else>
            <p class="text-[14px]">{{ current.where === 'cloud' ? 'Il modello lo sceglie Arianna a ogni lavoro.' : 'Lavora solo con i modelli sul Mac: lo sceglie Arianna.' }}</p>
            <p class="text-[13px] text-muted">{{ current.where === 'cloud' ? 'Questo agente non ha modelli cloud fra cui scegliere.' : 'Questo agente non può usare Claude né Codex.' }}</p>
          </template>
        </section>

        <!-- Skill (D-161): third-party text the agent reads in its delegations and local cards, as data -->
        <section v-if="tab === 'skills'" :class="CARD" role="tabpanel">
          <p v-if="skillRefusal(current.id)" class="text-[14px] text-muted">{{ skillRefusal(current.id) }}</p>
          <template v-else>
            <p class="text-[13px] text-muted">
              Le skill assegnate arrivano a questo agente insieme al suo prompt, come testo da consultare: mai come istruzioni per Arianna, mai nelle chiamate. Si tengono con «Salva» nella barra in basso.
              <a href="/impostazioni/skill-e-stili" class="text-accent hover:underline" @click.prevent="emit('section', 'skill-e-stili')">Gestisci le raccolte in Skill e stili</a>.
            </p>
            <p v-if="skillsOf(current.id).length === 0" class="text-[14px] text-muted">Nessuna skill assegnata: scegline una dall’elenco qui sotto.</p>
            <ul v-else class="m-0 flex list-none flex-col gap-1.5 p-0">
              <li v-for="id in skillsOf(current.id)" :key="id" class="flex items-start gap-2 rounded-[10px] border border-line px-3 py-2 text-[14px]">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate font-medium">{{ skillOf(id)?.name ?? id }}</span>
                  <span v-if="skillCatalog !== null && skillOf(id) === undefined" class="text-[13px] text-warn">Non è più fra le skill scaricate: non arriva all’agente finché non torna.</span>
                  <template v-else-if="skillOf(id)">
                    <span v-if="assignedText(id)" class="text-[13px] text-muted">{{ assignedText(id) }}</span>
                    <span class="text-[12.5px] text-muted">{{ skillLicenseText(skillOf(id)?.license ?? null) }}</span>
                  </template>
                </span>
                <button type="button" class="btn shrink-0 px-2 py-0.5 text-[13px]" :aria-label="`Togli ${skillOf(id)?.name ?? id}`" @click="unassignSkill(current.id, id)">Togli</button>
              </li>
            </ul>
            <div class="flex flex-col gap-1.5">
              <input v-model="skillQuery" type="search" class="field px-2.5 py-1.5 text-[14px]" placeholder="Cerca una skill da assegnare" aria-label="Cerca una skill da assegnare" />
              <p v-if="skillCatalogError" class="flex flex-wrap items-center gap-2 text-[13px] text-danger" role="alert">
                <span class="min-w-0 flex-1">{{ skillCatalogError }}</span>
                <button type="button" class="btn px-2.5 py-0.5 text-[13px]" @click="loadSkillCatalog">Riprova</button>
              </p>
              <p v-else-if="skillCatalog === null" class="text-[13px] text-muted">Leggo le skill…</p>
              <p v-else-if="skillCatalog.length === 0" class="text-[13px] text-muted">
                Nessuna skill scaricata:
                <a href="/impostazioni/skill-e-stili" class="text-accent hover:underline" @click.prevent="emit('section', 'skill-e-stili')">segui una raccolta in Skill e stili</a>, poi torna qui.
              </p>
              <p v-else-if="skillChoices.length === 0" class="text-[13px] text-muted">Nessuna skill con questa ricerca.</p>
              <ul v-else class="m-0 flex max-h-[300px] list-none flex-col overflow-auto rounded-[10px] border border-line p-0">
                <li v-for="item in skillChoices" :key="item.id" class="flex items-start gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0">
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-[14px] font-medium">{{ item.name }}</span>
                    <span v-if="skillText(item)" class="text-[13px] text-muted">{{ skillText(item) }}</span>
                    <span class="text-[12.5px] text-muted">{{ skillLicenseText(item.license) }}</span>
                  </span>
                  <button type="button" class="btn shrink-0 px-2 py-0.5 text-[13px]" :aria-label="`Assegna ${item.name}`" @click="assignSkill(current.id, item.id)">Assegna</button>
                </li>
              </ul>
              <p v-if="skillCatalog !== null && skillCatalog.length > 0 && translationsNoteText(skillTranslations)" class="text-[12.5px] text-muted">{{ translationsNoteText(skillTranslations) }}</p>
            </div>
          </template>
        </section>
      </fieldset>

      <!-- Permessi: changed only after the confirmation of what changes, never by the bar -->
      <section v-if="tab === 'permissions'" :class="CARD" role="tabpanel">
        <ul v-if="current.view" class="m-0 grid list-none gap-2 p-0">
          <li v-for="line in permissionLines(current.view.card)" :key="line" class="rounded-[10px] border border-line px-3 py-2 text-[14px]">
            <b class="font-semibold">{{ splitLine(line)[0] }}</b><span v-if="splitLine(line)[1]" class="block text-[13px] text-muted">{{ splitLine(line)[1] }}</span>
          </li>
        </ul>
        <p v-else class="text-[13px] text-muted">Arianna non ha caricato la scheda di questo agente: riavviala, e se resta così chiedi a Claude Code di controllarla.</p>
        <template v-if="current.official">
          <p class="text-[13px] text-muted">I permessi di un agente ufficiale si cambiano a mano, con Claude Code.</p>
          <div v-if="current.view?.fromPage" class="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <span>Creato da questa pagina e poi promosso.</span>
            <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busyName !== ''" @click="demoting = current.view!; error = ''">Riporta fra i miei…</button>
          </div>
        </template>
        <template v-else-if="current.view">
          <p class="rounded-[10px] border border-warn/40 bg-warn/7 px-3 py-2.5 text-[13.5px]">
            Finché resta fra i tuoi agenti vede al massimo <b>dati di lavoro</b> e modifica file solo <b>in una copia protetta</b>, qualunque cosa dica la scheda.
          </p>
          <div v-if="editingPermissions?.name === current.id && sources" class="flex flex-col gap-2.5 rounded-[10px] border border-line p-3">
            <PermissionsPicker v-model="editingPermissions.permissions" :sources="sources" :id-prefix="`edit-${current.id}`" />
            <div class="flex justify-end gap-2">
              <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="editingPermissions = null; error = ''">Annulla</button>
              <button type="button" class="btn btn-warn px-2.5 py-1 text-[13px]" :disabled="busyName !== ''" @click="reviewPermissions">Rivedi e salva…</button>
            </div>
          </div>
          <div v-else-if="sources && current.view.permissions" class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busyName !== ''" @click="startPermissions(current.view)">Modifica permessi…</button>
            <span class="text-[13px] text-muted">Prima di salvare ti mostra cosa cambia.</span>
          </div>
          <p v-else-if="current.view.permissions === null" class="text-[13px] text-muted">La scheda è stata cambiata a mano oltre quello che questa pagina permette: si cambia solo a mano, con Claude Code.</p>
        </template>
      </section>

      <!-- Scheda e prompt: the user's agents only -->
      <template v-if="tab === 'card' && !current.official">
        <section :class="CARD" role="tabpanel">
          <p v-if="!texts[current.id]" class="text-[13px] text-muted">Leggo il prompt…</p>
          <fieldset v-else :disabled="working" class="m-0 grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-6">
            <FormField :id="`desc-${current.id}`" label="Descrizione" hint="Una riga: Arianna la legge per scegliere a chi passare un lavoro." :span="6">
              <input :id="`desc-${current.id}`" v-model="texts[current.id]!.description" :class="INPUT" maxlength="200" />
            </FormField>
            <!-- A role of the catalog (D-079): its text is a third party's, with provenance and license; it changes only by adopting the role again -->
            <div v-if="current.view?.origin === 'agency'" class="flex flex-col gap-1.5 sm:col-span-6">
              <p class="text-[14px] font-medium">Prompt</p>
              <p class="rounded-[8px] border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[13px]">
                Testo di terzi preso dal catalogo agenti, con la sua provenienza e la sua licenza: qui si legge e basta. Arianna lo dà all’agente fra due marcatori, come dato.
              </p>
              <pre class="max-h-[320px] overflow-auto rounded border border-line bg-surface px-2.5 py-2 font-mono text-[12.5px] leading-[1.45] whitespace-pre-wrap">{{ texts[current.id]!.prompt }}</pre>
            </div>
            <FormField v-else :id="`prompt-${current.id}`" label="Prompt" :hint="`Le istruzioni dell’agente. ${lengthText(texts[current.id]!.prompt.length, MAX_USER_PROMPT)}.`" :span="6">
              <textarea :id="`prompt-${current.id}`" v-model="texts[current.id]!.prompt" rows="8" :class="INPUT" :maxlength="MAX_USER_PROMPT" />
            </FormField>
            <p class="text-[13px] text-muted sm:col-span-6">
              {{ current.on ? 'L’agente è attivo: i testi nuovi valgono dal prossimo lavoro che Arianna gli passa.' : 'Valgono da quando lo attivi.' }} Contano come dati di lavoro e possono arrivare a
              Claude: non scriverci dati personali.
            </p>
          </fieldset>
        </section>
        <section v-if="current.view" class="flex flex-col gap-3 rounded-xl border border-danger/40 bg-surface-2 p-4">
          <div class="flex flex-wrap items-center gap-3">
            <span class="min-w-0 flex-1 text-[14px] font-medium">Promuovi a ufficiale<small class="block text-[13px] font-normal text-muted">entra fra gli agenti del repository; cade il limite a dati di lavoro e copia protetta</small></span>
            <button
              type="button"
              class="btn btn-warn px-2.5 py-1 text-[13px]"
              :disabled="busyName !== '' || changedTexts.includes(current.id)"
              :title="changedTexts.includes(current.id) ? 'Prima salva o annulla descrizione e prompt' : undefined"
              @click="promoting = current.view!; error = ''"
            >Promuovi…</button>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <span class="min-w-0 flex-1 text-[14px] font-medium">Elimina<small class="block text-[13px] font-normal text-muted">solo da spento; i file si recuperano a mano</small></span>
            <button type="button" class="btn btn-danger px-2.5 py-1 text-[13px]" :disabled="busyName !== '' || current.on" :title="current.on ? 'Prima spegnilo' : undefined" @click="deleting = { name: current.id, typed: '' }; error = ''">Elimina…</button>
          </div>
        </section>
      </template>
    </div>
    <p v-else-if="!loadError" class="text-[14px] text-muted">Leggo gli agenti…</p>

    <!-- One bar for look, persona, model and texts (D-192): only with edits, saving or an error -->
    <div class="@3xl:col-span-2">
      <SettingsSaveBar
        :dirty="dirty"
        :label="barLabel"
        :busy="working || busy"
        :saved="saved"
        :error="barError"
        :invalid="dirty ? blocked : undefined"
        @cancel="undo"
        @save="saveAll"
      />
    </div>

    <!-- Adopting a role again (D-079, tappa 4): the lines that change, then the user's click; the agent turns off -->
    <div v-if="reapplying" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="reapply-title">
      <div class="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-auto rounded-xl border border-line-strong bg-surface-2 p-4">
        <h2 id="reapply-title" class="text-[16px] font-semibold">Riadottare il ruolo di {{ nameOf(reapplying.name) }}?</h2>
        <p class="text-[14px]">
          Il testo del ruolo diventa quello della versione in uso della raccolta<template v-if="reapplying.proposal.to.committedAt"> (del {{ dayText(reapplying.proposal.to.committedAt) }})</template>:
          <span class="text-ok">+{{ reapplying.proposal.diff.added }}</span> <span class="text-danger">−{{ reapplying.proposal.diff.removed }}</span> righe.
        </p>
        <div class="max-h-[300px] overflow-auto rounded-[8px] border border-line bg-surface font-mono text-[12.5px] leading-[1.55]" aria-label="Righe che cambiano">
          <div
            v-for="(row, index) in diffRows(reapplying.proposal.diff.hunks)"
            :key="index"
            class="px-2.5 whitespace-pre-wrap"
            :class="row.kind === 'added' ? 'bg-ok/12' : row.kind === 'removed' ? 'bg-danger/10 line-through decoration-danger/50' : 'text-muted'"
          >
            <span v-if="row.kind === 'added'" class="sr-only">aggiunta: </span><span v-else-if="row.kind === 'removed'" class="sr-only">tolta: </span>{{ row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '− ' : '  ' }}{{ row.text }}
          </div>
        </div>
        <ul class="list-disc pl-5 text-[14px]">
          <li>Nome, descrizione, personaggio, permessi e modello restano i tuoi.</li>
          <li>Il testo di prima va in <span class="font-mono text-[12.5px]">data/agents/eliminati</span>: lo puoi rileggere.</li>
          <li>
            L’agente {{ reapplying.proposal.active ? 'si spegne' : 'resta spento' }} e resta spento finché non lo riaccendi tu. Opus rilegge le righe cambiate e il rapporto compare sopra
            l’accensione; il testo nuovo si legge anche nella scheda «Scheda e prompt».
          </li>
        </ul>
        <div v-if="reapplying.proposal.unlicensed" class="flex flex-col gap-1.5 rounded-[10px] border border-warn/60 bg-warn/10 p-3 text-[13px]" role="alert">
          <p class="font-semibold">La raccolta ora non ha una licenza alla radice</p>
          <p>Senza licenza i diritti sul testo restano ai suoi autori: usarlo è una scelta tua, e l’avviso resta scritto nella scheda.</p>
          <label class="flex items-start gap-2"><input v-model="reapplying.licenseAccepted" type="checkbox" class="mt-0.5" />Ho letto l’avviso e voglio usare comunque questo testo</label>
        </div>
        <p v-if="reapplyError" class="text-[13px] text-danger" role="alert">{{ reapplyError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="reapplyBusy" @click="reapplying = null; reapplyError = ''">Annulla</button>
          <button
            type="button"
            class="btn btn-primary px-2.5 py-1 text-[13px]"
            :disabled="reapplyBusy || (reapplying.proposal.unlicensed && !reapplying.licenseAccepted)"
            @click="confirmReapply"
          >
            {{ reapplying.proposal.active ? 'Riadotta e spegni' : 'Riadotta' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Turning on an agent of the catalog without «nessun problema» (D-196): one more confirmation, never a block -->
    <div v-if="activating" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="activate-title">
      <div class="flex max-w-lg flex-col gap-3 rounded-xl border border-warn bg-surface-2 p-4">
        <h2 id="activate-title" class="text-[16px] font-semibold">{{ activating.ask.title }}</h2>
        <p class="text-[14px]">{{ activating.ask.text }}</p>
        <p v-if="error" class="text-[13px] text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="activating = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-[13px]" :disabled="busyName !== ''" @click="turnOn(activating.name)">{{ activating.ask.action }}</button>
        </div>
      </div>
    </div>

    <!-- Promotion: what changes, then the user's click -->
    <div v-if="promoting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="promote-title">
      <div class="flex max-w-lg flex-col gap-3 rounded-xl border border-warn bg-surface-2 p-4">
        <h2 id="promote-title" class="text-[16px] font-semibold">Promuovere {{ promoting.name }} a ufficiale?</h2>
        <p class="text-[14px]">L’agente passa fra quelli ufficiali, nella cartella del repository, e diventa attivo. Cosa cambia:</p>
        <ul class="list-disc pl-5 text-[14px]">
          <li>cade il limite a dati di lavoro e copia protetta: vale quello che dice la sua scheda;</li>
          <li>oggi la scheda dice: {{ permissionLines(promoting.card).slice(0, 2).join('; ') }};</li>
          <li>chi modifica a mano la sua scheda può dargli di più, fino ai dati privati;</li>
          <li>i suoi file diventano parte del repository: un commit li rende visibili a chi lo ha, e un push li pubblica.</li>
        </ul>
        <p class="text-[13px] text-muted">Si torna indietro da questa pagina con «Riporta fra i miei», finché la scheda resta quella scritta qui.</p>
        <p v-if="error" class="text-[13px] text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="promoting = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-[13px]" :disabled="busyName !== ''" @click="promote">Promuovi</button>
        </div>
      </div>
    </div>

    <!-- A promotion taken back -->
    <div v-if="demoting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="demote-title">
      <div class="flex max-w-lg flex-col gap-3 rounded-xl border border-line-strong bg-surface-2 p-4">
        <h2 id="demote-title" class="text-[16px] font-semibold">Riportare {{ demoting.name }} fra i tuoi agenti?</h2>
        <ul class="list-disc pl-5 text-[14px]">
          <li>la scheda esce dal repository e torna fra i tuoi agenti, spenta: Arianna non gli passa più lavoro finché non lo riattivi;</li>
          <li>torna il limite a dati di lavoro e copia protetta;</li>
          <li>se i suoi file erano già in un commit, il prossimo commit li registra come tolti.</li>
        </ul>
        <p class="text-[13px] text-muted">Una scheda cambiata a mano oltre i permessi ammessi non può tornare: resta ufficiale.</p>
        <p v-if="error" class="text-[13px] text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="demoting = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-primary px-2.5 py-1 text-[13px]" :disabled="busyName !== ''" @click="demote">Riporta fra i miei</button>
        </div>
      </div>
    </div>

    <!-- A change of permissions (or of texts that change the card's label): what changes, then the user's click -->
    <PermissionConfirm
      v-if="confirming"
      :proposal="confirming.proposal"
      :busy="busyName !== ''"
      :error="error"
      action="Conferma e salva"
      @confirm="confirmEdit"
      @cancel="confirming = null; error = ''"
    />

    <!-- Deletion: the name typed by the user -->
    <div v-if="deleting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <form class="flex max-w-lg flex-col gap-3 rounded-xl border border-danger/60 bg-surface-2 p-4" @submit.prevent="remove">
        <h2 id="delete-title" class="text-[16px] font-semibold">Eliminare {{ deleting.name }}?</h2>
        <p class="text-[14px]">L’agente sparisce dalla pagina e Arianna non lo vede più. Scheda e prompt vanno nel cestino degli agenti, sul Mac: da lì si recuperano solo a mano.</p>
        <label class="flex flex-col gap-1 text-[13px] text-muted">
          Per confermare scrivi il nome dell’agente
          <input v-model.trim="deleting.typed" class="field px-2 py-1.5 text-[14px] text-ink" :placeholder="deleting.name" autocomplete="off" />
        </label>
        <p v-if="error" class="text-[13px] text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="deleting = null; error = ''">Annulla</button>
          <button type="submit" class="btn btn-danger px-2.5 py-1 text-[13px]" :disabled="busyName !== '' || deleting.typed !== deleting.name">Elimina</button>
        </div>
      </form>
    </div>
  </div>
</template>

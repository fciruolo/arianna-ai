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
import { agentEntries, changedAgents, filterEntries, TAB_TEXT, tabsOf, unsavedNames, type AgentEntry, type AgentFilter, type AgentParts, type AgentTab } from '../lib/agents-page.ts';
import { agentName } from '../lib/italian.ts';
import { labelWord, MODEL_TEXT } from '../lib/labels.ts';
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
import { filterSkills, skillLicenseText, skillRefusalText, skillsErrorText, withoutSkill, withSkill, type SkillSummary } from '../lib/skills-catalog.ts';
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
  prepareUserAgentEdit,
  promoteUserAgent,
  UserAgentApiError,
  userAgentErrorText,
  workText,
  type AgentProposal,
  type UserAgentEdit,
  type UserAgentListing,
  type UserAgentSources,
  type UserAgentView,
  type UserPermissions,
} from '../lib/user-agents.ts';
import CharacterGenerate from './CharacterGenerate.vue';
import CharacterUpload from './CharacterUpload.vue';
import Icon from './Icon.vue';
import PermissionConfirm from './PermissionConfirm.vue';
import PermissionsPicker from './PermissionsPicker.vue';
import PixelAgent from './PixelAgent.vue';
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
const FILTERS: { id: AgentFilter; text: string }[] = [
  { id: 'all', text: 'Tutti' },
  { id: 'on', text: 'Attivi' },
  { id: 'off', text: 'Spenti' },
];
const visible = computed(() => filterEntries(entries.value, query.value, filter.value, nameOf));
const groups = computed(() => [
  { id: 'official', title: 'Ufficiali', hint: 'nel repository, in agents/', items: visible.value.filter((entry) => entry.official) },
  { id: 'mine', title: 'I miei', hint: 'in data/agents, fuori da git', items: visible.value.filter((entry) => !entry.official) },
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
async function loadSkillCatalog(): Promise<void> {
  try {
    skillCatalog.value = (await listSkills()).skills;
    skillCatalogError.value = '';
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
const skillRefusal = (agent: string): string | undefined => (props.view.agentSkills === undefined ? 'Il nucleo non gestisce ancora le skill: riavvialo dopo l’aggiornamento.' : skillRefusalText(props.view.agentSkills[agent]));
const skillOf = (id: string): SkillSummary | undefined => skillCatalog.value?.find((item) => item.id === id);
const skillChoices = computed(() => {
  const agent = current.value?.id;
  if (agent === undefined) return [];
  const taken = skillsOf(agent);
  return filterSkills(skillCatalog.value ?? [], skillQuery.value).filter((item) => !taken.includes(item.id)).slice(0, 40);
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
const barError = ref('');
const saved = ref(false);
let savedTimer: number | undefined;
watch(dirty, (now) => {
  if (now) saved.value = false;
});
const blocked = computed(() => (changedSettings.value.length > 0 || leaveChanged.value ? props.invalid : undefined) ?? textsInvalid.value);

async function saveAll(): Promise<void> {
  if (working.value || props.busy || blocked.value !== undefined) return;
  working.value = true;
  barError.value = '';
  try {
    if ((changedSettings.value.length > 0 || leaveChanged.value) && !(await props.save())) return;
    for (const name of changedTexts.value) {
      const draft = texts.value[name];
      if (!draft) continue;
      const edit: UserAgentEdit = { description: draft.description.trim(), prompt: draft.prompt };
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
    barError.value = userAgentErrorText(cause);
  } finally {
    working.value = false;
  }
}
function textsSaved(name: string, edit: UserAgentEdit): void {
  const draft = texts.value[name];
  if (draft && edit.description !== undefined && edit.prompt !== undefined) texts.value[name] = { ...draft, savedDescription: edit.description, savedPrompt: edit.prompt };
  void load();
  emit('changed');
}
function undo(): void {
  emit('cancel');
  for (const [name, draft] of Object.entries(texts.value)) if (draft) texts.value[name] = { ...draft, description: draft.savedDescription, prompt: draft.savedPrompt };
  barError.value = '';
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
/** Attivo/Spento at once; a refusal puts the switch back where the agent is. */
async function toggle(entry: AgentEntry, event: Event): Promise<void> {
  const box = event.target as HTMLInputElement;
  if (!(await run(entry.id, () => (entry.on ? deactivateUserAgent(entry.id) : activateUserAgent(entry.id))))) box.checked = entry.on;
}
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
const canChat = computed(() => current.value !== undefined && current.value.on && props.directAgents.some((agent) => agent.agent === current.value?.id));
</script>

<template>
  <div class="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-[minmax(250px,310px)_minmax(0,1fr)]">
    <!-- The list -->
    <aside class="flex flex-col gap-3 @3xl:sticky @3xl:top-0" aria-label="Elenco degli agenti">
      <div class="flex items-center gap-2">
        <span class="hud-title flex-1">Agenti</span>
        <a href="/impostazioni/agenti/nuovo" class="btn btn-primary px-2.5 py-1 text-xs" @click.prevent="emit('newAgent')">+ Nuovo agente</a>
      </div>
      <input v-model="query" type="search" class="field px-2.5 py-1.5 text-[13px]" placeholder="Cerca per nome o descrizione" aria-label="Cerca un agente" />
      <div class="flex gap-1.5" role="group" aria-label="Filtra">
        <button
          v-for="item in FILTERS"
          :key="item.id"
          type="button"
          class="rounded-full border px-2.5 py-0.5 text-xs"
          :class="filter === item.id ? 'border-accent bg-glow text-ink' : 'border-line-strong text-muted hover:text-ink'"
          :aria-pressed="filter === item.id"
          @click="filter = item.id"
        >
          {{ item.text }}
        </button>
      </div>
      <p v-if="loadError" class="text-xs text-danger" role="alert">{{ loadError }}</p>
      <template v-for="group in groups" :key="group.id">
        <template v-if="group.items.length > 0 || group.id === 'mine'">
          <p class="mt-1 flex items-baseline gap-2">
            <span class="hud-title text-[10px]">{{ group.title }}</span><small class="text-[11.5px] text-muted">{{ group.hint }}</small>
          </p>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="entry in group.items"
              :key="entry.id"
              type="button"
              class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 rounded-xl border bg-surface px-2.5 py-2 text-left transition-[border-color,transform] hover:-translate-y-px"
              :class="[entry.id === current?.id ? 'border-accent shadow-[0_0_0_3px_var(--glow)]' : 'border-line hover:border-line-strong', { 'opacity-60 grayscale': !entry.on }]"
              :aria-current="entry.id === current?.id ? 'true' : undefined"
              :disabled="generating && entry.id !== current?.id"
              :title="generating && entry.id !== current?.id ? HOLD_TEXT : undefined"
              @click="choose(entry.id)"
            >
              <span class="row-span-2"><PixelAgent :choice="previewOf(entry.id)" pose="idle" :scale="1" :version="sheetVersion" /></span>
              <span class="truncate text-[13.5px] font-semibold">
                {{ nameOf(entry.id) }}<span v-if="dirtyIds.has(entry.id)" class="text-warn" title="Modifiche non salvate" aria-label="modifiche non salvate"> •</span>
              </span>
              <span class="flex items-center gap-1.5 font-mono text-[10.5px] text-muted">
                <span class="size-[7px] shrink-0 rounded-full" :class="entry.on ? 'bg-ok' : 'border-[1.5px] border-muted'" :title="entry.on ? 'attivo' : 'spento'" />
                {{ entry.on ? '' : 'spento · ' }}{{ entry.where === 'cloud' ? 'Claude' : 'locale' }}
              </span>
            </button>
            <a
              v-if="group.id === 'mine'"
              href="/impostazioni/agenti/nuovo"
              class="grid min-h-[62px] place-items-center rounded-xl border border-dashed border-line-strong text-[13px] text-muted hover:border-accent hover:text-accent"
              @click.prevent="emit('newAgent')"
            >+ Nuovo agente</a>
          </div>
        </template>
      </template>
      <p v-if="visible.length === 0 && entries.length > 0" class="text-xs text-muted">Nessun agente con questi filtri.</p>
      <!-- Cards that could not be read: never loaded; a disabled one can be deleted -->
      <div v-for="item in listing?.refused ?? []" :key="`${item.state}-${item.name}`" class="flex flex-wrap items-center gap-2 rounded-[10px] border border-danger/50 px-2.5 py-2 text-xs">
        <span class="min-w-0 flex-1">
          <span class="font-mono">{{ item.name }}</span> (in {{ item.state === 'active' ? 'attivi' : 'disattivati' }}) non caricato: <span class="font-mono text-muted">{{ item.reason }}</span>
        </span>
        <button v-if="item.state === 'disabled'" type="button" class="btn btn-danger px-2 py-0.5 text-xs" :disabled="busyName !== ''" @click="deleting = { name: item.name, typed: '' }; error = ''">Elimina…</button>
      </div>
      <!-- For every agent: when one that entered a conversation leaves by itself (I-8, D-130) -->
      <div class="flex flex-col gap-1 rounded-[10px] border border-line bg-surface-2 p-3 text-[13px]">
        <label for="leave-after" class="flex flex-wrap items-center gap-2">
          Un agente entrato in una conversazione esce da solo dopo
          <input id="leave-after" v-model.number="form.participants" type="number" min="0" :max="MAX_LEAVE_AFTER" step="1" class="field w-16 px-2 py-1 text-[13px]" />
          tuoi messaggi senza lavori per lui
        </label>
        <p class="text-xs text-muted">Saluta con una frase e rientra alla delega seguente. 0 vuol dire mai. Il Coder non esce da solo: lo togli tu.</p>
        <p v-if="leaveAfterProblem(form.participants) !== undefined" class="text-xs text-warn">{{ leaveAfterProblem(form.participants) }}</p>
      </div>
    </aside>

    <!-- The detail -->
    <div v-if="current !== undefined" class="flex min-w-0 flex-col gap-3.5" aria-live="polite">
      <section class="hud-card relative grid grid-cols-1 items-center gap-4 overflow-hidden px-4 py-4 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div class="grid h-[132px] w-[112px] place-items-end justify-center rounded-xl border border-line bg-surface-2 pb-2">
          <PixelAgent :choice="previewOf(current.id)" pose="idle" :scale="3" :version="sheetVersion" />
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="chip">{{ current.official ? 'ufficiale' : 'mio' }}</span>
            <span class="chip" :class="current.where === 'cloud' ? 'text-info' : 'text-ok'">{{ current.where === 'cloud' ? '☁ va a Claude' : '⌂ resta sul computer' }}</span>
            <label class="ml-auto flex items-center gap-2 text-[13px]" :title="current.official ? (current.id === 'arianna' ? 'Arianna è sempre attiva' : 'Le schede ufficiali sono sempre attive') : undefined">
              {{ current.on ? 'Attivo' : 'Spento' }}
              <input type="checkbox" role="switch" class="switch" :checked="current.on" :disabled="current.official || busyName !== ''" :aria-label="`${nameOf(current.id)} attivo`" @change="toggle(current, $event)" />
            </label>
          </div>
          <h2 class="font-hud text-[22px] leading-tight font-semibold tracking-[0.06em]">{{ nameOf(current.id) }}</h2>
          <p v-if="current.description" class="max-w-[60ch] text-[13.5px] text-muted">{{ current.description }}</p>
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="chip font-mono">modello: {{ modelText(current) }}</span>
            <span v-if="current.view" class="chip font-mono">{{ labelWord(current.view.card.maxLabel) }} · {{ current.view.card.autonomy }}</span>
            <button v-if="canChat" type="button" class="btn px-2.5 py-0.5 text-xs" @click="emit('chat', current.id)">Apri una chat</button>
          </div>
          <p v-if="!current.official && current.view" class="text-xs" :class="current.view.works === null ? 'text-warn' : 'text-muted'">
            {{ current.on ? 'Da attivo' : 'Quando è attivo' }} {{ workText(current.view.works) }}.
          </p>
        </div>
      </section>

      <p v-if="error && !promoting && !demoting && !deleting && !confirming" class="text-xs text-danger" role="alert">{{ error }}</p>
      <p v-if="notice" class="text-xs text-ok" role="status">{{ notice }}</p>

      <div class="flex gap-0.5 overflow-x-auto border-b border-line" role="tablist" aria-label="Sezioni dell’agente">
        <button
          v-for="item in tabs"
          :key="item"
          type="button"
          role="tab"
          class="-mb-px border-b-2 px-3 py-2 font-hud text-[11px] font-semibold tracking-[0.14em] whitespace-nowrap uppercase"
          :class="tab === item ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'"
          :aria-selected="tab === item"
          :disabled="generating && tab !== item"
          :title="generating && tab !== item ? HOLD_TEXT : undefined"
          @click="tab = item"
        >
          {{ TAB_TEXT[item] }}
        </button>
      </div>

      <fieldset :disabled="busy || working" class="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
        <!-- Personalità (D-107) -->
        <section v-if="tab === 'persona' && form.personas[current.id]" class="hud-card flex flex-col gap-3.5 px-4 py-4" role="tabpanel">
          <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
            <span class="text-[13px] font-medium sm:pt-1">Tono<small class="block text-[11.5px] font-normal text-muted">come risponde</small></span>
            <div class="flex flex-col gap-1.5">
              <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tono">
                <label
                  v-for="tone in TONES"
                  :key="tone"
                  class="cursor-pointer rounded-[9px] border px-2.5 py-1 text-[13px] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
                  :class="form.personas[current.id]?.tone === tone ? 'border-accent bg-accent/15 text-ink' : 'border-line-strong text-muted hover:text-ink'"
                >
                  <input v-model="form.personas[current.id]!.tone" type="radio" :name="`tone-${current.id}`" :value="tone" class="sr-only" />{{ TONE_TEXT[tone] }}
                </label>
              </div>
              <p class="text-xs text-muted">Esempio: <span class="text-ink italic">«{{ TONE_EXAMPLE[form.personas[current.id]!.tone] }}»</span></p>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label :for="`address-${current.id}`" class="text-[13px] font-medium sm:pt-1.5">Ti dà del</label>
            <select :id="`address-${current.id}`" v-model="form.personas[current.id]!.address" class="field max-w-[160px] px-2 py-1.5 text-[13px]">
              <option v-for="address in ADDRESSES" :key="address" :value="address">{{ address }}</option>
            </select>
          </div>
          <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label :for="`display-${current.id}`" class="text-[13px] font-medium sm:pt-1.5">Nome visualizzato<small class="block text-[11.5px] font-normal text-muted">in chat e nell’ufficio</small></label>
            <input
              :id="`display-${current.id}`"
              v-model="form.personas[current.id]!.displayName"
              :maxlength="MAX_DISPLAY_NAME"
              :disabled="FIXED_NAMES.includes(current.id)"
              :placeholder="FIXED_NAMES.includes(current.id) ? 'non si cambia' : agentName(current.id)"
              class="field px-2 py-1.5 text-[13px] disabled:opacity-60"
            />
          </div>
          <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label :for="`spec-${current.id}`" class="text-[13px] font-medium sm:pt-1.5">Specializzazione<small class="block text-[11.5px] font-normal text-muted">si aggiunge al ruolo della scheda</small></label>
            <div class="flex flex-col gap-1">
              <span class="self-end font-mono text-[10.5px]" :class="countCharacters(form.personas[current.id]!.specialization) > MAX_TEXT ? 'text-danger' : 'text-muted'">{{ countCharacters(form.personas[current.id]!.specialization) }}/{{ MAX_TEXT }}</span>
              <textarea :id="`spec-${current.id}`" v-model="form.personas[current.id]!.specialization" rows="3" class="field px-2 py-1.5 text-[13px]" placeholder="Es. sviluppatore senior TypeScript, attento ai test e alla leggibilità." />
            </div>
          </div>
          <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label :for="`traits-${current.id}`" class="text-[13px] font-medium sm:pt-1.5">Personalità<small class="block text-[11.5px] font-normal text-muted">come parla</small></label>
            <div class="flex flex-col gap-1">
              <span class="self-end font-mono text-[10.5px]" :class="countCharacters(form.personas[current.id]!.traits) > MAX_TEXT ? 'text-danger' : 'text-muted'">{{ countCharacters(form.personas[current.id]!.traits) }}/{{ MAX_TEXT }}</span>
              <textarea :id="`traits-${current.id}`" v-model="form.personas[current.id]!.traits" rows="3" class="field px-2 py-1.5 text-[13px]" placeholder="Es. precisa e calma, con un debole per le metafore di cucina." />
            </div>
          </div>
          <p class="flex items-start gap-2 text-xs text-warn"><Icon name="gateway" :size="14" class="mt-px" />{{ PERSONA_NOTICE }}</p>
          <p class="text-xs text-muted">{{ costText(personaCost(form.personas[current.id]!)) }} {{ PERSONA_WHERE }}</p>
        </section>

        <!-- Aspetto (D-118, D-123, D-132) -->
        <section v-if="tab === 'look'" class="hud-card flex flex-col gap-3.5 px-4 py-4" role="tabpanel">
          <div class="grid grid-cols-1 gap-4 md:grid-cols-[auto_minmax(0,1fr)]">
            <div class="flex flex-wrap gap-2.5">
              <div v-for="item in POSES" :key="item.pose" class="flex flex-col items-center gap-1 rounded-[10px] border border-line px-2.5 pt-2 pb-1.5 font-mono text-[10px] text-muted">
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
                <button v-if="previewOf(current.id)" type="button" class="btn px-2.5 py-1 text-xs" :aria-expanded="animationsOpen" @click="animationsOpen = !animationsOpen">
                  {{ animationsOpen ? 'Chiudi le animazioni' : 'Tutte le animazioni' }}
                </button>
                <a v-if="previewOf(current.id)" class="btn px-2.5 py-1 text-xs" :href="sheetUrl(previewOf(current.id)!, sheetVersion)" :download="`${previewOf(current.id)!.character}.png`">Scarica PNG</a>
                <button v-if="form.characters[current.id] !== undefined" type="button" class="btn px-2.5 py-1 text-xs" @click="delete form.characters[current.id]">Torna al predefinito</button>
              </div>
            </div>
          </div>
          <SheetPreview v-if="animationsOpen && previewOf(current.id)" :src="sheetUrl(previewOf(current.id)!, sheetVersion)" :rows="previewOf(current.id)!.rows" />
          <p class="text-xs text-muted">
            Un foglio caricato con «Carica PNG» o disegnato con «Genera» va nel pacchetto <code class="font-mono">data/characters/miei</code>, fuori da git; un pacchetto intero si copia a mano in
            <code class="font-mono">data/characters</code>, poi si ricarica questa pagina.
          </p>
        </section>

        <!-- Modello -->
        <section v-if="tab === 'model'" class="hud-card flex flex-col gap-3 px-4 py-4" role="tabpanel">
          <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
            <template v-if="current.id === 'arianna'">
              <span class="text-[13px] font-medium sm:pt-1">Modello</span>
              <div class="flex flex-col gap-1">
                <p class="flex flex-wrap items-center gap-2 text-[13px]"><span class="font-mono text-xs">{{ view.values?.roles.orchestrator ?? 'nessuno' }}</span><span class="chip text-ok">locale</span></p>
                <p class="text-xs text-muted">
                  Si cambia in
                  <a href="/impostazioni/modelli" class="text-accent hover:underline" @click.prevent="emit('section', 'modelli')">Modelli</a>, ruolo Orchestratore: per Arianna solo modelli locali.
                </p>
              </div>
            </template>
            <template v-else-if="form.agents[current.id] !== undefined && modelsOf(current.id).length > 0">
              <label :for="`model-${current.id}`" class="text-[13px] font-medium sm:pt-1.5">Modello delle conversazioni nuove</label>
              <div class="flex flex-col gap-1.5">
                <select :id="`model-${current.id}`" v-model="form.agents[current.id]" class="field max-w-[320px] px-2 py-1.5 text-[13px]">
                  <option value="">automatico (sceglie il router)</option>
                  <option v-for="model in modelsOf(current.id)" :key="model" :value="model">{{ MODEL_TEXT[model] ?? model }}{{ blockerOf(model) === undefined ? '' : ` (${blockerOf(model)})` }}</option>
                  <!-- A model of the file the card no longer allows stays visible: it is kept, and ignored. -->
                  <option v-if="form.agents[current.id] !== '' && !modelsOf(current.id).includes(form.agents[current.id] as CloudModelAlias)" :value="form.agents[current.id]">
                    {{ MODEL_TEXT[form.agents[current.id] ?? ''] ?? form.agents[current.id] }} (non consentito dalla scheda)
                  </option>
                </select>
                <p class="text-xs text-muted">
                  Il selettore della chat lo cambia per una conversazione, e il router lo usa finché nessuna regola lo esclude. Un modello spento o con l’esecutore spento si può scegliere, ma
                  vale solo quando è acceso; non accende mai un esecutore.
                </p>
              </div>
            </template>
            <template v-else>
              <span class="text-[13px] font-medium">Modello</span>
              <div class="flex flex-col gap-1">
                <p class="text-[13px]">{{ current.where === 'cloud' ? 'sceglie il router' : 'solo modelli locali: sceglie il router' }}</p>
                <p class="text-xs text-muted">{{ current.where === 'cloud' ? 'La scheda non elenca modelli cloud da scegliere.' : 'La scheda non permette esecutori cloud.' }}</p>
              </div>
            </template>
          </div>
        </section>

        <!-- Skill (D-161): third-party text the agent reads in its delegations and local cards, as data -->
        <section v-if="tab === 'skills'" class="hud-card flex flex-col gap-3 px-4 py-4" role="tabpanel">
          <p v-if="skillRefusal(current.id)" class="text-[13px] text-muted">{{ skillRefusal(current.id) }}</p>
          <template v-else>
            <p class="text-xs text-muted">
              Le skill assegnate entrano, dopo il suo prompt, nelle deleghe a questo agente (Claude, Codex o modello locale) e nelle card che lavora sul modello locale, come testo di terzi da consultare: mai come istruzione per Arianna, mai nelle chiamate vocali. Si salvano con la barra delle
              modifiche, in <code class="font-mono">[agents.{{ current.id }}] skills</code> di <code class="font-mono">arianna.toml</code>. Sorgenti e aggiornamenti nella sezione Skill qui sotto.
            </p>
            <p v-if="skillsOf(current.id).length === 0" class="text-[13px]">Nessuna skill assegnata.</p>
            <ul v-else class="m-0 flex list-none flex-col gap-1.5 p-0">
              <li v-for="id in skillsOf(current.id)" :key="id" class="flex items-start gap-2 rounded-[10px] border border-line px-3 py-2 text-[13px]">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="flex min-w-0 items-baseline gap-2">
                    <span class="truncate font-medium">{{ skillOf(id)?.name ?? id }}</span>
                    <span class="truncate font-mono text-[10.5px] text-muted">{{ id }}</span>
                  </span>
                  <span v-if="skillCatalog !== null && skillOf(id) === undefined" class="text-xs text-warn">Non è più nel catalogo in uso: non arriva all’agente finché non torna.</span>
                  <span v-else-if="skillOf(id)" class="text-xs text-muted">{{ skillLicenseText(skillOf(id)?.license ?? null) }}</span>
                </span>
                <button type="button" class="btn shrink-0 px-2 py-0.5 text-xs" :aria-label="`Togli ${id}`" @click="unassignSkill(current.id, id)">Togli</button>
              </li>
            </ul>
            <div class="flex flex-col gap-1.5">
              <input v-model="skillQuery" type="search" class="field px-2.5 py-1.5 text-[13px]" placeholder="Cerca una skill da assegnare" aria-label="Cerca una skill da assegnare" />
              <p v-if="skillCatalogError" class="text-xs text-danger" role="alert">{{ skillCatalogError }}</p>
              <p v-else-if="skillCatalog === null" class="text-xs text-muted">Leggo il catalogo…</p>
              <p v-else-if="skillCatalog.length === 0" class="text-xs text-muted">Il catalogo è vuoto: aggiungi e scarica una sorgente nella sezione Skill qui sotto.</p>
              <p v-else-if="skillChoices.length === 0" class="text-xs text-muted">Nessuna skill con questa ricerca.</p>
              <ul v-else class="m-0 flex max-h-[300px] list-none flex-col overflow-auto rounded-[10px] border border-line p-0">
                <li v-for="item in skillChoices" :key="item.id" class="flex items-start gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0">
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="flex min-w-0 items-baseline gap-2">
                      <span class="truncate text-[13px] font-medium">{{ item.name }}</span>
                      <span class="truncate font-mono text-[10.5px] text-muted">{{ item.id }}</span>
                    </span>
                    <span v-if="item.description" class="text-xs text-muted">{{ item.description }}</span>
                    <span class="text-[11px] text-muted">{{ skillLicenseText(item.license) }}</span>
                  </span>
                  <button type="button" class="btn shrink-0 px-2 py-0.5 text-xs" :aria-label="`Assegna ${item.id}`" @click="assignSkill(current.id, item.id)">Assegna</button>
                </li>
              </ul>
            </div>
          </template>
        </section>
      </fieldset>

      <!-- Permessi: changed only after the confirmation of what changes, never by the bar -->
      <section v-if="tab === 'permissions'" class="hud-card flex flex-col gap-3 px-4 py-4" role="tabpanel">
        <ul v-if="current.view" class="m-0 grid list-none gap-2 p-0">
          <li v-for="line in permissionLines(current.view.card)" :key="line" class="rounded-[10px] border border-line px-3 py-2 text-[13px]">
            <b class="font-semibold">{{ splitLine(line)[0] }}</b><span v-if="splitLine(line)[1]" class="block text-xs text-muted">{{ splitLine(line)[1] }}</span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted">La scheda di questo agente non è fra quelle caricate dal nucleo.</p>
        <template v-if="current.official">
          <p class="text-xs text-muted">Le schede ufficiali si cambiano in <code class="font-mono">agents/{{ current.id }}.yaml</code>.</p>
          <div v-if="current.view?.fromPage" class="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Nato da questa pagina e promosso.</span>
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busyName !== ''" @click="demoting = current.view!; error = ''">Riporta fra i miei…</button>
          </div>
        </template>
        <template v-else-if="current.view">
          <p class="rounded-[10px] border border-warn/40 bg-warn/7 px-3 py-2.5 text-[12.5px]">
            Tetto finché resta fra i tuoi agenti: al massimo <b>Interno</b> e <b>A1</b>, qualunque cosa dica la scheda.
          </p>
          <div v-if="editingPermissions?.name === current.id && sources" class="flex flex-col gap-2.5 rounded-[10px] border border-line p-3">
            <PermissionsPicker v-model="editingPermissions.permissions" :sources="sources" :id-prefix="`edit-${current.id}`" />
            <div class="flex justify-end gap-2">
              <button type="button" class="btn px-2.5 py-1 text-xs" @click="editingPermissions = null; error = ''">Annulla</button>
              <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busyName !== ''" @click="reviewPermissions">Rivedi e salva…</button>
            </div>
          </div>
          <div v-else-if="sources && current.view.permissions" class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busyName !== ''" @click="startPermissions(current.view)">Modifica permessi…</button>
            <span class="text-xs text-muted">Ti mostra cosa cambia prima di salvare.</span>
          </div>
          <p v-else-if="current.view.permissions === null" class="text-xs text-muted">La scheda è stata cambiata a mano oltre l’elenco ammesso: si cambia solo nel file.</p>
        </template>
      </section>

      <!-- Scheda e prompt: the user's agents only -->
      <template v-if="tab === 'card' && !current.official">
        <section class="hud-card flex flex-col gap-3.5 px-4 py-4" role="tabpanel">
          <p v-if="!texts[current.id]" class="text-xs text-muted">Leggo il prompt…</p>
          <fieldset v-else :disabled="working" class="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
            <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
              <label :for="`desc-${current.id}`" class="text-[13px] font-medium sm:pt-1.5">Descrizione<small class="block text-[11.5px] font-normal text-muted">una riga, la legge Arianna per scegliere</small></label>
              <input :id="`desc-${current.id}`" v-model="texts[current.id]!.description" class="field px-2 py-1.5 text-[13px]" maxlength="200" />
            </div>
            <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[160px_minmax(0,1fr)]">
              <label :for="`prompt-${current.id}`" class="text-[13px] font-medium sm:pt-1.5">Prompt<small class="block text-[11.5px] font-normal text-muted">le istruzioni dell’agente</small></label>
              <div class="flex flex-col gap-1">
                <span class="self-end font-mono text-[10.5px] text-muted">{{ texts[current.id]!.prompt.length }}/{{ MAX_USER_PROMPT }}</span>
                <textarea :id="`prompt-${current.id}`" v-model="texts[current.id]!.prompt" rows="8" class="field px-2 py-1.5 text-[13px]" :maxlength="MAX_USER_PROMPT" />
              </div>
            </div>
            <p class="text-xs text-muted">
              {{ current.on ? 'L’agente è attivo: i testi nuovi valgono dal prossimo lavoro che Arianna gli passa.' : 'Valgono da quando lo attivi.' }} Restano Interno per tua dichiarazione, possono
              arrivare a un esecutore cloud (non scriverci dati personali) e passano dagli stessi controlli della creazione.
            </p>
          </fieldset>
        </section>
        <section v-if="current.view" class="hud-card danger flex flex-col gap-3 px-4 py-4">
          <div class="flex flex-wrap items-center gap-3">
            <span class="min-w-0 flex-1 text-[13px] font-medium">Promuovi a ufficiale<small class="block text-[11.5px] font-normal text-muted">passa in agents/, in git; cade il tetto Interno/A1</small></span>
            <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busyName !== '' || changedTexts.includes(current.id)"
              :title="changedTexts.includes(current.id) ? 'Prima salva o annulla descrizione e prompt' : undefined"
              @click="promoting = current.view!; error = ''"
              >Promuovi…</button>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <span class="min-w-0 flex-1 text-[13px] font-medium">Elimina<small class="block text-[11.5px] font-normal text-muted">solo da spento; va in data/agents/eliminati</small></span>
            <button type="button" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busyName !== '' || current.on" :title="current.on ? 'Prima spegnilo' : undefined" @click="deleting = { name: current.id, typed: '' }; error = ''">Elimina…</button>
          </div>
        </section>
      </template>
    </div>
    <p v-else class="text-sm text-muted">Leggo gli agenti…</p>

    <!-- One bar for look, persona, model and texts: the cards' own buttons are gone -->
    <div
      v-if="dirty || working || saved || barError"
      class="sticky bottom-4 z-10 mx-auto flex max-w-full flex-wrap items-center gap-3 rounded-xl border bg-surface py-2 pr-3 pl-4 shadow-[0_10px_30px_#0006,0_0_0_4px_var(--glow)] @3xl:col-span-2"
      :class="barError || props.error || blocked ? 'border-danger' : 'border-accent'"
      role="status"
    >
      <span class="min-w-0 text-[13px]" :class="{ 'text-danger': barError || props.error || blocked }">
        <template v-if="barError || props.error">{{ barError || props.error }}</template>
        <template v-else-if="working || busy">Salvo…</template>
        <template v-else-if="dirty && blocked">{{ blocked }}</template>
        <template v-else-if="dirty">Modifiche non salvate a <b>{{ unsaved }}</b></template>
        <template v-else>Salvato</template>
      </span>
      <template v-if="dirty">
        <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="working || busy" @click="undo">Annulla</button>
        <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="working || busy || blocked !== undefined" @click="saveAll">Salva</button>
      </template>
    </div>

    <!-- Promotion: what changes, then the user's click -->
    <div v-if="promoting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="promote-title">
      <div class="hud-card warn flex max-w-lg flex-col gap-3 p-4">
        <h2 id="promote-title" class="font-hud text-[12px] font-semibold tracking-[0.14em] uppercase">Promuovere {{ promoting.name }} a ufficiale?</h2>
        <p class="text-[13px]">
          La scheda passa da <code class="font-mono">data/agents</code> a <code class="font-mono">agents/</code>, la cartella del repository in git, e l’agente diventa attivo. Cosa cambia:
        </p>
        <ul class="list-disc pl-5 text-[13px]">
          <li>il tetto Interno e A1 cade: valgono etichette, strumenti e azioni scritti nella scheda;</li>
          <li>oggi la scheda dice: {{ permissionLines(promoting.card).slice(0, 2).join('; ') }};</li>
          <li>chi modifica a mano <code class="font-mono">agents/{{ promoting.name }}.yaml</code> può dargli di più, fino a Privato;</li>
          <li>i file risultano nuovi in git: un commit li rende visibili a chi ha il repository, e un push li pubblica.</li>
        </ul>
        <p class="text-xs text-muted">Si torna indietro da questa pagina con «Riporta fra i miei», finché la scheda resta quella scritta qui.</p>
        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="promoting = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busyName !== ''" @click="promote">Promuovi</button>
        </div>
      </div>
    </div>

    <!-- A promotion taken back -->
    <div v-if="demoting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="demote-title">
      <div class="hud-card flex max-w-lg flex-col gap-3 p-4">
        <h2 id="demote-title" class="font-hud text-[12px] font-semibold tracking-[0.14em] uppercase">Riportare {{ demoting.name }} fra i tuoi agenti?</h2>
        <ul class="list-disc pl-5 text-[13px]">
          <li>la scheda torna in <code class="font-mono">data/agents/disattivati</code>, fuori da git, e l’agente si ferma: Arianna non gli passa più lavoro finché non lo riattivi;</li>
          <li>torna il tetto Interno e A1;</li>
          <li>se i file di <code class="font-mono">agents/{{ demoting.name }}</code> erano già in un commit, git li vedrà come tolti: il prossimo commit lo registra.</li>
        </ul>
        <p class="text-xs text-muted">Una scheda cambiata a mano oltre i permessi ammessi non può tornare: resta ufficiale.</p>
        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="demoting = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busyName !== ''" @click="demote">Riporta fra i miei</button>
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
      <form class="hud-card flex max-w-lg flex-col gap-3 p-4" @submit.prevent="remove">
        <h2 id="delete-title" class="font-hud text-[12px] font-semibold tracking-[0.14em] uppercase">Eliminare {{ deleting.name }}?</h2>
        <p class="text-[13px]">
          L’agente sparisce dalla pagina e Arianna non lo vede più. I due file (scheda e prompt) vanno in <code class="font-mono">data/agents/eliminati</code>: da lì si recuperano solo a mano.
        </p>
        <label class="flex flex-col gap-1 text-xs text-muted">
          Per confermare scrivi il nome dell’agente
          <input v-model.trim="deleting.typed" class="field px-2 py-1.5 font-mono text-[13px] text-ink" :placeholder="deleting.name" autocomplete="off" />
        </label>
        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="deleting = null; error = ''">Annulla</button>
          <button type="submit" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busyName !== '' || deleting.typed !== deleting.name">Elimina</button>
        </div>
      </form>
    </div>
  </div>
</template>

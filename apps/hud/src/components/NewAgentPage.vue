<script setup lang="ts">
/**
 * "Nuovo agente" (D-119, tappa T3): a page of its own, in three steps. What
 * the agent does (its permissions, chosen within the list from a starting
 * point, tappa T3b), who it is (name, description and prompt, with an
 * example), how it looks (a character generated or a PNG uploaded here); then "Crea
 * spento", which shows what the card will allow and writes it only on
 * the user's confirmation. The core checks everything again. The character
 * goes into [characters] of arianna.toml right after the card: if that
 * fails, the agent exists anyway and the page says where to add it again.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { catalogPresetOf, roleCardName, roleUnlicensed, type AgentRoleSummary, type AgentRoleText } from '../lib/agents-catalog.ts';
import { lengthText } from '../lib/agents-page.ts';
import { loadAgentRole, loadCharacters, loadSettings, saveSettings, type UploadedCharacter } from '../lib/api.ts';
import { activationAsk, redoSafetyReport } from '../lib/safety-report.ts';
import { safetyPoll } from '../lib/safety-poll.ts';
import type { CharacterChoice, CharacterListing } from '../lib/types.ts';
import {
  activateUserAgent,
  createCatalogAgent,
  createUserAgent,
  loadSources,
  prepareCatalogAgent,
  MAX_USER_PROMPT,
  prepareUserAgent,
  PRESET_ORDER,
  PRESET_TEXT,
  samePermissionsOf,
  USER_AGENT_NAME,
  UserAgentApiError,
  userAgentErrorText,
  workText,
  type AgentProposal,
  type NewUserAgent,
  type UserAgentSources,
  type UserAgentView,
  type UserPermissions,
} from '../lib/user-agents.ts';
import CatalogRolePicker from './CatalogRolePicker.vue';
import SafetyReportCard from './SafetyReportCard.vue';
import CharacterGenerate from './CharacterGenerate.vue';
import CharacterUpload from './CharacterUpload.vue';
import FormField from './FormField.vue';
import Icon from './Icon.vue';
import PermissionConfirm from './PermissionConfirm.vue';
import PermissionsPicker from './PermissionsPicker.vue';
import PixelAgent from './PixelAgent.vue';

/** `done`: back to the Agents section; `changed`: an agent was created or activated. */
const emit = defineEmits<{ done: []; changed: [] }>();

const STEPS = ['Cosa fa', 'Chi è', 'Aspetto'] as const;
const step = ref(0);
const sources = ref<UserAgentSources | null>(null);
const characters = ref<CharacterListing | null>(null);
const loadError = ref('');
const LOCAL: UserPermissions = { executor: 'local', tools: [], autonomy: 'A0', maxSteps: 10, maxMinutes: 10 };
const presetPermissions = (id: string): UserPermissions => sources.value?.presets.find((preset) => preset.id === id)?.permissions ?? LOCAL;
const empty = () => ({ preset: 'answer', permissions: presetPermissions('answer'), name: '', description: '', prompt: '', character: '' });
const form = ref(empty());
/** What the core will write, shown before it does (tappa T3b). */
const proposal = ref<AgentProposal | null>(null);
const busy = ref(false);
const error = ref('');
const created = ref<UserAgentView | null>(null);
const characterNote = ref('');

// «Dal catalogo» (D-079, tappa 3): a role of the catalog gives description and prompt; the user chooses name and permissions.
const origin = ref<'scratch' | 'catalog'>('scratch');
const roleId = ref<string | null>(null);
const role = ref<AgentRoleSummary | null>(null);
const roleText = ref<AgentRoleText | null>(null);
/** The yes to the warning of a source without a license (choice of the user, 2026-10-13). */
const licenseAccepted = ref(false);
const fromCatalog = computed(() => origin.value === 'catalog');
/** The core found no license the card can carry, though the list of roles did not say so: the page asks as well. */
const licenseNeeded = ref(false);
const unlicensed = computed(() => fromCatalog.value && (licenseNeeded.value || (role.value !== null && roleUnlicensed(role.value))));
function chooseOrigin(value: 'scratch' | 'catalog'): void {
  if (origin.value === value) return;
  origin.value = value;
  error.value = '';
  if (value === 'scratch') {
    form.value = empty();
    roleId.value = null;
    role.value = null;
    roleText.value = null;
    licenseAccepted.value = false;
    licenseNeeded.value = false;
  }
}
/** A role chosen: its name and the starting point of its division; the user changes them after. */
function onRole(chosen: AgentRoleSummary | null, text: AgentRoleText | null): void {
  const changed = chosen?.id !== role.value?.id;
  role.value = chosen;
  roleText.value = text;
  if (!changed || chosen === null) return;
  licenseAccepted.value = false;
  licenseNeeded.value = false;
  const preset = catalogPresetOf(chosen.division);
  form.value = { ...form.value, preset, permissions: presetPermissions(preset), name: roleCardName(chosen.slug), description: chosen.description, prompt: '' };
}
watch(roleText, (text) => {
  // The prompt shown in «Aspetto» and given to the generator of the character: the role's text, read only.
  if (fromCatalog.value && text !== null) form.value.prompt = text.text;
});
/** The catalog is followed in the settings: the page of the settings opens there. */
function openCatalogSettings(): void {
  window.location.assign('/impostazioni/catalogo-agenti');
}
const catalogInput = () => ({ from: { catalog: roleId.value ?? '' }, name: form.value.name, permissions: form.value.permissions });
/** Bumped by an upload: the sheets are asked again, a replaced one included. */
const sheetVersion = ref(0);

async function readCharacters(): Promise<void> {
  try {
    characters.value = await loadCharacters();
  } catch {
    // The list stays as it was: a reload of the page asks again.
  }
}

onMounted(async () => {
  try {
    sources.value = await loadSources();
    form.value.permissions = presetPermissions(form.value.preset);
  } catch (cause) {
    loadError.value = userAgentErrorText(cause);
  }
  await readCharacters();
});

/** The starting points the core offers, in the page's order. */
const presets = computed(() => PRESET_ORDER.filter((id) => sources.value?.presets.some((preset) => preset.id === id)));
const text = computed(() => PRESET_TEXT[form.value.preset]);
/** The starting point still as it was: the permissions not changed by hand. */
const asPreset = computed(() => samePermissionsOf(form.value.permissions, presetPermissions(form.value.preset)));
function choosePreset(id: string): void {
  form.value.preset = id;
  form.value.permissions = presetPermissions(id);
}

const nameProblem = computed(() => (USER_AGENT_NAME.test(form.value.name) ? '' : 'Nome: da 2 a 40 caratteri, minuscole, cifre e trattini, e comincia con una lettera.'));
const descriptionProblem = computed(() => {
  const description = form.value.description.trim();
  if (description === '') return 'Scrivi una descrizione di una riga: Arianna la legge per decidere quando passargli un lavoro.';
  return description.length > 200 ? 'La descrizione supera 200 caratteri.' : '';
});
const promptProblem = computed(() => {
  if (form.value.prompt.trim() === '') return 'Scrivi il prompt: cosa fa l’agente e come.';
  return form.value.prompt.length > MAX_USER_PROMPT ? `Il prompt supera ${String(MAX_USER_PROMPT)} caratteri.` : '';
});
/** What keeps the user on a step; empty when the step is complete. */
function problemOf(index: number): string {
  if (index === 0) {
    if (sources.value === null) return 'Leggo i permessi ammessi…';
    return fromCatalog.value && role.value === null ? 'Scegli un ruolo del catalogo.' : '';
  }
  // A role of the catalog brings description and prompt: only the name is the user's.
  if (index === 1) return fromCatalog.value ? nameProblem.value : nameProblem.value || descriptionProblem.value || promptProblem.value;
  if (index === 2 && unlicensed.value && !licenseAccepted.value) return 'Leggi l’avviso sulla licenza e conferma prima di creare l’agente.';
  return '';
}
/** A step is reachable when every step before it is complete. */
function reachable(index: number): boolean {
  return Array.from({ length: index }, (_, before) => problemOf(before)).every((problem) => problem === '');
}

/** Fills the empty fields with the template's example: never over what the user wrote. */
function useExample(): void {
  const example = text.value?.example;
  if (example === undefined) return;
  if (form.value.name === '') form.value.name = example.name;
  if (form.value.description.trim() === '') form.value.description = example.description;
  if (form.value.prompt.trim() === '') form.value.prompt = example.prompt;
}
const exampleUseful = computed(() => form.value.name === '' || form.value.description.trim() === '' || form.value.prompt.trim() === '');

const characterOptions = computed(() =>
  (characters.value?.packs ?? []).flatMap((pack) => pack.characters.map((character) => ({ value: `${pack.id}/${character.id}`, label: `${pack.name} · ${character.name}`, pack, character }))),
);
/** What the agent wears: the choice, or the core's default for a new agent (the Coder's original sheet). */
const preview = computed((): CharacterChoice | undefined => {
  const wanted = form.value.character === '' ? undefined : characterOptions.value.find((option) => option.value === form.value.character);
  const option = wanted ?? characterOptions.value.find((item) => item.pack.original && item.character.id === 'coder');
  return option === undefined ? undefined : { pack: option.pack.id, character: option.character.id, rows: option.character.rows };
});

async function onUploaded(saved: UploadedCharacter): Promise<void> {
  sheetVersion.value += 1;
  await readCharacters();
  form.value.character = `${saved.pack}/${saved.character}`;
}

function go(index: number): void {
  if (index >= 0 && index < STEPS.length && reachable(index)) {
    step.value = index;
    error.value = '';
  }
}

const input = (): NewUserAgent => ({ name: form.value.name, description: form.value.description.trim(), prompt: form.value.prompt, permissions: form.value.permissions });
/** What the card would be: from the page's texts, or from the role (the core reads it again). */
const prepareAny = (): Promise<AgentProposal> => (fromCatalog.value ? prepareCatalogAgent(catalogInput()) : prepareUserAgent(input()));
/**
 * The proposal shown for confirmation. The core decides whether the source
 * has a license the card can carry: when it says none and the user has not
 * said yes yet, the page shows the warning first, never the confirmation.
 */
async function prepareShown(): Promise<void> {
  const prepared = await prepareAny();
  if (fromCatalog.value && prepared.catalog?.unlicensed === true && !licenseAccepted.value) {
    licenseNeeded.value = true;
    error.value = 'La raccolta di questo ruolo non ha una licenza alla radice: leggi l’avviso qui sopra e conferma, poi premi di nuovo «Crea spento».';
    return;
  }
  proposal.value = prepared;
}

/** Back where a refused field can be changed: the permissions on the first step, the texts on the second. */
function stepOf(cause: unknown): number {
  const message = cause instanceof UserAgentApiError ? cause.message : '';
  return /^permissions|not allowed|max_?(steps|minutes|Steps|Minutes)/.test(message) ? 0 : 1;
}

/** "Crea disattivato": the core says what the card will be; nothing is written yet. */
async function prepare(): Promise<void> {
  if (!reachable(STEPS.length) || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await prepareShown();
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    if (cause instanceof UserAgentApiError && (cause.status === 409 || cause.status === 400)) step.value = stepOf(cause);
  } finally {
    busy.value = false;
  }
}

async function create(): Promise<void> {
  const shown = proposal.value;
  if (shown === null || busy.value) return;
  busy.value = true;
  error.value = '';
  characterNote.value = '';
  let agent: UserAgentView;
  try {
    agent = await (fromCatalog.value ? createCatalogAgent(catalogInput(), shown.confirmation, licenseAccepted.value) : createUserAgent(input(), shown.confirmation));
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    // Expired or changed: the core shows the card again, with a new confirmation; still busy meanwhile, the old id is spent.
    if (cause instanceof UserAgentApiError && cause.status === 409 && /prepare the change again/.test(cause.message)) {
      try {
        proposal.value = await prepareAny();
      } catch (again) {
        proposal.value = null;
        error.value = userAgentErrorText(again);
      } finally {
        busy.value = false;
      }
      return;
    }
    busy.value = false;
    proposal.value = null;
    // The name taken or a field refused: back where it can be changed.
    if (cause instanceof UserAgentApiError && (cause.status === 409 || cause.status === 400)) step.value = stepOf(cause);
    return;
  }
  proposal.value = null;
  created.value = agent;
  emit('changed');
  if (form.value.character !== '') {
    try {
      const view = await loadSettings();
      if (view.values === null || view.fingerprint === null) throw new Error('arianna.toml cannot be read');
      await saveSettings(view.fingerprint, { characters: { ...view.values.characters, [agent.name]: form.value.character } });
    } catch {
      characterNote.value = 'L’agente c’è, ma il personaggio non è stato salvato: generalo o caricalo di nuovo nella sua scheda, nella pagina Agenti.';
    }
  }
  busy.value = false;
}

/**
 * «Accendi ora» of an agent made from a role (D-196): the report of its role
 * is the one shown at step 1; with something to look at, still being read or
 * missing, one more confirmation first, never a block.
 */
const activating = ref<NonNullable<ReturnType<typeof activationAsk>> | null>(null);
const createdSafety = computed(() => (fromCatalog.value ? roleText.value?.safety : undefined));
const reportError = ref('');
function askActivation(): void {
  const ask = activationAsk(createdSafety.value, 'new');
  if (ask === undefined) void activate();
  else activating.value = ask;
}
// The report may still be read when the agent is created: read again until it arrives.
const poll = safetyPoll(
  () => loadAgentRole(roleId.value ?? ''),
  (read) => {
    if (roleId.value !== read.id) return false;
    roleText.value = read;
    return true;
  },
);
watch(created, (agent) => {
  if (agent !== null) poll.follow(roleText.value);
});
onBeforeUnmount(poll.stop);
const redoing = ref(false);
async function redo(): Promise<void> {
  const current = roleText.value;
  if (current === null || redoing.value) return;
  redoing.value = true;
  reportError.value = '';
  try {
    roleText.value = { ...current, safety: await redoSafetyReport({ role: current.id }) };
    poll.follow(roleText.value);
  } catch {
    // Its own line: the error of «Accendi ora» stays for turning it on.
    reportError.value = 'Il rapporto non è ripartito: riprova fra poco.';
  } finally {
    redoing.value = false;
  }
}

async function activate(): Promise<void> {
  const agent = created.value;
  if (agent === null || busy.value) return;
  activating.value = null;
  busy.value = true;
  error.value = '';
  try {
    created.value = await activateUserAgent(agent.name);
    emit('changed');
  } catch (cause) {
    error.value = userAgentErrorText(cause);
  } finally {
    busy.value = false;
  }
}

const INPUT = 'field w-full px-2.5 py-1.5 text-[14px] text-ink';

function another(): void {
  form.value = empty();
  roleId.value = null;
  role.value = null;
  roleText.value = null;
  licenseAccepted.value = false;
  licenseNeeded.value = false;
  proposal.value = null;
  created.value = null;
  characterNote.value = '';
  error.value = '';
  step.value = 0;
}
</script>


<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
      <header class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2.5">
          <h1 id="new-agent-title" class="text-[22px] font-semibold">Nuovo agente</h1>
          <span class="pill">Nasce spento</span>
          <a href="/impostazioni/agenti" class="ml-auto text-[14px] text-accent hover:underline" @click.prevent="emit('done')">Torna agli agenti</a>
        </div>
        <p class="max-w-[78ch] text-muted">
          Un agente nuovo nasce spento, fra i tuoi. Finché resta tuo vede al massimo dati di lavoro e modifica file solo in una copia protetta, qualunque cosa dica la sua scheda. Lo accendi tu,
          qui alla fine o dalla pagina Agenti.
        </p>
      </header>
      <p v-if="loadError" role="alert" class="rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2 text-[14px]">{{ loadError }} Ricarica la pagina per riprovare.</p>

      <!-- Created: what now -->
      <section v-if="created" class="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4" aria-labelledby="created-title" aria-live="polite">
        <div class="flex items-center gap-3">
          <PixelAgent :choice="preview" pose="idle" :scale="2" :version="sheetVersion" />
          <div class="flex flex-col gap-1">
            <h2 id="created-title" class="text-[16px] font-semibold">{{ created.name }}</h2>
            <p class="text-[14px]">{{ created.state === 'active' ? 'Creato e acceso.' : 'Creato, spento.' }} {{ created.description }}</p>
            <p class="text-[13px] text-muted">{{ created.state === 'active' ? `Da ora ${workText(created.works)}.` : `Quando lo accendi, ${workText(created.works)}.` }}</p>
          </div>
        </div>
        <!-- The safety report of its role (D-196) beside the choice of turning it on now -->
        <SafetyReportCard v-if="createdSafety" :safety="createdSafety" :redoing="redoing" @redo="redo" />
        <p v-if="reportError" class="text-[13px] text-warn" role="alert">{{ reportError }}</p>
        <p v-if="characterNote" class="text-[13px] text-warn" role="alert">{{ characterNote }}</p>
        <p v-if="error" class="text-[13px] text-danger" role="alert">{{ error }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn px-3 py-1.5 text-[14px]" @click="another">Crea un altro</button>
          <button type="button" class="btn px-3 py-1.5 text-[14px]" @click="emit('done')">Torna agli agenti</button>
          <button v-if="created.state === 'disabled'" type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy" @click="askActivation">
            {{ error ? 'Riprova ad accenderlo' : activationAsk(createdSafety, 'new') === undefined ? 'Accendi ora' : `${activationAsk(createdSafety, 'new')?.action}…` }}
          </button>
        </div>
      </section>

      <template v-else>
        <!-- The three steps: an earlier one is always reachable, a later one when the ones before are complete -->
        <nav aria-label="Passi">
          <ol class="flex flex-wrap gap-1 border-b border-line">
            <li v-for="(title, index) in STEPS" :key="title">
              <button
                type="button"
                class="-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[14px] disabled:opacity-50 touch:min-h-11"
                :class="index === step ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'"
                :aria-current="index === step ? 'step' : undefined"
                :disabled="!reachable(index)"
                @click="go(index)"
              >
                <span class="grid size-5 place-items-center rounded-full border border-current text-[12px]">{{ index + 1 }}</span>{{ title }}
              </button>
            </li>
          </ol>
        </nav>

        <!-- 1. What it does: a starting point, then the permissions within the list (tappa T3b) -->
        <section v-if="step === 0" class="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4" :aria-labelledby="fromCatalog && role === null ? 'step-origin' : 'step-permissions'">
          <!-- Where it starts from (D-079, tappa 3): from scratch, or from a role of the catalog of agents -->
          <template v-if="sources?.catalog">
            <h2 id="step-origin" class="text-[16px] font-semibold">Da dove parti</h2>
            <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2" role="group" aria-label="Da dove parti">
              <button
                type="button"
                class="flex flex-col gap-1.5 rounded-[10px] border p-3 text-left text-[14px] touch:min-h-11"
                :class="!fromCatalog ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:border-line-strong'"
                :aria-pressed="!fromCatalog"
                @click="chooseOrigin('scratch')"
              >
                <span class="font-semibold">Da zero</span>
                <span class="text-[13px] text-muted">Scegli un punto di partenza e scrivi tu nome, descrizione e prompt.</span>
              </button>
              <button
                type="button"
                class="flex flex-col gap-1.5 rounded-[10px] border p-3 text-left text-[14px] touch:min-h-11"
                :class="fromCatalog ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:border-line-strong'"
                :aria-pressed="fromCatalog"
                @click="chooseOrigin('catalog')"
              >
                <span class="font-semibold">Dal catalogo</span>
                <span class="text-[13px] text-muted">Prendi un ruolo pronto da una raccolta che segui. Il prompt è il suo testo, i permessi li scegli tu come sempre.</span>
              </button>
            </div>
          </template>
          <template v-if="fromCatalog">
            <CatalogRolePicker v-model="roleId" @role="onRole" @settings="openCatalogSettings" />
            <template v-if="role !== null && sources">
              <h2 id="step-permissions" class="text-[16px] font-semibold">Cosa fa</h2>
              <p class="text-[14px] text-muted">
                I permessi partono da quelli della divisione del ruolo; cambiali dentro quello che è ammesso per gli agenti nuovi. Il prompt resta il testo del ruolo, a L0: l’agente vede al massimo
                dati di lavoro.
              </p>
              <PermissionsPicker v-model="form.permissions" :sources="sources" id-prefix="new-agent" />
            </template>
          </template>
          <template v-else>
          <h2 id="step-permissions" class="text-[16px] font-semibold">Cosa fa</h2>
          <p class="text-[14px] text-muted">
            Parti da un modello e cambia ciò che vuoi, dentro quello che è ammesso per gli agenti nuovi. Prima di crearlo la pagina ti mostra cosa potrà fare, e l’agente nasce solo con la tua
            conferma.
          </p>
          <fieldset class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <legend class="sr-only">Punto di partenza</legend>
            <label
              v-for="id in presets"
              :key="id"
              class="flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-3 text-[14px] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
              :class="form.preset === id ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:border-line-strong'"
            >
              <input type="radio" name="preset" :value="id" :checked="form.preset === id" class="sr-only" @change="choosePreset(id)" />
              <span class="font-semibold">{{ PRESET_TEXT[id]?.title ?? id }}<span v-if="form.preset === id && !asPreset" class="ml-1.5 text-[13px] font-normal text-muted">(cambiato)</span></span>
              <span class="text-[13px] text-muted">{{ PRESET_TEXT[id]?.text }}</span>
            </label>
          </fieldset>
          <PermissionsPicker v-if="sources" v-model="form.permissions" :sources="sources" id-prefix="new-agent" />
          <p class="text-[13px] text-muted">Vede al massimo dati di lavoro, come il prompt che gli scrivi. Mai lavori passati ad altri agenti, messaggi fuori dal Mac o azioni che chiedono approvazione.</p>
          </template>
        </section>

        <!-- 2. Who it is: name, description, prompt -->
        <section v-else-if="step === 1" class="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4" aria-labelledby="step-who">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id="step-who" class="text-[16px] font-semibold">Chi è</h2>
            <span class="pill">{{ form.permissions.executor === 'claude' ? 'Lavora con Claude' : 'Lavora sul Mac' }}</span>
            <button v-if="text && exampleUseful && !fromCatalog" type="button" class="btn ml-auto px-2.5 py-1 text-[13px]" @click="useExample">Completa con l’esempio</button>
          </div>
          <div class="grid gap-3 sm:grid-cols-6">
            <FormField
              id="new-agent-name"
              label="Nome"
              :hint="fromCatalog ? 'Parte dal nome del file del ruolo; se c’è già un agente con questo nome scegline un altro.' : 'Minuscole, cifre e trattini: si usa anche per i suoi file.'"
              :span="2"
            >
              <input id="new-agent-name" v-model.trim="form.name" :class="INPUT" maxlength="40" :placeholder="text?.example.name" autocomplete="off" />
            </FormField>
            <!-- A role of the catalog: description and prompt are the role's, read only -->
            <div v-if="fromCatalog && role" class="flex flex-col gap-1.5 text-[14px] sm:col-span-4">
              <p class="font-medium">{{ role.name }} <span class="text-[13px] font-normal text-muted">· {{ role.source }}</span></p>
              <p class="text-[13px] text-muted">{{ role.description }}</p>
              <p class="text-[13px] text-muted">
                La descrizione della scheda dirà da quale raccolta viene il ruolo e con quale licenza; il prompt è il testo del ruolo, fra due marcatori, come dato.
              </p>
            </div>
            <FormField v-if="!fromCatalog" id="new-agent-description" label="Descrizione" hint="Una riga: Arianna la legge per scegliere a chi passare un lavoro." :span="4">
              <input id="new-agent-description" v-model="form.description" :class="INPUT" maxlength="200" :placeholder="text?.example.description" />
            </FormField>
            <FormField
              v-if="!fromCatalog"
              id="new-agent-prompt"
              label="Prompt: cosa fa e come"
              :problem="form.prompt.length > MAX_USER_PROMPT ? `Troppo lungo: ${lengthText(form.prompt.length, MAX_USER_PROMPT)}.` : undefined"
              :hint="`Scrivilo come istruzioni a un collega: cosa riceve, cosa deve fare, come deve rispondere. Lui non vede la chat. ${lengthText(form.prompt.length, MAX_USER_PROMPT)}.`"
              :span="6"
            >
              <textarea id="new-agent-prompt" v-model="form.prompt" rows="9" :class="INPUT" :maxlength="MAX_USER_PROMPT" :placeholder="text?.example.prompt" />
            </FormField>
          </div>
          <p class="flex items-start gap-2 text-[13px] text-warn">
            <Icon name="gateway" :size="14" class="mt-0.5 shrink-0" />
            Nome, descrizione e prompt contano come dati di lavoro e possono arrivare a Claude: non scriverci nomi di clienti, importi o password. Un testo con IBAN, codici fiscali, carte o chiavi
            viene rifiutato.
          </p>
        </section>

        <!-- 3. How it looks, and what will be created -->
        <section v-else class="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4" aria-labelledby="step-look">
          <h2 id="step-look" class="text-[16px] font-semibold">Aspetto</h2>
          <div class="flex flex-wrap items-center gap-4">
            <div class="flex items-end gap-3 rounded-[10px] border border-line bg-surface px-4 py-3">
              <PixelAgent :choice="preview" pose="idle" :scale="2" :version="sheetVersion" />
              <PixelAgent :choice="preview" pose="working" :scale="2" :version="sheetVersion" />
            </div>
            <!-- The character comes from Genera personaggio or Carica PNG below; a chosen one can go back to the default. -->
            <button v-if="form.character !== ''" type="button" class="btn px-2.5 py-1 text-[13px]" @click="form.character = ''">Torna al predefinito</button>
          </div>
          <CharacterGenerate
            :agent-label="form.name || 'il nuovo agente'"
            :name="form.name"
            :description="form.description"
            :prompt="form.prompt"
            keep="si tiene con «Crea spento»"
            @uploaded="onUploaded"
          />
          <CharacterUpload :agent-label="form.name || 'il nuovo agente'" keep="si tiene con «Crea spento»" @uploaded="onUploaded" />

          <div class="flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface p-3 text-[14px]">
            <p class="text-[13px] font-medium text-muted">Cosa verrà creato</p>
            <p><b class="font-semibold">{{ form.name }}</b> · {{ form.description.trim() }}</p>
            <p class="text-[13px] text-muted">«Crea spento» ti mostra prima i permessi e cosa può uscire verso Claude.</p>
            <p class="line-clamp-3 text-[13px] whitespace-pre-line text-muted">{{ form.prompt.trim() }}</p>
            <p v-if="fromCatalog && role" class="text-[13px] text-muted">Ruolo di terzi da {{ role.source }}: la scheda ne riporta provenienza e licenza, e nasce spenta.</p>
          </div>
          <!-- A source without a license (choice of the user, 2026-10-13): a warning and the user's yes, never a block -->
          <div v-if="unlicensed" class="flex flex-col gap-2 rounded-[10px] border border-warn/60 bg-warn/10 p-3 text-[14px]" role="alert">
            <p class="font-semibold">La raccolta {{ role?.source }} non ha una licenza alla radice</p>
            <p class="text-[13px]">
              Senza licenza i diritti sul testo restano ai suoi autori: usarlo come prompt di un tuo agente è una scelta tua. L’avviso resterà scritto nella scheda dell’agente.
            </p>
            <label class="flex items-start gap-2 text-[13px]">
              <input v-model="licenseAccepted" type="checkbox" class="mt-0.5" />
              Ho letto l’avviso e voglio usare comunque questo ruolo
            </label>
          </div>
        </section>

        <p v-if="error" class="text-[13px] text-danger" role="alert">{{ error }}</p>
        <p v-else-if="problemOf(step)" class="text-[13px] text-muted">{{ problemOf(step) }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn px-3 py-1.5 text-[14px]" @click="emit('done')">Annulla</button>
          <button v-if="step > 0" type="button" class="btn px-3 py-1.5 text-[14px]" @click="go(step - 1)">Indietro</button>
          <button v-if="step < STEPS.length - 1" type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="problemOf(step) !== ''" @click="go(step + 1)">Avanti</button>
          <button v-else type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy || !reachable(STEPS.length)" @click="prepare">Crea spento</button>
        </div>
        <PermissionConfirm v-if="proposal" :proposal="proposal" :busy="busy" :error="error" action="Conferma e crea" @confirm="create" @cancel="proposal = null; error = ''" />
      </template>
    </div>
    <!-- Turning on an agent whose role has something to look at, is still read or has no report (D-196): one more confirmation, never a block -->
    <div v-if="activating" class="phone-overlay-bottom fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="new-activate-title">
      <div class="phone-sheet-bottom flex max-w-lg flex-col gap-3 rounded-xl border border-warn bg-surface-2 p-4 phone:w-full">
        <h2 id="new-activate-title" class="text-[16px] font-semibold">{{ activating.title }}</h2>
        <p class="text-[14px]">{{ activating.text }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="activating = null">Annulla</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-[13px]" :disabled="busy" @click="activate">{{ activating.action }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

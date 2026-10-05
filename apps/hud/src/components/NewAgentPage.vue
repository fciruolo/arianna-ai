<script setup lang="ts">
/**
 * "Nuovo agente" (D-119, tappa T3): a page of its own, in three steps. What
 * the agent does (its permissions, chosen within the list from a starting
 * point, tappa T3b), who it is (name, description and prompt, with an
 * example), how it looks (a character, or a PNG uploaded here); then "Crea
 * disattivato", which shows what the card will allow and writes it only on
 * the user's confirmation. The core checks everything again. The character
 * goes into [characters] of arianna.toml right after the card: if that
 * fails, the agent exists anyway and the page says where to choose it.
 */
import { computed, onMounted, ref } from 'vue';

import { loadCharacters, loadSettings, saveSettings, type UploadedCharacter } from '../lib/api.ts';
import type { CharacterChoice, CharacterListing } from '../lib/types.ts';
import {
  activateUserAgent,
  createUserAgent,
  loadSources,
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
import CharacterGenerate from './CharacterGenerate.vue';
import CharacterUpload from './CharacterUpload.vue';
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
  if (index === 0) return sources.value === null ? 'Leggo i permessi ammessi…' : '';
  if (index === 1) return nameProblem.value || descriptionProblem.value || promptProblem.value;
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
    proposal.value = await prepareUserAgent(input());
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
    agent = await createUserAgent(input(), shown.confirmation);
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    // Expired or changed: the core shows the card again, with a new confirmation; still busy meanwhile, the old id is spent.
    if (cause instanceof UserAgentApiError && cause.status === 409 && /prepare the change again/.test(cause.message)) {
      try {
        proposal.value = await prepareUserAgent(input());
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
      characterNote.value = 'L’agente c’è, ma il personaggio non è stato salvato: sceglilo nella sua scheda, nella pagina Agenti.';
    }
  }
  busy.value = false;
}

async function activate(): Promise<void> {
  const agent = created.value;
  if (agent === null || busy.value) return;
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

function another(): void {
  form.value = empty();
  proposal.value = null;
  created.value = null;
  characterNote.value = '';
  error.value = '';
  step.value = 0;
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[860px] flex-col gap-5 px-4 pt-5 pb-10 md:px-6">
      <section class="hud-card p-4" aria-labelledby="new-agent-title">
        <div class="flex flex-wrap items-center gap-2">
          <Icon name="office" :size="16" />
          <h1 id="new-agent-title" class="font-hud text-[15px] font-semibold tracking-[0.12em] uppercase">Nuovo agente</h1>
          <a href="/impostazioni/agenti" class="ml-auto text-xs text-accent hover:underline" @click.prevent="emit('done')">Torna agli agenti</a>
        </div>
        <p class="mt-2 text-[13px] text-muted">
          Un agente nuovo nasce disattivato in <code class="font-mono">data/agents</code>, fuori da git. Finché resta lì vede al massimo dati di lavoro (L1) e agisce solo nella sandbox (A1),
          qualunque cosa dica la sua scheda. Lo attivi tu, qui alla fine o dalla pagina Agenti.
        </p>
        <p v-if="loadError" role="alert" class="mt-3 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ loadError }}</p>
      </section>

      <!-- Created: what now -->
      <section v-if="created" class="hud-card flex flex-col gap-3 p-4" aria-labelledby="created-title" aria-live="polite">
        <div class="flex items-center gap-3">
          <PixelAgent :choice="preview" pose="idle" :scale="2" :version="sheetVersion" />
          <div class="flex flex-col gap-1">
            <h2 id="created-title" class="hud-title font-mono">{{ created.name }}</h2>
            <p class="text-[13px]">{{ created.state === 'active' ? 'Creato e attivo.' : 'Creato, disattivato.' }} {{ created.description }}</p>
            <p class="text-xs text-muted">{{ created.state === 'active' ? `Da ora ${workText(created.works)}.` : `Quando lo attivi, ${workText(created.works)}.` }}</p>
          </div>
        </div>
        <p v-if="characterNote" class="text-xs text-warn" role="alert">{{ characterNote }}</p>
        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="another">Crea un altro</button>
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="emit('done')">Torna agli agenti</button>
          <button v-if="created.state === 'disabled'" type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy" @click="activate">Attiva ora</button>
        </div>
      </section>

      <template v-else>
        <!-- The three steps: an earlier one is always reachable, a later one when the ones before are complete -->
        <nav aria-label="Passi">
          <ol class="flex flex-wrap gap-2">
            <li v-for="(title, index) in STEPS" :key="title">
              <button
                type="button"
                class="btn flex items-center gap-2 px-2.5 py-1 text-xs"
                :class="index === step ? 'btn-primary' : ''"
                :aria-current="index === step ? 'step' : undefined"
                :disabled="!reachable(index)"
                @click="go(index)"
              >
                <span class="font-mono">{{ index + 1 }}</span>{{ title }}
              </button>
            </li>
          </ol>
        </nav>

        <!-- 1. What it does: a starting point, then the permissions within the list (tappa T3b) -->
        <section v-if="step === 0" class="hud-card flex flex-col gap-3 p-4" aria-labelledby="step-permissions">
          <h2 id="step-permissions" class="hud-title">Cosa fa</h2>
          <p class="text-xs text-muted">
            Parti da un modello e cambia ciò che vuoi, dentro l’elenco ammesso per gli agenti nuovi. Prima di creare l’agente la pagina ti mostra cosa potrà fare, e la scheda si scrive solo con la
            tua conferma.
          </p>
          <fieldset class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <legend class="sr-only">Punto di partenza</legend>
            <label
              v-for="id in presets"
              :key="id"
              class="flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-3 text-[13px] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
              :class="form.preset === id ? 'border-accent bg-accent/10' : 'border-line bg-surface-2 hover:border-line-strong'"
            >
              <input type="radio" name="preset" :value="id" :checked="form.preset === id" class="sr-only" @change="choosePreset(id)" />
              <span class="font-semibold">{{ PRESET_TEXT[id]?.title ?? id }}<span v-if="form.preset === id && !asPreset" class="ml-1.5 text-xs font-normal text-muted">(cambiato)</span></span>
              <span class="text-xs text-muted">{{ PRESET_TEXT[id]?.text }}</span>
            </label>
          </fieldset>
          <PermissionsPicker v-if="sources" v-model="form.permissions" :sources="sources" id-prefix="new-agent" />
          <p class="text-xs text-muted">Dati che legge: al massimo dati di lavoro (L1), come il prompt che gli scrivi. Mai deleghe ad altri agenti, canali esterni o azioni che chiedono approvazione.</p>
        </section>

        <!-- 2. Who it is: name, description, prompt -->
        <section v-else-if="step === 1" class="hud-card flex flex-col gap-3 p-4" aria-labelledby="step-who">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id="step-who" class="hud-title">Chi è</h2>
            <span class="chip">{{ form.permissions.executor === 'claude' ? 'Claude Code' : 'modello locale' }}</span>
            <button v-if="text && exampleUseful" type="button" class="btn ml-auto px-2.5 py-1 text-xs" @click="useExample">Completa con l’esempio</button>
          </div>
          <div class="grid grid-cols-1 gap-x-3.5 gap-y-2.5 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-xs text-muted">
              Nome (si usa anche per i file)
              <input v-model.trim="form.name" class="field px-2 py-1.5 font-mono text-[13px] text-ink" maxlength="40" :placeholder="text?.example.name" autocomplete="off" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">
              Descrizione (una riga: Arianna la legge per scegliere a chi passare un lavoro)
              <input v-model="form.description" class="field px-2 py-1.5 text-[13px] text-ink" maxlength="200" :placeholder="text?.example.description" />
            </label>
          </div>
          <label class="flex flex-col gap-1 text-xs text-muted">
            <span class="flex gap-2"
              >Prompt: cosa fa e come<span class="ml-auto font-mono" :class="form.prompt.length > MAX_USER_PROMPT ? 'text-danger' : ''">{{ form.prompt.length }}/{{ MAX_USER_PROMPT }}</span></span
            >
            <textarea v-model="form.prompt" rows="9" class="field px-2 py-1.5 text-[13px] text-ink" :maxlength="MAX_USER_PROMPT" :placeholder="text?.example.prompt" />
          </label>
          <p class="text-xs text-muted">
            Scrivi il prompt come istruzioni a un collega: cosa riceve, cosa deve fare, come deve rispondere. Arianna gli passa ogni volta un incarico con quello che serve; lui non vede la chat.
          </p>
          <p class="flex items-start gap-2 text-xs text-warn">
            <Icon name="gateway" :size="14" class="mt-px" />
            Nome, descrizione e prompt valgono come L1 per tua dichiarazione e possono arrivare a un esecutore cloud: non scriverci dati personali. Un testo con IBAN, codici fiscali, carte,
            chiavi o valori del vault viene rifiutato.
          </p>
        </section>

        <!-- 3. How it looks, and what will be created -->
        <section v-else class="hud-card flex flex-col gap-3 p-4" aria-labelledby="step-look">
          <h2 id="step-look" class="hud-title">Aspetto</h2>
          <div class="flex flex-wrap items-center gap-4">
            <div class="flex items-end gap-3 rounded-[10px] border border-line bg-surface-2 px-4 py-3">
              <PixelAgent :choice="preview" pose="idle" :scale="2" :version="sheetVersion" />
              <PixelAgent :choice="preview" pose="working" :scale="2" :version="sheetVersion" />
            </div>
            <label class="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-muted">
              Personaggio
              <select v-model="form.character" class="field px-2 py-1.5 text-[13px] text-ink">
                <option value="">predefinito (quello del Coder)</option>
                <option v-for="option in characterOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
          </div>
          <CharacterGenerate
            :agent-label="form.name || 'il nuovo agente'"
            :name="form.name"
            :description="form.description"
            :prompt="form.prompt"
            keep="si tiene con «Crea disattivato»"
            @uploaded="onUploaded"
          />
          <CharacterUpload :agent-label="form.name || 'il nuovo agente'" keep="si tiene con «Crea disattivato»" @uploaded="onUploaded" />

          <div class="flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface-2 p-3 text-[13px]">
            <p class="text-xs text-muted">Cosa verrà creato</p>
            <p><span class="font-mono">{{ form.name }}</span> · {{ form.description.trim() }}</p>
            <p class="text-xs text-muted">«Crea disattivato» ti mostra prima i permessi, la trifecta e cosa esce verso il cloud.</p>
            <p class="line-clamp-3 text-xs whitespace-pre-line text-muted">{{ form.prompt.trim() }}</p>
          </div>
        </section>

        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <p v-else-if="problemOf(step)" class="text-xs text-muted">{{ problemOf(step) }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="emit('done')">Annulla</button>
          <button v-if="step > 0" type="button" class="btn px-2.5 py-1 text-xs" @click="go(step - 1)">Indietro</button>
          <button v-if="step < STEPS.length - 1" type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="problemOf(step) !== ''" @click="go(step + 1)">Avanti</button>
          <button v-else type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy || !reachable(STEPS.length)" @click="prepare">Crea disattivato</button>
        </div>
        <PermissionConfirm v-if="proposal" :proposal="proposal" :busy="busy" :error="error" action="Conferma e crea" @confirm="create" @cancel="proposal = null; error = ''" />
      </template>
    </div>
  </div>
</template>

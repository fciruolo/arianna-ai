<script setup lang="ts">
/**
 * The agents the user creates (D-119, tappa T2): a new card from a template,
 * activation, deactivation and promotion to official. A first, small page:
 * the full "Nuovo agente" page is tappa T3.
 */
import { computed, onMounted, ref } from 'vue';

import { agentName } from '../lib/italian.ts';
import {
  activateUserAgent,
  createUserAgent,
  deactivateUserAgent,
  listUserAgents,
  loadTemplates,
  MAX_USER_PROMPT,
  permissionLines,
  promoteUserAgent,
  TEMPLATE_TEXT,
  USER_AGENT_NAME,
  userAgentErrorText,
  type TemplateSource,
  type UserAgentListing,
  type UserAgentView,
} from '../lib/user-agents.ts';

const emit = defineEmits<{ changed: [] }>();

const listing = ref<UserAgentListing | null>(null);
const templates = ref<TemplateSource[]>([]);
const loadError = ref('');
const busy = ref('');
const error = ref('');
const open = ref<string | null>(null);
const promoting = ref<UserAgentView | null>(null);

const creating = ref(false);
const form = ref({ name: '', description: '', template: 'answer', prompt: '' });
const formError = ref('');
const chosenTemplate = computed(() => templates.value.find((template) => template.id === form.value.template));
const formProblem = computed(() => {
  if (!USER_AGENT_NAME.test(form.value.name)) return 'Nome: da 2 a 40 caratteri, minuscole, cifre e trattini.';
  if (form.value.description.trim() === '') return 'Scrivi una descrizione di una riga.';
  if (form.value.prompt.trim() === '') return 'Scrivi il prompt: cosa fa l’agente e come.';
  if (form.value.prompt.length > MAX_USER_PROMPT) return `Il prompt supera ${String(MAX_USER_PROMPT)} caratteri.`;
  return '';
});

const STATE_TEXT = { active: 'attivo', disabled: 'disattivato', official: 'ufficiale' } as const;
const STATE_CLASS = { active: 'text-ok', disabled: 'text-muted', official: 'text-accent' } as const;
const FOLDER_TEXT = { active: 'attivi', disabled: 'disattivati' } as const;

async function load(): Promise<void> {
  try {
    [listing.value, templates.value] = await Promise.all([listUserAgents(), loadTemplates()]);
    loadError.value = '';
  } catch (cause) {
    loadError.value = userAgentErrorText(cause);
  }
}
onMounted(() => void load());

async function run(name: string, action: () => Promise<unknown>): Promise<boolean> {
  busy.value = name;
  error.value = '';
  try {
    await action();
    await load();
    emit('changed');
    return true;
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    return false;
  } finally {
    busy.value = '';
  }
}

async function create(): Promise<void> {
  if (formProblem.value !== '') return;
  busy.value = 'nuovo';
  formError.value = '';
  try {
    await createUserAgent({ ...form.value });
    form.value = { name: '', description: '', template: 'answer', prompt: '' };
    creating.value = false;
    await load();
  } catch (cause) {
    formError.value = userAgentErrorText(cause);
  } finally {
    busy.value = '';
  }
}

async function promote(): Promise<void> {
  const agent = promoting.value;
  if (agent === null) return;
  if (await run(agent.name, () => promoteUserAgent(agent.name))) promoting.value = null;
}
</script>

<template>
  <section id="user-agents" class="hud-card" aria-labelledby="user-agents-title">
    <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <h2 id="user-agents-title" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] uppercase">Agenti nuovi</h2>
      <button v-if="!creating" type="button" class="btn btn-primary px-2.5 py-1 text-xs" @click="creating = true">Nuovo da modello</button>
    </header>
    <div class="flex flex-col gap-3 p-4">
      <p class="text-xs text-muted">
        Un agente creato qui nasce disattivato, in <code class="font-mono">data/agents</code>, fuori da git. Finché resta lì vede al massimo dati di lavoro (L1) e agisce solo nella sandbox (A1),
        qualunque cosa dica la sua scheda. Strumenti e permessi vengono dal modello scelto: una scheda modificata a mano oltre il suo modello non si carica.
      </p>
      <p v-if="loadError" class="text-xs text-danger" role="alert">{{ loadError }}</p>
      <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>

      <!-- New agent from a template -->
      <form v-if="creating" class="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface-2 p-3" @submit.prevent="create">
        <div class="grid grid-cols-1 gap-x-3.5 gap-y-2.5 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-xs text-muted">
            Nome (si usa anche per i file)
            <input v-model.trim="form.name" class="field px-2 py-1.5 font-mono text-[13px] text-ink" maxlength="40" placeholder="traduttore" autocomplete="off" />
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Modello
            <select v-model="form.template" class="field px-2 py-1.5 text-[13px] text-ink">
              <option v-for="template in templates" :key="template.id" :value="template.id">{{ TEMPLATE_TEXT[template.id]?.title ?? template.id }}</option>
            </select>
          </label>
        </div>
        <p v-if="chosenTemplate" class="text-xs text-muted">{{ TEMPLATE_TEXT[chosenTemplate.id]?.text }}</p>
        <ul v-if="chosenTemplate" class="list-disc pl-5 text-xs text-muted">
          <li v-for="line in permissionLines(chosenTemplate)" :key="line">{{ line }}</li>
        </ul>
        <label class="flex flex-col gap-1 text-xs text-muted">
          Descrizione (una riga)
          <input v-model="form.description" class="field px-2 py-1.5 text-[13px] text-ink" maxlength="200" placeholder="Traduce le note di rilascio in italiano" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          <span class="flex">Prompt: cosa fa e come <span class="ml-auto font-mono">{{ form.prompt.length }}/{{ MAX_USER_PROMPT }}</span></span>
          <textarea v-model="form.prompt" rows="6" class="field px-2 py-1.5 text-[13px] text-ink" :maxlength="MAX_USER_PROMPT" placeholder="Traduci in italiano i testi che ti passo, mantenendo il tono originale." />
        </label>
        <p class="text-xs text-muted">
          Nome, descrizione e prompt valgono come L1 per tua dichiarazione e possono arrivare a un esecutore cloud: non scriverci dati personali. Un testo con IBAN, codici fiscali, carte,
          chiavi o valori del vault viene rifiutato.
        </p>
        <p v-if="formError || formProblem" class="text-xs" :class="formError ? 'text-danger' : 'text-muted'" role="alert">{{ formError || formProblem }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="creating = false; formError = ''">Annulla</button>
          <button type="submit" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="formProblem !== '' || busy === 'nuovo'">Crea disattivato</button>
        </div>
      </form>

      <!-- The user's agents -->
      <p v-if="listing && listing.user.length === 0 && !creating" class="text-xs text-muted">Nessun agente nuovo, per ora.</p>
      <div v-for="agent in listing?.user ?? []" :key="agent.name" class="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 p-3">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="hud-title font-mono">{{ agent.name }}</h3>
          <span class="chip" :class="STATE_CLASS[agent.state]">{{ STATE_TEXT[agent.state] }}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ agent.description }}</span>
          <button type="button" class="btn px-2.5 py-1 text-xs" :aria-expanded="open === agent.name" @click="open = open === agent.name ? null : agent.name">Permessi</button>
          <button v-if="agent.state === 'disabled'" type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="run(agent.name, () => activateUserAgent(agent.name))">Attiva</button>
          <button v-else type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="run(agent.name, () => deactivateUserAgent(agent.name))">Disattiva</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="promoting = agent">Promuovi a ufficiale…</button>
        </div>
        <ul v-if="open === agent.name" class="list-disc pl-5 text-xs text-muted">
          <li v-for="line in permissionLines(agent.card)" :key="line">{{ line }}</li>
          <li>Tetto finché resta in <code class="font-mono">data/agents</code>: al massimo L1 e A1</li>
        </ul>
      </div>

      <!-- Cards that could not be read: never loaded -->
      <div v-for="item in listing?.refused ?? []" :key="`${item.state}-${item.name}`" class="rounded-[10px] border border-danger/50 px-3 py-2 text-xs">
        <span class="font-mono">{{ item.name }}</span> (in {{ FOLDER_TEXT[item.state] }}) non caricato: <span class="font-mono text-muted">{{ item.reason }}</span>
      </div>

      <p v-if="listing" class="text-xs text-muted">
        Ufficiali, in <code class="font-mono">agents/</code>: {{ listing.official.map((agent) => agentName(agent.name)).join(', ') }}.
      </p>
    </div>

    <!-- Promotion: what changes, then the user's click -->
    <div v-if="promoting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="promote-title">
      <div class="hud-card warn flex max-w-lg flex-col gap-3 p-4">
        <h2 id="promote-title" class="font-hud text-[12px] font-semibold tracking-[0.14em] uppercase">Promuovere {{ promoting.name }} a ufficiale?</h2>
        <p class="text-[13px]">
          La scheda passa da <code class="font-mono">data/agents</code> a <code class="font-mono">agents/</code>, la cartella del repository in git, e l’agente diventa attivo. Cosa cambia:
        </p>
        <ul class="list-disc pl-5 text-[13px]">
          <li>il tetto L1 e A1 cade: valgono etichette, strumenti e azioni scritti nella scheda;</li>
          <li>oggi la scheda dice: {{ permissionLines(promoting.card).slice(0, 2).join('; ') }};</li>
          <li>chi modifica a mano <code class="font-mono">agents/{{ promoting.name }}.yaml</code> può dargli di più, fino a L2;</li>
          <li>i file risultano nuovi in git: un commit li rende visibili a chi ha il repository, e un push li pubblica.</li>
        </ul>
        <p class="text-xs text-muted">La promozione non si annulla da questa pagina: per tornare indietro si spostano a mano i due file in <code class="font-mono">data/agents/disattivati</code>.</p>
        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="promoting = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="promote">Promuovi</button>
        </div>
      </div>
    </div>
  </section>
</template>

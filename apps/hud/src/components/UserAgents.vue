<script setup lang="ts">
/**
 * The agents the user creates (D-119): the list with activation,
 * deactivation and promotion to official (tappa T2); description and prompt
 * changed in place, deletion of a disabled agent (its name typed as the
 * confirmation) and a promotion taken back (tappa T3); permissions changed
 * within the list, saved only after the confirmation of what changes
 * (tappa T3b). A new agent is made on a page of its own, "Nuovo agente".
 */
import { onMounted, ref } from 'vue';

import { agentName } from '../lib/italian.ts';
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
import PermissionConfirm from './PermissionConfirm.vue';
import PermissionsPicker from './PermissionsPicker.vue';

/** `newAgent`: open the page "Nuovo agente"; `changed`: an agent changed state, the rest of the page reads again. */
const emit = defineEmits<{ changed: []; newAgent: [] }>();

const listing = ref<UserAgentListing | null>(null);
const loadError = ref('');
const busy = ref('');
const error = ref('');
const open = ref<string | null>(null);
const promoting = ref<UserAgentView | null>(null);
const demoting = ref<UserAgentView | null>(null);
/** The agent to delete; `typed` must be its name. */
const deleting = ref<{ name: string; typed: string } | null>(null);
/** The agent being changed: texts with the prompt as the core has it, and its permissions (tappa T3b). */
const editing = ref<{ name: string; description: string; prompt: string; loaded: boolean; permissions: UserPermissions | null } | null>(null);
/** The change of permissions shown before it is saved. */
const confirming = ref<{ name: string; edit: UserAgentEdit; proposal: AgentProposal } | null>(null);
const sources = ref<UserAgentSources | null>(null);
const notice = ref('');

const STATE_TEXT = { active: 'attivo', disabled: 'disattivato', official: 'ufficiale' } as const;
const STATE_CLASS = { active: 'text-ok', disabled: 'text-muted', official: 'text-accent' } as const;
const FOLDER_TEXT = { active: 'attivi', disabled: 'disattivati' } as const;

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
    // Without the list the texts can still be changed; the permissions are not shown.
  }
});

async function run(name: string, action: () => Promise<unknown>): Promise<boolean> {
  busy.value = name;
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
    busy.value = '';
  }
}

async function promote(): Promise<void> {
  const agent = promoting.value;
  if (agent === null) return;
  if (await run(agent.name, () => promoteUserAgent(agent.name))) promoting.value = null;
}

async function demote(): Promise<void> {
  const agent = demoting.value;
  if (agent === null) return;
  if (await run(agent.name, () => demoteUserAgent(agent.name))) demoting.value = null;
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
    notice.value = `Eliminato: i due file sono in ${folder}, da cui si recuperano a mano.`;
  }
}

/** Opens the texts of `agent`: the prompt is read from the core's file, never kept by the list. */
async function startEdit(agent: UserAgentView): Promise<void> {
  editing.value = { name: agent.name, description: agent.description, prompt: '', loaded: false, permissions: agent.permissions === null ? null : { ...agent.permissions, tools: [...agent.permissions.tools] } };
  error.value = '';
  try {
    const prompt = await loadUserAgentPrompt(agent.name);
    // Another agent opened meanwhile: this answer is for nobody.
    if (editing.value?.name === agent.name) editing.value = { ...editing.value, prompt: prompt.trimEnd(), loaded: true };
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    if (editing.value?.name === agent.name) editing.value = null;
  }
}

/** Saves the texts at once; a change of permissions or labels first shows what changes (tappa T3b). */
async function saveEdit(): Promise<void> {
  const draft = editing.value;
  if (draft === null || !draft.loaded || busy.value !== '') return;
  const edit: UserAgentEdit = { description: draft.description.trim(), prompt: draft.prompt, ...(draft.permissions === null ? {} : { permissions: draft.permissions }) };
  busy.value = draft.name;
  error.value = '';
  let proposal: AgentProposal;
  try {
    proposal = await prepareUserAgentEdit(draft.name, edit);
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    busy.value = '';
    return;
  }
  busy.value = '';
  if (proposal.confirmation === null) await save(draft.name, edit, null);
  else confirming.value = { name: draft.name, edit, proposal };
}

/** Writes the edit; returns the error of the core, or null when it is saved. */
async function save(name: string, edit: UserAgentEdit, confirmation: string | null): Promise<unknown> {
  const changedPermissions = confirmation !== null;
  busy.value = name;
  error.value = '';
  notice.value = '';
  try {
    await editUserAgent(name, edit, confirmation);
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    busy.value = '';
    return cause;
  }
  editing.value = null;
  confirming.value = null;
  notice.value = changedPermissions ? `Salvato: ${name} usa i permessi e i testi nuovi dal prossimo lavoro.` : `Salvato: ${name} usa i testi nuovi dal prossimo lavoro.`;
  try {
    await load();
    emit('changed');
  } finally {
    busy.value = '';
  }
  return null;
}

async function confirmEdit(): Promise<void> {
  const shown = confirming.value;
  if (shown === null || busy.value !== '') return;
  const failure = await save(shown.name, shown.edit, shown.proposal.confirmation);
  if (failure === null) return;
  // Any other error: the window closes, the error stays on the page.
  if (!(failure instanceof UserAgentApiError && failure.status === 409 && /prepare the change again/.test(failure.message))) {
    confirming.value = null;
    return;
  }
  // Expired or changed meanwhile: shown again with a new confirmation, busy until it is there (the old id is spent).
  busy.value = shown.name;
  try {
    const again = await prepareUserAgentEdit(shown.name, shown.edit);
    confirming.value = { ...shown, proposal: again };
  } catch (cause) {
    error.value = userAgentErrorText(cause);
    confirming.value = null;
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <section id="user-agents" class="hud-card" aria-labelledby="user-agents-title">
    <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <h2 id="user-agents-title" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] uppercase">Agenti nuovi</h2>
      <a href="/impostazioni/agenti/nuovo" class="btn btn-primary px-2.5 py-1 text-xs" @click.prevent="emit('newAgent')">Nuovo agente</a>
    </header>
    <div class="flex flex-col gap-3 p-4">
      <p class="text-xs text-muted">
        Un agente creato qui nasce disattivato, in <code class="font-mono">data/agents</code>, fuori da git. Finché resta lì vede al massimo dati di lavoro (L1) e agisce solo nella sandbox (A1),
        qualunque cosa dica la sua scheda. Strumenti e permessi si scelgono dentro l’elenco ammesso, con «Modifica»: una scheda cambiata a mano oltre l’elenco non si carica. Da attivo,
        Arianna gli passa i lavori adatti a lui.
      </p>
      <p v-if="loadError" class="text-xs text-danger" role="alert">{{ loadError }}</p>
      <p v-if="error && !promoting && !demoting && !deleting && !confirming" class="text-xs text-danger" role="alert">{{ error }}</p>
      <p v-if="notice" class="text-xs text-ok" role="status">{{ notice }}</p>

      <!-- The user's agents -->
      <p v-if="listing && listing.user.length === 0" class="text-xs text-muted">Nessun agente nuovo, per ora.</p>
      <div v-for="agent in listing?.user ?? []" :key="agent.name" class="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 p-3">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="hud-title font-mono">{{ agent.name }}</h3>
          <span class="chip" :class="STATE_CLASS[agent.state]">{{ STATE_TEXT[agent.state] }}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ agent.description }}</span>
          <button type="button" class="btn px-2.5 py-1 text-xs" :aria-expanded="open === agent.name" @click="open = open === agent.name ? null : agent.name">Permessi</button>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy !== '' || editing?.name === agent.name" @click="startEdit(agent)">Modifica</button>
          <button v-if="agent.state === 'disabled'" type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="run(agent.name, () => activateUserAgent(agent.name))">Attiva</button>
          <button v-else type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="run(agent.name, () => deactivateUserAgent(agent.name))">Disattiva</button>
          <button v-if="agent.state === 'disabled'" type="button" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="deleting = { name: agent.name, typed: '' }; error = ''">Elimina…</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="promoting = agent; error = ''">Promuovi a ufficiale…</button>
        </div>
        <p class="text-xs" :class="agent.works === null ? 'text-warn' : 'text-muted'">{{ agent.state === 'active' ? 'Da attivo' : 'Quando è attivo' }} {{ workText(agent.works) }}.</p>
        <ul v-if="open === agent.name" class="list-disc pl-5 text-xs text-muted">
          <li v-for="line in permissionLines(agent.card)" :key="line">{{ line }}</li>
          <li>Tetto finché resta in <code class="font-mono">data/agents</code>: al massimo L1 e A1</li>
        </ul>

        <!-- Description and prompt, changed in place -->
        <form v-if="editing?.name === agent.name" class="flex flex-col gap-2.5 border-t border-line pt-2.5" @submit.prevent="saveEdit">
          <p v-if="!editing.loaded" class="text-xs text-muted">Leggo il prompt…</p>
          <template v-else>
            <label class="flex flex-col gap-1 text-xs text-muted">
              Descrizione (una riga)
              <input v-model="editing.description" class="field px-2 py-1.5 text-[13px] text-ink" maxlength="200" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">
              <span class="flex">Prompt <span class="ml-auto font-mono">{{ editing.prompt.length }}/{{ MAX_USER_PROMPT }}</span></span>
              <textarea v-model="editing.prompt" rows="8" class="field px-2 py-1.5 text-[13px] text-ink" :maxlength="MAX_USER_PROMPT" />
            </label>
            <div v-if="sources && editing.permissions" class="flex flex-col gap-2 rounded-[10px] border border-line p-3">
              <p class="text-xs text-muted">Permessi (un cambio ti mostra prima cosa cambia e si salva solo con la tua conferma)</p>
              <PermissionsPicker v-model="editing.permissions" :sources="sources" :id-prefix="`edit-${agent.name}`" />
            </div>
            <p class="text-xs text-muted">
              {{ agent.state === 'active' ? 'L’agente è attivo: i testi nuovi valgono dal prossimo lavoro che Arianna gli passa.' : 'Valgono da quando lo attivi.' }} Restano L1 per tua
              dichiarazione, possono arrivare a un esecutore cloud (non scriverci dati personali) e passano dagli stessi controlli della creazione.
            </p>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn px-2.5 py-1 text-xs" @click="editing = null; error = ''">Annulla</button>
              <button type="submit" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy !== '' || editing.description.trim() === '' || editing.prompt.trim() === ''">Salva</button>
            </div>
          </template>
        </form>
      </div>

      <!-- Cards that could not be read: never loaded; a disabled one can be deleted -->
      <div v-for="item in listing?.refused ?? []" :key="`${item.state}-${item.name}`" class="flex flex-wrap items-center gap-2 rounded-[10px] border border-danger/50 px-3 py-2 text-xs">
        <span class="min-w-0 flex-1">
          <span class="font-mono">{{ item.name }}</span> (in {{ FOLDER_TEXT[item.state] }}) non caricato: <span class="font-mono text-muted">{{ item.reason }}</span>
        </span>
        <button v-if="item.state === 'disabled'" type="button" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="deleting = { name: item.name, typed: '' }; error = ''">Elimina…</button>
      </div>

      <!-- Official agents: the ones born here can go back -->
      <div v-if="listing" class="flex flex-col gap-1.5 text-xs text-muted">
        <p>Ufficiali, in <code class="font-mono">agents/</code>: {{ listing.official.map((agent) => agentName(agent.name)).join(', ') }}.</p>
        <div v-for="agent in listing.official.filter((item) => item.fromPage)" :key="agent.name" class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-ink">{{ agent.name }}</span>
          <span>nato da questa pagina e promosso</span>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="demoting = agent; error = ''">Riporta fra i miei…</button>
        </div>
      </div>
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
        <p class="text-xs text-muted">Si torna indietro da questa pagina con «Riporta fra i miei», finché la scheda resta quella scritta qui.</p>
        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="promoting = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="promote">Promuovi</button>
        </div>
      </div>
    </div>

    <!-- A promotion taken back -->
    <div v-if="demoting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="demote-title">
      <div class="hud-card flex max-w-lg flex-col gap-3 p-4">
        <h2 id="demote-title" class="font-hud text-[12px] font-semibold tracking-[0.14em] uppercase">Riportare {{ demoting.name }} fra i tuoi agenti?</h2>
        <ul class="list-disc pl-5 text-[13px]">
          <li>la scheda torna in <code class="font-mono">data/agents/disattivati</code>, fuori da git, e l’agente si ferma: Arianna non gli passa più lavoro finché non lo riattivi;</li>
          <li>torna il tetto L1 e A1;</li>
          <li>se i file di <code class="font-mono">agents/{{ demoting.name }}</code> erano già in un commit, git li vedrà come tolti: il prossimo commit lo registra.</li>
        </ul>
        <p class="text-xs text-muted">Una scheda cambiata a mano oltre i permessi ammessi non può tornare: resta ufficiale.</p>
        <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="demoting = null; error = ''">Annulla</button>
          <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy !== ''" @click="demote">Riporta fra i miei</button>
        </div>
      </div>
    </div>

    <!-- A change of permissions: what changes, then the user's click -->
    <PermissionConfirm
      v-if="confirming"
      :proposal="confirming.proposal"
      :busy="busy !== ''"
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
          <button type="submit" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busy !== '' || deleting.typed !== deleting.name">Elimina</button>
        </div>
      </form>
    </div>
  </section>
</template>

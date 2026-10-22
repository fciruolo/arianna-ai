<script setup lang="ts">
/**
 * "Agenti da GitHub" in Impostazioni → Catalogo agenti (D-079): the catalog
 * of roles from the GitHub repositories the user follows, with the list of
 * sources of the skills (SourceList.vue). One download at a time: the others
 * wait in the queue. Only "Usa questa versione" adopts a version, and the
 * agents already made from a role do not change with it. The roles can be
 * searched and read here; making an agent from one comes with «+ Nuovo agente» (tappa 3).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  addAgentSource,
  adoptAgentSource,
  discardAgentSource,
  listAgentRoles,
  loadAgentRole,
  loadAgentsCatalog,
  removeAgentSource,
  updateAgentSource,
} from '../lib/api.ts';
import { agentsErrorText, divisionCounts, filterRoles, limitsText, roleLicenseText, shouldPollAgents, type AgentRoleListing, type AgentRoleText, type AgentsStatus } from '../lib/agents-catalog.ts';
import { redoSafetyReport } from '../lib/safety-report.ts';
import { useRoleTranslations } from '../lib/skill-translations.ts';
import { translationsNoteText } from '../lib/skills-catalog.ts';
import TranslatedText from './TranslatedText.vue';
import { safetyPoll } from '../lib/safety-poll.ts';
import { agentSourceRow } from '../lib/source-list.ts';
import SafetyReportCard from './SafetyReportCard.vue';
import SettingsCard from './SettingsCard.vue';
import SourceList from './SourceList.vue';

const status = ref<AgentsStatus | null>(null);
const error = ref('');
const acting = ref<string | null>(null);
let timer: number | undefined;
let mounted = true;

function schedule(): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (mounted && shouldPollAgents(status.value)) timer = window.setTimeout(() => void refresh(), 1500);
}

async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    status.value = await loadAgentsCatalog();
    error.value = '';
  } catch (cause) {
    error.value = agentsErrorText(cause);
  }
  schedule();
}
onMounted(refresh);
onBeforeUnmount(() => {
  mounted = false;
  window.clearTimeout(timer);
  poll.stop();
});

/** One action at a time; `key` marks the source (or the form) that waits. */
async function act(key: string, action: () => Promise<AgentsStatus>, listChanged = false): Promise<boolean> {
  if (acting.value !== null) return false;
  acting.value = key;
  error.value = '';
  try {
    status.value = await action();
    if (listChanged) {
      listing.value = null;
      if (browsing.value) void loadList();
    }
    return true;
  } catch (cause) {
    error.value = agentsErrorText(cause);
    return false;
  } finally {
    acting.value = null;
    schedule();
  }
}

const rows = computed(() => status.value?.sources.map(agentSourceRow) ?? null);
const list = ref<InstanceType<typeof SourceList> | null>(null);
async function add(address: string): Promise<void> {
  if (await act('add', () => addAgentSource(address))) list.value?.added();
}

// The roles of the versions in use
const listing = ref<AgentRoleListing | null>(null);
const listError = ref('');
const query = ref('');
const division = ref('');
const browsing = ref(false);
const divisions = computed(() => divisionCounts(listing.value?.roles ?? []));
// The descriptions in Italian (request of the user of 2026-10-13): asked when the list is read, the English one meanwhile.
const { status: translations, italian, open: openTranslations } = useRoleTranslations();
const shown = computed(() => filterRoles(listing.value?.roles ?? [], query.value, division.value, '', translations.value?.translations));
const total = computed(() => status.value?.sources.reduce((sum, source) => sum + (source.adopted?.roles ?? 0), 0) ?? 0);
async function loadList(): Promise<void> {
  try {
    listing.value = await listAgentRoles();
    listError.value = '';
    void openTranslations();
  } catch (cause) {
    listError.value = agentsErrorText(cause);
  }
}
function opened(event: Event): void {
  browsing.value = event.target instanceof HTMLDetailsElement && event.target.open;
  if (browsing.value && listing.value === null) void loadList();
}

const selected = ref<string | null>(null);
const role = ref<AgentRoleText | null>(null);
const roleError = ref('');
async function choose(id: string): Promise<void> {
  if (selected.value === id) {
    selected.value = null;
    return;
  }
  selected.value = id;
  role.value = null;
  roleError.value = '';
  try {
    const text = await loadAgentRole(id);
    if (selected.value === id) {
      role.value = text;
      void openReport(text);
    }
  } catch (cause) {
    if (selected.value === id) roleError.value = agentsErrorText(cause);
  }
}
// The safety report of the role opened (D-196): made the first time, once per version; read again while it is made.
const poll = safetyPoll(
  () => loadAgentRole(selected.value ?? ''),
  (text) => {
    if (selected.value !== text.id) return false;
    role.value = text;
    return true;
  },
);
const redoing = ref(false);
const reportError = ref('');
/** The role opened: its report is made now if this version has none (once); `redo` is «Rifai il rapporto». */
async function openReport(current: AgentRoleText, redo = false): Promise<void> {
  reportError.value = '';
  try {
    const safety = await redoSafetyReport({ role: current.id }, redo);
    if (selected.value === current.id) {
      role.value = { ...current, safety };
      poll.follow(role.value);
    }
  } catch (cause) {
    if (selected.value === current.id) reportError.value = `Rapporto di sicurezza: ${agentsErrorText(cause)}`;
  }
}
async function redo(): Promise<void> {
  const current = role.value;
  if (current === null || redoing.value) return;
  redoing.value = true;
  await openReport(current, true);
  redoing.value = false;
}
</script>

<template>
  <SettingsCard
    id="agents-catalog"
    title="Agenti da GitHub"
    description="Segui una raccolta: i suoi ruoli si sfogliano qui sotto e in «+ Nuovo agente». Si scaricano solo i file .md dei ruoli e le licenze, una raccolta alla volta; nessun altro file del repository arriva sul Mac e nulla si esegue."
  >
    <template #header><span title="Testo pubblico di terzi: si legge come dato, mai come istruzione">testo di terzi</span></template>
    <div v-if="error" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]" role="alert">
      <span class="min-w-[220px] flex-1">{{ error }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <!-- Entries of the list of sources written by hand that are not a valid address: left out, never cloned -->
    <p v-for="item in status?.ignored ?? []" :key="item.entry" class="text-[13px] text-warn" :title="item.reason">
      Ignorata: «{{ item.entry }}» non è l’indirizzo di una raccolta (https://github.com/proprietario/repository).
    </p>

    <SourceList
      ref="list"
      :sources="rows"
      :hide-loading="error !== ''"
      :suggestions="status?.suggestions ?? []"
      :acting="acting"
      loading-text="Leggo le raccolte di ruoli…"
      empty-title="Nessuna raccolta di ruoli."
      empty-text="Scrivi qui sotto l’indirizzo di una raccolta di GitHub, per esempio github.com/msitarzewski/agency-agents, e premi «Segui»."
      form-label="Segui una raccolta"
      placeholder="Indirizzo di una raccolta, per esempio https://github.com/msitarzewski/agency-agents"
      details-label="Quali ruoli"
      @add="add"
      @update="(id) => act(id, () => updateAgentSource(id))"
      @remove="(id) => act(id, () => removeAgentSource(id), true)"
      @adopt="(id, commit) => act(id, () => adoptAgentSource(id, commit), true)"
      @discard="(id) => act(id, () => discardAgentSource(id))"
    />
    <p v-if="status && status.sources.length > 0" class="text-[13px] text-muted">
      {{ limitsText(status.limits) }}. Ogni ruolo resta con la licenza della sua
      raccolta: la scheda di un agente la riporta sempre.
    </p>

    <!-- The roles of the versions in use -->
    <details v-if="total > 0" class="rounded-[10px] border border-line bg-surface text-[14px]" @toggle="opened">
      <summary class="cursor-pointer px-3 py-2 font-medium select-none">Sfoglia i ruoli ({{ total }})</summary>
      <div class="flex flex-col gap-2 border-t border-line px-3 py-2.5">
        <div class="flex flex-wrap gap-2">
          <input v-model="query" type="search" class="field min-w-[200px] flex-1 px-2.5 py-1.5 text-[14px]" placeholder="Cerca per nome o descrizione" aria-label="Cerca un ruolo" />
          <select v-model="division" class="field px-2 py-1.5 text-[14px]" aria-label="Divisione">
            <option value="">Tutte le divisioni</option>
            <option v-for="item in divisions" :key="item.division" :value="item.division">{{ item.division }} ({{ item.count }})</option>
          </select>
        </div>
        <div v-if="listError" class="flex flex-wrap items-center gap-2 text-[13px] text-danger" role="alert">
          <span class="flex-1">{{ listError }}</span>
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="loadList">Riprova</button>
        </div>
        <p v-else-if="listing === null" class="text-[13px] text-muted">Leggo l’elenco…</p>
        <p v-else-if="shown.length === 0" class="text-[13px] text-muted">Nessun ruolo con questa ricerca.</p>
        <ul v-else class="m-0 flex max-h-[420px] list-none flex-col overflow-auto p-0">
          <li v-for="item in shown" :key="item.id" class="border-b border-line last:border-b-0">
            <button type="button" class="flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-surface-2 touch:min-h-11" :aria-expanded="selected === item.id" @click="choose(item.id)">
              <span class="truncate font-medium">{{ item.name }} <span class="text-[12.5px] font-normal text-muted">· {{ item.division }} · {{ item.source }}</span></span>
              <span v-if="item.description && selected !== item.id" class="text-[13px] text-muted" :title="italian(item.id) === undefined ? undefined : item.description">{{ italian(item.id) ?? item.description }}</span>
            </button>
            <div v-if="selected === item.id" class="flex flex-col gap-1.5 px-2 pb-2">
              <!-- The description of the role open: in Italian, with «Originale» one click away -->
              <p v-if="item.description" class="text-[13px] text-muted"><TranslatedText :original="item.description" :italian="italian(item.id)" /></p>
              <p class="rounded-[8px] border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[13px]">
                Testo scritto da altri ({{ roleLicenseText(item) }}): qui si legge e basta. Quando potrai farne un agente, lo riceverà come dato: non deciderà permessi, etichette né
                strumenti.
              </p>
              <SafetyReportCard v-if="role?.safety" :safety="role.safety" :redoing="redoing" @redo="redo" />
              <p v-if="reportError" class="text-[13px] text-warn" role="alert">{{ reportError }}</p>
              <p v-if="roleError" class="text-[13px] text-warn">{{ roleError }}</p>
              <p v-else-if="role === null" class="text-[13px] text-muted">Leggo il ruolo…</p>
              <pre v-else class="max-h-[360px] overflow-auto rounded border border-line bg-surface-2 px-2.5 py-2 font-mono text-[12.5px] leading-[1.45] whitespace-pre-wrap">{{ role.text }}</pre>
            </div>
          </li>
        </ul>
        <p v-if="listing !== null && translationsNoteText(translations)" class="text-[12.5px] text-muted">{{ translationsNoteText(translations) }}</p>
      </div>
    </details>
  </SettingsCard>
</template>

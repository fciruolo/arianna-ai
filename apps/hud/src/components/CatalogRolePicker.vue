<script setup lang="ts">
/**
 * The choice of a role in «+ Nuovo agente» → «Dal catalogo» (D-079, tappa 3):
 * search by name and description, a select for the source, chips for the
 * division, the roles grouped by division; on the right the chosen role with
 * where it comes from, its license, the warning that it is third-party text
 * at L0 and the starting point of its division. The text of the role is
 * shown as it is, read only; nothing of it chooses a permission.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { catalogPresetOf, divisionCounts, filterRoles, roleLicenseText, roleUnlicensed, type AgentRoleListing, type AgentRoleSummary, type AgentRoleText, agentsErrorText } from '../lib/agents-catalog.ts';
import { listAgentRoles, loadAgentRole } from '../lib/api.ts';
import { redoSafetyReport } from '../lib/safety-report.ts';
import { safetyPoll } from '../lib/safety-poll.ts';
import { PRESET_TEXT } from '../lib/user-agents.ts';
import SafetyReportCard from './SafetyReportCard.vue';

const props = defineProps<{ modelValue: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [id: string | null]; role: [role: AgentRoleSummary | null, text: AgentRoleText | null]; settings: [] }>();

const listing = ref<AgentRoleListing | null>(null);
const listError = ref('');
const query = ref('');
const source = ref('');
const division = ref('');

async function load(): Promise<void> {
  try {
    listing.value = await listAgentRoles();
    listError.value = '';
  } catch (cause) {
    listError.value = agentsErrorText(cause);
  }
}
onMounted(load);

const roles = computed(() => listing.value?.roles ?? []);
const sources = computed(() => [...new Set(roles.value.map((role) => role.source))].sort());
const divisions = computed(() => divisionCounts(filterRoles(roles.value, '', '', source.value)));
const shown = computed(() => filterRoles(roles.value, query.value, division.value, source.value));
/** The roles shown, by division, the larger first. */
const groups = computed(() => {
  const order = divisionCounts(shown.value).map((item) => item.division);
  return order.map((name) => ({ division: name, roles: shown.value.filter((role) => role.division === name) }));
});
watch(source, () => {
  division.value = '';
});

const chosen = computed(() => roles.value.find((role) => role.id === props.modelValue) ?? null);
const text = ref<AgentRoleText | null>(null);
const textError = ref('');
watch(
  chosen,
  async (role) => {
    text.value = null;
    textError.value = '';
    emit('role', role, null);
    if (role === null) return;
    try {
      const read = await loadAgentRole(role.id);
      if (props.modelValue === role.id) {
        text.value = read;
        emit('role', role, read);
        void openReport(read);
      }
    } catch (cause) {
      if (props.modelValue === role.id) textError.value = agentsErrorText(cause);
    }
  },
  { immediate: true },
);

// The safety report of the role (D-196): made once per version when a role is first opened, here or in the catalog.
const poll = safetyPoll(
  () => loadAgentRole(props.modelValue ?? ''),
  (read) => {
    if (props.modelValue !== read.id) return false;
    text.value = read;
    emit('role', chosen.value, read);
    return true;
  },
);
onBeforeUnmount(poll.stop);
const redoing = ref(false);
const reportError = ref('');
/** The role opened: its report is made now if this version has none (once); `redo` is «Rifai il rapporto». */
async function openReport(current: AgentRoleText, redo = false): Promise<void> {
  reportError.value = '';
  try {
    const safety = await redoSafetyReport({ role: current.id }, redo);
    if (props.modelValue === current.id) {
      text.value = { ...current, safety };
      emit('role', chosen.value, text.value);
      poll.follow(text.value);
    }
  } catch (cause) {
    if (props.modelValue === current.id) reportError.value = `Rapporto di sicurezza: ${agentsErrorText(cause)}`;
  }
}
async function redo(): Promise<void> {
  const current = text.value;
  if (current === null || redoing.value) return;
  redoing.value = true;
  await openReport(current, true);
  redoing.value = false;
}

const preset = computed(() => (chosen.value === null ? null : catalogPresetOf(chosen.value.division)));
</script>

<template>
  <div v-if="listError" class="flex flex-wrap items-center gap-2 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2 text-[14px]" role="alert">
    <span class="min-w-0 flex-1">{{ listError }}</span>
    <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="load">Riprova</button>
  </div>
  <p v-else-if="listing === null" class="text-[14px] text-muted">Leggo i ruoli del catalogo…</p>
  <p v-else-if="roles.length === 0" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
    Non segui ancora nessuna raccolta di ruoli, o non ne hai ancora usata una versione.
    <a href="/impostazioni/catalogo-agenti" class="text-accent hover:underline" @click.prevent="emit('settings')">Aggiungine una in Impostazioni → Catalogo agenti</a>, premi «Scarica» e «Usa questa
    versione», poi torna qui; per esempio github.com/msitarzewski/agency-agents.
  </p>
  <div v-else class="grid min-h-[480px] grid-cols-1 overflow-hidden rounded-xl border border-line bg-surface-2 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
    <!-- The list -->
    <div class="flex min-w-0 flex-col border-b border-line md:border-r md:border-b-0">
      <div class="flex flex-col gap-2 border-b border-line bg-surface p-3">
        <input v-model="query" type="search" class="field px-2.5 py-1.5 text-[14px]" placeholder="Cerca per nome o descrizione" aria-label="Cerca un ruolo" />
        <label class="flex items-center gap-2 text-[13px] text-muted">
          Raccolta
          <select v-model="source" class="field min-w-0 flex-1 px-2 py-1 text-[14px] text-ink">
            <option value="">Tutte ({{ roles.length }} ruoli)</option>
            <option v-for="item in sources" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <div class="flex flex-wrap gap-1.5" role="group" aria-label="Divisione">
          <button
            type="button"
            class="rounded-full border px-2.5 py-0.5 text-[13px]"
            :class="division === '' ? 'border-accent bg-accent/10 text-ink' : 'border-line-strong text-muted hover:text-ink'"
            :aria-pressed="division === ''"
            @click="division = ''"
          >
            Tutte
          </button>
          <button
            v-for="item in divisions"
            :key="item.division"
            type="button"
            class="rounded-full border px-2.5 py-0.5 text-[13px]"
            :class="division === item.division ? 'border-accent bg-accent/10 text-ink' : 'border-line-strong text-muted hover:text-ink'"
            :aria-pressed="division === item.division"
            @click="division = item.division"
          >
            {{ item.division }} · {{ item.count }}
          </button>
        </div>
      </div>
      <p v-if="shown.length === 0" class="p-6 text-center text-[14px] text-muted">Nessun ruolo con questa ricerca: cambia il testo o scegli «Tutte».</p>
      <div v-else class="max-h-[520px] min-h-0 flex-1 overflow-auto">
        <template v-for="group in groups" :key="group.division">
          <p class="sticky top-0 flex border-b border-line bg-surface-2 px-3 pt-2 pb-1 text-[12.5px] font-semibold text-muted">
            {{ group.division }}<span class="ml-auto font-normal">{{ group.roles.length }}</span>
          </p>
          <button
            v-for="role in group.roles"
            :key="role.id"
            type="button"
            class="flex w-full min-w-0 flex-col items-start gap-0.5 border-b border-line px-3 py-2 text-left hover:bg-accent/5"
            :class="role.id === modelValue ? 'bg-accent/10 shadow-[inset_3px_0_0_var(--accent)]' : ''"
            :aria-pressed="role.id === modelValue"
            @click="emit('update:modelValue', role.id)"
          >
            <span class="w-full truncate text-[14.5px] font-semibold">{{ role.name }}</span>
            <span class="line-clamp-2 text-[13px] text-muted">{{ role.description }}</span>
            <span v-if="sources.length > 1" class="text-[12px] text-muted">{{ role.source }}</span>
          </button>
        </template>
      </div>
    </div>

    <!-- The chosen role -->
    <div class="flex min-w-0 flex-col gap-3 p-4 md:p-5">
      <p v-if="chosen === null" class="m-auto text-center text-[14px] text-muted">Scegli un ruolo a sinistra per leggerlo.</p>
      <template v-else>
        <div class="flex flex-wrap gap-1.5">
          <span class="pill">{{ chosen.division }}</span>
          <span class="pill">{{ chosen.source }}</span>
          <span class="pill border-info/50 text-info">Testo di terzi · L0</span>
        </div>
        <h3 class="text-[20px] font-semibold">{{ chosen.name }}</h3>
        <p class="text-[14px] text-muted">{{ chosen.description }}</p>
        <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3.5 gap-y-1 text-[13.5px]">
          <dt class="text-muted">Raccolta</dt>
          <dd class="m-0 [overflow-wrap:anywhere]">
            <a :href="text?.page ?? `https://github.com/${chosen.source}`" target="_blank" rel="noopener noreferrer" class="hover:text-accent hover:underline">{{ chosen.source }}</a
            ><template v-if="text">, file <span class="font-mono text-[12.5px]">{{ text.path }}</span></template>
          </dd>
          <dt class="text-muted">Licenza</dt>
          <dd class="m-0" :class="{ 'text-warn': roleUnlicensed(chosen) }">{{ roleLicenseText(chosen) }}{{ roleUnlicensed(chosen) ? ': prima di crearlo te lo chiederò' : ': resta scritta nella scheda' }}</dd>
        </dl>
        <p class="rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2 text-[13px]">
          Testo scritto da altri: Arianna lo dà all’agente fra due marcatori, come dato. Non può cambiare permessi, etichette o strumenti, e una richiesta nel testo di leggere file o contattare
          servizi viene ignorata.
        </p>
        <!-- The safety report of this version of the role (D-196): read once, shared by every agent made from it -->
        <SafetyReportCard v-if="text?.safety" :safety="text.safety" :redoing="redoing" @redo="redo" />
        <p v-if="reportError" class="text-[13px] text-warn" role="alert">{{ reportError }}</p>
        <details open class="text-[13px]">
          <summary class="cursor-pointer text-muted select-none">Il testo del ruolo</summary>
          <p v-if="textError" class="mt-1 text-warn">{{ textError }}</p>
          <p v-else-if="text === null" class="mt-1 text-muted">Leggo il ruolo…</p>
          <pre v-else class="mt-1.5 max-h-[260px] overflow-auto rounded-[8px] border border-line bg-surface px-3 py-2 font-mono text-[12.5px] leading-[1.5] whitespace-pre-wrap">{{ text.text }}</pre>
        </details>
        <div v-if="preset" class="flex flex-col gap-1 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[13.5px]">
          <b class="font-semibold">Permessi di partenza: {{ PRESET_TEXT[preset]?.title ?? preset }}</b>
          <span class="text-muted">Dalla divisione «{{ chosen.division }}», mai dal file. {{ PRESET_TEXT[preset]?.text }} Li cambi qui sotto, dentro quello che è ammesso per gli agenti tuoi.</span>
        </div>
      </template>
    </div>
  </div>
</template>

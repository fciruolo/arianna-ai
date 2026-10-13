<script setup lang="ts">
/**
 * "Skill da GitHub" in Impostazioni → Skill e stili (D-161, D-192): the
 * catalog of skills from the GitHub repositories the user follows. Each source
 * has its own "Scarica"/"Cerca aggiornamenti", the summary of what changes,
 * and only "Usa questa versione" adopts it. The suggestions are added with a
 * click, never by themselves. The skills can be searched and read; they reach
 * an agent only when assigned in its tab "Skill", as third-party data. A
 * version is told by its date, never by its commit.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { addSkillSource, adoptSkillSource, discardSkillSource, listSkills, loadSkill, loadSkillsCatalog, removeSkillSource, updateSkillSource } from '../lib/api.ts';
import { versionText } from '../lib/design-catalog.ts';
import {
  filterSkills,
  otherFilesText,
  shouldPollSkills,
  skillChangesText,
  skillJobErrorText,
  skillLicenseText,
  skillsErrorText,
  sourceBlocked,
  sourceButtonText,
  sourceSummaryText,
  sourceUrlProblem,
  type SkillListing,
  type SkillsStatus,
  type SkillText,
} from '../lib/skills-catalog.ts';
import SettingsCard from './SettingsCard.vue';

const emit = defineEmits<{ changed: [] }>();

const status = ref<SkillsStatus | null>(null);
const error = ref('');
const acting = ref<string | null>(null);
let timer: number | undefined;
let mounted = true;

function schedule(): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (mounted && shouldPollSkills(status.value)) timer = window.setTimeout(() => void refresh(), 1500);
}

async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    status.value = await loadSkillsCatalog();
    error.value = '';
  } catch (cause) {
    error.value = skillsErrorText(cause);
  }
  schedule();
}
onMounted(refresh);
onBeforeUnmount(() => {
  mounted = false;
  window.clearTimeout(timer);
});

/** One action at a time; `key` marks the source (or the form) that waits. */
async function act(key: string, action: () => Promise<SkillsStatus>, listChanged = false): Promise<boolean> {
  if (acting.value !== null) return false;
  acting.value = key;
  error.value = '';
  try {
    status.value = await action();
    if (listChanged) {
      listing.value = null;
      if (browsing.value) void loadList();
      emit('changed');
    }
    return true;
  } catch (cause) {
    error.value = skillsErrorText(cause);
    return false;
  } finally {
    acting.value = null;
    schedule();
  }
}

// Adding a source
const url = ref('');
const urlProblem = computed(() => (url.value.trim() === '' ? undefined : sourceUrlProblem(url.value)));
async function add(address: string): Promise<void> {
  if (sourceUrlProblem(address) !== undefined) return;
  if (await act('add', () => addSkillSource(address.trim()))) url.value = '';
}

// Removing one asks first, in place
const removing = ref<string | null>(null);
async function remove(source: string): Promise<void> {
  removing.value = null;
  await act(source, () => removeSkillSource(source), true);
}

async function adopt(source: string, commit: string): Promise<void> {
  await act(source, () => adoptSkillSource(source, commit), true);
}

// The skills of the versions in use
const listing = ref<SkillListing | null>(null);
const listError = ref('');
const query = ref('');
const browsing = ref(false);
const shown = computed(() => filterSkills(listing.value?.skills ?? [], query.value));
const total = computed(() => status.value?.sources.reduce((sum, source) => sum + (source.adopted?.skills ?? 0), 0) ?? 0);
async function loadList(): Promise<void> {
  try {
    listing.value = await listSkills();
    listError.value = '';
  } catch (cause) {
    listError.value = skillsErrorText(cause);
  }
}
function opened(event: Event): void {
  browsing.value = event.target instanceof HTMLDetailsElement && event.target.open;
  if (browsing.value && listing.value === null) void loadList();
}

const selected = ref<string | null>(null);
const skill = ref<SkillText | null>(null);
const skillError = ref('');
async function choose(id: string): Promise<void> {
  if (selected.value === id) {
    selected.value = null;
    return;
  }
  selected.value = id;
  skill.value = null;
  skillError.value = '';
  try {
    const text = await loadSkill(id);
    if (selected.value === id) skill.value = text;
  } catch (cause) {
    if (selected.value === id) skillError.value = skillsErrorText(cause);
  }
}
</script>

<template>
  <SettingsCard id="skills-catalog" title="Skill da GitHub" description="Segui una raccolta: le sue skill compaiono nella scheda Skill di ogni agente. Si scaricano solo i testi e le licenze; script e altri file delle skill non si scaricano e non si eseguono mai.">
    <template #header><span title="Testo pubblico di terzi: si legge come dato, mai come istruzione">testo di terzi</span></template>
    <div v-if="error" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]" role="alert">
      <span class="min-w-[220px] flex-1">{{ error }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <!-- Entries of the list of sources written by hand that are not a valid address: left out, never cloned -->
    <p v-for="item in status?.ignored ?? []" :key="item.entry" class="text-[13px] text-warn" :title="item.reason">
      Ignorata: «{{ item.entry }}» non è l’indirizzo di una raccolta (https://github.com/proprietario/repository).
    </p>

    <!-- The sources -->
    <p v-if="status === null && !error" class="text-[14px] text-muted">Leggo le raccolte…</p>
    <p v-else-if="status !== null && status.sources.length === 0" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
      <b class="font-semibold text-ink">Nessuna raccolta.</b> Scrivi qui sotto l’indirizzo di una raccolta di GitHub, per esempio github.com/anthropics/skills, e premi «Segui».
    </p>
    <ul v-else-if="status" class="m-0 flex list-none flex-col p-0">
      <li v-for="source in status.sources" :key="source.id" class="flex flex-col gap-2 border-t border-line py-2.5 text-[14px] first:border-t-0 first:pt-0">
        <div class="flex flex-wrap items-center gap-2.5">
          <div class="min-w-0 flex-1">
            <a :href="source.page" target="_blank" rel="noopener noreferrer" class="font-semibold hover:text-accent hover:underline">{{ source.id }}</a>
            <div class="text-[13px] text-muted">{{ sourceSummaryText(source) }}</div>
          </div>
          <template v-if="!source.readOnly">
            <button
              type="button"
              class="btn px-2.5 py-1 text-[13px]"
              :class="{ 'btn-primary': source.adopted === null }"
              :disabled="acting !== null || sourceBlocked(source) !== undefined"
              :title="sourceBlocked(source)"
              @click="act(source.id, () => updateSkillSource(source.id))"
            >
              {{ sourceButtonText(source) }}
            </button>
            <button v-if="removing !== source.id" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null || source.job?.status === 'running'" @click="removing = source.id">Togli…</button>
          </template>
        </div>
        <p v-if="removing === source.id" class="flex flex-wrap items-center gap-2 text-[13px]" role="alert">
          <span>Togliere {{ source.id }}? Le sue skill spariscono dal catalogo e dagli agenti a cui sono assegnate.</span>
          <button type="button" class="btn px-2 py-0.5 text-[13px]" @click="removing = null">No</button>
          <button type="button" class="btn btn-primary px-2 py-0.5 text-[13px]" @click="remove(source.id)">Sì, togli</button>
        </p>
        <p v-if="source.readOnly" class="text-[13px] text-muted">Le skill di Open Design: si aggiornano con gli stili, in «Stili per il Designer».</p>
        <p v-if="source.job?.status === 'running'" class="text-[13px] text-muted" role="status">
          {{ source.job.phase === 'index' ? 'Leggo nomi e descrizioni…' : 'Scarico da GitHub solo i testi delle skill e le licenze…' }}
        </p>
        <p v-else-if="source.job?.status === 'done' && source.job.outcome === 'unchanged'" class="text-[13px] text-ok" role="status">Nessuna novità: la versione in uso è la più recente.</p>
        <div v-else-if="source.job?.status === 'failed'" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2 text-[14px]" role="alert">
          <span class="min-w-[220px] flex-1">{{ skillJobErrorText(source.job.error) }}</span>
          <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null || sourceBlocked(source) !== undefined" @click="act(source.id, () => updateSkillSource(source.id))">Riprova</button>
        </div>

        <!-- The version waiting: what changes, then the user's click -->
        <div v-if="source.pending" class="flex flex-col gap-1.5 rounded-[10px] border border-accent bg-accent/8 px-3 py-2" aria-live="polite">
          <p class="font-semibold">{{ source.adopted === null ? 'Scaricata' : 'Versione nuova' }}: {{ versionText(source.pending.committedAt) }}, {{ source.pending.skills }} skill</p>
          <p>{{ skillChangesText(source.pending.diff) }}</p>
          <p v-if="source.pending.rejected > 0" class="text-[13px] text-muted">{{ source.pending.rejected }} file scartati (senza intestazione, troppo grandi, nomi insoliti o collegamenti)</p>
          <details v-if="source.adopted !== null && source.pending.diff.added + source.pending.diff.changed + source.pending.diff.removed > 0" class="text-[13px]">
            <summary class="cursor-pointer text-muted select-none">Quali skill</summary>
            <p v-if="source.pending.diff.addedSlugs.length > 0" class="mt-1"><b class="font-semibold">Nuove:</b> {{ source.pending.diff.addedSlugs.join(', ') }}</p>
            <p v-if="source.pending.diff.changedSlugs.length > 0" class="mt-1"><b class="font-semibold">Cambiate:</b> {{ source.pending.diff.changedSlugs.join(', ') }}</p>
            <p v-if="source.pending.diff.removedSlugs.length > 0" class="mt-1"><b class="font-semibold">Tolte:</b> {{ source.pending.diff.removedSlugs.join(', ') }}</p>
          </details>
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="acting !== null" @click="act(source.id, () => discardSkillSource(source.id))">Scarta</button>
            <button type="button" class="btn btn-primary px-3 py-1 text-[14px]" :disabled="acting !== null" @click="adopt(source.id, source.pending.commit)">Usa questa versione</button>
          </div>
        </div>
      </li>
    </ul>

    <!-- Follow a source -->
    <form class="grid gap-3 border-t border-line pt-3 sm:grid-cols-6" @submit.prevent="add(url)">
      <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-4">
        <span class="text-[14px] font-medium text-ink">Segui una raccolta</span>
        <input
          v-model="url"
          type="url"
          class="field px-2.5 py-1.5 text-[14px]"
          placeholder="Indirizzo di una raccolta, per esempio https://github.com/anthropics/skills"
          :aria-invalid="urlProblem !== undefined"
        />
        <span v-if="urlProblem" class="text-warn">{{ urlProblem }}</span>
      </label>
      <div class="flex items-end sm:col-span-1">
        <button type="submit" class="btn px-3 py-1.5 text-[14px]" :disabled="acting !== null || sourceUrlProblem(url) !== undefined" :title="sourceUrlProblem(url)">Segui</button>
      </div>
    </form>
    <div v-if="status && status.suggestions.length > 0" class="flex flex-wrap items-center gap-1.5 text-[13px]">
      <span class="text-muted">Suggerite:</span>
      <button v-for="item in status.suggestions" :key="item.id" type="button" class="pill hover:border-accent hover:text-ink" :disabled="acting !== null" :title="`Segui ${item.page}`" @click="add(item.page)">+ {{ item.id }}</button>
    </div>

    <!-- The skills of the versions in use -->
    <details v-if="total > 0" class="rounded-[10px] border border-line bg-surface text-[14px]" @toggle="opened">
      <summary class="cursor-pointer px-3 py-2 font-medium select-none">Cerca nelle skill ({{ total }})</summary>
      <div class="flex flex-col gap-2 border-t border-line px-3 py-2.5">
        <input v-model="query" type="search" class="field px-2.5 py-1.5 text-[14px]" placeholder="Cerca per nome, raccolta, descrizione o licenza" aria-label="Cerca una skill" />
        <div v-if="listError" class="flex flex-wrap items-center gap-2 text-[13px] text-danger" role="alert">
          <span class="flex-1">{{ listError }}</span>
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="loadList">Riprova</button>
        </div>
        <p v-else-if="listing === null" class="text-[13px] text-muted">Leggo l’elenco…</p>
        <p v-else-if="shown.length === 0" class="text-[13px] text-muted">Nessuna skill con questa ricerca.</p>
        <ul v-else class="m-0 flex max-h-[420px] list-none flex-col overflow-auto p-0">
          <li v-for="item in shown" :key="item.id" class="border-b border-line last:border-b-0">
            <button type="button" class="flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-surface-2" :aria-expanded="selected === item.id" @click="choose(item.id)">
              <span class="truncate font-medium">{{ item.name }}</span>
              <span v-if="item.description" class="text-[13px] text-muted">{{ item.description }}</span>
            </button>
            <div v-if="selected === item.id" class="flex flex-col gap-1.5 px-2 pb-2">
              <p class="rounded-[8px] border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[13px]">
                Testo di terzi, {{ skillLicenseText(item.license) }}. Prima di assegnarla controlla che la licenza ti consenta l’uso che ne farai.
              </p>
              <p v-if="otherFilesText(item.otherFiles)" class="text-[13px] text-muted">{{ otherFilesText(item.otherFiles) }}</p>
              <p v-if="skillError" class="text-[13px] text-warn">{{ skillError }}</p>
              <p v-else-if="skill === null" class="text-[13px] text-muted">Leggo la skill…</p>
              <pre v-else class="max-h-[360px] overflow-auto rounded border border-line bg-surface-2 px-2.5 py-2 font-mono text-[12.5px] leading-[1.45] whitespace-pre-wrap">{{ skill.text }}</pre>
            </div>
          </li>
        </ul>
      </div>
    </details>
  </SettingsCard>
</template>

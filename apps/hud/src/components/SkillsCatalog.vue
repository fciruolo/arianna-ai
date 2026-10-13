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
import { filterSkills, otherFilesText, shouldPollSkills, skillLicenseText, skillsErrorText, type SkillListing, type SkillsStatus, type SkillText } from '../lib/skills-catalog.ts';
import { skillSourceRow } from '../lib/source-list.ts';
import SettingsCard from './SettingsCard.vue';
import SourceList from './SourceList.vue';

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

// The sources, as the common list shows them (SourceList.vue)
const rows = computed(() => status.value?.sources.map(skillSourceRow) ?? null);
const list = ref<InstanceType<typeof SourceList> | null>(null);
async function add(address: string): Promise<void> {
  if (await act('add', () => addSkillSource(address))) list.value?.added();
}
async function remove(source: string): Promise<void> {
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

    <!-- The sources, then the field to follow one and the suggestions -->
    <SourceList
      ref="list"
      :sources="rows"
      :hide-loading="error !== ''"
      :suggestions="status?.suggestions ?? []"
      :acting="acting"
      loading-text="Leggo le raccolte…"
      empty-title="Nessuna raccolta."
      empty-text="Scrivi qui sotto l’indirizzo di una raccolta di GitHub, per esempio github.com/anthropics/skills, e premi «Segui»."
      form-label="Segui una raccolta"
      placeholder="Indirizzo di una raccolta, per esempio https://github.com/anthropics/skills"
      details-label="Quali skill"
      @add="add"
      @update="(id) => act(id, () => updateSkillSource(id))"
      @remove="remove"
      @adopt="adopt"
      @discard="(id) => act(id, () => discardSkillSource(id))"
    />
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

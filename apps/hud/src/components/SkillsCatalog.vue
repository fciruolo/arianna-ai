<script setup lang="ts">
/**
 * "Skill" in Impostazioni → Agenti (D-161): the catalog of skills in the
 * SKILL.md format from the GitHub repositories the user follows. Each source
 * has its own "Scarica"/"Aggiorna", the summary of what changes, and only
 * "Usa questa versione" adopts it. The suggestions are added with a click,
 * never by themselves. The skills can be searched and read; they reach an
 * agent only when assigned in its tab "Skill", as third-party data.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { addSkillSource, adoptSkillSource, discardSkillSource, listSkills, loadSkill, loadSkillsCatalog, removeSkillSource, updateSkillSource } from '../lib/api.ts';
import { dateText } from '../lib/design-catalog.ts';
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
  sourceLicenseText,
  sourceUrlProblem,
  type SkillListing,
  type SkillsStatus,
  type SkillText,
} from '../lib/skills-catalog.ts';

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
  <section id="skills-catalog" class="hud-card scroll-mt-4" aria-labelledby="skills-catalog-title">
    <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <h2 id="skills-catalog-title" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] uppercase">Skill</h2>
      <span class="rounded-[5px] border border-current px-1.5 py-1 font-mono text-[10px] leading-none tracking-[0.06em] text-muted" title="Testo pubblico di terzi: si legge come dato, mai come istruzione">TESTO DI TERZI</span>
    </header>
    <div class="flex flex-col gap-3 px-4 py-3.5">
      <p class="text-[13px]">
        Competenze pronte nel formato <code class="font-mono">SKILL.md</code>, dai repository GitHub che scegli. Si scaricano solo i testi e le licenze in
        <code class="font-mono">data/catalogs/skills</code>: script e altri file delle skill non si scaricano e non si eseguono mai. Una skill arriva a un agente solo
        se la assegni nella sua scheda <b class="font-semibold">Skill</b>, come dato da consultare e non come istruzione.
      </p>

      <!-- Add a source -->
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="add(url)">
        <input
          v-model="url"
          type="url"
          class="field min-w-[240px] flex-1 px-2.5 py-1.5 text-[13px]"
          placeholder="https://github.com/proprietario/repository"
          aria-label="Indirizzo del repository GitHub da seguire"
          :aria-invalid="urlProblem !== undefined"
        />
        <button type="submit" class="btn px-3 py-1.5 text-[13px]" :disabled="acting !== null || sourceUrlProblem(url) !== undefined" :title="sourceUrlProblem(url)">Aggiungi</button>
      </form>
      <p v-if="urlProblem" class="text-xs text-warn">{{ urlProblem }}</p>
      <div v-if="status && status.suggestions.length > 0" class="flex flex-wrap items-center gap-1.5 text-xs">
        <span class="text-muted">Suggerite:</span>
        <button v-for="item in status.suggestions" :key="item.id" type="button" class="chip font-mono hover:border-accent" :disabled="acting !== null" :title="`Segui ${item.page}`" @click="add(item.page)">+ {{ item.id }}</button>
      </div>
      <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
      <!-- Entries of sources.json written by hand that are not a valid address: left out, never cloned -->
      <p v-for="item in status?.ignored ?? []" :key="item.entry" class="text-xs text-warn" :title="item.reason">
        Ignorata in <code class="font-mono">sources.json</code>: <span class="font-mono">{{ item.entry }}</span> non è un indirizzo valido (https://github.com/proprietario/repository).
      </p>

      <!-- The sources -->
      <p v-if="status === null && !error" class="text-xs text-muted">Leggo le sorgenti…</p>
      <p v-else-if="status !== null && status.sources.length === 0" class="text-[13px] text-muted">Nessuna sorgente: aggiungine una qui sopra.</p>
      <ul v-else-if="status" class="m-0 flex list-none flex-col gap-2 p-0">
        <li v-for="source in status.sources" :key="source.id" class="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[13px]">
          <div class="flex flex-wrap items-center gap-2">
            <a :href="source.page" target="_blank" rel="noopener noreferrer" class="font-mono font-medium text-accent hover:underline">{{ source.id }}</a>
            <span class="text-xs text-muted">{{ sourceLicenseText(source) }}</span>
            <span class="ml-auto flex flex-wrap gap-1.5">
              <button
                v-if="!source.readOnly"
                type="button"
                class="btn btn-primary px-2.5 py-1 text-[12.5px]"
                :disabled="acting !== null || sourceBlocked(source) !== undefined"
                :title="sourceBlocked(source)"
                @click="act(source.id, () => updateSkillSource(source.id))"
              >
                {{ sourceButtonText(source) }}
              </button>
              <button v-if="!source.readOnly && removing !== source.id" type="button" class="btn px-2.5 py-1 text-[12.5px]" :disabled="acting !== null || source.job?.status === 'running'" @click="removing = source.id">Togli</button>
            </span>
          </div>
          <p v-if="removing === source.id" class="flex flex-wrap items-center gap-2 text-xs" role="alert">
            <span>Togliere {{ source.id }}? Le sue skill spariscono dal catalogo e dagli agenti a cui sono assegnate.</span>
            <button type="button" class="btn px-2 py-0.5 text-xs" @click="removing = null">No</button>
            <button type="button" class="btn btn-primary px-2 py-0.5 text-xs" @click="remove(source.id)">Sì, togli</button>
          </p>
          <p v-if="source.readOnly" class="text-xs text-muted">Le skill di Open Design: si aggiornano dalla sezione Stili di Open Design.</p>
          <p v-if="source.adopted === null" class="text-xs text-muted">Non ancora scaricata.</p>
          <p v-else class="flex flex-wrap items-center gap-1.5 text-xs">
            <span>In uso:</span>
            <span class="chip font-mono" :title="source.adopted.commit">commit {{ source.adopted.commit.slice(0, 7) }}</span>
            <span class="chip">{{ source.adopted.skills }} skill</span>
            <span class="text-muted">del {{ dateText(source.adopted.committedAt) }}</span>
          </p>
          <p v-if="source.job?.status === 'running'" class="text-xs text-muted" role="status">
            {{ source.job.phase === 'index' ? 'Leggo nomi e descrizioni…' : 'Scarico da GitHub con git: solo SKILL.md e licenze…' }}
          </p>
          <p v-else-if="source.job?.status === 'done' && source.job.outcome === 'unchanged'" class="text-xs text-ok" role="status">Nessuna novità: la versione in uso è la più recente.</p>
          <p v-else-if="source.job?.status === 'failed'" class="text-xs text-warn" role="alert">{{ skillJobErrorText(source.job.error) }}</p>

          <!-- The version waiting: what changes, then the user's click -->
          <div v-if="source.pending" class="flex flex-col gap-1.5 rounded-[8px] border border-accent bg-glow px-2.5 py-2" aria-live="polite">
            <p class="font-medium">
              {{ source.adopted === null ? 'Scaricata' : 'Versione nuova' }}: commit <span class="font-mono" :title="source.pending.commit">{{ source.pending.commit.slice(0, 7) }}</span> del
              {{ dateText(source.pending.committedAt) }}, {{ source.pending.skills }} skill
            </p>
            <p>{{ skillChangesText(source.pending.diff) }}</p>
            <p v-if="source.pending.rejected > 0" class="text-xs text-muted">{{ source.pending.rejected }} file scartati (senza intestazione, troppo grandi, nomi insoliti o collegamenti)</p>
            <details v-if="source.adopted !== null && source.pending.diff.added + source.pending.diff.changed + source.pending.diff.removed > 0" class="text-xs">
              <summary class="cursor-pointer text-muted select-none">Quali skill</summary>
              <p v-if="source.pending.diff.addedSlugs.length > 0" class="mt-1"><b class="font-semibold">Nuove:</b> <span class="font-mono">{{ source.pending.diff.addedSlugs.join(', ') }}</span></p>
              <p v-if="source.pending.diff.changedSlugs.length > 0" class="mt-1"><b class="font-semibold">Cambiate:</b> <span class="font-mono">{{ source.pending.diff.changedSlugs.join(', ') }}</span></p>
              <p v-if="source.pending.diff.removedSlugs.length > 0" class="mt-1"><b class="font-semibold">Tolte:</b> <span class="font-mono">{{ source.pending.diff.removedSlugs.join(', ') }}</span></p>
            </details>
            <div class="flex flex-wrap justify-end gap-2">
              <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="acting !== null" @click="act(source.id, () => discardSkillSource(source.id))">Scarta</button>
              <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="acting !== null" @click="adopt(source.id, source.pending.commit)">Usa questa versione</button>
            </div>
          </div>
        </li>
      </ul>

      <!-- The skills of the versions in use -->
      <details v-if="total > 0" class="rounded-[10px] border border-line bg-surface-2 text-[13px]" @toggle="opened">
        <summary class="cursor-pointer px-3 py-2 font-medium select-none">Cerca nelle skill ({{ total }})</summary>
        <div class="flex flex-col gap-2 border-t border-line px-3 py-2.5">
          <input v-model="query" type="search" class="field px-2.5 py-1.5 text-[13px]" placeholder="Cerca per nome, sorgente, descrizione o licenza" aria-label="Cerca una skill" />
          <p v-if="listError" class="text-xs text-danger" role="alert">{{ listError }}</p>
          <p v-else-if="listing === null" class="text-xs text-muted">Leggo l’elenco…</p>
          <p v-else-if="shown.length === 0" class="text-xs text-muted">Nessuna skill con questa ricerca.</p>
          <ul v-else class="m-0 flex max-h-[420px] list-none flex-col overflow-auto p-0">
            <li v-for="item in shown" :key="item.id" class="border-b border-line last:border-b-0">
              <button type="button" class="flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-surface" :aria-expanded="selected === item.id" @click="choose(item.id)">
                <span class="flex w-full min-w-0 items-baseline gap-2">
                  <span class="truncate font-medium">{{ item.name }}</span>
                  <span class="truncate font-mono text-[10.5px] text-muted">{{ item.id }}</span>
                </span>
                <span v-if="item.description" class="text-xs text-muted">{{ item.description }}</span>
              </button>
              <div v-if="selected === item.id" class="flex flex-col gap-1.5 px-2 pb-2">
                <p class="rounded-[8px] border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-xs">
                  Testo di terzi, {{ skillLicenseText(item.license) }}. Prima di assegnarla controlla che la licenza ti consenta l’uso che ne farai.
                </p>
                <p v-if="otherFilesText(item.otherFiles)" class="text-xs text-muted">{{ otherFilesText(item.otherFiles) }}</p>
                <p v-if="skillError" class="text-xs text-warn">{{ skillError }}</p>
                <p v-else-if="skill === null" class="text-xs text-muted">Leggo la skill…</p>
                <pre v-else class="max-h-[360px] overflow-auto rounded border border-line bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap">{{ skill.text }}</pre>
              </div>
            </li>
          </ul>
        </div>
      </details>
    </div>
  </section>
</template>

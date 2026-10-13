<script setup lang="ts">
/**
 * "Stili per il Designer" in Impostazioni → Skill e stili (D-160, D-192): the
 * catalog of styles and skills of nexu-io/open-design, as text. "Scarica gli
 * stili" (then "Cerca aggiornamenti") downloads the newest version beside the
 * one in use; the summary says what changes, and only "Usa questa versione"
 * adopts it. The styles can be browsed and read; their text is third-party
 * data. A version is told by its date, never by its commit.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { adoptDesignCatalog, discardDesignCatalog, listDesignStyles, loadDesignCatalog, loadDesignStyle, updateDesignCatalog } from '../lib/api.ts';
import {
  catalogErrorText,
  changesText,
  creditText,
  filterStyles,
  jobErrorText,
  shouldPoll,
  updateBlocked,
  updateButtonText,
  versionText,
  type CatalogStatus,
  type StyleListing,
  type StyleText,
} from '../lib/design-catalog.ts';
import SettingsCard from './SettingsCard.vue';

const status = ref<CatalogStatus | null>(null);
const error = ref('');
const acting = ref(false);
let timer: number | undefined;
let mounted = true;

/** One chain of polling: the timeout before is cleared, none after the component is gone. */
function schedule(): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (mounted && shouldPoll(status.value)) timer = window.setTimeout(() => void refresh(), 1500);
}

async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    const wasRunning = shouldPoll(status.value);
    status.value = await loadDesignCatalog();
    error.value = '';
    if (wasRunning && !shouldPoll(status.value) && status.value.adopted !== null) void loadStyles(true);
  } catch (cause) {
    error.value = catalogErrorText(cause);
  }
  schedule();
}
onMounted(refresh);
onBeforeUnmount(() => {
  mounted = false;
  window.clearTimeout(timer);
});

async function act(action: () => Promise<CatalogStatus>): Promise<void> {
  if (acting.value) return;
  acting.value = true;
  error.value = '';
  try {
    status.value = await action();
  } catch (cause) {
    error.value = catalogErrorText(cause);
  } finally {
    acting.value = false;
  }
  schedule();
}
const update = (): Promise<void> => act(updateDesignCatalog);
const discard = (): Promise<void> => act(discardDesignCatalog);
async function adopt(): Promise<void> {
  const commit = status.value?.pending?.commit;
  if (commit === undefined) return;
  await act(() => adoptDesignCatalog(commit));
  if (status.value?.pending === null) {
    selected.value = null;
    await loadStyles(true);
  }
}
/** «Riprova» after an error: the status read again, or the download again when it was the one that failed. */
function retry(): void {
  if (error.value !== '') void refresh();
  else void update();
}

const blocked = computed(() => (acting.value ? 'Un momento…' : updateBlocked(status.value)));
const job = computed(() => status.value?.job ?? null);
const failure = computed(() => (error.value !== '' ? error.value : job.value?.status === 'failed' ? jobErrorText(job.value.error) : null));

// The browsable list of the adopted version
const listing = ref<StyleListing | null>(null);
const listError = ref('');
const query = ref('');
const shown = computed(() => filterStyles(listing.value?.styles ?? [], query.value));
async function loadStyles(force = false): Promise<void> {
  if (listing.value !== null && !force) return;
  try {
    listing.value = await listDesignStyles();
    listError.value = '';
  } catch (cause) {
    listError.value = catalogErrorText(cause);
  }
}
function opened(event: Event): void {
  if (event.target instanceof HTMLDetailsElement && event.target.open) void loadStyles();
}

const selected = ref<string | null>(null);
const style = ref<StyleText | null>(null);
const styleError = ref('');
async function choose(slug: string): Promise<void> {
  if (selected.value === slug) {
    selected.value = null;
    return;
  }
  selected.value = slug;
  style.value = null;
  styleError.value = '';
  try {
    const text = await loadDesignStyle(slug);
    if (selected.value === slug) style.value = text;
  } catch (cause) {
    if (selected.value === slug) styleError.value = catalogErrorText(cause);
  }
}
</script>

<template>
  <SettingsCard id="design-catalog" title="Stili per il Designer">
    <template #header><span title="Testo pubblico di terzi: si legge come dato, mai come istruzione">da Open Design, testo di terzi</span></template>
    <!-- The version in use -->
    <p v-if="status === null && !error" class="text-[14px] text-muted">Leggo lo stato del catalogo…</p>
    <p v-else-if="status !== null && status.adopted === null" class="text-[14px] text-muted">
      Nessuno stile ancora. Premi «Scarica gli stili»: arrivano i testi degli stili visivi e delle skill di Open Design, da dare al Designer. Una versione si usa solo dopo che hai visto
      cosa cambia.
    </p>
    <p v-else-if="status?.adopted" class="text-[14px] text-muted">In uso {{ versionText(status.adopted.committedAt) }}: {{ status.adopted.styles }} stili e {{ status.adopted.skills }} skill.</p>

    <!-- The download -->
    <div class="flex flex-wrap items-center gap-2.5">
      <button type="button" class="btn px-3 py-1.5 text-[14px]" :class="{ 'btn-primary': status?.adopted === null }" :disabled="blocked !== undefined" :title="blocked" @click="update">
        {{ updateButtonText(status) }}
      </button>
      <span v-if="job?.status === 'running'" class="text-[13px] text-muted" role="status">
        {{ job.phase === 'index' ? 'Leggo nomi e descrizioni…' : 'Scarico da GitHub solo i testi degli stili, delle skill e la licenza…' }}
      </span>
      <span v-else-if="job?.status === 'done' && job.outcome === 'unchanged'" class="text-[13px] text-ok" role="status">Nessuna novità: la versione in uso è la più recente.</span>
    </div>
    <div v-if="failure !== null" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]" role="alert">
      <span class="min-w-[220px] flex-1">{{ failure }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting || (error === '' && blocked !== undefined)" @click="retry">Riprova</button>
    </div>

    <!-- The version waiting: what changes, then the user's click -->
    <div v-if="status?.pending" class="flex flex-col gap-2 rounded-[10px] border border-accent bg-accent/8 px-3 py-2.5" aria-live="polite">
      <p class="text-[14px] font-semibold">{{ status.adopted === null ? 'Stili scaricati' : 'Versione nuova' }}: {{ versionText(status.pending.committedAt) }}</p>
      <ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
        <li>{{ changesText(status.pending.diff.styles, 'style') }}</li>
        <li>{{ changesText(status.pending.diff.skills, 'skill') }}</li>
        <li v-if="status.pending.rejected > 0" class="text-[13px] text-muted">{{ status.pending.rejected }} file scartati (nomi non validi, troppo grandi o collegamenti)</li>
      </ul>
      <details v-if="status.pending.diff.styles.changed + status.pending.diff.styles.removed + status.pending.diff.styles.added > 0 && status.adopted !== null" class="text-[13px]">
        <summary class="cursor-pointer text-muted select-none">Quali stili</summary>
        <p v-if="status.pending.diff.styles.addedSlugs.length > 0" class="mt-1"><b class="font-semibold">Nuovi:</b> {{ status.pending.diff.styles.addedSlugs.join(', ') }}</p>
        <p v-if="status.pending.diff.styles.changedSlugs.length > 0" class="mt-1"><b class="font-semibold">Cambiati:</b> {{ status.pending.diff.styles.changedSlugs.join(', ') }}</p>
        <p v-if="status.pending.diff.styles.removedSlugs.length > 0" class="mt-1"><b class="font-semibold">Tolti:</b> {{ status.pending.diff.styles.removedSlugs.join(', ') }}</p>
      </details>
      <!-- The news of Open Design (I-21, D-186): what changed in the software, not only in styles and skills -->
      <p v-if="status.newsPreparing" class="text-[13px] text-muted" role="status">Preparo le novità del programma da GitHub…</p>
      <p v-else-if="status.pending.news?.state === 'missing' && status.adopted !== null" class="text-[13px] text-muted">{{ status.pending.news.message }}</p>
      <details v-else-if="status.pending.news?.state === 'ready' && status.pending.news.items.length > 0" class="text-[13px]" open>
        <summary class="cursor-pointer text-muted select-none">Novità del programma ({{ status.pending.news.items.length }})</summary>
        <ul class="m-0 mt-1 flex list-disc flex-col gap-0.5 pl-4">
          <li v-for="item in status.pending.news.items.slice(0, 12)" :key="item.key">
            <b class="font-semibold">{{ item.title }}</b><template v-if="item.summary !== ''"> — {{ item.summary }}</template>
          </li>
        </ul>
        <p class="mt-1 text-muted">
          {{ status.pending.news.items.length > 12 ? `E altre ${status.pending.news.items.length - 12}. ` : '' }}Per scegliere cosa rifare nello Studio: «Novità di Open Design», qui sotto.
        </p>
      </details>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="acting" @click="discard">Scarta</button>
        <button type="button" class="btn btn-primary px-3 py-1 text-[14px]" :disabled="acting" @click="adopt">Usa questa versione</button>
      </div>
    </div>

    <!-- The styles of the version in use -->
    <details v-if="status?.adopted" class="rounded-[10px] border border-line bg-surface text-[14px]" @toggle="opened">
      <summary class="cursor-pointer px-3 py-2 font-medium select-none">Sfoglia gli stili ({{ status.adopted.styles }})</summary>
      <div class="flex flex-col gap-2 border-t border-line px-3 py-2.5">
        <input v-model="query" type="search" class="field px-2.5 py-1.5 text-[14px]" placeholder="Cerca per nome, categoria o descrizione" aria-label="Cerca uno stile" />
        <div v-if="listError" class="flex flex-wrap items-center gap-2 text-[13px] text-danger" role="alert">
          <span class="flex-1">{{ listError }}</span>
          <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="loadStyles(true)">Riprova</button>
        </div>
        <p v-else-if="listing === null" class="text-[13px] text-muted">Leggo l’elenco…</p>
        <p v-else-if="shown.length === 0" class="text-[13px] text-muted">Nessuno stile con questa ricerca.</p>
        <ul v-else class="m-0 flex max-h-[420px] list-none flex-col overflow-auto p-0">
          <li v-for="item in shown" :key="item.slug" class="border-b border-line last:border-b-0">
            <button type="button" class="flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-surface-2" :aria-expanded="selected === item.slug" @click="choose(item.slug)">
              <span class="flex w-full min-w-0 items-baseline gap-2">
                <span class="truncate font-medium">{{ item.name }}</span>
                <span v-if="item.category" class="ml-auto shrink-0 text-[13px] text-muted">{{ item.category }}</span>
              </span>
              <span v-if="item.description" class="text-[13px] text-muted">{{ item.description }}</span>
            </button>
            <div v-if="selected === item.slug" class="px-2 pb-2">
              <p v-if="styleError" class="text-[13px] text-warn">{{ styleError }}</p>
              <p v-else-if="style === null" class="text-[13px] text-muted">Leggo lo stile…</p>
              <pre v-else class="max-h-[360px] overflow-auto rounded border border-line bg-surface-2 px-2.5 py-2 font-mono text-[12.5px] leading-[1.45] whitespace-pre-wrap">{{ style.text }}</pre>
            </div>
          </li>
        </ul>
        <p v-if="listing && listing.skills.length > 0" class="text-[13px] text-muted">Nel catalogo ci sono anche {{ listing.skills.length }} skill: si assegnano a un agente nella sua scheda Skill.</p>
      </div>
    </details>

    <!-- Credit and license -->
    <p v-if="status" class="text-[13px] text-muted">
      {{ creditText(status) }}
      <a :href="status.page" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">Repository e licenza</a>
    </p>
  </SettingsCard>
</template>

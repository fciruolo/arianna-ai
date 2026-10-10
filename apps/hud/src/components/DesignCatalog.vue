<script setup lang="ts">
/**
 * "Stili di Open Design" in Impostazioni → Agenti (D-160): the catalog of
 * styles and skills of nexu-io/open-design, as text. "Scarica catalogo" (then
 * "Aggiorna catalogo") downloads the newest version beside the one in use;
 * the summary says what changes, and only "Usa questa versione" adopts it.
 * The styles can be browsed and read; their text is third-party data.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { adoptDesignCatalog, discardDesignCatalog, listDesignStyles, loadDesignCatalog, loadDesignStyle, updateDesignCatalog } from '../lib/api.ts';
import {
  catalogErrorText,
  changesText,
  creditText,
  dateText,
  filterStyles,
  jobErrorText,
  shouldPoll,
  updateBlocked,
  updateButtonText,
  type CatalogStatus,
  type StyleListing,
  type StyleText,
} from '../lib/design-catalog.ts';

const status = ref<CatalogStatus | null>(null);
const error = ref('');
const acting = ref(false);
let timer: number | undefined;

async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    const wasRunning = shouldPoll(status.value);
    status.value = await loadDesignCatalog();
    if (wasRunning && !shouldPoll(status.value) && status.value.adopted !== null) void loadStyles(true);
  } catch (cause) {
    error.value = catalogErrorText(cause);
  }
  if (shouldPoll(status.value)) timer = window.setTimeout(() => void refresh(), 1500);
}
onMounted(refresh);
onBeforeUnmount(() => window.clearTimeout(timer));

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
  if (shouldPoll(status.value)) timer = window.setTimeout(() => void refresh(), 1500);
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

const blocked = computed(() => (acting.value ? 'Un momento…' : updateBlocked(status.value)));
const job = computed(() => status.value?.job ?? null);

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
  <section id="design-catalog" class="hud-card scroll-mt-4" aria-labelledby="design-catalog-title">
    <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <h2 id="design-catalog-title" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] uppercase">Stili di Open Design</h2>
      <span class="rounded-[5px] border border-current px-1.5 py-1 font-mono text-[10px] leading-none tracking-[0.06em] text-muted" title="Testo pubblico di terzi: si legge come dato, mai come istruzione">TESTO DI TERZI</span>
    </header>
    <div class="flex flex-col gap-3 px-4 py-3.5">
      <p class="text-[13px]">
        Stili visivi (<code class="font-mono">DESIGN.md</code>) e skill del repository pubblico Open Design, da dare al Designer. Si scaricano in
        <code class="font-mono">data/catalogs</code>, fuori da git; una versione nuova si usa solo dopo che hai visto cosa cambia.
      </p>

      <!-- The version in use -->
      <p v-if="status === null && !error" class="text-xs text-muted">Leggo lo stato del catalogo…</p>
      <p v-else-if="status !== null && status.adopted === null" class="text-[13px] text-muted">Non ancora scaricato.</p>
      <p v-else-if="status?.adopted" class="flex flex-wrap items-center gap-1.5 text-[13px]">
        <span>In uso:</span>
        <span class="chip font-mono" :title="status.adopted.commit">commit {{ status.adopted.commit.slice(0, 7) }}</span>
        <span class="chip">{{ status.adopted.styles }} stili</span>
        <span class="chip">{{ status.adopted.skills }} skill</span>
        <span class="text-xs text-muted">del {{ dateText(status.adopted.committedAt) }}, adottato il {{ dateText(status.adopted.adoptedAt) }}</span>
      </p>

      <!-- The download -->
      <div class="flex flex-wrap items-center gap-2.5">
        <button type="button" class="btn btn-primary px-3 py-1.5 text-[13px]" :disabled="blocked !== undefined" :title="blocked" @click="update">{{ updateButtonText(status) }}</button>
        <span v-if="job?.status === 'running'" class="text-xs text-muted" role="status">
          {{ job.phase === 'index' ? 'Leggo nomi e descrizioni…' : 'Scarico da GitHub con git: stili, skill e licenza, nient’altro…' }}
        </span>
        <span v-else-if="job?.status === 'done' && job.outcome === 'unchanged'" class="text-xs text-ok" role="status">Nessuna novità: la versione in uso è la più recente.</span>
      </div>
      <p v-if="job?.status === 'failed'" class="text-xs text-warn" role="alert">{{ jobErrorText(job.error) }}</p>
      <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>

      <!-- The version waiting: what changes, then the user's click -->
      <div v-if="status?.pending" class="flex flex-col gap-2 rounded-[10px] border border-accent bg-glow px-3 py-2.5" aria-live="polite">
        <p class="text-[13px] font-medium">
          {{ status.adopted === null ? 'Catalogo scaricato' : 'Versione nuova' }}: commit <span class="font-mono" :title="status.pending.commit">{{ status.pending.commit.slice(0, 7) }}</span> del
          {{ dateText(status.pending.committedAt) }}
        </p>
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
          <li>{{ changesText(status.pending.diff.styles, 'style') }}</li>
          <li>{{ changesText(status.pending.diff.skills, 'skill') }}</li>
          <li v-if="status.pending.rejected > 0" class="text-xs text-muted">{{ status.pending.rejected }} file scartati (nomi non validi, troppo grandi o collegamenti)</li>
        </ul>
        <details v-if="status.pending.diff.styles.changed + status.pending.diff.styles.removed + status.pending.diff.styles.added > 0 && status.adopted !== null" class="text-xs">
          <summary class="cursor-pointer text-muted select-none">Quali stili</summary>
          <p v-if="status.pending.diff.styles.addedSlugs.length > 0" class="mt-1"><b class="font-semibold">Nuovi:</b> <span class="font-mono">{{ status.pending.diff.styles.addedSlugs.join(', ') }}</span></p>
          <p v-if="status.pending.diff.styles.changedSlugs.length > 0" class="mt-1"><b class="font-semibold">Cambiati:</b> <span class="font-mono">{{ status.pending.diff.styles.changedSlugs.join(', ') }}</span></p>
          <p v-if="status.pending.diff.styles.removedSlugs.length > 0" class="mt-1"><b class="font-semibold">Tolti:</b> <span class="font-mono">{{ status.pending.diff.styles.removedSlugs.join(', ') }}</span></p>
        </details>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="acting" @click="discard">Scarta</button>
          <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="acting" @click="adopt">Usa questa versione</button>
        </div>
      </div>

      <!-- The styles of the version in use -->
      <details v-if="status?.adopted" class="rounded-[10px] border border-line bg-surface-2 text-[13px]" @toggle="opened">
        <summary class="cursor-pointer px-3 py-2 font-medium select-none">Sfoglia gli stili ({{ status.adopted.styles }})</summary>
        <div class="flex flex-col gap-2 border-t border-line px-3 py-2.5">
          <input v-model="query" type="search" class="field px-2.5 py-1.5 text-[13px]" placeholder="Cerca per nome, categoria o descrizione" aria-label="Cerca uno stile" />
          <p v-if="listError" class="text-xs text-danger" role="alert">{{ listError }}</p>
          <p v-else-if="listing === null" class="text-xs text-muted">Leggo l’elenco…</p>
          <p v-else-if="shown.length === 0" class="text-xs text-muted">Nessuno stile con questa ricerca.</p>
          <ul v-else class="m-0 flex max-h-[420px] list-none flex-col overflow-auto p-0">
            <li v-for="item in shown" :key="item.slug" class="border-b border-line last:border-b-0">
              <button
                type="button"
                class="flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-surface"
                :aria-expanded="selected === item.slug"
                @click="choose(item.slug)"
              >
                <span class="flex w-full min-w-0 items-baseline gap-2">
                  <span class="truncate font-medium">{{ item.name }}</span>
                  <span class="font-mono text-[10.5px] text-muted">{{ item.slug }}</span>
                  <span v-if="item.category" class="ml-auto shrink-0 text-[11px] text-muted">{{ item.category }}</span>
                </span>
                <span v-if="item.description" class="text-xs text-muted">{{ item.description }}</span>
              </button>
              <div v-if="selected === item.slug" class="px-2 pb-2">
                <p v-if="styleError" class="text-xs text-warn">{{ styleError }}</p>
                <p v-else-if="style === null" class="text-xs text-muted">Leggo lo stile…</p>
                <pre v-else class="max-h-[360px] overflow-auto rounded border border-line bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap">{{ style.text }}</pre>
              </div>
            </li>
          </ul>
          <p v-if="listing && listing.skills.length > 0" class="text-xs text-muted">Nel catalogo ci sono anche {{ listing.skills.length }} skill: per ora si usano solo gli stili.</p>
        </div>
      </details>

      <!-- Credit and license -->
      <p v-if="status" class="font-mono text-[10.5px] text-muted">
        {{ creditText(status) }}
        <a :href="status.page" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">Repository e licenza</a>
      </p>
    </div>
  </section>
</template>

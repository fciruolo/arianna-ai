<script setup lang="ts">
/**
 * "Cerca su Hugging Face" in Impostazioni → Modelli (I-10, D-139): a search
 * among the public MLX models, the card of the chosen one (files, sizes,
 * sha256 of the weights, why it cannot be added) and "Aggiungi al catalogo"
 * after a confirmation that says what is written and what leaves. Only the
 * typed text, or the chosen repository id, leaves the Mac, through the
 * gateway of the core. The new entry is experimental and without a role.
 */
import { computed, ref } from 'vue';

import { addFromHuggingFace, huggingFaceCard, searchHuggingFace } from '../lib/api.ts';
import { addLines, cardBlockers, cleanQuery, countText, EXCLUDED_TEXT, excludedFiles, hubErrorText, keptFiles, MAX_QUERY_LENGTH, resultLine, type HubCard, type HubSearchResult } from '../lib/huggingface.ts';
import { sizeText } from '../lib/models-page.ts';
import Icon from './Icon.vue';

/** `added`: the id of the new catalog entry, for the page to show it. */
const emit = defineEmits<{ added: [modelId: string] }>();

const open = ref(false);
const query = ref('');
const searching = ref(false);
const results = ref<HubSearchResult[] | null>(null);
const searchError = ref<string | null>(null);
const canSearch = computed(() => cleanQuery(query.value) !== undefined && !searching.value);

async function search(): Promise<void> {
  const text = cleanQuery(query.value);
  if (text === undefined || searching.value) return;
  searching.value = true;
  searchError.value = null;
  card.value = null;
  try {
    results.value = await searchHuggingFace(text);
  } catch (error) {
    searchError.value = hubErrorText(error);
  } finally {
    searching.value = false;
  }
}

const card = ref<HubCard | null>(null);
const cardFor = ref<string | null>(null);
const cardError = ref<string | null>(null);
const confirming = ref(false);
const adding = ref(false);
const addError = ref<string | null>(null);

async function choose(repo: string): Promise<void> {
  cardFor.value = repo;
  card.value = null;
  cardError.value = null;
  confirming.value = false;
  addError.value = null;
  try {
    const read = await huggingFaceCard(repo);
    if (cardFor.value === repo) card.value = read;
  } catch (error) {
    if (cardFor.value === repo) cardError.value = hubErrorText(error);
  }
}

async function add(): Promise<void> {
  const shown = card.value;
  if (shown === null || adding.value) return;
  adding.value = true;
  addError.value = null;
  try {
    const id = await addFromHuggingFace(shown.repo, shown.revision);
    confirming.value = false;
    card.value = { ...shown, inCatalog: id };
    results.value = results.value?.map((result) => (result.repo === shown.repo ? { ...result, inCatalog: id } : result)) ?? null;
    emit('added', id);
  } catch (error) {
    addError.value = hubErrorText(error);
  } finally {
    adding.value = false;
  }
}

const blockers = computed(() => (card.value === null ? [] : cardBlockers(card.value)));
</script>

<template>
  <section class="hud-card flex flex-col" aria-labelledby="hf-title">
    <button type="button" class="flex items-center gap-2 px-3.5 py-2.5 text-left" :aria-expanded="open" @click="open = !open">
      <h2 id="hf-title" class="hud-title flex-1">Cerca su Hugging Face</h2>
      <span class="text-xs text-muted">{{ open ? 'chiudi' : 'modelli MLX pubblici' }}</span>
    </button>
    <div v-if="open" class="flex flex-col gap-3 border-t border-line px-3.5 py-3">
      <p class="text-xs text-muted">
        Esce solo il testo che scrivi qui (Pubblico), passando dal gateway, verso huggingface.co: niente account, niente altro. Si cercano solo modelli in formato MLX, quello del server
        locale. Un modello aggiunto entra nel catalogo come sperimentale e senza ruoli.
      </p>
      <form class="flex flex-wrap items-center gap-2" role="search" @submit.prevent="search">
        <input
          v-model="query"
          type="search"
          class="field min-w-[180px] flex-1 px-2.5 py-1 text-[13px]"
          :maxlength="MAX_QUERY_LENGTH"
          placeholder="es. qwen3 4bit"
          aria-label="Cerca su Hugging Face"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="!canSearch">{{ searching ? 'Cerco…' : 'Cerca' }}</button>
      </form>
      <p v-if="searchError !== null" role="alert" class="text-xs text-danger">{{ searchError }}</p>

      <div v-if="results !== null" class="grid grid-cols-1 items-start gap-3 @4xl:grid-cols-[minmax(240px,340px)_minmax(0,1fr)]">
        <!-- Results -->
        <div class="flex max-h-[420px] flex-col overflow-y-auto rounded-[10px] border border-line" aria-label="Risultati">
          <p v-if="results.length === 0" class="px-3 py-2.5 text-xs text-muted">Nessun modello MLX con questo nome.</p>
          <button
            v-for="result in results"
            :key="result.repo"
            type="button"
            class="flex flex-col gap-0.5 border-t border-line px-3 py-2 text-left first:border-t-0 hover:bg-surface-2"
            :class="result.repo === cardFor ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--accent)]' : ''"
            :aria-current="result.repo === cardFor ? 'true' : undefined"
            @click="choose(result.repo)"
          >
            <span class="font-mono text-[12.5px] [overflow-wrap:anywhere]">{{ result.repo }}</span>
            <span class="text-xs text-muted">{{ resultLine(result) }}</span>
            <span v-if="result.inCatalog !== null" class="chip self-start text-ok">nel catalogo: {{ result.inCatalog }}</span>
          </button>
        </div>

        <!-- The card -->
        <div class="min-w-0" aria-live="polite">
          <p v-if="cardFor === null" class="text-xs text-muted">Scegli un risultato per vedere file, dimensioni e licenza.</p>
          <p v-else-if="cardError !== null" role="alert" class="text-xs text-danger">{{ cardError }}</p>
          <p v-else-if="card === null" class="text-xs text-muted">Leggo la scheda di {{ cardFor }}…</p>
          <div v-else class="flex flex-col gap-2.5">
            <div>
              <h3 class="font-mono text-[14px] font-semibold break-all">{{ card.repo }}</h3>
              <p class="text-xs text-muted">
                commit <span class="font-mono">{{ card.revision.slice(0, 7) }}</span><template v-if="card.modelType !== null"> · famiglia {{ card.modelType }}</template>
                <template v-if="card.pipeline !== null"> · {{ card.pipeline }}</template> · {{ countText(card.downloads) }} download
              </p>
            </div>
            <dl class="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3">
              <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">Peso</dt><dd class="text-[13px]">{{ sizeText(Math.max(card.sizeBytes, 1)) }}</dd></div>
              <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">RAM stimata</dt><dd class="text-[13px]">{{ card.ramMinGib }} GiB</dd></div>
              <div class="flex flex-col gap-0.5 bg-surface px-3 py-2"><dt class="hud-title text-[9.5px]">Licenza</dt><dd class="text-[13px]" :class="{ 'text-muted': card.license === null }">{{ card.license ?? 'non indicata' }}</dd></div>
            </dl>
            <details class="text-xs">
              <summary class="cursor-pointer text-muted hover:text-ink">{{ keptFiles(card).length }} file nel catalogo<template v-if="excludedFiles(card).length > 0">, {{ excludedFiles(card).length }} esclusi</template></summary>
              <ul class="mt-1.5 flex flex-col gap-0.5">
                <li v-for="file in keptFiles(card)" :key="file.path" class="flex flex-wrap gap-x-2">
                  <span class="font-mono [overflow-wrap:anywhere]">{{ file.path }}</span>
                  <span class="text-muted">{{ sizeText(Math.max(file.sizeBytes, 1)) }} · {{ file.sha256 !== null ? `sha256 ${file.sha256.slice(0, 8)}…` : 'sha256 calcolato quando lo aggiungi' }}</span>
                </li>
                <li v-for="file in excludedFiles(card)" :key="file.path" class="flex flex-wrap gap-x-2 text-muted">
                  <span class="font-mono line-through [overflow-wrap:anywhere]">{{ file.path }}</span>
                  <span>{{ file.excluded === null ? '' : EXCLUDED_TEXT[file.excluded] }}</span>
                </li>
              </ul>
            </details>
            <ul v-if="blockers.length > 0" class="flex list-disc flex-col gap-0.5 pl-5 text-xs text-warn">
              <li v-for="reason in blockers" :key="reason">{{ reason }}</li>
            </ul>
            <div v-if="!confirming" class="flex flex-wrap items-center gap-2">
              <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="blockers.length > 0" @click="confirming = true">Aggiungi al catalogo…</button>
              <a :href="`https://huggingface.co/${card.repo}`" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-xs text-muted hover:text-ink hover:underline">Pagina del modello<Icon name="external" :size="11" /></a>
            </div>
            <div v-else class="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5">
              <h4 class="hud-title text-[10.5px]">Aggiungere {{ card.suggestedId }} al catalogo?</h4>
              <p v-for="line in addLines(card)" :key="line" class="text-[12.5px]">{{ line }}</p>
              <p v-if="addError !== null" role="alert" class="text-xs text-danger">{{ addError }}</p>
              <div class="flex justify-end gap-2">
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="adding" @click="confirming = false">Annulla</button>
                <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="adding" @click="add">{{ adding ? 'Aggiungo…' : 'Aggiungi' }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { search } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import { useModal } from '../lib/modal.ts';
import {
  enterRow,
  highlightParts,
  IDLE_SEARCH,
  moveSelection,
  resultsText,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LIMIT,
  searchAnswered,
  searchFailed,
  searchFootnote,
  searchGroups,
  searchQuery,
  searchStarted,
  textChanged,
  type SearchKind,
  type SearchRow,
  type SearchState,
  type SearchTarget,
} from '../lib/search.ts';
import type { IconName } from '../icons.ts';
import LabelBadge from './LabelBadge.vue';
import Icon from './Icon.vue';

/**
 * "Cerca" (D-097): a window in the middle of the page over everything the
 * private chat may see (D-089). The query goes to the core only; nothing is
 * kept after the window closes.
 */
const emit = defineEmits<{ close: []; go: [target: SearchTarget] }>();

const dialog = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
useModal(dialog, () => emit('close'), input);

const text = ref('');
/** Rounds, stale answers and what Invio may open: `lib/search.ts`. */
const state = ref<SearchState>({ ...IDLE_SEARCH });

const result = computed(() => state.value.result);
const loading = computed(() => state.value.phase === 'waiting' || state.value.phase === 'loading');
const problem = computed(() => state.value.problem);
const selected = computed({
  get: () => state.value.selected,
  set: (value: number) => {
    state.value = { ...state.value, selected: value };
  },
});

const groups = computed(() => (result.value === null ? [] : searchGroups(result.value)));
const rows = computed<SearchRow[]>(() => groups.value.flatMap((group) => group.rows));
const footnote = computed(() => (result.value === null ? null : searchFootnote(result.value)));
const ready = computed(() => searchQuery(text.value) !== undefined);
const announce = computed(() => resultsText(state.value, rows.value.length));

const KIND_ICON: Record<SearchKind, IconName> = { conversation: 'chat', message: 'chat', note: 'thoughts', page: 'knowledge' };

let timer: number | undefined;
let controller: AbortController | undefined;

async function run(query: string, round: number): Promise<void> {
  const request = new AbortController();
  controller = request;
  state.value = searchStarted(state.value, round);
  try {
    const found = await search(query, SEARCH_LIMIT, request.signal);
    state.value = searchAnswered(state.value, round, found);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return;
    state.value = searchFailed(state.value, round, errorText(cause));
  }
}

watch(text, (value) => {
  // A new round at once: the old request stops, nothing selected until the new answer.
  window.clearTimeout(timer);
  controller?.abort();
  state.value = textChanged(state.value, value);
  const query = searchQuery(value);
  if (query === undefined) return;
  const round = state.value.round;
  timer = window.setTimeout(() => void run(query, round), SEARCH_DEBOUNCE_MS);
});

onBeforeUnmount(() => {
  window.clearTimeout(timer);
  controller?.abort();
});

/** The rows on screen belong to an older query: shown dimmed, never opened. */
const stale = computed(() => state.value.phase !== 'done');

function choose(row: SearchRow | undefined): void {
  if (row === undefined || stale.value) return;
  emit('go', row.target);
  emit('close');
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (rows.value.length === 0) return;
    selected.value = moveSelection(selected.value, rows.value.length, event.key === 'ArrowDown' ? 1 : -1);
    document.getElementById(`search-row-${String(selected.value)}`)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    // Only with the answer of the query on screen: never a row of an older one.
    const index = enterRow(state.value, rows.value.length);
    if (index !== undefined) choose(rows.value[index]);
  }
}

function indexOf(row: SearchRow): number {
  return rows.value.indexOf(row);
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]" @click.self="emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Cerca"
      tabindex="-1"
      class="hud-card flex max-h-[76vh] w-full max-w-[620px] flex-col bg-surface outline-none"
    >
      <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span class="text-muted"><Icon name="search" :size="18" /></span>
        <input
          ref="input"
          v-model="text"
          type="text"
          maxlength="200"
          role="combobox"
          aria-label="Cerca in conversazioni, messaggi, pensieri e pagine"
          aria-controls="search-results"
          :aria-expanded="rows.length > 0"
          :aria-activedescendant="selected >= 0 ? `search-row-${String(selected)}` : undefined"
          autocomplete="off"
          spellcheck="false"
          placeholder="Cerca in conversazioni, messaggi, pensieri e pagine"
          class="min-w-0 flex-1 bg-transparent py-1 text-[15px] outline-none placeholder:text-muted"
          @keydown="onKey"
        />
        <span class="font-mono text-[10.5px] text-muted" role="status" aria-live="polite">{{ announce }}</span>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-2 py-2.5 text-[13.5px]">
        <p v-if="!ready" class="px-2 py-4 text-center text-muted">Scrivi almeno 2 caratteri. Fino a Privato, come la chat privata.</p>
        <p v-else-if="problem !== null" role="alert" class="px-2 text-warn">Non riesco a cercare: {{ problem }}</p>
        <p v-else-if="result !== null && rows.length === 0 && !loading" class="px-2 py-4 text-center text-muted">Nessun risultato.</p>

        <div id="search-results" role="listbox" aria-label="Risultati" class="flex flex-col gap-3">
          <section v-for="group in groups" :key="group.kind" role="group" :aria-label="group.title">
            <h3 class="hud-title mx-2 mb-1">{{ group.title }}</h3>
            <div
              v-for="row in group.rows"
              :id="`search-row-${String(indexOf(row))}`"
              :key="row.key"
              role="option"
              :aria-selected="indexOf(row) === selected"
              class="flex cursor-pointer items-start gap-2.5 rounded-lg border px-2 py-1.5"
              :class="[indexOf(row) === selected ? 'border-line-strong bg-surface-2' : 'border-transparent hover:bg-surface-2', { 'opacity-50': stale }]"
              :aria-disabled="stale ? 'true' : undefined"
              @mousemove="selected = indexOf(row)"
              @click="choose(row)"
            >
              <span class="mt-0.5 text-muted"><Icon :name="KIND_ICON[row.kind]" :size="15" /></span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate font-medium">{{ row.title }}</span>
                  <span v-if="row.meta !== null" class="shrink-0 font-mono text-[10.5px] text-muted">{{ row.meta }}</span>
                  <LabelBadge class="shrink-0" :label="row.label" />
                </span>
                <span v-if="row.snippet !== null" class="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-muted">
                  <template v-for="(part, index) in highlightParts(row.snippet, row.highlight)" :key="index">
                    <mark v-if="part.mark" class="rounded-[3px] bg-accent/25 px-px text-ink">{{ part.text }}</mark>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </span>
              </span>
            </div>
          </section>
        </div>
      </div>

      <footer class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-[15px] py-2 font-mono text-[10.5px] text-muted">
        <span v-if="footnote !== null" class="min-w-0 flex-1 font-sans text-[11.5px]">{{ footnote }}</span>
        <span v-else class="flex-1" />
        <span>↑↓ scegli · Invio apri · Esc chiudi</span>
      </footer>
    </section>
  </div>
</template>

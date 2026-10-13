<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { approveArchive, discardArchive, loadArchive, proposeArchiveAgain } from '../lib/api.ts';
import {
  approveItemOf,
  archiveErrorText,
  editOf,
  folderText,
  isCorrected,
  movedText,
  titleProblem,
  type ArchiveEdit,
  type ArchiveFolder,
  type ArchiveItem,
} from '../lib/archive.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * "Da archiviare" (D-195): for each organized thought, where the Archivist
 * (the local model) proposes to file it in kb/. The user approves it as it
 * is, corrects folder, title and links first, or discards it; nothing moves
 * without a click, and the note keeps its label (never lower).
 */

const emit = defineEmits<{
  /** "Apri il pensiero": the thought in the panel of the page. */
  open: [name: string];
  /** Something moved or changed: the page reloads its list and the count. */
  changed: [];
  /** How many proposals wait, for the count of the filter. */
  count: [value: number];
}>();

const items = ref<ArchiveItem[]>([]);
const folders = ref<ArchiveFolder[]>([]);
const edits = ref<Record<string, ArchiveEdit>>({});
const selected = ref<Set<string>>(new Set());
const loading = ref(true);
const busy = ref(false);
const listError = ref<string | null>(null);
/** Per thought: why it did not move, or that it was proposed again. */
const notices = ref<Record<string, string>>({});
/** What moved in the last approval, shown above the list. */
const moved = ref<string[]>([]);

const fresh = computed(() => items.value.filter((item) => item.state === 'proposed'));
const chosen = computed(() => fresh.value.filter((item) => selected.value.has(item.name)));
const allChosen = computed(() => fresh.value.length > 0 && chosen.value.length === fresh.value.length);
const blocked = computed(() => chosen.value.some((item) => titleProblem(editFor(item).title) !== undefined));

function editFor(item: ArchiveItem): ArchiveEdit {
  return edits.value[item.name] ?? editOf(item);
}

function setEdit(item: ArchiveItem, change: Partial<ArchiveEdit>): void {
  edits.value = { ...edits.value, [item.name]: { ...editFor(item), ...change } };
}

function dropLink(item: ArchiveItem, path: string): void {
  setEdit(item, { links: editFor(item).links.filter((link) => link !== path) });
}

function toggle(name: string): void {
  const next = new Set(selected.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allChosen.value ? new Set() : new Set(fresh.value.map((item) => item.name));
}

function when(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return today ? `oggi ${date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : date.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The folder of a proposal when it is not among those allowed any more: still shown, so the select is not empty. */
function folderOptions(item: ArchiveItem): ArchiveFolder[] {
  const current = editFor(item).folder;
  return folders.value.some((folder) => folder.path === current) ? folders.value : [{ path: current, label: item.label }, ...folders.value];
}

async function refresh(): Promise<void> {
  try {
    const listing = await loadArchive();
    items.value = listing.proposals;
    folders.value = listing.folders;
    const names = new Set(listing.proposals.map((item) => item.name));
    // Corrections and choices of thoughts still listed stay; the others go.
    edits.value = Object.fromEntries(Object.entries(edits.value).filter(([name]) => names.has(name)));
    selected.value = new Set([...selected.value].filter((name) => names.has(name)));
    listError.value = null;
    emit('count', listing.proposals.filter((item) => item.state === 'proposed').length);
  } catch (cause) {
    listError.value = `Non riesco a caricare le proposte. ${errorText(cause)}`;
  } finally {
    loading.value = false;
  }
}

async function approve(list: readonly ArchiveItem[]): Promise<void> {
  if (busy.value || list.length === 0) return;
  busy.value = true;
  moved.value = [];
  try {
    const results = await approveArchive(list.map((item) => approveItemOf(item, editFor(item))));
    const next = { ...notices.value };
    const done: string[] = [];
    for (const result of results) {
      if (result.ok) {
        delete next[result.name];
        const item = list.find((candidate) => candidate.name === result.name);
        done.push(`«${item === undefined ? result.name : editFor(item).title.trim()}»: ${movedText(result)}`);
      } else next[result.name] = archiveErrorText(result.code);
    }
    notices.value = next;
    moved.value = done;
    await refresh();
    emit('changed');
  } catch (cause) {
    listError.value = errorText(cause);
  } finally {
    busy.value = false;
  }
}

async function discard(item: ArchiveItem): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await discardArchive(item.name, item.version);
    await refresh();
    emit('changed');
  } catch (cause) {
    notices.value = { ...notices.value, [item.name]: errorText(cause) };
  } finally {
    busy.value = false;
  }
}

async function proposeAgain(item: ArchiveItem): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await proposeArchiveAgain(item.name);
    notices.value = { ...notices.value, [item.name]: 'Chiesta una proposta nuova: il modello locale la scrive fra poco. Aggiorna fra qualche istante.' };
  } catch (cause) {
    notices.value = { ...notices.value, [item.name]: errorText(cause) };
  } finally {
    busy.value = false;
  }
}

defineExpose({ refresh });

onMounted(refresh);
</script>

<template>
  <section aria-label="Da archiviare" class="flex flex-col gap-3">
    <p v-if="listError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ listError }}</p>
    <ul v-if="moved.length > 0" role="status" class="flex flex-col gap-1 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[14px]">
      <li v-for="line in moved" :key="line" class="flex items-start gap-2"><span class="text-ok"><Icon name="approve" :size="15" /></span>{{ line }}</li>
    </ul>

    <p v-if="loading && items.length === 0" class="py-6 text-center text-[14px] text-muted">Carico le proposte…</p>
    <p v-else-if="!loading && items.length === 0 && listError === null" class="py-6 text-center text-sm text-muted">
      Niente da archiviare: i pensieri riordinati sono già al loro posto, o li hai lasciati nell’inbox.
    </p>

    <div v-if="fresh.length > 0" class="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[14px]">
      <label class="flex items-center gap-2">
        <input type="checkbox" class="accent-[var(--accent)]" :checked="allChosen" @change="toggleAll" />
        Seleziona tutte
      </label>
      <span class="min-w-[200px] flex-1 text-[13.5px] text-muted">
        {{ chosen.length === 1 ? '1 selezionata' : `${String(chosen.length)} selezionate` }} · si spostano con la cartella e il titolo che vedi
      </span>
      <button type="button" class="btn btn-primary px-2.5 py-1 text-[13.5px]" :disabled="busy || chosen.length === 0 || blocked" @click="approve(chosen)">
        <Icon name="approve" :size="15" />Approva le selezionate ({{ chosen.length }})
      </button>
    </div>

    <article
      v-for="item in items"
      :key="item.name"
      class="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5 rounded-xl border bg-surface px-3.5 py-3"
      :class="[item.state === 'expired' ? 'border-dashed border-line' : selected.has(item.name) ? 'border-accent' : 'border-line']"
    >
      <input
        type="checkbox"
        class="mt-1 accent-[var(--accent)]"
        :checked="selected.has(item.name)"
        :disabled="item.state === 'expired'"
        :aria-label="`Seleziona ${item.noteTitle ?? item.title}`"
        @change="toggle(item.name)"
      />
      <div class="min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span class="text-[14.5px] font-semibold break-words">{{ item.noteTitle ?? item.title }}</span>
          <LabelBadge :label="item.label" />
          <span v-if="item.state === 'expired'" class="ml-auto text-[13px] text-warn">proposta scaduta: il pensiero è cambiato dopo</span>
          <span v-else class="ml-auto text-[13px] text-muted">proposta {{ when(item.at) }}</span>
        </div>

        <template v-if="item.state === 'proposed'">
          <div class="mt-2 grid grid-cols-1 gap-x-3.5 gap-y-2 md:grid-cols-2">
            <label class="flex flex-col gap-1 text-[12.5px] text-muted">
              Sposta in
              <select
                class="w-full rounded-lg border bg-surface-2 px-2.5 py-1.5 text-[14px] text-ink outline-none"
                :class="editFor(item).folder === item.folder ? 'border-line-strong' : 'border-info'"
                :value="editFor(item).folder"
                @change="setEdit(item, { folder: ($event.target as HTMLSelectElement).value })"
              >
                <option v-for="folder in folderOptions(item)" :key="folder.path" :value="folder.path">{{ folderText(folder.path) }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-[12.5px] text-muted">
              Titolo
              <input
                type="text"
                class="w-full rounded-lg border bg-surface-2 px-2.5 py-1.5 text-[14px] text-ink outline-none"
                :class="titleProblem(editFor(item).title) === undefined ? 'border-line-strong' : 'border-danger'"
                :value="editFor(item).title"
                maxlength="80"
                @input="setEdit(item, { title: ($event.target as HTMLInputElement).value })"
              />
              <span v-if="titleProblem(editFor(item).title) !== undefined" class="text-danger">{{ titleProblem(editFor(item).title) }}</span>
            </label>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span class="text-muted">Collegamenti:</span>
            <span v-if="editFor(item).links.length === 0" class="text-muted">nessuno</span>
            <template v-for="link in item.links" :key="link.path">
              <span v-if="editFor(item).links.includes(link.path)" class="inline-flex items-center gap-1 rounded-full border border-line-strong py-0 pr-1 pl-2.5">
                {{ link.title }}
                <button type="button" class="rounded px-1 text-muted hover:text-danger" :aria-label="`Togli il collegamento a ${link.title}`" @click="dropLink(item, link.path)">×</button>
              </span>
            </template>
          </div>
          <p v-if="item.reason !== ''" class="mt-2 text-[13.5px] text-muted"><span class="font-semibold text-ink">Perché:</span> {{ item.reason }}</p>
          <p v-if="isCorrected(item, editFor(item))" class="mt-1 text-[13px] text-info">
            Hai corretto la proposta{{ editFor(item).folder === item.folder ? '' : ` (era ${folderText(item.folder)})` }}. L’etichetta resta {{ item.label === 'L2' ? 'Privato' : item.label }}.
          </p>
        </template>
        <p v-else class="mt-1.5 text-[13.5px] text-muted">
          Era: <span class="font-mono text-[12.5px]">{{ folderText(item.folder) }}</span> · «{{ item.title }}»
        </p>

        <p v-if="notices[item.name] !== undefined" role="status" class="mt-2 text-[13px] text-warn">{{ notices[item.name] }}</p>

        <div class="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            v-if="item.state === 'proposed'"
            type="button"
            class="btn btn-primary px-2.5 py-1 text-[13.5px]"
            :disabled="busy || titleProblem(editFor(item).title) !== undefined"
            @click="approve([item])"
          >
            <Icon name="approve" :size="15" />Approva
          </button>
          <button v-else type="button" class="btn px-2.5 py-1 text-[13.5px]" :disabled="busy" @click="proposeAgain(item)"><Icon name="retry" :size="14" />Proponi di nuovo</button>
          <button type="button" class="btn px-2.5 py-1 text-[13.5px]" @click="emit('open', item.name)"><Icon name="thoughts" :size="14" />Apri il pensiero</button>
          <button type="button" class="btn px-2.5 py-1 text-[13.5px] hover:text-danger" :disabled="busy" @click="discard(item)">Scarta</button>
        </div>
      </div>
    </article>
  </section>
</template>

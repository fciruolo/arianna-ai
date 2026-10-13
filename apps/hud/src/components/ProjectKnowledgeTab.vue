<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { addProjectNote, confirmPrivacy, deleteProjectNote, loadSettings, preparePrivacy, readProjectKnowledge } from '../lib/api.ts';
import { ApiError } from '../lib/api.ts';
import { DELETE_PROJECT_NOTE_TEXT } from '../lib/erase.ts';
import { errorText } from '../lib/italian.ts';
import { LABEL_OPTION, LABEL_TEXT } from '../lib/labels.ts';
import { browseErrorText, folderLabelByName, isFolderName, lowers, noteLabels, withFolderLabel, type BrowsableContainer, type KnowledgeFolder, type ProjectKnowledge } from '../lib/projects.ts';
import { folderCounts, noteDayText, noteGroups, notesCountText, raisedLabel, statusTone } from '../lib/projects-page.ts';
import { changeLines, writeError, type ChangeLine, type PrivacyProposal } from '../lib/settings.ts';
import type { Label } from '../lib/types.ts';
import DeleteConfirm from './DeleteConfirm.vue';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import ProjectNoteView from './ProjectNoteView.vue';

/**
 * The tab "Conoscenza" of Progetti (I-11, D-145, tappa P2), in three columns
 * as a mail (D-193): the management folders on the left with how many notes
 * each, the notes of the folder chosen in rows (title, date, first line, the
 * state of an IM) the most recent first, and the note open on the right, or
 * the form of "+ Nota". A folder's label is a privacy setting: its selector
 * sits on the row of its group and is written with the two steps of the
 * Settings (prepare, then this page's Conferma); a label that goes down says
 * so before the confirmation. A new note's label is shown before saving and
 * can only go up. Everything stays on this computer: the Coder does not see
 * these folders.
 */
const props = defineProps<{ container: BrowsableContainer }>();
/** "Apri la conversazione" after a note left once (D-187). */
const emit = defineEmits<{ conversation: [id: string] }>();

const LABELS: readonly Label[] = ['L0', 'L1', 'L2', 'L3'];
const ALL = '*';
const STATUS_CLASS = { done: 'border-ok text-ok', next: 'border-info text-info', plain: '' } as const;

const knowledge = ref<ProjectKnowledge | null>(null);
const problem = ref<string | null>(null);

async function load(): Promise<void> {
  const name = props.container.name;
  try {
    const found = await readProjectKnowledge(name);
    if (props.container.name === name) {
      knowledge.value = found;
      problem.value = null;
    }
  } catch (cause) {
    if (props.container.name === name) problem.value = browseErrorText(cause);
  }
}

// --- The folder chosen on the left, the search, the rows in the middle (D-193).
const chosenFolder = ref<string>(ALL);
const query = ref('');
const groups = computed(() => noteGroups(knowledge.value?.folders ?? [], knowledge.value?.notes ?? [], query.value, chosenFolder.value === ALL ? null : chosenFolder.value));
const counts = computed(() => folderCounts(knowledge.value?.notes ?? []));
/** The year of today, read when the list is drawn: a page left open past New Year shows the dates right. */
const thisYear = (): number => new Date().getFullYear();
/** An existing folder by name, ignoring case as the core does: `workplan` is the existing `Workplan`. */
const existingFolder = (path: string): KnowledgeFolder | undefined => knowledge.value?.folders.find((folder) => folder.path.toLowerCase() === path.trim().toLowerCase());
const folderLabel = (path: string): Label | undefined => existingFolder(path)?.label;

// --- The right column: the note open by its path, or the form of "+ Nota".
const opened = ref<string | null>(null);
const writing = ref(false);
const reader = ref<HTMLElement | null>(null);

/** Below 1100 px the note goes under the list: it is brought into view. */
function revealReader(): void {
  void nextTick(() => {
    if (window.innerWidth < 1100) reader.value?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function openNote(path: string): void {
  // A draft of "+ Nota" stays: "+ Nota" brings it back.
  writing.value = false;
  deleting.value = false;
  deleteError.value = null;
  opened.value = path;
  revealReader();
}

function closeNote(): void {
  opened.value = null;
  deleting.value = false;
}

// --- "Elimina" of the open note (D-157): its file goes for good, after the confirmation in place.
const deleting = ref(false);
const removing = ref(false);
const deleteError = ref<string | null>(null);

async function removeNote(path: string): Promise<void> {
  if (removing.value) return;
  removing.value = true;
  deleteError.value = null;
  try {
    await deleteProjectNote(props.container.name, path);
    deleting.value = false;
    if (opened.value === path) opened.value = null;
    await load();
  } catch (cause) {
    deleteError.value = `Non ho eliminato la nota. ${errorText(cause)}`;
  } finally {
    removing.value = false;
  }
}

const openedTitle = computed(() => knowledge.value?.notes.find((note) => note.path === opened.value)?.title ?? null);

// --- A folder relabeled: prepared on the settings, confirmed here.
const relabel = ref<{ folder: KnowledgeFolder; to: Label; proposal: PrivacyProposal | null; error: string | null; busy: boolean; spent: boolean } | null>(null);
const relabelLines = computed<ChangeLine[]>(() => (relabel.value?.proposal ? changeLines(relabel.value.proposal.changes) : []));
const relabelCancel = ref<HTMLButtonElement | null>(null);
watch(
  () => relabel.value !== null,
  async (open) => {
    if (!open) return;
    await nextTick();
    relabelCancel.value?.focus();
  },
);

function settingsError(cause: unknown): string {
  if (cause instanceof ApiError) return writeError(cause.status, cause.message).text;
  return errorText(cause);
}

async function chooseLabel(folder: KnowledgeFolder | undefined, event: Event): Promise<void> {
  const select = event.target;
  if (folder === undefined || !(select instanceof HTMLSelectElement)) return;
  const to = select.value as Label;
  // The selector shows the label in force until the confirmation writes the new one.
  select.value = folder.label;
  if (to === folder.label) return;
  relabel.value = { folder, to, proposal: null, error: null, busy: true, spent: false };
  try {
    const view = await loadSettings();
    if (view.fingerprint === null || view.values === null) throw new Error('le impostazioni non si leggono');
    const projects = withFolderLabel(view.values.projects, props.container.name, folder.path, to);
    const proposal = await preparePrivacy(view.fingerprint, { projects });
    if (relabel.value?.folder === folder) relabel.value = { ...relabel.value, proposal, busy: false };
  } catch (cause) {
    if (relabel.value?.folder === folder) relabel.value = { ...relabel.value, error: settingsError(cause), busy: false };
  }
}

async function confirmRelabel(): Promise<void> {
  const open = relabel.value;
  if (open?.proposal === null || open === null) return;
  relabel.value = { ...open, busy: true, error: null };
  try {
    await confirmPrivacy(open.proposal.id);
    relabel.value = null;
    await load();
  } catch (cause) {
    // The core spends the id even when it refuses.
    relabel.value = { ...open, busy: false, spent: true, error: `${settingsError(cause)} Chiudi e riprova.` };
  }
}

// --- "+ Nota", in the right column.
const adding = ref<{ folder: string; title: string; label: Label; text: string; busy: boolean; error: string | null } | null>(null);
const saved = ref<string | null>(null);
const titleInput = ref<HTMLInputElement | null>(null);

/** The label of a folder: the one it has, or for a new one the one its name gives (D-145). */
const labelOfFolder = (path: string): Label => folderLabel(path.trim()) ?? folderLabelByName(path);

function startAdding(): void {
  if (knowledge.value === null) return;
  saved.value = null;
  writing.value = true;
  deleting.value = false;
  if (adding.value === null) {
    // The folder chosen on the left, else an existing one, or Workplan for a project without folders yet.
    const folder = chosenFolder.value !== ALL ? chosenFolder.value : (knowledge.value.folders[0]?.path ?? 'Workplan');
    adding.value = { folder, title: '', label: labelOfFolder(folder), text: '', busy: false, error: null };
  }
  revealReader();
  void nextTick(() => titleInput.value?.focus());
}

function stopAdding(): void {
  adding.value = null;
  writing.value = false;
}

// Another folder proposes its own label; a lower one is never offered.
watch(
  () => adding.value?.folder,
  (folder) => {
    if (adding.value !== null && folder !== undefined) adding.value.label = labelOfFolder(folder);
  },
);
const addingNew = computed(() => adding.value !== null && isFolderName(adding.value.folder.trim()) && folderLabel(adding.value.folder.trim()) === undefined);
const addingLabels = computed(() => (adding.value === null ? [] : noteLabels(labelOfFolder(adding.value.folder))));
const canSave = computed(
  () => adding.value !== null && !adding.value.busy && isFolderName(adding.value.folder.trim()) && adding.value.title.trim() !== '' && adding.value.text.trim() !== '',
);

async function saveNote(): Promise<void> {
  const note = adding.value;
  if (note === null || !canSave.value) return;
  note.busy = true;
  note.error = null;
  try {
    const written = await addProjectNote(props.container.name, { folder: existingFolder(note.folder)?.path ?? note.folder.trim(), title: note.title.trim(), label: note.label, text: note.text });
    stopAdding();
    saved.value = `Nota salvata in ${written.path} (${LABEL_TEXT[written.label]}).`;
    await load();
    opened.value = written.path;
  } catch (cause) {
    note.busy = false;
    note.error = cause instanceof ApiError && cause.status === 400 ? `Arianna ha rifiutato la nota: ${cause.message}` : browseErrorText(cause);
  }
}

// Last: it runs at once and resets the state declared above (declared before, or the first run would find none).
watch(
  () => props.container.name,
  () => {
    knowledge.value = null;
    opened.value = null;
    writing.value = false;
    deleting.value = false;
    relabel.value = null;
    adding.value = null;
    saved.value = null;
    problem.value = null;
    query.value = '';
    chosenFolder.value = ALL;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="problem" class="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">
      <span class="flex-1">Non riesco a leggere la conoscenza: {{ problem }}</span>
      <button type="button" class="btn px-2.5 py-1 text-xs" @click="load"><Icon name="retry" :size="13" />Riprova</button>
    </div>
    <p v-else-if="knowledge === null" class="text-sm text-muted">Leggo la conoscenza…</p>

    <!-- Three columns as a mail (D-193): folders, notes, the note open; two below 1100 px, one below 700 px -->
    <div
      v-else
      class="grid grid-cols-1 overflow-hidden rounded-2xl border border-line bg-surface-2 min-[700px]:grid-cols-[200px_minmax(0,1fr)] min-[1100px]:h-[max(520px,calc(100dvh-230px))] min-[1100px]:grid-cols-[230px_360px_minmax(0,1fr)]"
    >
      <!-- Folders -->
      <nav class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface" aria-label="Cartelle">
        <div class="flex min-h-14 items-center gap-2 border-b border-line px-3.5 py-2.5">
          <h2 class="text-[15px] font-semibold">Cartelle</h2>
          <button type="button" class="btn btn-primary ml-auto inline-flex items-center gap-1 px-2.5 py-1 text-[13px] font-semibold" @click="startAdding"><Icon name="new" :size="13" />Nota</button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto py-1 max-[700px]:flex max-[700px]:overflow-x-auto max-[700px]:py-0 min-[700px]:max-[1100px]:max-h-[520px]">
          <button
            type="button"
            class="flex w-full items-center gap-2 border-l-3 px-3.5 py-2 text-left text-[14.5px] hover:bg-accent/5 max-[700px]:w-auto max-[700px]:shrink-0 max-[700px]:border-b-3 max-[700px]:border-l-0 max-[700px]:whitespace-nowrap"
            :class="chosenFolder === ALL ? 'border-accent bg-accent/10 font-semibold' : 'border-transparent'"
            :aria-pressed="chosenFolder === ALL"
            @click="chosenFolder = ALL"
          >
            Tutte le note<span class="ml-auto pl-2 text-[13px] font-normal text-muted tabular-nums">{{ knowledge.notes.length }}</span>
          </button>
          <button
            v-for="folder in knowledge.folders"
            :key="folder.path"
            type="button"
            class="flex w-full items-center gap-2 border-l-3 px-3.5 py-2 text-left text-[14.5px] hover:bg-accent/5 max-[700px]:w-auto max-[700px]:shrink-0 max-[700px]:border-b-3 max-[700px]:border-l-0 max-[700px]:whitespace-nowrap"
            :class="chosenFolder === folder.path ? 'border-accent bg-accent/10 font-semibold' : 'border-transparent'"
            :aria-pressed="chosenFolder === folder.path"
            :title="folder.path"
            @click="chosenFolder = folder.path"
          >
            <LabelBadge :label="folder.label" dot /><span class="min-w-0 truncate">{{ folder.path }}</span>
            <span class="ml-auto pl-2 text-[13px] font-normal text-muted tabular-nums">{{ counts.get(folder.path) ?? 0 }}</span>
          </button>
          <p v-if="knowledge.folders.length === 0" class="px-3.5 py-2 text-[13px] text-muted">Nessuna cartella ancora: la crea la prima nota.</p>
        </div>
        <div class="flex flex-col gap-2 border-t border-line px-3.5 py-3 text-[12.5px] text-muted">
          <span class="max-[700px]:hidden">
            In <span class="font-mono text-ink">{{ knowledge.where }}</span><template v-if="knowledge.inKb">: il progetto è un solo git, quindi le note stanno nella conoscenza di Arianna, fuori dal codice.</template><template v-else>, accanto alle parti di codice.</template>
          </span>
          <span class="max-[700px]:hidden">Una nota resta almeno al livello della sua cartella: l’intestazione può alzarlo, mai abbassarlo.</span>
          <p v-if="knowledge.repoFolders.length > 0" class="flex gap-2 rounded-xl border border-warn/50 bg-warn/10 px-2.5 py-2 text-[12.5px] text-ink">
            <span class="text-warn"><Icon name="warning" :size="14" /></span>
            <span>Dentro il repository ci sono anche {{ knowledge.repoFolders.map((folder) => `${folder.path} (${LABEL_TEXT[folder.label]})`).join(', ') }}: stanno nel codice, quindi con un file sopra Interno lì dentro il Coder non apre il progetto.</span>
          </p>
        </div>
      </nav>

      <!-- Notes -->
      <section class="flex min-h-0 min-w-0 flex-col overflow-hidden border-line max-[700px]:border-t min-[700px]:border-l" aria-label="Note">
        <div class="flex min-h-14 items-center gap-2 border-b border-line px-3.5 py-2.5">
          <label class="flex h-[34px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-muted">
            <Icon name="search" :size="14" />
            <input v-model="query" type="search" class="w-full bg-transparent text-[14px] text-ink outline-none" placeholder="Cerca fra le note" aria-label="Cerca fra le note, per titolo, cartella o prima riga" />
          </label>
        </div>
        <div class="min-h-0 flex-1 overflow-auto min-[700px]:max-[1100px]:max-h-[520px]">
          <div v-if="saved" class="m-2.5 flex items-center gap-2 rounded-xl border border-ok/45 bg-ok/9 px-3 py-2 text-[13.5px]" role="status">
            <span class="text-ok"><Icon name="saved" :size="15" /></span><span class="min-w-0 flex-1 break-words">{{ saved }}</span>
            <button type="button" class="grid size-6 place-items-center rounded-md text-muted hover:text-ink" aria-label="Chiudi" @click="saved = null"><Icon name="close" :size="13" /></button>
          </div>
          <div v-if="knowledge.notes.length === 0" class="flex flex-col items-start gap-2 p-4 text-[14px]">
            <p>Nessuna nota ancora. Le note dicono ad Arianna cose del progetto che non stanno nel codice, per esempio «il cliente vuole le call il giovedì».</p>
            <p v-if="knowledge.folders.length === 0" class="text-[13px] text-muted">Con «+ Nota» scrivi il nome di una cartella (per esempio Workplan, IM o documenti): la creo quando salvi la prima nota.</p>
          </div>
          <p v-else-if="groups.length === 0 && query.trim() !== ''" class="p-4 text-[14px] text-muted">Nessuna nota con «{{ query.trim() }}».</p>
          <div v-for="group in groups" :key="group.folder">
            <div class="flex items-center gap-2 px-3.5 pt-3 pb-1.5 text-[13px] text-muted">
              <b class="min-w-0 truncate text-[14px] text-ink">{{ group.folder }}</b>{{ notesCountText(group.notes.length) }}
              <select
                v-if="existingFolder(group.folder)"
                class="field ml-auto w-auto px-1.5 py-0.5 text-[13px] text-ink"
                :value="group.label"
                :aria-label="`Etichetta della cartella ${group.folder}`"
                title="Etichetta della cartella: cambiarla chiede conferma"
                :disabled="relabel !== null"
                @change="chooseLabel(existingFolder(group.folder), $event)"
              >
                <option v-for="label in LABELS" :key="label" :value="label">{{ LABEL_TEXT[label] }}</option>
              </select>
            </div>
            <p v-if="group.notes.length === 0" class="border-t border-line px-3.5 py-2.5 text-[13px] text-muted">Nessuna nota in questa cartella.</p>
            <button
              v-for="note in group.notes"
              :key="note.path"
              type="button"
              class="block w-full border-t border-line px-3.5 py-2.5 text-left hover:bg-accent/4"
              :class="opened === note.path && !writing ? 'bg-accent/10 shadow-[inset_3px_0_0_var(--accent)]' : ''"
              :title="note.path"
              :aria-current="opened === note.path && !writing ? 'true' : undefined"
              @click="openNote(note.path)"
            >
              <span class="flex items-baseline gap-2">
                <b class="min-w-0 flex-1 truncate font-semibold">{{ note.title }}</b>
                <span class="text-[12.5px] whitespace-nowrap text-muted tabular-nums">{{ noteDayText(note.date, thisYear()) }}</span>
              </span>
              <span v-if="note.excerpt" class="mt-0.5 line-clamp-2 text-[13.5px] text-muted">{{ note.excerpt }}</span>
              <span v-if="note.status || raisedLabel(note, group.label)" class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span v-if="note.status" class="pill px-2 py-0 text-[12.5px]" :class="STATUS_CLASS[statusTone(note.status)]">{{ note.status }}</span>
                <template v-if="raisedLabel(note, group.label)">
                  <LabelBadge :label="note.label" class="text-[12.5px]" /><span class="text-[12.5px] text-muted">alzata dall’intestazione</span>
                </template>
              </span>
            </button>
          </div>
          <p v-if="knowledge.more > 0" class="border-t border-line px-3.5 py-2.5 text-[13px] text-muted">Altre {{ knowledge.more }} note non mostrate.</p>
        </div>
      </section>

      <!-- The note open, the form of "+ Nota", or nothing chosen -->
      <div
        ref="reader"
        class="flex min-h-0 min-w-0 flex-col overflow-hidden border-line max-[1100px]:col-span-full max-[1100px]:border-t min-[1100px]:border-l"
        :class="{ 'max-[1100px]:hidden': !writing && opened === null }"
      >
        <template v-if="writing && adding">
          <div class="flex min-h-14 items-center gap-2 border-b border-line px-4 py-2.5">
            <span class="mr-auto text-[13px] text-muted">Nota nuova</span>
            <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="adding.busy" @click="stopAdding">Annulla</button>
          </div>
          <form class="flex min-h-0 max-w-[760px] flex-1 flex-col gap-3 overflow-auto px-4 py-4 sm:px-6" @submit.prevent="saveNote">
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1 text-[13px] text-muted">Cartella (una di queste, o un nome nuovo)
                <input v-model="adding.folder" list="knowledge-folders" maxlength="100" class="field px-2 py-1.5 text-[14px] text-ink" placeholder="Workplan" />
                <datalist id="knowledge-folders">
                  <option v-for="folder in knowledge.folders" :key="folder.path" :value="folder.path">{{ LABEL_TEXT[folder.label] }}</option>
                </datalist>
              </label>
              <label class="flex flex-col gap-1 text-[13px] text-muted">Etichetta
                <select v-model="adding.label" class="field px-2 py-1.5 text-[14px] text-ink">
                  <option v-for="label in addingLabels" :key="label" :value="label">{{ LABEL_OPTION[label] }}</option>
                </select>
              </label>
            </div>
            <label class="flex flex-col gap-1 text-[13px] text-muted">Titolo
              <input ref="titleInput" v-model="adding.title" maxlength="200" class="field px-2 py-1.5 text-[14px] text-ink" placeholder="Per esempio: Milestone di maggio" />
            </label>
            <label class="flex flex-col gap-1 text-[13px] text-muted">Testo
              <textarea v-model="adding.text" rows="10" class="field px-2 py-1.5 text-[14px] text-ink" placeholder="Quello che Arianna deve sapere di questo progetto" />
            </label>
            <p class="flex flex-wrap items-center gap-1.5 rounded-lg border border-info/45 bg-info/8 px-3 py-2 text-[14px]">
              Si salverà come <LabelBadge :label="adding.label" /> in <span class="font-mono text-[13px] break-all">{{ knowledge.where }}/{{ adding.folder.trim() }}</span>.
              <span v-if="addingNew" class="text-[13px] text-warn">Cartella nuova: la creo, {{ LABEL_TEXT[labelOfFolder(adding.folder)] }} per il suo nome.</span>
              <span class="text-[13px] text-muted">L’etichetta si può alzare, non scendere sotto quella della cartella.</span>
            </p>
            <p v-if="adding.folder.trim() !== '' && !isFolderName(adding.folder.trim())" class="text-[13px] text-danger">Il nome della cartella è uno solo: niente barre, niente punto all’inizio.</p>
            <p v-if="adding.error" class="rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">{{ adding.error }}</p>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="adding.busy" @click="stopAdding">Annulla</button>
              <button type="submit" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="!canSave">Salva la nota</button>
            </div>
          </form>
        </template>
        <ProjectNoteView
          v-else-if="opened"
          :project="container.name"
          :path="opened"
          :deleting="deleting"
          @close="closeNote"
          @saved="load"
          @open="(id) => emit('conversation', id)"
          @delete="
            deleteError = null;
            deleting = true;
          "
        >
          <div v-if="deleting" class="border-b border-line p-3">
            <DeleteConfirm
              :subject="openedTitle"
              :text="DELETE_PROJECT_NOTE_TEXT"
              :extra="deleteError"
              :busy="removing"
              @confirm="removeNote(opened)"
              @cancel="
                deleting = false;
                deleteError = null;
              "
            />
          </div>
        </ProjectNoteView>
        <div v-else class="grid h-full place-items-center p-8 text-center text-[14px] text-muted">
          <div class="flex flex-col items-center gap-2">
            <Icon name="knowledge" :size="26" />
            <span>Scegli una nota a sinistra per leggerla.</span>
            <span v-if="adding" class="text-[13px]">Hai una nota nuova a metà: «+ Nota» la riprende.</span>
          </div>
        </div>
      </div>
    </div>

    <!-- The new label of a folder: what changes, and "scende" when it goes down; written only with Conferma -->
    <div v-if="relabel" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="relabel-title" @keydown.esc="!relabel.busy && (relabel = null)">
      <div class="w-full max-w-[500px] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_70px_#0008]">
        <div class="flex gap-3.5 px-5 pt-5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg" :class="lowers(relabel.folder.label, relabel.to) ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'"><Icon name="warning" :size="16" /></span>
          <div>
            <h2 id="relabel-title" class="mt-0.5 mb-1 text-[16px] font-semibold">Etichetta di {{ relabel.folder.path }}</h2>
            <p class="flex flex-wrap items-center gap-1.5 text-[14px]"><LabelBadge :label="relabel.folder.label" /> → <LabelBadge :label="relabel.to" /></p>
          </div>
        </div>
        <p v-if="lowers(relabel.folder.label, relabel.to)" class="mx-5 mt-3 rounded-lg border border-danger/40 bg-danger/8 px-3 py-2 text-[14px]">
          <b>L’etichetta scende.</b> Le note di questa cartella senza un’etichetta più alta nell’intestazione diventano {{ LABEL_TEXT[relabel.to] }}: le leggerà anche una conversazione che oggi non le vede.
          <template v-if="relabel.to === 'L0' || relabel.to === 'L1'"> Restano comunque su questo computer: verso il cloud esce solo ciò che passa dal gateway.</template>
        </p>
        <div class="mx-5 mt-3">
          <p v-if="relabel.proposal === null && relabel.error === null" class="text-[14px] text-muted">Preparo la modifica…</p>
          <ul v-else-if="relabel.proposal" class="flex flex-col gap-1 text-[14px]">
            <li v-for="line in relabelLines" :key="line.text" class="break-words">{{ line.text }}</li>
          </ul>
          <p v-if="relabel.error" class="mt-2 text-sm text-danger" role="alert">{{ relabel.error }}</p>
        </div>
        <div class="mt-4 flex justify-end gap-2 border-t border-line px-5 py-3">
          <button ref="relabelCancel" type="button" class="btn px-3 py-1 text-[14px]" :disabled="relabel.busy" @click="relabel = null">Annulla</button>
          <button
            type="button"
            class="btn px-3 py-1 text-[14px] font-semibold"
            :class="lowers(relabel.folder.label, relabel.to) ? 'btn-danger' : 'btn-primary'"
            :disabled="relabel.busy || relabel.proposal === null || relabel.spent"
            @click="confirmRelabel"
          >
            {{ lowers(relabel.folder.label, relabel.to) ? `Sì, abbassa a ${LABEL_TEXT[relabel.to]}` : 'Conferma' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

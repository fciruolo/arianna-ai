<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { addProjectNote, confirmPrivacy, deleteProjectNote, loadSettings, preparePrivacy, readProjectKnowledge } from '../lib/api.ts';
import { ApiError } from '../lib/api.ts';
import { DELETE_PROJECT_NOTE_TEXT } from '../lib/erase.ts';
import { errorText } from '../lib/italian.ts';
import { LABEL_OPTION, LABEL_TEXT } from '../lib/labels.ts';
import { browseErrorText, folderLabelByName, isFolderName, lowers, noteLabels, withFolderLabel, type BrowsableContainer, type KnowledgeFolder, type ProjectKnowledge } from '../lib/projects.ts';
import { folderCounts, noteGroups, notesCountText } from '../lib/projects-page.ts';
import { changeLines, writeError, type ChangeLine, type PrivacyProposal } from '../lib/settings.ts';
import type { Label } from '../lib/types.ts';
import DeleteConfirm from './DeleteConfirm.vue';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import ProjectNoteView from './ProjectNoteView.vue';

/**
 * The tab "Conoscenza" of Progetti (I-11, D-145, tappa P2): the management
 * folders of the container, each with the selector of its label, and the
 * notes with theirs. A folder's label is a privacy setting: it is written
 * with the two steps of the Settings (prepare, then this page's Conferma),
 * and a label that goes down says so before the confirmation. "+ Nota"
 * writes a new note; its label is shown before saving and can only go up.
 * D-191: folders in the normal font with how many notes each, the notes as
 * cards by folder, a search on the titles and paths already read.
 * Everything stays on this computer: the Coder does not see these folders.
 * A note's title opens it, to read and to edit by hand (ProjectNoteView).
 */
const props = defineProps<{ container: BrowsableContainer }>();
/** "Apri la conversazione" after a note left once (D-187). */
const emit = defineEmits<{ conversation: [id: string] }>();

const LABELS: readonly Label[] = ['L0', 'L1', 'L2', 'L3'];

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

// The notes by folder as cards, with a search on the titles and paths the page has already (D-191).
const query = ref('');
const groups = computed(() => noteGroups(knowledge.value?.folders ?? [], knowledge.value?.notes ?? [], query.value));
const counts = computed(() => folderCounts(knowledge.value?.notes ?? []));
/** The name of a note's file, under its title. */
const fileName = (path: string): string => path.split('/').pop() ?? path;
/** An existing folder by name, ignoring case as the core does: `workplan` is the existing `Workplan`. */
const existingFolder = (path: string): KnowledgeFolder | undefined => knowledge.value?.folders.find((folder) => folder.path.toLowerCase() === path.trim().toLowerCase());
const folderLabel = (path: string): Label | undefined => existingFolder(path)?.label;

// --- The note open above the panels, by its path.
const opened = ref<string | null>(null);

// --- "Elimina" of a note (D-157): its file goes for good, after the confirmation in place.
const deleting = ref<string | null>(null);
const removing = ref(false);
const deleteError = ref<string | null>(null);

async function removeNote(path: string): Promise<void> {
  if (removing.value) return;
  removing.value = true;
  deleteError.value = null;
  try {
    await deleteProjectNote(props.container.name, path);
    deleting.value = null;
    if (opened.value === path) opened.value = null;
    await load();
  } catch (cause) {
    deleteError.value = `Non ho eliminato la nota. ${errorText(cause)}`;
  } finally {
    removing.value = false;
  }
}

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

async function chooseLabel(folder: KnowledgeFolder, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
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

// --- "+ Conoscenza".
const adding = ref<{ folder: string; title: string; label: Label; text: string; busy: boolean; error: string | null } | null>(null);
const saved = ref<string | null>(null);
const titleInput = ref<HTMLInputElement | null>(null);

/** The label of a folder: the one it has, or for a new one the one its name gives (D-145). */
const labelOfFolder = (path: string): Label => folderLabel(path.trim()) ?? folderLabelByName(path);

function startAdding(): void {
  if (knowledge.value === null) return;
  saved.value = null;
  // A first folder to propose: an existing one, or Workplan for a project without folders yet.
  const folder = knowledge.value.folders[0]?.path ?? 'Workplan';
  adding.value = { folder, title: '', label: labelOfFolder(folder), text: '', busy: false, error: null };
  void nextTick(() => titleInput.value?.focus());
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
    adding.value = null;
    saved.value = `Nota salvata in ${written.path} (${LABEL_TEXT[written.label]}).`;
    await load();
  } catch (cause) {
    note.busy = false;
    note.error = cause instanceof ApiError && cause.status === 400 ? `Il nucleo ha rifiutato la nota: ${cause.message}` : browseErrorText(cause);
  }
}

// Last: it runs at once and resets the state declared above (declared before, or the first run would find none).
watch(
  () => props.container.name,
  () => {
    knowledge.value = null;
    opened.value = null;
    relabel.value = null;
    adding.value = null;
    saved.value = null;
    problem.value = null;
    query.value = '';
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="grid flex-1 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
    <div v-if="problem" class="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px] lg:col-span-2" role="alert">
      <span class="flex-1">Non riesco a leggere la conoscenza: {{ problem }}</span>
      <button type="button" class="btn px-2.5 py-1 text-xs" @click="load"><Icon name="retry" :size="13" />Riprova</button>
    </div>
    <p v-else-if="knowledge === null" class="text-sm text-muted">Leggo la conoscenza…</p>
    <template v-else>
      <ProjectNoteView v-if="opened" class="lg:col-span-2" :project="container.name" :path="opened" @close="opened = null" @saved="load" @open="(id) => emit('conversation', id)" />

      <!-- The management folders, in the normal font, with how many notes each (D-145, D-191) -->
      <section class="flex flex-col gap-1 rounded-2xl border border-line bg-surface-2 px-4 py-3.5" aria-labelledby="folders-title">
        <h2 id="folders-title" class="text-[16px] font-semibold">Cartelle di gestione</h2>
        <p class="mb-1 text-[13px] text-muted">
          In <span class="font-mono text-ink">{{ knowledge.where }}</span><template v-if="knowledge.inKb">: il progetto è un solo git, quindi le note stanno nella conoscenza di Arianna, fuori dal codice.</template><template v-else>, accanto alle parti di codice: il Coder non le vede.</template>
        </p>
        <p v-if="knowledge.folders.length === 0" class="py-2 text-[14px] text-muted">
          Nessuna cartella di gestione ancora. Con «+ Nota» scrivi il nome di una cartella (per esempio Workplan, IM o documenti): la creo quando salvi la prima nota.
        </p>
        <ul v-else class="flex flex-col">
          <li v-for="folder in knowledge.folders" :key="folder.path" class="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
            <span class="min-w-0 flex-1">
              <b class="block truncate font-semibold">{{ folder.path }}</b>
              <span class="block text-[12.5px] text-muted">{{ notesCountText(counts.get(folder.path) ?? 0) }} · {{ folder.chosen ? `scelta tua (per nome: ${LABEL_TEXT[folder.defaultLabel]})` : 'etichetta per nome' }}</span>
            </span>
            <select class="field px-2 py-1 text-[14px] text-ink" :value="folder.label" :aria-label="`Etichetta della cartella ${folder.path}`" :disabled="relabel !== null" @change="chooseLabel(folder, $event)">
              <option v-for="label in LABELS" :key="label" :value="label">{{ LABEL_TEXT[label] }}</option>
            </select>
          </li>
        </ul>
        <p class="mt-1 text-[13px] text-muted">Una nota resta almeno al livello della sua cartella; la sua intestazione può alzarlo, mai abbassarlo. Tutto resta su questo computer.</p>
        <p v-if="knowledge.repoFolders.length > 0" class="mt-1 flex gap-2 rounded-xl border border-warn/50 bg-warn/10 px-3 py-2 text-[13px]">
          <span class="text-warn"><Icon name="warning" :size="14" /></span>
          <span>Dentro il repository ci sono anche {{ knowledge.repoFolders.map((folder) => `${folder.path} (${LABEL_TEXT[folder.label]})`).join(', ') }}: stanno nel codice, quindi con un file sopra Interno lì dentro il Coder non apre il progetto.</span>
        </p>
      </section>

      <!-- The notes, as cards by folder, with a search (D-191) -->
      <section class="flex min-w-0 flex-col gap-3" aria-labelledby="notes-title">
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="notes-title" class="mr-auto text-[16px] font-semibold">Note</h2>
          <label v-if="knowledge.notes.length > 0" class="flex h-[34px] w-full items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-muted sm:w-[260px]">
            <Icon name="search" :size="14" />
            <input v-model="query" type="search" class="w-full bg-transparent text-[14px] text-ink outline-none" placeholder="Cerca fra le note" aria-label="Cerca fra le note, per titolo o cartella" />
          </label>
          <button type="button" class="btn btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-[14px] font-semibold" :disabled="adding !== null" @click="startAdding"><Icon name="new" :size="14" />Nota</button>
        </div>
        <div v-if="saved" class="flex items-center gap-2.5 rounded-xl border border-ok/45 bg-ok/9 px-3 py-2 text-[14px]" role="status">
          <span class="text-ok"><Icon name="saved" :size="15" /></span><span class="min-w-0 flex-1">{{ saved }}</span>
          <button type="button" class="btn px-2 py-0.5 text-xs" @click="saved = null">Chiudi</button>
        </div>

        <form v-if="adding" class="flex flex-col gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-3.5" @submit.prevent="saveNote">
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
            <textarea v-model="adding.text" rows="6" class="field px-2 py-1.5 text-[14px] text-ink" placeholder="Quello che Arianna deve sapere di questo progetto" />
          </label>
          <p class="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[14px]">
            Si salverà come <LabelBadge :label="adding.label" /> in <span class="font-mono text-[13px]">{{ knowledge.where }}/{{ adding.folder.trim() }}</span>.
            <span v-if="addingNew" class="text-[13px] text-warn">Cartella nuova: la creo, {{ LABEL_TEXT[labelOfFolder(adding.folder)] }} per il suo nome.</span>
            <span class="text-[13px] text-muted">L’etichetta si può alzare, non scendere sotto quella della cartella.</span>
          </p>
          <p v-if="adding.folder.trim() !== '' && !isFolderName(adding.folder.trim())" class="text-[13px] text-danger">Il nome della cartella è uno solo: niente barre, niente punto all’inizio.</p>
          <p v-if="adding.error" class="rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">{{ adding.error }}</p>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="adding.busy" @click="adding = null">Annulla</button>
            <button type="submit" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="!canSave">Salva la nota</button>
          </div>
        </form>

        <div v-if="knowledge.notes.length === 0 && adding === null" class="flex flex-col items-start gap-2 rounded-2xl border border-line bg-surface-2 p-4">
          <p class="text-[14.5px]">Nessuna nota ancora. Le note dicono ad Arianna cose del progetto che non stanno nel codice, per esempio «il cliente vuole le call il giovedì».</p>
          <button type="button" class="btn btn-primary px-3 py-1 text-[14px]" @click="startAdding"><Icon name="new" :size="14" />Nota</button>
        </div>
        <p v-else-if="groups.length === 0 && query.trim() !== ''" class="text-[14px] text-muted">Nessuna nota con «{{ query.trim() }}» nel titolo o nella cartella.</p>
        <div v-for="group in groups" :key="group.folder" class="flex flex-col gap-2">
          <p class="flex items-center gap-2 font-semibold">
            {{ group.folder }}<LabelBadge v-if="group.label" :label="group.label" /><span class="text-[13px] font-normal text-muted">{{ group.notes.length }}</span>
          </p>
          <p v-if="group.notes.length === 0" class="text-[13px] text-muted">Nessuna nota in questa cartella.</p>
          <ul v-else class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5">
            <li v-for="note in group.notes" :key="note.path" class="group relative flex">
              <div v-if="deleting === note.path" class="w-full rounded-xl border border-danger/50 bg-surface-2 p-3">
                <DeleteConfirm
                  :subject="note.title"
                  :text="DELETE_PROJECT_NOTE_TEXT"
                  :extra="deleteError"
                  :busy="removing"
                  @confirm="removeNote(note.path)"
                  @cancel="
                    deleting = null;
                    deleteError = null;
                  "
                />
              </div>
              <template v-else>
                <button
                  type="button"
                  class="flex w-full flex-col gap-1.5 rounded-xl border bg-surface-2 px-3.5 py-3 text-left transition-colors hover:border-accent"
                  :class="opened === note.path ? 'border-accent' : 'border-line'"
                  :title="note.path"
                  :aria-current="opened === note.path ? 'true' : undefined"
                  @click="opened = note.path"
                >
                  <b class="pr-7 font-semibold break-words">{{ note.title }}</b>
                  <span class="mt-auto flex items-center gap-2 text-[12.5px] text-muted"><LabelBadge :label="note.label" /><span class="min-w-0 truncate font-mono text-[12px]">{{ fileName(note.path) }}</span></span>
                </button>
                <button
                  type="button"
                  class="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-muted transition hover:text-danger md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                  :aria-label="`Elimina per sempre ${note.title}`"
                  title="Elimina per sempre"
                  @click="
                    deleteError = null;
                    deleting = note.path;
                  "
                >
                  <Icon name="delete" :size="14" />
                </button>
              </template>
            </li>
          </ul>
        </div>
        <p v-if="knowledge.more > 0" class="text-[13px] text-muted">Altre {{ knowledge.more }} note non mostrate.</p>
      </section>
    </template>

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

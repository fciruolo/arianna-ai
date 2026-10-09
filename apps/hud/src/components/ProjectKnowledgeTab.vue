<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { addProjectNote, confirmPrivacy, loadSettings, preparePrivacy, readProjectKnowledge } from '../lib/api.ts';
import { ApiError } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import { browseErrorText, folderLabelByName, isFolderName, lowers, noteLabels, withFolderLabel, type BrowsableContainer, type KnowledgeFolder, type ProjectKnowledge } from '../lib/projects.ts';
import { changeLines, writeError, type ChangeLine, type PrivacyProposal } from '../lib/settings.ts';
import type { Label } from '../lib/types.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * The tab "Conoscenza" of Progetti (I-11, D-145, tappa P2): the management
 * folders of the container, each with the selector of its label, and the
 * notes with theirs. A folder's label is a privacy setting: it is written
 * with the two steps of the Settings (prepare, then this page's Conferma),
 * and a label that goes down says so before the confirmation. "+ Conoscenza"
 * writes a new note; its label is shown before saving and can only go up.
 * Everything stays on this computer: the Coder does not see these folders.
 */
const props = defineProps<{ container: BrowsableContainer }>();

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

const notesByFolder = computed(() => {
  const groups = new Map<string, ProjectKnowledge['notes']>();
  for (const folder of knowledge.value?.folders ?? []) groups.set(folder.path, []);
  for (const note of knowledge.value?.notes ?? []) groups.set(note.folder, [...(groups.get(note.folder) ?? []), note]);
  return [...groups.entries()];
});
/** An existing folder by name, ignoring case as the core does: `workplan` is the existing `Workplan`. */
const existingFolder = (path: string): KnowledgeFolder | undefined => knowledge.value?.folders.find((folder) => folder.path.toLowerCase() === path.trim().toLowerCase());
const folderLabel = (path: string): Label | undefined => existingFolder(path)?.label;

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
    relabel.value = null;
    adding.value = null;
    saved.value = null;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="grid flex-1 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-else-if="knowledge === null" class="text-sm text-muted">Leggo la conoscenza…</p>
    <template v-else>
      <!-- The panel of the folders: one selector each (D-145) -->
      <section class="rounded-2xl border border-line bg-surface" aria-labelledby="folders-title">
        <header class="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="private" :size="15" class="text-muted" />
          <h2 id="folders-title" class="hud-title flex-1">Cartelle di gestione</h2>
        </header>
        <p class="border-b border-line px-4 py-2 text-xs text-muted">
          In <span class="font-mono text-ink">{{ knowledge.where }}</span><template v-if="knowledge.inKb">: il progetto è un solo git, quindi le note stanno nella conoscenza di Arianna, fuori dal codice.</template><template v-else>, accanto alle parti di codice, mai dentro una parte.</template>
        </p>
        <p v-if="knowledge.folders.length === 0" class="p-4 text-sm text-muted">
          Nessuna cartella di gestione ancora. Con “+ Conoscenza” scrivi il nome di una cartella (per esempio Workplan, IM o documenti): la creo quando salvi la prima nota.
        </p>
        <ul v-else class="divide-y divide-line">
          <li v-for="folder in knowledge.folders" :key="folder.path" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
            <span class="min-w-0 flex-1">
              <span class="block truncate font-mono text-[13px]">{{ folder.path }}</span>
              <span class="block text-[11.5px] text-muted">{{ folder.chosen ? `scelta tua (per nome: ${LABEL_TEXT[folder.defaultLabel]})` : 'per nome' }}</span>
            </span>
            <LabelBadge :label="folder.label" class="text-xs" />
            <select class="field px-2 py-1 text-[13px] text-ink" :value="folder.label" :aria-label="`Etichetta della cartella ${folder.path}`" :disabled="relabel !== null" @change="chooseLabel(folder, $event)">
              <option v-for="label in LABELS" :key="label" :value="label">{{ LABEL_TEXT[label] }}</option>
            </select>
          </li>
        </ul>
        <p class="border-t border-line px-4 py-2.5 text-xs text-muted">
          Una nota resta almeno al livello della sua cartella; la sua intestazione può alzarla, mai abbassarla. Tutto resta su questo computer: il Coder non vede queste cartelle.
        </p>
        <p v-if="knowledge.repoFolders.length > 0" class="border-t border-line px-4 py-2.5 text-xs text-warn">
          Dentro il repository ci sono anche {{ knowledge.repoFolders.map((folder) => `${folder.path} (${LABEL_TEXT[folder.label]})`).join(', ') }}: stanno nel codice, quindi con un file sopra Interno lì dentro il Coder non apre il progetto.
        </p>
      </section>

      <!-- The notes, by folder -->
      <section class="rounded-2xl border border-line bg-surface" aria-labelledby="notes-title">
        <header class="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="knowledge" :size="15" class="text-muted" />
          <h2 id="notes-title" class="hud-title flex-1">Note</h2>
          <button type="button" class="btn btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold" :disabled="adding !== null" @click="startAdding">
            <Icon name="new" :size="13" />Conoscenza
          </button>
        </header>
        <p v-if="saved" class="border-b border-line px-4 py-2 text-xs text-ok" role="status">{{ saved }}</p>

        <form v-if="adding" class="flex flex-col gap-3 border-b border-line px-4 py-3.5" @submit.prevent="saveNote">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-xs text-muted">Cartella (una di queste, o un nome nuovo)
              <input v-model="adding.folder" list="knowledge-folders" maxlength="100" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="Workplan" />
              <datalist id="knowledge-folders">
                <option v-for="folder in knowledge.folders" :key="folder.path" :value="folder.path">{{ LABEL_TEXT[folder.label] }}</option>
              </datalist>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">Etichetta
              <select v-model="adding.label" class="field px-2 py-1.5 text-[13px] text-ink">
                <option v-for="label in addingLabels" :key="label" :value="label">{{ LABEL_TEXT[label] }}</option>
              </select>
            </label>
          </div>
          <label class="flex flex-col gap-1 text-xs text-muted">Titolo
            <input ref="titleInput" v-model="adding.title" maxlength="200" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="Per esempio: Milestone di maggio" />
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">Testo
            <textarea v-model="adding.text" rows="6" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="Quello che Arianna deve sapere di questo progetto" />
          </label>
          <p class="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px]">
            Si salverà come <LabelBadge :label="adding.label" /> in <span class="font-mono">{{ knowledge.where }}/{{ adding.folder.trim() }}</span>.
            <span v-if="addingNew" class="text-xs text-warn">Cartella nuova: la creo, {{ LABEL_TEXT[labelOfFolder(adding.folder)] }} per il suo nome.</span>
            <span class="text-xs text-muted">L’etichetta si può alzare, non scendere sotto quella della cartella.</span>
          </p>
          <p v-if="adding.folder.trim() !== '' && !isFolderName(adding.folder.trim())" class="text-xs text-danger">Il nome della cartella è uno solo: niente barre, niente punto all’inizio.</p>
          <p v-if="adding.error" class="text-sm text-danger" role="alert">{{ adding.error }}</p>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="adding.busy" @click="adding = null">Annulla</button>
            <button type="submit" class="btn btn-primary px-3 py-1 text-[13px] font-semibold" :disabled="!canSave">Salva la nota</button>
          </div>
        </form>

        <p v-if="knowledge.notes.length === 0" class="p-4 text-sm text-muted">Nessuna nota ancora: “+ Conoscenza” ne scrive una.</p>
        <div v-else class="divide-y divide-line">
          <div v-for="[folder, notes] in notesByFolder" :key="folder" class="px-4 py-2.5">
            <h3 class="mb-1.5 font-mono text-xs text-muted">{{ folder }}</h3>
            <p v-if="notes.length === 0" class="text-xs text-muted">Nessuna nota.</p>
            <ul v-else class="flex flex-col gap-1">
              <li v-for="note in notes" :key="note.path" class="flex items-center gap-2 text-[13px]">
                <span class="min-w-0 flex-1 truncate" :title="note.path">{{ note.title }}</span>
                <LabelBadge :label="note.label" class="text-xs" />
              </li>
            </ul>
          </div>
          <p v-if="knowledge.more > 0" class="px-4 py-2 text-xs text-muted">Altre {{ knowledge.more }} note non mostrate.</p>
        </div>
      </section>
    </template>

    <!-- The new label of a folder: what changes, and "scende" when it goes down; written only with Conferma -->
    <div v-if="relabel" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="relabel-title" @keydown.esc="!relabel.busy && (relabel = null)">
      <div class="w-full max-w-[500px] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_70px_#0008]">
        <div class="flex gap-3.5 px-5 pt-5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg" :class="lowers(relabel.folder.label, relabel.to) ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'"><Icon name="warning" :size="16" /></span>
          <div>
            <h2 id="relabel-title" class="mt-0.5 mb-1 text-[16px] font-semibold">Etichetta di {{ relabel.folder.path }}</h2>
            <p class="flex flex-wrap items-center gap-1.5 text-[13px]"><LabelBadge :label="relabel.folder.label" /> → <LabelBadge :label="relabel.to" /></p>
          </div>
        </div>
        <p v-if="lowers(relabel.folder.label, relabel.to)" class="mx-5 mt-3 rounded-lg border border-danger/40 bg-danger/8 px-3 py-2 text-[13px]">
          <b>L’etichetta scende.</b> Le note di questa cartella senza un’etichetta più alta nell’intestazione diventano {{ LABEL_TEXT[relabel.to] }}: le leggerà anche una conversazione che oggi non le vede.
          <template v-if="relabel.to === 'L0' || relabel.to === 'L1'"> Restano comunque su questo computer: verso il cloud esce solo ciò che passa dal gateway.</template>
        </p>
        <div class="mx-5 mt-3">
          <p v-if="relabel.proposal === null && relabel.error === null" class="text-[13px] text-muted">Preparo la modifica…</p>
          <ul v-else-if="relabel.proposal" class="flex flex-col gap-1 text-[13px]">
            <li v-for="line in relabelLines" :key="line.text" class="break-words">{{ line.text }}</li>
          </ul>
          <p v-if="relabel.error" class="mt-2 text-sm text-danger" role="alert">{{ relabel.error }}</p>
        </div>
        <div class="mt-4 flex justify-end gap-2 border-t border-line px-5 py-3">
          <button ref="relabelCancel" type="button" class="btn px-3 py-1 text-[13px]" :disabled="relabel.busy" @click="relabel = null">Annulla</button>
          <button
            type="button"
            class="btn px-3 py-1 text-[13px] font-semibold"
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

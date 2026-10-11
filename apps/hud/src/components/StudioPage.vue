<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, exportMockupPptx, listMockups, readMockup, writeMockup } from '../lib/api.ts';
import { buildSrcdoc, type FrameRect } from '../lib/studio-frame.ts';
import { deckFromDocument, editSource, hasSlides, parseMockup } from '../lib/studio-dom.ts';
import {
  COMMENTS_MAX,
  exportName,
  groupMockups,
  pickMockup,
  reviewMessage,
  studioErrorText,
  variantLabel,
  VIEW_TEXT,
  VIEW_WIDTH,
  type Mockup,
  type MockupList,
  type MockupText,
  type StudioAddress,
  type StudioComment,
  type StudioEdit as EditRequest,
  type StudioView,
} from '../lib/studio.ts';
import type { ProjectInfo } from '../lib/types.ts';
import type { IconName } from '../icons.ts';
import Icon from './Icon.vue';
import StudioComments from './StudioComments.vue';
import StudioEdit from './StudioEdit.vue';
import StudioFrame from './StudioFrame.vue';

/**
 * The page «Studio» (I-19, D-184): on the left the direct chat with the
 * Designer of the chosen project (the slot, filled by the app with the chat
 * it already has), on the right the canvas with the project's mockups in an
 * isolated frame: variants by group, desktop, tablet and mobile views, two
 * variants side by side, comments on the elements sent as one message,
 * the direct edit of an element written in the file, and the exports.
 */
const props = defineProps<{
  projects: ProjectInfo[];
  address: StudioAddress;
  /** Changes when a task of the chat ends: the Designer may have written a file. */
  version: number;
  /** Sends one message in the conversation with the Designer; false when it did not leave. */
  send: (body: string) => Promise<boolean>;
  /** Why a message cannot go to the Designer now, or undefined. */
  chatBlocked: string | undefined;
}>();
const emit = defineEmits<{ address: [address: StudioAddress] }>();

const project = computed(() => props.address.project);
const list = ref<MockupList | null>(null);
const listProblem = ref<string | null>(null);
const shown = ref<MockupText | null>(null);
const shownProblem = ref<string | null>(null);
/** The variant beside it, when comparing. */
const other = ref<MockupText | null>(null);
const otherProblem = ref<string | null>(null);
const notice = ref<string | null>(null);

// Comments (O3) and direct edit (O6): a click in the frame picks an element for one or the other.
type PickMode = 'none' | 'comment' | 'edit';
const pickMode = ref<PickMode>('none');
const comments = ref<StudioComment[]>([]);
const pending = ref<{ selector: string; tag: string; excerpt: string } | null>(null);
const highlight = ref<string | null>(null);
const editing = ref<{ selector: string; tag: string } | null>(null);
const saving = ref(false);
const editProblem = ref<string | null>(null);

const groups = computed(() => groupMockups(list.value?.files ?? []));
const current = computed<Mockup | undefined>(() => list.value?.files.find((file) => file.path === props.address.file));
const currentGroup = computed(() => groups.value.find((group) => group.group === current.value?.group));

function choose(file: string | undefined): void {
  emit('address', { ...(project.value === undefined ? {} : { project: project.value }), ...(file === undefined ? {} : { file }) });
}

function chooseProject(name: string): void {
  comments.value = [];
  pending.value = null;
  editing.value = null;
  emit('address', name === '' ? {} : { project: name });
}

let listToken = 0;
async function loadList(): Promise<void> {
  const name = project.value;
  if (name === undefined) {
    list.value = null;
    return;
  }
  const token = ++listToken;
  try {
    const result = await listMockups(name);
    if (token !== listToken) return;
    list.value = result;
    listProblem.value = null;
    // No file asked for, or one that is gone: the most recent.
    const wanted = props.address.file;
    if (wanted === undefined || !result.files.some((file) => file.path === wanted)) {
      const first = pickMockup(result.files, wanted);
      if (first !== undefined) choose(first.path);
    }
  } catch (cause) {
    if (token === listToken) listProblem.value = studioErrorText(cause);
  }
}

/** The latest read of each frame wins: an older answer arriving late is dropped. */
const fileTokens = { shown: 0, other: 0 };
async function loadFile(path: string | undefined, target: 'shown' | 'other'): Promise<void> {
  const into = target === 'shown' ? shown : other;
  const problem = target === 'shown' ? shownProblem : otherProblem;
  const name = project.value;
  if (name === undefined || path === undefined) {
    into.value = null;
    return;
  }
  const token = ++fileTokens[target];
  try {
    const text = await readMockup(name, path);
    if (token !== fileTokens[target]) return;
    into.value = text;
    problem.value = null;
  } catch (cause) {
    if (token === fileTokens[target]) problem.value = studioErrorText(cause);
  }
}

watch(project, () => {
  list.value = null;
  shown.value = null;
  void loadList();
}, { immediate: true });
watch(() => props.address.file, (path) => {
  pending.value = null;
  editing.value = null;
  if (shown.value?.path !== path) shown.value = null;
  void loadFile(path, 'shown');
}, { immediate: true });
// A file rewritten by the Designer (its sha256 changed in the list): read again.
watch(current, (file) => {
  if (file !== undefined && shown.value !== null && shown.value.path === file.path && shown.value.sha256 !== file.sha256 && !saving.value) {
    void loadFile(file.path, 'shown');
  }
});
watch(() => props.version, () => void loadList());

// The list is read again every 15 s while the page is in view: the Designer's run writes files in the project.
let timer: number | undefined;
onMounted(() => {
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void loadList();
  }, 15_000);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  clearPrint();
});

// Views and comparison (O4)
const view = ref<StudioView>('desktop');
const VIEWS: StudioView[] = ['desktop', 'tablet', 'mobile'];
const VIEW_ICON: Record<StudioView, IconName> = { desktop: 'view-desktop', tablet: 'view-tablet', mobile: 'view-mobile' };
const frameStyle = computed(() => {
  const width = VIEW_WIDTH[view.value];
  return width === null ? { width: '100%' } : { width: `${String(width)}px`, maxWidth: '100%' };
});
const comparing = ref(false);
const otherPath = ref<string | undefined>(undefined);
watch([comparing, otherPath], ([on, path]) => {
  if (!on) return;
  void loadFile(path, 'other');
});
function toggleCompare(): void {
  comparing.value = !comparing.value;
  if (comparing.value && otherPath.value === undefined) {
    const variants = currentGroup.value?.variants ?? [];
    otherPath.value = variants.filter((file) => file.path !== props.address.file).at(-1)?.path ?? list.value?.files.find((file) => file.path !== props.address.file)?.path;
  }
}

let nextId = 1;
const sending = ref(false);

function setMode(mode: PickMode): void {
  pickMode.value = pickMode.value === mode ? 'none' : mode;
  if (pickMode.value !== 'comment') pending.value = null;
  if (pickMode.value === 'edit') comparing.value = false;
}

function onPick(pick: { selector: string; rect: FrameRect; tag: string; excerpt: string }): void {
  highlight.value = pick.selector;
  if (pickMode.value === 'comment') pending.value = { selector: pick.selector, tag: pick.tag, excerpt: pick.excerpt };
  else if (pickMode.value === 'edit') editing.value = { selector: pick.selector, tag: pick.tag };
}

function addComment(text: string): void {
  const file = props.address.file;
  if (pending.value === null || file === undefined || comments.value.length >= COMMENTS_MAX) return;
  comments.value = [...comments.value, { id: nextId++, file, ...pending.value, text }];
  pending.value = null;
  highlight.value = null;
}

function updateComment(id: number, text: string): void {
  comments.value = comments.value.map((comment) => (comment.id === id ? { ...comment, text } : comment));
}

function removeComment(id: number): void {
  comments.value = comments.value.filter((comment) => comment.id !== id);
}

function focusComment(selector: string | null): void {
  highlight.value = selector;
}

async function sendComments(): Promise<void> {
  if (comments.value.length === 0 || sending.value || props.chatBlocked !== undefined) return;
  sending.value = true;
  try {
    const sent = await props.send(reviewMessage(comments.value, list.value?.files ?? []));
    if (sent) {
      comments.value = [];
      pickMode.value = 'none';
      highlight.value = null;
      notice.value = 'Commenti inviati al Designer: la variante nuova compare qui quando ha finito.';
    }
  } finally {
    sending.value = false;
  }
}

// Direct edit (O6)

async function saveEdit(edit: EditRequest): Promise<void> {
  const name = project.value;
  const base = shown.value;
  if (name === undefined || base === null || saving.value) return;
  editProblem.value = null;
  const result = editSource(base.text, edit);
  if (!result.ok) {
    editProblem.value =
      result.reason === 'not-found'
        ? 'L’elemento non c’è più nel file.'
        : result.reason === 'not-text'
          ? 'Il testo di questo elemento contiene altri elementi.'
          : 'Valori non accettati.';
    return;
  }
  saving.value = true;
  try {
    const written = await writeMockup(name, base.path, result.text, base.sha256);
    shown.value = { path: written.path, text: result.text, sha256: written.sha256 };
    notice.value = 'Modifica salvata nel file.';
    void loadList();
  } catch (cause) {
    editProblem.value = studioErrorText(cause);
    if (cause instanceof ApiError && cause.status === 409) {
      await loadFile(base.path, 'shown');
      void loadList();
    }
  } finally {
    saving.value = false;
  }
}

// Exports (O5)
const isDeck = computed(() => (shown.value === null ? false : hasSlides(parseMockup(shown.value.text))));
const exporting = ref(false);
const exportProblem = ref<string | null>(null);

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

function exportHtml(): void {
  const file = shown.value;
  if (file === null) return;
  download(new Blob([file.text], { type: 'text/html;charset=utf-8' }), exportName(file.path, 'html'));
}

/**
 * PDF: the browser's print of the mockup, from a frame of its own that
 * also has `allow-modals` (a sandboxed frame may not open the print dialog
 * without it); the canvas never has it. Still no `allow-same-origin`.
 */
const printDoc = ref<string | null>(null);
let printTimer: number | undefined;
function clearPrint(): void {
  window.clearTimeout(printTimer);
  printDoc.value = null;
}
function exportPdf(): void {
  const file = shown.value;
  if (file === null) return;
  clearPrint();
  // On the next tick: a new frame each time, so the print starts again.
  window.setTimeout(() => {
    printDoc.value = buildSrcdoc(file.text, 'print');
    printTimer = window.setTimeout(clearPrint, 120_000);
  }, 0);
}

async function exportPptx(): Promise<void> {
  const name = project.value;
  const file = shown.value;
  if (name === undefined || file === null || exporting.value) return;
  exportProblem.value = null;
  const deck = deckFromDocument(parseMockup(file.text), exportName(file.path, 'html').replace(/\.html$/, ''));
  if (deck === undefined) {
    exportProblem.value = 'Questo mockup non ha diapositive (section[data-slide]).';
    return;
  }
  exporting.value = true;
  try {
    download(await exportMockupPptx(name, file.path, deck), exportName(file.path, 'pptx'));
  } catch (cause) {
    exportProblem.value = studioErrorText(cause);
  } finally {
    exporting.value = false;
  }
}

/** On narrow screens one side at a time. */
const side = ref<'chat' | 'canvas'>('canvas');
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col" aria-label="Studio">
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 md:px-6">
      <label class="flex items-center gap-2 text-[12.5px] text-muted">
        <Icon name="project" :size="14" />
        <span class="sr-only">Progetto</span>
        <select class="field px-2 py-1 text-[13px] text-ink" :value="project ?? ''" @change="chooseProject(($event.target as HTMLSelectElement).value)">
          <option value="">Scegli un progetto…</option>
          <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }}</option>
        </select>
      </label>
      <p class="flex items-center gap-1.5 text-[11.5px] text-muted" role="note">
        <Icon name="private" :size="12" />I mockup si vedono in una cornice isolata: niente rete, niente accesso alla chat.
      </p>
      <div class="ml-auto flex gap-1 lg:hidden" role="group" aria-label="Lato mostrato">
        <button type="button" class="btn px-2.5 py-1 text-xs" :aria-pressed="side === 'chat'" :class="{ 'btn-primary': side === 'chat' }" @click="side = 'chat'">Conversazione</button>
        <button type="button" class="btn px-2.5 py-1 text-xs" :aria-pressed="side === 'canvas'" :class="{ 'btn-primary': side === 'canvas' }" @click="side = 'canvas'">Canvas</button>
      </div>
    </div>

    <div v-if="project === undefined" class="flex flex-1 items-center justify-center p-8 text-center">
      <div class="flex max-w-md flex-col items-center gap-3">
        <Icon name="studio" :size="28" />
        <p class="font-hud text-lg font-semibold tracking-[0.05em]">Studio di design</p>
        <p class="text-sm text-muted">
          Scegli un progetto: a sinistra parli col Designer, a destra vedi i suoi mockup, lasci commenti sugli elementi e li esporti.
        </p>
      </div>
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(340px,2fr)_3fr]">
      <!-- Left: the direct chat with the Designer of this project. -->
      <div class="min-h-0 flex-col border-line lg:flex lg:border-r" :class="side === 'chat' ? 'flex' : 'hidden'">
        <slot name="chat" />
      </div>

      <!-- Right: the canvas. -->
      <div class="min-h-0 flex-col gap-2 overflow-auto p-3 lg:flex" :class="side === 'canvas' ? 'flex' : 'hidden'">
        <div v-if="listProblem !== null" class="flex flex-wrap items-center gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm" role="alert">
          <span class="flex-1">{{ listProblem }}</span>
          <button type="button" class="btn px-2.5 py-1 text-xs" @click="loadList"><Icon name="retry" :size="13" />Riprova</button>
        </div>
        <p v-else-if="list === null" class="text-sm text-muted">Carico i mockup…</p>
        <div v-else-if="list.files.length === 0" class="rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">
          Nessun mockup in <code class="font-mono">{{ list.folder }}/</code>. Chiedi al Designer una pagina nella conversazione: compare qui quando ha finito.
        </div>
        <template v-else>
          <!-- Toolbar: group and variants, views, tools. -->
          <div class="flex flex-wrap items-center gap-2">
            <select
              v-if="groups.length > 1"
              class="field px-2 py-1 text-[12.5px]"
              aria-label="Mockup"
              :value="current?.group ?? ''"
              @change="choose(groups.find((group) => group.group === ($event.target as HTMLSelectElement).value)?.variants.at(-1)?.path)"
            >
              <option v-for="group in groups" :key="group.group" :value="group.group">{{ group.group }}</option>
            </select>
            <span v-else class="font-mono text-[12px]">{{ groups[0]?.group }}</span>
            <div class="flex gap-1" role="group" aria-label="Varianti">
              <button
                v-for="file in currentGroup?.variants ?? []"
                :key="file.path"
                type="button"
                class="rounded-md border px-2 py-0.5 font-mono text-[11px]"
                :class="file.path === address.file ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong text-muted hover:text-ink'"
                :aria-pressed="file.path === address.file"
                :title="`${file.name} · ${new Date(file.modified).toLocaleString('it-IT')}`"
                @click="choose(file.path)"
              >{{ variantLabel(file) }}</button>
            </div>
            <div class="ml-auto flex gap-1" role="group" aria-label="Vista">
              <button
                v-for="name in VIEWS"
                :key="name"
                type="button"
                class="grid size-7 place-items-center rounded-md"
                :class="view === name ? 'bg-surface-2 text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
                :aria-pressed="view === name"
                :aria-label="VIEW_TEXT[name]"
                :title="VIEW_TEXT[name]"
                @click="view = name"
              ><Icon :name="VIEW_ICON[name]" :size="15" /></button>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <button type="button" class="btn px-2.5 py-1 text-xs" :class="{ 'btn-primary': pickMode === 'comment' }" :aria-pressed="pickMode === 'comment'" @click="setMode('comment')">
              <Icon name="comment" :size="13" />Commenta
            </button>
            <button type="button" class="btn px-2.5 py-1 text-xs" :class="{ 'btn-primary': pickMode === 'edit' }" :aria-pressed="pickMode === 'edit'" @click="setMode('edit')">
              <Icon name="rename" :size="13" />Modifica
            </button>
            <button type="button" class="btn px-2.5 py-1 text-xs" :class="{ 'btn-primary': comparing }" :aria-pressed="comparing" :disabled="list.files.length < 2" @click="toggleCompare">
              <Icon name="compare" :size="13" />Confronta
            </button>
            <span class="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="shown === null" title="Scarica il file HTML del mockup" @click="exportHtml"><Icon name="download" :size="13" />HTML</button>
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="shown === null" title="Stampa del browser: scegli «Salva come PDF»" @click="exportPdf"><Icon name="print" :size="13" />PDF</button>
            <button
              v-if="isDeck"
              type="button"
              class="btn px-2.5 py-1 text-xs"
              :disabled="exporting"
              title="Presentazione PowerPoint dalle diapositive del mockup"
              @click="exportPptx"
            ><Icon name="download" :size="13" />{{ exporting ? 'Preparo…' : 'PPTX' }}</button>
            <button type="button" class="btn ml-auto px-2.5 py-1 text-xs" title="Rileggi l’elenco dei mockup" @click="loadList(); loadFile(address.file, 'shown')"><Icon name="retry" :size="13" />Ricarica</button>
          </div>
          <p v-if="pickMode === 'comment'" class="text-[11.5px] text-muted">Fai clic su un elemento della pagina per commentarlo; i link e i pulsanti non scattano.</p>
          <p v-else-if="pickMode === 'edit'" class="text-[11.5px] text-muted">Fai clic su un elemento per cambiarne testo, colori e spaziature.</p>
          <p v-if="exportProblem !== null" class="text-xs text-warn" role="alert">{{ exportProblem }}</p>
          <p v-if="notice !== null" class="flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs" role="status">
            <Icon name="saved" :size="13" /><span class="flex-1">{{ notice }}</span>
            <button type="button" class="rounded p-0.5 hover:bg-surface-2" aria-label="Chiudi" @click="notice = null"><Icon name="close" :size="12" /></button>
          </p>

          <!-- The frames. -->
          <div class="flex min-h-[480px] flex-1 gap-2">
            <div class="flex min-w-0 flex-1 flex-col items-center overflow-auto rounded-lg border border-line bg-surface-2 p-2">
              <p v-if="shownProblem !== null" class="text-sm text-warn" role="alert">{{ shownProblem }}</p>
              <p v-else-if="shown === null" class="text-sm text-muted">Leggo il mockup…</p>
              <div v-else class="h-full min-h-[460px] overflow-hidden rounded border border-line" :style="frameStyle">
                <StudioFrame
                  :key="shown.sha256"
                  :source="shown.text"
                  :title="`Mockup ${shown.path}`"
                  mode="studio"
                  :comment="pickMode !== 'none'"
                  :highlight="highlight"
                  @pick="onPick"
                />
              </div>
            </div>
            <div v-if="comparing" class="flex min-w-0 flex-1 flex-col items-center gap-2 overflow-auto rounded-lg border border-line bg-surface-2 p-2">
              <select v-model="otherPath" class="field self-stretch px-2 py-1 text-[12px]" aria-label="Variante a confronto">
                <option v-for="file in list.files" :key="file.path" :value="file.path">{{ file.name }}</option>
              </select>
              <p v-if="otherProblem !== null" class="text-sm text-warn" role="alert">{{ otherProblem }}</p>
              <div v-else-if="other !== null" class="h-full min-h-[420px] overflow-hidden rounded border border-line" :style="frameStyle">
                <StudioFrame :key="other.sha256" :source="other.text" :title="`Confronto ${other.path}`" />
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <StudioComments
              v-if="pickMode === 'comment' || comments.length > 0"
              :comments="comments"
              :pending="pending"
              :sending="sending"
              :blocked="chatBlocked"
              @add="addComment"
              @cancel="pending = null; highlight = null"
              @update="updateComment"
              @remove="removeComment"
              @focus="focusComment"
              @send="sendComments"
            />
            <div v-if="editing !== null && shown !== null" class="flex flex-col gap-1">
              <StudioEdit :source="shown.text" :selector="editing.selector" :tag="editing.tag" :saving="saving" @save="saveEdit" @close="editing = null; highlight = null" />
              <p v-if="editProblem !== null" class="text-xs text-warn" role="alert">{{ editProblem }}</p>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- The print (PDF): its own frame, out of sight, the only one with allow-modals. -->
    <iframe
      v-if="printDoc !== null"
      class="pointer-events-none fixed top-0 -left-[10000px] h-[800px] w-[1200px] border-0"
      sandbox="allow-scripts allow-modals"
      referrerpolicy="no-referrer"
      aria-hidden="true"
      tabindex="-1"
      title="Stampa del mockup"
      :srcdoc="printDoc"
    />
  </section>
</template>

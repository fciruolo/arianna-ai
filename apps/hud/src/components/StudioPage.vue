<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, deleteMockup, exportMockupPptx, listDesignStyles, listMockups, listSkills, listStyleSamples, readMockup, studioFrame, writeMockup } from '../lib/api.ts';
import type { StyleSummary } from '../lib/design-catalog.ts';
import type { SkillSummary } from '../lib/skills-catalog.ts';
import { buildSrcdoc, type FrameRect } from '../lib/studio-frame.ts';
import { deckFromDocument, editSource, hasSlides, parseMockup } from '../lib/studio-dom.ts';
import {
  afterDeletion,
  COMMENTS_MAX,
  exportName,
  groupMockups,
  keepKnown,
  NO_DESIGN,
  parseStudioDesign,
  pickMockup,
  reviewMessage,
  STUDIO_EDIT_CHANGED,
  STUDIO_SKILLS_MAX,
  studioDesignKey,
  studioErrorText,
  variantDesignText,
  variantLabel,
  VIEW_TEXT,
  VIEW_WIDTH,
  type Mockup,
  type MockupList,
  type MockupText,
  type StudioAddress,
  type StudioComment,
  type StudioDesign,
  type StudioEdit as EditRequest,
  type StudioView,
  type StyleSample,
} from '../lib/studio.ts';
import type { ProjectInfo } from '../lib/types.ts';
import type { IconName } from '../icons.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import Icon from './Icon.vue';
import StudioComments from './StudioComments.vue';
import StudioDesignDialog from './StudioDesignDialog.vue';
import DesignTextDialog from './DesignTextDialog.vue';
import StudioEdit from './StudioEdit.vue';
import StudioFloat from './StudioFloat.vue';
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
const emit = defineEmits<{
  address: [address: StudioAddress];
  /** The style and skills chosen for this project: the app sends them with every message to the Designer. */
  design: [design: StudioDesign];
  /** "Apri in Progetti" (I-20, D-185): the project with the folder of its mockups open in File. */
  projects: [project: string, folder: string];
}>();

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
const editing = ref<{ selector: string; tag: string; excerpt: string } | null>(null);
const saving = ref(false);
const editProblem = ref<string | null>(null);

const groups = computed(() => groupMockups(list.value?.files ?? []));
const current = computed<Mockup | undefined>(() => list.value?.files.find((file) => file.path === props.address.file));
const currentGroup = computed(() => groups.value.find((group) => group.group === current.value?.group));

function choose(file: string | undefined): void {
  emit('address', { ...(project.value === undefined ? {} : { project: project.value }), ...(file === undefined ? {} : { file }) });
}

function chooseProject(name: string): void {
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
  // Comments, a pending pick and an edit belong to the project they were made on.
  comments.value = [];
  pending.value = null;
  editing.value = null;
  editProblem.value = null;
  highlight.value = null;
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
/** "Schermo intero" (request of the user): the frames over the whole window, one or the two compared; Esc leaves. */
const fullscreen = ref(false);
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && fullscreen.value) fullscreen.value = false;
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});
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
/** "Scorri insieme" (choice of the user): off by default, one frame's scroll moves the other. */
const scrollTogether = ref(false);
const otherFrame = ref<InstanceType<typeof StudioFrame> | null>(null);
function followScroll(from: 'shown' | 'other', x: number, y: number): void {
  if (!comparing.value || !scrollTogether.value) return;
  (from === 'shown' ? otherFrame.value : shownFrame.value)?.scrollTo(x, y);
}

// Delete (D-184, choice of the user): the file moves to eliminati/, its number is never used again;
// the window explains it and, with its box (off by default), deletes for good instead (I-20, D-185).
const confirmingDelete = ref(false);
const deleting = ref(false);
const deletePermanent = ref(false);
const deleteProblem = ref<string | null>(null);
watch(
  () => props.address.file,
  () => {
    confirmingDelete.value = false;
  },
);
function askDelete(): void {
  deletePermanent.value = false;
  deleteProblem.value = null;
  confirmingDelete.value = true;
}
async function deleteShown(): Promise<void> {
  const name = project.value;
  const file = shown.value;
  if (name === undefined || file === null || deleting.value) return;
  deleting.value = true;
  deleteProblem.value = null;
  const permanent = deletePermanent.value;
  try {
    await deleteMockup(name, file.path, file.sha256, permanent);
    const next = afterDeletion(list.value?.files ?? [], file.path);
    confirmingDelete.value = false;
    const fileName = file.path.split('/').at(-1) ?? file.path;
    notice.value = permanent
      ? `${fileName} eliminato per sempre; il suo numero non verrà più usato.`
      : `${fileName} eliminato: è in ${list.value?.folder ?? 'mockups'}/eliminati/ del progetto (si ripristina da Progetti → File), il suo numero non verrà più usato.`;
    await loadList();
    // The variant compared was the one deleted: another one, not the one shown next.
    if (otherPath.value === file.path || otherPath.value === next) {
      const left = list.value?.files.filter((entry) => entry.path !== next) ?? [];
      otherPath.value = left.at(-1)?.path;
      if (otherPath.value === undefined) comparing.value = false;
    }
    choose(next);
  } catch (cause) {
    deleteProblem.value = studioErrorText(cause);
    if (cause instanceof ApiError && cause.status === 409) await loadFile(file.path, 'shown');
  } finally {
    deleting.value = false;
  }
}

function toggleCompare(): void {
  comparing.value = !comparing.value;
  if (comparing.value && otherPath.value === undefined) {
    const variants = currentGroup.value?.variants ?? [];
    otherPath.value = variants.filter((file) => file.path !== props.address.file).at(-1)?.path ?? list.value?.files.find((file) => file.path !== props.address.file)?.path;
  }
}

// Style and skills (O2): from the adopted catalogs (D-160, D-161), as on a Designer card (D-163),
// sent with every message of the Studio to the Designer (D-184); remembered per project in this browser.
const styleCatalog = ref<{ id: string; name: string }[]>([]);
const skillCatalog = ref<{ id: string; name: string; source: string }[]>([]);
/** For the window of style and skills (I-20, D-185): the whole entries and the small page of each style. */
const styleEntries = ref<StyleSummary[]>([]);
const skillEntries = ref<SkillSummary[]>([]);
const samples = ref<Record<string, StyleSample>>({});
const designOpen = ref(false);
const catalogsLoaded = ref(false);
const design = ref<StudioDesign>(NO_DESIGN);

function storedDesign(name: string): StudioDesign {
  try {
    return parseStudioDesign(window.localStorage.getItem(studioDesignKey(name)));
  } catch {
    return NO_DESIGN;
  }
}

function useDesign(next: StudioDesign, save: boolean): void {
  // A choice gone from the catalogs would be refused by the core: dropped once they are read.
  const kept = catalogsLoaded.value ? keepKnown(next, styleCatalog.value.map((style) => style.id), skillCatalog.value.map((skill) => skill.id)) : next;
  design.value = kept;
  // Before the catalogs are read nothing leaves: a choice gone from them would make the message fail.
  emit('design', catalogsLoaded.value ? kept : NO_DESIGN);
  const name = project.value;
  if (!save || name === undefined) return;
  try {
    window.localStorage.setItem(studioDesignKey(name), JSON.stringify(kept));
  } catch {
    // Private window or storage off: the choice lasts while the page is open.
  }
}

async function loadCatalogs(): Promise<void> {
  const [styles, skills, sampled] = await Promise.allSettled([listDesignStyles(), listSkills(), listStyleSamples()]);
  styleEntries.value = styles.status === 'fulfilled' ? styles.value.styles : [];
  skillEntries.value = skills.status === 'fulfilled' ? skills.value.skills : [];
  samples.value = sampled.status === 'fulfilled' ? sampled.value.samples : {};
  styleCatalog.value = styleEntries.value.map((style) => ({ id: style.slug, name: style.name }));
  skillCatalog.value = skillEntries.value.map((skill) => ({ id: skill.id, name: skill.name, source: skill.source }));
  catalogsLoaded.value = true;
  useDesign(design.value, false);
}

watch(project, (name) => {
  useDesign(name === undefined ? NO_DESIGN : storedDesign(name), false);
}, { immediate: true });
onMounted(() => void loadCatalogs());

const styleNameOf = (slug: string): string | undefined => styleCatalog.value.find((style) => style.id === slug)?.name;
const skillNameOf = (id: string): string | undefined => skillCatalog.value.find((skill) => skill.id === id)?.name;
const designSummary = computed(() => {
  const style = design.value.style === null ? 'nessuno' : (styleNameOf(design.value.style) ?? design.value.style);
  const count = design.value.skills.length;
  return `Stile: ${style} · ${count === 0 ? 'nessuna skill' : count === 1 ? '1 skill' : `${String(count)} skill`}`;
});
const shownSample = computed(() => (design.value.style === null ? undefined : samples.value[design.value.style]));

function applyDesign(next: StudioDesign): void {
  useDesign({ style: next.style, skills: next.skills.slice(0, STUDIO_SKILLS_MAX) }, true);
  designOpen.value = false;
}

/** What the variant shown, and the one compared, were made with (register next to the mockups, D-185). */
const otherFile = computed(() => list.value?.files.find((file) => file.path === otherPath.value));
/** The whole text of a style or a skill, from the line under the toolbar. */
const detail = ref<{ kind: 'style' | 'skill'; id: string; title: string } | null>(null);

let nextId = 1;
const sending = ref(false);

function setMode(mode: PickMode): void {
  pickMode.value = pickMode.value === mode ? 'none' : mode;
  if (pickMode.value !== 'comment') pending.value = null;
  if (pickMode.value === 'edit') comparing.value = false;
}

function onPick(pick: { selector: string; rect: FrameRect; tag: string; excerpt: string }): void {
  highlight.value = pick.selector;
  editProblem.value = null;
  if (pickMode.value === 'comment') pending.value = { selector: pick.selector, tag: pick.tag, excerpt: pick.excerpt };
  else if (pickMode.value === 'edit') editing.value = { selector: pick.selector, tag: pick.tag, excerpt: pick.excerpt };
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
    const sent = await props.send(reviewMessage(comments.value, list.value?.files ?? [], list.value?.highest ?? {}));
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
  const picked = editing.value;
  if (name === undefined || base === null || picked === null || saving.value) return;
  editProblem.value = null;
  const result = editSource(base.text, edit, picked.excerpt);
  if (!result.ok) {
    editProblem.value =
      result.reason === 'not-found'
        ? 'L’elemento non c’è più nel file.'
        : result.reason === 'changed'
          ? STUDIO_EDIT_CHANGED
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
/** The frame of the mockup shown: it measures how the slides look (PPTX). */
const shownFrame = ref<InstanceType<typeof StudioFrame> | null>(null);
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
  studioFrame(buildSrcdoc(file.text, 'print'), true).then(
    (url) => {
      printDoc.value = url;
      printTimer = window.setTimeout(clearPrint, 120_000);
    },
    () => {
      printDoc.value = null;
    },
  );
}

async function exportPptx(): Promise<void> {
  const name = project.value;
  const file = shown.value;
  if (name === undefined || file === null || exporting.value) return;
  exportProblem.value = null;
  exporting.value = true;
  try {
    // Colours, fonts and sizes as the screen shows them; the attributes alone without an answer.
    const looks = await shownFrame.value?.measureLooks();
    if (shown.value !== file) return;
    const deck = deckFromDocument(parseMockup(file.text), exportName(file.path, 'html').replace(/\.html$/, ''), looks);
    if (deck === undefined) {
      exportProblem.value = 'Questo mockup non ha diapositive (section[data-slide]).';
      return;
    }
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
      <template v-if="project !== undefined">
        <!-- Style and skills for the Designer (O2): every message of the Studio carries them; chosen in a window (I-20, D-185). -->
        <button
          type="button"
          class="btn inline-flex max-w-[320px] items-center gap-2 px-2.5 py-1 text-[12.5px]"
          title="Scegli lo stile di Open Design e le skill che il Designer legge con ogni messaggio dello Studio"
          :disabled="!catalogsLoaded"
          @click="designOpen = true"
        >
          <span v-if="shownSample" class="flex h-3.5 w-7 shrink-0 overflow-hidden rounded-sm" aria-hidden="true">
            <span class="flex-1" :style="{ backgroundColor: shownSample.hero }" /><span class="flex-1" :style="{ backgroundColor: shownSample.background }" /><span class="flex-1" :style="{ backgroundColor: shownSample.accent }" />
          </span>
          <Icon v-else name="studio" :size="13" />
          <span class="min-w-0 truncate">{{ designSummary }}</span>
        </button>
        <button type="button" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]" title="Il progetto in Progetti, con la cartella dei mockup aperta in File" @click="emit('projects', project, list?.folder ?? 'mockups')">
          <Icon name="project" :size="13" />Apri in Progetti
        </button>
      </template>
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
                :title="`${file.name} · ${new Date(file.modified).toLocaleString('it-IT')} · ${variantDesignText(file.design, styleNameOf, skillNameOf)}`"
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
            <template v-if="comparing">
              <select v-model="otherPath" class="field px-2 py-1 text-[12px]" aria-label="Variante a confronto">
                <option v-for="file in list.files" :key="file.path" :value="file.path">{{ file.name }}</option>
              </select>
              <label class="flex items-center gap-1.5 text-xs text-muted" title="Quando scorri una delle due pagine, l’altra la segue">
                <input v-model="scrollTogether" type="checkbox" class="accent-[var(--accent)]" />Scorri insieme
              </label>
            </template>
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
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="shown === null" title="La variante, o le due a confronto, su tutta la finestra (Esc per uscire)" @click="fullscreen = true">
              <Icon name="fullscreen" :size="13" />Schermo intero
            </button>
            <span class="ml-auto" />
            <button
              type="button"
              class="btn px-2.5 py-1 text-xs"
              :disabled="shown === null"
              title="Toglie questa variante: il file va nella cartella eliminati del progetto"
              @click="askDelete"
            ><Icon name="delete" :size="13" />Elimina</button>
            <button type="button" class="btn px-2.5 py-1 text-xs" title="Rileggi l’elenco dei mockup" @click="loadList(); loadFile(address.file, 'shown')"><Icon name="retry" :size="13" />Ricarica</button>
          </div>
          <p class="flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-muted">
            <template v-for="entry in comparing && otherFile !== undefined ? [current, otherFile] : [current]" :key="entry?.path">
              <span v-if="entry !== undefined">
                <b class="font-mono font-normal text-ink">{{ entry.name }}</b> ·
                <template v-if="entry.design === undefined">{{ variantDesignText(undefined, styleNameOf, skillNameOf) }}</template>
                <template v-else>
                  Fatta con
                  <template v-if="entry.design.style === null">nessuno stile</template>
                  <button v-else type="button" class="text-ink underline hover:text-accent" title="Leggi lo stile" @click="detail = { kind: 'style', id: entry.design.style, title: styleNameOf(entry.design.style) ?? entry.design.style }">
                    stile {{ styleNameOf(entry.design.style) ?? entry.design.style }}
                  </button>
                  ·
                  <template v-if="entry.design.skills.length === 0">nessuna skill</template>
                  <template v-else>
                    skill:
                    <template v-for="(skill, at) in entry.design.skills" :key="skill">
                      <button type="button" class="text-ink underline hover:text-accent" title="Leggi la skill" @click="detail = { kind: 'skill', id: skill, title: skillNameOf(skill) ?? skill }">{{ skillNameOf(skill) ?? skill }}</button><template v-if="at < entry.design.skills.length - 1">, </template>
                    </template>
                  </template>
                </template>
              </span>
            </template>
          </p>
          <p v-if="pickMode === 'comment'" class="text-[11.5px] text-muted">Fai clic su un elemento della pagina per commentarlo; i link e i pulsanti non scattano.</p>
          <p v-else-if="pickMode === 'edit'" class="text-[11.5px] text-muted">Fai clic su un elemento per cambiarne testo, colori e spaziature.</p>
          <p v-if="exportProblem !== null" class="text-xs text-warn" role="alert">{{ exportProblem }}</p>
          <p v-if="notice !== null" class="flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs" role="status">
            <Icon name="saved" :size="13" /><span class="flex-1">{{ notice }}</span>
            <button type="button" class="rounded p-0.5 hover:bg-surface-2" aria-label="Chiudi" @click="notice = null"><Icon name="close" :size="12" /></button>
          </p>

          <!-- The frames; on the whole window with "Schermo intero". -->
          <div class="flex min-h-[480px] flex-1 gap-2" :class="{ 'fixed inset-0 z-50 bg-[var(--bg)] p-3 pt-11': fullscreen }">
            <div v-if="fullscreen" class="fixed inset-x-3 top-2 z-50 flex items-center gap-2 text-xs text-muted">
              <span class="font-mono">{{ shown?.path.split('/').at(-1) }}<template v-if="comparing && other !== null"> · {{ other.path.split('/').at(-1) }}</template></span>
              <label v-if="comparing" class="flex items-center gap-1.5">
                <input v-model="scrollTogether" type="checkbox" class="accent-[var(--accent)]" />Scorri insieme
              </label>
              <button type="button" class="btn ml-auto px-2.5 py-1 text-xs" title="Esci dallo schermo intero (Esc)" @click="fullscreen = false">
                <Icon name="fullscreen-exit" :size="13" />Esci
              </button>
            </div>
            <div class="flex min-w-0 flex-1 flex-col items-center overflow-auto rounded-lg border border-line bg-surface-2 p-2">
              <p v-if="shownProblem !== null" class="text-sm text-warn" role="alert">{{ shownProblem }}</p>
              <p v-else-if="shown === null" class="text-sm text-muted">Leggo il mockup…</p>
              <div v-else class="h-full min-h-[460px] overflow-hidden rounded border border-line" :style="frameStyle">
                <StudioFrame
                  ref="shownFrame"
                  :key="shown.sha256"
                  :source="shown.text"
                  :title="`Mockup ${shown.path}`"
                  mode="studio"
                  :comment="pickMode !== 'none'"
                  :highlight="highlight"
                  @pick="onPick"
                  @scroll="(x: number, y: number) => followScroll('shown', x, y)"
                />
              </div>
            </div>
            <div v-if="comparing" class="flex min-w-0 flex-1 flex-col items-center gap-2 overflow-auto rounded-lg border border-line bg-surface-2 p-2">
              <p v-if="otherProblem !== null" class="text-sm text-warn" role="alert">{{ otherProblem }}</p>
              <div v-else-if="other !== null" class="h-full min-h-[420px] overflow-hidden rounded border border-line" :style="frameStyle">
                <StudioFrame
                  ref="otherFrame"
                  :key="other.sha256"
                  :source="other.text"
                  :title="`Confronto ${other.path}`"
                  mode="studio"
                  @scroll="(x: number, y: number) => followScroll('other', x, y)"
                />
              </div>
            </div>
            <!-- Comments and edit in a window the user moves (choice after the first trial). -->
            <StudioFloat
              v-if="pickMode === 'comment' || comments.length > 0 || (editing !== null && shown !== null)"
              :title="editing !== null ? 'Modifica diretta' : 'Commenti al Designer'"
            >
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
                <StudioEdit :source="shown.text" :selector="editing.selector" :tag="editing.tag" :excerpt="editing.excerpt" :saving="saving" @save="saveEdit" @close="editing = null; highlight = null" />
                <p v-if="editProblem !== null" class="text-xs text-warn" role="alert">{{ editProblem }}</p>
              </div>
            </StudioFloat>
          </div>
        </template>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirmingDelete && shown !== null && list !== null"
      :title="deletePermanent ? 'Eliminare per sempre la variante?' : 'Eliminare la variante?'"
      :confirm-text="deleting ? 'Elimino…' : deletePermanent ? 'Elimina per sempre' : 'Elimina'"
      :danger="deletePermanent"
      :busy="deleting"
      :problem="deleteProblem"
      @confirm="deleteShown"
      @cancel="confirmingDelete = false"
    >
      <p v-if="deletePermanent"><b class="font-mono">{{ shown.path.split('/').at(-1) }}</b> esce dallo Studio e dalle varianti e il file viene cancellato dal progetto.</p>
      <p v-else>
        <b class="font-mono">{{ shown.path.split('/').at(-1) }}</b> esce dallo Studio e dalle varianti. Il file non si cancella: va nella cartella
        <code class="font-mono">{{ list.folder }}/eliminati/</code> del progetto, da dove si rimette a posto in Progetti → File con «Ripristina».
      </p>
      <p class="text-xs text-muted">Il suo numero non verrà più usato: la prossima variante del Designer prende il numero seguente.</p>
      <label class="flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]" :class="deletePermanent ? 'border-danger/60 bg-danger/10' : 'border-line'">
        <input v-model="deletePermanent" type="checkbox" class="mt-0.5 accent-[var(--danger)]" />
        <span>
          Elimina definitivamente
          <span v-if="deletePermanent" class="block text-xs text-danger">Il file sparisce subito, senza passare da eliminati/: da Arianna non si recupera.</span>
        </span>
      </label>
    </ConfirmDialog>
    <DesignTextDialog v-if="detail !== null" :kind="detail.kind" :id="detail.id" :title="detail.title" @close="detail = null" />
    <StudioDesignDialog
      v-if="designOpen"
      :styles="styleEntries"
      :skills="skillEntries"
      :samples="samples"
      :design="design"
      @apply="applyDesign"
      @close="designOpen = false"
    />

    <!-- The print (PDF): its own frame, out of sight, the only one with allow-modals. -->
    <iframe
      v-if="printDoc !== null"
      class="pointer-events-none fixed top-0 -left-[10000px] h-[800px] w-[1200px] border-0"
      sandbox="allow-scripts allow-modals"
      referrerpolicy="no-referrer"
      aria-hidden="true"
      tabindex="-1"
      title="Stampa del mockup"
      :src="printDoc"
    />
  </section>
</template>

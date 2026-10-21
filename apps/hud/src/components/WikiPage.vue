<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import {
  ApiError,
  approveWikiProposal,
  createWikiFolder,
  createWikiPage,
  deleteWikiFolder,
  deleteWikiPage,
  discardWikiProposal,
  editWikiPage,
  loadWiki,
  loadWikiPage,
  loadWikiProposals,
  moveWikiNow,
  proposeWikiAgain,
  restoreWikiPage,
} from '../lib/api.ts';
import { diffRows } from '../lib/delegations.ts';
import {
  ancestorsOf,
  buildWikiTree,
  dropDestination,
  dropFolder,
  indexPath,
  isEmptyFolder,
  KIND_TEXT,
  movedPath,
  pathProblem,
  tidyPath,
  versionText,
  wikiErrorText,
  wikilinkTarget,
  type WikiDragged,
  type WikiListing,
  type WikiNode,
  type WikiPageView,
  type WikiProposal,
} from '../lib/wiki.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';
import PageHeader from './PageHeader.vue';

/**
 * The Wiki (D-280): pages of kb/wiki the local model proposes from the
 * user's notes. «Pagine» reads the tree (topic › sub-topic › article, each
 * folder with its index); «Proposte» shows each proposal as a diff, to
 * approve (a new page where the user says), discard or ask again. Nothing
 * changes without a click; the pages never leave the Mac.
 */

const emit = defineEmits<{
  /** A citation of a note: the note in Conoscenza. */
  'open-graph': [nodeId: string];
}>();

const tab = ref<'pages' | 'proposals'>('pages');
const listing = ref<WikiListing | null>(null);
const listError = ref<string | null>(null);
const open = ref<Set<string>>(new Set());
const shownPath = ref<string>('_indice');
const page = ref<WikiPageView | null>(null);
const pageError = ref<string | null>(null);
const pageLoading = ref(false);

const proposals = ref<WikiProposal[] | null>(null);
const proposalsError = ref<string | null>(null);
/** Per proposal: the path the user typed (new page: its place; move: its destination). */
const paths = ref<Record<string, string>>({});
/** Per proposal: why it did not go, or what happened. */
const notices = ref<Record<string, string>>({});
const busy = ref<string | null>(null);
const done = ref<string | null>(null);

const restoring = ref<string | null>(null);
const restoreProblem = ref<string | null>(null);
const restoreBusy = ref(false);

/** «Elimina» of the page shown: asked in a dialog, then the page, its versions and its proposals go. */
const deleting = ref(false);
const deleteProblem = ref<string | null>(null);
const deleteBusy = ref(false);
const notice = ref<string | null>(null);

const moveTo = ref('');
const moveNotice = ref<string | null>(null);
const moveBusy = ref(false);

/** «Modifica» (D-280): the user writes the page; saved at once, the version before kept. */
const editing = ref(false);
const editTitle = ref('');
const editBody = ref('');
const editBusy = ref(false);
const editProblem = ref<string | null>(null);

/** «Sposta o rinomina» of the page shown, at once. */
const movingPage = ref(false);
const pageMoveTo = ref('');
const pageMoveBusy = ref(false);
const pageMoveProblem = ref<string | null>(null);

/** «Nuova pagina» or «Nuova cartella» from the folder shown. */
const creating = ref<'page' | 'folder' | null>(null);
const createPath = ref('');
const createTitle = ref('');
const createBusy = ref(false);
const createProblem = ref<string | null>(null);

/** «Elimina cartella» of the empty folder shown, asked in a dialog. */
const deletingFolder = ref(false);
const folderDeleteBusy = ref(false);
const folderDeleteProblem = ref<string | null>(null);
const shownFolderEmpty = computed(() => listing.value !== null && shownFolder.value !== null && isEmptyFolder(shownFolder.value, listing.value.folders, listing.value.pages));

/** Dragging a page or folder in the tree: where it is over, and what went wrong. */
const dragging = ref<WikiDragged | null>(null);
const dropOver = ref<string | null>(null);
const treeNotice = ref<string | null>(null);

const tree = computed(() => (listing.value === null ? [] : buildWikiTree(listing.value.folders, listing.value.pages)));
const proposalCount = computed(() => proposals.value?.length ?? listing.value?.proposals ?? 0);
/** The folder whose index is shown, or null for a page. */
const shownFolder = computed(() => (shownPath.value === '_indice' ? '' : shownPath.value.endsWith('/_indice') ? shownPath.value.slice(0, -'/_indice'.length) : null));
const moveProblem = computed(() => (moveTo.value.trim() === '' ? undefined : pathProblem(tidyPath(moveTo.value), 'folder')));
const pageMovePathProblem = computed(() => (pageMoveTo.value.trim() === '' ? undefined : pathProblem(tidyPath(pageMoveTo.value), 'page')));
const createPathProblem = computed(() => (createPath.value.trim() === '' || creating.value === null ? undefined : pathProblem(tidyPath(createPath.value), creating.value)));

interface Row {
  node: WikiNode;
  depth: number;
}

/** The tree as rows: a folder's children only while it is open. */
const rows = computed(() => {
  const out: Row[] = [];
  const walk = (nodes: readonly WikiNode[], depth: number): void => {
    for (const node of nodes) {
      out.push({ node, depth });
      if (node.kind === 'folder' && open.value.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(tree.value, 0);
  return out;
});

function problemOf(failure: unknown): string {
  return failure instanceof ApiError ? wikiErrorText(failure.status, failure.message) : 'Non riesco a parlare con Arianna: riprova.';
}

async function loadListing(): Promise<void> {
  listError.value = null;
  try {
    listing.value = await loadWiki();
  } catch (failure) {
    listError.value = problemOf(failure);
  }
}

let pageRequest = 0;
async function show(path: string): Promise<void> {
  shownPath.value = path;
  notice.value = null;
  moveTo.value = '';
  moveNotice.value = null;
  editing.value = false;
  movingPage.value = false;
  creating.value = null;
  const folder = path === '_indice' ? '' : path.endsWith('/_indice') ? path.slice(0, -'/_indice'.length) : null;
  const next = new Set(open.value);
  for (const ancestor of folder === null ? ancestorsOf(path) : [...ancestorsOf(`${folder}/x`)]) if (ancestor !== '') next.add(ancestor);
  open.value = next;
  const request = ++pageRequest;
  pageLoading.value = true;
  pageError.value = null;
  try {
    const loaded = await loadWikiPage(path);
    if (request === pageRequest) page.value = loaded;
  } catch (failure) {
    if (request !== pageRequest) return;
    page.value = null;
    const emptyFolder = folder !== null && folder !== '' && (listing.value?.folders.includes(folder) ?? false);
    pageError.value =
      failure instanceof ApiError && failure.status === 404
        ? folder === ''
          ? 'La Wiki è ancora vuota: le pagine arrivano dalle proposte del modello locale, o le scrivi tu con «Nuova pagina».'
          : emptyFolder
            ? 'Cartella ancora vuota: crea qui una pagina o trascinane una dall’albero.'
            : 'Questa pagina non c’è più.'
        : problemOf(failure);
  } finally {
    if (request === pageRequest) pageLoading.value = false;
  }
}

function toggle(path: string): void {
  const next = new Set(open.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  open.value = next;
}

function choose(node: WikiNode): void {
  if (node.kind === 'folder') {
    if (!open.value.has(node.path)) toggle(node.path);
    void show(indexPath(node.path));
  } else void show(node.path);
}

/** A wikilink of the page: another page of the Wiki here, a note in Conoscenza. */
function follow(target: string): void {
  const where = wikilinkTarget(target);
  if ('wiki' in where) void show(where.wiki);
  else emit('open-graph', where.note);
}

async function loadProposals(): Promise<void> {
  proposalsError.value = null;
  try {
    proposals.value = await loadWikiProposals();
  } catch (failure) {
    proposalsError.value = problemOf(failure);
  }
}

function pathFor(proposal: WikiProposal): string {
  return paths.value[proposal.id] ?? (proposal.kind === 'move' ? (proposal.to ?? '') : proposal.path);
}

function proposalProblem(proposal: WikiProposal): string | undefined {
  if (proposal.kind === 'update') return undefined;
  return pathProblem(tidyPath(pathFor(proposal)), proposal.kind === 'move' ? 'folder' : 'page');
}

async function approve(proposal: WikiProposal): Promise<void> {
  if (busy.value !== null || proposalProblem(proposal) !== undefined) return;
  busy.value = proposal.id;
  done.value = null;
  const typed = tidyPath(pathFor(proposal));
  const original = proposal.kind === 'move' ? (proposal.to ?? '') : proposal.path;
  try {
    const result = await approveWikiProposal(proposal.id, proposal.kind === 'update' || typed === original ? undefined : typed);
    done.value = proposal.kind === 'move' ? `Cartella spostata in wiki/${result.path}.` : `Pagina scritta: wiki/${result.path}.`;
    await Promise.all([loadProposals(), loadListing()]);
    if (proposal.kind !== 'move' && shownPath.value === result.path) await show(result.path);
  } catch (failure) {
    notices.value = { ...notices.value, [proposal.id]: problemOf(failure) };
    await loadProposals();
  } finally {
    busy.value = null;
  }
}

async function discard(proposal: WikiProposal): Promise<void> {
  if (busy.value !== null) return;
  busy.value = proposal.id;
  done.value = null;
  try {
    await discardWikiProposal(proposal.id);
    await Promise.all([loadProposals(), loadListing()]);
  } catch (failure) {
    notices.value = { ...notices.value, [proposal.id]: problemOf(failure) };
  } finally {
    busy.value = null;
  }
}

async function again(proposal: WikiProposal): Promise<void> {
  if (busy.value !== null) return;
  busy.value = proposal.id;
  try {
    await proposeWikiAgain(proposal.id);
    notices.value = { ...notices.value, [proposal.id]: 'Il modello locale ci ripensa: la proposta nuova sostituirà questa fra poco.' };
  } catch (failure) {
    notices.value = { ...notices.value, [proposal.id]: problemOf(failure) };
  } finally {
    busy.value = null;
  }
}

async function confirmRestore(): Promise<void> {
  if (page.value === null || restoring.value === null) return;
  restoreBusy.value = true;
  restoreProblem.value = null;
  try {
    await restoreWikiPage(page.value.path, restoring.value, page.value.version);
    restoring.value = null;
    await show(page.value.path);
    await loadListing();
  } catch (failure) {
    restoreProblem.value = problemOf(failure);
  } finally {
    restoreBusy.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  if (page.value === null || page.value.kind !== 'page') return;
  const { path, title, version } = page.value;
  deleteBusy.value = true;
  deleteProblem.value = null;
  try {
    await deleteWikiPage(path, version);
    deleting.value = false;
    await Promise.all([loadListing(), loadProposals()]);
    await show('_indice');
    notice.value = `Pagina «${title}» eliminata, con le sue versioni.`;
  } catch (failure) {
    deleteProblem.value = problemOf(failure);
  } finally {
    deleteBusy.value = false;
  }
}

/** After a move: the tree, the proposals and the page shown at its new place. */
async function afterMove(from: string, to: string, what: string): Promise<void> {
  await Promise.all([loadListing(), loadProposals()]);
  await show(movedPath(shownPath.value, from, to));
  notice.value = `${what} spostata in wiki/${to}.`;
}

/** «Sposta o rinomina» of the folder shown, at once (D-280): its pages, versions and links follow. */
async function moveFolder(): Promise<void> {
  const from = shownFolder.value;
  const to = tidyPath(moveTo.value);
  if (from === null || from === '' || moveBusy.value || pathProblem(to, 'folder') !== undefined) return;
  moveBusy.value = true;
  moveNotice.value = null;
  try {
    const now = await moveWikiNow('folder', from, to);
    await afterMove(from, now, 'Cartella');
  } catch (failure) {
    moveNotice.value = problemOf(failure);
  } finally {
    moveBusy.value = false;
  }
}

/** «Sposta o rinomina» of the page shown, at once: over the page as shown. */
async function movePage(): Promise<void> {
  if (page.value === null || page.value.kind !== 'page' || pageMoveBusy.value) return;
  const to = tidyPath(pageMoveTo.value);
  if (pathProblem(to, 'page') !== undefined) return;
  const { path, version } = page.value;
  pageMoveBusy.value = true;
  pageMoveProblem.value = null;
  try {
    const now = await moveWikiNow('page', path, to, version);
    await afterMove(path, now, 'Pagina');
  } catch (failure) {
    pageMoveProblem.value = problemOf(failure);
  } finally {
    pageMoveBusy.value = false;
  }
}

async function confirmFolderDelete(): Promise<void> {
  const folder = shownFolder.value;
  if (folder === null || folder === '') return;
  folderDeleteBusy.value = true;
  folderDeleteProblem.value = null;
  try {
    await deleteWikiFolder(folder);
    deletingFolder.value = false;
    await loadListing();
    await show(indexPath(folder.split('/').slice(0, -1).join('/')));
    notice.value = `Cartella wiki/${folder} eliminata.`;
  } catch (failure) {
    folderDeleteProblem.value = problemOf(failure);
  } finally {
    folderDeleteBusy.value = false;
  }
}

function startEdit(): void {
  if (page.value === null || page.value.kind !== 'page') return;
  editTitle.value = page.value.title;
  editBody.value = page.value.body;
  editProblem.value = null;
  movingPage.value = false;
  editing.value = true;
}

/** «Salva»: the page as written, over the page as shown; the version before goes to «Versioni precedenti». */
async function saveEdit(): Promise<void> {
  if (page.value === null || page.value.kind !== 'page' || editBusy.value) return;
  const { path, version } = page.value;
  editBusy.value = true;
  editProblem.value = null;
  try {
    await editWikiPage(path, version, editTitle.value, editBody.value);
    await Promise.all([show(path), loadListing(), loadProposals()]);
    notice.value = 'Pagina salvata. La versione di prima è fra le precedenti.';
  } catch (failure) {
    editProblem.value = problemOf(failure);
  } finally {
    editBusy.value = false;
  }
}

function startCreate(kind: 'page' | 'folder'): void {
  const folder = shownFolder.value ?? '';
  creating.value = kind;
  createPath.value = folder === '' ? '' : `${folder}/`;
  createTitle.value = '';
  createProblem.value = null;
}

/** «Crea»: a folder stays empty until a page goes in it; a page opens in «Modifica». */
async function create(): Promise<void> {
  const kind = creating.value;
  const path = tidyPath(createPath.value);
  if (kind === null || createBusy.value || pathProblem(path, kind) !== undefined || (kind === 'page' && createTitle.value.trim() === '')) return;
  createBusy.value = true;
  createProblem.value = null;
  try {
    if (kind === 'folder') {
      await createWikiFolder(path);
      await loadListing();
      await show(indexPath(path));
      notice.value = `Cartella wiki/${path} creata.`;
    } else {
      const made = await createWikiPage(path, createTitle.value);
      await loadListing();
      await show(made.path);
      startEdit();
    }
  } catch (failure) {
    createProblem.value = problemOf(failure);
  } finally {
    createBusy.value = false;
  }
}

function dragStart(event: DragEvent, node: WikiNode): void {
  dragging.value = { kind: node.kind, path: node.path };
  treeNotice.value = null;
  event.dataTransfer?.setData('text/plain', `wiki/${node.path}`);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
}

function dragEnd(): void {
  dragging.value = null;
  dropOver.value = null;
}

function dragOver(event: DragEvent, folder: string): void {
  if (dragging.value === null) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  dropOver.value = folder;
}

/** A page or folder dropped on a folder (or on a page: its folder): moved at once, as with «Sposta o rinomina». */
async function dropOn(folder: string): Promise<void> {
  const item = dragging.value;
  dragEnd();
  if (item === null) return;
  const where = dropDestination(item, folder);
  if (where === null) return;
  if ('problem' in where) {
    treeNotice.value = where.problem;
    return;
  }
  try {
    const base = item.kind === 'page' ? (await loadWikiPage(item.path)).version : undefined;
    const now = await moveWikiNow(item.kind, item.path, where.to, base);
    await afterMove(item.path, now, item.kind === 'page' ? 'Pagina' : 'Cartella');
  } catch (failure) {
    treeNotice.value = problemOf(failure);
  }
}

function openTab(next: 'pages' | 'proposals'): void {
  tab.value = next;
  if (next === 'proposals') void loadProposals();
  else void loadListing();
}

const rowClass = { added: 'bg-ok/10', removed: 'bg-danger/10', context: '', gap: 'text-muted' } as const;
const signOf = { added: '+', removed: '−', context: ' ', gap: '⋯' } as const;

onMounted(() => {
  void loadListing();
  void loadProposals();
  void show('_indice');
});
</script>

<template>
  <div class="flex min-h-0 flex-1 overflow-hidden">
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1180px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
        <PageHeader title="Wiki" title-id="wiki-title">
          Pagine che il modello locale propone dalle tue note e dai video riassunti: cambiano solo quando le approvi. Restano sul Mac, sempre Private.
        </PageHeader>

        <div class="flex gap-1 border-b border-line" role="tablist" aria-label="Viste della Wiki">
          <button
            id="wiki-tab-pages"
            type="button"
            role="tab"
            class="-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[14px] whitespace-nowrap"
            :class="tab === 'pages' ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'"
            :aria-selected="tab === 'pages'"
            aria-controls="wiki-panel-pages"
            @click="openTab('pages')"
          >
            <Icon name="wiki" :size="14" />Pagine
          </button>
          <button
            id="wiki-tab-proposals"
            type="button"
            role="tab"
            class="-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[14px] whitespace-nowrap"
            :class="tab === 'proposals' ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'"
            :aria-selected="tab === 'proposals'"
            aria-controls="wiki-panel-proposals"
            @click="openTab('proposals')"
          >
            Proposte ({{ proposalCount }})
          </button>
        </div>

        <!-- Pages: the tree and the page read -->
        <div v-if="tab === 'pages'" id="wiki-panel-pages" role="tabpanel" aria-labelledby="wiki-tab-pages" class="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
          <nav class="flex flex-col gap-0.5 rounded-xl border border-line bg-surface-2 p-2 text-[14px]" aria-label="Albero della Wiki">
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md px-2 py-1 text-left font-semibold hover:bg-surface"
              :class="[shownPath === '_indice' ? 'text-accent' : '', dropOver === '' ? 'bg-accent/15' : '']"
              @click="show('_indice')"
              @dragover="dragOver($event, '')"
              @dragleave="dropOver = null"
              @drop.prevent="dropOn('')"
            >
              <Icon name="wiki" :size="14" />Wiki
            </button>
            <p v-if="treeNotice !== null" class="px-2 py-1 text-xs text-danger" role="alert">{{ treeNotice }}</p>
            <p v-if="listError !== null" class="px-2 py-1 text-xs text-danger" role="alert">{{ listError }}</p>
            <p v-else-if="listing !== null && rows.length === 0" class="px-2 py-1 text-[13px] text-muted">Nessuna pagina ancora.</p>
            <p v-if="rows.length > 0" class="mt-1 px-2 text-[12px] text-muted">Trascina pagine e cartelle per spostarle.</p>
            <div
              v-for="row in rows"
              :key="`${row.node.kind}:${row.node.path}`"
              class="flex items-center rounded-md"
              :class="dropOver !== null && dropOver === dropFolder(row.node) && dragging !== null ? 'bg-accent/15' : ''"
              :style="{ paddingLeft: `${String(row.depth * 14)}px` }"
              draggable="true"
              :title="`Trascina per spostare wiki/${row.node.path}`"
              @dragstart="dragStart($event, row.node)"
              @dragend="dragEnd"
              @dragover="dragOver($event, dropFolder(row.node))"
              @drop.prevent="dropOn(dropFolder(row.node))"
            >
              <button
                v-if="row.node.kind === 'folder'"
                type="button"
                class="rounded p-0.5 text-muted hover:text-ink"
                :aria-label="open.has(row.node.path) ? `Chiudi ${row.node.name}` : `Apri ${row.node.name}`"
                :aria-expanded="open.has(row.node.path)"
                @click="toggle(row.node.path)"
              >
                <Icon :name="open.has(row.node.path) ? 'sort-down' : 'expand'" :size="13" />
              </button>
              <span v-else class="inline-block w-[18px]" />
              <button
                type="button"
                class="min-w-0 flex-1 truncate rounded-md px-1.5 py-0.5 text-left hover:bg-surface"
                :class="[row.node.kind === 'folder' ? 'font-medium' : '', (row.node.kind === 'folder' ? `${row.node.path}/_indice` : row.node.path) === shownPath ? 'text-accent' : '']"
                :title="`wiki/${row.node.path}`"
                @click="choose(row.node)"
              >
                {{ row.node.name }}
              </button>
            </div>
          </nav>

          <article class="min-w-0 rounded-xl border border-line bg-surface p-4">
            <p v-if="notice !== null" class="mb-3 rounded-lg border border-ok/50 bg-ok/10 px-3 py-2 text-sm" role="status">{{ notice }}</p>
            <p v-if="pageLoading && page === null" class="text-sm text-muted">Leggo la pagina…</p>
            <p v-else-if="pageError !== null" class="text-sm text-muted">{{ pageError }}</p>
            <template v-else-if="page !== null">
              <div class="flex flex-wrap items-center gap-2">
                <p class="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">wiki/{{ page.path }}</p>
                <template v-if="page.kind === 'page' && !editing">
                  <button type="button" class="btn px-2 py-0.5 text-[12.5px]" @click="startEdit"><Icon name="rename" :size="12" />Modifica</button>
                  <button type="button" class="btn px-2 py-0.5 text-[12.5px]" @click="movingPage = !movingPage; pageMoveTo = page.path; pageMoveProblem = null">Sposta o rinomina</button>
                  <button type="button" class="btn px-2 py-0.5 text-[12.5px] hover:text-danger" @click="deleting = true; deleteProblem = null">
                    <Icon name="delete" :size="12" />Elimina
                  </button>
                </template>
              </div>

              <form v-if="editing" class="mt-2 flex flex-col gap-2" @submit.prevent="saveEdit">
                <input
                  v-model="editTitle"
                  type="text"
                  maxlength="80"
                  class="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[17px] font-semibold outline-none"
                  aria-label="Titolo della pagina"
                />
                <textarea
                  v-model="editBody"
                  rows="20"
                  class="min-h-[320px] resize-y rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[13.5px] leading-relaxed outline-none"
                  aria-label="Testo della pagina in Markdown"
                  spellcheck="true"
                />
                <p class="text-[12.5px] text-muted">
                  Markdown: titoli con ##, elenchi con -, grassetto con **. Per citare una nota o un’altra pagina scrivi il suo percorso fra doppie parentesi quadre (come nelle pagine proposte). Niente link, immagini o indirizzi: la pagina resta sul Mac.
                </p>
                <p v-if="editProblem !== null" class="text-[13px] text-danger" role="alert">{{ editProblem }}</p>
                <div class="flex gap-2">
                  <button type="submit" class="btn btn-primary px-3 py-1 text-[13.5px]" :disabled="editBusy || editTitle.trim() === ''">Salva</button>
                  <button type="button" class="btn px-3 py-1 text-[13.5px]" :disabled="editBusy" @click="editing = false">Annulla</button>
                </div>
              </form>
              <template v-else>
                <h2 class="mt-1 text-[19px] font-semibold">{{ page.title }}</h2>
                <MarkdownText class="mt-3" :source="page.body" :wikilink="follow" />
              </template>

              <section v-if="page.kind === 'page' && movingPage && !editing" class="mt-5 border-t border-line pt-3">
                <h3 class="text-[14px] font-semibold">Sposta o rinomina la pagina</h3>
                <p class="mt-0.5 text-[13px] text-muted">Subito: versioni e collegamenti seguono; un aggiornamento proposto per questa pagina scade.</p>
                <form class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="movePage">
                  <input
                    v-model="pageMoveTo"
                    type="text"
                    class="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1 font-mono text-[13.5px] outline-none"
                    aria-label="Nuovo percorso della pagina"
                  />
                  <button type="submit" class="btn px-2.5 py-1 text-[13px]" :disabled="pageMoveBusy || pageMoveTo.trim() === '' || pageMovePathProblem !== undefined">Sposta</button>
                </form>
                <p v-if="pageMovePathProblem !== undefined" class="mt-1 text-xs text-danger">{{ pageMovePathProblem }}</p>
                <p v-if="pageMoveProblem !== null" class="mt-1 text-[13px] text-danger" role="alert">{{ pageMoveProblem }}</p>
              </section>

              <section v-if="page.kind === 'page' && !editing && page.versions.length > 0" class="mt-5 border-t border-line pt-3">
                <h3 class="flex items-center gap-1.5 text-[14px] font-semibold"><Icon name="history" :size="14" />Versioni precedenti</h3>
                <ul class="mt-1.5 flex flex-col gap-1 text-[13.5px]">
                  <li v-for="version in page.versions" :key="version.id" class="flex items-center gap-2">
                    <span class="font-mono text-[12.5px] text-muted">{{ versionText(version.at) }}</span>
                    <button type="button" class="btn px-2 py-0.5 text-[12.5px]" @click="restoring = version.id; restoreProblem = null"><Icon name="retry" :size="12" />Ripristina</button>
                  </li>
                </ul>
              </section>
            </template>

            <!-- The folder shown (or the root): new pages and folders, and «Sposta o rinomina» of the folder -->
            <section v-if="shownFolder !== null && !pageLoading" class="mt-5 border-t border-line pt-3">
              <div class="flex flex-wrap gap-2">
                <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="startCreate('page')"><Icon name="new" :size="13" />Nuova pagina</button>
                <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="startCreate('folder')"><Icon name="new" :size="13" />Nuova cartella</button>
                <button v-if="shownFolderEmpty" type="button" class="btn px-2.5 py-1 text-[13px] hover:text-danger" @click="deletingFolder = true; folderDeleteProblem = null">
                  <Icon name="delete" :size="13" />Elimina cartella
                </button>
              </div>
              <form v-if="creating !== null" class="mt-2 flex flex-col gap-2" @submit.prevent="create">
                <input
                  v-model="createPath"
                  type="text"
                  class="rounded-md border border-line bg-surface-2 px-2.5 py-1 font-mono text-[13.5px] outline-none"
                  :placeholder="creating === 'page' ? 'argomento/articolo' : 'argomento o argomento/sotto-argomento'"
                  :aria-label="creating === 'page' ? 'Percorso della pagina nuova' : 'Percorso della cartella nuova'"
                />
                <input
                  v-if="creating === 'page'"
                  v-model="createTitle"
                  type="text"
                  maxlength="80"
                  class="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[13.5px] outline-none"
                  placeholder="Titolo"
                  aria-label="Titolo della pagina nuova"
                />
                <p v-if="createPathProblem !== undefined" class="text-xs text-danger">{{ createPathProblem }}</p>
                <p v-if="createProblem !== null" class="text-[13px] text-danger" role="alert">{{ createProblem }}</p>
                <div class="flex gap-2">
                  <button
                    type="submit"
                    class="btn btn-primary px-3 py-1 text-[13px]"
                    :disabled="createBusy || createPath.trim() === '' || createPathProblem !== undefined || (creating === 'page' && createTitle.trim() === '')"
                  >
                    Crea
                  </button>
                  <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="createBusy" @click="creating = null">Annulla</button>
                </div>
              </form>

              <template v-if="shownFolder !== ''">
                <h3 class="mt-4 text-[14px] font-semibold">Sposta o rinomina la cartella</h3>
                <p class="mt-0.5 text-[13px] text-muted">Subito, con le sue pagine: versioni e collegamenti seguono. Puoi anche trascinarla nell’albero.</p>
                <form class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="moveFolder">
                  <input
                    v-model="moveTo"
                    type="text"
                    class="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1 font-mono text-[13.5px] outline-none"
                    :placeholder="shownFolder"
                    aria-label="Nuovo percorso della cartella"
                  />
                  <button type="submit" class="btn px-2.5 py-1 text-[13px]" :disabled="moveBusy || moveTo.trim() === '' || moveProblem !== undefined">Sposta</button>
                </form>
                <p v-if="moveProblem !== undefined" class="mt-1 text-xs text-danger">{{ moveProblem }}</p>
                <p v-if="moveNotice !== null" class="mt-1 text-[13px] text-danger" role="alert">{{ moveNotice }}</p>
              </template>
            </section>
          </article>
        </div>

        <!-- Proposals -->
        <div v-else id="wiki-panel-proposals" role="tabpanel" aria-labelledby="wiki-tab-proposals" class="flex flex-col gap-3">
          <p v-if="done !== null" class="rounded-lg border border-ok/50 bg-ok/10 px-3 py-2 text-sm" role="status">{{ done }}</p>
          <p v-if="proposalsError !== null" class="text-sm text-danger" role="alert">{{ proposalsError }}</p>
          <p v-else-if="proposals === null" class="text-sm text-muted">Carico le proposte…</p>
          <p v-else-if="proposals.length === 0" class="rounded-xl border border-line bg-surface-2 p-4 text-[14.5px] text-muted">
            Nessuna proposta in attesa. Arrivano da sole dopo ogni video riassunto e ogni nota archiviata, o con «Proponi per la Wiki» nel pannello di una nota.
          </p>
          <article v-for="proposal in proposals ?? []" :key="proposal.id" class="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5">
            <header class="flex flex-wrap items-center gap-2">
              <span class="rounded-full border border-line-strong px-2 py-0.5 text-[12px] text-muted">{{ KIND_TEXT[proposal.kind] }}</span>
              <h3 class="min-w-0 flex-1 truncate text-[15px] font-semibold">{{ proposal.title }}</h3>
              <span class="font-mono text-[12px] text-muted">{{ proposal.createdAt.slice(0, 16).replace('T', ' ') }}</span>
            </header>
            <p v-if="proposal.state === 'expired'" class="flex items-center gap-1.5 text-[13.5px] text-warn"><Icon name="warning" :size="14" />La pagina è cambiata dopo la proposta.</p>
            <label v-if="proposal.kind !== 'update'" class="flex flex-wrap items-center gap-2 text-[13.5px]">
              <span class="text-muted">{{ proposal.kind === 'move' ? `wiki/${proposal.path} →` : 'Percorso' }}</span>
              <input
                :value="pathFor(proposal)"
                type="text"
                class="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1 font-mono text-[13.5px] outline-none"
                :aria-label="proposal.kind === 'move' ? 'Dove va la cartella' : 'Percorso della pagina nuova'"
                :disabled="proposal.state === 'expired'"
                @input="paths = { ...paths, [proposal.id]: ($event.target as HTMLInputElement).value }"
              />
            </label>
            <p v-else class="font-mono text-[13px] text-muted">wiki/{{ proposal.path }}</p>
            <p v-if="proposalProblem(proposal) !== undefined" class="text-xs text-danger">{{ proposalProblem(proposal) }}</p>
            <p v-if="proposal.source !== null" class="text-[13.5px]">
              <span class="text-muted">Da</span>
              <button type="button" class="ml-1 hover:text-accent hover:underline" @click="emit('open-graph', proposal.source.id)">{{ proposal.source.title }}</button>
            </p>
            <p v-if="proposal.reason !== ''" class="text-[13.5px] text-muted">{{ proposal.reason }}</p>
            <p class="text-[12.5px] text-muted">+{{ proposal.diff.added }} −{{ proposal.diff.removed }}</p>
            <div class="max-h-[420px] overflow-auto rounded-lg border border-line font-mono text-[12.5px]">
              <table class="w-full border-collapse">
                <tbody>
                  <tr v-for="(row, at) in diffRows(proposal.diff.hunks)" :key="at" :class="rowClass[row.kind]">
                    <td class="w-px px-1 select-none" :class="row.kind === 'added' ? 'text-ok' : row.kind === 'removed' ? 'text-danger' : 'text-muted'" aria-hidden="true">{{ signOf[row.kind] }}</td>
                    <td class="pr-3 whitespace-pre-wrap break-words">
                      <span v-if="row.kind === 'added'" class="sr-only">aggiunta: </span><span v-else-if="row.kind === 'removed'" class="sr-only">tolta: </span>{{ row.text }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="notices[proposal.id]" class="text-[13px]" role="status">{{ notices[proposal.id] }}</p>
            <footer class="flex flex-wrap gap-2">
              <button
                v-if="proposal.state === 'fresh'"
                type="button"
                class="btn btn-primary px-3 py-1 text-[13.5px]"
                :disabled="busy !== null || proposalProblem(proposal) !== undefined"
                @click="approve(proposal)"
              >
                <Icon name="approve" :size="14" />Approva
              </button>
              <button type="button" class="btn px-3 py-1 text-[13.5px]" :disabled="busy !== null" @click="discard(proposal)">Scarta</button>
              <button v-if="proposal.kind !== 'move'" type="button" class="btn px-3 py-1 text-[13.5px]" :disabled="busy !== null" @click="again(proposal)">
                <Icon name="retry" :size="14" />Proponi di nuovo
              </button>
            </footer>
          </article>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="deletingFolder && shownFolder !== null && shownFolder !== ''"
      title="Elimina la cartella"
      confirm-text="Elimina"
      danger
      :busy="folderDeleteBusy"
      :problem="folderDeleteProblem"
      @confirm="confirmFolderDelete"
      @cancel="deletingFolder = false"
    >
      <p>La cartella vuota wiki/{{ shownFolder }} va via. Le altre cartelle e le pagine restano come sono.</p>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="deleting && page !== null && page.kind === 'page'"
      title="Elimina la pagina"
      confirm-text="Elimina"
      danger
      :busy="deleteBusy"
      :problem="deleteProblem"
      @confirm="confirmDelete"
      @cancel="deleting = false"
    >
      <p>
        La pagina «{{ page.title }}» va via per sempre dal Mac{{ page.versions.length === 0 ? '' : page.versions.length === 1 ? ', con la sua versione precedente,' : `, con le sue ${String(page.versions.length)} versioni precedenti,` }} insieme alle proposte in attesa su di lei. Le note che cita restano. Gli indici delle cartelle si aggiornano; una cartella rimasta senza pagine sparisce.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="restoring !== null && page !== null"
      title="Ripristina la versione"
      confirm-text="Ripristina"
      :busy="restoreBusy"
      :problem="restoreProblem"
      @confirm="confirmRestore"
      @cancel="restoring = null"
    >
      <p>La pagina «{{ page.title }}» torna com’era il {{ versionText(page.versions.find((version) => version.id === restoring)?.at ?? '') }}. La versione di adesso resta fra le precedenti.</p>
    </ConfirmDialog>
  </div>
</template>

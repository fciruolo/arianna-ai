<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  ApiError,
  approveWikiProposal,
  compareWikiVersion,
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
import { coarsePointer, wikiEmptyText } from '../lib/touch-hints.ts';
import {
  ancestorsOf,
  breadcrumb,
  buildWikiTree,
  citationOf,
  clampTreeWidth,
  copyPath,
  copyTitle,
  dropDestination,
  dropFolder,
  folderName,
  folderOf,
  indexPath,
  isEmptyFolder,
  KIND_TEXT,
  movedPath,
  moveChoices,
  newItemPath,
  pathProblem,
  renamedFolder,
  SAVE_DELAY_MS,
  SAVE_TEXT,
  sessionToken,
  tidyPath,
  TREE_WIDTH,
  treeMenu,
  versionErrorText,
  versionText,
  wikiDiffRows,
  wikiErrorText,
  wikilinkTarget,
  type SaveState,
  type VersionComparison,
  type WikiDragged,
  type WikiListing,
  type WikiMenuItem,
  type WikiNode,
  type WikiPageView,
  type WikiProposal,
} from '../lib/wiki.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';
import WikiMenu from './WikiMenu.vue';

/** The editor (D-282) loads with the first page opened: the rest of the chat does not carry it. */
const WikiEditor = defineAsyncComponent(() => import('./WikiEditor.vue'));

/**
 * The Wiki as Notion (D-280, D-284): the tree on the side (resizable, can be
 * closed; a panel on the phone), the path on top, the page in the middle at
 * reading width. A page is always written: the title on top and the text in
 * the editor save by themselves 1.5 s after the last change, over the page
 * as it was shown; the core keeps one version per writing session. The
 * indexes are composed by the code and only read. The right click (or «…»,
 * Maiusc+F10) on the tree opens our menu: new page, new folder, rename, move,
 * duplicate, copy the citation, delete. «Proposte (n)» of the local model is
 * an entry of the tree. Nothing leaves the Mac.
 */

const emit = defineEmits<{
  /** A citation of a note: the note in Conoscenza. */
  'open-graph': [nodeId: string];
}>();

type View = { kind: 'page'; path: string } | { kind: 'index'; path: string } | { kind: 'proposals' };

const listing = ref<WikiListing | null>(null);
const listError = ref<string | null>(null);
const open = ref<Set<string>>(new Set());
const view = ref<View>({ kind: 'index', path: '_indice' });
const page = ref<WikiPageView | null>(null);
const pageError = ref<string | null>(null);
const pageLoading = ref(false);
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function say(text: string): void {
  notice.value = text;
  if (noticeTimer !== undefined) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, 6000);
}

const shownPath = computed(() => (view.value.kind === 'proposals' ? null : view.value.path));
const tree = computed(() => (listing.value === null ? [] : buildWikiTree(listing.value.folders, listing.value.pages)));
const proposalCount = computed(() => proposals.value?.length ?? listing.value?.proposals ?? 0);
const crumbs = computed(() => (shownPath.value === null ? [] : breadcrumb(shownPath.value)));

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

// ---------------------------------------------------------------------------
// The page that saves by itself (D-284)

const draftTitle = ref('');
const draftBody = ref('');
let savedTitle = '';
let savedBody = '';
/** One per opening of a page: the core keeps one version per session. */
const session = ref(sessionToken());
const saveState = ref<SaveState>('idle');
const saveProblem = ref<string | null>(null);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
/** A move of the page open, or of a folder above it, waiting for the core: saves wait for it (then go to the new path). */
let pathMove: Promise<void> | null = null;
const editorRef = ref<{ focus: () => void } | null>(null);
/** A page just made in the tree: its editor takes the cursor as soon as it is ready. */
const focusNew = ref(false);
const autofocus = ref(false);

/** The state now, read again after an await (TypeScript keeps the one before). */
const saveIs = (state: SaveState): boolean => saveState.value === state;
const unsaved = (): boolean => page.value?.kind === 'page' && (draftTitle.value !== savedTitle || draftBody.value !== savedBody);

function schedule(): void {
  if (page.value?.kind !== 'page' || saveState.value === 'changed') return;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!unsaved()) return;
  // While a save is going, «Salvataggio…» stays: the text written meanwhile goes with the next one.
  if (saving === null) saveState.value = 'waiting';
  saveTimer = setTimeout(() => {
    void saveNow();
  }, SAVE_DELAY_MS);
}
watch([draftTitle, draftBody], schedule);

/** The save, over the page as it was shown; one at a time, the last text wins. */
async function saveNow(): Promise<void> {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  // Every save in flight first, not only one: two waiting callers would otherwise both send over the same version.
  while (saving !== null || pathMove !== null) await (saving ?? pathMove);
  const current = page.value;
  if (current === null || current.kind !== 'page' || saveState.value === 'changed' || !unsaved()) return;
  const title = draftTitle.value;
  const body = draftBody.value;
  if (title.trim() === '') {
    saveState.value = 'problem';
    saveProblem.value = 'La pagina ha bisogno di un titolo: finché manca non la salvo.';
    return;
  }
  saveState.value = 'saving';
  saving = (async () => {
    try {
      const { version, kept } = await editWikiPage(current.path, current.version, title, body, session.value);
      // The page reloaded meanwhile («Ricarica», another page): this answer is for the one before.
      if (page.value !== current) return;
      current.version = version;
      savedTitle = title;
      savedBody = body;
      saveProblem.value = null;
      const entry = listing.value?.pages.find((item) => item.path === current.path);
      if (entry !== undefined && entry.title !== title.trim()) entry.title = title.replace(/\s+/g, ' ').trim();
      saveState.value = draftTitle.value === title && draftBody.value === body ? 'saved' : 'waiting';
      // A version went to .storia (and the oldest beyond 20 may have gone): «Versioni precedenti» reads the list again.
      if (kept) {
        void loadWikiPage(current.path)
          .then((fresh) => {
            if (page.value === current) current.versions = fresh.versions;
          })
          .catch(() => undefined);
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.message.startsWith('changed')) {
        saveState.value = 'changed';
        saveProblem.value = null;
      } else {
        saveState.value = 'problem';
        saveProblem.value = problemOf(failure);
      }
    } finally {
      saving = null;
    }
  })();
  await saving;
  // Written meanwhile: the next save goes on its own.
  if (saveIs('waiting') && saveTimer === undefined && unsaved()) schedule();
}

/** Before leaving the page: what waits is saved now. */
async function flush(): Promise<void> {
  if (saveTimer !== undefined || saving !== null) await saveNow();
}

function onTitleKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    editorRef.value?.focus();
  }
}

/** Leaving with text that cannot be saved (an error, or the page changed): asked first, then `go`. */
const leaving = ref<{ go: () => void; text?: string; confirm?: string } | null>(null);

/** Whether leaving now loses text that cannot be saved. */
const unsavable = (): boolean => unsaved() && (saveState.value === 'changed' || saveState.value === 'problem');

function leave(): void {
  const go = leaving.value?.go;
  leaving.value = null;
  go?.();
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (unsaved()) event.preventDefault();
}

// ---------------------------------------------------------------------------
// Showing a page, an index or the proposals

let pageRequest = 0;
async function show(next: View, force = false): Promise<void> {
  if (!force) {
    await flush();
    if (unsavable()) {
      leaving.value = {
        go: () => {
          void show(next, true);
        },
      };
      return;
    }
  }
  leaving.value = null;
  phoneTree.value = false;
  view.value = next;
  if (next.kind === 'proposals') {
    page.value = null;
    pageError.value = null;
    void loadProposals();
    return;
  }
  const path = next.path;
  const folder = next.kind === 'index' ? folderOf(path) : null;
  const opened = new Set(open.value);
  for (const ancestor of folder === null ? ancestorsOf(path) : [...ancestorsOf(`${folder}/x`)]) if (ancestor !== '') opened.add(ancestor);
  open.value = opened;
  const request = ++pageRequest;
  pageLoading.value = true;
  pageError.value = null;
  try {
    const loaded = await loadWikiPage(path);
    if (request !== pageRequest) return;
    page.value = loaded;
    draftTitle.value = loaded.title;
    draftBody.value = loaded.body;
    savedTitle = loaded.title;
    savedBody = loaded.body;
    session.value = sessionToken();
    comparing.value = null;
    saveState.value = 'idle';
    // Only the page just made takes the cursor; the next opening reads first.
    const fresh = focusNew.value;
    focusNew.value = false;
    autofocus.value = fresh;
    saveProblem.value = null;
  } catch (failure) {
    if (request !== pageRequest) return;
    page.value = null;
    const emptyFolder = folder !== null && folder !== '' && (listing.value?.folders.includes(folder) ?? false);
    pageError.value =
      failure instanceof ApiError && failure.status === 404
        ? folder === ''
          ? wikiEmptyText('wiki', coarsePointer())
          : emptyFolder
            ? wikiEmptyText('folder', coarsePointer())
            : 'Questa pagina non c’è più.'
        : problemOf(failure);
  } finally {
    if (request === pageRequest) pageLoading.value = false;
  }
}

function showPath(path: string): Promise<void> {
  return show(path === '_indice' || path.endsWith('/_indice') ? { kind: 'index', path } : { kind: 'page', path });
}

function reload(): void {
  if (view.value.kind !== 'proposals') void show(view.value, true);
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
    void show({ kind: 'index', path: indexPath(node.path) });
  } else void show({ kind: 'page', path: node.path });
}

/** A citation of the page: another page of the Wiki here, a note in Conoscenza. */
function follow(target: string): void {
  const where = wikilinkTarget(target, page.value?.citations);
  if ('wiki' in where) {
    void showPath(where.wiki);
    return;
  }
  // A note opens in Conoscenza, outside the Wiki: what waits is saved first, and text that cannot be is asked about.
  void flush().then(() => {
    const go = (): void => {
      emit('open-graph', where.note);
    };
    if (unsavable()) leaving.value = { go };
    else go();
  });
}

// ---------------------------------------------------------------------------
// The tree on the side: width, closed, the panel on the phone

const WIDTH_KEY = 'arianna.wiki.treeWidth';
const CLOSED_KEY = 'arianna.wiki.treeClosed';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the width is only for this visit.
  }
}

const treeWidth = ref(clampTreeWidth(stored(WIDTH_KEY)));
const treeClosed = ref(stored(CLOSED_KEY) === '1');
const phoneTree = ref(false);

function setClosed(closed: boolean): void {
  treeClosed.value = closed;
  store(CLOSED_KEY, closed ? '1' : '0');
}

let resizeFrom: { x: number; width: number } | null = null;
function resizeStart(event: PointerEvent): void {
  resizeFrom = { x: event.clientX, width: treeWidth.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function resizeMove(event: PointerEvent): void {
  if (resizeFrom === null) return;
  treeWidth.value = clampTreeWidth(resizeFrom.width + event.clientX - resizeFrom.x);
}
function resizeEnd(): void {
  if (resizeFrom === null) return;
  resizeFrom = null;
  store(WIDTH_KEY, String(treeWidth.value));
}
function resizeKey(event: KeyboardEvent): void {
  const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
  if (step === 0) return;
  event.preventDefault();
  treeWidth.value = clampTreeWidth(treeWidth.value + step);
  store(WIDTH_KEY, String(treeWidth.value));
}

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

const keyOf = (node: WikiDragged): string => `${node.kind}:${node.path}`;

function rowShown(node: WikiNode): boolean {
  return node.kind === 'folder' ? shownPath.value === indexPath(node.path) : shownPath.value === node.path;
}

// ---------------------------------------------------------------------------
// The menu of the tree (D-284): right click, «…», Maiusc+F10 or the menu key

const menu = ref<{ x: number; y: number; node: WikiDragged | null; items: WikiMenuItem[]; back: HTMLElement | null } | null>(null);

function emptyFolder(path: string): boolean {
  return listing.value !== null && isEmptyFolder(path, listing.value.folders, listing.value.pages);
}

function openMenu(x: number, y: number, node: WikiDragged | null, back: HTMLElement | null): void {
  menu.value = { x, y, node, items: treeMenu(node, node?.kind === 'folder' ? emptyFolder(node.path) : false), back };
}

/** The name of the row an element is in: where the focus goes back after the menu, never the arrow (tabindex -1). */
function rowName(element: Element | null): HTMLElement | null {
  return element?.closest('.wiki-row')?.querySelector<HTMLElement>('.wiki-row-name') ?? null;
}

function onRowMenu(event: MouseEvent, node: WikiDragged): void {
  openMenu(event.clientX, event.clientY, node, event.currentTarget instanceof HTMLElement ? rowName(event.currentTarget) : null);
}

function onDotsMenu(event: MouseEvent, node: WikiDragged | null): void {
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const rect = target?.getBoundingClientRect();
  openMenu(rect === undefined ? event.clientX : rect.left, rect === undefined ? event.clientY : rect.bottom + 4, node, rowName(target) ?? target);
}

/** Whether the menu is open on this row (or on the root, `null`): `aria-expanded` of its «…». */
function menuOn(node: WikiDragged | null): boolean {
  if (menu.value === null) return false;
  if (node === null || menu.value.node === null) return node === menu.value.node;
  return menu.value.node.kind === node.kind && menu.value.node.path === node.path;
}

/** The element the last menu came from: the focus goes back there when what it opened closes. */
let lastBack: HTMLElement | null = null;
function focusBack(): void {
  if (lastBack?.isConnected === true) lastBack.focus({ preventScroll: true });
  lastBack = null;
}

function onRowKey(event: KeyboardEvent, node: WikiNode): void {
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    const rect = target?.getBoundingClientRect();
    openMenu(rect?.left ?? 0, (rect?.bottom ?? 0) + 2, { kind: node.kind, path: node.path }, target);
  } else if (event.key === 'F2') {
    event.preventDefault();
    startRename({ kind: node.kind, path: node.path }, node.name);
  }
}

function onEmptyMenu(event: MouseEvent): void {
  openMenu(event.clientX, event.clientY, null, null);
}

function closeMenu(): void {
  const back = menu.value?.back ?? null;
  menu.value = null;
  back?.focus({ preventScroll: true });
}

function nameOf(node: WikiDragged): string {
  if (node.kind === 'folder') return folderName(node.path);
  return listing.value?.pages.find((item) => item.path === node.path)?.title ?? node.path;
}

async function chooseMenu(id: string): Promise<void> {
  const node = menu.value?.node ?? null;
  lastBack = menu.value?.back ?? null;
  menu.value = null;
  if (id === 'new-page' || id === 'new-folder') startNew(node, id === 'new-page' ? 'page' : 'folder');
  else if (node === null) return;
  else if (id === 'rename') startRename(node, nameOf(node));
  else if (id === 'move') startMove(node);
  else if (id === 'duplicate') await duplicate(node);
  else if (id === 'cite') {
    await cite(node);
    focusBack();
  }
  else if (id === 'delete') await startDelete(node);
}

// The name typed in the tree: a new page or folder, or a rename

const inline = ref<{ mode: 'page' | 'folder' | 'rename'; folder: string; at: string; node: WikiDragged | null; value: string; problem: string | null; busy: boolean } | null>(null);
const inlineInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

async function focusInline(): Promise<void> {
  await nextTick();
  const input = Array.isArray(inlineInput.value) ? inlineInput.value[0] : inlineInput.value;
  input?.focus();
  input?.select();
}

function startNew(node: WikiDragged | null, kind: 'page' | 'folder'): void {
  const folder = node === null ? '' : node.kind === 'folder' ? node.path : folderOf(node.path);
  if (folder !== '' && !open.value.has(folder)) toggle(folder);
  // Under the folder's row (or the page's), at the top for the root.
  const at = node === null ? 'root' : node.kind === 'folder' ? keyOf(node) : keyOf(node);
  inline.value = { mode: kind, folder, at, node: null, value: '', problem: null, busy: false };
  phoneTree.value = phoneTree.value || window.matchMedia('(max-width: 767px)').matches;
  void focusInline();
}

function startRename(node: WikiDragged, name: string): void {
  inline.value = { mode: 'rename', folder: folderOf(node.path), at: keyOf(node), node, value: name, problem: null, busy: false };
  void focusInline();
}

function inlinePlaceholder(): string {
  const now = inline.value;
  if (now === null) return '';
  if (now.mode === 'rename') return now.node?.kind === 'folder' ? 'Nome della cartella' : 'Titolo della pagina';
  if (now.mode === 'folder') return 'Nome della cartella';
  return now.folder === '' ? 'Argomento/Titolo della pagina' : 'Titolo della pagina';
}

function cancelInline(): void {
  inline.value = null;
  focusBack();
}

function onInlineBlur(): void {
  // A click elsewhere with nothing typed closes it; with a name it waits for Enter or Esc.
  if (inline.value !== null && !inline.value.busy && inline.value.value.trim() === '') inline.value = null;
}

async function submitInline(): Promise<void> {
  const now = inline.value;
  if (now === null || now.busy) return;
  now.problem = null;
  if (now.mode === 'rename') {
    await submitRename(now.node, now.value);
    return;
  }
  const made = newItemPath(now.folder, now.value, now.mode);
  if ('problem' in made) {
    now.problem = made.problem;
    return;
  }
  now.busy = true;
  try {
    if (now.mode === 'folder') {
      await createWikiFolder(made.path);
      inline.value = null;
      await loadListing();
      open.value = new Set([...open.value, ...ancestorsOf(`${made.path}/x`)]);
      await show({ kind: 'index', path: indexPath(made.path) });
    } else {
      // A new page starts empty, as in Notion: the cursor goes in its text.
      const created = await createWikiPage(made.path, made.title, '');
      inline.value = null;
      await loadListing();
      focusNew.value = true;
      await show({ kind: 'page', path: created.path });
    }
  } catch (failure) {
    if (inline.value === now) {
      now.problem = problemOf(failure);
      now.busy = false;
    }
  }
}

async function submitRename(node: WikiDragged | null, value: string): Promise<void> {
  const now = inline.value;
  if (node === null || now === null) return;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name === '') {
    now.problem = 'Scrivi il nome.';
    return;
  }
  now.busy = true;
  try {
    if (node.kind === 'page') {
      // A page keeps its path (its citations stay): «Rinomina» changes the title, as the title on top of the page.
      if (shownPath.value === node.path && page.value?.kind === 'page') {
        draftTitle.value = name;
        await saveNow();
        if (saveState.value === 'problem' || saveState.value === 'changed') throw new Error(saveProblem.value ?? SAVE_TEXT[saveState.value]);
      } else {
        const shown = await loadWikiPage(node.path);
        await editWikiPage(node.path, shown.version, name, shown.body);
      }
      inline.value = null;
      await loadListing();
    } else {
      const to = renamedFolder(node.path, name);
      const problem = pathProblem(to, 'folder');
      if (problem !== undefined) throw new Error(problem);
      if (to === node.path) {
        inline.value = null;
        return;
      }
      await moveNow({ kind: 'folder', path: node.path }, to, 'Cartella', 'rinominata:');
      inline.value = null;
    }
  } catch (failure) {
    if (inline.value === now) {
      now.problem = failure instanceof ApiError ? problemOf(failure) : failure instanceof Error ? failure.message : 'Non ci sono riuscito: riprova.';
      now.busy = false;
    }
  }
}

// «Sposta in…»

const moving = ref<{ node: WikiDragged; choices: { folder: string; to: string }[]; chosen: string; busy: boolean; problem: string | null } | null>(null);

function startMove(node: WikiDragged): void {
  const choices = moveChoices(node, listing.value?.folders ?? []);
  moving.value = { node, choices, chosen: choices[0]?.to ?? '', busy: false, problem: null };
}

async function confirmMove(): Promise<void> {
  const now = moving.value;
  if (now === null || now.chosen === '' || now.busy) return;
  now.busy = true;
  now.problem = null;
  try {
    await moveNow(now.node, now.chosen, now.node.kind === 'page' ? 'Pagina' : 'Cartella');
    moving.value = null;
  } catch (failure) {
    now.problem = problemOf(failure);
    now.busy = false;
  }
}

/** After a move: the tree, the proposals and the page shown at its new place. */
async function afterMove(from: string, to: string, what: string, verb = 'spostata in'): Promise<void> {
  await Promise.all([loadListing(), loadProposals()]);
  await followMove(from, to);
  say(`${what} ${verb} wiki/${to}.`);
}

/**
 * A page or folder moved now, at once (D-280). What waits on the page open is
 * saved first; saves written during the move wait for the core's answer and
 * then go to the new path, so nothing is written on the old one.
 */
async function moveNow(item: WikiDragged, to: string, what: string, verb?: string): Promise<void> {
  await flush();
  let release = (): void => undefined;
  pathMove = new Promise((done) => {
    release = done;
  });
  try {
    const base = item.kind === 'page' ? (await loadWikiPage(item.path)).version : undefined;
    const where = await moveWikiNow(item.kind, item.path, to, base);
    await afterMove(item.path, where, what, verb);
  } finally {
    pathMove = null;
    release();
  }
}

/**
 * The page open follows a move of itself or of a folder above it: when its
 * text did not change, in place, with what is being written; when the core
 * rewrote it (links that followed) and the user wrote meanwhile, the page
 * says it changed and keeps the text; otherwise it opens again.
 */
async function followMove(from: string, to: string): Promise<void> {
  if (shownPath.value === null) return;
  const moved = movedPath(shownPath.value, from, to);
  if (moved === shownPath.value) return;
  const current = page.value;
  if (view.value.kind !== 'page' || current?.kind !== 'page') {
    // Forced: the saves wait for this move, a flush here would wait for itself.
    await show(moved === '_indice' || moved.endsWith('/_indice') ? { kind: 'index', path: moved } : { kind: 'page', path: moved }, true);
    return;
  }
  try {
    const fresh = await loadWikiPage(moved);
    if (page.value !== current) return;
    if (fresh.version !== current.version && !unsaved()) {
      await show({ kind: 'page', path: moved }, true);
      return;
    }
    if (fresh.version !== current.version) saveState.value = 'changed';
    current.path = moved;
    current.versions = fresh.versions;
    view.value = { kind: 'page', path: moved };
    open.value = new Set([...open.value, ...ancestorsOf(moved)]);
  } catch (failure) {
    say(problemOf(failure));
  }
}

// «Duplica»: a new page «<titolo> (copia)» next to it, with the same text

async function duplicate(node: WikiDragged): Promise<void> {
  if (node.kind !== 'page' || listing.value === null) return;
  try {
    if (shownPath.value === node.path) await flush();
    const shown = await loadWikiPage(node.path);
    const taken = new Set([...listing.value.pages.map((item) => item.path), ...listing.value.folders]);
    const created = await createWikiPage(copyPath(node.path, taken), copyTitle(shown.title), shown.body);
    await loadListing();
    await show({ kind: 'page', path: created.path });
    say(`Copia creata: wiki/${created.path}.`);
  } catch (failure) {
    say(problemOf(failure));
  }
}

// «Copia citazione»

async function cite(node: WikiDragged): Promise<void> {
  const text = citationOf(node);
  try {
    await navigator.clipboard.writeText(text);
    say(`Citazione copiata: ${text}. Incollala in un’altra pagina.`);
  } catch {
    say(`Non riesco a copiare da qui: la citazione è ${text}`);
  }
}

// «Elimina»: a page after the confirmation of D-280, an empty folder

const deleting = ref<{ path: string; title: string; version: string; versions: number } | null>(null);
const deleteProblem = ref<string | null>(null);
const deleteBusy = ref(false);
const deletingFolder = ref<string | null>(null);
const folderDeleteBusy = ref(false);
const folderDeleteProblem = ref<string | null>(null);

async function startDelete(node: WikiDragged): Promise<void> {
  deleteProblem.value = null;
  folderDeleteProblem.value = null;
  if (node.kind === 'folder') {
    deletingFolder.value = node.path;
    return;
  }
  try {
    if (shownPath.value === node.path) await flush();
    const shown = await loadWikiPage(node.path);
    deleting.value = { path: node.path, title: shown.title, version: shown.version, versions: shown.versions.length };
  } catch (failure) {
    say(problemOf(failure));
  }
}

async function confirmDelete(): Promise<void> {
  const now = deleting.value;
  if (now === null) return;
  deleteBusy.value = true;
  deleteProblem.value = null;
  try {
    await deleteWikiPage(now.path, now.version);
    deleting.value = null;
    await Promise.all([loadListing(), loadProposals()]);
    if (shownPath.value === now.path) await show({ kind: 'index', path: indexPath(folderOf(now.path)) }, true);
    say(`Pagina «${now.title}» eliminata, con le sue versioni.`);
  } catch (failure) {
    deleteProblem.value = problemOf(failure);
  } finally {
    deleteBusy.value = false;
  }
}

async function confirmFolderDelete(): Promise<void> {
  const folder = deletingFolder.value;
  if (folder === null) return;
  folderDeleteBusy.value = true;
  folderDeleteProblem.value = null;
  try {
    await deleteWikiFolder(folder);
    deletingFolder.value = null;
    await loadListing();
    if (shownPath.value === indexPath(folder)) await show({ kind: 'index', path: indexPath(folder.split('/').slice(0, -1).join('/')) });
    say(`Cartella wiki/${folder} eliminata.`);
  } catch (failure) {
    folderDeleteProblem.value = problemOf(failure);
  } finally {
    folderDeleteBusy.value = false;
  }
}

// «Ripristina» an old version

const restoring = ref<string | null>(null);
const restoreProblem = ref<string | null>(null);
const restoreBusy = ref(false);

/** A version gone from «Versioni precedenti» (beyond the 20 kept, or the page deleted) says so, and the list is read again. */
function versionProblem(failure: unknown): string {
  if (!(failure instanceof ApiError)) return problemOf(failure);
  if (failure.status !== 404) return versionErrorText(failure.status, failure.message);
  const current = page.value;
  if (current?.kind === 'page') {
    void loadWikiPage(current.path)
      .then((fresh) => {
        if (page.value === current) current.versions = fresh.versions;
      })
      .catch(() => undefined);
  }
  return versionErrorText(404, failure.message);
}

/** Text written here that cannot be saved (an error, or the page changed) goes when a version comes back: asked first. */
const RESTORE_LOSES = 'Il testo scritto qui non è salvato e il ripristino lo sostituisce: va perso. Copialo prima, se ti serve.';

async function confirmRestore(force = false): Promise<void> {
  if (page.value === null || restoring.value === null) return;
  await flush();
  if (!force && unsavable()) {
    leaving.value = {
      text: RESTORE_LOSES,
      confirm: 'Ripristina comunque',
      go: () => {
        void confirmRestore(true);
      },
    };
    return;
  }
  restoreBusy.value = true;
  restoreProblem.value = null;
  try {
    await restoreWikiPage(page.value.path, restoring.value, page.value.version);
    restoring.value = null;
    await show({ kind: 'page', path: page.value.path }, true);
    await loadListing();
  } catch (failure) {
    restoreProblem.value = versionProblem(failure);
  } finally {
    restoreBusy.value = false;
  }
}

// Dragging a page or folder in the tree

const dragging = ref<WikiDragged | null>(null);
const dropOver = ref<string | null>(null);
const treeNotice = ref<string | null>(null);

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

/** A page or folder dropped on a folder (or on a page: its folder): moved at once. */
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
    await moveNow(item, where.to, item.kind === 'page' ? 'Pagina' : 'Cartella');
  } catch (failure) {
    treeNotice.value = problemOf(failure);
  }
}

// ---------------------------------------------------------------------------
// The proposals of the local model

const proposals = ref<WikiProposal[] | null>(null);
const proposalsError = ref<string | null>(null);
/** Per proposal: the path the user typed (new page: its place; move: its destination). */
const paths = ref<Record<string, string>>({});
/** Per proposal: why it did not go, or what happened. */
const notices = ref<Record<string, string>>({});
const busy = ref<string | null>(null);
const done = ref<string | null>(null);

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

const rowClass = { added: 'bg-ok/10', removed: 'bg-danger/10', context: '', gap: 'bg-surface-2 text-muted italic' } as const;

// «Confronta» an old version with the page now (D-285)

const comparing = ref<{ id: string; at: string; data: VersionComparison | null; problem: string | null; busy: boolean; unsaved: boolean } | null>(null);
const comparePanel = ref<HTMLElement | null>(null);

/** The diff of the version with the page as it is now: what waits is saved first, so «adesso» is what the user sees. */
async function compare(id: string, at: string): Promise<void> {
  const current = page.value;
  if (current === null || current.kind !== 'page') return;
  // One at a time: the plain «Ripristina» asks in its window, the comparison has its own button.
  restoring.value = null;
  comparing.value = { id, at, data: null, problem: null, busy: false, unsaved: false };
  try {
    await flush();
    // What cannot be saved is not on the Mac yet: the comparison shows the page as saved, and says so.
    const asked = comparing.value as { id: string; unsaved: boolean } | null;
    if (asked?.id === id) asked.unsaved = unsavable();
    const data = await compareWikiVersion(current.path, id);
    // «Chiudi», another «Confronta» or another page meanwhile: this answer is not shown.
    // TypeScript keeps the value from before the await: read again, it may be null now.
    const shown = comparing.value as { id: string; data: VersionComparison | null } | null;
    if (shown?.id !== id || page.value !== current) return;
    shown.data = data;
    await nextTick();
    comparePanel.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (failure) {
    const shown = comparing.value as { id: string; problem: string | null } | null;
    if (shown?.id === id) shown.problem = versionProblem(failure);
  }
}

/** «Ripristina questa versione»: only over the page as compared (its sha256); the version of now stays among the old ones. */
async function restoreCompared(force = false): Promise<void> {
  const now = comparing.value;
  const current = page.value;
  if (now === null || now.data === null || current === null || now.busy) return;
  await flush();
  if (!force && unsavable()) {
    leaving.value = {
      text: RESTORE_LOSES,
      confirm: 'Ripristina comunque',
      go: () => {
        void restoreCompared(true);
      },
    };
    return;
  }
  now.busy = true;
  now.problem = null;
  try {
    await restoreWikiPage(current.path, now.id, now.data.base);
    comparing.value = null;
    await show({ kind: 'page', path: current.path }, true);
    await loadListing();
    say(`Pagina tornata com’era il ${versionText(now.at)}. La versione di prima è fra le precedenti.`);
  } catch (failure) {
    now.problem =
      failure instanceof ApiError && failure.message.startsWith('changed')
        ? 'La pagina è cambiata dopo il confronto: confronta di nuovo prima di ripristinare.'
        : versionProblem(failure);
    now.busy = false;
  }
}
const signOf = { added: '+', removed: '−', context: ' ', gap: '⋯' } as const;

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload);
  void loadListing();
  void loadProposals();
  void show({ kind: 'index', path: '_indice' });
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  if (noticeTimer !== undefined) clearTimeout(noticeTimer);
  // Leaving the Wiki for another page of the chat: what waits is saved.
  if (saveTimer !== undefined) void saveNow();
});
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <!-- The tree: on the side on a wide screen, a panel on the phone -->
    <div v-if="phoneTree" class="fixed inset-0 z-30 bg-black/40 md:hidden" aria-hidden="true" @click="phoneTree = false" />
    <aside
      class="flex-col border-r border-line bg-surface-2 text-[14px]"
      :class="[phoneTree ? 'fixed inset-y-0 left-0 z-40 flex w-[min(320px,86vw)] shadow-xl' : 'hidden', treeClosed ? 'md:hidden' : 'md:relative md:z-auto md:flex md:w-[var(--tree-w)] md:shadow-none']"
      :style="{ '--tree-w': `${String(treeWidth)}px` }"
      aria-label="Albero della Wiki"
    >
      <div class="flex items-center gap-1 px-2 pt-3 pb-1">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left font-semibold hover:bg-surface touch:min-h-11"
          :class="[shownPath === '_indice' ? 'text-accent' : '', dropOver === '' ? 'bg-accent/15' : '']"
          @click="show({ kind: 'index', path: '_indice' })"
          @dragover="dragOver($event, '')"
          @dragleave="dropOver = null"
          @drop.prevent="dropOn('')"
          @contextmenu.prevent="onEmptyMenu"
        >
          <Icon name="wiki" :size="15" /><span class="truncate">Wiki</span>
        </button>
        <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-ink touch:size-11" title="Nuova pagina o cartella alla radice" aria-label="Nuova pagina o cartella alla radice" aria-haspopup="menu" :aria-expanded="menuOn(null)" @click="onDotsMenu($event, null)">
          <Icon name="new" :size="15" />
        </button>
        <button type="button" class="hidden size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-ink md:grid" title="Chiudi l’albero" aria-label="Chiudi l’albero" @click="setClosed(true)">
          <Icon name="sidebar-collapse" :size="15" />
        </button>
        <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-ink md:hidden touch:size-11" aria-label="Chiudi l’albero" @click="phoneTree = false">
          <Icon name="close" :size="15" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" @contextmenu.self.prevent="onEmptyMenu">
        <p v-if="treeNotice !== null" class="px-2 py-1 text-xs text-danger" role="alert">{{ treeNotice }}</p>
        <p v-if="listError !== null" class="px-2 py-1 text-xs text-danger" role="alert">{{ listError }}</p>

        <form v-if="inline !== null && inline.at === 'root'" class="px-1 py-0.5" @submit.prevent="submitInline">
          <input
            ref="inlineInput"
            v-model="inline.value"
            type="text"
            maxlength="120"
            autocomplete="off"
            class="w-full rounded-md border border-line bg-surface px-2 py-1 text-[14px] outline-none"
            :placeholder="inlinePlaceholder()"
            :aria-label="inlinePlaceholder()"
            :disabled="inline.busy"
            @keydown.esc.prevent="cancelInline"
            @blur="onInlineBlur"
          />
          <p v-if="inline.problem !== null" class="mt-0.5 text-xs text-danger" role="alert">{{ inline.problem }}</p>
        </form>

        <p v-if="listing !== null && rows.length === 0 && inline === null" class="px-2 py-1 text-[13px] text-muted" @contextmenu.prevent="onEmptyMenu">Nessuna pagina ancora. <span class="touch:hidden">Clic destro qui o «+» per crearne.</span><span class="hidden touch:inline">Tocca «+» qui sopra per crearne.</span></p>

        <template v-for="row in rows" :key="keyOf(row.node)">
          <div
            class="wiki-row group flex items-center rounded-md"
            :class="[dropOver !== null && dropOver === dropFolder(row.node) && dragging !== null ? 'bg-accent/15' : '', rowShown(row.node) ? 'bg-surface' : 'hover:bg-surface/70']"
            :style="{ paddingLeft: `${String(row.depth * 14)}px` }"
            :draggable="inline?.at !== keyOf(row.node)"
            @dragstart="dragStart($event, row.node)"
            @dragend="dragEnd"
            @dragover="dragOver($event, dropFolder(row.node))"
            @drop.prevent="dropOn(dropFolder(row.node))"
            @contextmenu.prevent.stop="onRowMenu($event, row.node)"
          >
            <button
              v-if="row.node.kind === 'folder'"
              type="button"
              tabindex="-1"
              class="rounded p-0.5 text-muted hover:text-ink touch:grid touch:size-9 touch:place-items-center"
              :aria-label="open.has(row.node.path) ? `Chiudi ${row.node.name}` : `Apri ${row.node.name}`"
              :aria-expanded="open.has(row.node.path)"
              @click="toggle(row.node.path)"
            >
              <Icon :name="open.has(row.node.path) ? 'sort-down' : 'expand'" :size="13" />
            </button>
            <span v-else class="inline-block w-[18px] touch:w-9" />

            <form v-if="inline !== null && inline.mode === 'rename' && inline.at === keyOf(row.node)" class="min-w-0 flex-1 py-0.5 pr-1" @submit.prevent="submitInline">
              <input
                ref="inlineInput"
                v-model="inline.value"
                type="text"
                maxlength="80"
                autocomplete="off"
                class="w-full rounded-md border border-line bg-surface px-1.5 py-0.5 text-[14px] outline-none"
                :aria-label="inlinePlaceholder()"
                :disabled="inline.busy"
                @keydown.esc.prevent="cancelInline"
                @blur="onInlineBlur"
              />
              <p v-if="inline.problem !== null" class="mt-0.5 text-xs text-danger" role="alert">{{ inline.problem }}</p>
            </form>
            <button
              v-else
              type="button"
              class="wiki-row-name min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left touch:min-h-11"
              :class="[row.node.kind === 'folder' ? 'font-medium' : '', rowShown(row.node) ? 'text-accent' : '']"
              :title="`wiki/${row.node.path} · clic destro per le azioni`"
              :aria-current="rowShown(row.node) ? 'page' : undefined"
              @click="choose(row.node)"
              @keydown="onRowKey($event, row.node)"
            >
              {{ row.node.name }}
            </button>

            <span class="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button
                v-if="row.node.kind === 'folder'"
                type="button"
                class="grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-ink touch:size-11"
                :title="`Nuova pagina in ${row.node.name}`"
                :aria-label="`Nuova pagina in ${row.node.name}`"
                @click="startNew({ kind: 'folder', path: row.node.path }, 'page')"
              >
                <Icon name="new" :size="13" />
              </button>
              <button
                type="button"
                class="grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-ink touch:size-11"
                :title="`Azioni su ${row.node.name}`"
                :aria-label="`Azioni su ${row.node.name}`"
                aria-haspopup="menu"
                :aria-expanded="menuOn({ kind: row.node.kind, path: row.node.path })"
                @click="onDotsMenu($event, { kind: row.node.kind, path: row.node.path })"
              >
                <Icon name="more" :size="14" />
              </button>
            </span>
          </div>
          <form v-if="inline !== null && inline.mode !== 'rename' && inline.at === keyOf(row.node)" class="py-0.5 pr-1" :style="{ paddingLeft: `${String((row.depth + (row.node.kind === 'folder' ? 1 : 0)) * 14 + 18)}px` }" @submit.prevent="submitInline">
            <input
              ref="inlineInput"
              v-model="inline.value"
              type="text"
              maxlength="120"
              autocomplete="off"
              class="w-full rounded-md border border-line bg-surface px-2 py-1 text-[14px] outline-none"
              :placeholder="inlinePlaceholder()"
              :aria-label="inlinePlaceholder()"
              :disabled="inline.busy"
              @keydown.esc.prevent="cancelInline"
              @blur="onInlineBlur"
            />
            <p v-if="inline.problem !== null" class="mt-0.5 text-xs text-danger" role="alert">{{ inline.problem }}</p>
          </form>
        </template>
        <!-- The empty part below the rows: its right click makes at the root -->
        <div class="min-h-16 flex-1" aria-hidden="true" @contextmenu.prevent="onEmptyMenu" />
      </div>

      <div class="border-t border-line px-2 py-2">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-surface touch:min-h-11"
          :class="view.kind === 'proposals' ? 'bg-surface text-accent' : ''"
          :aria-current="view.kind === 'proposals' ? 'page' : undefined"
          @click="show({ kind: 'proposals' })"
        >
          <Icon name="inbox" :size="14" /><span class="flex-1">Proposte</span>
          <span class="rounded-full px-1.5 text-[12px]" :class="proposalCount > 0 ? 'bg-accent/15 text-accent' : 'text-muted'">{{ proposalCount }}</span>
        </button>
      </div>

      <!-- Drag to resize; the arrows too -->
      <div
        class="absolute inset-y-0 -right-1 hidden w-2 cursor-col-resize md:block"
        role="separator"
        aria-orientation="vertical"
        aria-label="Larghezza dell’albero"
        :aria-valuenow="treeWidth"
        :aria-valuemin="TREE_WIDTH.min"
        :aria-valuemax="TREE_WIDTH.max"
        tabindex="0"
        @pointerdown="resizeStart"
        @pointermove="resizeMove"
        @pointerup="resizeEnd"
        @pointercancel="resizeEnd"
        @keydown="resizeKey"
      />
    </aside>

    <!-- The page -->
    <main class="min-w-0 flex-1 overflow-y-auto" aria-labelledby="wiki-title">
      <div class="sticky top-0 z-10 flex items-center gap-2 bg-bg/90 px-3 py-2 backdrop-blur md:px-4">
        <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink md:hidden touch:size-11" aria-label="Apri l’albero della Wiki" @click="phoneTree = true">
          <Icon name="sidebar-expand" :size="16" />
        </button>
        <button v-if="treeClosed" type="button" class="hidden size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink md:grid" title="Apri l’albero" aria-label="Apri l’albero" @click="setClosed(false)">
          <Icon name="sidebar-expand" :size="16" />
        </button>
        <nav class="flex min-w-0 flex-1 items-center gap-1 text-[13.5px] text-muted" aria-label="Percorso">
          <template v-if="view.kind === 'proposals'">
            <button type="button" class="truncate rounded px-1 hover:bg-surface-2 hover:text-ink touch:min-h-11" @click="show({ kind: 'index', path: '_indice' })">Wiki</button>
            <span aria-hidden="true">›</span><span class="truncate text-ink">Proposte</span>
          </template>
          <template v-else>
            <template v-for="(crumb, at) in crumbs" :key="crumb.folder">
              <span v-if="at > 0" aria-hidden="true">›</span>
              <button
                type="button"
                class="truncate rounded px-1 hover:bg-surface-2 hover:text-ink touch:min-h-11"
                :class="view.kind === 'index' && at === crumbs.length - 1 ? 'text-ink' : ''"
                @click="show({ kind: 'index', path: indexPath(crumb.folder) })"
              >
                {{ crumb.text }}
              </button>
            </template>
            <template v-if="view.kind === 'page' && page !== null">
              <span aria-hidden="true">›</span><span class="truncate text-ink">{{ draftTitle.trim() === '' ? 'Senza titolo' : draftTitle }}</span>
            </template>
          </template>
        </nav>
        <span v-if="view.kind === 'page'" class="shrink-0 text-[12.5px]" :class="saveState === 'changed' || saveState === 'problem' ? 'text-danger' : 'text-muted'" role="status" aria-live="polite">
          {{ SAVE_TEXT[saveState] }}
        </span>
        <button
          v-if="view.kind === 'page' && page !== null"
          type="button"
          class="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink touch:size-11"
          title="Azioni sulla pagina"
          aria-label="Azioni sulla pagina"
          aria-haspopup="menu"
          :aria-expanded="menuOn({ kind: 'page', path: page.path })"
          @click="onDotsMenu($event, { kind: 'page', path: page.path })"
        >
          <Icon name="more" :size="16" />
        </button>
      </div>

      <div class="mx-auto w-full max-w-[760px] px-4 pt-6 pb-24 md:px-12">
        <p v-if="notice !== null" class="mb-4 rounded-lg border border-ok/50 bg-ok/10 px-3 py-2 text-sm" role="status">{{ notice }}</p>

        <!-- Proposals -->
        <section v-if="view.kind === 'proposals'" class="flex flex-col gap-3">
          <h1 id="wiki-title" class="text-[30px] leading-tight font-bold">Proposte</h1>
          <p class="text-[14px] text-muted">Pagine che il modello locale propone dalle tue note e dai video riassunti: cambiano la Wiki solo quando le approvi.</p>
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
              <button type="button" class="ml-1 hover:text-accent hover:underline touch:min-h-11" @click="emit('open-graph', proposal.source.id)">{{ proposal.source.title }}</button>
            </p>
            <p v-if="proposal.reason !== ''" class="text-[13.5px] text-muted">{{ proposal.reason }}</p>
            <p class="text-[12.5px] text-muted">+{{ proposal.diff.added }} −{{ proposal.diff.removed }}</p>
            <div class="max-h-[420px] overflow-auto rounded-lg border border-line font-mono text-[12.5px]">
              <table class="w-full border-collapse">
                <tbody>
                  <tr v-for="(row, at) in wikiDiffRows(proposal.diff.hunks)" :key="at" :class="rowClass[row.kind]">
                    <td class="w-px px-1 select-none" :class="row.kind === 'added' ? 'text-ok' : row.kind === 'removed' ? 'text-danger' : 'text-muted'" aria-hidden="true">{{ signOf[row.kind] }}</td>
                    <td class="pr-3 break-words whitespace-pre-wrap">
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
        </section>

        <template v-else>
          <!-- The home of the Wiki: what it is and how it works -->
          <section v-if="view.path === '_indice'" class="mb-6 rounded-xl border border-line bg-surface-2 p-4 text-[14px] leading-relaxed text-muted">
            <p>
              Pagine che il modello locale propone dalle tue note e dai video riassunti (le approvi in «Proposte»), e pagine che scrivi tu. Restano sul Mac, sempre Private.
            </p>
            <p class="mt-1.5">
              Una pagina si scrive direttamente e si salva da sola. Nel testo «/» apre i blocchi, «[[» cita una nota o un’altra pagina<span class="touch:hidden">, la maniglia ⋮⋮ sposta un blocco. Clic destro su una voce dell’albero (o «…») per creare, rinominare, spostare, duplicare o eliminare.</span><span class="hidden touch:inline">. Il «⋯» di una voce dell’albero crea, rinomina, sposta, duplica o elimina.</span>
            </p>
          </section>

          <p v-if="pageLoading && page === null" class="text-sm text-muted">Leggo la pagina…</p>
          <p v-else-if="pageError !== null" class="text-[15px] text-muted">{{ pageError }}</p>

          <!-- An index: composed by the code, only read -->
          <article v-else-if="page !== null && page.kind === 'index'">
            <h1 id="wiki-title" class="text-[32px] leading-tight font-bold phone:text-[26px]">{{ page.title }}</h1>
            <p class="mt-1 text-[12.5px] text-muted">Indice composto da Arianna: si aggiorna da solo con le pagine della cartella.</p>
            <MarkdownText class="mt-5" :source="page.body" :wikilink="follow" />
          </article>

          <!-- A page: always written, saved by itself -->
          <article v-else-if="page !== null">
            <p v-if="saveState === 'changed'" class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm" role="alert">
              <Icon name="warning" :size="14" />
              <span class="min-w-0 flex-1">La pagina è cambiata intanto (una proposta approvata, un’altra finestra): quello che hai scritto qui non è salvato, copialo prima di ricaricare.</span>
              <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="reload">Ricarica</button>
            </p>
            <p v-if="saveState === 'problem' && saveProblem !== null" class="mb-4 flex items-center gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm" role="alert">
              <Icon name="warning" :size="14" /><span class="min-w-0 flex-1">{{ saveProblem }} La pagina non è salvata finché non lo correggi.</span>
            </p>
            <input
              id="wiki-title"
              v-model="draftTitle"
              type="text"
              maxlength="80"
              autocomplete="off"
              class="w-full bg-transparent text-[32px] leading-tight font-bold outline-none placeholder:text-muted/60 phone:text-[26px]"
              data-own-size
              placeholder="Senza titolo"
              aria-label="Titolo della pagina"
              @keydown="onTitleKey"
            />
            <div class="mt-4">
              <WikiEditor :key="session" ref="editorRef" v-model="draftBody" :autofocus="autofocus" :citations="page.citations" @follow="follow" />
            </div>

            <details v-if="page.versions.length > 0" class="mt-8 border-t border-line pt-3 text-[13.5px]">
              <summary class="flex cursor-pointer items-center gap-1.5 font-semibold text-muted"><Icon name="history" :size="14" />Versioni precedenti ({{ page.versions.length }})</summary>
              <ul class="mt-1.5 flex flex-col gap-1">
                <li v-for="version in page.versions" :key="version.id" class="flex items-center gap-2 phone:flex-wrap">
                  <span class="font-mono text-[12.5px] text-muted">{{ versionText(version.at) }}</span>
                  <button type="button" class="btn px-2 py-0.5 text-[12.5px]" :aria-pressed="comparing?.id === version.id" :disabled="comparing?.busy === true || restoreBusy" @click="compare(version.id, version.at)"><Icon name="compare" :size="12" />Confronta</button>
                  <button type="button" class="btn px-2 py-0.5 text-[12.5px]" :disabled="comparing?.busy === true || restoreBusy" @click="restoring = version.id; restoreProblem = null; comparing = null"><Icon name="retry" :size="12" />Ripristina</button>
                </li>
              </ul>
            </details>

            <!-- «Confronta» (D-285): from the old version to the page now, as the diff of the proposals -->
            <section v-if="comparing !== null" ref="comparePanel" class="mt-4 flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5" aria-labelledby="wiki-compare-title">
              <h2 id="wiki-compare-title" class="text-[15px] font-semibold">Versione del {{ versionText(comparing.at) }} e pagina di adesso</h2>
              <p class="text-[13px] text-muted">
                <span class="text-danger">−</span> c’era nella versione e adesso non c’è più · <span class="text-ok">+</span> c’è adesso e nella versione non c’era. La prima riga è il titolo.
              </p>
              <p v-if="comparing.unsaved" class="flex items-center gap-1.5 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-[13px]" role="status">
                <Icon name="warning" :size="14" />Il testo non salvato non è nel confronto: «adesso» è la pagina com’è salvata sul Mac.
              </p>
              <p v-if="comparing.data === null && comparing.problem === null" class="text-sm text-muted">Confronto le due versioni…</p>
              <template v-if="comparing.data !== null">
                <p v-if="comparing.data.diff.hunks.length === 0" class="text-[14px] text-muted">Nessuna differenza: la versione è uguale alla pagina di adesso.</p>
                <template v-else>
                  <p class="text-[12.5px] text-muted">+{{ comparing.data.diff.added }} −{{ comparing.data.diff.removed }}</p>
                  <div class="max-h-[480px] overflow-auto rounded-lg border border-line font-mono text-[12.5px]">
                    <table class="w-full border-collapse">
                      <tbody>
                        <tr v-for="(row, at) in wikiDiffRows(comparing.data.diff.hunks, comparing.data.lines.then)" :key="at" :class="rowClass[row.kind]">
                          <td class="w-px px-1 select-none" :class="row.kind === 'added' ? 'text-ok' : row.kind === 'removed' ? 'text-danger' : 'text-muted'" aria-hidden="true">{{ signOf[row.kind] }}</td>
                          <td class="pr-3 break-words whitespace-pre-wrap">
                            <span v-if="row.kind === 'added'" class="sr-only">aggiunta: </span><span v-else-if="row.kind === 'removed'" class="sr-only">tolta: </span>{{ row.text }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </template>
              <p v-if="comparing.problem !== null" class="text-[13px] text-danger" role="alert">{{ comparing.problem }}</p>
              <footer class="flex flex-wrap gap-2">
                <button
                  v-if="comparing.data !== null && comparing.data.diff.hunks.length > 0"
                  type="button"
                  class="btn btn-primary px-3 py-1 text-[13.5px]"
                  :disabled="comparing.busy"
                  @click="restoreCompared()"
                >
                  <Icon name="retry" :size="14" />Ripristina questa versione
                </button>
                <button type="button" class="btn px-3 py-1 text-[13.5px]" :disabled="comparing.busy" @click="comparing = null">Chiudi</button>
              </footer>
            </section>
          </article>
        </template>
      </div>
    </main>

    <WikiMenu v-if="menu !== null" :items="menu.items" :x="menu.x" :y="menu.y" :label="menu.node === null ? 'Azioni alla radice della Wiki' : `Azioni su ${nameOf(menu.node)}`" @choose="chooseMenu" @close="closeMenu" />

    <ConfirmDialog
      v-if="moving !== null"
      :title="moving.node.kind === 'page' ? 'Sposta la pagina' : 'Sposta la cartella'"
      confirm-text="Sposta"
      :busy="moving.busy"
      :problem="moving.problem"
      :disabled="moving.chosen === ''"
      @confirm="confirmMove"
      @cancel="moving = null; focusBack()"
    >
      <p v-if="moving.choices.length === 0">Non c’è un’altra cartella dove possa andare: al più argomento › sotto-argomento › articolo.</p>
      <template v-else>
        <p>Dove va «{{ nameOf(moving.node) }}»? Subito: versioni e collegamenti seguono.</p>
        <select v-model="moving.chosen" class="mt-2 w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[14px] outline-none" aria-label="Cartella di destinazione">
          <option v-for="choice in moving.choices" :key="choice.to" :value="choice.to">{{ choice.folder === '' ? 'Wiki (radice)' : `wiki/${choice.folder}` }}</option>
        </select>
      </template>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="deletingFolder !== null"
      title="Elimina la cartella"
      confirm-text="Elimina"
      danger
      :busy="folderDeleteBusy"
      :problem="folderDeleteProblem"
      @confirm="confirmFolderDelete"
      @cancel="deletingFolder = null; focusBack()"
    >
      <p>La cartella vuota wiki/{{ deletingFolder }} va via. Le altre cartelle e le pagine restano come sono.</p>
    </ConfirmDialog>

    <ConfirmDialog v-if="deleting !== null" title="Elimina la pagina" confirm-text="Elimina" danger :busy="deleteBusy" :problem="deleteProblem" @confirm="confirmDelete" @cancel="deleting = null; focusBack()">
      <p>
        La pagina «{{ deleting.title }}» va via per sempre dal Mac{{ deleting.versions === 0 ? '' : deleting.versions === 1 ? ', con la sua versione precedente,' : `, con le sue ${String(deleting.versions)} versioni precedenti,` }} insieme alle proposte in attesa su di lei. Le note che cita restano. Gli indici delle cartelle si aggiornano; la cartella resta.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="restoring !== null && page !== null"
      title="Ripristina la versione"
      confirm-text="Ripristina"
      :busy="restoreBusy"
      :problem="restoreProblem"
      @confirm="confirmRestore()"
      @cancel="restoring = null"
    >
      <p>La pagina «{{ page.title }}» torna com’era il {{ versionText(page.versions.find((version) => version.id === restoring)?.at ?? '') }}. La versione di adesso resta fra le precedenti.</p>
    </ConfirmDialog>

    <ConfirmDialog v-if="leaving !== null" title="Modifiche non salvate" :confirm-text="leaving.confirm ?? 'Lascia la pagina'" danger @confirm="leave" @cancel="leaving = null">
      <p v-if="leaving.text !== undefined">{{ leaving.text }}</p>
      <p v-else>{{ saveState === 'changed' ? 'La pagina è cambiata intanto e quello che hai scritto non si può salvare sopra.' : saveProblem ?? 'Quello che hai scritto non è salvato.' }} Se lasci la pagina, il testo scritto qui va perso: copialo prima, se ti serve.</p>
    </ConfirmDialog>
  </div>
</template>

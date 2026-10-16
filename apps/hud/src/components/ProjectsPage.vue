<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { clientOfProject, deleteProjectPath, listBrowsableProjects, listClients, listProjectDir, moveProjectPath, listProjectServices, openProjectFile, readCommitDiff, readImOverview, readProjectFile, readProjectGit, revealProjectFile, serviceLog, setProjectHidden, startService, stopService } from '../lib/api.ts';
import { diffRows } from '../lib/delegations.ts';
import { calendarText, todayInput, type ImOverview } from '../lib/im-billing.ts';
import { imDayText } from '../lib/im.ts';
import { cardMoneyText, isAriannaProject, overdueShortText, partsText, projectCardIm, projectInitials, sortProjectCards, type ProjectCardIm } from '../lib/project-cards.ts';
import { isPartTab, nextIm, overdueInvoices, overdueText, partPressed, PROJECT_TABS, type ProjectTab } from '../lib/projects-page.ts';
import {
  agoText,
  browseErrorText,
  changeMark,
  childPath,
  confirmText,
  endedText,
  extensionOf,
  FILE_ERROR_TEXT,
  fileBadge,
  firstChangedLine,
  highlightLine,
  serviceStateText,
  SHUT_TEXT,
  sizeText,
  vscodeUrl,
  partTitle,
  folderFromSearch,
  invoiceFromSearch,
  projectFromSearch,
  projectsPathFor,
  type BrowsableContainer,
  type BrowsableProject,
  type CommitDiff,
  type ProjectFile,
  type ProjectGit,
  type ServiceLog,
  type ServiceState,
  type TreeEntry,
} from '../lib/projects.ts';
import { initialsOf, logoUrl, type ClientLogo } from '../lib/clients.ts';
import { restoredPath } from '../lib/studio.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import Icon from './Icon.vue';
import ProjectImTab from './ProjectImTab.vue';
import ProjectRulesTab from './ProjectRulesTab.vue';
import ProjectKnowledgeTab from './ProjectKnowledgeTab.vue';

/**
 * "Progetti" (D-134): an approved project read on this computer. File and
 * Git are read only: the tree, a file with the colours of the code, "Apri"
 * for pages and images (D-117), branches, changes not committed, commits and
 * their diff. "Apri in VS Code" is a vscode:// link: the core runs nothing.
 * "Mostra nascosti" (D-135): with the user's consent, kept per project, the
 * hidden entries too; a secret comes covered until "Mostra".
 * D-145: a project is a container; File, Git and Servizi read one of its
 * parts (the container itself when it is one git), "Conoscenza" its
 * management folders and notes.
 * D-191: the name in the normal font, four numbers on top (Branch, Modifiche,
 * Servizi, Prossimo IM), the tabs in one row (the pills of the parts only in
 * File, Git and Servizi), errors and empty states that say what to do.
 * Without `?progetto=` the page is a grid of cards, as the clients (D-190).
 * `visit` changes at every opening of the page from outside (a link, "back"):
 * the address is read again.
 */
const props = defineProps<{ visit: number }>();

const emit = defineEmits<{ client: [id: string]; studio: [project: string]; conversation: [id: string]; settings: [slug: string]; cardwall: [] }>();

const projects = ref<BrowsableProject[] | null>(null);
const containers = ref<BrowsableContainer[] | null>(null);
const chosenContainer = ref<string | null>(null);
const container = computed(() => containers.value?.find((item) => item.name === chosenContainer.value) ?? null);
const parts = computed(() => (projects.value ?? []).filter((item) => item.project === chosenContainer.value));
const chosen = ref<string | null>(null);
const project = computed(() => parts.value.find((item) => item.name === chosen.value) ?? null);
const switcherOpen = ref(false);
const tab = ref<ProjectTab>('file');
const problem = ref<string | null>(null);

// Files
const folders = ref<Record<string, { entries: TreeEntry[]; more: number } | 'loading' | string>>({});
const openFolders = ref<Set<string>>(new Set());
const selected = ref<string | null>(null);
const file = ref<ProjectFile | null>(null);
const fileProblem = ref<string | null>(null);
const fileLoading = ref(false);
const openProblem = ref<string | null>(null);
const query = ref('');

// Move, restore and delete (I-20, D-185): a window asks first; the core refuses links, hidden parts and a running agent.
interface FileAction {
  kind: 'delete' | 'move' | 'restore';
  path: string;
  entry: 'file' | 'dir';
  to: string;
}
const fileAction = ref<FileAction | null>(null);
const actionBusy = ref(false);
const actionProblem = ref<string | null>(null);
const actionNotice = ref<string | null>(null);

function askAction(kind: FileAction['kind'], path: string, entry: FileAction['entry']): void {
  fileAction.value = { kind, path, entry, to: kind === 'restore' ? (restoredPath(path) ?? path) : path };
  actionProblem.value = null;
}

async function runAction(): Promise<void> {
  const action = fileAction.value;
  if (project.value === null || action === null || actionBusy.value) return;
  const name = project.value.name;
  actionBusy.value = true;
  actionProblem.value = null;
  try {
    if (action.kind === 'delete') {
      const done = await deleteProjectPath(name, action.path);
      actionNotice.value = done.kind === 'dir' ? `Cartella ${action.path} eliminata per sempre (${String(done.entries)} elementi).` : `${action.path} eliminato per sempre.`;
    } else {
      const to = action.to.trim();
      await moveProjectPath(name, action.path, to);
      actionNotice.value = action.kind === 'restore' ? `${action.path} rimesso in ${to}.` : `${action.path} spostato in ${to}.`;
    }
    const gone = action.path;
    if (selected.value !== null && (selected.value === gone || selected.value.startsWith(`${gone}/`))) {
      selected.value = null;
      file.value = null;
    }
    fileAction.value = null;
    refreshTree();
  } catch (cause) {
    actionProblem.value = browseErrorText(cause);
  } finally {
    actionBusy.value = false;
  }
}

/** Hidden parts and node_modules are never moved or deleted from the page (the core refuses them too). */
const changeable = (path: string): boolean => !path.split('/').some((part) => part.startsWith('.') || part === 'node_modules');

/** A folder opened from the address (the Studio's "Apri in Progetti"): every folder on the way. */
function openPath(folder: string): void {
  const next = new Set(openFolders.value);
  const parts = folder.split('/');
  for (let at = 1; at <= parts.length; at += 1) {
    const dir = parts.slice(0, at).join('/');
    next.add(dir);
    if (folders.value[dir] === undefined) void loadFolder(dir);
  }
  openFolders.value = next;
}

// Hidden entries (D-135): the consent is the core's, asked here each time it is turned on.
const hiddenOn = computed(() => project.value?.hidden === true);
const hiddenConfirm = ref(false);
const hiddenBusy = ref(false);
const hiddenProblem = ref<string | null>(null);
const revealing = ref(false);
const hiddenCancel = ref<HTMLButtonElement | null>(null);
watch(hiddenConfirm, async (now) => {
  if (!now) return;
  await nextTick();
  hiddenCancel.value?.focus();
});

function toggleHidden(): void {
  hiddenProblem.value = null;
  if (hiddenOn.value) void setHidden(false);
  else hiddenConfirm.value = true;
}

async function setHidden(on: boolean): Promise<void> {
  if (project.value === null) return;
  const name = project.value.name;
  hiddenBusy.value = true;
  try {
    await setProjectHidden(name, on);
    projects.value = (projects.value ?? []).map((item) => (item.name === name ? { ...item, hidden: on } : item));
    if (chosen.value === name) reloadShown(on);
  } catch (cause) {
    hiddenProblem.value = browseErrorText(cause);
  } finally {
    hiddenConfirm.value = false;
    hiddenBusy.value = false;
  }
}

/** After the consent changed: the open folders read again (the hidden ones closed when it is off), the file and the commit too. */
function reloadShown(on: boolean): void {
  const stillOpen = [...openFolders.value].filter((dir) => on || !dir.split('/').some((part) => part.startsWith('.') || part === 'node_modules'));
  folders.value = {};
  openFolders.value = new Set(stillOpen);
  for (const dir of stillOpen) void loadFolder(dir);
  if (selected.value !== null) void showFile(selected.value);
  if (commit.value !== null) void showCommit(commit.value);
}

/** "Mostra" on a covered secret: read once more with reveal; another file covers it again. */
async function reveal(): Promise<void> {
  if (project.value === null || file.value === null) return;
  const path = file.value.path;
  revealing.value = true;
  try {
    const found = await revealProjectFile(project.value.name, path);
    if (selected.value === path) file.value = found;
  } catch (cause) {
    if (selected.value === path) fileProblem.value = browseErrorText(cause);
  } finally {
    revealing.value = false;
  }
}

// Git
const git = ref<ProjectGit | null>(null);
const gitProblem = ref<string | null>(null);
const commit = ref<string | null>(null);
const diff = ref<CommitDiff | null>(null);
const diffProblem = ref<string | null>(null);

// Services (D-134, tappa 2): only what the project declares, each start and stop confirmed here.
const services = ref<ServiceState[] | null>(null);
const servicesProblem = ref<string | null>(null);
const chosenService = ref<string | null>(null);
const log = ref<ServiceLog | null>(null);
const confirming = ref<{ service: ServiceState; stop: boolean } | null>(null);
const acting = ref(false);
let poll: number | undefined;

async function loadServices(): Promise<void> {
  if (project.value === null) return;
  const name = project.value.name;
  try {
    const found = await listProjectServices(name);
    if (chosen.value !== name) return;
    services.value = found;
    servicesProblem.value = null;
    if (chosenService.value === null && found[0] !== undefined) chosenService.value = found.find((item) => item.run !== null)?.id ?? found[0].id;
  } catch (cause) {
    if (chosen.value === name) servicesProblem.value = browseErrorText(cause);
  }
}

async function loadLog(): Promise<void> {
  if (project.value === null || chosenService.value === null) return;
  const id = chosenService.value;
  try {
    const found = await serviceLog(project.value.name, id);
    if (chosenService.value === id) log.value = found;
  } catch {
    // The next tick tries again.
  }
}

async function confirmAction(): Promise<void> {
  if (project.value === null || confirming.value === null) return;
  const { service, stop } = confirming.value;
  acting.value = true;
  try {
    const run = stop ? await stopService(project.value.name, service.id) : await startService(project.value.name, service.id, service.fingerprint);
    chosenService.value = service.id;
    log.value = run;
    confirming.value = null;
    await loadServices();
  } catch (cause) {
    servicesProblem.value = browseErrorText(cause);
    confirming.value = null;
    await loadServices();
  } finally {
    acting.value = false;
  }
}

const serviceGroups = computed(() => {
  const groups = new Map<string, ServiceState[]>();
  for (const service of services.value ?? []) groups.set(service.file, [...(groups.get(service.file) ?? []), service]);
  return [...groups.entries()];
});
const shownService = computed(() => services.value?.find((item) => item.id === chosenService.value) ?? null);
// The dialog takes the focus, so that Esc closes it at once.
const cancelButton = ref<HTMLButtonElement | null>(null);
watch(confirming, async (now) => {
  if (now === null) return;
  await nextTick();
  cancelButton.value?.focus();
});
const confirmation = computed(() => (confirming.value === null ? null : confirmText(confirming.value.service, confirming.value.stop)));

watch(chosenService, () => {
  log.value = null;
  void loadLog();
});
onMounted(() => {
  poll = window.setInterval(() => {
    if (tab.value !== 'svc' || document.hidden) return;
    void loadLog();
    void loadServices();
  }, 2000);
});
onBeforeUnmount(() => {
  window.clearInterval(poll);
});

const currentBranch = computed(() => git.value?.branches.find((branch) => branch.current)?.name ?? null);
const changes = computed(() => git.value?.changes ?? []);

function initials(name: string): string {
  const parts = name.split(/[-_ .]+/).filter((part) => part !== '');
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

/** The tree read again, with the folders open as they are, and the changes of git: files written meanwhile appear. */
function refreshTree(): void {
  // The rows stay while the new listing comes: no flash of "Carico…".
  for (const dir of ['', ...openFolders.value]) void loadFolder(dir, true);
  void loadGit();
  void refreshFile();
}

/** The file open on the right read again, in place: an exported CLAUDE.md shows its new text. */
async function refreshFile(): Promise<void> {
  const path = selected.value;
  if (project.value === null || path === null || file.value === null) return;
  try {
    const found = await readProjectFile(project.value.name, path);
    if (selected.value === path) file.value = found;
  } catch (cause) {
    if (selected.value === path) fileProblem.value = browseErrorText(cause);
  }
}

async function loadFolder(dir: string, keep = false): Promise<void> {
  if (project.value === null) return;
  const name = project.value.name;
  if (!keep || folders.value[dir] === undefined) folders.value = { ...folders.value, [dir]: 'loading' };
  try {
    const listing = await listProjectDir(name, dir);
    if (chosen.value === name) folders.value = { ...folders.value, [dir]: listing };
  } catch (cause) {
    if (chosen.value === name) folders.value = { ...folders.value, [dir]: browseErrorText(cause) };
  }
}

function toggleFolder(dir: string): void {
  const next = new Set(openFolders.value);
  if (next.has(dir)) next.delete(dir);
  else {
    next.add(dir);
    if (folders.value[dir] === undefined) void loadFolder(dir);
  }
  openFolders.value = next;
}

async function showFile(path: string): Promise<void> {
  if (project.value === null) return;
  selected.value = path;
  file.value = null;
  fileProblem.value = null;
  openProblem.value = null;
  fileLoading.value = true;
  try {
    const found = await readProjectFile(project.value.name, path);
    if (selected.value === path) file.value = found;
  } catch (cause) {
    if (selected.value === path) fileProblem.value = browseErrorText(cause);
  } finally {
    fileLoading.value = false;
  }
}

/** "Apri" (D-117, tappa 3): the tab opened at the click, then pointed at the link of the core. */
async function openInBrowser(): Promise<void> {
  if (project.value === null || file.value === null) return;
  openProblem.value = null;
  const tabWindow = window.open('about:blank', '_blank');
  if (tabWindow !== null) tabWindow.opener = null;
  try {
    const url = await openProjectFile(project.value.name, file.value.path);
    if (tabWindow === null) openProblem.value = 'Il browser ha bloccato la scheda nuova: consenti i popup per questa pagina e premi di nuovo "Apri".';
    else tabWindow.location.href = url;
  } catch (cause) {
    tabWindow?.close();
    openProblem.value = browseErrorText(cause);
  }
}

async function loadGit(): Promise<void> {
  if (project.value === null) return;
  const name = project.value.name;
  gitProblem.value = null;
  try {
    const found = await readProjectGit(name);
    if (chosen.value !== name) return;
    git.value = found;
    const first = found.log[0];
    if (commit.value === null && first !== undefined) void showCommit(first.id);
  } catch (cause) {
    if (chosen.value === name) gitProblem.value = browseErrorText(cause);
  }
}

async function showCommit(id: string): Promise<void> {
  if (project.value === null) return;
  commit.value = id;
  diff.value = null;
  diffProblem.value = null;
  try {
    const found = await readCommitDiff(project.value.name, id);
    if (commit.value === id) diff.value = found;
  } catch (cause) {
    if (commit.value === id) diffProblem.value = browseErrorText(cause);
  }
}

function choose(name: string): void {
  switcherOpen.value = false;
  if (chosen.value === name) return;
  chosen.value = name;
  folders.value = {};
  openFolders.value = new Set(['']);
  selected.value = null;
  file.value = null;
  fileProblem.value = null;
  git.value = null;
  commit.value = null;
  diff.value = null;
  services.value = null;
  chosenService.value = null;
  log.value = null;
  servicesProblem.value = null;
  void loadFolder('');
  void loadGit();
  // The services too: the number at the top says how many are on (D-191).
  void loadServices();
}

/** A part of the container: from a tab of the whole project back to its files. */
function choosePart(name: string): void {
  if (!isPartTab(tab.value)) tab.value = 'file';
  choose(name);
}

/** A container: its first part opened in File, or "Conoscenza" when it has no part (D-145). */
function chooseContainer(name: string): void {
  switcherOpen.value = false;
  if (chosenContainer.value === name) return;
  chosenContainer.value = name;
  chosen.value = null;
  const first = parts.value[0];
  if (first === undefined) {
    if (isPartTab(tab.value)) tab.value = 'know';
  } else {
    if (tab.value === 'know') tab.value = 'file';
    choose(first.name);
  }
}

/** The invoice to open in the IM tab, from the address (D-190); null after it. */
const amendInvoice = ref<string | null>(null);

onMounted(() => {
  void loadProjects();
});

/** The approved projects; "Riprova" reads them again. */
async function loadProjects(): Promise<void> {
  problem.value = null;
  try {
    const found = await listBrowsableProjects();
    projects.value = found.projects;
    containers.value = found.containers;
    applyAddress();
    if (chosenContainer.value === null) void loadCards(found.containers);
  } catch (cause) {
    problem.value = browseErrorText(cause);
  }
}

/**
 * The project the address names: none is the grid of cards; a project (from
 * the page of its client, D-168) or a part of one, with a folder (from the
 * Studio, D-185), or an invoice (from the dashboard of its client, D-190).
 */
function applyAddress(): void {
  const found = containers.value;
  if (found === null) return;
  amendInvoice.value = null;
  const named = projectFromSearch(window.location.search);
  const part = (projects.value ?? []).find((item) => item.name === named);
  const first = found.find((item) => item.name === (part?.project ?? named));
  switcherOpen.value = false;
  if (first === undefined) {
    chosenContainer.value = null;
    chosen.value = null;
    return;
  }
  chooseContainer(first.name);
  if (part !== undefined && chosen.value !== part.name) choosePart(part.name);
  // An invoice: the IM tab, its "Totale e scadenza…" open.
  const invoice = invoiceFromSearch(window.location.search);
  if (invoice !== undefined) {
    amendInvoice.value = invoice;
    tab.value = 'im';
  }
  const folder = folderFromSearch(window.location.search);
  if (folder !== undefined && part !== undefined && chosen.value === part.name) {
    tab.value = 'file';
    openPath(folder);
  }
}

// Opened again from outside (a link from Clienti or the Studio, "back"): the address says what to show.
watch(
  () => props.visit,
  () => {
    // A first reading that failed is tried again at the next opening.
    if (containers.value === null) {
      void loadProjects();
      return;
    }
    applyAddress();
    if (chosenContainer.value === null) void loadCards(containers.value);
  },
);

/** A card, the switcher, "‹ Progetti": the address follows, so "back" and a reload find the same view. */
function go(name: string | null): void {
  const path = projectsPathFor(name ?? undefined);
  if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, '', path);
  if (name === null) {
    switcherOpen.value = false;
    amendInvoice.value = null;
    chosenContainer.value = null;
    chosen.value = null;
    if (containers.value !== null) void loadCards(containers.value);
  } else chooseContainer(name);
}

// The grid of cards (D-191, as the clients of D-190): client, parts, calendar, next IM and three numbers per project.
const thisYear = new Date().getFullYear();
const cardIm = ref(new Map<string, ProjectCardIm>());
const cardFailed = ref(new Set<string>());
const cardClients = ref(new Map<string, { id: string; displayName: string; logo: ClientLogo | null }>());
let cardsRead = 0;
async function loadCards(list: readonly BrowsableContainer[]): Promise<void> {
  const request = ++cardsRead;
  const today = todayInput();
  void listClients()
    .then((found) => {
      if (request !== cardsRead) return;
      const owners = new Map<string, { id: string; displayName: string; logo: ClientLogo | null }>();
      for (const item of found.clients) for (const name of item.projects) owners.set(name, { id: item.id, displayName: item.displayName, logo: item.logo });
      cardClients.value = owners;
    })
    .catch(() => {
      // Without the clients the cards show the project's letters.
    });
  // One read per card; a newer round (the page opened again) wins over a slower one.
  await Promise.all(
    list.map(async (item) => {
      try {
        const overview = await readImOverview(item.name);
        if (request !== cardsRead) return;
        cardIm.value = new Map(cardIm.value).set(item.name, projectCardIm(overview, today, thisYear));
        const failed = new Set(cardFailed.value);
        failed.delete(item.name);
        cardFailed.value = failed;
      } catch {
        if (request !== cardsRead || cardIm.value.has(item.name)) return;
        cardFailed.value = new Set(cardFailed.value).add(item.name);
      }
    }),
  );
}
const cards = computed(() => sortProjectCards(containers.value ?? [], new Map([...cardIm.value].map(([name, im]) => [name, im.money?.overdue ?? 0]))));

// The client of the container (D-168): name and logo in the header, a link to its page.
const client = ref<{ id: string; displayName: string; logo: ClientLogo | null } | null>(null);
watch(chosenContainer, async (name) => {
  client.value = null;
  if (name === null) return;
  try {
    const found = await clientOfProject(name);
    if (chosenContainer.value === name) client.value = found;
  } catch {
    // Without the client the header is as before.
  }
});

/**
 * The IM of the container for the number "Prossimo IM" of the header (D-191):
 * one read more when a project opens, with the route of the tab IM; the tab
 * sends its own overview after every change. Prices stay between page and core.
 */
const imOverview = ref<ImOverview | null>(null);
/** The tab sent a newer overview: the first read of the header, if slower, does not cover it. */
let imFromTab = false;
function tabOverview(next: ImOverview): void {
  imFromTab = true;
  imOverview.value = next;
}
watch(chosenContainer, async (name) => {
  imOverview.value = null;
  imFromTab = false;
  if (name === null) return;
  try {
    const found = await readImOverview(name);
    if (chosenContainer.value === name && !imFromTab) imOverview.value = found;
  } catch {
    // Without it the number says "—"; the tab IM tells why.
  }
});
const nextMeeting = computed(() => (imOverview.value === null ? null : nextIm(imOverview.value.ims)));
const overdueCount = computed(() => (imOverview.value === null ? 0 : overdueInvoices(imOverview.value.invoices, todayInput()).length));
const lastCommit = computed(() => git.value?.log[0] ?? null);
const servicesOn = computed(() => (services.value ?? []).filter((item) => item.on));

watch(tab, (now) => {
  // Back on File from another tab: files written meanwhile (an export, a run) appear without a click.
  if (now === 'file' && folders.value[''] !== undefined) refreshTree();
  if (now === 'git') void loadGit();
  if (now === 'svc') void loadServices();
});

/** The rows of the tree as they are open now: depth, path and entry. */
const rows = computed(() => {
  const out: { depth: number; path: string; entry: TreeEntry }[] = [];
  const needle = query.value.trim().toLowerCase();
  const walk = (dir: string, depth: number): void => {
    const listing = folders.value[dir];
    if (listing === undefined || typeof listing === 'string') return;
    for (const entry of listing.entries) {
      const path = childPath(dir, entry.name);
      const isOpenDir = entry.kind === 'dir' && entry.shut === undefined && openFolders.value.has(path);
      if (needle === '' || entry.name.toLowerCase().includes(needle) || isOpenDir) out.push({ depth, path, entry });
      if (isOpenDir) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return out;
});

const fileLines = computed(() => {
  if (file.value === null) return [];
  const extension = extensionOf(file.value.path);
  const text = file.value.text.endsWith('\n') ? file.value.text.slice(0, -1) : file.value.text;
  return text.split('\n').map((line) => highlightLine(line, extension));
});
const changedHere = computed(() => (selected.value === null ? undefined : changeMark(changes.value, selected.value, 'file')));
const tokenClass = { plain: '', keyword: 'text-[#8a4fc4] dark:text-[#c49cf0]', string: 'text-ok', number: 'text-warn', comment: 'italic text-muted' } as const;
const rowClass = { added: 'bg-ok/10', removed: 'bg-danger/10', context: '', gap: 'text-muted' } as const;
const signOf = { added: '+', removed: '−', context: ' ', gap: '⋯' } as const;
const badgeClass: Record<string, string> = {
  vue: 'bg-[#5fbf8f]',
  ts: 'bg-[#6aa0e0]',
  tsx: 'bg-[#6aa0e0]',
  js: 'bg-[#d8c25a]',
  json: 'bg-[#d8b45a]',
  md: 'bg-[#9aa8a6]',
  yml: 'bg-[#c98ad6]',
  toml: 'bg-[#c98ad6]',
  html: 'bg-[#e08a5f]',
  css: 'bg-[#7f9be0]',
  img: 'bg-[#7fc6c0]',
};
const commitShown = computed(() => git.value?.log.find((item) => item.id === commit.value) ?? null);
const diffTotal = (item: CommitDiff['files'][number]): string => ('hunks' in item ? `+${String(item.added)} −${String(item.removed)}` : '');
</script>

<template>
  <!-- One width with Finanze and Clienti (D-189, D-190, D-191). -->
  <section class="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 md:px-6" aria-label="Progetti">
    <div class="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-4">
    <div v-if="problem" class="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">
      <span class="text-danger"><Icon name="warning" :size="15" /></span>
      <span class="min-w-0 flex-1">Non riesco a leggere i progetti: {{ problem }}</span>
      <button type="button" class="btn px-2.5 py-1 text-xs" @click="loadProjects"><Icon name="retry" :size="13" />Riprova</button>
    </div>
    <p v-else-if="containers === null" class="text-sm text-muted">Carico i progetti…</p>
    <div v-else-if="containers.length === 0" class="flex max-w-xl flex-col items-start gap-2 rounded-2xl border border-line bg-surface-2 p-4">
      <p class="text-[14.5px]">Nessun progetto approvato. Un progetto è una cartella sul Mac che Arianna e il Coder possono leggere, per esempio <span class="font-mono text-[13px]">repos/progetto-test</span>.</p>
      <span class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-primary px-3 py-1 text-[14px]" @click="emit('settings', 'progetti')"><Icon name="new" :size="14" />Aggiungi un progetto</button>
        <span class="text-[13px] text-muted">apre Impostazioni → Progetti</span>
      </span>
    </div>

    <!-- THE GRID (D-191, as the clients of D-190): each approved project a card -->
    <template v-else-if="chosenContainer === null">
      <p class="text-[13px] text-muted">{{ containers.length === 1 ? '1 progetto' : `${String(containers.length)} progetti` }} · numeri del {{ thisYear }}</p>
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5">
        <li v-for="item in cards" :key="item.name" class="flex" :class="isAriannaProject(item.name) ? 'col-span-full' : ''">
          <button
            type="button"
            class="flex w-full flex-col gap-3 rounded-2xl border p-4 text-left transition-colors hover:border-accent"
            :class="[
              isAriannaProject(item.name) ? 'border-accent bg-accent/10' : 'border-line bg-surface-2',
              (cardIm.get(item.name)?.money?.overdue ?? 0) > 0 ? 'shadow-[inset_3px_0_0_var(--danger)]' : '',
            ]"
            @click="go(item.name)"
          >
            <span v-for="owner in [cardClients.get(item.name) ?? null]" :key="owner?.id ?? 'none'" class="flex items-center gap-3">
              <img v-if="owner && logoUrl(owner.id, owner.logo)" :src="logoUrl(owner.id, owner.logo) ?? undefined" alt="" class="size-[52px] shrink-0 rounded-xl border border-line bg-white object-contain p-0.5" />
              <span v-else class="grid size-[52px] shrink-0 place-items-center rounded-xl border border-accent/40 bg-accent/15 text-[17px] font-semibold text-accent" aria-hidden="true">{{ projectInitials(item.name) }}</span>
              <span class="min-w-0">
                <b class="flex items-center gap-2 truncate text-[16px] leading-snug font-semibold"
                  >{{ item.name }}<span v-if="isAriannaProject(item.name)" class="rounded-full border border-accent/50 px-2 py-px text-[12px] font-semibold text-accent">Arianna stessa</span></b
                >
                <span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted">
                  <template v-if="owner">{{ owner.displayName }}</template><template v-else>Nessun cliente</template>
                  <template v-if="partsText(item)"> · {{ partsText(item) }}</template>
                </span>
              </span>
            </span>
            <span v-for="im in [cardIm.get(item.name) ?? null]" :key="item.name + '-im'" class="flex min-h-[42px] flex-col text-[14px]">
              <template v-if="im">
                <span class="truncate">{{ im.calendar ?? 'Nessun calendario degli IM' }}</span>
                <span class="truncate text-[13px] text-muted">{{ im.next ? `Prossimo: ${im.next}` : 'Nessun IM aperto' }}</span>
              </template>
              <span v-else class="truncate font-mono text-[12.5px] text-muted" :title="item.absolute">{{ item.absolute }}</span>
            </span>
            <span v-for="im in [cardIm.get(item.name) ?? null]" :key="item.name + '-money'" class="mt-auto border-t border-line pt-3">
              <span v-if="im === null && cardFailed.has(item.name)" class="text-[13px] text-warn">Numeri non disponibili: apri il progetto e guarda la scheda IM.</span>
              <span v-else-if="im === null" class="text-[13px] text-muted">Leggo…</span>
              <span v-else-if="im.money === null" class="text-[13px] text-muted">Nessun IM: i numeri compaiono con il primo IM chiuso, dalla scheda IM.</span>
              <span v-else class="grid grid-cols-3 gap-2">
                <span class="flex min-w-0 flex-col"><span class="text-xs text-muted">Da fatturare</span><b class="truncate text-[17px] tabular-nums">{{ cardMoneyText(im.money.toInvoice, im.money.currency) }}</b></span>
                <span class="flex min-w-0 flex-col">
                  <span class="text-xs text-muted">In attesa</span>
                  <b class="truncate text-[17px] tabular-nums" :class="im.money.overdue > 0 ? 'text-danger' : ''">{{ cardMoneyText(im.money.awaiting, im.money.currency) }}</b>
                  <span v-if="im.money.overdue > 0" class="text-xs text-danger">{{ overdueShortText(im.money.overdue) }}</span>
                </span>
                <span class="flex min-w-0 flex-col"><span class="text-xs text-muted">Incassato {{ thisYear }}</span><b class="truncate text-[17px] tabular-nums">{{ cardMoneyText(im.money.paid, im.money.currency) }}</b></span>
              </span>
            </span>
          </button>
        </li>
        <li class="flex">
          <button type="button" class="grid min-h-[200px] w-full place-items-center rounded-2xl border border-dashed border-line-strong text-[15px] font-semibold text-muted hover:border-accent hover:text-accent" title="Apre Impostazioni → Progetti" @click="emit('settings', 'progetti')">
            <span class="flex items-center gap-2"><Icon name="new" :size="16" />Aggiungi un progetto</span>
          </button>
        </li>
      </ul>
      <p class="mt-auto inline-flex items-center gap-1.5 text-xs text-muted"><Icon name="private" :size="13" />Prezzi e fatture restano su questo computer.</p>
    </template>

    <template v-else-if="container">
      <!-- Masthead: which project, whose, where (D-191); the buttons stay on the row of the name, the path shortens -->
      <header class="flex flex-wrap items-center gap-x-4 gap-y-3 md:flex-nowrap">
        <button type="button" class="btn shrink-0 px-2.5 py-1 text-xs whitespace-nowrap" title="Torna a tutti i progetti" @click="go(null)"><span class="rotate-180"><Icon name="expand" :size="13" /></span>Progetti</button>
        <div class="grid size-12 shrink-0 place-items-center rounded-xl border border-accent/40 bg-accent/15 text-[16px] font-semibold text-accent" aria-hidden="true">{{ initials(container.name) }}</div>
        <div class="min-w-0 flex-1 basis-[220px]">
          <div class="relative">
            <button
              type="button"
              class="flex max-w-full items-center gap-2 text-[22px] leading-tight font-semibold"
              :aria-expanded="switcherOpen"
              aria-haspopup="listbox"
              title="Cambia progetto"
              @click="switcherOpen = !switcherOpen"
            >
              <span class="truncate">{{ container.name }}</span><span class="shrink-0 rotate-90 text-muted"><Icon name="expand" :size="15" /></span>
            </button>
            <div v-if="switcherOpen" class="absolute top-full left-0 z-20 mt-1.5 max-w-[calc(100vw-32px)] min-w-[280px] rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_14px_40px_#0006]" role="listbox">
              <button
                v-for="item in containers"
                :key="item.name"
                type="button"
                role="option"
                :aria-selected="item.name === container.name"
                class="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-accent/15"
                :class="item.name === container.name ? 'bg-accent/15' : ''"
                @click="go(item.name)"
              >
                <span class="block text-[14.5px]">{{ item.name }}<span v-if="!item.single" class="text-muted"> · {{ item.parts.length === 1 ? '1 parte' : `${String(item.parts.length)} parti` }}</span></span>
                <span class="block truncate font-mono text-[12.5px] text-muted">{{ item.absolute }}</span>
              </button>
              <p class="mt-1 border-t border-line px-2.5 pt-2 pb-1 text-[13px] text-muted">Altri progetti si approvano in Impostazioni → Progetti.</p>
            </div>
          </div>
          <p class="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13.5px] text-muted">
            <button v-if="client" type="button" class="inline-flex items-center gap-1.5 font-medium text-ink hover:text-accent" title="Apri la scheda del cliente" @click="emit('client', client.id)">
              <img v-if="client.logo" :src="logoUrl(client.id, client.logo) ?? ''" alt="" class="size-6 rounded-md border border-line bg-white object-contain" />
              <span v-else class="grid size-6 place-items-center rounded-md bg-accent/15 text-[12px] font-semibold text-accent">{{ initialsOf(client.displayName) }}</span>
              {{ client.displayName }} ›
            </button>
            <span v-if="!container.single">{{ parts.length === 1 ? '1 parte' : `${String(parts.length)} parti` }}</span>
            <span v-if="imOverview?.calendar.calendar">IM {{ calendarText(imOverview.calendar.calendar) }}</span>
          </p>
          <p class="mt-0.5 truncate font-mono text-[13px] text-muted" :title="isPartTab(tab) && project ? project.absolute : container.absolute">{{ isPartTab(tab) && project ? project.absolute : container.absolute }}</p>
        </div>
        <div class="flex shrink-0 gap-1.5 max-md:w-full max-md:flex-wrap">
          <a :href="vscodeUrl(project?.absolute ?? container.absolute)" class="btn inline-flex items-center gap-1.5 px-3 py-1.5 text-[14px] whitespace-nowrap" :title="project ? 'Apre la cartella di questa parte in Visual Studio Code' : 'Apre la cartella del progetto in Visual Studio Code'">
            <Icon name="code" :size="14" />Apri in VS Code
          </a>
          <button v-if="project" type="button" class="btn inline-flex items-center gap-1.5 px-3 py-1.5 text-[14px] whitespace-nowrap" title="I mockup di questa parte nello Studio di design, con la chat del Designer" @click="emit('studio', project.name)">
            <Icon name="studio" :size="14" />Apri nello Studio
          </button>
        </div>
      </header>

      <!-- Four numbers, as in Finanze: each opens its tab (D-191) -->
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <button type="button" class="hud-card flex flex-col gap-1 px-4 py-3 text-left hover:border-accent disabled:cursor-default disabled:hover:border-line-strong" :disabled="project === null" @click="tab = 'git'">
          <span class="hud-title flex w-full justify-between gap-2">Branch<span v-if="project" class="truncate font-sans text-[13px] font-normal tracking-normal normal-case">{{ partTitle(project) }}</span></span>
          <span class="flex items-center gap-2 font-mono text-[18px] leading-tight"><Icon name="branch" :size="16" />{{ project === null ? '—' : (currentBranch ?? (git?.repository === false ? 'niente git' : '…')) }}</span>
          <span class="text-[13px] text-muted">{{ project === null ? 'nessuna parte con git' : lastCommit ? `ultimo commit ${agoText(lastCommit.at)}` : git?.repository === false ? 'la cartella non è un repository' : 'nessun commit' }}</span>
        </button>
        <button type="button" class="hud-card flex flex-col gap-1 px-4 py-3 text-left hover:border-accent disabled:cursor-default disabled:hover:border-line-strong" :class="changes.length > 0 ? 'warn' : ''" :disabled="project === null" @click="tab = 'git'">
          <span class="hud-title flex w-full justify-between gap-2">Modifiche<span v-if="project" class="truncate font-sans text-[13px] font-normal tracking-normal normal-case">{{ partTitle(project) }}</span></span>
          <span class="text-[22px] leading-tight font-semibold" :class="changes.length > 0 ? 'text-warn' : ''">{{ project === null || git === null ? '—' : changes.length === 1 ? '1 file' : `${String(changes.length)} file` }}</span>
          <span class="text-[13px] text-muted">{{ project === null ? 'nessuna parte con git' : changes.length > 0 ? 'non ancora in un commit · Git ›' : 'tutto in un commit · Git ›' }}</span>
        </button>
        <button type="button" class="hud-card flex flex-col gap-1 px-4 py-3 text-left hover:border-accent disabled:cursor-default disabled:hover:border-line-strong" :disabled="project === null" @click="tab = 'svc'">
          <span class="hud-title flex w-full justify-between gap-2">Servizi<span v-if="project" class="truncate font-sans text-[13px] font-normal tracking-normal normal-case">{{ partTitle(project) }}</span></span>
          <span class="flex items-center gap-2 text-[22px] leading-tight font-semibold">
            <span v-if="services !== null && services.length > 0" class="size-2.5 rounded-full" :class="servicesOn.length > 0 ? 'bg-ok' : 'bg-muted/50'" aria-hidden="true"></span>
            {{ project === null || services === null ? '—' : services.length === 0 ? 'nessuno' : `${String(servicesOn.length)} ${servicesOn.length === 1 ? 'acceso' : 'accesi'} su ${String(services.length)}` }}
          </span>
          <span class="text-[13px] text-muted">
            {{ project === null ? 'nessuna parte con git' : services === null ? (servicesProblem ? 'non letti · Servizi ›' : 'leggo i servizi…') : servicesOn[0] ? `${servicesOn[0].name}${servicesOn[0].ports[0] !== undefined ? ` su :${String(servicesOn[0].ports[0])}` : ''} · Servizi ›` : services.length === 0 ? 'la parte non dichiara servizi' : 'nessuno acceso · Servizi ›' }}
          </span>
        </button>
        <button type="button" class="hud-card flex flex-col gap-1 px-4 py-3 text-left hover:border-accent" :class="overdueCount > 0 ? 'danger' : ''" @click="tab = 'im'">
          <span class="hud-title">Prossimo IM</span>
          <span class="text-[22px] leading-tight font-semibold">{{ nextMeeting ? imDayText(nextMeeting.date) : '—' }}</span>
          <span class="text-[13px] text-muted">
            <template v-if="nextMeeting">IM-{{ nextMeeting.number }} · </template><template v-else-if="imOverview">nessun IM aperto · </template><span v-if="overdueCount > 0" class="text-danger">{{ overdueText(overdueCount) }} · </span>IM ›
          </span>
        </button>
      </div>

      <!-- The tabs in one row (D-191, after the trial): File, Git and Servizi read the part chosen, the others the whole project -->
      <nav class="flex flex-wrap items-end gap-0.5 border-b border-line" aria-label="Schede del progetto">
        <button
          v-for="item in PROJECT_TABS.filter((entry) => project !== null || !isPartTab(entry.id))"
          :key="item.id"
          type="button"
          :aria-current="tab === item.id ? 'true' : undefined"
          class="-mb-px border-b-2 px-3 pt-2 pb-2.5 text-[14.5px]"
          :class="tab === item.id ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'"
          @click="tab = item.id"
        >
          {{ item.text }}
        </button>
        <span v-if="tab === 'svc'" class="ml-auto hidden items-center gap-1.5 pb-2.5 text-[13px] text-muted lg:flex"><Icon name="play" :size="13" />Avvia e ferma con la tua conferma, ogni volta</span>
        <span v-else-if="tab === 'im'" class="ml-auto hidden items-center gap-1.5 pb-2.5 text-[13px] text-muted lg:flex"><Icon name="private" :size="13" />Prezzi e fatture restano su questo computer</span>
        <span v-else-if="tab === 'rules'" class="ml-auto hidden items-center gap-1.5 pb-2.5 text-[13px] text-muted lg:flex"><Icon name="gateway" :size="13" />Vanno a Claude e Codex come Interno</span>
        <span v-else-if="tab === 'know'" class="ml-auto hidden items-center gap-1.5 pb-2.5 text-[13px] text-muted lg:flex"><Icon name="private" :size="13" />Solo su questo computer: il Coder non vede queste cartelle</span>
        <span v-else class="ml-auto hidden items-center gap-1.5 pb-2.5 text-[13px] text-muted lg:flex"><Icon name="private" :size="13" />Sola lettura: niente checkout né commit da qui</span>
      </nav>

      <!-- The parts of the container (D-145): only in File, Git and Servizi -->
      <div v-if="!container.single && parts.length === 0" class="flex max-w-2xl items-center gap-2.5 rounded-xl border border-info/45 bg-info/9 px-3 py-2 text-[14px]">
        <span class="text-info"><Icon name="info" :size="15" /></span>
        <span>Nessuna sottocartella con un proprio git: il Coder non ha dove lavorare. File, Git e Servizi compaiono quando una parte ha il suo git.</span>
      </div>
      <div v-else-if="!container.single && isPartTab(tab)" class="-mt-1 flex flex-wrap items-center gap-1.5" role="group" aria-label="Parti del progetto">
        <span class="mr-1 text-[13px] text-muted">Parte</span>
        <button
          v-for="item in parts"
          :key="item.name"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[14px]"
          :class="partPressed(tab, item.name, chosen) ? 'border-accent bg-accent/14 font-semibold text-ink' : 'border-line-strong bg-surface-2 text-ink hover:border-accent'"
          :aria-pressed="partPressed(tab, item.name, chosen)"
          @click="choosePart(item.name)"
        >
          {{ partTitle(item) }}
          <span v-if="item.name === chosen && git !== null" class="text-[12px] font-normal text-muted">{{ git.repository ? `${currentBranch ?? '?'} · ${changes.length === 0 ? 'pulito' : changes.length === 1 ? '1 modifica' : `${String(changes.length)} modifiche`}` : 'niente git' }}</span>
        </button>
      </div>

      <!-- CONOSCENZA (D-145): the management folders of the container and their notes -->
      <ProjectKnowledgeTab v-if="tab === 'know'" :container="container" @conversation="(id) => emit('conversation', id)" />
      <!-- IM (D-167, P4d): calendar, price, every IM with its money, the invoices -->
      <ProjectImTab v-else-if="tab === 'im'" :container="container" :amend="amendInvoice" @changed="tabOverview" @cardwall="emit('cardwall')" @amended="amendInvoice = null" />
      <!-- REGOLE (I-14, D-174): the rules at the head of every delegation on the project -->
      <ProjectRulesTab v-else-if="tab === 'rules'" :container="container" @exported="refreshTree" @settings="emit('settings', $event)" />

      <template v-else-if="project">
      <div v-if="tab === 'file' && actionNotice !== null" class="flex flex-wrap items-center gap-2.5 rounded-xl border border-ok/45 bg-ok/9 px-3 py-2 text-[14px]" role="status">
        <span class="text-ok"><Icon name="saved" :size="15" /></span>
        <span class="min-w-0 flex-1 break-words">{{ actionNotice }}</span>
        <button type="button" class="btn px-2 py-0.5 text-xs" @click="actionNotice = null">Chiudi</button>
      </div>
      <!-- FILE: the tree and the file, one split pane -->
      <div v-if="tab === 'file'" class="grid min-h-[520px] flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-line bg-surface-2 md:grid-cols-[290px_minmax(0,1fr)]">
        <div class="flex min-h-0 flex-col border-b border-line md:border-r md:border-b-0">
          <label class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 text-muted">
            <Icon name="search" :size="14" />
            <input v-model="query" type="search" placeholder="Cerca fra le cartelle aperte" aria-label="Cerca un file" class="w-full bg-transparent text-[14px] text-ink" />
            <button type="button" class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] text-muted transition hover:text-ink" title="Rilegge l’elenco dei file" @click.prevent="refreshTree"><Icon name="retry" :size="12" />Aggiorna</button>
          </label>
          <!-- The tree in the normal font (D-191); the path of the open file and the code stay fixed-width. -->
          <div class="min-h-0 flex-1 overflow-auto p-1.5 text-[14px] max-md:max-h-80">
            <p v-if="folders[''] === 'loading'" class="px-2 py-1 text-muted">Carico…</p>
            <div v-else-if="typeof folders[''] === 'string'" class="m-1 flex flex-col items-start gap-2 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">
              <span>{{ folders[''] }}</span>
              <button type="button" class="btn px-2.5 py-1 text-xs" @click="refreshTree"><Icon name="retry" :size="13" />Riprova</button>
            </div>
            <template v-for="row in rows" :key="row.path">
              <div
                v-if="row.entry.shut"
                class="flex h-[30px] items-center gap-[7px] rounded-[7px] px-2 text-muted"
                :style="{ paddingLeft: `${String(8 + row.depth * 14)}px` }"
                :title="SHUT_TEXT[row.entry.shut]"
              >
                <span class="w-3"></span>{{ row.entry.name }}<span class="ml-auto"><Icon name="private" :size="12" /></span>
              </div>
              <div v-else class="group relative">
              <button
                type="button"
                class="flex h-[30px] w-full items-center gap-[7px] rounded-[7px] px-2 text-left whitespace-nowrap hover:bg-bg"
                :class="row.path === selected ? 'bg-accent/14 shadow-[inset_2px_0_0_var(--color-accent)]' : ''"
                :style="{ paddingLeft: `${String(8 + row.depth * 14)}px` }"
                :aria-expanded="row.entry.kind === 'dir' ? openFolders.has(row.path) : undefined"
                @click="row.entry.kind === 'dir' ? toggleFolder(row.path) : showFile(row.path)"
              >
                <span class="w-3 text-[12px] text-muted">{{ row.entry.kind === 'dir' ? (openFolders.has(row.path) ? '▾' : '▸') : '' }}</span>
                <!-- A small coloured square for the kind of file (D-191), instead of a tag written at 7.5 px; the kind in the title. -->
                <span
                  v-if="row.entry.kind === 'file' && fileBadge(row.entry.name).text"
                  class="size-2.5 shrink-0 rounded-[3px]"
                  :class="badgeClass[fileBadge(row.entry.name).tone] ?? 'bg-muted'"
                  :title="fileBadge(row.entry.name).text"
                  aria-hidden="true"
                ></span>
                <span
                  class="truncate"
                  :class="changeMark(changes, row.path, row.entry.kind) === 'M' ? 'text-warn' : changeMark(changes, row.path, row.entry.kind) === 'A' ? 'text-ok' : ''"
                  >{{ row.entry.name }}</span
                >
                <span v-if="row.entry.secret" class="ml-auto pl-2 text-warn" title="Può contenere un segreto: il testo arriva coperto"><Icon name="private" :size="12" /></span>
                <span v-if="changeMark(changes, row.path, row.entry.kind)" class="pl-2 text-[12px] font-semibold" :class="[row.entry.secret ? '' : 'ml-auto', changeMark(changes, row.path, row.entry.kind) === 'M' ? 'text-warn' : 'text-ok']">{{
                  changeMark(changes, row.path, row.entry.kind)
                }}</span>
              </button>
              <!-- Move, restore and delete (D-185): on hover or keyboard focus, each one asks in a window. -->
              <span v-if="changeable(row.path)" class="absolute inset-y-0 right-1 hidden items-center gap-0.5 rounded-md bg-surface-2 pl-1 group-focus-within:flex group-hover:flex">
                <button v-if="restoredPath(row.path)" type="button" class="grid size-6 place-items-center rounded text-muted hover:text-ink" :aria-label="`Ripristina ${row.path}`" title="Ripristina: lo rimette nella cartella sopra eliminati/" @click="askAction('restore', row.path, row.entry.kind)"><Icon name="restore" :size="12" /></button>
                <button type="button" class="grid size-6 place-items-center rounded text-muted hover:text-ink" :aria-label="`Sposta o rinomina ${row.path}`" title="Sposta o rinomina" @click="askAction('move', row.path, row.entry.kind)"><Icon name="rename" :size="12" /></button>
                <button type="button" class="grid size-6 place-items-center rounded text-muted hover:text-danger" :aria-label="`Elimina ${row.path}`" title="Elimina per sempre" @click="askAction('delete', row.path, row.entry.kind)"><Icon name="delete" :size="12" /></button>
              </span>
              </div>
              <p v-if="row.entry.kind === 'dir' && openFolders.has(row.path) && folders[row.path] === 'loading'" class="px-2 text-muted" :style="{ paddingLeft: `${String(30 + row.depth * 14)}px` }">…</p>
            </template>
          </div>
          <div class="shrink-0 border-t border-line px-3 py-2.5 text-[13px] text-muted">
            <button
              type="button"
              role="switch"
              :aria-checked="hiddenOn"
              class="mb-2 flex w-full items-center gap-2 rounded-md text-left text-[13.5px] text-ink"
              :disabled="hiddenBusy"
              title="File e cartelle col punto, node_modules e .git, col tuo consenso"
              @click="toggleHidden"
            >
              <span class="relative h-[18px] w-8 shrink-0 rounded-full border transition-colors" :class="hiddenOn ? 'border-accent bg-accent/70' : 'border-line-strong bg-surface-2'"
                ><span class="absolute top-[2px] size-3 rounded-full bg-ink transition-[left]" :class="hiddenOn ? 'left-[15px]' : 'left-[2px]'"></span
              ></span>
              Mostra nascosti
            </button>
            <p v-if="hiddenProblem" class="mb-1.5 rounded-lg border border-danger/50 bg-danger/10 px-2 py-1 text-ink" role="alert">{{ hiddenProblem }}</p>
            <p class="flex flex-wrap gap-x-3 gap-y-1">
              <span><b class="text-warn">M</b> modificato</span><span><b class="text-ok">A</b> nuovo</span><span class="inline-flex items-center gap-1"><Icon name="private" :size="12" />chiuso</span
              ><span class="inline-flex items-center gap-1"><span class="text-warn"><Icon name="private" :size="12" /></span>segreto</span>
            </p>
          </div>
        </div>
        <div class="flex min-h-0 min-w-0 flex-col">
          <div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3">
            <span class="min-w-0 flex-1 truncate font-mono text-[13.5px]">
              <template v-if="selected"><span class="text-muted">{{ project.name }} / </span>{{ selected }}</template>
              <span v-else class="text-muted">Scegli un file a sinistra</span>
            </span>
            <span v-if="file" class="font-mono text-[12.5px] whitespace-nowrap text-muted">{{ sizeText(file.size) }}<template v-if="!file.covered"> · {{ fileLines.length }} righe</template></span>
            <a v-if="selected && !fileProblem && file?.covered !== true" :href="vscodeUrl(project.absolute, selected)" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs" title="Apre questo file in Visual Studio Code"><Icon name="code" :size="13" />VS Code</a>
            <button v-if="file?.openable" type="button" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs" title="Apre in una scheda nuova, servita dal computer" @click="openInBrowser"><Icon name="external" :size="13" />Apri</button>
          </div>
          <p v-if="openProblem" class="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[13px]" role="alert">{{ openProblem }}</p>
          <div class="min-h-0 flex-1 overflow-auto">
            <p v-if="fileLoading" class="p-4 text-sm text-muted">Carico…</p>
            <div v-else-if="fileProblem" class="grid h-full place-items-center p-8 text-[14px]">
              <div class="flex max-w-sm flex-col items-start gap-2.5 rounded-xl border border-line bg-surface p-4">
                <p class="flex items-start gap-2"><span class="mt-0.5 text-muted"><Icon name="private" :size="16" /></span>{{ fileProblem }}</p>
                <span class="flex flex-wrap gap-1.5">
                  <button v-if="selected" type="button" class="btn px-2.5 py-1 text-xs" @click="showFile(selected)"><Icon name="retry" :size="13" />Riprova</button>
                  <button type="button" class="btn px-2.5 py-1 text-xs" @click="refreshTree">Aggiorna l’elenco</button>
                </span>
              </div>
            </div>
            <div v-else-if="file?.covered" class="grid h-full place-items-center p-8 text-center text-[14px]">
              <div class="grid max-w-md justify-items-center gap-3">
                <span class="text-warn"><Icon name="warning" :size="26" /></span>
                <p>Questo file può contenere un segreto: password, token o chiavi. Il testo è coperto, così non compare sullo schermo per sbaglio.</p>
                <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="revealing" @click="reveal">Mostra</button>
                <p class="text-xs text-muted">Si scopre solo questa volta, e resta traccia nel registro degli eventi. Attenzione a condivisioni dello schermo e screenshot.</p>
              </div>
            </div>
            <pre v-else-if="file" class="m-0 py-3 font-mono text-[13.5px] leading-[1.7]"><span v-for="(line, at) in fileLines" :key="at" class="flex"><span class="w-12 shrink-0 border-r-2 pr-3.5 mr-3.5 text-right text-muted/70 select-none" :class="changedHere === 'A' ? 'border-ok' : 'border-transparent'">{{ at + 1 }}</span><span class="whitespace-pre pr-4"><span v-for="(token, index) in line" :key="index" :class="tokenClass[token.kind]">{{ token.text }}</span></span></span></pre>
          </div>
        </div>
      </div>

      <!-- SERVIZI: the cards by file on the left, the log of the chosen one on the right -->
      <div v-else-if="tab === 'svc'" class="grid flex-1 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)]">
        <div>
          <div v-if="servicesProblem" class="mb-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">
            <span class="min-w-0 flex-1">{{ servicesProblem }}</span>
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="loadServices"><Icon name="retry" :size="13" />Riprova</button>
          </div>
          <p v-if="services === null && !servicesProblem" class="text-sm text-muted">Leggo i servizi…</p>
          <div v-else-if="services !== null && services.length === 0" class="flex max-w-xl flex-col items-start gap-2 rounded-2xl border border-line bg-surface-2 p-4">
            <p class="text-[14.5px]">
              Questa parte non dichiara servizi. Arianna avvia solo comandi scritti nei file: aggiungi uno script a <span class="font-mono text-[13px]">package.json</span> (per esempio <span class="font-mono text-[13px]">"dev": "vite"</span>), un <span class="font-mono text-[13px]">docker-compose.yml</span> o un <span class="font-mono text-[13px]">Makefile</span>.
            </p>
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="loadServices"><Icon name="retry" :size="13" />Rileggi</button>
          </div>
          <div v-for="[fileName, list] in serviceGroups" :key="fileName" class="mb-5">
            <p class="mb-2 flex items-center gap-2"><span class="font-mono text-[13px] font-medium">{{ fileName }}</span><span class="hud-title text-[12px]">{{ list[0]?.source === 'package.json' ? 'script' : list[0]?.source === 'compose' ? 'servizi' : 'obiettivi' }}</span></p>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
              <div
                v-for="service in list"
                :key="service.id"
                class="grid cursor-pointer gap-2 rounded-xl border bg-surface px-3 pt-3 pb-2.5"
                :class="service.id === chosenService ? 'border-accent shadow-[0_0_0_3px_var(--color-glow,transparent)]' : 'border-line hover:border-line-strong'"
                role="button"
                tabindex="0"
                :aria-pressed="service.id === chosenService"
                @click="chosenService = service.id"
                @keydown.enter.self="chosenService = service.id"
              >
                <div class="flex items-center gap-2">
                  <span class="size-2 rounded-full" :class="service.run?.running && !service.on ? 'animate-pulse bg-warn' : service.on ? 'bg-ok' : 'bg-muted/50'"></span>
                  <span class="text-[14px] font-semibold">{{ service.name }}</span>
                  <span class="ml-auto font-mono text-[12.5px]" :class="service.on ? 'text-ok' : 'text-muted'">{{ serviceStateText(service) }}</span>
                </div>
                <span class="truncate rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12.5px] text-muted" :title="service.script ?? service.command.join(' ')">{{ service.script ?? service.command.join(' ') }}</span>
                <div class="flex items-center gap-1.5">
                  <span class="mr-auto font-mono text-[12.5px] text-muted">{{ service.ports.map((item) => `:${String(item)}`).join(' ') }}</span>
                  <a
                    v-if="service.on && service.ports[0] !== undefined && service.source !== 'compose'"
                    :href="`http://127.0.0.1:${String(service.ports[0])}/`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn inline-flex items-center gap-1 px-2 py-0.5 text-xs"
                    @click.stop
                    ><Icon name="external" :size="12" />Apri</a
                  >
                  <button
                    v-if="service.run?.running || (service.on && service.source === 'compose')"
                    type="button"
                    class="btn btn-danger inline-flex items-center gap-1 px-2 py-0.5 text-xs"
                    @click.stop="confirming = { service, stop: true }"
                  >
                    <Icon name="stop" :size="11" />Ferma
                  </button>
                  <button v-else type="button" class="btn inline-flex items-center gap-1 px-2 py-0.5 text-xs" @click.stop="confirming = { service, stop: false }"><Icon name="play" :size="11" />Avvia</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <aside class="overflow-hidden rounded-2xl border border-line bg-[#071013] text-[#cfe3df] lg:sticky lg:top-0" aria-label="Registro">
          <div class="flex items-center gap-2.5 border-b border-white/10 px-3.5 py-2.5 text-[14px]">
            <span class="size-2 rounded-full" :class="log?.running ? 'bg-ok' : 'bg-white/25'"></span>
            <b>{{ shownService?.name ?? 'Registro' }}</b>
            <span class="font-mono text-[12.5px] text-[#8aa3a0]">{{ log ? endedText(log) : shownService ? 'nessun avvio da qui' : '' }}</span>
          </div>
          <pre class="m-0 h-[300px] overflow-auto px-3.5 py-3 font-mono text-[13px] leading-[1.7] whitespace-pre-wrap">{{ log?.lines.join('\n') ?? '' }}</pre>
          <div class="grid gap-1 border-t border-white/10 px-3.5 py-2.5 text-xs text-[#8aa3a0]">
            <span>Si avviano <b class="font-medium text-[#cfe3df]">solo i comandi scritti nei file del progetto</b>, con la tua conferma ogni volta.</span>
            <span>Test e build si fermano da soli dopo <b class="font-medium text-[#cfe3df]">10 minuti</b>; i servizi avviati da qui si fermano alla chiusura di Arianna. Il registro resta sul computer (ultime 2000 righe).</span>
          </div>
        </aside>
      </div>

      <!-- GIT: branches, changes, commits on the left; the diff on the right -->
      <div v-else class="grid min-h-[460px] flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-[340px_minmax(0,1fr)]">
        <div class="flex min-h-0 flex-col overflow-auto border-b border-line md:border-r md:border-b-0">
          <div v-if="gitProblem" class="m-3 flex flex-col items-start gap-2 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]" role="alert">
            <span>{{ gitProblem }}</span>
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="loadGit"><Icon name="retry" :size="13" />Riprova</button>
          </div>
          <p v-else-if="git === null" class="p-3 text-sm text-muted">Leggo git…</p>
          <div v-else-if="!git.repository" class="flex flex-col items-start gap-2 p-4 text-[14px]">
            <p>Questa cartella non è un repository git: non ci sono branch né commit da mostrare. Se vuoi che il Coder ci lavori, apri un terminale nella cartella e scrivi <span class="font-mono text-[13px]">git init</span>.</p>
            <a :href="vscodeUrl(project.absolute)" class="btn px-2.5 py-1 text-xs"><Icon name="code" :size="13" />Apri in VS Code</a>
          </div>
          <template v-else>
            <div class="flex items-center gap-2 px-3.5 pt-3.5 pb-1.5"><span class="hud-title flex-1 text-[12px]">Branch</span></div>
            <ul class="px-2 font-mono text-[13.5px]">
              <li v-for="branch in git.branches" :key="branch.name" class="flex items-center gap-2 rounded-md px-1.5 py-1" :class="branch.current ? 'text-accent' : ''">
                <span aria-hidden="true">{{ branch.current ? '●' : '○' }}</span><span class="min-w-0 flex-1 truncate">{{ branch.name }}</span
                ><span class="text-[12.5px] whitespace-nowrap text-muted">{{ agoText(branch.at) }}</span>
              </li>
            </ul>
            <div class="flex items-center gap-2 px-3.5 pt-4 pb-1.5"><span class="hud-title flex-1 text-[12px]">Non salvato in un commit</span><span class="font-mono text-[12.5px] text-muted">{{ git.changes.length }}</span></div>
            <p v-if="git.changes.length === 0" class="px-3.5 text-xs text-muted">Nessuna modifica.</p>
            <ul class="px-2 font-mono text-[13px]">
              <li v-for="change in git.changes" :key="change.path" class="flex items-center gap-2 px-1.5 py-0.5">
                <b class="w-3.5 text-center" :class="change.change === 'added' ? 'text-ok' : change.change === 'deleted' ? 'text-danger' : 'text-warn'">{{
                  { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[change.change]
                }}</b>
                <span class="min-w-0 truncate" :title="change.from ? `da ${change.from}` : undefined">{{ change.path }}</span>
              </li>
            </ul>
            <div class="px-3.5 pt-4 pb-1.5"><span class="hud-title text-[12px]">Commit</span></div>
            <p v-if="git.log.length === 0" class="px-3.5 pb-3 text-xs text-muted">Ancora nessun commit.</p>
            <ol class="px-2 pb-3">
              <li v-for="(item, at) in git.log" :key="item.id" class="relative">
                <span class="absolute left-[18px] w-0.5 bg-line" :class="[at === 0 ? 'top-[18px]' : 'top-0', at === git.log.length - 1 ? 'h-[18px]' : 'bottom-0']" aria-hidden="true"></span>
                <button type="button" class="relative grid w-full grid-cols-[22px_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-2 text-left hover:bg-surface-2" :class="item.id === commit ? 'bg-accent/15' : ''" @click="showCommit(item.id)">
                  <span class="mt-[5px] ml-[5px] size-2.5 rounded-full border-2" :class="[item.parents.length > 1 ? 'border-info' : 'border-accent', item.id === commit ? 'bg-accent' : 'bg-surface']" aria-hidden="true"></span>
                  <span class="truncate text-[14px]">{{ item.subject }}</span>
                  <span class="col-start-2 font-mono text-[12.5px] text-muted">{{ item.id.slice(0, 7) }} · {{ item.author }} · {{ agoText(item.at) }}</span>
                </button>
              </li>
            </ol>
          </template>
        </div>
        <div class="flex min-h-0 min-w-0 flex-col">
          <div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3">
            <span class="min-w-0 flex-1 truncate text-[14px] font-semibold">{{ commitShown?.subject ?? 'Scegli un commit' }}</span>
            <span v-if="commitShown" class="font-mono text-[12.5px] text-muted">{{ commitShown.id.slice(0, 7) }}</span>
          </div>
          <div class="min-h-0 flex-1 overflow-auto font-mono text-[13px] leading-[1.6]">
            <p v-if="diffProblem" class="p-3 text-sm text-danger" role="alert">{{ diffProblem }}</p>
            <p v-else-if="commit && diff === null" class="p-3 font-sans text-sm text-muted">Carico il diff…</p>
            <template v-else-if="diff">
              <p v-if="diff.files.length === 0" class="p-3 font-sans text-sm text-muted">Nessun file cambiato.</p>
              <div v-for="item in diff.files" :key="item.path">
                <div class="sticky top-0 z-[1] flex items-center gap-2 border-y border-line bg-surface-2 px-3.5 py-2 text-[13px] font-medium">
                  <span class="min-w-0 flex-1 truncate">{{ item.from ? `${item.from} → ${item.path}` : item.path }}</span>
                  <span class="font-normal text-muted">{{ diffTotal(item) }}</span>
                  <a
                    v-if="'hunks' in item && item.change !== 'deleted'"
                    :href="vscodeUrl(project.absolute, item.path, firstChangedLine(item.hunks))"
                    class="rounded px-1 font-sans font-normal text-muted hover:text-ink"
                    title="Apre il file in Visual Studio Code, com'è adesso"
                    ><Icon name="code" :size="13"
                  /></a>
                </div>
                <p v-if="'error' in item" class="px-3.5 py-2 font-sans text-xs text-muted">{{ FILE_ERROR_TEXT[item.error] ?? 'Non mostrato.' }}</p>
                <table v-else class="w-full border-collapse">
                  <tbody>
                    <tr v-for="(row, at) in diffRows(item.hunks)" :key="at" :class="rowClass[row.kind]">
                      <td class="w-px px-1.5 text-right text-muted select-none">{{ row.oldLine ?? '' }}</td>
                      <td class="w-px px-1.5 text-right text-muted select-none">{{ row.newLine ?? '' }}</td>
                      <td class="w-px px-1 select-none" :class="row.kind === 'added' ? 'text-ok' : row.kind === 'removed' ? 'text-danger' : 'text-muted'" aria-hidden="true">{{ signOf[row.kind] }}</td>
                      <td class="pr-3 whitespace-pre">
                        <span v-if="row.kind === 'added'" class="sr-only">aggiunta: </span><span v-else-if="row.kind === 'removed'" class="sr-only">tolta: </span>{{ row.text }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>
        </div>
      </div>
      </template>
    </template>
    </div>

    <!-- The consent of D-135: in the page, never a dialog of the browser -->
    <div v-if="hiddenConfirm && project" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="hidden-confirm-title" @keydown.esc="hiddenConfirm = false">
      <div class="w-full max-w-lg rounded-2xl border border-line-strong bg-surface shadow-[0_24px_60px_#0008]">
        <div class="flex gap-3 px-5 pt-5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-warn/15 text-warn"><Icon name="warning" :size="16" /></span>
          <div>
            <h2 id="hidden-confirm-title" class="mt-0.5 mb-1 text-[16px] font-semibold">Mostrare i file nascosti di {{ project.name }}?</h2>
            <p class="text-[14px] text-muted">Resta acceso per questo progetto finché lo spegni. Tutto resta sul computer: niente va al cloud né ai modelli.</p>
          </div>
        </div>
        <ul class="mx-5 mt-4 grid list-disc gap-1.5 pl-5 text-[14px]">
          <li>Vedrai le voci col punto (.github, .vscode, .env…), node_modules e l’interno di .git.</li>
          <li>I file che possono contenere segreti (.env, chiavi, .npmrc, .git/config) arrivano coperti: li scopri uno alla volta con “Mostra”.</li>
          <li>Un segreto scoperto si vede sullo schermo, e quindi anche in condivisioni e screenshot.</li>
        </ul>
        <div class="mt-5 flex justify-end gap-2 border-t border-line px-5 py-3">
          <button ref="hiddenCancel" type="button" class="btn px-3 py-1 text-[14px]" :disabled="hiddenBusy" @click="hiddenConfirm = false">Annulla</button>
          <button type="button" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="hiddenBusy" @click="setHidden(true)">Mostra nascosti</button>
        </div>
      </div>
    </div>

    <!-- The confirmation of a start or a stop: in the page, never a dialog of the browser -->
    <div v-if="confirming && confirmation && project" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="service-confirm-title" @keydown.esc="confirming = null">
      <div class="w-full max-w-[480px] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_70px_#0008]">
        <div class="flex gap-3.5 px-5 pt-5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg" :class="confirming.stop ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent'"><Icon :name="confirming.stop ? 'stop' : 'play'" :size="16" /></span>
          <div>
            <h2 id="service-confirm-title" class="mt-0.5 mb-1 text-[16px] font-semibold">{{ confirmation.title }}</h2>
            <p class="text-[14px] text-muted">{{ confirming.stop ? 'Arianna chiede al processo di chiudersi; se non risponde entro 10 secondi lo chiude lei.' : 'Arianna esegue questo comando sul tuo computer, nella cartella del progetto.' }}</p>
          </div>
        </div>
        <p class="mx-5 mt-4 rounded-lg bg-[#071013] px-3 py-2.5 font-mono text-[14px] text-[#cfe3df]"><span class="text-[#5d7774]">$ </span>{{ confirmation.command }}</p>
        <div v-if="!confirming.stop && confirming.service.script" class="mx-5 mt-2">
          <p class="mb-1 text-xs text-muted">{{ confirming.service.source === 'Makefile' ? 'La ricetta nel Makefile (make esegue anche gli obiettivi da cui dipende):' : 'Lo script in package.json (anche i suoi pre e post, se ci sono):' }}</p>
          <pre class="max-h-40 overflow-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[13px] whitespace-pre-wrap">{{ confirming.service.script }}</pre>
        </div>
        <dl class="mx-5 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-[13.5px]">
          <dt class="text-muted">Scritto in</dt><dd class="font-mono break-all">{{ confirmation.from }}</dd>
          <dt class="text-muted">Cartella</dt><dd class="font-mono break-all">{{ project.absolute }}</dd>
          <dt class="text-muted">Durata</dt><dd>{{ confirmation.duration }}</dd>
        </dl>
        <div class="flex justify-end gap-2 px-5 pt-4 pb-5">
          <button ref="cancelButton" type="button" class="btn px-3 py-1 text-[14px]" :disabled="acting" @click="confirming = null">Annulla</button>
          <button type="button" class="btn px-3 py-1 text-[14px] font-semibold" :class="confirming.stop ? 'btn-danger' : 'btn-primary'" :disabled="acting" @click="confirmAction">{{ confirming.stop ? 'Ferma' : 'Avvia' }}</button>
        </div>
      </div>
    </div>
  </section>
  <ConfirmDialog
    v-if="fileAction !== null"
    :title="fileAction.kind === 'delete' ? 'Eliminare per sempre?' : fileAction.kind === 'restore' ? 'Ripristinare?' : 'Spostare o rinominare?'"
    :confirm-text="fileAction.kind === 'delete' ? 'Elimina per sempre' : fileAction.kind === 'restore' ? 'Ripristina' : 'Sposta'"
    :danger="fileAction.kind === 'delete'"
    :busy="actionBusy"
    :problem="actionProblem"
    :disabled="fileAction.kind !== 'delete' && (fileAction.to.trim() === '' || fileAction.to.trim() === fileAction.path)"
    @confirm="runAction"
    @cancel="fileAction = null"
  >
    <template v-if="fileAction.kind === 'delete'">
      <p>
        <b class="break-all font-mono">{{ fileAction.path }}</b><template v-if="fileAction.entry === 'dir'"> e tutto quello che contiene</template> sparisce dal progetto.
      </p>
      <p class="text-xs text-muted">Non c'è un cestino: da Arianna non si recupera. Se il file era in un commit di git, si recupera da lì.</p>
    </template>
    <template v-else>
      <p v-if="fileAction.kind === 'restore'">Rimetto <b class="break-all font-mono">{{ fileAction.path }}</b> fuori da <code class="font-mono">eliminati/</code>, qui:</p>
      <p v-else>Nuovo percorso di <b class="break-all font-mono">{{ fileAction.path }}</b>, dentro il progetto:</p>
      <input v-model="fileAction.to" type="text" class="field w-full px-2 py-1.5 font-mono text-[13.5px]" aria-label="Nuovo percorso" @keydown.enter="fileAction.to.trim() !== '' && fileAction.to.trim() !== fileAction.path && runAction()" />
      <p class="text-xs text-muted">Se c'è già un file con quel nome non viene toccato: scegli un altro nome.</p>
    </template>
  </ConfirmDialog>
</template>

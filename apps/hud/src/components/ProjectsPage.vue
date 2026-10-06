<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { listBrowsableProjects, listProjectDir, listProjectServices, openProjectFile, readCommitDiff, readProjectFile, readProjectGit, serviceLog, startService, stopService } from '../lib/api.ts';
import { diffRows } from '../lib/delegations.ts';
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
  type BrowsableProject,
  type CommitDiff,
  type ProjectFile,
  type ProjectGit,
  type ServiceLog,
  type ServiceState,
  type TreeEntry,
} from '../lib/projects.ts';
import Icon from './Icon.vue';

/**
 * "Progetti" (D-134): an approved project read on this computer. File and
 * Git are read only: the tree, a file with the colours of the code, "Apri"
 * for pages and images (D-117), branches, changes not committed, commits and
 * their diff. "Apri in VS Code" is a vscode:// link: the core runs nothing.
 */

const projects = ref<BrowsableProject[] | null>(null);
const chosen = ref<string | null>(null);
const project = computed(() => projects.value?.find((item) => item.name === chosen.value) ?? null);
const switcherOpen = ref(false);
const tab = ref<'file' | 'git' | 'svc'>('file');
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

async function loadFolder(dir: string): Promise<void> {
  if (project.value === null) return;
  const name = project.value.name;
  folders.value = { ...folders.value, [dir]: 'loading' };
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
  void loadFolder('');
  void loadGit();
}

onMounted(async () => {
  try {
    projects.value = await listBrowsableProjects();
    const first = projects.value[0];
    if (first !== undefined) choose(first.name);
  } catch (cause) {
    problem.value = browseErrorText(cause);
  }
});

watch(tab, (now) => {
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
  <section class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4 md:px-6" aria-label="Progetti">
    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-else-if="projects === null" class="text-sm text-muted">Carico i progetti…</p>
    <div v-else-if="projects.length === 0" class="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
      Nessun progetto approvato. Si aggiungono in <b>Impostazioni → Progetti</b>: qui si vedono solo quelli approvati.
    </div>

    <template v-else-if="project">
      <!-- Masthead: which project, where, how it stands -->
      <header class="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div class="grid size-11 place-items-center rounded-xl border border-accent/40 bg-accent/15 font-hud text-[16px] font-semibold text-accent" aria-hidden="true">{{ initials(project.name) }}</div>
        <div class="min-w-0">
          <div class="relative">
            <button
              type="button"
              class="flex items-center gap-2 font-hud text-[21px] leading-tight font-semibold tracking-[0.02em]"
              :aria-expanded="switcherOpen"
              aria-haspopup="listbox"
              @click="switcherOpen = !switcherOpen"
            >
              {{ project.name }}<span class="rotate-90 text-muted"><Icon name="expand" :size="15" /></span>
            </button>
            <div v-if="switcherOpen" class="absolute top-full left-0 z-20 mt-1.5 min-w-[280px] rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_14px_40px_#0006]" role="listbox">
              <button
                v-for="item in projects"
                :key="item.name"
                type="button"
                role="option"
                :aria-selected="item.name === project.name"
                class="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-accent/15"
                :class="item.name === project.name ? 'bg-accent/15' : ''"
                @click="choose(item.name)"
              >
                <span class="block text-[13.5px]">{{ item.name }}</span>
                <span class="block truncate font-mono text-[11px] text-muted">{{ item.absolute }}</span>
              </button>
              <p class="mt-1 border-t border-line px-2.5 pt-2 pb-1 text-xs text-muted">Altri progetti si approvano in Impostazioni → Progetti.</p>
            </div>
          </div>
          <p class="flex flex-wrap items-center gap-x-2.5 font-mono text-xs text-muted">
            <span class="truncate">{{ project.absolute }}</span>
            <a :href="vscodeUrl(project.absolute)" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 font-sans text-xs text-ink" title="Apre la cartella del progetto in Visual Studio Code">
              <Icon name="code" :size="13" />Apri in VS Code
            </a>
          </p>
        </div>
        <div class="ml-auto flex overflow-hidden rounded-xl border border-line bg-surface">
          <button type="button" class="grid gap-1 px-4 py-2 text-left hover:bg-surface-2" @click="tab = 'git'">
            <span class="hud-title text-[10px]">Branch</span>
            <span class="flex items-center gap-1.5 font-mono text-[13px]"><Icon name="branch" :size="13" />{{ currentBranch ?? (git?.repository === false ? 'niente git' : '…') }}</span>
          </button>
          <button type="button" class="grid gap-1 border-l border-line px-4 py-2 text-left hover:bg-surface-2" @click="tab = 'git'">
            <span class="hud-title text-[10px]">Modifiche</span>
            <span class="font-mono text-[13px]" :class="changes.length > 0 ? 'text-warn' : ''">{{ git === null ? '…' : changes.length === 1 ? '1 file' : `${String(changes.length)} file` }}</span>
          </button>
          <button type="button" class="grid gap-1 border-l border-line px-4 py-2 text-left hover:bg-surface-2" @click="tab = 'svc'">
            <span class="hud-title text-[10px]">Servizi</span>
            <span class="flex items-center gap-1.5 font-mono text-[13px]"
              ><span class="size-2 rounded-full" :class="(services ?? []).some((item) => item.on) ? 'bg-ok' : 'bg-muted/50'"></span
              >{{ services === null ? 'apri' : `${String(services.filter((item) => item.on).length)} accesi su ${String(services.length)}` }}</span
            >
          </button>
        </div>
      </header>

      <nav class="flex items-end gap-1 border-b border-line" role="tablist" aria-label="Schede del progetto">
        <button
          v-for="item in [{ id: 'file', text: 'File' }, { id: 'git', text: 'Git' }, { id: 'svc', text: 'Servizi' }] as const"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="tab === item.id"
          class="-mb-px border-b-2 px-3 pt-2 pb-2.5 text-[13.5px] font-medium"
          :class="tab === item.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'"
          @click="tab = item.id"
        >
          {{ item.text }}
        </button>
        <span v-if="tab === 'svc'" class="ml-auto hidden items-center gap-1.5 pb-2.5 text-xs text-muted sm:flex"><Icon name="play" :size="13" />Avvia e ferma con la tua conferma, ogni volta</span>
        <span v-else class="ml-auto hidden items-center gap-1.5 pb-2.5 text-xs text-muted sm:flex"><Icon name="private" :size="13" />Sola lettura: niente modifiche, checkout né commit da qui</span>
      </nav>

      <!-- FILE: the tree and the file, one split pane -->
      <div v-if="tab === 'file'" class="grid min-h-[460px] flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-[264px_minmax(0,1fr)]">
        <div class="flex min-h-0 flex-col border-b border-line md:border-r md:border-b-0">
          <label class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 text-muted">
            <Icon name="search" :size="14" />
            <input v-model="query" type="search" placeholder="Cerca fra le cartelle aperte" aria-label="Cerca un file" class="w-full bg-transparent text-[13px] text-ink" />
          </label>
          <div class="min-h-0 flex-1 overflow-auto p-1.5 font-mono text-[12.5px] max-md:max-h-80">
            <p v-if="folders[''] === 'loading'" class="px-2 py-1 text-muted">Carico…</p>
            <p v-else-if="typeof folders[''] === 'string'" class="px-2 py-1 text-danger">{{ folders[''] }}</p>
            <template v-for="row in rows" :key="row.path">
              <div
                v-if="row.entry.shut"
                class="flex h-7 items-center gap-1.5 rounded-md px-2 text-muted opacity-70"
                :style="{ paddingLeft: `${String(8 + row.depth * 14)}px` }"
                :title="SHUT_TEXT[row.entry.shut]"
              >
                <span class="w-3"></span>{{ row.entry.name }}<span class="ml-auto"><Icon name="private" :size="11" /></span>
              </div>
              <button
                v-else
                type="button"
                class="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left whitespace-nowrap hover:bg-surface-2"
                :class="row.path === selected ? 'bg-accent/15 shadow-[inset_2px_0_0_var(--color-accent)]' : ''"
                :style="{ paddingLeft: `${String(8 + row.depth * 14)}px` }"
                :aria-expanded="row.entry.kind === 'dir' ? openFolders.has(row.path) : undefined"
                @click="row.entry.kind === 'dir' ? toggleFolder(row.path) : showFile(row.path)"
              >
                <span class="w-3 text-[9px] text-muted">{{ row.entry.kind === 'dir' ? (openFolders.has(row.path) ? '▾' : '▸') : '' }}</span>
                <span
                  v-if="row.entry.kind === 'file' && fileBadge(row.entry.name).text"
                  class="grid h-[15px] w-[24px] shrink-0 place-items-center rounded-[3px] text-[7.5px] font-semibold text-bg"
                  :class="badgeClass[fileBadge(row.entry.name).tone] ?? 'bg-muted'"
                  >{{ fileBadge(row.entry.name).text }}</span
                >
                <span
                  class="truncate"
                  :class="changeMark(changes, row.path, row.entry.kind) === 'M' ? 'text-warn' : changeMark(changes, row.path, row.entry.kind) === 'A' ? 'text-ok' : ''"
                  >{{ row.entry.name }}</span
                >
                <span v-if="changeMark(changes, row.path, row.entry.kind)" class="ml-auto pl-2 text-[10.5px]" :class="changeMark(changes, row.path, row.entry.kind) === 'M' ? 'text-warn' : 'text-ok'">{{
                  changeMark(changes, row.path, row.entry.kind)
                }}</span>
              </button>
              <p v-if="row.entry.kind === 'dir' && openFolders.has(row.path) && folders[row.path] === 'loading'" class="px-2 text-muted" :style="{ paddingLeft: `${String(30 + row.depth * 14)}px` }">…</p>
            </template>
          </div>
          <p class="flex shrink-0 gap-3 border-t border-line px-3 py-2 text-[11.5px] text-muted">
            <span><b class="font-mono text-warn">M</b> modificato</span><span><b class="font-mono text-ok">A</b> nuovo</span><span class="inline-flex items-center gap-1"><Icon name="private" :size="11" />chiuso</span>
          </p>
        </div>
        <div class="flex min-h-0 min-w-0 flex-col">
          <div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3">
            <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">
              <template v-if="selected"><span class="text-muted">{{ project.name }} / </span>{{ selected }}</template>
              <span v-else class="text-muted">Scegli un file a sinistra</span>
            </span>
            <span v-if="file" class="font-mono text-[11.5px] whitespace-nowrap text-muted">{{ sizeText(file.size) }} · {{ fileLines.length }} righe</span>
            <a v-if="selected && !fileProblem" :href="vscodeUrl(project.absolute, selected)" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs" title="Apre questo file in Visual Studio Code"><Icon name="code" :size="13" />VS Code</a>
            <button v-if="file?.openable" type="button" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs" title="Apre in una scheda nuova, servita dal computer" @click="openInBrowser"><Icon name="external" :size="13" />Apri</button>
          </div>
          <p v-if="openProblem" class="border-b border-line px-3 py-1.5 text-xs text-danger" role="alert">{{ openProblem }}</p>
          <div class="min-h-0 flex-1 overflow-auto">
            <p v-if="fileLoading" class="p-4 text-sm text-muted">Carico…</p>
            <div v-else-if="fileProblem" class="grid h-full place-items-center p-8 text-center text-[13px] text-muted">
              <div class="grid max-w-sm justify-items-center gap-2"><Icon name="private" :size="26" />{{ fileProblem }}</div>
            </div>
            <pre v-else-if="file" class="m-0 py-3 font-mono text-[12.5px] leading-[1.7]"><span v-for="(line, at) in fileLines" :key="at" class="flex"><span class="w-12 shrink-0 border-r-2 pr-3.5 mr-3.5 text-right text-muted/70 select-none" :class="changedHere === 'A' ? 'border-ok' : 'border-transparent'">{{ at + 1 }}</span><span class="whitespace-pre pr-4"><span v-for="(token, index) in line" :key="index" :class="tokenClass[token.kind]">{{ token.text }}</span></span></span></pre>
          </div>
        </div>
      </div>

      <!-- SERVIZI: the cards by file on the left, the log of the chosen one on the right -->
      <div v-else-if="tab === 'svc'" class="grid flex-1 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)]">
        <div>
          <p v-if="servicesProblem" class="mb-3 text-sm text-danger" role="alert">{{ servicesProblem }}</p>
          <p v-if="services === null" class="text-sm text-muted">Leggo i servizi…</p>
          <p v-else-if="services.length === 0" class="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm text-muted">
            Questo progetto non dichiara servizi: niente script in package.json, niente docker-compose.yml, niente Makefile.
          </p>
          <div v-for="[fileName, list] in serviceGroups" :key="fileName" class="mb-5">
            <p class="mb-2 flex items-center gap-2"><span class="font-mono text-[12px] font-medium">{{ fileName }}</span><span class="hud-title text-[10px]">{{ list[0]?.source === 'package.json' ? 'script' : list[0]?.source === 'compose' ? 'servizi' : 'obiettivi' }}</span></p>
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
                  <span class="ml-auto font-mono text-[11px]" :class="service.on ? 'text-ok' : 'text-muted'">{{ serviceStateText(service) }}</span>
                </div>
                <span class="truncate rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11.5px] text-muted" :title="service.script ?? service.command.join(' ')">{{ service.script ?? service.command.join(' ') }}</span>
                <div class="flex items-center gap-1.5">
                  <span class="mr-auto font-mono text-[11px] text-muted">{{ service.ports.map((item) => `:${String(item)}`).join(' ') }}</span>
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
          <div class="flex items-center gap-2.5 border-b border-white/10 px-3.5 py-2.5 text-[13px]">
            <span class="size-2 rounded-full" :class="log?.running ? 'bg-ok' : 'bg-white/25'"></span>
            <b>{{ shownService?.name ?? 'Registro' }}</b>
            <span class="font-mono text-[11.5px] text-[#8aa3a0]">{{ log ? endedText(log) : shownService ? 'nessun avvio da qui' : '' }}</span>
          </div>
          <pre class="m-0 h-[300px] overflow-auto px-3.5 py-3 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap">{{ log?.lines.join('\n') ?? '' }}</pre>
          <div class="grid gap-1 border-t border-white/10 px-3.5 py-2.5 text-xs text-[#8aa3a0]">
            <span>Si avviano <b class="font-medium text-[#cfe3df]">solo i comandi scritti nei file del progetto</b>, con la tua conferma ogni volta.</span>
            <span>Test e build si fermano da soli dopo <b class="font-medium text-[#cfe3df]">10 minuti</b>; i servizi avviati da qui si fermano alla chiusura di Arianna. Il registro resta sul computer (ultime 2000 righe).</span>
          </div>
        </aside>
      </div>

      <!-- GIT: branches, changes, commits on the left; the diff on the right -->
      <div v-else class="grid min-h-[460px] flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-[340px_minmax(0,1fr)]">
        <div class="flex min-h-0 flex-col overflow-auto border-b border-line md:border-r md:border-b-0">
          <p v-if="gitProblem" class="p-3 text-sm text-danger" role="alert">{{ gitProblem }}</p>
          <p v-else-if="git === null" class="p-3 text-sm text-muted">Leggo git…</p>
          <p v-else-if="!git.repository" class="p-3 text-sm text-muted">Questa cartella non è un repository git.</p>
          <template v-else>
            <div class="flex items-center gap-2 px-3.5 pt-3.5 pb-1.5"><span class="hud-title flex-1 text-[10px]">Branch</span></div>
            <ul class="px-2 font-mono text-[12.5px]">
              <li v-for="branch in git.branches" :key="branch.name" class="flex items-center gap-2 rounded-md px-1.5 py-1" :class="branch.current ? 'text-accent' : ''">
                <span aria-hidden="true">{{ branch.current ? '●' : '○' }}</span><span class="min-w-0 flex-1 truncate">{{ branch.name }}</span
                ><span class="text-[11px] whitespace-nowrap text-muted">{{ agoText(branch.at) }}</span>
              </li>
            </ul>
            <div class="flex items-center gap-2 px-3.5 pt-4 pb-1.5"><span class="hud-title flex-1 text-[10px]">Non salvato in un commit</span><span class="font-mono text-[11px] text-muted">{{ git.changes.length }}</span></div>
            <p v-if="git.changes.length === 0" class="px-3.5 text-xs text-muted">Nessuna modifica.</p>
            <ul class="px-2 font-mono text-[12px]">
              <li v-for="change in git.changes" :key="change.path" class="flex items-center gap-2 px-1.5 py-0.5">
                <b class="w-3.5 text-center" :class="change.change === 'added' ? 'text-ok' : change.change === 'deleted' ? 'text-danger' : 'text-warn'">{{
                  { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[change.change]
                }}</b>
                <span class="min-w-0 truncate" :title="change.from ? `da ${change.from}` : undefined">{{ change.path }}</span>
              </li>
            </ul>
            <div class="px-3.5 pt-4 pb-1.5"><span class="hud-title text-[10px]">Commit</span></div>
            <p v-if="git.log.length === 0" class="px-3.5 pb-3 text-xs text-muted">Ancora nessun commit.</p>
            <ol class="px-2 pb-3">
              <li v-for="(item, at) in git.log" :key="item.id" class="relative">
                <span class="absolute left-[18px] w-0.5 bg-line" :class="[at === 0 ? 'top-[18px]' : 'top-0', at === git.log.length - 1 ? 'h-[18px]' : 'bottom-0']" aria-hidden="true"></span>
                <button type="button" class="relative grid w-full grid-cols-[22px_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-2 text-left hover:bg-surface-2" :class="item.id === commit ? 'bg-accent/15' : ''" @click="showCommit(item.id)">
                  <span class="mt-[5px] ml-[5px] size-2.5 rounded-full border-2" :class="[item.parents.length > 1 ? 'border-info' : 'border-accent', item.id === commit ? 'bg-accent' : 'bg-surface']" aria-hidden="true"></span>
                  <span class="truncate text-[13px]">{{ item.subject }}</span>
                  <span class="col-start-2 font-mono text-[11.5px] text-muted">{{ item.id.slice(0, 7) }} · {{ item.author }} · {{ agoText(item.at) }}</span>
                </button>
              </li>
            </ol>
          </template>
        </div>
        <div class="flex min-h-0 min-w-0 flex-col">
          <div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3">
            <span class="min-w-0 flex-1 truncate text-[14px] font-semibold">{{ commitShown?.subject ?? 'Scegli un commit' }}</span>
            <span v-if="commitShown" class="font-mono text-[11.5px] text-muted">{{ commitShown.id.slice(0, 7) }}</span>
          </div>
          <div class="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[1.6]">
            <p v-if="diffProblem" class="p-3 text-sm text-danger" role="alert">{{ diffProblem }}</p>
            <p v-else-if="commit && diff === null" class="p-3 font-sans text-sm text-muted">Carico il diff…</p>
            <template v-else-if="diff">
              <p v-if="diff.files.length === 0" class="p-3 font-sans text-sm text-muted">Nessun file cambiato.</p>
              <div v-for="item in diff.files" :key="item.path">
                <div class="sticky top-0 z-[1] flex items-center gap-2 border-y border-line bg-surface-2 px-3.5 py-2 text-[12px] font-medium">
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

    <!-- The confirmation of a start or a stop: in the page, never a dialog of the browser -->
    <div v-if="confirming && confirmation && project" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="service-confirm-title" @keydown.esc="confirming = null">
      <div class="w-full max-w-[480px] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_70px_#0008]">
        <div class="flex gap-3.5 px-5 pt-5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg" :class="confirming.stop ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent'"><Icon :name="confirming.stop ? 'stop' : 'play'" :size="16" /></span>
          <div>
            <h2 id="service-confirm-title" class="mt-0.5 mb-1 text-[16px] font-semibold">{{ confirmation.title }}</h2>
            <p class="text-[13px] text-muted">{{ confirming.stop ? 'Arianna chiede al processo di chiudersi; se non risponde entro 10 secondi lo chiude lei.' : 'Arianna esegue questo comando sul tuo computer, nella cartella del progetto.' }}</p>
          </div>
        </div>
        <p class="mx-5 mt-4 rounded-lg bg-[#071013] px-3 py-2.5 font-mono text-[13px] text-[#cfe3df]"><span class="text-[#5d7774]">$ </span>{{ confirmation.command }}</p>
        <div v-if="!confirming.stop && confirming.service.script" class="mx-5 mt-2">
          <p class="mb-1 text-xs text-muted">{{ confirming.service.source === 'Makefile' ? 'La ricetta nel Makefile (make esegue anche gli obiettivi da cui dipende):' : 'Lo script in package.json (anche i suoi pre e post, se ci sono):' }}</p>
          <pre class="max-h-40 overflow-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{{ confirming.service.script }}</pre>
        </div>
        <dl class="mx-5 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-[12.5px]">
          <dt class="text-muted">Scritto in</dt><dd class="font-mono break-all">{{ confirmation.from }}</dd>
          <dt class="text-muted">Cartella</dt><dd class="font-mono break-all">{{ project.absolute }}</dd>
          <dt class="text-muted">Durata</dt><dd>{{ confirmation.duration }}</dd>
        </dl>
        <div class="flex justify-end gap-2 px-5 pt-4 pb-5">
          <button ref="cancelButton" type="button" class="btn px-3 py-1 text-[13px]" :disabled="acting" @click="confirming = null">Annulla</button>
          <button type="button" class="btn px-3 py-1 text-[13px] font-semibold" :class="confirming.stop ? 'btn-danger' : 'btn-primary'" :disabled="acting" @click="confirmAction">{{ confirming.stop ? 'Ferma' : 'Avvia' }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

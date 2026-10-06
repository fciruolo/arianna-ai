<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { listBrowsableProjects, listProjectDir, openProjectFile, readCommitDiff, readProjectFile, readProjectGit } from '../lib/api.ts';
import { diffRows } from '../lib/delegations.ts';
import {
  agoText,
  browseErrorText,
  changeMark,
  childPath,
  extensionOf,
  FILE_ERROR_TEXT,
  fileBadge,
  firstChangedLine,
  highlightLine,
  SHUT_TEXT,
  sizeText,
  vscodeUrl,
  type BrowsableProject,
  type CommitDiff,
  type ProjectFile,
  type ProjectGit,
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
const tab = ref<'file' | 'git'>('file');
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
        </div>
      </header>

      <nav class="flex items-end gap-1 border-b border-line" role="tablist" aria-label="Schede del progetto">
        <button
          v-for="item in [{ id: 'file', text: 'File' }, { id: 'git', text: 'Git' }] as const"
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
        <span class="ml-auto hidden items-center gap-1.5 pb-2.5 text-xs text-muted sm:flex"><Icon name="private" :size="13" />Sola lettura: niente modifiche, checkout né commit da qui</span>
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
  </section>
</template>

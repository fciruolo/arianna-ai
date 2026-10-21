<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { ApiError, approveWikiProposal, discardWikiProposal, loadWiki, loadWikiPage, loadWikiProposals, proposeWikiAgain, proposeWikiMove, restoreWikiPage } from '../lib/api.ts';
import { diffRows } from '../lib/delegations.ts';
import {
  ancestorsOf,
  buildWikiTree,
  indexPath,
  KIND_TEXT,
  pathProblem,
  tidyPath,
  versionText,
  wikiErrorText,
  wikilinkTarget,
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

const moveTo = ref('');
const moveNotice = ref<string | null>(null);
const moveBusy = ref(false);

const tree = computed(() => (listing.value === null ? [] : buildWikiTree(listing.value.folders, listing.value.pages)));
const proposalCount = computed(() => proposals.value?.length ?? listing.value?.proposals ?? 0);
/** The folder whose index is shown, or null for a page. */
const shownFolder = computed(() => (shownPath.value === '_indice' ? '' : shownPath.value.endsWith('/_indice') ? shownPath.value.slice(0, -'/_indice'.length) : null));
const moveProblem = computed(() => (moveTo.value.trim() === '' ? undefined : pathProblem(tidyPath(moveTo.value), 'folder')));

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
  moveTo.value = '';
  moveNotice.value = null;
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
    pageError.value = failure instanceof ApiError && failure.status === 404 ? (folder === '' ? 'La Wiki è ancora vuota: le pagine arrivano dalle proposte del modello locale.' : 'Questa pagina non c’è più.') : problemOf(failure);
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

async function proposeMove(): Promise<void> {
  const from = shownFolder.value;
  const to = tidyPath(moveTo.value);
  if (from === null || from === '' || moveBusy.value || pathProblem(to, 'folder') !== undefined) return;
  moveBusy.value = true;
  moveNotice.value = null;
  try {
    await proposeWikiMove(from, to);
    moveTo.value = '';
    moveNotice.value = `Proposta di spostamento in wiki/${to}: la approvi nella scheda «Proposte».`;
    await loadProposals();
  } catch (failure) {
    moveNotice.value = problemOf(failure);
  } finally {
    moveBusy.value = false;
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
            <button type="button" class="flex items-center gap-1.5 rounded-md px-2 py-1 text-left font-semibold hover:bg-surface" :class="shownPath === '_indice' ? 'text-accent' : ''" @click="show('_indice')">
              <Icon name="wiki" :size="14" />Wiki
            </button>
            <p v-if="listError !== null" class="px-2 py-1 text-xs text-danger" role="alert">{{ listError }}</p>
            <p v-else-if="listing !== null && rows.length === 0" class="px-2 py-1 text-[13px] text-muted">Nessuna pagina ancora.</p>
            <div v-for="row in rows" :key="`${row.node.kind}:${row.node.path}`" class="flex items-center" :style="{ paddingLeft: `${String(row.depth * 14)}px` }">
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
            <p v-if="pageLoading && page === null" class="text-sm text-muted">Leggo la pagina…</p>
            <p v-else-if="pageError !== null" class="text-sm text-muted">{{ pageError }}</p>
            <template v-else-if="page !== null">
              <p class="font-mono text-[12px] text-muted">wiki/{{ page.path }}</p>
              <h2 class="mt-1 text-[19px] font-semibold">{{ page.title }}</h2>
              <MarkdownText class="mt-3" :source="page.body" :wikilink="follow" />

              <section v-if="shownFolder !== null && shownFolder !== ''" class="mt-5 border-t border-line pt-3">
                <h3 class="text-[14px] font-semibold">Sposta o rinomina la cartella</h3>
                <p class="mt-0.5 text-[13px] text-muted">Diventa una proposta da approvare in «Proposte»; i collegamenti alle pagine seguono.</p>
                <form class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="proposeMove">
                  <input
                    v-model="moveTo"
                    type="text"
                    class="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1 font-mono text-[13.5px] outline-none"
                    :placeholder="shownFolder"
                    aria-label="Nuovo percorso della cartella"
                  />
                  <button type="submit" class="btn px-2.5 py-1 text-[13px]" :disabled="moveBusy || moveTo.trim() === '' || moveProblem !== undefined">Proponi</button>
                </form>
                <p v-if="moveProblem !== undefined" class="mt-1 text-xs text-danger">{{ moveProblem }}</p>
                <p v-if="moveNotice !== null" class="mt-1 text-[13px]" role="status">{{ moveNotice }}</p>
              </section>

              <section v-if="page.kind === 'page' && page.versions.length > 0" class="mt-5 border-t border-line pt-3">
                <h3 class="flex items-center gap-1.5 text-[14px] font-semibold"><Icon name="history" :size="14" />Versioni precedenti</h3>
                <ul class="mt-1.5 flex flex-col gap-1 text-[13.5px]">
                  <li v-for="version in page.versions" :key="version.id" class="flex items-center gap-2">
                    <span class="font-mono text-[12.5px] text-muted">{{ versionText(version.at) }}</span>
                    <button type="button" class="btn px-2 py-0.5 text-[12.5px]" @click="restoring = version.id; restoreProblem = null"><Icon name="retry" :size="12" />Ripristina</button>
                  </li>
                </ul>
              </section>
            </template>
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

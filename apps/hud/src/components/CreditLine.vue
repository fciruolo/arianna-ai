<script setup lang="ts">
import { computed, ref } from 'vue';

import { loadDelegationDiff, loadDelegationFile, openDelegationFile } from '../lib/api.ts';
import { canOpen, canPreview, codeFence, diffRows, diffTotals } from '../lib/delegations.ts';
import { baseCommitText, CHANGE_TEXT, DIFF_ERROR_TEXT, creditText, diffCountText, filesTitle, previewErrorText } from '../lib/italian.ts';
import type { DelegationDiff, DelegationFile, FileDiff, FileDiffError, FilePreview, MessageCredit } from '../lib/types.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * Under an answer written in the cloud (D-082): who wrote it, on which
 * executor and model, in how long; for a report of the Coder, the files its
 * run changed. Opening the list loads the diff of every file against the
 * commit they were listed against (D-117), removed lines in red and added
 * ones in green; each file can also be shown whole, as it is now in the
 * approved project, read only. Nothing here opens Finder or the folder.
 */
const props = defineProps<{ credit: MessageCredit }>();

const files = computed(() => props.credit.files ?? []);
const open = ref<number | null>(null);
const whole = ref(false);
const preview = ref<FilePreview | null>(null);
const loading = ref(false);
const problem = ref<string | null>(null);

/** "Apri" (D-117, tappa 3): the file in a new tab, sandboxed by the core; why not, under the list. */
const openProblem = ref<string | null>(null);
async function openFile(index: number): Promise<void> {
  const id = props.credit.delegationId;
  if (id === null) return;
  openProblem.value = null;
  // Opened at the click, before the request, or the browser takes it for a popup; no way back to the chat.
  const tab = window.open('about:blank', '_blank');
  if (tab !== null) tab.opener = null;
  try {
    const url = await openDelegationFile(id, index);
    // A blocked popup stays blocked after the request: the user opens it from the message.
    if (tab === null) openProblem.value = 'Il browser ha bloccato la scheda nuova: consenti i popup per questa pagina e premi di nuovo "Apri".';
    else tab.location.href = url;
  } catch (cause) {
    tab?.close();
    openProblem.value = previewErrorText(cause);
  }
}

const diff = ref<DelegationDiff | null>(null);
const diffLoading = ref(false);
const diffProblem = ref<string | null>(null);
const totals = computed(() => (diff.value === null ? null : diffTotals(diff.value.files)));

const changeClass: Record<DelegationFile['change'], string> = {
  added: 'text-ok',
  modified: 'text-info',
  deleted: 'text-danger',
  renamed: 'text-warn',
};

const rowClass = { added: 'bg-ok/10', removed: 'bg-danger/10', context: '', gap: 'text-muted' } as const;
const signOf = { added: '+', removed: '−', context: ' ', gap: '⋯' } as const;

type ShownDiff = Extract<FileDiff, { hunks: unknown }>;

function diffOf(index: number): FileDiff | undefined {
  return diff.value?.files.find((file) => file.index === index);
}

/** The diff of a file, when it is shown. */
function shownDiff(index: number): ShownDiff | undefined {
  const file = diffOf(index);
  return file === undefined || 'error' in file ? undefined : file;
}

/** Why the diff of a file is not shown, when it is not. */
function diffError(index: number): FileDiffError | undefined {
  const file = diffOf(index);
  return file !== undefined && 'error' in file ? file.error : undefined;
}

/** The diff is loaded once, the first time the list is opened. */
async function loadDiff(event: Event): Promise<void> {
  const id = props.credit.delegationId;
  if (!(event.target instanceof HTMLDetailsElement) || !event.target.open || id === null) return;
  if (diff.value !== null || diffLoading.value) return;
  diffLoading.value = true;
  diffProblem.value = null;
  try {
    diff.value = await loadDelegationDiff(id);
  } catch (cause) {
    diffProblem.value = previewErrorText(cause);
  } finally {
    diffLoading.value = false;
  }
}

function toggle(index: number): void {
  open.value = open.value === index ? null : index;
  whole.value = false;
  preview.value = null;
  problem.value = null;
}

async function showWhole(index: number): Promise<void> {
  const id = props.credit.delegationId;
  if (id === null) return;
  if (whole.value) {
    whole.value = false;
    return;
  }
  whole.value = true;
  preview.value = null;
  problem.value = null;
  loading.value = true;
  try {
    const file = await loadDelegationFile(id, index);
    if (open.value === index && whole.value) preview.value = file;
  } catch (cause) {
    if (open.value === index && whole.value) problem.value = previewErrorText(cause);
  } finally {
    if (open.value === index) loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p class="font-mono text-[10.5px] text-muted" title="Chi ha scritto questa risposta: esecutore, modello scelto e modello effettivo">
      {{ creditText(credit) }}
    </p>
    <details v-if="files.length > 0" class="rounded-lg border border-line bg-surface-2 text-[12.5px]" @toggle="loadDiff">
      <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 font-medium select-none">
        <Icon name="file" :size="14" />{{ filesTitle(files.length) }}
        <span v-if="credit.repo !== null" class="font-mono text-[10.5px] font-normal text-muted">· {{ credit.repo }}</span>
        <span v-if="totals !== null" class="ml-auto font-mono text-[11px] font-normal" title="Righe aggiunte e tolte dal Coder">
          <span class="text-ok">+{{ totals.added }}</span> <span class="text-danger">−{{ totals.removed }}</span>
        </span>
      </summary>
      <p v-if="diffLoading" class="border-t border-line px-3 py-1.5 text-xs text-muted">Calcolo le modifiche…</p>
      <p v-else-if="diffProblem !== null" class="border-t border-line px-3 py-1.5 text-xs text-warn">{{ diffProblem }}</p>
      <p v-if="openProblem !== null" role="alert" class="border-t border-line px-3 py-1.5 text-xs text-warn">{{ openProblem }}</p>
      <ul class="flex flex-col border-t border-line">
        <li v-for="(file, index) in files" :key="`${file.change}:${file.path}`" class="border-b border-line last:border-b-0">
          <div v-if="credit.delegationId !== null" class="flex items-stretch">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left hover:bg-surface"
              :aria-expanded="open === index"
              :title="`Mostra le modifiche a ${file.path}`"
              @click="toggle(index)"
            >
              <span class="w-[78px] shrink-0 font-mono text-[10.5px]" :class="changeClass[file.change]">{{ CHANGE_TEXT[file.change] }}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]" :class="{ 'text-muted line-through': file.change === 'deleted' }">{{ file.path }}</span>
              <span v-if="file.from !== undefined" class="truncate font-mono text-[10.5px] text-muted">da {{ file.from }}</span>
              <span v-if="shownDiff(index) !== undefined" class="shrink-0 font-mono text-[10.5px]">
                {{ diffCountText(shownDiff(index)?.added ?? 0, shownDiff(index)?.removed ?? 0) }}
              </span>
            </button>
            <button
              v-if="canOpen(file)"
              type="button"
              class="shrink-0 px-2.5 font-mono text-[10.5px] text-accent hover:bg-surface"
              :title="`Apri ${file.path} in una scheda nuova, in sandbox: legge solo i file del progetto`"
              :aria-label="`Apri ${file.path} in una scheda nuova`"
              @click="openFile(index)"
            >Apri</button>
          </div>
          <div v-else class="flex items-center gap-2 px-3 py-1.5">
            <span class="w-[78px] shrink-0 font-mono text-[10.5px]" :class="changeClass[file.change]">{{ CHANGE_TEXT[file.change] }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{{ file.path }}</span>
          </div>
          <div v-if="open === index" class="border-t border-line px-3 py-2" aria-live="polite">
            <template v-if="!whole">
              <p v-if="diffLoading" class="text-xs text-muted">Calcolo le modifiche…</p>
              <p v-else-if="diffOf(index) === undefined" class="text-xs text-muted">Modifiche non disponibili: apri la versione intera.</p>
              <p v-else-if="diffError(index) !== undefined" class="text-xs text-warn">{{ DIFF_ERROR_TEXT[diffError(index) ?? 'not-found'] }}</p>
              <p v-else-if="(shownDiff(index)?.hunks.length ?? 0) === 0" class="text-xs text-muted">Nessuna riga cambiata.</p>
              <div v-else>
                <p v-if="diff?.baseCommit" class="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
                  <Icon name="info" :size="12" />{{ baseCommitText(diff.baseCommit) }}
                </p>
                <div class="max-h-[420px] overflow-auto rounded border border-line bg-surface font-mono text-[11.5px] leading-[1.45]">
                <table class="w-full border-collapse">
                  <tbody>
                    <tr
                      v-for="(row, at) in diffRows(shownDiff(index)?.hunks ?? [])"
                      :key="at"
                      :class="rowClass[row.kind]"
                    >
                      <td class="w-px px-1.5 text-right text-muted select-none">{{ row.oldLine ?? '' }}</td>
                      <td class="w-px px-1.5 text-right text-muted select-none">{{ row.newLine ?? '' }}</td>
                      <td
                        class="w-px px-1 select-none"
                        :class="row.kind === 'added' ? 'text-ok' : row.kind === 'removed' ? 'text-danger' : 'text-muted'"
                        aria-hidden="true"
                      >
                        {{ signOf[row.kind] }}
                      </td>
                      <td class="pr-3 whitespace-pre">
                        <span v-if="row.kind === 'added'" class="sr-only">aggiunta: </span>
                        <span v-else-if="row.kind === 'removed'" class="sr-only">tolta: </span>
                        <span>{{ row.text }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                </div>
              </div>
            </template>
            <template v-else>
              <p v-if="loading" class="text-xs text-muted">Leggo il file…</p>
              <p v-else-if="problem !== null" class="text-xs text-warn">{{ problem }}</p>
              <template v-else-if="preview !== null">
                <p class="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
                  <Icon name="info" :size="12" />Versione attuale del file, in sola lettura: può essere cambiato dopo il lavoro del Coder.
                </p>
                <MarkdownText class="max-h-[420px] overflow-auto" :source="codeFence(preview.text, preview.path)" />
              </template>
            </template>
            <button
              v-if="canPreview(file)"
              type="button"
              class="mt-2 text-[11px] text-muted underline-offset-2 hover:text-text hover:underline"
              @click="showWhole(index)"
            >
              {{ whole ? 'Torna alle modifiche' : 'Versione intera' }}
            </button>
          </div>
        </li>
      </ul>
    </details>
  </div>
</template>

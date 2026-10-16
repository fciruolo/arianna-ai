<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { listActivities, listTerminal, loadDelegationFile } from '../lib/api.ts';
import { activityLines, type ChatState, type TerminalCall, type TerminalText } from '../lib/chat-state.ts';
import { atWork, COMPUTER_TABS, computerTask, delegationCredit, filesView, mayReadFile, sandboxRefusal, savedCalls, terminalCalls, type ComputerTab } from '../lib/computer.ts';
import { codeFence } from '../lib/delegations.ts';
import { activityText, CHANGE_TEXT, errorText, previewErrorText } from '../lib/italian.ts';
import { STATUS_TEXT } from '../lib/labels.ts';
import type { Activity, FilePreview, MessageCredit, SavedActivity, Task } from '../lib/types.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * The "Computer" of the Coder's run (D-095, tappa 1), a panel at the right of
 * the conversation with three tabs: Terminale, File, Attività. Read only:
 * nothing here writes to the run, which stays non interactive (D-049). While
 * the run works everything comes from the WebSocket; once it ended the files
 * and the steps are read again from the core, and so is the terminal, saved
 * with the delegation (migration 0062).
 */
const props = defineProps<{
  chat: ChatState;
  tasks: Record<string, Task>;
  credits: Map<string, MessageCredit>;
  activityCounts: Record<string, number>;
  /** The project folder of the conversation, the only one the Coder's cage opens. */
  workspace: string | null;
}>();

/** Why the Coder is isolated, in plain words (D-095): the sandbox of the executors, PRIVACY-POLICY-SPEC. */
const CAGE_LINES = [
  'Cartella: legge e scrive solo nella cartella del progetto; ogni lettura fuori (la tua home, le note, i dati di Arianna) la nega il sistema operativo.',
  'Rete: spenta. Un download, un curl o un npm install falliscono.',
  'Ambiente pulito: niente tue variabili né segreti; dopo il lavoro Arianna controlla che la configurazione di git non sia cambiata.',
  'Questo pannello è in sola lettura: tu guardi, il Coder non ti vede e non può usarlo.',
];
const cageFolder = computed(() => (props.workspace === null ? 'la cartella del progetto' : (props.workspace.split(/[:/]/).filter((part) => part !== '').at(-1) ?? props.workspace)));
const cageOpen = ref(false);
const emit = defineEmits<{ close: [] }>();

const TAB_TEXT: Record<ComputerTab, string> = { terminal: 'Terminale', files: 'File', activity: 'Attività' };
const tab = ref<ComputerTab>('terminal');

const taskId = computed(() => computerTask(props.chat, props.credits));
const status = computed(() => (taskId.value === undefined ? undefined : props.tasks[taskId.value]?.status));
const working = computed(() => atWork(status.value));
const credit = computed(() => (taskId.value === undefined ? undefined : delegationCredit(props.chat, props.credits, taskId.value)));

// Terminale: live while the run works; once it ended, as saved with the delegation (migration 0062).
const liveCalls = computed(() => (taskId.value === undefined ? [] : terminalCalls(props.chat, taskId.value)));
const savedTerminal = ref<TerminalCall[] | null>(null);
const terminalLoading = ref(false);
const terminalProblem = ref<string | null>(null);
const calls = computed(() => (working.value || savedTerminal.value === null || savedTerminal.value.length < liveCalls.value.length ? liveCalls.value : savedTerminal.value));
/** Each read has its number: only the answer of the latest one counts, so a change during a read is never lost. */
let terminalRead = 0;
async function readTerminal(): Promise<void> {
  const read = ++terminalRead;
  const id = taskId.value;
  if (id === undefined || working.value) {
    terminalLoading.value = false;
    return;
  }
  terminalLoading.value = true;
  terminalProblem.value = null;
  try {
    const rows = await listTerminal(id);
    if (read === terminalRead) savedTerminal.value = savedCalls(rows);
  } catch (cause) {
    if (read === terminalRead) terminalProblem.value = errorText(cause);
  } finally {
    if (read === terminalRead) terminalLoading.value = false;
  }
}
watch(
  [taskId, working],
  () => {
    savedTerminal.value = null;
    void readTerminal();
  },
  { immediate: true },
);
const screen = ref<HTMLElement | null>(null);
/** Follows the newest command while the user stays at the bottom. */
const following = ref(true);
function onScreenScroll(): void {
  const element = screen.value;
  if (element !== null) following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}
watch(
  () => calls.value.map((call) => `${call.callId}:${call.command?.text === undefined ? '' : 'c'}${call.output?.text === undefined ? '' : 'o'}`).join(','),
  async () => {
    if (!following.value) return;
    await nextTick();
    if (screen.value !== null) screen.value.scrollTop = screen.value.scrollHeight;
  },
);

function notes(part: TerminalText): string[] {
  const out: string[] = [];
  if (part.refused) out.push('Testo nascosto: conteneva un valore del vault.');
  if (part.hidden > 0) out.push(part.hidden === 1 ? '1 riga nascosta: conteneva un valore del vault.' : `${String(part.hidden)} righe nascoste: contenevano un valore del vault.`);
  if (part.truncated) out.push('Tagliato: si vedono le prime 200 righe o i primi 16 KiB.');
  return out;
}

// File
const files = computed(() => (taskId.value === undefined ? undefined : filesView(props.chat, taskId.value, status.value, credit.value)));
const openFile = ref<number | null>(null);
const preview = ref<FilePreview | null>(null);
const previewLoading = ref(false);
const previewProblem = ref<string | null>(null);

/** The content of a file of the ended delegation, from the existing route: never while the run works. */
async function showFile(index: number): Promise<void> {
  const view = files.value;
  if (view === undefined || !mayReadFile(view, index)) return;
  if (openFile.value === index) {
    openFile.value = null;
    return;
  }
  openFile.value = index;
  preview.value = null;
  previewProblem.value = null;
  previewLoading.value = true;
  try {
    const file = await loadDelegationFile(view.delegationId, index);
    if (openFile.value === index) preview.value = file;
  } catch (cause) {
    if (openFile.value === index) previewProblem.value = previewErrorText(cause);
  } finally {
    if (openFile.value === index) previewLoading.value = false;
  }
}
watch(taskId, () => {
  openFile.value = null;
  preview.value = null;
  saved.value = null;
});

// Attività
const live = computed<Activity[]>(() => (taskId.value === undefined || !working.value ? [] : activityLines(props.chat, taskId.value, status.value)));
const saved = ref<SavedActivity[] | null>(null);
const savedLoading = ref(false);
const savedProblem = ref<string | null>(null);
async function readSaved(): Promise<void> {
  const id = taskId.value;
  if (id === undefined || working.value || savedLoading.value) return;
  if (saved.value !== null && saved.value.length >= (props.activityCounts[id] ?? 0)) return;
  savedLoading.value = true;
  savedProblem.value = null;
  try {
    const lines = await listActivities(id);
    if (taskId.value === id) saved.value = lines;
  } catch (cause) {
    savedProblem.value = errorText(cause);
  } finally {
    savedLoading.value = false;
  }
}
watch([tab, taskId, working], () => {
  if (tab.value === 'activity') void readSaved();
});

/** Esc closes the panel, unless something else used it (the "/" menu of the chat) or the user is writing. */
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  emit('close');
}
const closeButton = ref<HTMLButtonElement | null>(null);
onMounted(() => {
  window.addEventListener('keydown', onKey);
  closeButton.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <aside class="fixed inset-y-0 right-0 z-40 flex w-full max-w-[560px] flex-col border-l border-line bg-surface shadow-[0_14px_40px_#0006]" aria-labelledby="computer-title">
    <header class="flex items-start gap-2 border-b border-line px-5 py-4">
      <div class="min-w-0 flex-1">
        <h2 id="computer-title" class="flex items-center gap-2 text-[16px] font-semibold"><Icon name="computer" :size="16" />Computer del Coder</h2>
        <p class="mt-1 text-xs text-muted">
          <template v-if="taskId === undefined">Nessun lavoro del Coder in questa conversazione.</template>
          <template v-else-if="working">Al lavoro adesso. Puoi solo guardare: da qui non si scrive nulla al Coder.</template>
          <template v-else>Lavoro finito · {{ status === undefined ? '' : STATUS_TEXT[status] }}</template>
        </p>
        <button
          type="button"
          class="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[12px] text-ink hover:bg-surface-2"
          :aria-expanded="cageOpen"
          @click="cageOpen = !cageOpen"
        >
          <Icon name="private" :size="12" />Isolato · solo {{ cageFolder }} · rete spenta · tu guardi soltanto
        </button>
        <ul v-if="cageOpen" class="mt-2 flex list-disc flex-col gap-1 pl-5 text-[12px] text-muted">
          <li v-for="line in CAGE_LINES" :key="line">{{ line }}</li>
          <li>Per vederlo coi tuoi occhi: chiedi al Coder di leggere un file della tua home o di scaricare una pagina; nel Terminale il tentativo compare con «Bloccato dall'isolamento».</li>
        </ul>
      </div>
      <button ref="closeButton" type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" aria-label="Chiudi il computer del Coder" @click="emit('close')">
        <Icon name="close" :size="16" />
      </button>
    </header>

    <div class="flex gap-1 border-b border-line px-4" role="tablist" aria-label="Viste del computer del Coder">
      <button
        v-for="item in COMPUTER_TABS"
        :key="item"
        type="button"
        role="tab"
        class="-mb-px border-b-2 px-3 py-2 text-[14px] whitespace-nowrap"
        :class="tab === item ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'"
        :aria-selected="tab === item"
        @click="tab = item"
      >
        {{ TAB_TEXT[item] }}
      </button>
    </div>

    <!-- Terminale: commands and outputs of Bash, live while the run works, then as saved -->
    <section v-if="tab === 'terminal'" class="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-label="Terminale">
      <div ref="screen" class="min-h-0 flex-1 overflow-y-auto bg-surface-2 px-4 py-3 font-mono text-[12.5px] leading-[1.55]" @scroll.passive="onScreenScroll">
        <p v-if="terminalProblem !== null && calls.length === 0" class="font-sans text-[13px] text-warn">{{ terminalProblem }}</p>
        <p v-else-if="terminalLoading && calls.length === 0" class="font-sans text-[13px] text-muted">Carico i comandi…</p>
        <p v-else-if="calls.length === 0" class="font-sans text-[13px] text-muted">
          {{ working ? 'Nessun comando ancora: appena il Coder ne lancia uno, compare qui.' : 'Il Coder non ha lanciato comandi in questo lavoro.' }}
        </p>
        <div v-for="call in calls" :key="call.callId" class="mb-3 last:mb-0">
          <template v-if="call.command !== undefined && call.command.text !== undefined">
            <pre class="break-words whitespace-pre-wrap text-ink"><span class="text-accent select-none" aria-hidden="true">$ </span>{{ call.command.text }}</pre>
            <p v-for="note in notes(call.command)" :key="note" class="font-sans text-[12px] text-warn">{{ note }}</p>
          </template>
          <template v-if="call.output !== undefined && call.output.text !== undefined">
            <pre v-if="call.output.text !== ''" class="mt-1 break-words whitespace-pre-wrap" :class="call.output.error ? 'text-danger' : 'text-muted'">{{ call.output.text }}</pre>
            <p v-else-if="!call.output.refused" class="mt-1 font-sans text-[12px] text-muted">(nessuna uscita)</p>
            <p v-if="sandboxRefusal(call.output.text)" class="mt-1 inline-flex items-center gap-1 rounded-md bg-danger/15 px-1.5 py-0.5 font-sans text-[12px] font-medium text-danger">
              <Icon name="private" :size="12" />Bloccato dall'isolamento
            </p>
            <p v-for="note in notes(call.output)" :key="note" class="font-sans text-[12px] text-warn">{{ note }}</p>
          </template>
          <p v-else-if="working" class="mt-1 font-sans text-[12px] text-muted">In corso…</p>
        </div>
      </div>
      <p class="border-t border-line px-4 py-2 text-[12px] text-muted">
        Comandi e uscite restano salvati con la conversazione (mai in incognito) e si cancellano con lei. Arianna nasconde i valori del vault, non le password scritte nei file del progetto (come un <code>.env</code>).
      </p>
    </section>

    <!-- File: paths while the run works, the files of the delegation once it ended -->
    <section v-else-if="tab === 'files'" class="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13.5px]" role="tabpanel" aria-label="File">
      <p v-if="files === undefined" class="text-muted">Nessun file da mostrare.</p>
      <template v-else-if="files.mode === 'live'">
        <p class="mb-2 text-xs text-muted">{{ working ? 'I file che il Coder sta cambiando. Il contenuto si apre a lavoro finito.' : 'I file che il Coder ha cambiato.' }}</p>
        <p v-if="files.paths.length === 0" class="text-muted">Nessun file cambiato finora.</p>
        <ul v-else class="flex flex-col gap-1 font-mono text-[12.5px]">
          <li v-for="path in files.paths" :key="path" class="flex items-center gap-2 break-all"><Icon name="file" :size="13" />{{ path }}</li>
        </ul>
      </template>
      <template v-else>
        <p class="mb-2 text-xs text-muted">I file cambiati dal lavoro<template v-if="files.repo !== null"> in {{ files.repo }}</template>, come sono adesso. Tocca un file per leggerlo.</p>
        <p v-if="files.files.length === 0" class="text-muted">Il lavoro non ha cambiato file.</p>
        <ul v-else class="flex flex-col rounded-lg border border-line">
          <li v-for="(file, index) in files.files" :key="`${file.change}:${file.path}`" class="border-b border-line last:border-b-0">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
              :disabled="!mayReadFile(files, index)"
              :aria-expanded="openFile === index"
              @click="showFile(index)"
            >
              <span class="shrink-0 font-mono text-[12px] text-muted">{{ CHANGE_TEXT[file.change] }}</span>
              <span class="min-w-0 flex-1 font-mono text-[12.5px] break-all">{{ file.path }}</span>
            </button>
            <div v-if="openFile === index" class="border-t border-line px-3 py-2">
              <p v-if="previewLoading" class="text-xs text-muted">Apro il file…</p>
              <p v-else-if="previewProblem !== null" class="text-xs text-warn">{{ previewProblem }}</p>
              <MarkdownText v-else-if="preview !== null" :source="codeFence(preview.text, preview.path)" />
            </div>
          </li>
        </ul>
      </template>
    </section>

    <!-- Attività: the activity lines, live and then saved (D-083) -->
    <section v-else class="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13.5px]" role="tabpanel" aria-label="Attività">
      <template v-if="working">
        <p v-if="live.length === 0" class="text-muted">Nessun passo ancora.</p>
        <ul v-else class="flex flex-col gap-[5px]">
          <li v-for="(line, index) in live" :key="`${String(line.step)}:${String(index)}`" class="flex items-start gap-2.5">
            <span class="w-4 shrink-0 text-center font-mono text-[12.5px]" :class="(line.kind === 'error' || line.kind === 'stop') ? 'text-warn' : 'text-accent'" aria-hidden="true">{{ (line.kind === 'error' || line.kind === 'stop') ? '!' : '›' }}</span>
            <span class="min-w-0 flex-1 break-words">{{ activityText(line) }}</span>
          </li>
        </ul>
      </template>
      <template v-else>
        <p v-if="taskId === undefined" class="text-muted">Nessun passo da mostrare.</p>
        <p v-else-if="savedLoading" class="text-xs text-muted">Carico i passi…</p>
        <p v-else-if="savedProblem !== null" class="text-xs text-warn">{{ savedProblem }}</p>
        <p v-else-if="saved !== null && saved.length === 0" class="text-muted">Nessun passo salvato.</p>
        <ul v-else-if="saved !== null" class="flex flex-col gap-[5px]">
          <li v-for="line in saved" :key="line.id" class="flex items-start gap-2.5">
            <span class="w-4 shrink-0 text-center font-mono text-[12.5px]" :class="(line.kind === 'error' || line.kind === 'stop') ? 'text-warn' : 'text-ok'" aria-hidden="true">{{ (line.kind === 'error' || line.kind === 'stop') ? '!' : '✓' }}</span>
            <span class="min-w-0 flex-1 break-words">{{ activityText(line) }}</span>
          </li>
        </ul>
      </template>
    </section>
  </aside>
</template>

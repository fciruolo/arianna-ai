<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import { captureNote, deleteNote, fetchNoteLink, listNotes, loadArchive, loadNote, loadNoteVideo, organizeNote, proposeForWiki, summarizeNoteVideo } from '../lib/api.ts';
import { DELETE_NOTE_TEXT } from '../lib/erase.ts';
import { MAX_NOTE_BYTES } from '../lib/capture.ts';
import {
  errorText,
  THOUGHT_MIC_HINT,
  THOUGHT_PLACEHOLDER,
  THOUGHT_SAVED_TEXT,
  THOUGHT_SAVED_UNQUEUED_TEXT,
  THOUGHT_STATE_HINT,
  THOUGHT_STATE_TEXT,
} from '../lib/italian.ts';
import {
  byteLength,
  canFetch,
  displayTitle,
  fetchSettled,
  filterThoughts,
  graphId,
  groupThoughts,
  kindText,
  noteDate,
  noteName,
  POLL_EVERY_MS,
  shouldPoll,
  sizeCounter,
  thoughtCapture,
  thoughtState,
  wikilinkTarget,
  type LocalMark,
  type Note,
  type NoteSummary,
  type StatusFilter,
} from '../lib/thoughts.ts';
import { canSummarizeVideo, isYoutubeVideo, VIDEO_CONFIRM_LINES, videoFacts, videoJobText, type VideoJob } from '../lib/video.ts';
import ArchiveProposals from './ArchiveProposals.vue';
import DeleteConfirm from './DeleteConfirm.vue';
import LabelBadge from './LabelBadge.vue';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';
import PageHeader from './PageHeader.vue';
import VideoNote from './VideoNote.vue';

/**
 * "Pensieri" (D-090): a large field to write a thought, saved at once in
 * kb/inbox and organized in the background by the local model (D-086); below,
 * the thoughts by day, each readable in the panel on the right.
 */

const emit = defineEmits<{
  /** "Apri nel grafo": the node id of the knowledge page (relative to kb/). */
  openGraph: [nodeId: string];
}>();

const draft = ref('');
const field = ref<HTMLTextAreaElement | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const saved = ref<string | null>(null);

const notes = ref<NoteSummary[]>([]);
const hidden = ref(0);
const loading = ref(true);
const listError = ref<string | null>(null);
const query = ref('');
/** The filters of the list, and "Da archiviare" (D-195), the proposals of the Archivist. */
const status = ref<StatusFilter | 'archive'>('all');
const archiveCount = ref(0);
const now = ref(Date.now());
const marks = ref<Record<string, LocalMark>>({});

const selectedName = ref<string | null>(null);
const note = ref<Note | null>(null);
const noteLoading = ref(false);
const noteError = ref<string | null>(null);
const requeueing = ref(false);
const panelNotice = ref<string | null>(null);
/** The note whose link is being downloaded and summarized (D-154). */
const fetching = ref<string | null>(null);
/** The thought waiting for the user to confirm its deletion for good (D-157), and the one being deleted. */
const deleting = ref<string | null>(null);
/** The same from the panel of the open thought. */
const deletingOpen = ref(false);
const removing = ref(false);
const deleteError = ref<string | null>(null);
/** «Riassumi il video» (D-273): the card that asks the approval for this video, and the job of the open note. */
const videoConfirm = ref(false);
const videoSending = ref(false);
const videoJob = ref<VideoJob | null>(null);
const videoWorking = computed(() => videoJob.value !== null && (videoJob.value.state === 'queued' || videoJob.value.state === 'running'));

const counter = computed(() => sizeCounter(draft.value));
const tooLarge = computed(() => byteLength(draft.value) > MAX_NOTE_BYTES);
const shown = computed(() => filterThoughts(notes.value, query.value, status.value === 'archive' ? 'all' : status.value));
const groups = computed(() => groupThoughts(shown.value, new Date(now.value)));
const selected = computed(() => notes.value.find((item) => item.name === selectedName.value));
const selectedState = computed(() => (selected.value === undefined ? undefined : stateOf(selected.value)));
const counts = computed(() => ({
  all: notes.value.length,
  new: notes.value.filter((item) => item.status !== 'organized').length,
  organized: notes.value.filter((item) => item.status === 'organized').length,
  archive: archiveCount.value,
}));

const STATUS_FILTERS: { value: StatusFilter | 'archive'; text: string }[] = [
  { value: 'all', text: 'Tutti' },
  { value: 'new', text: 'Da riordinare' },
  { value: 'organized', text: 'Riordinati' },
  { value: 'archive', text: 'Da archiviare' },
];


function stateOf(item: NoteSummary) {
  return thoughtState(item, now.value, marks.value[item.name]);
}

function timeOf(item: NoteSummary): string {
  const iso = noteDate(item);
  if (iso === null) return '';
  const date = new Date(iso);
  const today = new Date(now.value).toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The field grows with the text, up to a limit. */
function resize(): void {
  const element = field.value;
  if (element === null) return;
  element.style.height = 'auto';
  element.style.height = `${String(Math.min(element.scrollHeight, 360))}px`;
}

let pollStartedAt: number | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

/** Reloads every few seconds while a thought is being organized, up to the cap of lib/thoughts.ts. */
function schedule(): void {
  clearTimeout(timer);
  if (!alive || !shouldPoll(notes.value, pollStartedAt, Date.now(), marks.value)) return;
  timer = setTimeout(() => {
    void refresh().then(schedule);
  }, POLL_EVERY_MS);
}

function startPolling(): void {
  pollStartedAt = Date.now();
  schedule();
}

async function refresh(): Promise<void> {
  try {
    const listing = await listNotes();
    now.value = Date.now();
    notes.value = listing.notes;
    hidden.value = listing.hidden;
    listError.value = null;
    // The count of "Da archiviare": a failure leaves the last one.
    loadArchive()
      .then((archive) => {
        archiveCount.value = archive.proposals.filter((item) => item.state === 'proposed').length;
      })
      .catch(() => undefined);
    // The note open in the panel was organized meanwhile: its text changed.
    const open = selected.value;
    if (open !== undefined && note.value !== null && note.value.name === open.name && note.value.status !== open.status) void read(open.name);
  } catch (cause) {
    listError.value = `Non riesco a caricare i pensieri. ${errorText(cause)}`;
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (saving.value) return;
  saved.value = null;
  const checked = thoughtCapture(draft.value);
  if ('error' in checked) {
    saveError.value = checked.error;
    return;
  }
  saveError.value = null;
  saving.value = true;
  try {
    const result = await captureNote(checked.capture);
    const name = noteName(result.path);
    if (result.organizing === false) marks.value = { ...marks.value, [name]: { failed: true } };
    saved.value = result.organizing === false ? THOUGHT_SAVED_UNQUEUED_TEXT : THOUGHT_SAVED_TEXT;
    draft.value = '';
    await nextTick();
    resize();
    await refresh();
    startPolling();
  } catch (cause) {
    saveError.value = errorText(cause);
  } finally {
    saving.value = false;
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    void save();
  }
}

let readRequest = 0;
async function read(name: string): Promise<void> {
  const request = ++readRequest;
  noteLoading.value = true;
  noteError.value = null;
  try {
    const loaded = await loadNote(name);
    if (request === readRequest) {
      note.value = loaded;
      if (isYoutubeVideo(loaded.url) && (loaded.video ?? null) === null) void watchVideo(name);
    }
  } catch (cause) {
    if (request === readRequest) noteError.value = errorText(cause);
  } finally {
    if (request === readRequest) noteLoading.value = false;
  }
}

function open(name: string): void {
  panelNotice.value = null;
  deletingOpen.value = false;
  videoConfirm.value = false;
  videoJob.value = null;
  if (selectedName.value === name) return;
  selectedName.value = name;
  note.value = null;
  void read(name);
}

function closePanel(): void {
  videoConfirm.value = false;
  videoJob.value = null;
  clearTimeout(videoTimer);
  selectedName.value = null;
  note.value = null;
  noteError.value = null;
  panelNotice.value = null;
  deletingOpen.value = false;
  readRequest += 1;
}

/** A `[[wikilink]]` of the text: another thought opens here, any other page in the graph. */
function followWikilink(target: string): void {
  const where = wikilinkTarget(target);
  if (where === undefined) {
    panelNotice.value = `«${target}» non è un collegamento valido.`;
    return;
  }
  if ('note' in where) {
    if (notes.value.some((item) => item.name === where.note)) open(where.note);
    else panelNotice.value = `«${target}» non è fra i pensieri che posso mostrarti.`;
    return;
  }
  emit('openGraph', where.graph);
}

async function organizeAgain(): Promise<void> {
  const item = selected.value;
  if (item === undefined || requeueing.value) return;
  requeueing.value = true;
  panelNotice.value = null;
  try {
    await organizeNote(item.name);
    marks.value = { ...marks.value, [item.name]: { queuedAt: Date.now() } };
    now.value = Date.now();
    panelNotice.value = 'Rimesso in coda: il modello locale lo riordina fra poco.';
    startPolling();
  } catch (cause) {
    panelNotice.value = errorText(cause);
    void refresh();
  } finally {
    requeueing.value = false;
  }
}

const FETCH_POLL_MS = 3_000;
/** The model may wait for a call or a task to end: the panel stops looking after this long. */
const FETCH_WAIT_MS = 5 * 60_000;
let fetchTimer: ReturnType<typeof setTimeout> | undefined;

/** "Scarica e riassumi" (D-154): the core downloads the link and the local model organizes the note again. */
async function fetchAndSummarize(): Promise<void> {
  const current = note.value;
  if (current === null || fetching.value !== null || !canFetch(current)) return;
  const name = current.name;
  fetching.value = name;
  panelNotice.value = null;
  try {
    await fetchNoteLink(name);
  } catch (cause) {
    fetching.value = null;
    panelNotice.value = errorText(cause);
    return;
  }
  const started = Date.now();
  const look = (): void => {
    fetchTimer = setTimeout(() => {
      void (async () => {
        if (!alive || fetching.value !== name) return;
        try {
          const loaded = await loadNote(name);
          if (fetchSettled(current, loaded)) {
            fetching.value = null;
            if (selectedName.value === name) {
              note.value = loaded;
              panelNotice.value = loaded.fetchFailed ? 'Non sono riuscita a scaricare il link: il motivo è nella sezione «Contenuto».' : null;
            }
            void refresh();
            return;
          }
        } catch {
          // Read again at the next look.
        }
        if (Date.now() - started > FETCH_WAIT_MS) {
          fetching.value = null;
          if (selectedName.value === name) panelNotice.value = 'Il riassunto del link non è ancora pronto: il modello locale potrebbe essere occupato. Riapri il pensiero più tardi.';
          return;
        }
        look();
      })();
    }, FETCH_POLL_MS);
  };
  look();
}

const VIDEO_POLL_MS = 3_000;
let videoTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The job of the video of the open note (D-273): read now and again every few
 * seconds while it is queued or at work; once done, the note is read again.
 * A job may wait for a call to end, or take long for the audio: no time cap,
 * the polling stops when the panel closes or shows another note.
 */
async function watchVideo(name: string): Promise<void> {
  clearTimeout(videoTimer);
  if (!alive || selectedName.value !== name) return;
  try {
    const job = await loadNoteVideo(name);
    if (selectedName.value !== name) return;
    const wasWorking = videoWorking.value;
    videoJob.value = job;
    if (job?.state === 'done' && wasWorking) {
      await read(name);
      void refresh();
      return;
    }
  } catch {
    // Read again at the next look.
  }
  if (videoWorking.value) {
    videoTimer = setTimeout(() => {
      void watchVideo(name);
    }, VIDEO_POLL_MS);
  }
}

/** «Approva per questo video»: the approval of the user for this one video, then the job in the queue of the core. */
async function approveVideo(): Promise<void> {
  const current = note.value;
  if (current === null || videoSending.value || !canSummarizeVideo(current)) return;
  videoSending.value = true;
  panelNotice.value = null;
  try {
    await summarizeNoteVideo(current.name);
    videoConfirm.value = false;
    videoJob.value = { state: 'queued' };
    void watchVideo(current.name);
  } catch (cause) {
    panelNotice.value = errorText(cause);
  } finally {
    videoSending.value = false;
  }
}

const wikiSending = ref(false);

/** «Proponi per la Wiki» (D-280): the local model prepares a proposal from this thought, in the background. */
async function proposeWiki(): Promise<void> {
  const current = note.value;
  if (current === null || wikiSending.value || current.status !== 'organized') return;
  wikiSending.value = true;
  panelNotice.value = null;
  try {
    await proposeForWiki(`inbox/${current.name}`);
    panelNotice.value = 'Proposta in preparazione: la trovi nella Wiki, scheda Proposte.';
  } catch (cause) {
    panelNotice.value = errorText(cause);
  } finally {
    wikiSending.value = false;
  }
}

/** A thought approved or discarded in "Da archiviare": the list again; a thought moved out of the inbox leaves the panel. */
async function afterArchive(): Promise<void> {
  await refresh();
  if (selectedName.value !== null && !notes.value.some((item) => item.name === selectedName.value)) closePanel();
}

/** "Elimina" confirmed: the file of the thought goes for good; the list and the panel let it go. */
async function removeThought(name: string): Promise<void> {
  if (removing.value) return;
  removing.value = true;
  deleteError.value = null;
  try {
    await deleteNote(name);
    deleting.value = null;
    deletingOpen.value = false;
    if (selectedName.value === name) closePanel();
    notes.value = notes.value.filter((item) => item.name !== name);
    await refresh();
  } catch (cause) {
    deleteError.value = `Non ho eliminato il pensiero. ${errorText(cause)}`;
  } finally {
    removing.value = false;
  }
}

function onWindowKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selectedName.value !== null) closePanel();
}

onMounted(async () => {
  window.addEventListener('keydown', onWindowKey);
  field.value?.focus();
  await refresh();
  // Thoughts saved elsewhere (the chat, Telegram) may still be organizing.
  startPolling();
});

onBeforeUnmount(() => {
  alive = false;
  clearTimeout(timer);
  clearTimeout(fetchTimer);
  clearTimeout(videoTimer);
  window.removeEventListener('keydown', onWindowKey);
});
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
        <PageHeader title="Pensieri" title-id="thoughts-title">
          Scrivi un pensiero e basta: il modello locale gli dà titolo, riassunto, collegamenti e tag, poi propone dove archiviarlo. Restano in <span class="font-mono text-[13px]">kb/inbox</span>, Privati, su questo computer.
          <template #actions>
            <span class="pill">{{ counts.all === 1 ? '1 pensiero' : `${String(counts.all)} pensieri` }}</span>
            <button type="button" class="btn px-2.5 py-1 text-[13.5px]" aria-label="Aggiorna l’elenco" @click="refresh"><Icon name="retry" :size="14" />Aggiorna</button>
          </template>
        </PageHeader>

        <!-- The field -->
        <section class="rounded-xl border border-line bg-surface-2 p-4" aria-label="Nuovo pensiero">
          <form @submit.prevent="save">
            <label for="thought" class="sr-only">Pensiero</label>
            <textarea
              id="thought"
              ref="field"
              v-model="draft"
              rows="3"
              :placeholder="THOUGHT_PLACEHOLDER"
              class="block max-h-[360px] min-h-[88px] w-full resize-none rounded-lg border border-line-strong bg-surface px-3.5 py-3 text-[15px] leading-relaxed text-ink outline-none placeholder:text-muted"
              :aria-invalid="tooLarge"
              aria-describedby="thought-help"
              @keydown="onKey"
              @input="resize"
            />
            <div class="mt-2.5 flex flex-wrap items-center gap-2">
              <p id="thought-help" class="min-w-0 flex-1 text-[13px] text-muted">
                <!-- D-294: a finger has no ⌘ to press; «Salva» is the button beside. -->
                <span class="touch:hidden">⌘/Ctrl+Invio per salvare · </span>il modello locale scrive titolo, riassunto, collegamenti e tag, il tuo testo resta in fondo
                <span v-if="counter !== undefined" :class="tooLarge ? 'text-danger' : ''"> · {{ counter }}</span>
              </p>
              <button
                type="button"
                class="btn px-2.5 opacity-50"
                aria-disabled="true"
                :aria-label="`Detta un pensiero: ${THOUGHT_MIC_HINT}`"
                :title="THOUGHT_MIC_HINT"
                @click.prevent
              >
                <Icon name="mic" :size="16" />
              </button>
              <button type="submit" class="btn btn-primary" :disabled="saving || draft.trim() === '' || tooLarge">
                <Icon name="saved" :size="16" />{{ saving ? 'Salvo…' : 'Salva' }}
              </button>
            </div>
          </form>
          <p v-if="saveError !== null" role="alert" class="mt-2.5 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ saveError }}</p>
          <p v-else-if="saved !== null" role="status" class="mt-2.5 flex items-center gap-2 text-[13px] text-muted">
            <Icon name="saved" :size="13" />{{ saved }}
          </p>
        </section>

        <!-- Filters -->
        <section aria-label="Elenco dei pensieri" class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <label class="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
              <Icon name="search" :size="14" />
              <input
                v-model="query"
                type="search"
                class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
                placeholder="Filtra per testo o #tag"
                aria-label="Filtra i pensieri per titolo, tipo o tag"
              />
            </label>
            <div class="flex rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label="Stato">
              <button
                v-for="item in STATUS_FILTERS"
                :key="item.value"
                type="button"
                role="radio"
                :aria-checked="status === item.value"
                class="rounded-md px-2.5 py-1 text-[13.5px] touch:min-h-11"
                :class="status === item.value ? 'bg-surface-2 font-semibold text-ink' : 'text-muted hover:text-ink'"
                @click="status = item.value"
              >
                {{ item.text }} <span :class="item.value === 'archive' && counts.archive > 0 ? 'font-semibold text-accent' : 'text-muted'">{{ counts[item.value] }}</span>
              </button>
            </div>
          </div>

          <ArchiveProposals v-if="status === 'archive'" @open="open" @changed="afterArchive" @count="archiveCount = $event" />
          <template v-else>
          <p v-if="listError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ listError }}</p>
          <p v-if="loading && notes.length === 0" class="py-6 text-center text-[14px] text-muted">Carico i pensieri…</p>
          <p v-else-if="!loading && notes.length === 0 && listError === null" class="py-6 text-center text-sm text-muted">
            Ancora nessun pensiero: scrivine uno qui sopra, o usa «/nota» nella chat.
          </p>
          <p v-else-if="shown.length === 0 && notes.length > 0" class="py-4 text-center text-sm text-muted">Nessun pensiero corrisponde al filtro.</p>

          <div v-for="group in groups" :key="group.title">
            <h2 class="mx-1 mb-1.5 text-[13px] font-semibold text-muted">{{ group.title }}</h2>
            <ul class="flex flex-col gap-1.5">
              <li v-for="item in group.items" :key="item.name" class="group relative">
                <DeleteConfirm
                  v-if="deleting === item.name"
                  :subject="displayTitle(item)"
                  :text="DELETE_NOTE_TEXT"
                  :extra="deleteError"
                  :busy="removing"
                  @confirm="removeThought(item.name)"
                  @cancel="
                    deleting = null;
                    deleteError = null;
                  "
                />
                <button
                  v-else
                  type="button"
                  class="flex w-full flex-col gap-1.5 rounded-xl border px-3.5 py-2.5 pr-10 text-left transition-colors touch:min-h-11"
                  :class="selectedName === item.name ? 'border-accent bg-surface-2' : 'border-line bg-surface hover:border-line-strong'"
                  :aria-current="selectedName === item.name ? 'true' : undefined"
                  @click="open(item.name)"
                >
                  <span class="flex items-start gap-2">
                    <span class="min-w-0 flex-1 text-[14px] leading-snug font-medium break-words">{{ displayTitle(item) }}</span>
                    <span class="shrink-0 text-[13px] text-muted tabular-nums">{{ timeOf(item) }}</span>
                  </span>
                  <span class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted">
                    <span class="inline-flex items-center gap-1"><Icon v-if="item.media === 'youtube'" name="video" :size="13" />{{ item.media === 'youtube' ? 'Video' : kindText(item) }}</span>
                    <span
                      class="inline-flex items-center gap-1.5"
                      :class="{ 'text-accent': stateOf(item) === 'organizing', 'text-ok': stateOf(item) === 'organized', 'text-warn': stateOf(item) === 'stuck' }"
                      :title="THOUGHT_STATE_HINT[stateOf(item)]"
                    >
                      <span
                        class="size-[6px] rounded-full"
                        :class="{
                          'animate-hud-blink bg-accent shadow-[0_0_6px_var(--accent)]': stateOf(item) === 'organizing',
                          'bg-ok': stateOf(item) === 'organized',
                          'bg-warn': stateOf(item) === 'stuck',
                        }"
                      />
                      {{ THOUGHT_STATE_TEXT[stateOf(item)] }}
                    </span>
                    <span v-for="tag in item.tags" :key="tag" class="font-mono text-[12.5px] text-ink/70">#{{ tag }}</span>
                  </span>
                  <span v-if="stateOf(item) === 'organizing'" class="hud-scan w-full" aria-hidden="true" />
                </button>
                <button
                  v-if="deleting !== item.name"
                  type="button"
                  class="absolute right-2 bottom-2 rounded-md p-1 text-muted transition hover:text-danger md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 touch:min-h-11"
                  :aria-label="`Elimina per sempre ${displayTitle(item)}`"
                  title="Elimina per sempre"
                  @click="
                    deleteError = null;
                    deleting = item.name;
                  "
                >
                  <Icon name="delete" :size="15" />
                </button>
              </li>
            </ul>
          </div>
          <p v-if="hidden > 0" class="text-[13px] text-muted">{{ hidden }} pensieri sopra Privato non sono mostrati.</p>
          </template>
        </section>
      </div>
    </div>

    <!-- The thought open: on the right on wide screens, the whole width otherwise -->
    <aside
      v-if="selectedName !== null"
      class="absolute inset-0 z-10 flex flex-col bg-surface lg:static lg:z-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line"
      aria-label="Pensiero aperto"
    >
      <header class="flex items-start gap-2 border-b border-line px-4 pt-3.5 pb-3">
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
            <span>{{ selected === undefined ? 'Pensiero' : kindText(selected) }}</span>
            <span v-if="selectedState !== undefined">· {{ THOUGHT_STATE_TEXT[selectedState] }}</span>
            <span v-if="selected !== undefined && timeOf(selected) !== ''">· {{ timeOf(selected) }}</span>
          </p>
          <h2 class="mt-1 text-[17px] leading-snug font-semibold break-words">
            {{ note?.title ?? (selected === undefined ? selectedName : displayTitle(selected)) }}
          </h2>
          <p v-if="note !== null && note.name === selectedName && note.video" class="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
            <Icon name="video" :size="14" />{{ videoFacts(note.video) }}
          </p>
        </div>
        <LabelBadge v-if="selected !== undefined" class="mt-0.5" :label="selected.label" />
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink touch:min-h-11" aria-label="Chiudi il pensiero" @click="closePanel">
          <Icon name="close" :size="16" />
        </button>
      </header>
      <div class="flex flex-wrap gap-2 border-b border-line px-4 py-2.5">
        <button v-if="selectedState === 'stuck'" type="button" class="btn px-2.5 py-1 text-xs" :disabled="requeueing" @click="organizeAgain">
          <Icon name="retry" :size="14" />Riordina di nuovo
        </button>
        <button
          v-if="note !== null && note.name === selectedName && canFetch(note) && selectedState !== 'organizing'"
          type="button"
          class="btn px-2.5 py-1 text-xs"
          :disabled="fetching !== null"
          title="Arianna scarica il link e il modello locale lo riassume nel pensiero; il sito riceve solo l’indirizzo"
          @click="fetchAndSummarize"
        >
          <Icon name="link" :size="14" />{{ fetching === note.name ? 'Scarico e riassumo…' : 'Scarica e riassumi' }}
        </button>
        <button
          v-if="note !== null && note.name === selectedName && canSummarizeVideo(note) && !videoWorking"
          type="button"
          class="btn px-2.5 py-1 text-xs"
          :disabled="videoSending"
          :aria-expanded="videoConfirm"
          title="Arianna legge i sottotitoli (o l’audio) del video e il modello locale lo riassume nel pensiero; prima ti chiede l’approvazione"
          @click="videoConfirm = !videoConfirm"
        >
          <Icon name="video" :size="14" />Riassumi il video
        </button>
        <button v-if="selected !== undefined" type="button" class="btn px-2.5 py-1 text-xs" @click="emit('openGraph', graphId(selected.path))">
          <Icon name="knowledge" :size="14" />Apri nel grafo
        </button>
        <button
          v-if="note !== null && note.name === selectedName && note.status === 'organized'"
          type="button"
          class="btn px-2.5 py-1 text-xs"
          :disabled="wikiSending"
          title="Il modello locale propone cosa aggiungere alla Wiki da questo pensiero; la pagina cambia solo se approvi"
          @click="proposeWiki"
        >
          <Icon name="wiki" :size="14" />Proponi per la Wiki
        </button>
        <button
          v-if="selected !== undefined"
          type="button"
          class="btn px-2.5 py-1 text-xs hover:text-danger"
          @click="
            deleteError = null;
            deletingOpen = true;
          "
        >
          <Icon name="delete" :size="14" />Elimina
        </button>
      </div>
      <div v-if="videoConfirm && note !== null && canSummarizeVideo(note)" class="border-b border-line px-4 py-3" role="group" aria-labelledby="video-confirm-title">
        <p id="video-confirm-title" class="mb-1.5 text-[14px] font-semibold">Riassumo questo video?</p>
        <ul class="mb-2.5 flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted">
          <li v-for="line in VIDEO_CONFIRM_LINES" :key="line">{{ line }}</li>
        </ul>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="videoSending" @click="approveVideo">
            <Icon name="video" :size="14" />{{ videoSending ? 'Metto in coda…' : 'Approva per questo video' }}
          </button>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="videoSending" @click="videoConfirm = false">Annulla</button>
        </div>
      </div>
      <div v-if="selected !== undefined && deletingOpen" class="border-b border-line px-4 py-2.5">
        <DeleteConfirm
          :subject="displayTitle(selected)"
          :text="DELETE_NOTE_TEXT"
          :extra="deleteError"
          :busy="removing"
          @confirm="removeThought(selected.name)"
          @cancel="
            deletingOpen = false;
            deleteError = null;
          "
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div v-if="fetching !== null && fetching === selectedName" class="mb-3">
          <p class="mb-1.5 font-mono text-[12.5px] text-accent">Scarico il link e lo riassumo col modello locale…</p>
          <span class="hud-scan block w-full" aria-hidden="true" />
        </div>
        <div v-if="videoJobText(videoJob) !== null" class="mb-3" role="status">
          <p class="mb-1.5 font-mono text-[12.5px]" :class="videoJob?.state === 'failed' ? 'text-warn' : 'text-accent'">{{ videoJobText(videoJob) }}</p>
          <span v-if="videoWorking" class="hud-scan block w-full" aria-hidden="true" />
        </div>
        <div v-if="selectedState === 'organizing'" class="mb-3">
          <p class="mb-1.5 font-mono text-[12.5px] text-accent">{{ THOUGHT_STATE_HINT.organizing }}…</p>
          <span class="hud-scan block w-full" aria-hidden="true" />
        </div>
        <div v-if="selected !== undefined && selected.tags.length > 0" class="mb-3 flex flex-wrap gap-1.5">
          <button
            v-for="tag in selected.tags"
            :key="tag"
            type="button"
            class="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[12.5px] text-muted hover:border-accent hover:text-accent touch:min-h-11"
            :title="`Filtra #${tag}`"
            @click="query = `#${tag}`"
          >
            #{{ tag }}
          </button>
        </div>
        <p v-if="panelNotice !== null" class="mb-2 text-xs text-warn" role="status">{{ panelNotice }}</p>
        <p v-if="noteLoading && note === null" class="font-mono text-xs text-muted">Leggo il pensiero…</p>
        <p v-else-if="noteError !== null" class="text-sm text-danger">{{ noteError }}</p>
        <template v-if="note !== null && note.name === selectedName">
          <VideoNote v-if="note.video" :body="note.body" :video-id="note.video.id" :wikilink="followWikilink" />
          <MarkdownText v-else :source="note.body" :wikilink="followWikilink" />
        </template>
      </div>
    </aside>
  </div>
</template>

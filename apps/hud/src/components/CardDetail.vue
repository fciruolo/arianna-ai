<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { cloudSkills } from '../lib/claude-skills.ts';
import {
  addCardDependency,
  addCardLink,
  addChecklistItem,
  cardAction,
  listActivities,
  sendBackCard,
  cardFileUrl,
  listDesignStyles,
  listSkills,
  loadCardDetail,
  markCommitmentDone,
  moveCard,
  removeCardDependency,
  removeCardFile,
  removeCardLink,
  removeChecklistItem,
  updateCard,
  updateChecklistItem,
  uploadCardFile,
  type CardFieldsInput,
} from '../lib/api.ts';
import {
  assigneeLocked,
  blockedText,
  type Card,
  type CardAction,
  CARD_ACTION_TEXT,
  cardActions,
  NOT_STOPPED_TEXT,
  type CardDetailData,
  cardErrorText,
  type ChecklistItem,
  COMMITMENT_STATUS_TEXT,
  dataUrlBase64,
  dependencyChoices,
  designChoices,
  DESIGNER_AGENT,
  dueText,
  fileKindText,
  fileRefusal,
  fileSizeText,
  historyLines,
  isImage,
  isWebAddress,
  linkText,
  MAX_CARD_SKILLS,
  MAX_CRITERIA,
  MAX_GOAL,
  MAX_ITEM,
  MAX_TITLE,
  moveButtons,
  type MoveTarget,
  opensInline,
  PRIORITY_TEXT,
  progressPercent,
  stateText,
  STATUS_COLUMN_TEXT,
} from '../lib/cardwall.ts';
import { activityText, agentName, reasonText, relativeTimeText } from '../lib/italian.ts';
import { milestoneChoices, type Milestone } from '../lib/milestones.ts';
import { CHOICE_TEXT } from '../lib/labels.ts';
import { listUserAgents } from '../lib/user-agents.ts';
import { useModal } from '../lib/modal.ts';
import type { Approval, ExecutorChoice, SavedActivity } from '../lib/types.ts';
import ApprovalCard from './ApprovalCard.vue';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * The page of a card of the cardwall (I-13, D-152), a wide panel on the
 * right. A task is changed in place: title, properties, "Descrizione" in
 * Markdown (write or preview), "Quando è finito" (agents' cards only), checklist, links, attached
 * files (button or drop on the panel; they stay on this Mac), the cards it
 * waits for, the moves the core allows and its history. Texts are saved on
 * blur and a moment after typing stops; "Salvato" says so. Read again
 * (debounced) whenever the live feed says something changed (`version`). A
 * commitment shows its data and "Fatto"; rinvii and motivi go to the
 * Segretaria in the chat. An agent's card (D-159) also has "Avvia",
 * "Riprendi" or "Riprova", the decisions it waits for (where it runs) and the
 * agent's report.
 */
const props = defineProps<{
  card: Card;
  cards: Card[];
  projects: string[];
  agents: string[];
  /** The milestones of the projects (D-313): the card may go in one of its project's. */
  milestones?: Milestone[];
  today: string;
  version: number;
  splitInbox: boolean;
  /** The pending approvals of the chat: those of this card show here (D-159). */
  approvals?: Approval[];
  decide?: (approval: Approval, state: 'approved' | 'rejected', choice?: ExecutorChoice, plan?: { starts: readonly number[]; revision: number }) => Promise<void>;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();

const dialog = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLElement | null>(null);
useModal(dialog, () => emit('close'), closeButton);

const busy = ref(false);
const problem = ref<string | null>(null);

const isTask = computed(() => props.card.kind === 'task');
const blocked = computed(() => blockedText(props.card));
const moves = computed(() => moveButtons(props.card, props.splitInbox));
/** The decisions this card waits for (D-159): where it runs, a declassification, a folder with changes. */
const cardApprovals = computed(() => (props.approvals ?? []).filter((approval) => approval.taskId === props.card.id));
const actions = computed(() => cardActions(props.card, cardApprovals.value.length > 0));
const report = computed(() => detail.value?.report ?? null);
const chosen = computed(() => (detail.value?.executor === null || detail.value?.executor === undefined ? undefined : (CHOICE_TEXT[detail.value.executor] ?? detail.value.executor)));
const choices = computed(() => dependencyChoices(props.card, props.cards));
/** Agents the select offers: the registry's, and the card's own when it is no longer there. */
const agentChoices = computed(() => (props.card.assignee === 'user' || props.agents.includes(props.card.assignee) ? props.agents : [...props.agents, props.card.assignee]));
/** The open milestones of the card's project, and the one it is in (D-313). */
const milestoneOptions = computed(() => milestoneChoices(props.card, props.milestones ?? []));
const projectChoices = computed(() => (props.card.project === null || props.projects.includes(props.card.project) ? props.projects : [...props.projects, props.card.project]));
const locked = computed(() => assigneeLocked(props.card));
const lockedText = computed(() => {
  if (!locked.value) return undefined;
  if (props.card.status === 'done') return 'Una card fatta non cambia chi la fa.';
  if (props.card.status === 'running') return 'È al lavoro: chi la fa non cambia.';
  return 'Il motore l’ha già avuta: chi la fa non cambia più.';
});

// The card in full, read from the core; again when the live feed says something changed.
const detail = ref<CardDetailData | null>(null);
const loading = ref(false);

async function loadDetail(): Promise<void> {
  if (!isTask.value) return;
  loading.value = true;
  try {
    detail.value = await loadCardDetail(props.card.id);
    syncTexts();
  } catch (cause) {
    problem.value = cardErrorText(cause);
  } finally {
    loading.value = false;
  }
}

let reloadTimer: number | undefined;
watch(
  () => props.version,
  () => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void loadDetail(), 300);
  },
);
onMounted(loadDetail);

// Whether the agent asks where each card runs (executor_choice: ask, D-159), or works with its first executor
// and asks only when that one cannot (prefer-first, D-298): from its card, read from the core.
const asks = ref(false);
const prefers = ref<string | undefined>(undefined);
async function loadAsks(): Promise<void> {
  const assignee = props.card.assignee;
  if (assignee === 'user') {
    asks.value = false;
    prefers.value = undefined;
    return;
  }
  try {
    const listing = await listUserAgents();
    const agent = [...listing.official, ...listing.user].find((item) => item.name === assignee);
    if (props.card.assignee !== assignee) return;
    asks.value = agent?.card.executorChoice === 'ask';
    const first = agent?.card.executors[0];
    prefers.value = agent?.card.executorChoice === 'prefer-first' && first !== undefined ? (CHOICE_TEXT[first] ?? first) : undefined;
  } catch {
    asks.value = false;
    prefers.value = undefined;
  }
}
watch(() => props.card.assignee, () => void loadAsks());
onMounted(loadAsks);

// The style of Open Design and the skills of a Designer card (D-163): chosen from the adopted catalogs.
const isDesigner = computed(() => isTask.value && props.card.assignee === DESIGNER_AGENT);
const styleCatalog = ref<{ id: string; name: string }[]>([]);
const skillCatalog = ref<{ id: string; name: string; source: string }[]>([]);
const catalogsLoaded = ref(false);
async function loadCatalogs(): Promise<void> {
  if (!isDesigner.value || catalogsLoaded.value) return;
  const [styles, skills] = await Promise.allSettled([listDesignStyles(), listSkills()]);
  styleCatalog.value = styles.status === 'fulfilled' ? styles.value.styles.map((style) => ({ id: style.slug, name: style.name })) : [];
  // The Designer works in the cloud: a private skill of the user's own is never offered (D-255).
  skillCatalog.value = skills.status === 'fulfilled' ? cloudSkills(skills.value.skills).map((skill) => ({ id: skill.id, name: skill.name, source: skill.source })) : [];
  catalogsLoaded.value = true;
}
watch(isDesigner, () => void loadCatalogs());
onMounted(loadCatalogs);
const chosenStyle = computed(() => detail.value?.style ?? null);
const styleGone = computed(() => chosenStyle.value !== null && catalogsLoaded.value && !styleCatalog.value.some((style) => style.id === chosenStyle.value));
const chosenSkills = computed(() => designChoices(detail.value?.skills ?? [], catalogsLoaded.value ? skillCatalog.value : (detail.value?.skills ?? []).map((id) => ({ id, name: id }))));
const skillOptions = computed(() => skillCatalog.value.filter((skill) => !(detail.value?.skills ?? []).includes(skill.id)));

function setStyle(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  void act(() => updateCard(props.card.id, { style: value === '' ? null : value }));
}

function addSkill(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const id = select.value;
  select.value = '';
  if (id !== '') void act(() => updateCard(props.card.id, { skills: [...(detail.value?.skills ?? []), id] }));
}

function removeSkill(id: string): void {
  void act(() => updateCard(props.card.id, { skills: (detail.value?.skills ?? []).filter((skill) => skill !== id) }));
}

// "Salvato": a moment after each change the core took.
const saved = ref(false);
let savedTimer: number | undefined;
function flashSaved(): void {
  saved.value = true;
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (saved.value = false), 2000);
}

async function act(work: () => Promise<unknown>, quiet = false): Promise<boolean> {
  busy.value = true;
  if (!quiet) problem.value = null;
  try {
    await work();
    flashSaved();
    return true;
  } catch (cause) {
    problem.value = cardErrorText(cause);
    return false;
  } finally {
    busy.value = false;
    emit('changed');
    void loadDetail();
  }
}

// Title, description and criteria: written here, saved on blur and a moment after typing stops.
type TextField = 'title' | 'goal' | 'criteria';
const texts = reactive<Record<TextField, string>>({ title: props.card.title, goal: '', criteria: '' });
const editing = new Set<TextField>();
const textTimers = new Map<TextField, number>();
const savingText = ref(false);

function serverText(field: TextField): string {
  if (field === 'title') return detail.value?.title ?? props.card.title;
  return (field === 'goal' ? detail.value?.goal : detail.value?.criteria) ?? '';
}

/** What the core holds goes into the fields the user is not writing in. */
function syncTexts(): void {
  for (const field of ['title', 'goal', 'criteria'] as const) if (!editing.has(field) && !textTimers.has(field)) texts[field] = serverText(field);
}

function onTextInput(field: TextField): void {
  window.clearTimeout(textTimers.get(field));
  textTimers.set(
    field,
    window.setTimeout(() => void saveText(field), 1200),
  );
}

function onTextFocus(field: TextField): void {
  editing.add(field);
}

function onTextBlur(field: TextField): void {
  editing.delete(field);
  void saveText(field);
}

async function saveText(field: TextField): Promise<void> {
  window.clearTimeout(textTimers.get(field));
  textTimers.delete(field);
  if (detail.value === null) return;
  const value = texts[field];
  if (value.trim() === serverText(field).trim()) return;
  if (field === 'title' && value.trim() === '') {
    problem.value = 'Il titolo non può essere vuoto.';
    texts.title = serverText('title');
    return;
  }
  const fields: CardFieldsInput = field === 'title' ? { title: value.trim() } : { [field]: value.trim() === '' ? null : value };
  savingText.value = true;
  // What was sent is what the core holds now: a reload in between does not write it again.
  if (field === 'title') detail.value.title = value.trim();
  else detail.value[field] = value.trim() === '' ? null : value.trim();
  try {
    await updateCard(props.card.id, fields);
    flashSaved();
    emit('changed');
  } catch (cause) {
    problem.value = cardErrorText(cause);
    void loadDetail();
  } finally {
    savingText.value = false;
  }
}

/** A text being written when the panel closes is saved all the same. */
onBeforeUnmount(() => {
  window.clearTimeout(reloadTimer);
  window.clearTimeout(savedTimer);
  for (const field of [...textTimers.keys()]) void saveText(field);
});

function onTitleKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    (event.target as HTMLInputElement).blur();
  }
}

// "Descrizione": Markdown, written or read.
const goalMode = ref<'edit' | 'preview'>('preview');
const goalArea = ref<HTMLTextAreaElement | null>(null);
watch(
  () => detail.value !== null,
  (ready) => {
    if (ready && (detail.value?.goal ?? null) === null) goalMode.value = 'edit';
  },
  { once: true },
);

function editGoal(): void {
  goalMode.value = 'edit';
  window.setTimeout(() => goalArea.value?.focus(), 0);
}

// Properties.
function setProject(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  void act(() => updateCard(props.card.id, { project: value === '' ? null : value }));
}

function setMilestone(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  void act(() => updateCard(props.card.id, { milestone: value === '' ? null : value }));
}

function setAssignee(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  void act(() => updateCard(props.card.id, { assignee: value }));
}

function setPriority(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
  void act(() => updateCard(props.card.id, { priority: value }));
}

function setDay(field: 'due' | 'planned', event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  void act(() => updateCard(props.card.id, { [field]: value === '' ? null : value }));
}

function clearDay(field: 'due' | 'planned'): void {
  void act(() => updateCard(props.card.id, { [field]: null }));
}

// Checklist.
const newItem = ref('');
const checklist = computed<ChecklistItem[]>(() => detail.value?.checklist ?? []);
const progress = computed(() => progressPercent(checklist.value));
const doneItems = computed(() => checklist.value.filter((item) => item.done).length);

async function addItem(): Promise<void> {
  const body = newItem.value.trim();
  if (body === '') return;
  if (await act(() => addChecklistItem(props.card.id, body))) newItem.value = '';
}

function toggleItem(item: ChecklistItem): void {
  item.done = !item.done;
  void act(() => updateChecklistItem(props.card.id, item.id, { done: item.done }));
}

function renameItem(item: ChecklistItem, event: Event): void {
  const input = event.target as HTMLInputElement;
  const body = input.value.trim();
  if (body === item.body) return;
  if (body === '') {
    input.value = item.body;
    return;
  }
  void act(() => updateChecklistItem(props.card.id, item.id, { body }));
}

function blurOnEnter(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    (event.target as HTMLInputElement).blur();
  }
}

function removeItem(item: ChecklistItem): void {
  void act(() => removeChecklistItem(props.card.id, item.id));
}

// Links.
const newUrl = ref('');
const newLinkTitle = ref('');

async function addLink(): Promise<void> {
  const url = newUrl.value.trim();
  if (url === '') return;
  if (!isWebAddress(url)) {
    problem.value = 'Il link deve essere un indirizzo web (http o https).';
    return;
  }
  if (await act(() => addCardLink(props.card.id, url, newLinkTitle.value.trim()))) {
    newUrl.value = '';
    newLinkTitle.value = '';
  }
}

function removeLink(link: string): void {
  void act(() => removeCardLink(props.card.id, link));
}

function removeFile(file: string): void {
  void act(() => removeCardFile(props.card.id, file));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// Attached files: the button or a drop on the panel. They go to the core in base64 and stay on this Mac.
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(0);
const dropDepth = ref(0);

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(dataUrlBase64(typeof reader.result === 'string' ? reader.result : ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function attach(files: readonly File[]): Promise<void> {
  if (!isTask.value || files.length === 0) return;
  problem.value = null;
  const refused: string[] = [];
  for (const file of files) {
    const refusal = fileRefusal(file);
    if (refusal !== undefined) {
      refused.push(refusal);
      continue;
    }
    uploading.value += 1;
    try {
      const data = await readBase64(file);
      await uploadCardFile(props.card.id, { name: file.name, type: file.type === '' ? 'application/octet-stream' : file.type, data });
      flashSaved();
    } catch (cause) {
      refused.push(`«${file.name}»: ${cardErrorText(cause)}`);
    } finally {
      uploading.value -= 1;
    }
  }
  if (refused.length > 0) problem.value = refused.join(' ');
  emit('changed');
  void loadDetail();
}

function onFilesChosen(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  void attach(files);
}

function carriesFiles(event: DragEvent): boolean {
  return isTask.value && (event.dataTransfer?.types.includes('Files') ?? false);
}

function onPanelDragEnter(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dropDepth.value += 1;
}

function onPanelDragOver(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
}

function onPanelDragLeave(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  dropDepth.value = Math.max(0, dropDepth.value - 1);
}

function onPanelDrop(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dropDepth.value = 0;
  void attach([...(event.dataTransfer?.files ?? [])]);
}

// Dependencies, moves, commitments.
function addDependency(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const on = select.value;
  select.value = '';
  if (on !== '') void act(() => addCardDependency(props.card.id, on));
}

function removeDependency(on: string): void {
  void act(() => removeCardDependency(props.card.id, on));
}

function move(to: MoveTarget): void {
  void act(() => moveCard(props.card.id, to));
}

function runAction(action: CardAction): void {
  let left = false;
  void act(async () => {
    left = (await cardAction(props.card.id, action)).left;
  }).then(() => {
    if (left) problem.value = NOT_STOPPED_TEXT;
  });
}

// The steps of the agent (D-235): what it searched, read, wrote or delegated; read again every few seconds while the card works.
const STEPS_POLL_MS = 3_000;
const steps = ref<SavedActivity[]>([]);
async function loadSteps(): Promise<void> {
  if (!isTask.value || props.card.assignee === 'user') return;
  try {
    steps.value = await listActivities(props.card.id);
  } catch {
    // Not there (an older core): the card shows no steps.
  }
}
let stepsTimer: number | undefined;
function followSteps(): void {
  window.clearInterval(stepsTimer);
  void loadSteps();
  if (props.card.status === 'running') stepsTimer = window.setInterval(() => void loadSteps(), STEPS_POLL_MS);
}
watch(() => props.card.status, followSteps);
onMounted(followSteps);
onBeforeUnmount(() => window.clearInterval(stepsTimer));

// «Rimanda» (D-235): an agent's card in Da verificare goes back to work with a note; the note is Privato unless the user says Interno.
const canSendBack = computed(() => props.card.kind === 'task' && props.card.status === 'to_verify' && props.card.assignee !== 'user');
/** A card already private stays so: Interno would not take it back to the cloud, so it is not offered. */
const alreadyPrivate = computed(() => props.card.label === 'L2' || props.card.label === 'L3');
const returns = computed(() => detail.value?.returns ?? []);
const returnNote = ref('');
const returnLabel = ref<'L1' | 'L2'>('L2');

function sendBack(): void {
  const note = returnNote.value.trim();
  if (note === '') {
    problem.value = 'Scrivi una nota: dice all’agente cosa correggere.';
    return;
  }
  void act(async () => {
    await sendBackCard(props.card.id, note, returnLabel.value);
    returnNote.value = '';
    returnLabel.value = 'L2';
  });
}

async function decideHere(approval: Approval, state: 'approved' | 'rejected', choice?: ExecutorChoice, plan?: { starts: readonly number[]; revision: number }): Promise<void> {
  if (props.decide === undefined) return;
  await props.decide(approval, state, choice, plan);
  emit('changed');
  void loadDetail();
}

function commitmentDone(): void {
  void act(() => markCommitmentDone(props.card.id));
}

const history = computed(() => historyLines(detail.value?.history ?? [], new Date()));

function absoluteTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

<template>
  <!-- A file dropped beside the panel is not opened by the browser in place of the chat. -->
  <div class="fixed inset-0 z-40 bg-black/40" aria-hidden="true" @click="emit('close')" @dragover.prevent @drop.prevent />
  <aside
    ref="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="card-title"
    tabindex="-1"
    class="fixed inset-y-0 right-0 z-50 flex w-full max-w-[640px] flex-col border-l bg-surface shadow-[0_14px_40px_#0006] outline-none max-md:top-[var(--vv-top,0px)] max-md:bottom-auto max-md:h-[var(--vv-height,100dvh)] max-md:border-l-0 max-md:pt-[var(--safe-top)] max-md:pb-[var(--safe-bottom)]"
    :class="dropDepth > 0 ? 'border-accent' : 'border-line'"
    @dragenter="onPanelDragEnter"
    @dragover="onPanelDragOver"
    @dragleave="onPanelDragLeave"
    @drop="onPanelDrop"
  >
    <header class="flex items-start gap-2 border-b border-line px-5 py-4 max-md:px-4 max-md:py-3">
      <div class="min-w-0 flex-1">
        <p class="hud-title mb-1.5 flex items-center gap-2">
          <span>{{ isTask ? 'Card' : 'Impegno' }} · {{ stateText(card) }}</span>
          <span v-if="savingText || busy || uploading > 0" class="text-muted normal-case" aria-live="polite">Salvo…</span>
          <span v-else-if="saved" class="inline-flex items-center gap-1 text-ok normal-case" aria-live="polite"><Icon name="saved" :size="12" />Salvato</span>
        </p>
        <label v-if="isTask" for="card-title" class="sr-only">Titolo</label>
        <input
          v-if="isTask"
          id="card-title"
          v-model="texts.title"
          :maxlength="MAX_TITLE"
          class="w-full rounded-md bg-transparent px-1 py-0.5 -mx-1 text-[18px] leading-snug font-semibold outline-none hover:bg-surface-2"
          @input="onTextInput('title')"
          @focus="onTextFocus('title')"
          @blur="onTextBlur('title')"
          @keydown="onTitleKey"
        />
        <h2 v-else id="card-title" class="text-[16px] leading-snug font-semibold break-words">{{ card.title }}</h2>
      </div>
      <button ref="closeButton" type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink touch:-my-1.5 touch:size-11" aria-label="Chiudi il dettaglio" @click="emit('close')">
        <Icon name="close" :size="16" />
      </button>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-5 py-4 text-[14.5px] max-md:px-4">
      <p v-if="problem !== null" role="alert" class="flex items-start gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-[14px] text-danger">
        <span class="flex-1">{{ problem }}</span>
        <button type="button" class="shrink-0 text-muted hover:text-ink touch:-my-2 touch:grid touch:size-11 touch:place-items-center" aria-label="Chiudi l’avviso" @click="problem = null"><Icon name="close" :size="14" /></button>
      </p>

      <div v-if="card.late || card.column === 'failed' || blocked !== undefined" class="flex flex-wrap items-center gap-2">
        <span v-if="card.late" class="chip text-danger">in ritardo</span>
        <span v-if="card.column === 'failed'" class="chip text-danger">Fallito</span>
        <span v-if="blocked !== undefined" class="chip text-warn">bloccata</span>
      </div>

      <!-- A task: the whole card, changed in place. -->
      <template v-if="isTask">
        <div class="grid grid-cols-[minmax(110px,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 max-md:grid-cols-[minmax(96px,auto)_minmax(0,1fr)] max-md:gap-x-3">
          <label for="card-project" class="text-muted">Progetto</label>
          <select id="card-project" class="field px-2 py-1.5 text-[14px]" :value="card.project ?? ''" :disabled="busy" @change="setProject">
            <option value="">Generale</option>
            <option v-for="name in projectChoices" :key="name" :value="name">{{ name }}</option>
          </select>

          <template v-if="card.project !== null && milestoneOptions.length > 0">
            <label for="card-milestone" class="text-muted">Milestone</label>
            <select id="card-milestone" class="field px-2 py-1.5 text-[14px]" :value="card.milestone ?? ''" :disabled="busy" @change="setMilestone">
              <option value="">Nessuna</option>
              <option v-for="milestone in milestoneOptions" :key="milestone.id" :value="milestone.id">{{ milestone.title }}{{ milestone.status === 'closed' ? ' (chiusa)' : '' }}</option>
            </select>
          </template>

          <label for="card-assignee" class="text-muted">Chi la fa</label>
          <span class="flex flex-col gap-1">
            <select id="card-assignee" class="field px-2 py-1.5 text-[14px]" :value="card.assignee" :disabled="busy || locked" :aria-describedby="lockedText !== undefined ? 'card-assignee-why' : undefined" @change="setAssignee">
              <option value="user">Tu</option>
              <option v-for="agent in agentChoices" :key="agent" :value="agent">{{ agentName(agent) }}</option>
            </select>
            <span v-if="lockedText !== undefined" id="card-assignee-why" class="text-[13px] text-muted">{{ lockedText }}</span>
          </span>

          <!-- The Designer's card (D-163): a style of Open Design and skills of the catalog, read by the Designer as reference data. -->
          <template v-if="isDesigner && detail !== null">
            <label for="card-style" class="text-muted">Stile</label>
            <span class="flex flex-col gap-1">
              <select id="card-style" class="field px-2 py-1.5 text-[14px]" :value="chosenStyle ?? ''" :disabled="busy" @change="setStyle">
                <option value="">Nessuno</option>
                <option v-if="styleGone && chosenStyle !== null" :value="chosenStyle">{{ chosenStyle }} (non più nel catalogo)</option>
                <option v-for="style in styleCatalog" :key="style.id" :value="style.id">{{ style.name }}</option>
              </select>
              <span v-if="styleGone" class="text-[13px] text-warn">Non è più nel catalogo: la card parte senza.</span>
              <span v-else-if="catalogsLoaded && styleCatalog.length === 0" class="text-[13px] text-muted">Nessuno stile: scarica il catalogo di Open Design in Impostazioni → Agenti.</span>
            </span>

            <span id="card-skills-label" class="text-muted">Skill</span>
            <span class="flex min-w-0 flex-col gap-1.5">
              <ul v-if="chosenSkills.length > 0" class="flex flex-wrap gap-1.5" aria-labelledby="card-skills-label">
                <li v-for="skill in chosenSkills" :key="skill.id" class="flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pr-0.5 pl-2 text-[13.5px]" :title="skill.id">
                  <span class="min-w-0 truncate" :class="{ 'text-warn': skill.gone }">{{ skill.name }}<template v-if="skill.gone"> (non più nel catalogo)</template></span>
                  <button type="button" class="grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-surface hover:text-ink touch:-my-2 touch:size-11" :disabled="busy" :aria-label="`Togli la skill: ${skill.name}`" @click="removeSkill(skill.id)">
                    <Icon name="close" :size="12" />
                  </button>
                </li>
              </ul>
              <select v-if="skillOptions.length > 0 && chosenSkills.length < MAX_CARD_SKILLS" class="field px-2 py-1.5 text-[14px]" aria-label="Aggiungi una skill" :disabled="busy" @change="addSkill">
                <option value="">Aggiungi una skill…</option>
                <option v-for="skill in skillOptions" :key="skill.id" :value="skill.id">{{ skill.name }} · {{ skill.source }}</option>
              </select>
              <span v-else-if="catalogsLoaded && skillCatalog.length === 0" class="text-[13px] text-muted">Nessuna skill: aggiungi una sorgente in Impostazioni → Agenti.</span>
              <span v-if="chosenStyle !== null || chosenSkills.length > 0" class="text-[13px] text-muted">Il Designer li legge come testo di riferimento, con la loro licenza.</span>
            </span>
          </template>

          <label for="card-priority" class="text-muted">Priorità</label>
          <select id="card-priority" class="field px-2 py-1.5 text-[14px]" :value="card.priority" :disabled="busy" @change="setPriority">
            <option v-for="(name, value) in PRIORITY_TEXT" :key="value" :value="value">{{ name }}</option>
          </select>

          <span class="text-muted">Stato</span>
          <span :class="card.column === 'failed' ? 'text-danger' : ''">{{ stateText(card) }}</span>

          <label for="card-planned" class="text-muted">Data esecuzione</label>
          <span class="flex items-center gap-2">
            <input id="card-planned" type="date" class="field min-w-0 flex-1 px-2 py-1.5 text-[14px]" :value="card.planned ?? ''" :disabled="busy" @change="setDay('planned', $event)" />
            <button v-if="card.planned !== null" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy" @click="clearDay('planned')">Togli</button>
          </span>

          <label for="card-due" class="text-muted">Scadenza</label>
          <span class="flex items-center gap-2">
            <input id="card-due" type="date" class="field min-w-0 flex-1 px-2 py-1.5 text-[14px]" :class="{ 'text-danger': card.late }" :value="card.due ?? ''" :disabled="busy" @change="setDay('due', $event)" />
            <button v-if="card.due !== null" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy" @click="clearDay('due')">Togli</button>
          </span>

          <span class="text-muted">Etichetta</span>
          <span><LabelBadge :label="card.label" /></span>
        </div>

        <p v-if="detail === null && loading" class="text-[14px] text-muted">Carico la card…</p>

        <template v-if="detail !== null">
          <!-- Descrizione -->
          <section aria-labelledby="card-goal-title">
            <div class="mb-2 flex items-center gap-2">
              <h3 id="card-goal-title" class="hud-title flex-1">Descrizione</h3>
              <div class="flex overflow-hidden rounded-md border border-line text-[13px]" role="group" aria-label="Descrizione">
                <button type="button" class="px-2 py-0.5 touch:min-h-11 touch:px-3.5" :class="goalMode === 'edit' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="goalMode === 'edit'" @click="editGoal">Scrivi</button>
                <button type="button" class="border-l border-line px-2 py-0.5 touch:min-h-11 touch:px-3.5" :class="goalMode === 'preview' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="goalMode === 'preview'" @click="goalMode = 'preview'">Anteprima</button>
              </div>
            </div>
            <template v-if="goalMode === 'edit'">
              <textarea
                ref="goalArea"
                v-model="texts.goal"
                :maxlength="MAX_GOAL"
                rows="8"
                class="field w-full resize-y px-3 py-2 font-mono text-[14px] leading-relaxed"
                placeholder="Che cosa c’è da sapere: Markdown, elenchi, link…"
                aria-labelledby="card-goal-title"
                @input="onTextInput('goal')"
                @focus="onTextFocus('goal')"
                @blur="onTextBlur('goal')"
              />
              <p v-if="texts.goal.length > MAX_GOAL * 0.9" class="mt-1 text-right font-mono text-[12.5px] text-muted">{{ texts.goal.length }}/{{ MAX_GOAL }}</p>
            </template>
            <div v-else class="min-h-[40px] cursor-text rounded-lg border border-transparent px-1 py-1 hover:border-line" @dblclick="editGoal">
              <MarkdownText v-if="texts.goal.trim() !== ''" :source="texts.goal" />
              <button v-else type="button" class="text-[14px] text-muted hover:text-ink" @click="editGoal">Nessuna descrizione: scrivila</button>
            </div>
          </section>

          <!-- When it is finished: only for an agent, who needs to know where to stop (D-152). -->
          <section v-if="card.assignee !== 'user'" aria-labelledby="card-criteria-title">
            <h3 id="card-criteria-title" class="hud-title mb-2">Quando è finito</h3>
            <textarea
              v-model="texts.criteria"
              :maxlength="MAX_CRITERIA"
              rows="3"
              class="field w-full resize-y px-3 py-2 text-[14px] leading-relaxed"
              placeholder="Per l’agente: quando il lavoro si può dire finito"
              aria-labelledby="card-criteria-title"
              @input="onTextInput('criteria')"
              @focus="onTextFocus('criteria')"
              @blur="onTextBlur('criteria')"
            />
          </section>

          <!-- Checklist -->
          <section aria-labelledby="card-checklist-title">
            <div class="mb-2 flex items-center gap-2">
              <h3 id="card-checklist-title" class="hud-title flex-1">Checklist</h3>
              <span v-if="checklist.length > 0" class="font-mono text-[12.5px] text-muted">{{ doneItems }}/{{ checklist.length }}</span>
            </div>
            <div v-if="checklist.length > 0" class="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100" aria-label="Avanzamento della checklist">
              <div class="h-full rounded-full bg-accent transition-[width]" :style="{ width: `${progress}%` }" />
            </div>
            <ul v-if="checklist.length > 0" class="mb-2 flex flex-col gap-0.5">
              <li v-for="item in checklist" :key="item.id" class="group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface-2">
                <label class="contents touch-box"><input type="checkbox" class="size-4 shrink-0 accent-[var(--accent)] touch:size-5" :checked="item.done" :aria-label="`Fatta: ${item.body}`" @change="toggleItem(item)" /></label>
                <input
                  :value="item.body"
                  :maxlength="MAX_ITEM"
                  class="min-w-0 flex-1 bg-transparent py-0.5 outline-none"
                  :class="{ 'text-muted line-through': item.done }"
                  aria-label="Testo della voce"
                  @change="renameItem(item, $event)"
                  @keydown="blurOnEnter"
                />
                <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md text-muted opacity-60 group-hover:opacity-100 hover:text-ink touch:size-11 touch:opacity-100" :aria-label="`Togli la voce: ${item.body}`" @click="removeItem(item)">
                  <Icon name="close" :size="13" />
                </button>
              </li>
            </ul>
            <form class="flex gap-2" @submit.prevent="addItem">
              <input v-model="newItem" :maxlength="MAX_ITEM" class="field min-w-0 flex-1 px-2.5 py-1.5 text-[14px]" placeholder="Aggiungi una voce e premi Invio" aria-label="Nuova voce della checklist" />
              <button type="submit" class="btn px-3 py-1.5 text-[14px]" :disabled="newItem.trim() === ''">Aggiungi</button>
            </form>
          </section>

          <!-- Link -->
          <section aria-labelledby="card-links-title">
            <h3 id="card-links-title" class="hud-title mb-2">Link</h3>
            <ul v-if="detail.links.length > 0" class="mb-2 flex flex-col gap-1">
              <li v-for="link in detail.links" :key="link.id" class="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
                <Icon name="link" :size="14" class="shrink-0 text-muted" />
                <a :href="link.url" target="_blank" rel="noopener noreferrer" class="min-w-0 flex-1 truncate text-accent hover:underline" :title="link.url">{{ linkText(link) }}</a>
                <span v-if="link.title !== null" class="hidden shrink-0 font-mono text-[12.5px] text-muted sm:inline">{{ hostOf(link.url) }}</span>
                <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink touch:size-11" :aria-label="`Togli il link: ${linkText(link)}`" @click="removeLink(link.id)">
                  <Icon name="close" :size="13" />
                </button>
              </li>
            </ul>
            <form class="flex flex-wrap gap-2" @submit.prevent="addLink">
              <input v-model="newUrl" type="url" class="field min-w-[200px] flex-[2] px-2.5 py-1.5 text-[14px] max-md:min-w-0 max-md:basis-full" placeholder="https://…" aria-label="Indirizzo del link" />
              <input v-model="newLinkTitle" maxlength="200" class="field min-w-[140px] flex-1 px-2.5 py-1.5 text-[14px] max-md:min-w-0" placeholder="Titolo (facoltativo)" aria-label="Titolo del link" />
              <button type="submit" class="btn px-3 py-1.5 text-[14px]" :disabled="newUrl.trim() === ''">Aggiungi</button>
            </form>
          </section>

          <!-- Allegati -->
          <section aria-labelledby="card-files-title">
            <div class="mb-2 flex items-center gap-2">
              <h3 id="card-files-title" class="hud-title flex-1">Allegati</h3>
              <span v-if="uploading > 0" class="text-[13px] text-muted" aria-live="polite">Allego…</span>
              <button type="button" class="btn px-3 py-1 text-[13.5px]" @click="fileInput?.click()"><Icon name="attach" :size="14" />Allega</button>
              <input ref="fileInput" type="file" multiple class="hidden" @change="onFilesChosen" />
            </div>
            <ul v-if="detail.files.length > 0" class="mb-2 flex flex-col gap-1.5">
              <li v-for="file in detail.files" :key="file.id" class="flex items-center gap-3 rounded-lg border border-line px-2.5 py-2">
                <img v-if="isImage(file.mediaType)" :src="cardFileUrl(card.id, file.id)" alt="" loading="lazy" class="size-11 shrink-0 rounded-md border border-line object-cover" />
                <span v-else class="grid size-11 shrink-0 place-items-center rounded-md border border-line bg-surface-2 font-mono text-[12px] text-muted">{{ fileKindText(file) }}</span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate" :title="file.name">{{ file.name }}</span>
                  <span class="font-mono text-[12.5px] text-muted">{{ fileKindText(file) }} · {{ fileSizeText(file.size) }}</span>
                </span>
                <a
                  :href="cardFileUrl(card.id, file.id)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :download="opensInline(file.mediaType) ? undefined : file.name"
                  class="btn shrink-0 px-2.5 py-1 text-[13px]"
                  >{{ opensInline(file.mediaType) ? 'Apri' : 'Scarica' }}</a
                >
                <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink touch:size-11" :aria-label="`Togli l’allegato: ${file.name}`" @click="removeFile(file.id)">
                  <Icon name="close" :size="13" />
                </button>
              </li>
            </ul>
            <p class="flex items-center gap-1.5 text-[13px] text-muted">
              <Icon name="private" :size="12" /><template v-if="dropDepth > 0">Lascia i file qui per allegarli.</template><template v-else><span class="touch:hidden">Trascina qui i file, fino a 20 MB l’uno. Restano su questo Mac, privati.</span><span class="hidden touch:inline">Con «Allega», fino a 20 MB l’uno. Restano sul Mac, privati.</span></template>
            </p>
          </section>
        </template>

        <!-- The agent's work (D-159): the decisions it waits for, Avvia / Riprendi / Riprova, its report. -->
        <section v-if="card.assignee !== 'user'" aria-labelledby="card-work">
          <h3 id="card-work" class="hud-title mb-2">Lavoro di {{ agentName(card.assignee) }}</h3>
          <div class="flex flex-col gap-2.5">
            <ApprovalCard v-for="approval in cardApprovals" :key="approval.id" :approval="approval" :decide="decideHere" />
            <div v-if="actions.length > 0 || chosen !== undefined" class="flex flex-wrap items-center gap-2">
              <button v-for="action in actions" :key="action" type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy" @click="runAction(action)">
                {{ CARD_ACTION_TEXT[action] }}
              </button>
              <span v-if="chosen !== undefined" class="text-[13.5px] text-muted">Ultima scelta: {{ chosen }}</span>
            </div>
            <p v-if="actions.includes('start')" class="text-[13.5px] text-muted">
              Con Avvia, la card parte appena non aspetta più nulla<template v-if="asks">; prima ti chiedo con chi lavora</template><template v-else-if="prefers !== undefined">; lavora con {{ prefers }}, e ti chiedo con chi solo se {{ prefers }} non è disponibile</template>.
            </p>
            <div v-if="report !== null" class="rounded-lg border border-line bg-bg px-3 py-2.5">
              <p class="mb-1.5 flex items-center gap-2 text-[13px] text-muted">
                <span class="flex-1">Rapporto · {{ CHOICE_TEXT[report.executor ?? ''] ?? report.executor ?? '' }}{{ report.model === null ? '' : ` / ${report.model}` }}</span>
                <LabelBadge :label="report.label" />
              </p>
              <MarkdownText :source="report.text" class="max-h-72 overflow-y-auto text-[14px] break-words" />
              <ul v-if="report.files.length > 0" class="mt-2 flex flex-wrap gap-1.5" aria-label="File scritti nel progetto">
                <li v-for="file in report.files" :key="file" class="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12.5px]">{{ file }}</li>
              </ul>
            </div>
            <div v-if="steps.length > 0" class="rounded-lg border border-line px-3 py-2.5">
              <p class="mb-1.5 text-[13px] text-muted">Passi{{ card.status === 'running' ? ' · si aggiornano mentre lavora' : '' }}</p>
              <ol class="flex max-h-48 flex-col gap-1 overflow-y-auto text-[13.5px]" aria-label="Passi dell’agente">
                <li v-for="item in steps" :key="item.id" class="break-words">{{ activityText(item) }}</li>
              </ol>
            </div>
            <ul v-if="returns.length > 0" class="flex flex-col gap-1.5" aria-label="Note con cui l’hai rimandata">
              <li v-for="(item, index) in returns" :key="item.at" class="rounded-lg border border-line px-3 py-2 text-[14px]">
                <p class="mb-1 flex items-center gap-2 text-[13px] text-muted">
                  <span class="flex-1">Rimandata, {{ index + 1 }}ª volta · {{ relativeTimeText(item.at, new Date()) }}</span>
                  <LabelBadge :label="item.label" />
                </p>
                <p class="whitespace-pre-wrap break-words">{{ item.note }}</p>
              </li>
            </ul>
            <div v-if="canSendBack" class="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
              <label for="card-return" class="text-[13.5px] text-muted">Non va? Rimandala con una nota: l’agente riparte dal suo rapporto e da quello che scrivi.</label>
              <textarea id="card-return" v-model="returnNote" rows="3" maxlength="2000" class="field px-2 py-1.5 text-[14px]" placeholder="Per esempio: usa i colori del DESIGN.md" :disabled="busy" />
              <div class="flex flex-wrap items-center gap-2">
                <template v-if="!alreadyPrivate">
                  <label for="card-return-label" class="text-[13.5px] text-muted">Privacy della nota</label>
                  <select id="card-return-label" v-model="returnLabel" class="field px-2 py-1.5 text-[14px]" :disabled="busy">
                    <option value="L2">Privato: la card resta sul modello locale</option>
                    <option value="L1">Interno: può tornare a Claude o ChatGPT</option>
                  </select>
                </template>
                <span v-else class="text-[13.5px] text-muted">La card è già Privata: la nota resta sul modello locale.</span>
                <button type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy" @click="sendBack">Rimanda</button>
              </div>
            </div>
          </div>
        </section>

        <!-- Aspetta -->
        <section aria-labelledby="card-deps">
          <h3 id="card-deps" class="hud-title mb-2">Aspetta</h3>
          <p v-if="card.dependsOn.length === 0" class="mb-2 text-[14px] text-muted">Non aspetta altre card.</p>
          <ul v-else class="mb-2 flex flex-col gap-1">
            <li v-for="dep in card.dependsOn" :key="dep.id" class="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
              <span class="min-w-0 flex-1 break-words" :class="{ 'text-muted line-through': dep.status === 'done' }">{{ dep.title }}</span>
              <span class="shrink-0 font-mono text-[12.5px]" :class="dep.status === 'done' ? 'text-ok' : dep.status === 'failed' ? 'text-danger' : 'text-muted'" :title="dep.status === 'failed' ? 'Fallita: finché non la togli o non riparte, questa card aspetta' : undefined">{{ STATUS_COLUMN_TEXT[dep.status] }}</span>
              <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink touch:size-11" :disabled="busy" :aria-label="`Non aspettare più: ${dep.title}`" @click="removeDependency(dep.id)">
                <Icon name="close" :size="13" />
              </button>
            </li>
          </ul>
          <select v-if="(card.status === 'inbox' || card.status === 'ready') && choices.length > 0" class="field w-full px-2 py-1.5 text-[14px]" aria-label="Aspetta anche…" :disabled="busy" @change="addDependency">
            <option value="">Aspetta anche…</option>
            <option v-for="other in choices" :key="other.id" :value="other.id">{{ other.title }}</option>
          </select>
        </section>

        <section v-if="moves.length > 0" aria-labelledby="card-moves">
          <h3 id="card-moves" class="hud-title mb-2">Sposta in</h3>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="item in moves" :key="item.to" type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="busy" @click="move(item.to)">{{ item.text }}</button>
          </div>
        </section>

        <section v-if="card.waitingReason !== null || card.note !== null" aria-labelledby="card-note">
          <h3 id="card-note" class="hud-title mb-2">Nota</h3>
          <p v-if="card.waitingReason !== null" class="mb-1.5 break-words whitespace-pre-line"><span class="text-muted">In attesa perché:</span> {{ reasonText(card.waitingReason) ?? card.waitingReason }}</p>
          <p v-if="card.note !== null && card.note !== card.waitingReason" class="break-words whitespace-pre-line">{{ card.note }}</p>
        </section>

        <!-- Cronologia -->
        <section v-if="history.length > 0" aria-labelledby="card-history">
          <h3 id="card-history" class="hud-title mb-2">Cronologia</h3>
          <ol class="flex flex-col gap-1.5 border-l border-line pl-3">
            <li v-for="(line, index) in history" :key="`${line.at}:${index}`" class="flex items-baseline gap-2 text-[13.5px]">
              <span class="min-w-0 flex-1">{{ line.text }}</span>
              <time class="shrink-0 font-mono text-[12.5px] text-muted" :datetime="line.at" :title="absoluteTime(line.at)">{{ line.when }}</time>
            </li>
          </ol>
        </section>
      </template>

      <!-- A commitment of the secretary: its data and "Fatto". -->
      <template v-else>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
          <dt class="text-muted">Quando</dt>
          <dd :class="{ 'text-danger': card.late }">{{ dueText(card, today) ?? '—' }}</dd>
          <dt class="text-muted">Stato</dt>
          <dd>{{ COMMITMENT_STATUS_TEXT[card.status as keyof typeof COMMITMENT_STATUS_TEXT] }}</dd>
          <dt class="text-muted">Etichetta</dt>
          <dd><LabelBadge :label="card.label" /></dd>
          <template v-if="card.reason !== null">
            <dt class="text-muted">Perché</dt>
            <dd class="break-words">{{ card.reason }}</dd>
          </template>
        </dl>
        <div v-if="card.status === 'open'">
          <button type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy" @click="commitmentDone"><Icon name="approve" :size="14" />Fatto</button>
        </div>
        <p class="text-[13.5px] text-muted">Per rinviarlo o dire perché non è fatto, scrivilo alla Segretaria in chat.</p>
      </template>
    </div>
  </aside>
</template>

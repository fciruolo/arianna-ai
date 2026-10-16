<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { editPlan, loadMentionable } from '../lib/api.ts';
import { executorChoices } from '../lib/cardwall.ts';
import { outcomeText, reportEntries } from '../lib/commitments.ts';
import { IM_NO, IM_YES, imConfirmation } from '../lib/im-approval.ts';
import { ACTION_TEXT, CHOICE_TEXT, declassifyLabels, EXECUTOR_TEXT, MODEL_TEXT } from '../lib/labels.ts';
import { errorText } from '../lib/italian.ts';
import {
  addRow,
  cloneDraft,
  COMPLEXITIES,
  COMPLEXITY_TEXT,
  draftProblem,
  keepTicks,
  MAX_PLAN_ROWS,
  planBody,
  planDraft,
  planStarts,
  removeRow,
  toggleBlockedBy,
  whoText,
  withAssignee,
  type PlanDraft,
} from '../lib/plan-approval.ts';
import { factProposal, factShare, PROPOSE_NO, PROPOSE_YES, SHARE_NO, SHARE_YES } from '../lib/profile-approval.ts';
import type { Approval, ExecutorChoice } from '../lib/types.ts';
import LabelBadge from './LabelBadge.vue';
import Icon from './Icon.vue';

const props = defineProps<{
  approval: Approval;
  /** `plan`: the cards of a plan to start at once, «Avvia subito», and the revision shown (D-235). */
  decide: (approval: Approval, state: 'approved' | 'rejected', choice?: ExecutorChoice, plan?: { starts: readonly number[]; revision: number }) => Promise<void>;
}>();
const busy = ref(false);

/**
 * A plan of Arianna (D-159, D-235): the cards it would create, who does each,
 * what each waits for, when it is done and how large it is. Editable before
 * the decision; «Avvia subito» per agent's row goes with «Crea le card».
 */
const plan = ref<PlanDraft | undefined>(undefined);
const editing = ref(false);
watch(
  () => props.approval.detail,
  (detail) => {
    if (props.approval.kind !== 'plan' || editing.value) return;
    const fresh = planDraft(detail);
    plan.value = fresh === undefined ? undefined : keepTicks(fresh, plan.value);
  },
  { immediate: true },
);
const draft = ref<PlanDraft | undefined>(undefined);
const planError = ref<string | null>(null);
/** Who may do a row: the user and the agents Arianna may call, with those the plan already names. */
const agents = ref<string[]>([]);
const assignees = computed(() => {
  const named = [...agents.value, ...(draft.value?.rows ?? []).map((row) => row.assignee)].filter((name) => name !== 'user');
  return ['user', ...new Set(named)];
});
const draftIssue = computed(() => (draft.value === undefined ? undefined : draftProblem(draft.value)));

async function startEdit(): Promise<void> {
  if (plan.value === undefined) return;
  draft.value = cloneDraft(plan.value);
  planError.value = null;
  editing.value = true;
  try {
    agents.value = await loadMentionable();
  } catch {
    // Without the list only the agents the plan names are offered.
  }
}

function cancelEdit(): void {
  editing.value = false;
  draft.value = undefined;
  planError.value = null;
}

async function saveEdit(): Promise<void> {
  const edited = draft.value;
  if (edited === undefined || draftIssue.value !== undefined) return;
  busy.value = true;
  planError.value = null;
  try {
    const saved = await editPlan(props.approval.id, planBody(edited));
    const fresh = planDraft(saved.detail);
    // The ticks «Avvia subito» stay as the user left them, row by row.
    plan.value = fresh === undefined ? undefined : keepTicks(fresh, { ...edited, revision: fresh.revision });
    editing.value = false;
    draft.value = undefined;
  } catch (cause) {
    planError.value = errorText(cause);
  } finally {
    busy.value = false;
  }
}

function setStart(index: number, on: boolean): void {
  const row = plan.value?.rows[index];
  if (row !== undefined && row.assignee !== 'user') row.start = on;
}

function setAssignee(index: number, assignee: string): void {
  const row = draft.value?.rows[index];
  if (draft.value !== undefined && row !== undefined) draft.value.rows[index] = withAssignee(row, assignee);
}

function toggleWait(index: number, on: number): void {
  const row = draft.value?.rows[index];
  if (draft.value !== undefined && row !== undefined) draft.value.rows[index] = toggleBlockedBy(row, index + 1, on);
}

function dropRow(number: number): void {
  if (draft.value !== undefined) draft.value = removeRow(draft.value, number);
}

function newRow(): void {
  if (draft.value !== undefined) draft.value = addRow(draft.value);
}

/** «bloccata da: 1. Grafica» of a row of the plan. */
function waitsText(blockedBy: readonly number[]): string {
  return blockedBy.map((on) => `${String(on)}. ${plan.value?.rows[on - 1]?.title ?? ''}`).join(', ');
}

async function createCards(): Promise<void> {
  if (plan.value === undefined) return;
  busy.value = true;
  try {
    await props.decide(props.approval, 'approved', undefined, { starts: planStarts(plan.value), revision: plan.value.revision });
  } finally {
    busy.value = false;
  }
}
/** Where a card of an agent runs (D-159): the ways allowed, and the ones left out with why. */
const executor = computed(() => (props.approval.kind === 'executor' ? executorChoices(props.approval.detail) : undefined));

async function chooseExecutor(choice: ExecutorChoice): Promise<void> {
  busy.value = true;
  try {
    await props.decide(props.approval, 'approved', choice);
  } finally {
    busy.value = false;
  }
}

const title = computed(() => ACTION_TEXT[props.approval.action] ?? props.approval.action);
/** One fact of «Su di te» to an agent, once (D-114, tappa C): who asks, why, the exact text. */
const share = computed(() => factShare(props.approval));
/** A fact Arianna would remember (D-114, tappa D). */
const proposal = computed(() => factProposal(props.approval));
const isDeclassify = computed(() => props.approval.kind === 'declassify' && share.value === undefined);
/** A workspace approval names the repository and the files with uncommitted changes. */
const workspace = computed(() => {
  if (props.approval.kind !== 'workspace') return undefined;
  const { repo, files, agent } = props.approval.detail;
  // The agent that would work there (D-119): the Coder for an approval written before it was named.
  const who = typeof agent === 'string' && agent !== 'coder' ? agent : 'Il Coder';
  return typeof repo === 'string' && Array.isArray(files) ? { repo, files: files.map(String), who } : undefined;
});
/** A budget approval names executor and model (router aliases) and the step. */
const budget = computed(() => {
  if (props.approval.kind !== 'budget') return undefined;
  const { executor, model } = props.approval.detail;
  return typeof executor === 'string' && typeof model === 'string' ? { executor, model } : undefined;
});
/** A commitment of the secretary to note, mark done (D-144) or move (D-148): its text, the day the core computed, the time; for a move also where it was. */
const commitment = computed(() => {
  if (props.approval.kind !== 'commitment') return undefined;
  const { op: raw, text: body, dayText, time, fromDayText, fromTime } = props.approval.detail;
  const op = (['add', 'done', 'move'] as const).find((name) => name === raw);
  if (op === undefined || typeof body !== 'string' || typeof dayText !== 'string') return undefined;
  const from = op === 'move' && typeof fromDayText === 'string' ? { dayText: fromDayText, time: typeof fromTime === 'string' ? fromTime : null } : undefined;
  return { op, body, dayText, time: typeof time === 'string' ? time : null, from };
});
/** The end-of-day report of the secretary (D-151): its valid lines; none falls back to the generic view. */
const report = computed(() => {
  if (props.approval.kind !== 'commitment') return undefined;
  const entries = reportEntries(props.approval.detail);
  return entries.length > 0 ? entries : undefined;
});
/** An IM item from a private conversation (D-167, P4b): the exact text and the IM it goes down to. */
const im = computed(() => (props.approval.kind === 'im' ? imConfirmation(props.approval.detail) : undefined));
const COMMITMENT_NOTE = {
  add: 'Il giorno l’ha calcolato Arianna dalle tue parole: controllalo prima di confermare.',
  done: 'Confermando, l’impegno risulta fatto.',
  move: 'Il giorno nuovo l’ha calcolato Arianna dalle tue parole: controllalo prima di confermare.',
} as const;
const COMMITMENT_YES = { add: 'Sì, segna', done: 'Sì, è fatto', move: 'Sì, sposta' } as const;
/** The exact text the approval covers: approving lets out this text, and only this. */
const text = computed(() => (typeof props.approval.detail.text === 'string' ? props.approval.detail.text : undefined));
const labels = computed(() => declassifyLabels(props.approval.detail));
const detail = computed(() => JSON.stringify(props.approval.detail, null, 2));

async function choose(state: 'approved' | 'rejected'): Promise<void> {
  busy.value = true;
  try {
    await props.decide(props.approval, state);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <article class="hud-card warn" :aria-label="`Richiesta di approvazione: ${title}`">
    <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-3">
      <span class="text-warn"><Icon name="warning" /></span>
      <h3 class="min-w-0 flex-1 truncate font-semibold">{{ title }}</h3>
      <span v-if="labels" class="lab text-warn">{{ labels }}</span>
      <LabelBadge :label="approval.label" />
      <span class="font-mono text-[12px] tracking-[0.08em] whitespace-nowrap text-warn uppercase">In attesa</span>
    </header>

    <div class="flex min-w-0 flex-col gap-2 px-[15px] py-3">
      <template v-if="share !== undefined">
        <p class="text-[15px]"><strong>{{ share.title }}</strong></p>
        <p class="break-words text-muted">Perché, secondo chi chiede: «{{ share.reason }}»</p>
        <p>Testo che esce:</p>
        <p class="rounded-lg border border-line bg-bg px-3 py-2 break-words">«{{ share.text }}»</p>
        <p class="text-xs text-muted">{{ share.note }}</p>
      </template>
      <template v-else-if="proposal !== undefined">
        <p>
          Vuoi che ricordi: <strong>{{ proposal.topic }}</strong>?
        </p>
        <p class="rounded-lg border border-line bg-bg px-3 py-2 break-words">{{ proposal.text }}</p>
        <p class="text-xs text-muted">{{ proposal.note }}</p>
      </template>
      <template v-else-if="isDeclassify && text !== undefined">
        <p>Approvando, questo testo esatto viene declassato e può uscire dalla macchina. Nient'altro.</p>
        <pre class="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{{ text }}</pre>
      </template>
      <template v-else-if="workspace !== undefined">
        <p>
          {{ workspace.who }} lavorerebbe in <span class="font-mono">{{ workspace.repo }}</span>, dove hai modifiche non ancora committate. Approvando lavora sopra di
          esse, sul branch corrente; rifiutando, Arianna lo saprà. Oppure committa prima e riprendi il task.
        </p>
        <ul class="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
          <li v-for="file in workspace.files" :key="file" class="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12.5px]">{{ file }}</li>
        </ul>
      </template>
      <template v-else-if="plan !== undefined && !editing">
        <p>
          Arianna propone {{ plan.rows.length }} card per <strong>{{ plan.title }}</strong>. Nessuna esiste finché non le crei: nascono tutte in Inbox, e partono subito
          solo quelle con «Avvia subito».
        </p>
        <ol class="flex flex-col gap-1.5">
          <li v-for="(row, index) in plan.rows" :key="index" class="rounded-lg border border-line bg-bg px-3 py-2">
            <p class="flex flex-wrap items-baseline gap-x-2 break-words">
              <span class="font-mono text-[12.5px] text-muted">{{ index + 1 }}.</span>
              <strong class="min-w-0 flex-1">{{ row.title }}</strong>
              <span class="chip text-[12.5px]" :title="COMPLEXITY_TEXT[row.complexity]">{{ row.complexity }}</span>
              <span class="chip text-[12.5px]">{{ whoText(row.assignee) }}</span>
            </p>
            <p v-if="row.goal !== ''" class="mt-0.5 text-[13.5px] break-words text-muted">{{ row.goal }}</p>
            <p v-if="row.criteria !== ''" class="mt-0.5 text-[13px] break-words"><span class="text-muted">Fatta quando:</span> {{ row.criteria }}</p>
            <p v-if="row.blockedBy.length > 0" class="mt-0.5 text-[13px] text-warn">bloccata da: {{ waitsText(row.blockedBy) }}</p>
            <label v-if="row.assignee !== 'user'" class="mt-1 flex w-fit items-center gap-1.5 text-[13px]">
              <input type="checkbox" :checked="row.start" :disabled="busy" @change="setStart(index, ($event.target as HTMLInputElement).checked)" />
              Avvia subito<span v-if="row.blockedBy.length > 0" class="text-muted">: parte quando le card che aspetta sono in Fatto</span>
            </label>
          </li>
        </ol>
      </template>
      <template v-else-if="plan !== undefined && draft !== undefined">
        <label class="flex flex-col gap-1 text-[13px] text-muted">
          Titolo del piano
          <input v-model="draft.title" maxlength="120" class="field px-2.5 py-1.5 text-[14px] text-ink" />
        </label>
        <ol class="flex flex-col gap-2">
          <li v-for="(row, index) in draft.rows" :key="index" class="flex flex-col gap-1.5 rounded-lg border border-line bg-bg px-3 py-2">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[12.5px] text-muted">{{ index + 1 }}.</span>
              <input v-model="row.title" maxlength="120" class="field min-w-0 flex-1 px-2 py-1 text-[14px]" :aria-label="`Titolo della card ${index + 1}`" placeholder="Titolo" />
              <button type="button" class="btn px-2 py-1 text-[13px]" :disabled="busy" :aria-label="`Elimina la card ${index + 1}`" @click="dropRow(index + 1)">Elimina</button>
            </div>
            <textarea v-model="row.goal" maxlength="500" rows="2" class="field resize-y px-2 py-1 text-[13.5px]" :aria-label="`Obiettivo della card ${index + 1}`" placeholder="Obiettivo" />
            <input v-model="row.criteria" maxlength="500" class="field px-2 py-1 text-[13.5px]" :aria-label="`Criterio di completamento della card ${index + 1}`" placeholder="Fatta quando…" />
            <div class="flex flex-wrap items-center gap-2 text-[13px]">
              <select :value="row.assignee" class="field px-2 py-1 text-[13.5px]" :aria-label="`Chi fa la card ${index + 1}`" @change="setAssignee(index, ($event.target as HTMLSelectElement).value)">
                <option v-for="name in assignees" :key="name" :value="name">{{ whoText(name) }}</option>
              </select>
              <select v-model="row.complexity" class="field px-2 py-1 text-[13.5px]" :aria-label="`Complessità della card ${index + 1}`">
                <option v-for="size in COMPLEXITIES" :key="size" :value="size">{{ COMPLEXITY_TEXT[size] }}</option>
              </select>
              <span v-if="index > 0" class="flex flex-wrap items-center gap-1.5">
                <span class="text-muted">bloccata da</span>
                <label v-for="on in index" :key="on" class="flex items-center gap-1">
                  <input type="checkbox" :checked="row.blockedBy.includes(on)" @change="toggleWait(index, on)" />{{ on }}
                </label>
              </span>
            </div>
          </li>
        </ol>
        <button type="button" class="btn w-fit px-2.5 py-1 text-[13px]" :disabled="busy || draft.rows.length >= MAX_PLAN_ROWS" @click="newRow">Aggiungi una card</button>
        <p v-if="draftIssue !== undefined" class="text-[13px] text-warn">{{ draftIssue }}</p>
      </template>
      <template v-else-if="executor !== undefined">
        <p>
          <strong>{{ executor.title }}</strong>: con chi lavora {{ executor.agent }}? Scegli tu per questo lavoro.
        </p>
        <ul v-if="executor.excluded.length > 0" class="flex flex-col gap-0.5 text-[13.5px] text-muted">
          <li v-for="item in executor.excluded" :key="item.executor">{{ item.executor }}: {{ item.why }}.</li>
        </ul>
      </template>
      <template v-else-if="report !== undefined">
        <p class="text-[15px]"><strong>Resoconto</strong></p>
        <ul class="flex flex-col gap-1.5">
          <li v-for="entry in report" :key="entry.commitmentId" class="rounded-lg border border-line bg-bg px-3 py-2">
            <p class="break-words">
              {{ entry.text }}<span class="text-xs text-muted"> · {{ entry.dayText }}<template v-if="entry.time !== null">, alle {{ entry.time }}</template></span>
            </p>
            <p class="text-[14px]" :class="entry.outcome === 'done' ? 'text-ok' : entry.outcome === 'not_done' ? 'text-warn' : ''">
              <strong>{{ outcomeText(entry) }}</strong>
            </p>
            <p v-if="entry.reason !== null" class="text-xs break-words text-muted">Perché: {{ entry.reason }}</p>
          </li>
        </ul>
        <p class="text-xs text-muted">
          Confermando, Arianna annota esiti e motivi<template v-if="report.some((entry) => entry.outcome === 'postponed')"
            >; un rinvio crea l’impegno nel giorno nuovo, calcolato dalle tue parole: controllalo</template
          >.
        </p>
      </template>
      <template v-else-if="im !== undefined">
        <p>{{ im.sentence }}</p>
        <p class="rounded-lg border border-line bg-bg px-3 py-2 break-words">{{ im.title }}</p>
        <p class="text-xs text-muted">{{ im.where }}</p>
      </template>
      <template v-else-if="commitment !== undefined">
        <p v-if="commitment.from !== undefined" class="text-muted line-through">
          <span class="sr-only">Prima: </span>{{ commitment.from.dayText }}<template v-if="commitment.from.time !== null">, alle {{ commitment.from.time }}</template>
        </p>
        <p class="text-[15px]">
          <span v-if="commitment.from !== undefined" class="sr-only">Nuovo giorno: </span>
          <strong>{{ commitment.dayText }}</strong><template v-if="commitment.time !== null">, alle {{ commitment.time }}</template>
        </p>
        <p class="rounded-lg border border-line bg-bg px-3 py-2 break-words">{{ commitment.body }}</p>
        <p class="text-xs text-muted">{{ COMMITMENT_NOTE[commitment.op] }}</p>
      </template>
      <p v-else-if="budget !== undefined">
        Il passo delegato userebbe <strong>{{ MODEL_TEXT[budget.model] ?? budget.model }}</strong> su {{ EXECUTOR_TEXT[budget.executor] ?? budget.executor }},
        che costa oltre il piano. Approvando, parte con questo modello; rifiutando, Arianna lo saprà e deciderà altrimenti.
      </p>
      <pre v-else class="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs break-words whitespace-pre-wrap">{{ detail }}</pre>
      <p v-if="planError !== null" class="text-[13px] text-warn" role="alert">{{ planError }}</p>
    </div>

    <div v-if="executor !== undefined" class="flex flex-wrap items-center gap-2 rounded-b-[14px] border-t border-line bg-surface-2 px-[15px] py-3">
      <button v-for="(option, index) in executor.options" :key="option" type="button" :disabled="busy" class="btn" :class="{ 'btn-primary': index === 0 }" @click="chooseExecutor(option)">
        {{ CHOICE_TEXT[option] }}
      </button>
      <button type="button" :disabled="busy" class="btn" @click="choose('rejected')">Non ora</button>
    </div>
    <div v-else-if="plan !== undefined && editing" class="flex flex-wrap items-center gap-2 rounded-b-[14px] border-t border-line bg-surface-2 px-[15px] py-3">
      <button type="button" :disabled="busy || draftIssue !== undefined" class="btn btn-primary" @click="saveEdit">Salva le modifiche</button>
      <button type="button" :disabled="busy" class="btn" @click="cancelEdit">Annulla</button>
    </div>
    <div v-else-if="plan !== undefined" class="flex flex-wrap items-center gap-2 rounded-b-[14px] border-t border-line bg-surface-2 px-[15px] py-3">
      <button type="button" :disabled="busy" class="btn btn-primary" @click="createCards"><Icon name="approve" :size="16" />Crea le card</button>
      <button type="button" :disabled="busy" class="btn" @click="startEdit">Modifica</button>
      <button type="button" :disabled="busy" class="btn" @click="choose('rejected')">Non ora</button>
    </div>
    <div v-else class="flex flex-wrap items-center gap-2 rounded-b-[14px] border-t border-line bg-surface-2 px-[15px] py-3">
      <button type="button" :disabled="busy" class="btn btn-primary" @click="choose('approved')">
        <Icon name="approve" :size="16" />{{ share !== undefined ? SHARE_YES : proposal !== undefined ? PROPOSE_YES : im !== undefined ? IM_YES : report !== undefined ? 'Sì, annota' : commitment === undefined ? 'Approva' : COMMITMENT_YES[commitment.op] }}
      </button>
      <button type="button" :disabled="busy" class="btn" @click="choose('rejected')">{{ share !== undefined ? SHARE_NO : proposal !== undefined ? PROPOSE_NO : im !== undefined ? IM_NO : commitment === undefined && report === undefined ? 'Rifiuta' : 'No' }}</button>
    </div>
  </article>
</template>

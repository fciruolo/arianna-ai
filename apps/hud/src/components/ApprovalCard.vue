<script setup lang="ts">
import { computed, ref } from 'vue';

import { outcomeText, reportEntries } from '../lib/commitments.ts';
import { ACTION_TEXT, declassifyLabels, EXECUTOR_TEXT, MODEL_TEXT } from '../lib/labels.ts';
import type { Approval } from '../lib/types.ts';
import LabelBadge from './LabelBadge.vue';
import Icon from './Icon.vue';

const props = defineProps<{ approval: Approval; decide: (approval: Approval, state: 'approved' | 'rejected') => Promise<void> }>();
const busy = ref(false);

const title = computed(() => ACTION_TEXT[props.approval.action] ?? props.approval.action);
const isDeclassify = computed(() => props.approval.kind === 'declassify');
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
      <span class="font-mono text-[10.5px] tracking-[0.08em] whitespace-nowrap text-warn uppercase">In attesa</span>
    </header>

    <div class="flex min-w-0 flex-col gap-2 px-[15px] py-3">
      <template v-if="isDeclassify && text !== undefined">
        <p>Approvando, questo testo esatto viene declassato e può uscire dalla macchina. Nient'altro.</p>
        <pre class="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{{ text }}</pre>
      </template>
      <template v-else-if="workspace !== undefined">
        <p>
          {{ workspace.who }} lavorerebbe in <span class="font-mono">{{ workspace.repo }}</span>, dove hai modifiche non ancora committate. Approvando lavora sopra di
          esse, sul branch corrente; rifiutando, Arianna lo saprà. Oppure committa prima e riprendi il task.
        </p>
        <ul class="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
          <li v-for="file in workspace.files" :key="file" class="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[11.5px]">{{ file }}</li>
        </ul>
      </template>
      <template v-else-if="report !== undefined">
        <p class="text-[15px]"><strong>Resoconto</strong></p>
        <ul class="flex flex-col gap-1.5">
          <li v-for="entry in report" :key="entry.commitmentId" class="rounded-lg border border-line bg-bg px-3 py-2">
            <p class="break-words">
              {{ entry.text }}<span class="text-xs text-muted"> · {{ entry.dayText }}<template v-if="entry.time !== null">, alle {{ entry.time }}</template></span>
            </p>
            <p class="text-[13px]" :class="entry.outcome === 'done' ? 'text-ok' : entry.outcome === 'not_done' ? 'text-warn' : ''">
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
    </div>

    <div class="flex flex-wrap items-center gap-2 rounded-b-[14px] border-t border-line bg-surface-2 px-[15px] py-3">
      <button type="button" :disabled="busy" class="btn btn-primary" @click="choose('approved')">
        <Icon name="approve" :size="16" />{{ report !== undefined ? 'Sì, annota' : commitment === undefined ? 'Approva' : COMMITMENT_YES[commitment.op] }}
      </button>
      <button type="button" :disabled="busy" class="btn" @click="choose('rejected')">{{ commitment === undefined && report === undefined ? 'Rifiuta' : 'No' }}</button>
    </div>
  </article>
</template>

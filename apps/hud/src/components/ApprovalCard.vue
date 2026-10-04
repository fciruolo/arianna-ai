<script setup lang="ts">
import { computed, ref } from 'vue';

import { ACTION_TEXT, declassifyLabels, EXECUTOR_TEXT, LABEL_TEXT, MODEL_TEXT } from '../lib/labels.ts';
import type { Approval } from '../lib/types.ts';
import Icon from './Icon.vue';

const props = defineProps<{ approval: Approval; decide: (approval: Approval, state: 'approved' | 'rejected') => Promise<void> }>();
const busy = ref(false);

const title = computed(() => ACTION_TEXT[props.approval.action] ?? props.approval.action);
const isDeclassify = computed(() => props.approval.kind === 'declassify');
/** A workspace approval names the repository and the files with uncommitted changes. */
const workspace = computed(() => {
  if (props.approval.kind !== 'workspace') return undefined;
  const { repo, files } = props.approval.detail;
  return typeof repo === 'string' && Array.isArray(files) ? { repo, files: files.map(String) } : undefined;
});
/** A budget approval names executor and model (router aliases) and the step. */
const budget = computed(() => {
  if (props.approval.kind !== 'budget') return undefined;
  const { executor, model } = props.approval.detail;
  return typeof executor === 'string' && typeof model === 'string' ? { executor, model } : undefined;
});
/** The exact text the approval covers: approving lets out this text, and only this. */
const text = computed(() => (typeof props.approval.detail.text === 'string' ? props.approval.detail.text : undefined));
const labels = computed(() => declassifyLabels(props.approval.detail));
const detail = computed(() => JSON.stringify(props.approval.detail, null, 2));
const labelClass: Record<string, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };

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
      <span class="lab" :class="labelClass[approval.label]" :title="LABEL_TEXT[approval.label]">{{ approval.label }}</span>
      <span class="font-mono text-[10.5px] tracking-[0.08em] whitespace-nowrap text-warn uppercase">In attesa</span>
    </header>

    <div class="flex min-w-0 flex-col gap-2 px-[15px] py-3">
      <template v-if="isDeclassify && text !== undefined">
        <p>Approvando, questo testo esatto viene declassato e può uscire dalla macchina. Nient'altro.</p>
        <pre class="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{{ text }}</pre>
      </template>
      <template v-else-if="workspace !== undefined">
        <p>
          Il Coder lavorerebbe in <span class="font-mono">{{ workspace.repo }}</span>, dove hai modifiche non ancora committate. Approvando lavora sopra di
          esse, sul branch corrente; rifiutando, Arianna lo saprà. Oppure committa prima e riprendi il task.
        </p>
        <ul class="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
          <li v-for="file in workspace.files" :key="file" class="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[11.5px]">{{ file }}</li>
        </ul>
      </template>
      <p v-else-if="budget !== undefined">
        Il passo delegato userebbe <strong>{{ MODEL_TEXT[budget.model] ?? budget.model }}</strong> su {{ EXECUTOR_TEXT[budget.executor] ?? budget.executor }},
        che costa oltre il piano. Approvando, parte con questo modello; rifiutando, Arianna lo saprà e deciderà altrimenti.
      </p>
      <pre v-else class="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs break-words whitespace-pre-wrap">{{ detail }}</pre>
    </div>

    <div class="flex flex-wrap items-center gap-2 rounded-b-[14px] border-t border-line bg-surface-2 px-[15px] py-3">
      <button type="button" :disabled="busy" class="btn btn-primary" @click="choose('approved')"><Icon name="approve" :size="16" />Approva</button>
      <button type="button" :disabled="busy" class="btn" @click="choose('rejected')">Rifiuta</button>
    </div>
  </article>
</template>

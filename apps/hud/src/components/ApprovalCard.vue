<script setup lang="ts">
import { computed, ref } from 'vue';

import { ACTION_TEXT, declassifyLabels, EXECUTOR_TEXT, LABEL_TEXT, MODEL_TEXT } from '../lib/labels.ts';
import type { Approval } from '../lib/types.ts';

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
  <article
    class="rounded-xl border bg-white p-4 shadow-sm dark:bg-stone-950"
    :class="isDeclassify ? 'border-amber-300 dark:border-amber-800' : 'border-stone-200 dark:border-stone-800'"
  >
    <header class="flex items-center gap-2">
      <h3 class="text-sm font-semibold">{{ title }}</h3>
      <span v-if="labels" class="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {{ labels }}
      </span>
      <span class="ml-auto text-xs text-stone-500" :title="LABEL_TEXT[approval.label]">{{ approval.label }}</span>
    </header>

    <template v-if="isDeclassify && text !== undefined">
      <p class="mt-2 text-xs text-stone-600 dark:text-stone-400">
        Approvando, questo testo esatto viene declassato e può uscire dalla macchina. Nient'altro.
      </p>
      <pre
        class="mt-2 max-h-64 overflow-auto rounded-lg bg-stone-100 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words dark:bg-stone-900"
      >{{ text }}</pre>
    </template>
    <template v-else-if="workspace !== undefined">
      <p class="mt-2 text-xs text-stone-600 dark:text-stone-400">
        Il Coder lavorerebbe in <span class="font-mono">{{ workspace.repo }}</span>, dove hai modifiche non ancora committate. Approvando lavora
        sopra di esse, sul branch corrente; rifiutando, Arianna lo saprà. Oppure committa prima e riprendi il task.
      </p>
      <ul class="mt-2 max-h-40 overflow-auto rounded-lg bg-stone-100 p-3 font-mono text-xs leading-relaxed dark:bg-stone-900">
        <li v-for="file in workspace.files" :key="file">{{ file }}</li>
      </ul>
    </template>
    <p v-else-if="budget !== undefined" class="mt-2 text-xs text-stone-600 dark:text-stone-400">
      Il passo delegato userebbe <strong>{{ MODEL_TEXT[budget.model] ?? budget.model }}</strong> su {{ EXECUTOR_TEXT[budget.executor] ?? budget.executor }},
      che costa oltre il piano. Approvando, parte con questo modello; rifiutando, Arianna lo saprà e deciderà altrimenti.
    </p>
    <pre
      v-else
      class="mt-2 max-h-48 overflow-auto rounded-lg bg-stone-100 p-3 font-mono text-xs whitespace-pre-wrap break-words dark:bg-stone-900"
    >{{ detail }}</pre>

    <div class="mt-3 flex gap-2">
      <button
        type="button"
        :disabled="busy"
        class="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        @click="choose('approved')"
      >
        Approva
      </button>
      <button
        type="button"
        :disabled="busy"
        class="flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold hover:bg-stone-100 disabled:opacity-40 dark:border-stone-700 dark:hover:bg-stone-800"
        @click="choose('rejected')"
      >
        Rifiuta
      </button>
    </div>
  </article>
</template>

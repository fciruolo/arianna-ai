<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { approveGodPlan, loadMessagePlan } from '../lib/api.ts';
import { STATE_TEXT, waitsText, type MessagePlan } from '../lib/god-work.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

/**
 * The plan under an answer of GOD (D-127, G2): read and checked by the core
 * from the stored message (never from the page), shown as a card with its
 * subtasks; «Approva e avvia» starts them, each in a clone of its own. Once
 * approved, the card shows the states and opens the cruscotto of GOD.
 */
const props = defineProps<{ messageId: string }>();
const emit = defineEmits<{ dashboard: [] }>();

const plan = ref<MessagePlan | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

async function load(): Promise<void> {
  try {
    plan.value = await loadMessagePlan(props.messageId);
    error.value = null;
  } catch (cause) {
    error.value = `Non riesco a leggere il piano. ${errorText(cause)}`;
  }
}

async function approve(): Promise<void> {
  busy.value = true;
  try {
    const approved = await approveGodPlan(props.messageId);
    plan.value = { ...(plan.value ?? {}), approved };
    error.value = null;
  } catch (cause) {
    error.value = `Il piano non è partito. ${errorText(cause)}`;
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="hud-card mt-2 p-3" aria-label="Piano di GOD">
    <div class="flex flex-wrap items-center gap-2">
      <Icon name="god" :size="15" />
      <span class="font-hud text-[12.5px] font-semibold tracking-[0.14em] uppercase">Piano</span>
      <span v-if="plan?.proposal !== undefined" class="min-w-0 flex-1 truncate text-[14px] font-medium">{{ plan.proposal.title }}</span>
    </div>
    <p v-if="error !== null" role="alert" class="mt-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</p>
    <p v-if="plan?.error !== undefined" class="mt-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
      Il piano non si può avviare: {{ plan.error }}. Chiedi a GOD di correggerlo.
    </p>
    <ol v-if="plan?.proposal !== undefined" class="mt-2 flex flex-col gap-2">
      <li v-for="(subtask, index) in plan.proposal.subtasks" :key="index" class="rounded-lg border border-line px-3 py-2">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class="font-mono text-[12.5px] text-muted">{{ index + 1 }}</span>
          <span class="min-w-0 flex-1 text-[14.5px] font-medium">{{ subtask.title }}</span>
          <span v-if="waitsText(subtask.blockedBy) !== null" class="font-mono text-[12.5px] text-muted">{{ waitsText(subtask.blockedBy) }}</span>
          <span v-if="plan.approved?.subtasks[index] !== undefined" class="rounded-[5px] border border-line px-1.5 font-mono text-[12px] text-muted">
            {{ STATE_TEXT[plan.approved.subtasks[index].state] }}
          </span>
        </div>
        <p class="mt-1 text-[14px] whitespace-pre-wrap text-muted">{{ subtask.goal }}</p>
        <p class="mt-1 font-mono text-[12.5px] break-words text-muted">{{ subtask.files.join(' · ') }}</p>
      </li>
    </ol>
    <div v-if="plan?.proposal !== undefined" class="mt-3 flex flex-wrap items-center gap-2">
      <button
        v-if="plan.approved === undefined"
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-[14px] font-medium text-accent-ink disabled:opacity-50 touch:min-h-11"
        :disabled="busy"
        @click="approve"
      >
        <Icon name="approve" :size="15" />{{ busy ? 'Avvio…' : 'Approva e avvia' }}
      </button>
      <button v-else type="button" class="rounded-lg border border-line px-2.5 py-1 text-[13.5px] hover:border-line-strong touch:min-h-11" @click="emit('dashboard')">Apri il cruscotto di GOD</button>
      <span class="text-xs text-muted">
        {{ plan.approved === undefined ? 'Ogni sottocompito lavora in un clone suo, con il Coder; poi il Reviewer. L’unione in main la fai tu.' : 'Approvato: i sottocompiti partono secondo la quota.' }}
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { listActivities } from '../lib/api.ts';
import { activityText, errorText, relativeTimeText, stepsButtonText } from '../lib/italian.ts';
import type { SavedActivity } from '../lib/types.ts';
import Icon from './Icon.vue';

/**
 * The steps of a finished task (D-083): a small button under its last
 * message that opens, on request, the activity lines the task saved while it
 * worked, each with how long ago it was written.
 */
const props = defineProps<{ taskId: string; count: number }>();

const open = ref(false);
const lines = ref<SavedActivity[] | null>(null);
const loading = ref(false);
const problem = ref<string | null>(null);
const now = ref(new Date());

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (!open.value) return;
  now.value = new Date();
  if (lines.value !== null && lines.value.length >= props.count) return;
  loading.value = true;
  problem.value = null;
  try {
    lines.value = await listActivities(props.taskId);
  } catch (cause) {
    problem.value = errorText(cause);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-1.5 text-[12.5px]">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 self-start font-mono text-[10.5px] text-muted hover:text-info"
      :aria-expanded="open"
      title="Cosa ha fatto Arianna mentre lavorava a questa risposta"
      @click="toggle"
    >
      <Icon name="history" :size="12" />{{ stepsButtonText(count, open) }}
    </button>
    <div v-if="open" class="rounded-lg border border-line bg-surface-2 px-3 py-2" aria-live="polite">
      <p v-if="loading" class="text-xs text-muted">Carico i passi…</p>
      <p v-else-if="problem !== null" class="text-xs text-warn">{{ problem }}</p>
      <ul v-else-if="lines !== null" class="flex flex-col gap-[5px]">
        <li v-for="line in lines" :key="line.id" class="flex items-start gap-2.5">
          <span class="w-4 shrink-0 text-center font-mono text-[11px]" :class="line.kind === 'error' ? 'text-warn' : 'text-ok'" aria-hidden="true">{{
            line.kind === 'error' ? '!' : '✓'
          }}</span>
          <span class="min-w-0 flex-1 break-words">{{ activityText(line) }}</span>
          <time class="shrink-0 font-mono text-[10.5px] text-muted" :datetime="line.at" :title="new Date(line.at).toLocaleString('it-IT')">{{
            relativeTimeText(line.at, now)
          }}</time>
        </li>
      </ul>
    </div>
  </div>
</template>

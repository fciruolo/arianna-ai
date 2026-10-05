<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

import { listDelegations } from '../lib/api.ts';
import { agentName, DELEGATION_STATUS_TEXT, durationText, errorText, runnerText } from '../lib/italian.ts';
import type { RecentDelegation, StatusSnapshot } from '../lib/types.ts';
import Icon from './Icon.vue';

/**
 * "Deleghe recenti" (D-082): the latest steps handed to the Coder, with
 * executor, model, outcome, time and files changed. Metadata only: never the
 * brief or the report. Read again whenever the status panel is.
 */
const props = defineProps<{ status: StatusSnapshot | null }>();
const emit = defineEmits<{ open: [conversationId: string] }>();

const rows = ref<RecentDelegation[]>([]);
const problem = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    rows.value = await listDelegations(8);
    problem.value = null;
  } catch (cause) {
    problem.value = errorText(cause);
  }
}

onMounted(refresh);
watch(() => props.status, refresh);

const statusClass: Record<RecentDelegation['status'], string> = {
  pending: 'text-muted',
  running: 'text-accent',
  ok: 'text-ok',
  failed: 'text-danger',
  refused: 'text-warn',
};

function when(ts: string): string {
  const date = new Date(ts);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}
</script>

<template>
  <section>
    <h3 class="hud-title mb-2.5 flex items-center justify-between">
      <span class="flex items-center gap-1.5"><Icon name="history" :size="14" />Deleghe recenti</span>
      <small class="font-mono text-[10px] tracking-[0.06em] normal-case">chi ha fatto cosa</small>
    </h3>
    <p v-if="problem !== null" class="text-[11.5px] text-warn">{{ problem }}</p>
    <p v-else-if="rows.length === 0" class="text-[11.5px] text-muted">Nessuna delega ancora.</p>
    <ul v-else class="flex flex-col gap-1.5">
      <li v-for="row in rows" :key="row.id" class="rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-xs">
        <div class="flex items-center gap-2">
          <b class="font-semibold">{{ agentName(row.agent) }}</b>
          <span :class="statusClass[row.status]">{{ DELEGATION_STATUS_TEXT[row.status] }}</span>
          <span class="ml-auto font-mono text-[10.5px] text-muted">{{ when(row.createdAt) }}</span>
        </div>
        <div class="mt-0.5 truncate font-mono text-[10.5px] text-muted" :title="runnerText(row)">
          {{ row.executor === null && row.alias === null ? 'non avviata' : runnerText(row) }}<template v-if="durationText(row.durationMs) !== undefined"> · {{ durationText(row.durationMs) }}</template><template v-if="row.files !== null && row.files > 0"> · {{ row.files }} file</template>
        </div>
        <button
          v-if="row.conversationId !== null"
          type="button"
          class="mt-0.5 block max-w-full truncate text-left text-[11px] text-info hover:underline"
          @click="emit('open', row.conversationId)"
        >
          {{ row.conversationTitle ?? 'Conversazione' }}<template v-if="row.repo !== null"> · {{ row.repo }}</template>
        </button>
      </li>
    </ul>
  </section>
</template>

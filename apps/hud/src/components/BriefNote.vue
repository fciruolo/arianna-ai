<script setup lang="ts">
/**
 * «Ha visto solo il brief» under the report of an agent in a chat with
 * Arianna (D-107, tappa B2): of this chat the agent read only the text of the
 * request; besides it, its own instructions and, in a project, what the
 * project gives it (notes, files). A click shows that text, read from the core.
 */
import { ref } from 'vue';
import { loadBrief } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import LabelBadge from './LabelBadge.vue';
import type { Label } from '../lib/types.ts';

const props = defineProps<{ conversationId: string; delegationId: string }>();

const open = ref(false);
const brief = ref<{ brief: string; label: Label } | null>(null);
const problem = ref<string | null>(null);

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (!open.value || brief.value !== null) return;
  problem.value = null;
  try {
    brief.value = await loadBrief(props.conversationId, props.delegationId);
  } catch (cause) {
    problem.value = `Brief non letto. ${errorText(cause)}`;
  }
}
</script>

<template>
  <div class="w-full text-[13px] text-muted">
    <button type="button" class="hover:text-ink hover:underline" :aria-expanded="open" title="Di questa chat ha letto solo il testo della richiesta; in più ha le sue istruzioni e, in un progetto, ciò che il progetto gli dà" @click="toggle">
      Ha visto solo il brief {{ open ? '▾' : '▸' }}
    </button>
    <div v-if="open" class="mt-1.5 rounded-lg bg-bg/60 px-2.5 py-2">
      <p v-if="problem !== null" class="text-danger">{{ problem }}</p>
      <p v-else-if="brief === null">Leggo…</p>
      <template v-else>
        <p class="mb-1 flex items-center gap-2">La richiesta che ha ricevuto da questa chat <LabelBadge :label="brief.label" /></p>
        <p class="break-words whitespace-pre-wrap text-ink">{{ brief.brief }}</p>
      </template>
    </div>
  </div>
</template>

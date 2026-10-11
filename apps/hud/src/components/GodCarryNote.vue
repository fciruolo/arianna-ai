<script setup lang="ts">
import { ref, watch } from 'vue';

import { loadGodCarry, restartGodConversation } from '../lib/api.ts';
import { carryOriginText, type GodCarry } from '../lib/god.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

/**
 * At the top of a conversation with GOD (D-127, G4): "Riassumi e riparti",
 * which opens a new conversation with a fresh session that starts from a
 * summary of this one written by the code; and, in a conversation restarted
 * that way, the summary it carries (what GOD read with the dossier); in one
 * opened by "Parlane con GOD" (I-6), the entry of "Novità" and its git facts.
 */
const props = defineProps<{ conversationId: string; empty: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();

const carry = ref<GodCarry | null>(null);

function openFrom(): void {
  const from = carry.value?.from ?? null;
  if (from !== null) emit('open', from);
}
const shown = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.conversationId,
  async (id) => {
    carry.value = null;
    shown.value = false;
    try {
      carry.value = await loadGodCarry(id);
    } catch {
      // An older core, or nothing to show: the note stays empty.
    }
  },
  { immediate: true },
);

async function restart(): Promise<void> {
  busy.value = true;
  try {
    const conversation = await restartGodConversation(props.conversationId);
    error.value = null;
    emit('open', conversation.id);
  } catch (cause) {
    error.value = `Non sono riuscita a ripartire. ${errorText(cause)}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="hud-card px-3 py-2.5" aria-label="Contesto di GOD">
    <div class="flex flex-wrap items-center gap-2">
      <Icon name="god" :size="14" />
      <span v-if="carry !== null" class="min-w-0 flex-1 text-[12.5px]">
        {{ carryOriginText(carry) }}
        <button type="button" class="text-info hover:underline" @click="shown = !shown">{{ shown ? 'Nascondi il contesto' : 'Mostra il contesto' }}</button>
        <template v-if="carry.from !== null">
          ·
          <button type="button" class="text-info hover:underline" @click="openFrom">apri quella</button>
        </template>
      </span>
      <span v-else class="min-w-0 flex-1 text-[12.5px] text-muted">Quando la conversazione si allunga, riparti da un riassunto: la chat resta qui intera.</span>
      <button
        v-if="!empty"
        type="button"
        class="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-line-strong disabled:opacity-50"
        :disabled="busy"
        title="Una conversazione nuova con GOD, che parte dal riassunto di questa e dal fascicolo"
        @click="restart"
      >
        {{ busy ? 'Riassumo…' : 'Riassumi e riparti' }}
      </button>
    </div>
    <pre v-if="shown && carry !== null" class="mt-2 max-h-72 overflow-y-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted">{{ carry.body }}</pre>
    <p v-if="error !== null" role="alert" class="mt-2 text-[12.5px] text-danger">{{ error }}</p>
  </section>
</template>

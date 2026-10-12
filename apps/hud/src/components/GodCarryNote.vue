<script setup lang="ts">
import { ref, watch } from 'vue';

import { loadGodCarry } from '../lib/api.ts';
import { carryOriginText, type GodCarry } from '../lib/god.ts';
import Icon from './Icon.vue';

/**
 * At the top of a conversation with GOD (D-127, G4), only when it starts from
 * a context: in a conversation restarted from a summary (GodCarryProposal),
 * the summary it carries (what GOD read with the dossier); in one opened by
 * "Parlane con GOD" (I-6), the entry of "Novità" and its git facts.
 */
const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ open: [id: string] }>();

const carry = ref<GodCarry | null>(null);

function openFrom(): void {
  const from = carry.value?.from ?? null;
  if (from !== null) emit('open', from);
}
const shown = ref(false);

watch(
  () => props.conversationId,
  async (id) => {
    carry.value = null;
    shown.value = false;
    try {
      carry.value = await loadGodCarry(id);
    } catch {
      // An older core, or nothing to show: no note.
    }
  },
  { immediate: true },
);
</script>

<template>
  <section v-if="carry !== null" class="hud-card px-3 py-2.5" aria-label="Contesto di GOD">
    <div class="flex flex-wrap items-center gap-2">
      <Icon name="god" :size="14" />
      <span class="min-w-0 flex-1 text-[13.5px]">
        {{ carryOriginText(carry) }}
        <button type="button" class="text-info hover:underline" @click="shown = !shown">{{ shown ? 'Nascondi il contesto' : 'Mostra il contesto' }}</button>
        <template v-if="carry.from !== null">
          ·
          <button type="button" class="text-info hover:underline" @click="openFrom">apri quella</button>
        </template>
      </span>
    </div>
    <pre v-if="shown" class="mt-2 max-h-72 overflow-y-auto font-mono text-[12.5px] whitespace-pre-wrap text-muted">{{ carry.body }}</pre>
  </section>
</template>

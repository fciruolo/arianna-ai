<script setup lang="ts">
import { computed } from 'vue';

import { LABEL_TEXT, MODE_TEXT } from '../lib/labels.ts';
import type { Conversation } from '../lib/types.ts';
import Icon from './Icon.vue';

/**
 * The header of one of the two conversations side by side (D-234): where it
 * is, its title and its label, so each side says its own; «Chiudi» on the one beside.
 */
const props = defineProps<{
  conversation: Conversation | undefined;
  /** «Chiudi» on this pane: only the conversation beside has it. */
  closable?: boolean;
}>();
const emit = defineEmits<{ legend: []; close: [] }>();

const title = computed(() => props.conversation?.title ?? 'Nuova conversazione');
const crumb = computed(() => {
  const conversation = props.conversation;
  if (conversation === undefined) return [];
  const project = conversation.workspace?.split('/').at(-1);
  return [...(conversation.origin === 'system' ? ['Chat di sistema'] : []), MODE_TEXT[conversation.mode], ...(project === undefined ? [] : [project])];
});
const labelClass: Record<string, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };
</script>

<template>
  <header class="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-4">
    <p class="min-w-0 flex-1 truncate text-[13.5px] text-muted">
      <template v-if="conversation !== undefined">
        <span v-for="part in crumb" :key="part">{{ part }} / </span>
        <b class="font-medium text-ink">{{ title }}</b>
      </template>
      <template v-else>Apro la conversazione…</template>
    </p>
    <button
      v-if="conversation !== undefined"
      type="button"
      class="lab inline-flex shrink-0 items-center gap-1"
      :class="labelClass[conversation.clearance]"
      :title="`${LABEL_TEXT[conversation.clearance]} · ${conversation.mode === 'work' ? 'può uscire' : 'resta qui'}: cosa vogliono dire le etichette`"
      :aria-label="`Etichetta ${LABEL_TEXT[conversation.clearance]}, ${conversation.mode === 'work' ? 'può uscire' : 'resta qui'}: apri la legenda delle etichette`"
      aria-haspopup="dialog"
      @click="emit('legend')"
    >
      <i class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />{{ LABEL_TEXT[conversation.clearance] }} · {{ conversation.mode === 'work' ? 'può uscire' : 'resta qui' }}
    </button>
    <button
      v-if="closable"
      type="button"
      class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-ink"
      title="Chiudi: la conversazione aperta torna a tutta pagina"
      :aria-label="`Chiudi la conversazione affiancata ${title}`"
      @click="emit('close')"
    >
      <Icon name="close" :size="14" />Chiudi
    </button>
  </header>
</template>

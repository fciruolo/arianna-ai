<script setup lang="ts">
import { ref } from 'vue';

import { useModal } from '../lib/modal.ts';
import type { Approval, ExecutorChoice } from '../lib/types.ts';
import CardwallPage from './CardwallPage.vue';
import Icon from './Icon.vue';

/**
 * The cardwall in the office (I-13 tappa C4, D-165): the same CardwallPage,
 * with the same filters, view and columns (they live in the browser's
 * storage), in a window over the lower part of the office. The office keeps
 * running above and around it: the agents stay at their desks. Esc, the
 * button or a click outside go back to the office, with the focus on the
 * canvas. It holds the card's detail and the filter menus: their Esc comes
 * first (`holder`).
 */
defineProps<{
  version: number;
  approvals: Approval[];
  decide: (approval: Approval, state: 'approved' | 'rejected', choice?: ExecutorChoice) => Promise<void>;
}>();
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLElement | null>(null);
const back = ref<HTMLElement | null>(null);
useModal(dialog, () => emit('close'), back, { holder: true });
</script>

<template>
  <div class="fixed inset-0 z-30 bg-black/25" aria-hidden="true" @click="emit('close')" />
  <section
    ref="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="office-cardwall-title"
    tabindex="-1"
    class="fixed inset-x-2 top-[14vh] bottom-2 z-30 flex flex-col overflow-hidden rounded-xl border border-line-strong bg-bg shadow-[0_14px_40px_#0006] outline-none md:inset-x-6 md:top-[30vh] md:bottom-4"
  >
    <header class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 md:px-6">
      <Icon name="cardwall" :size="16" />
      <h2 id="office-cardwall-title" class="font-medium">Cardwall</h2>
      <span class="hidden min-w-0 truncate text-xs text-muted sm:inline">nell'ufficio, con i filtri della pagina Cardwall</span>
      <button ref="back" type="button" class="btn ml-auto px-2.5 py-1 text-xs" @click="emit('close')">
        <Icon name="close" :size="14" />Torna all'ufficio
      </button>
    </header>
    <CardwallPage :version="version" :approvals="approvals" :decide="decide" />
  </section>
</template>

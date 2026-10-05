<script setup lang="ts">
import { ref } from 'vue';

import { useModal } from '../lib/modal.ts';
import type { DraftChoice } from '../lib/draft.ts';
import type { ProjectInfo } from '../lib/types.ts';
import Icon from './Icon.vue';
import NewConversation from './NewConversation.vue';

/** "+ Nuovo" of the left bar (D-097): private, work or with the Coder (D-111), and the project. */
defineProps<{ projects: ProjectInfo[] }>();
const emit = defineEmits<{ close: []; create: [choice: DraftChoice]; refresh: [] }>();

const dialog = ref<HTMLElement | null>(null);
useModal(dialog, () => emit('close'));

function create(choice: DraftChoice): void {
  emit('create', choice);
  emit('close');
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[14vh]" @click.self="emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-title"
      tabindex="-1"
      class="hud-card flex w-full max-w-[420px] flex-col bg-surface outline-none"
    >
      <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span class="text-accent"><Icon name="new" :size="18" /></span>
        <h2 id="new-title" class="flex-1 font-medium">Nuova conversazione</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="px-[15px] py-3.5">
        <NewConversation :projects="projects" @create="create" @refresh="emit('refresh')" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { useModal } from '../lib/modal.ts';
import type { DraftChoice } from '../lib/draft.ts';
import type { CharacterChoice, DirectAgent, ProjectInfo } from '../lib/types.ts';
import Icon from './Icon.vue';
import NewConversation from './NewConversation.vue';

/** "+ Nuovo" of the left bar (D-097): private, work or with an agent (D-111d), and the project. */
/** `initialAgent`: opened on the direct chat with this agent ("Apri una chat" in Impostazioni → Agenti, D-133). */
defineProps<{ projects: ProjectInfo[]; agents: DirectAgent[]; characters?: Record<string, CharacterChoice> | undefined; initialAgent?: string | undefined }>();
const emit = defineEmits<{ close: []; create: [choice: DraftChoice]; refresh: [] }>();

const dialog = ref<HTMLElement | null>(null);
useModal(dialog, () => emit('close'));

function create(choice: DraftChoice): void {
  emit('create', choice);
  emit('close');
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh] sm:pt-[14vh]" @click.self="emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-title"
      tabindex="-1"
      class="hud-card flex max-h-[84vh] w-full max-w-[34rem] flex-col overflow-y-auto bg-surface outline-none"
    >
      <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span class="text-accent"><Icon name="new" :size="18" /></span>
        <h2 id="new-title" class="flex-1 font-medium">Nuova conversazione</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="px-4 py-4">
        <NewConversation :projects="projects" :agents="agents" :characters="characters" :initial-agent="initialAgent" @create="create" @refresh="emit('refresh')" />
      </div>
    </section>
  </div>
</template>

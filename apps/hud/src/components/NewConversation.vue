<script setup lang="ts">
import { ref, watch } from 'vue';

import { MODE_HINT, MODE_TEXT } from '../lib/labels.ts';
import type { ConversationMode, ProjectInfo } from '../lib/types.ts';
import Icon from './Icon.vue';

const props = defineProps<{ projects: ProjectInfo[] }>();
const emit = defineEmits<{ create: [mode: ConversationMode, project?: string]; refresh: [] }>();
const mode = ref<ConversationMode>('private');
const project = ref('');
const modes: ConversationMode[] = ['private', 'work'];

// The list changes without a restart of the core (D-058): read it again when a work conversation is about to start.
watch(mode, (value) => {
  if (value === 'work') emit('refresh');
});
// The first approved project is the default; a project taken off the list is no longer chosen.
watch(
  () => props.projects,
  (list) => {
    if (!list.some((entry) => entry.name === project.value)) project.value = list[0]?.name ?? '';
  },
  { immediate: true },
);

function submit(): void {
  if (mode.value === 'work' && project.value !== '') emit('create', mode.value, project.value);
  else emit('create', mode.value);
}
</script>

<template>
  <form class="flex flex-col gap-2" @submit.prevent="submit">
    <div class="grid grid-cols-2 gap-1 rounded-[9px] border border-line bg-surface-2 p-1" role="radiogroup" aria-label="Modalità">
      <button
        v-for="option in modes"
        :key="option"
        type="button"
        role="radio"
        :aria-checked="mode === option"
        class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition"
        :class="mode === option ? 'bg-surface text-accent shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
        @click="mode = option"
      >
        <Icon :name="option" :size="14" />{{ MODE_TEXT[option] }}
      </button>
    </div>
    <p class="px-0.5 text-xs leading-snug text-muted">{{ MODE_HINT[mode] }}</p>
    <template v-if="mode === 'work'">
      <label v-if="projects.length > 0" class="flex flex-col gap-1 text-xs text-muted">
        Progetto
        <select v-model="project" class="field px-2.5 py-1.5 text-[13px]">
          <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ entry.path }}</option>
          <option value="">Nessun progetto</option>
        </select>
      </label>
      <p v-else class="text-xs leading-snug text-muted">
        Nessun progetto approvato: il Coder non ha dove lavorare. Aggiungine uno con
        <code class="font-mono">pnpm arianna:init --reconfigure</code>.
      </p>
    </template>
    <button
      type="submit"
      class="flex w-full items-center gap-2 rounded-[9px] border border-line-strong bg-surface-2 px-3 py-2.5 text-left font-medium hover:border-accent"
    >
      <Icon name="new" />Nuova conversazione
    </button>
  </form>
</template>

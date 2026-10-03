<script setup lang="ts">
import { ref, watch } from 'vue';

import { MODE_HINT, MODE_TEXT } from '../lib/labels.ts';
import type { ConversationMode, ProjectInfo } from '../lib/types.ts';

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
    <div class="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-800" role="radiogroup" aria-label="Modalità">
      <button
        v-for="option in modes"
        :key="option"
        type="button"
        role="radio"
        :aria-checked="mode === option"
        class="rounded-md px-2 py-1.5 text-sm font-medium transition"
        :class="
          mode === option
            ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-white'
            : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200'
        "
        @click="mode = option"
      >
        {{ MODE_TEXT[option] }}
      </button>
    </div>
    <p class="text-xs leading-snug text-stone-500 dark:text-stone-400">{{ MODE_HINT[mode] }}</p>
    <template v-if="mode === 'work'">
      <label v-if="projects.length > 0" class="flex flex-col gap-1 text-xs text-stone-500 dark:text-stone-400">
        Progetto
        <select
          v-model="project"
          class="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-900 outline-none focus:border-indigo-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        >
          <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ entry.path }}</option>
          <option value="">Nessun progetto</option>
        </select>
      </label>
      <p v-else class="text-xs leading-snug text-stone-500 dark:text-stone-400">
        Nessun progetto approvato: il Coder non ha dove lavorare. Aggiungine uno con
        <code class="font-mono">pnpm arianna:init --reconfigure</code>.
      </p>
    </template>
    <button
      type="submit"
      class="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
    >
      Nuova conversazione
    </button>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { coderWarning, type DraftChoice } from '../lib/draft.ts';
import { MODE_HINT, MODE_TEXT } from '../lib/labels.ts';
import type { ProjectInfo } from '../lib/types.ts';
import Icon from './Icon.vue';

const props = defineProps<{ projects: ProjectInfo[] }>();
const emit = defineEmits<{ create: [choice: DraftChoice]; refresh: [] }>();
/** Private, work with Arianna, or the direct chat with the Coder (D-111), always on a project. */
type Kind = 'private' | 'work' | 'coder';
const kind = ref<Kind>('private');
const project = ref('');
const kinds: { id: Kind; text: string; icon: 'private' | 'work' | 'coder' }[] = [
  { id: 'private', text: MODE_TEXT.private, icon: 'private' },
  { id: 'work', text: MODE_TEXT.work, icon: 'work' },
  { id: 'coder', text: 'Con il Coder', icon: 'coder' },
];
const hint = computed(() =>
  kind.value === 'coder' ? 'Parli direttamente con il Coder (Claude Code) su un progetto, senza Arianna in mezzo.' : MODE_HINT[kind.value],
);
// The direct chat has no "Nessun progetto": the first project is chosen when the empty one was.
const coderProject = computed(() => (kind.value === 'coder' && project.value === '' ? (props.projects[0]?.name ?? '') : project.value));

// The list changes without a restart of the core (D-058): read it again when a work conversation is about to start.
watch(kind, (value) => {
  if (value !== 'private') emit('refresh');
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
  if (kind.value === 'coder') {
    if (coderProject.value !== '') emit('create', { mode: 'work', project: coderProject.value, agent: 'coder' });
    return;
  }
  if (kind.value === 'work' && project.value !== '') emit('create', { mode: 'work', project: project.value });
  else emit('create', { mode: kind.value });
}
</script>

<template>
  <form class="flex flex-col gap-2" @submit.prevent="submit">
    <div class="grid grid-cols-3 gap-1 rounded-[9px] border border-line bg-surface-2 p-1" role="radiogroup" aria-label="Modalità">
      <button
        v-for="option in kinds"
        :key="option.id"
        type="button"
        role="radio"
        :aria-checked="kind === option.id"
        class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition"
        :class="kind === option.id ? 'bg-surface text-accent shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
        @click="kind = option.id"
      >
        <Icon :name="option.icon" :size="14" />{{ option.text }}
      </button>
    </div>
    <p class="px-0.5 text-xs leading-snug text-muted">{{ hint }}</p>
    <template v-if="kind !== 'private'">
      <label v-if="projects.length > 0" class="flex flex-col gap-1 text-xs text-muted">
        Progetto
        <select v-if="kind === 'coder'" :value="coderProject" class="field px-2.5 py-1.5 text-[13px]" @change="project = ($event.target as HTMLSelectElement).value">
          <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ entry.path }}</option>
        </select>
        <select v-else v-model="project" class="field px-2.5 py-1.5 text-[13px]">
          <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ entry.path }}</option>
          <option value="">Nessun progetto</option>
        </select>
      </label>
      <p v-else class="text-xs leading-snug text-muted">
        Nessun progetto approvato: il Coder non ha dove lavorare. Aggiungine uno con
        <code class="font-mono">pnpm arianna:init --reconfigure</code>.
      </p>
      <p v-if="kind === 'coder' && projects.length > 0" role="note" class="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
        {{ coderWarning(coderProject) }}
      </p>
    </template>
    <button
      type="submit"
      :disabled="kind === 'coder' && coderProject === ''"
      class="flex w-full items-center gap-2 rounded-[9px] border border-line-strong bg-surface-2 px-3 py-2.5 text-left font-medium hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon :name="kind === 'coder' ? 'coder' : 'new'" />{{ kind === 'coder' ? 'Parla con il Coder' : 'Nuova conversazione' }}
    </button>
  </form>
</template>

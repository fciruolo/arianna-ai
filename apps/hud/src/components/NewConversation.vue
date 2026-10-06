<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { cloudWarning, localNote, type DraftChoice } from '../lib/draft.ts';
import { agentName } from '../lib/italian.ts';
import { MODE_HINT, MODE_TEXT } from '../lib/labels.ts';
import type { CharacterChoice, ConversationMode, DirectAgent, ProjectInfo } from '../lib/types.ts';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

const props = defineProps<{ projects: ProjectInfo[]; agents: DirectAgent[]; characters?: Record<string, CharacterChoice> | undefined }>();
const emit = defineEmits<{ create: [choice: DraftChoice]; refresh: [] }>();
/** Private or work with Arianna, or the direct chat with an agent (D-111d), as its card allows. */
type Kind = 'private' | 'work' | 'agent';
const kind = ref<Kind>('private');
const project = ref('');
const agent = ref('');
const agentMode = ref<ConversationMode>('private');
const kinds: { id: Kind; text: string; icon: 'private' | 'work' | 'coder' }[] = [
  { id: 'private', text: MODE_TEXT.private, icon: 'private' },
  { id: 'work', text: MODE_TEXT.work, icon: 'work' },
  { id: 'agent', text: 'Con un agente', icon: 'coder' },
];

const policy = computed(() => props.agents.find((entry) => entry.agent === agent.value));
/** The mode of the direct chat: the one chosen when the card allows both, else the only one. */
const mode = computed<ConversationMode>(() => {
  const modes = policy.value?.modes ?? [];
  return modes.includes(agentMode.value) ? agentMode.value : (modes[0] ?? 'work');
});
// An agent on Claude works in a project: no "Nessun progetto" there, the first project is chosen when the empty one was.
const agentProject = computed(() => (policy.value?.project === true && project.value === '' ? (props.projects[0]?.name ?? '') : project.value));
const hint = computed(() => {
  if (kind.value !== 'agent') return MODE_HINT[kind.value];
  return 'Parli direttamente con un agente, senza Arianna in mezzo. Dove gira e che dati può leggere li decide la sua scheda.';
});
const ready = computed(() => {
  if (kind.value !== 'agent') return true;
  if (policy.value === undefined) return false;
  return !policy.value.project || agentProject.value !== '';
});

// The lists change without a restart of the core (D-058, D-111d): read them again when they are about to be used.
watch(kind, (value) => {
  if (value !== 'private') emit('refresh');
});
// The first approved project and the first agent are the defaults; one taken off the list is no longer chosen.
watch(
  () => props.projects,
  (list) => {
    if (!list.some((entry) => entry.name === project.value)) project.value = list[0]?.name ?? '';
  },
  { immediate: true },
);
watch(
  () => props.agents,
  (list) => {
    if (!list.some((entry) => entry.agent === agent.value)) agent.value = list[0]?.agent ?? '';
  },
  { immediate: true },
);

function submit(): void {
  if (kind.value === 'agent') {
    const chosen = policy.value;
    if (chosen === undefined || !ready.value) return;
    const withProject = chosen.project || (mode.value === 'work' && project.value !== '');
    emit('create', { mode: mode.value, agent: chosen.agent, ...(withProject && mode.value === 'work' ? { project: agentProject.value } : {}) });
    return;
  }
  if (kind.value === 'work' && project.value !== '') emit('create', { mode: 'work', project: project.value });
  else emit('create', { mode: kind.value });
}
</script>

<template>
  <form class="flex flex-col gap-2" @submit.prevent="submit">
    <div class="grid grid-cols-3 gap-1 rounded-[9px] border border-line bg-surface-2 p-1" role="radiogroup" aria-label="Con chi parli">
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

    <template v-if="kind === 'agent'">
      <!-- One card per agent (the user's choice after the trial of D-111d): character, name, where it runs, what it does. -->
      <div v-if="agents.length > 0" class="grid max-h-[46vh] grid-cols-2 gap-2 overflow-y-auto p-0.5" role="radiogroup" aria-label="Agente">
        <button
          v-for="entry in agents"
          :key="entry.agent"
          type="button"
          role="radio"
          :aria-checked="agent === entry.agent"
          class="flex flex-col items-start gap-1.5 rounded-[10px] border p-2.5 text-left transition"
          :class="agent === entry.agent ? 'border-accent bg-surface shadow-[inset_0_0_0_1px_var(--accent)]' : 'border-line bg-surface-2 hover:border-line-strong'"
          @click="agent = entry.agent"
        >
          <span class="flex w-full items-center gap-2">
            <PixelAgent :choice="characters?.[entry.agent]" pose="idle" :scale="1" />
            <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{{ agentName(entry.agent) }}</span>
          </span>
          <span
            class="rounded-full border px-1.5 py-px font-mono text-[10px]"
            :class="entry.cloud ? 'border-l1/60 text-l1' : 'border-line-strong text-muted'"
          >{{ entry.cloud ? 'Claude' : 'locale' }}</span>
          <span v-if="entry.description !== ''" class="line-clamp-2 text-[11.5px] leading-snug text-muted" :title="entry.description">{{ entry.description }}</span>
        </button>
      </div>
      <p v-else class="text-xs leading-snug text-muted">Nessun agente può rispondere adesso: attivane uno in Impostazioni → Agenti.</p>
      <div v-if="policy !== undefined && policy.modes.length > 1" class="grid grid-cols-2 gap-1 rounded-[9px] border border-line bg-surface-2 p-1" role="radiogroup" aria-label="Modalità">
        <button
          v-for="option in policy.modes"
          :key="option"
          type="button"
          role="radio"
          :aria-checked="mode === option"
          class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition"
          :class="mode === option ? 'bg-surface text-accent shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
          @click="agentMode = option"
        >
          <Icon :name="option" :size="13" />{{ MODE_TEXT[option] }}
        </button>
      </div>
      <template v-if="policy?.project === true">
        <label v-if="projects.length > 0" class="flex flex-col gap-1 text-xs text-muted">
          Progetto
          <select :value="agentProject" class="field px-2.5 py-1.5 text-[13px]" @change="project = ($event.target as HTMLSelectElement).value">
            <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ entry.path }}</option>
          </select>
        </label>
        <p v-else class="text-xs leading-snug text-muted">
          {{ agentName(policy.agent) }} lavora in un progetto, e non ce n'è uno approvato: aggiungilo con
          <code class="font-mono">pnpm arianna:init --reconfigure</code>.
        </p>
      </template>
      <p
        v-if="policy !== undefined"
        role="note"
        class="rounded-lg border px-3 py-2 text-xs leading-snug"
        :class="policy.cloud ? 'border-warn/50 bg-warn/10 text-warn' : 'border-line bg-surface-2 text-muted'"
      >
        {{ policy.cloud ? cloudWarning(policy.agent, policy.project ? agentProject : undefined) : localNote(policy.agent) }}
      </p>
    </template>

    <template v-else-if="kind === 'work'">
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
      :disabled="!ready"
      class="flex w-full items-center gap-2 rounded-[9px] border border-line-strong bg-surface-2 px-3 py-2.5 text-left font-medium hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon :name="kind === 'agent' ? 'coder' : 'new'" />{{ kind === 'agent' && policy !== undefined ? `Parla con ${agentName(policy.agent)}` : 'Nuova conversazione' }}
    </button>
  </form>
</template>

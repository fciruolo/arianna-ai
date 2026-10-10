<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { arrowChoice, cloudNotice, localNote, shortTarget, type DraftChoice } from '../lib/draft.ts';
import { agentDescription, agentTitle } from '../lib/italian.ts';
import { MODE_HINT, MODE_TEXT } from '../lib/labels.ts';
import type { CharacterChoice, ConversationMode, DirectAgent, ProjectInfo } from '../lib/types.ts';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

/** `initialAgent`: the direct chat with this agent is the first choice (D-133). */
const props = defineProps<{ projects: ProjectInfo[]; agents: DirectAgent[]; characters?: Record<string, CharacterChoice> | undefined; initialAgent?: string | undefined }>();
const emit = defineEmits<{ create: [choice: DraftChoice]; refresh: [] }>();
/** Private or work with Arianna, or the direct chat with an agent (D-111d), as its card allows. */
/** Incognito (D-136): with Arianna, private or work, its texts deleted when it closes. */
type Kind = 'private' | 'work' | 'agent' | 'incognito';
const kind = ref<Kind>(props.initialAgent === undefined ? 'private' : 'agent');
const project = ref('');
const agent = ref(props.initialAgent ?? '');
const agentMode = ref<ConversationMode>('private');
const incognitoMode = ref<ConversationMode>('private');
const kinds: { id: Kind; text: string; icon: 'private' | 'work' | 'coder' | 'incognito' }[] = [
  { id: 'private', text: MODE_TEXT.private, icon: 'private' },
  { id: 'work', text: MODE_TEXT.work, icon: 'work' },
  // Short, so that the four never wrap (D-158); the hint below says the rest.
  { id: 'agent', text: 'Agente', icon: 'coder' },
  { id: 'incognito', text: 'Incognito', icon: 'incognito' },
];
const modes: ConversationMode[] = ['private', 'work'];

const policy = computed(() => props.agents.find((entry) => entry.agent === agent.value));
/** The mode of the direct chat: the one chosen when the card allows both, else the only one. */
const mode = computed<ConversationMode>(() => {
  const modes = policy.value?.modes ?? [];
  return modes.includes(agentMode.value) ? agentMode.value : (modes[0] ?? 'work');
});
// An agent on Claude or Codex works in a project: no "Nessun progetto" there, the first project is chosen when the empty one was.
const agentProject = computed(() => (policy.value?.project === true && project.value === '' ? (props.projects[0]?.name ?? '') : project.value));
const hint = computed(() => {
  if (kind.value === 'incognito') {
    return `Come una conversazione ${incognitoMode.value === 'private' ? 'privata' : 'di lavoro'}, ma non compare nella lista e alla chiusura Arianna ne cancella i testi. Prima del primo messaggio vedi cosa resta fuori.`;
  }
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

/** The arrows move the choice inside a group, as in any radio group (D-158); the focus follows the chosen option. */
async function arrows<T>(event: KeyboardEvent, options: readonly T[], current: T, choose: (value: T) => void): Promise<void> {
  const next = arrowChoice(options, current, event.key);
  if (next === undefined) return;
  event.preventDefault();
  const group = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  choose(next);
  await nextTick();
  group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
}
const kindIds = kinds.map((option) => option.id);
const agentIds = computed(() => props.agents.map((entry) => entry.agent));
/** Enter on a choice opens the conversation, as the button does (D-158); Space chooses. */
function enter(event: KeyboardEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : undefined;
  if (target?.getAttribute('role') !== 'radio') return;
  event.preventDefault();
  submit();
}
const notice = computed(() => (policy.value?.cloud === true ? cloudNotice(policy.value.agent, policy.value.project ? agentProject.value : undefined, policy.value.executors) : undefined));

function submit(): void {
  if (kind.value === 'agent') {
    const chosen = policy.value;
    if (chosen === undefined || !ready.value) return;
    const withProject = chosen.project || (mode.value === 'work' && project.value !== '');
    emit('create', { mode: mode.value, agent: chosen.agent, ...(withProject && mode.value === 'work' ? { project: agentProject.value } : {}) });
    return;
  }
  if (kind.value === 'incognito') {
    const mode = incognitoMode.value;
    emit('create', { mode, ...(mode === 'work' && project.value !== '' ? { project: project.value } : {}), incognito: true });
    return;
  }
  if (kind.value === 'work' && project.value !== '') emit('create', { mode: 'work', project: project.value });
  else emit('create', { mode: kind.value });
}
</script>

<template>
  <form class="flex flex-col gap-3" @submit.prevent="submit" @keydown.enter="enter">
    <!-- The kind: never wrapped, two rows of two under 640 px (D-158). -->
    <div
      class="grid grid-cols-2 gap-1 rounded-[10px] border border-line bg-surface-2 p-1 sm:grid-cols-4"
      role="radiogroup"
      aria-label="Con chi parli"
      @keydown="arrows($event, kindIds, kind, (value) => (kind = value))"
    >
      <button
        v-for="option in kinds"
        :key="option.id"
        type="button"
        role="radio"
        :aria-checked="kind === option.id"
        :tabindex="kind === option.id ? 0 : -1"
        class="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[13px] font-medium whitespace-nowrap transition"
        :class="kind === option.id ? 'bg-surface text-accent shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
        @click="kind = option.id"
      >
        <Icon :name="option.icon" :size="15" />{{ option.text }}
      </button>
    </div>
    <p class="-mt-1 px-0.5 text-[12.5px] leading-snug text-muted">{{ hint }}</p>

    <!-- Incognito (D-136): then private or work, as for a normal conversation. -->
    <div
      v-if="kind === 'incognito'"
      class="grid grid-cols-2 gap-1 rounded-[10px] border border-line bg-surface-2 p-1"
      role="radiogroup"
      aria-label="Modalità della conversazione incognita"
      @keydown="arrows($event, modes, incognitoMode, (value) => (incognitoMode = value))"
    >
      <button
        v-for="option in modes"
        :key="option"
        type="button"
        role="radio"
        :aria-checked="incognitoMode === option"
        :tabindex="incognitoMode === option ? 0 : -1"
        class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap transition"
        :class="incognitoMode === option ? 'bg-surface text-accent shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
        @click="incognitoMode = option"
      >
        <Icon :name="option" :size="13" />{{ MODE_TEXT[option] }}
      </button>
    </div>

    <template v-if="kind === 'agent'">
      <!-- One card per agent (the user's choice after the trial of D-111d): character, name, where it runs, what it does. -->
      <div
        v-if="agents.length > 0"
        class="grid max-h-[40vh] grid-cols-1 gap-2 overflow-y-auto p-0.5 min-[420px]:grid-cols-2"
        role="radiogroup"
        aria-label="Agente"
        @keydown="arrows($event, agentIds, agent, (value) => (agent = value))"
      >
        <button
          v-for="entry in agents"
          :key="entry.agent"
          type="button"
          role="radio"
          :aria-checked="agent === entry.agent"
          :tabindex="agent === entry.agent ? 0 : -1"
          class="flex flex-col items-start gap-1 rounded-[10px] border p-2.5 text-left transition"
          :class="agent === entry.agent ? 'border-accent bg-surface shadow-[inset_0_0_0_1px_var(--accent)]' : 'border-line bg-surface-2 hover:border-line-strong'"
          @click="agent = entry.agent"
        >
          <span class="flex w-full items-center gap-2">
            <PixelAgent :choice="characters?.[entry.agent]" pose="idle" :scale="1" />
            <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium">{{ agentTitle(entry.agent) }}</span>
            <span
              class="shrink-0 rounded-full border px-1.5 py-px font-mono text-[10px] whitespace-nowrap"
              :class="entry.cloud ? 'border-l1/60 text-l1' : 'border-line-strong text-muted'"
            >{{ entry.cloud ? shortTarget(entry.executors?.length ? entry.executors : ['claude']) : 'locale' }}</span>
          </span>
          <span v-if="entry.description !== ''" class="line-clamp-2 text-xs leading-snug text-muted" :title="agentDescription(entry.agent, entry.description)">{{
            agentDescription(entry.agent, entry.description)
          }}</span>
        </button>
      </div>
      <p v-else class="text-[12.5px] leading-snug text-muted">Nessun agente può rispondere adesso: attivane uno in Impostazioni → Agenti.</p>
      <div
        v-if="policy !== undefined && policy.modes.length > 1"
        class="grid grid-cols-2 gap-1 rounded-[10px] border border-line bg-surface-2 p-1"
        role="radiogroup"
        aria-label="Modalità"
        @keydown="arrows($event, policy.modes, mode, (value) => (agentMode = value))"
      >
        <button
          v-for="option in policy.modes"
          :key="option"
          type="button"
          role="radio"
          :aria-checked="mode === option"
          :tabindex="mode === option ? 0 : -1"
          class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap transition"
          :class="mode === option ? 'bg-surface text-accent shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
          @click="agentMode = option"
        >
          <Icon :name="option" :size="13" />{{ MODE_TEXT[option] }}
        </button>
      </div>
      <template v-if="policy?.project === true">
        <label v-if="projects.length > 0" class="flex flex-col gap-1 text-xs font-medium text-muted">
          Progetto
          <select :value="agentProject" class="field px-2.5 py-2 text-[13px] font-normal text-ink" @change="project = ($event.target as HTMLSelectElement).value">
            <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ entry.path }}</option>
          </select>
        </label>
        <p v-else class="text-[12.5px] leading-snug text-muted">
          {{ agentTitle(policy.agent) }} lavora in un progetto, e non ce n'è uno approvato: aggiungilo con
          <code class="font-mono">pnpm arianna:init --reconfigure</code>.
        </p>
      </template>
      <!-- On the cloud: a short title, one sentence, the rest behind "Dettagli" (D-158). -->
      <div v-if="notice !== undefined" role="note" class="flex gap-2.5 rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2.5 text-[12.5px] leading-snug">
        <span class="mt-px shrink-0 text-warn"><Icon name="warning" :size="15" /></span>
        <div class="flex min-w-0 flex-col gap-1">
          <strong class="font-semibold text-warn">{{ notice.title }}</strong>
          <span class="text-ink">{{ notice.text }}</span>
          <details class="text-muted">
            <summary class="w-fit cursor-pointer rounded text-xs hover:text-ink">Dettagli</summary>
            <p class="mt-1 text-xs">{{ notice.details }}</p>
          </details>
        </div>
      </div>
      <p v-else-if="policy !== undefined" role="note" class="rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-[12.5px] leading-snug text-muted">{{ localNote(policy.agent) }}</p>
    </template>

    <template v-else-if="kind === 'work' || (kind === 'incognito' && incognitoMode === 'work')">
      <label v-if="projects.length > 0" class="flex flex-col gap-1 text-xs font-medium text-muted">
        Progetto
        <select v-model="project" class="field px-2.5 py-2 text-[13px] font-normal text-ink">
          <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ entry.path }}</option>
          <option value="">Nessun progetto</option>
        </select>
      </label>
      <p v-else class="text-[12.5px] leading-snug text-muted">
        Nessun progetto approvato: il Coder non ha dove lavorare. Aggiungine uno con
        <code class="font-mono">pnpm arianna:init --reconfigure</code>.
      </p>
    </template>

    <!-- The action: a primary button on the right, as Invio on a choice (D-158). -->
    <div class="mt-1 flex justify-end border-t border-line pt-3">
      <button type="submit" :disabled="!ready" class="btn btn-primary w-full px-4 py-2 text-[13.5px] whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto">
        <Icon :name="kind === 'agent' ? 'coder' : kind === 'incognito' ? 'incognito' : 'new'" :size="16" />{{
          kind === 'agent' && policy !== undefined ? `Parla con ${agentTitle(policy.agent)}` : kind === 'incognito' ? 'Nuova conversazione incognita' : 'Nuova conversazione'
        }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
/**
 * The permissions of a user's agent, chosen within the list the core offers
 * (D-119, tappa T3b): where it works, its tools, autonomy and limits. Every
 * click goes through `adjustPermissions`, so the page never shows a choice
 * the core would refuse; the core checks again on save.
 */
import { computed } from 'vue';

import { adjustPermissions, type UserAgentSources, type UserPermissions } from '../lib/user-agents.ts';

const props = defineProps<{ sources: UserAgentSources; modelValue: UserPermissions; idPrefix: string }>();
const emit = defineEmits<{ 'update:modelValue': [UserPermissions] }>();

const EXECUTORS = {
  local: { title: 'Modello locale', text: 'Risponde soltanto, senza strumenti. Niente esce dal Mac.' },
  claude: { title: 'Claude Code', text: 'Lavora nella cartella del progetto della conversazione. Il prompt e l’incarico vanno al cloud dal gateway, al massimo Interno.' },
} as const;

const TOOLS: Record<string, { title: string; text: string }> = {
  'repo.read': { title: 'Legge il codice', text: 'apre e cerca i file del progetto' },
  'repo.write': { title: 'Modifica il codice', text: 'crea e cambia file nel progetto' },
  'repo.test': { title: 'Esegue i test', text: 'lancia comandi nel progetto, in una sandbox senza rete' },
};

const set = (change: Partial<UserPermissions>): void => {
  emit('update:modelValue', adjustPermissions({ ...props.modelValue, ...change }, props.sources.allowed));
};
const offered = computed(() => props.sources.allowed.tools[props.modelValue.executor] ?? []);
const acting = (tool: string): boolean => props.sources.allowed.acting.includes(tool);
function toggle(tool: string, on: boolean): void {
  set({ tools: on ? [...props.modelValue.tools, tool] : props.modelValue.tools.filter((item) => item !== tool) });
}
const number = (event: Event): number => Number((event.target as HTMLInputElement).value);
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1 text-xs text-muted">Dove lavora</legend>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label
          v-for="executor in sources.allowed.executors"
          :key="executor"
          class="flex cursor-pointer flex-col gap-1 rounded-[10px] border p-2.5 text-[13px] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
          :class="modelValue.executor === executor ? 'border-accent bg-accent/10' : 'border-line bg-surface-2 hover:border-line-strong'"
        >
          <input type="radio" class="sr-only" :name="`${idPrefix}-executor`" :value="executor" :checked="modelValue.executor === executor" @change="set({ executor: executor as UserPermissions['executor'] })" />
          <span class="font-semibold">{{ EXECUTORS[executor as keyof typeof EXECUTORS]?.title ?? executor }}</span>
          <span class="text-xs text-muted">{{ EXECUTORS[executor as keyof typeof EXECUTORS]?.text }}</span>
        </label>
      </div>
    </fieldset>

    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1 text-xs text-muted">Strumenti</legend>
      <p v-if="offered.length === 0" class="text-xs text-muted">Sul modello locale nessuno strumento: l’agente risponde con quello che sa.</p>
      <label v-for="tool in offered" :key="tool" class="flex items-start gap-2 text-[13px]" :class="modelValue.autonomy === 'A0' && acting(tool) ? 'opacity-50' : ''">
        <input
          type="checkbox"
          class="mt-0.5 accent-[var(--accent)]"
          :checked="modelValue.tools.includes(tool)"
          :disabled="modelValue.autonomy === 'A0' && acting(tool)"
          @change="toggle(tool, ($event.target as HTMLInputElement).checked)"
        />
        <span>
          {{ TOOLS[tool]?.title ?? tool }} <span class="text-xs text-muted">· {{ TOOLS[tool]?.text }}</span>
          <span v-if="sources.claudeTools[tool]" class="font-mono text-[11px] text-muted"> ({{ sources.claudeTools[tool]?.join(', ') }})</span>
        </span>
      </label>
      <p v-if="modelValue.autonomy === 'A0' && offered.some(acting)" class="text-xs text-muted">Con A0 l’agente propone soltanto: modificare il codice ed eseguire i test richiedono A1.</p>
      <p class="text-xs text-muted">Altri strumenti (base di conoscenza, web, domande in chat) arriveranno quando le deleghe sapranno usarli.</p>
    </fieldset>

    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1 text-xs text-muted">Autonomia</legend>
      <div class="flex flex-wrap gap-4 text-[13px]">
        <label class="flex items-center gap-2">
          <input type="radio" class="accent-[var(--accent)]" :name="`${idPrefix}-autonomy`" value="A0" :checked="modelValue.autonomy === 'A0'" @change="set({ autonomy: 'A0' })" />
          A0 · propone soltanto
        </label>
        <label class="flex items-center gap-2">
          <input type="radio" class="accent-[var(--accent)]" :name="`${idPrefix}-autonomy`" value="A1" :checked="modelValue.autonomy === 'A1'" @change="set({ autonomy: 'A1' })" />
          A1 · agisce nella sandbox
        </label>
      </div>
    </fieldset>

    <div class="grid grid-cols-2 gap-3 sm:max-w-sm">
      <label class="flex flex-col gap-1 text-xs text-muted">
        Passi per lavoro (1–{{ sources.allowed.limits.maxSteps }})
        <input type="number" min="1" :max="sources.allowed.limits.maxSteps" step="1" class="field px-2 py-1.5 font-mono text-[13px] text-ink" :value="modelValue.maxSteps" @change="set({ maxSteps: number($event) })" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Minuti per lavoro (1–{{ sources.allowed.limits.maxMinutes }})
        <input type="number" min="1" :max="sources.allowed.limits.maxMinutes" step="1" class="field px-2 py-1.5 font-mono text-[13px] text-ink" :value="modelValue.maxMinutes" @change="set({ maxMinutes: number($event) })" />
      </label>
    </div>
  </div>
</template>

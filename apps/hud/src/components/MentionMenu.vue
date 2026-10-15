<script setup lang="ts">
/** The list of the «@» menu (D-107, tappa B2, D-219), above a composer: lib/mention-menu.ts holds its state. */
import { agentShortName } from '../lib/character-names.ts';

defineProps<{ items: readonly string[]; active: number }>();
const emit = defineEmits<{ choose: [agent: string]; hover: [index: number] }>();
</script>

<template>
  <div class="hud-card absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden bg-surface py-1.5 shadow-lg">
    <p class="hud-title px-3.5 pt-1 pb-1.5">Scrivi a un agente, senza passare da Arianna</p>
    <ul id="mention-menu" role="listbox" aria-label="Agenti" class="max-h-72 overflow-y-auto">
      <li
        v-for="(agent, index) in items"
        :key="agent"
        role="option"
        :aria-selected="index === active"
        class="flex cursor-pointer items-baseline gap-3 px-3.5 py-1.5 text-[14px]"
        :class="index === active ? 'bg-surface-2 text-ink' : 'text-muted'"
        @mousedown.prevent
        @mouseenter="emit('hover', index)"
        @click="emit('choose', agent)"
      >
        <span class="w-36 shrink-0 font-mono sm:w-40" :class="index === active ? 'text-accent' : 'text-ink'">@{{ agent }}</span>
        <span class="min-w-0 flex-1 truncate">{{ agentShortName(agent) }}</span>
      </li>
    </ul>
    <p class="px-3.5 pt-1.5 font-mono text-[12px] text-muted">↑↓ per scegliere · Invio o Tab · Esc per chiudere · /giro per chiedere a tutti</p>
  </div>
</template>

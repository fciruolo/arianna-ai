<script setup lang="ts">
import { computed } from 'vue';

import { agentLabel } from '../lib/character-names.ts';

/**
 * The name of an agent (D-214): with a person of the series, the character's
 * name first and, under it and smaller, the agent's («Dr. Cox» / «GOD»);
 * otherwise the agent's name alone (or `name`, when the caller has its own).
 * The text keeps the style of where it sits.
 */
const props = defineProps<{ agent: string; name?: string | undefined }>();
const label = computed(() => {
  const found = agentLabel(props.agent);
  return found.sub === null && props.name !== undefined ? { main: props.name, sub: null } : found;
});
</script>

<template>
  <span v-if="label.sub === null">{{ label.main }}</span>
  <span v-else class="inline-flex min-w-0 flex-col leading-tight">
    <span class="truncate">{{ label.main }}</span>
    <span class="truncate text-[0.72em] font-normal tracking-normal text-muted normal-case">{{ label.sub }}</span>
  </span>
</template>

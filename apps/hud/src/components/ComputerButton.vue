<script setup lang="ts">
import Icon from './Icon.vue';

/** The button that opens the computer of the Coder's run (D-095), in the block of the Coder's task: a dot pulses while it works. */
defineProps<{ open: boolean; working: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[13px] font-medium text-ink hover:bg-surface-2"
    :class="open ? 'bg-surface-2' : ''"
    :aria-pressed="open"
    title="Computer del Coder: terminale, file e attività del lavoro, in sola lettura"
    @click="emit('toggle')"
  >
    <Icon name="computer" :size="15" />Computer
    <span v-if="working" class="size-2 animate-pulse rounded-full bg-ok" aria-hidden="true"></span>
  </button>
</template>

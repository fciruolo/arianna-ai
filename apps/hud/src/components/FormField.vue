<script setup lang="ts">
/**
 * One field of a form (the registry of a client, D-168): the label, the
 * input in the slot, a hint and the problem in Italian under it. The input
 * gets `id`; the problem is announced to screen readers.
 */
defineProps<{
  id: string;
  label: string;
  problem?: string | undefined;
  hint?: string | undefined;
  wide?: boolean;
}>();
</script>

<template>
  <div class="grid content-start gap-1" :class="wide ? 'sm:col-span-2' : ''">
    <label :for="id" class="text-[12px] font-medium text-muted">{{ label }}</label>
    <slot />
    <p v-if="problem" :id="`${id}-problem`" class="text-[11.5px] text-danger" role="alert">{{ problem }}</p>
    <p v-else-if="hint" class="text-[11.5px] text-muted">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

/**
 * One field of a form (the registry of a client, D-168): the label, the
 * input in the slot, a hint and the problem in Italian under it. The input
 * (the one with `id`) is tied to the problem or the hint with
 * aria-describedby and marked aria-invalid while there is a problem; the
 * problem is read politely, not as an alarm.
 */
const props = defineProps<{
  id: string;
  label: string;
  problem?: string | undefined;
  hint?: string | undefined;
  wide?: boolean;
}>();

const root = ref<HTMLElement | null>(null);

function describe(): void {
  const control = root.value?.querySelector<HTMLElement>(`[id="${props.id.replace(/"/g, '')}"]`);
  if (control === null || control === undefined) return;
  const by = props.problem ? `${props.id}-problem` : props.hint ? `${props.id}-hint` : null;
  if (by === null) control.removeAttribute('aria-describedby');
  else control.setAttribute('aria-describedby', by);
  if (props.problem) control.setAttribute('aria-invalid', 'true');
  else control.removeAttribute('aria-invalid');
}

onMounted(describe);
watch(
  () => [props.problem, props.hint, props.id],
  async () => {
    await nextTick();
    describe();
  },
);
</script>

<template>
  <div ref="root" class="grid content-start gap-1" :class="wide ? 'sm:col-span-2' : ''">
    <label :for="id" class="text-[13px] font-medium text-muted">{{ label }}</label>
    <slot />
    <p :id="`${id}-problem`" class="text-[12.5px] text-danger empty:hidden" aria-live="polite">{{ problem ?? '' }}</p>
    <p v-if="hint && !problem" :id="`${id}-hint`" class="text-[12.5px] text-muted">{{ hint }}</p>
  </div>
</template>

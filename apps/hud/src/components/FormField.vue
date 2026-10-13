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
  /** Columns taken in a 6-column grid (the registry of a client, D-190); unset in the 2-column forms. */
  span?: 1 | 2 | 3 | 4 | 6;
  /** Needed for the electronic invoice and still empty (D-190): an amber edge on the input. */
  missing?: boolean;
}>();

const SPAN_CLASS = { 1: 'sm:col-span-1', 2: 'sm:col-span-2', 3: 'sm:col-span-3', 4: 'sm:col-span-4', 6: 'sm:col-span-6' } as const;

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
  <div ref="root" class="grid content-start gap-1" :class="[span !== undefined ? SPAN_CLASS[span] : wide ? 'sm:col-span-2' : '', missing ? 'form-missing' : '']" :data-missing="missing ? 'true' : undefined">
    <label :for="id" class="text-[13px] font-medium text-muted">{{ label }}</label>
    <slot />
    <p :id="`${id}-problem`" class="text-[12.5px] text-danger empty:hidden" aria-live="polite">{{ problem ?? '' }}</p>
    <p v-if="hint && !problem" :id="`${id}-hint`" class="text-[12.5px] text-muted">{{ hint }}</p>
  </div>
</template>

<style scoped>
/* A field the electronic invoice needs: the edge of the input in amber, never a focus ring. */
.form-missing :deep(input),
.form-missing :deep(select) {
  border-color: var(--warn);
}
</style>

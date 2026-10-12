<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import Icon from './Icon.vue';

/**
 * A modal window that asks before acting (I-20, D-185): what happens in the
 * slot, then the two buttons. Esc and a click outside cancel, unless busy.
 */
const props = withDefaults(defineProps<{ title: string; confirmText: string; danger?: boolean; busy?: boolean; problem?: string | null; disabled?: boolean }>(), {
  danger: false,
  busy: false,
  problem: null,
  disabled: false,
});
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLElement | null>(null);

function cancel(): void {
  if (!props.busy) emit('cancel');
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') cancel();
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  dialog.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" @click.self="cancel">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" tabindex="-1" class="hud-card flex max-h-[90vh] w-full max-w-[480px] flex-col bg-surface outline-none">
      <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span v-if="danger" class="text-danger"><Icon name="warning" :size="16" /></span>
        <h2 id="confirm-title" class="min-w-0 flex-1 truncate font-medium">{{ title }}</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" :disabled="busy" @click="cancel"><Icon name="close" :size="16" /></button>
      </header>
      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-[15px] py-3 text-[13.5px]">
        <slot />
        <p v-if="problem !== null" class="text-xs text-danger" role="alert">{{ problem }}</p>
      </div>
      <footer class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-[15px] py-2.5">
        <button type="button" class="rounded-md px-3 py-1 text-[13px] text-muted hover:text-ink" :disabled="busy" @click="cancel">Annulla</button>
        <button type="button" class="btn px-3 py-1 text-[13px]" :class="danger ? 'btn-danger' : 'btn-primary'" :disabled="busy || disabled" @click="emit('confirm')">{{ confirmText }}</button>
      </footer>
    </section>
  </div>
</template>

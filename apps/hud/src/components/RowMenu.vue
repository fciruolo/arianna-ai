<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

import type { RowMenuItem } from '../lib/projects-page.ts';
import Icon from './Icon.vue';

/**
 * The "⋯" of a row (D-191): the less common actions of an IM or of an
 * invoice in a small menu. Esc, a click outside or a choice close it; the
 * focus goes back to the button.
 */
const props = defineProps<{ items: readonly RowMenuItem[]; label: string; disabled?: boolean }>();
const emit = defineEmits<{ choose: [id: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
// Fixed to the window: a table that scrolls sideways would cut a menu placed inside it.
const place = ref<{ top: string; right: string }>({ top: '0px', right: '0px' });
const shut = (): void => {
  open.value = false;
};

function onDocument(event: PointerEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) open.value = false;
}

watch(open, async (now) => {
  if (now) {
    const rect = button.value?.getBoundingClientRect();
    if (rect !== undefined) place.value = { top: `${String(rect.bottom + 4)}px`, right: `${String(Math.max(8, window.innerWidth - rect.right))}px` };
    document.addEventListener('pointerdown', onDocument, true);
    window.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    await nextTick();
    menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  } else {
    document.removeEventListener('pointerdown', onDocument, true);
    window.removeEventListener('scroll', shut, true);
    window.removeEventListener('resize', shut);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocument, true);
  window.removeEventListener('scroll', shut, true);
  window.removeEventListener('resize', shut);
});

function close(): void {
  open.value = false;
  button.value?.focus();
}

/** Up and down move among the entries, round. */
function move(step: number): void {
  const entries = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  if (entries.length === 0) return;
  const at = entries.findIndex((entry) => entry === document.activeElement);
  entries[(at + step + entries.length) % entries.length]?.focus({ preventScroll: true });
}

/** Esc closes the menu when open; when closed it is left to the windows around. */
function onEscape(event: KeyboardEvent): void {
  if (!open.value) return;
  event.stopPropagation();
  close();
}

function choose(id: string): void {
  open.value = false;
  emit('choose', id);
}
</script>

<template>
  <span ref="root" class="relative inline-flex" @keydown.esc="onEscape">
    <button
      ref="button"
      type="button"
      class="grid size-7 place-items-center rounded-md border border-transparent text-muted hover:border-line-strong hover:text-ink disabled:opacity-40"
      :aria-label="props.label"
      :title="props.label"
      aria-haspopup="menu"
      :aria-expanded="open"
      :disabled="props.disabled || props.items.length === 0"
      @click="open = !open"
    >
      <Icon name="more" :size="16" />
    </button>
    <div v-if="open" ref="menu" role="menu" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" :aria-label="props.label" :style="place" class="fixed z-40 w-max max-w-[280px] min-w-[200px] rounded-xl border border-line-strong bg-surface p-1 text-left text-[14px] shadow-[0_14px_40px_#0005]">
      <button
        v-for="item in props.items"
        :key="item.id"
        type="button"
        role="menuitem"
        class="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-40"
        :class="item.danger ? 'text-danger' : 'text-ink'"
        :disabled="item.disabled"
        @click="choose(item.id)"
      >
        {{ item.text }}
      </button>
    </div>
  </span>
</template>

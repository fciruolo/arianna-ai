<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import type { WikiMenuItem } from '../lib/wiki.ts';

/**
 * The menu of the Wiki (D-284), ours and not the browser's: right click (or
 * «…», Maiusc+F10, the menu key) on a row of the tree, a click on the handle
 * of a block. It opens where it is asked, inside the window; the arrows move
 * among the entries, Esc, Tab, a click outside or a choice close it. An entry
 * that cannot be used here is shown off with its reason.
 */
const props = defineProps<{ items: readonly WikiMenuItem[]; x: number; y: number; label: string }>();
const emit = defineEmits<{ choose: [id: string]; close: [] }>();

const menu = ref<HTMLElement | null>(null);
const place = ref({ top: `${String(props.y)}px`, left: `${String(props.x)}px` });

function entries(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
}

function move(step: number): void {
  const list = entries();
  if (list.length === 0) return;
  const at = list.findIndex((entry) => entry === document.activeElement);
  list[(at + step + list.length) % list.length]?.focus({ preventScroll: true });
}

function edge(last: boolean): void {
  const list = entries();
  (last ? list.at(-1) : list[0])?.focus({ preventScroll: true });
}

function onDocument(event: PointerEvent): void {
  if (menu.value !== null && event.target instanceof Node && !menu.value.contains(event.target)) emit('close');
}
function shut(): void {
  emit('close');
}

onMounted(async () => {
  await nextTick();
  const rect = menu.value?.getBoundingClientRect();
  if (rect !== undefined) {
    // Inside the window, with 8px around: a menu opened near the bottom or the right goes up or left.
    const left = Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8));
    const top = props.y + rect.height + 8 > window.innerHeight ? Math.max(8, props.y - rect.height) : props.y;
    place.value = { top: `${String(top)}px`, left: `${String(left)}px` };
  }
  entries()[0]?.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onDocument, true);
  window.addEventListener('resize', shut);
  window.addEventListener('blur', shut);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocument, true);
  window.removeEventListener('resize', shut);
  window.removeEventListener('blur', shut);
});

function onKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') move(1);
  else if (event.key === 'ArrowUp') move(-1);
  else if (event.key === 'Home') edge(false);
  else if (event.key === 'End') edge(true);
  else if (event.key === 'Escape' || event.key === 'Tab') {
    event.stopPropagation();
    emit('close');
  } else return;
  event.preventDefault();
}
</script>

<template>
  <div
    ref="menu"
    role="menu"
    :aria-label="props.label"
    :style="place"
    class="fixed z-50 w-max max-w-[300px] min-w-[210px] rounded-xl border border-line-strong bg-surface p-1 text-left text-[14px] shadow-[0_14px_40px_#0005]"
    @keydown="onKey"
    @contextmenu.prevent
  >
    <template v-for="item in props.items" :key="item.id">
      <p v-if="item.group === true" class="px-2.5 pt-1.5 pb-0.5 text-[12px] text-muted" role="presentation">{{ item.text }}</p>
      <button
        v-else
        type="button"
        role="menuitem"
        class="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
        :class="[item.off !== undefined ? 'text-muted' : item.danger === true ? 'text-danger' : 'text-ink', item.on === true ? 'font-semibold' : '']"
        :disabled="item.off !== undefined"
        :aria-describedby="item.off !== undefined ? `wiki-menu-off-${item.id}` : undefined"
        @click="emit('choose', item.id)"
      >
        <span class="flex items-center justify-between gap-3">
          <span>{{ item.text }}</span>
          <span v-if="item.on === true" class="text-accent" aria-label="(adesso)">✓</span>
        </span>
        <span v-if="item.off !== undefined" :id="`wiki-menu-off-${item.id}`" class="mt-0.5 block text-[12px] leading-snug">{{ item.off }}</span>
      </button>
    </template>
  </div>
</template>

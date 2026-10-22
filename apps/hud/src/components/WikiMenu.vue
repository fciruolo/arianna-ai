<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import type { WikiMenuItem } from '../lib/wiki.ts';

/**
 * The menu of the Wiki (D-284), ours and not the browser's: right click (or
 * «…», Maiusc+F10, the menu key) on a row of the tree, a click on the handle
 * of a block. It opens where it is asked, inside the window; the arrows move
 * among all the entries, the ones off too (they say why with their reason),
 * Esc, Tab, a click outside or a choice close it. A heading («Trasforma in»)
 * makes a group of the entries after it; entries with a state now (`on`) are
 * radio entries.
 */
const props = defineProps<{ items: readonly WikiMenuItem[]; x: number; y: number; label: string }>();
const emit = defineEmits<{ choose: [id: string]; close: [] }>();

const menu = ref<HTMLElement | null>(null);
const place = ref({ top: `${String(props.y)}px`, left: `${String(props.x)}px` });

/** The entries in sections: before the first heading, then one group per heading. */
const sections = computed(() => {
  const out: { label: string | null; items: WikiMenuItem[] }[] = [{ label: null, items: [] }];
  for (const item of props.items) {
    if (item.group === true) out.push({ label: item.text, items: [] });
    else out.at(-1)?.items.push(item);
  }
  return out.filter((section) => section.items.length > 0);
});

function entries(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? [])];
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
  // The first entry that can be used; an entry off only when there is none.
  (entries().find((entry) => entry.getAttribute('aria-disabled') !== 'true') ?? entries()[0])?.focus({ preventScroll: true });
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

function choose(item: WikiMenuItem): void {
  // An entry off stays: its reason is read, nothing happens.
  if (item.off === undefined) emit('choose', item.id);
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
    <div v-for="(section, at) in sections" :key="section.label ?? `s${String(at)}`" :role="section.label === null ? undefined : 'group'" :aria-labelledby="section.label === null ? undefined : `wiki-menu-group-${String(at)}`">
      <p v-if="section.label !== null" :id="`wiki-menu-group-${String(at)}`" class="px-2.5 pt-1.5 pb-0.5 text-[12px] text-muted">{{ section.label }}</p>
      <button
        v-for="item in section.items"
        :key="item.id"
        type="button"
        :role="item.on === undefined ? 'menuitem' : 'menuitemradio'"
        :aria-checked="item.on === undefined ? undefined : item.on"
        :aria-disabled="item.off === undefined ? undefined : 'true'"
        :aria-describedby="item.off !== undefined ? `wiki-menu-off-${item.id}` : undefined"
        class="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 touch:py-3 focus-visible:bg-surface-2"
        :class="[item.off !== undefined ? 'cursor-default text-muted' : item.danger === true ? 'text-danger' : 'text-ink', item.on === true ? 'font-semibold' : '']"
        @click="choose(item)"
      >
        <span class="flex items-center justify-between gap-3">
          <span>{{ item.text }}</span>
          <span v-if="item.on === true" class="text-accent" aria-hidden="true">✓</span>
        </span>
        <span v-if="item.off !== undefined" :id="`wiki-menu-off-${item.id}`" class="mt-0.5 block text-[12px] leading-snug">{{ item.off }}</span>
      </button>
    </div>
  </div>
</template>

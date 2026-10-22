<script setup lang="ts">
/**
 * The «+» of the composer (D-231, idea 13 of OpenWork): one menu for what was
 * around the field (the «/» commands, «@» to an agent, «Allega nota
 * privata», «Nuova sessione» of the Designer, «Salva in inbox») and the model
 * of the conversation with its keys. A menu button: arrows, Home and End,
 * Invio or Spazio; Esc, Tab or a click outside close it, Esc gives the focus
 * back to the «+».
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { nextEnabled, type PlusEntry } from '../lib/composer.ts';
import Icon from './Icon.vue';

const props = defineProps<{ entries: readonly PlusEntry[]; modelTitle?: string | undefined }>();
const emit = defineEmits<{ choose: [entry: PlusEntry]; opened: [] }>();

const open = ref(false);
const active = ref(-1);
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);

const actions = computed(() => props.entries.filter((entry) => entry.action !== 'model'));
const models = computed(() => props.entries.filter((entry) => entry.action === 'model'));
/** The entries in the order the arrows walk them: actions, then models. */
const ordered = computed(() => [...actions.value, ...models.value]);

function onDocument(event: PointerEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) open.value = false;
}

watch(open, async (now) => {
  if (now) {
    document.addEventListener('pointerdown', onDocument, true);
    emit('opened');
    active.value = nextEnabled(ordered.value, -1, 1);
    await nextTick();
    focusActive();
  } else {
    document.removeEventListener('pointerdown', onDocument, true);
    active.value = -1;
  }
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocument, true));

function focusActive(): void {
  const entry = ordered.value[active.value];
  if (entry === undefined) {
    menu.value?.focus();
    return;
  }
  menu.value?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(entry.id)}"]`)?.focus();
}

function close(focusBack: boolean): void {
  open.value = false;
  if (focusBack) button.value?.focus();
}

function choose(entry: PlusEntry): void {
  if (entry.disabled === true) return;
  open.value = false;
  emit('choose', entry);
}

function move(to: number): void {
  if (to < 0) return;
  active.value = to;
  focusActive();
}

function onKey(event: KeyboardEvent): void {
  if (!open.value) return;
  const list = ordered.value;
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    case 'Tab':
      close(false);
      return;
    case 'ArrowDown':
    case 'ArrowUp':
      event.preventDefault();
      move(nextEnabled(list, active.value, event.key === 'ArrowDown' ? 1 : -1));
      return;
    case 'Home':
      event.preventDefault();
      move(nextEnabled(list, -1, 1));
      return;
    case 'End':
      event.preventDefault();
      move(nextEnabled(list, list.length, -1));
      return;
    default:
  }
}

function onButtonKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    open.value = true;
  }
}

defineExpose({ open: () => (open.value = true) });
</script>

<template>
  <div ref="root" class="relative mb-1 shrink-0" @keydown="onKey">
    <button
      ref="button"
      type="button"
      class="grid size-[30px] place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink touch:size-11"
      :class="open ? 'bg-surface-2 text-ink' : ''"
      aria-label="Altre azioni"
      title="Comandi, allegati e modello"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? 'plus-menu' : undefined"
      @click="open = !open"
      @keydown="onButtonKey"
    >
      <Icon name="new" :size="18" />
    </button>
    <div
      v-if="open"
      id="plus-menu"
      ref="menu"
      role="menu"
      tabindex="-1"
      aria-label="Altre azioni"
      class="hud-card absolute bottom-full left-0 z-30 mb-3 w-[min(320px,calc(100vw-2rem))] overflow-hidden bg-surface py-1.5 shadow-lg"
    >
      <div class="max-h-[60vh] overflow-y-auto">
        <button
          v-for="entry in actions"
          :key="entry.id"
          :data-entry="entry.id"
          type="button"
          role="menuitem"
          tabindex="-1"
          :aria-disabled="entry.disabled === true"
          class="flex w-full items-baseline gap-3 px-3.5 py-1.5 text-left text-[14px]"
          :class="[ordered[active]?.id === entry.id ? 'bg-surface-2 text-ink' : 'text-ink', entry.disabled === true ? 'cursor-default opacity-50' : 'cursor-pointer hover:bg-surface-2']"
          @mouseenter="entry.disabled !== true && (active = ordered.indexOf(entry))"
          @click="choose(entry)"
        >
          <span class="min-w-0 flex-1">
            {{ entry.text }}
            <span v-if="entry.hint !== undefined" class="block truncate text-[12px] text-muted">{{ entry.hint }}</span>
          </span>
          <kbd v-if="entry.keys !== undefined" class="shrink-0 font-mono text-[12px] text-muted">{{ entry.keys }}</kbd>
        </button>
        <template v-if="models.length > 0">
          <div role="separator" class="mt-1 border-t border-line" />
          <div role="group" :aria-label="modelTitle ?? 'Modello'">
          <p class="hud-title px-3.5 pt-2 pb-1" aria-hidden="true">{{ modelTitle ?? 'Modello' }}</p>
          <button
            v-for="entry in models"
            :key="entry.id"
            :data-entry="entry.id"
            type="button"
            role="menuitemradio"
            tabindex="-1"
            :aria-checked="entry.checked === true"
            class="flex w-full cursor-pointer items-center gap-3 px-3.5 py-1.5 text-left text-[14px] hover:bg-surface-2"
            :class="ordered[active]?.id === entry.id ? 'bg-surface-2 text-ink' : 'text-ink'"
            @mouseenter="active = ordered.indexOf(entry)"
            @click="choose(entry)"
          >
            <span class="grid size-4 shrink-0 place-items-center text-accent" aria-hidden="true"><Icon v-if="entry.checked === true" name="approve" :size="14" /></span>
            <span class="min-w-0 flex-1 truncate">{{ entry.text }}</span>
            <kbd v-if="entry.keys !== undefined" class="shrink-0 font-mono text-[12px] text-muted">{{ entry.keys }}</kbd>
          </button>
          </div>
        </template>
      </div>
      <p class="mt-1 border-t border-line px-3.5 pt-1.5 font-mono text-[12px] text-muted" aria-hidden="true">↑↓ per scegliere · Invio · Esc per chiudere</p>
    </div>
  </div>
</template>

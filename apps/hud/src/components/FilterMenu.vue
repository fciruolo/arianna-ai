<script setup lang="ts">
/**
 * A filter of the cardwall as a chip that opens a menu (D-152, a retouch the
 * user asked for: "è bruttissima quella select"): the name and, when one
 * is chosen, its value on the chip, tinted; a menu with a tick on the choice;
 * the little x puts the filter back to all. Without `options`, the menu holds
 * the slot (the columns of the board) as a small dialog, closed when the
 * focus leaves it. Keyboard: Enter or the arrows open it, the arrows move,
 * Enter chooses, Esc closes; a click outside closes it.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import type { IconName } from '../icons.ts';
import Icon from './Icon.vue';

interface Option {
  value: string;
  text: string;
}

const props = withDefaults(
  defineProps<{
    /** What the filter is: shown alone when nothing is chosen. */
    label: string;
    icon: IconName;
    options?: readonly Option[];
    /** The value that means "every one": no tint, no x. */
    allValue?: string;
    /** Right edge of the menu under the right edge of the chip. */
    alignRight?: boolean;
    /** Always shows the chosen text (the order), without tint or x. */
    plain?: boolean;
    /** Only the icon on the chip (the columns): the name is its tooltip. */
    iconOnly?: boolean;
  }>(),
  { allValue: 'all', alignRight: false, plain: false, iconOnly: false },
);
const model = defineModel<string>({ default: '' });

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const chip = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLElement | null>(null);
const active = ref(0);

const chosen = computed(() => props.options?.find((option) => option.value === model.value));
const filtering = computed(() => !props.plain && props.options !== undefined && model.value !== props.allValue);
const chipText = computed(() => {
  if (props.options === undefined) return props.label;
  if (props.plain) return chosen.value?.text ?? props.label;
  return filtering.value && chosen.value !== undefined ? chosen.value.text : props.label;
});

function onDocument(event: PointerEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) open.value = false;
}

watch(open, async (now) => {
  if (now) {
    document.addEventListener('pointerdown', onDocument, true);
    active.value = Math.max(0, props.options?.findIndex((option) => option.value === model.value) ?? 0);
    await nextTick();
    focusActive();
  } else {
    document.removeEventListener('pointerdown', onDocument, true);
  }
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocument, true));

function focusActive(): void {
  const items = list.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
  items?.[active.value]?.focus();
}

function choose(value: string): void {
  model.value = value;
  open.value = false;
  chip.value?.focus();
}

function onChipKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    open.value = false;
  } else if (props.options !== undefined && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    open.value = true;
  }
}

function onMenuKey(event: KeyboardEvent): void {
  const count = props.options?.length ?? 0;
  if (event.key === 'Escape') {
    event.preventDefault();
    open.value = false;
    chip.value?.focus();
  } else if (count > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    active.value = (active.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    focusActive();
  } else if (event.key === 'Tab' && props.options !== undefined) {
    open.value = false;
  }
}

/** The panel of the slot stays open while the focus moves inside it. */
function onPanelFocusOut(event: FocusEvent): void {
  if (props.options === undefined && !(event.relatedTarget instanceof Node && root.value?.contains(event.relatedTarget) === true)) open.value = false;
}
</script>

<template>
  <div ref="root" class="relative">
    <div
      class="flex h-[30px] items-center rounded-full border text-[12.5px] transition-colors"
      :class="filtering ? 'border-accent/60 bg-accent/10 text-ink' : 'border-line-strong text-muted hover:border-accent/60 hover:text-ink'"
    >
      <button
        ref="chip"
        type="button"
        class="flex h-full items-center gap-1.5 pr-2 pl-2.5"
        :class="{ 'pr-1.5': filtering }"
        :aria-haspopup="options === undefined ? 'dialog' : 'menu'"
        :aria-expanded="open"
        :aria-label="options === undefined ? label : `${label}: ${chosen?.text ?? ''}`"
        :title="label"
        @click="open = !open"
        @keydown="onChipKey"
      >
        <Icon :name="icon" :size="13" :class="filtering ? 'text-accent' : ''" />
        <span v-if="!iconOnly" class="max-w-[140px] truncate" :class="{ 'font-medium': filtering }">{{ chipText }}</span>
        <Icon v-if="!filtering" name="expand" :size="12" class="opacity-60 transition-transform" :class="open ? '-rotate-90' : 'rotate-90'" />
      </button>
      <button
        v-if="filtering"
        type="button"
        class="mr-1 grid size-5 place-items-center rounded-full text-muted hover:bg-accent/20 hover:text-ink"
        :aria-label="`Togli il filtro ${label}`"
        @click="choose(allValue)"
      >
        <Icon name="close" :size="11" />
      </button>
    </div>

    <div
      v-if="open"
      ref="list"
      :role="options === undefined ? 'dialog' : 'menu'"
      :aria-label="label"
      class="absolute top-full z-30 mt-1.5 min-w-[200px] overflow-hidden rounded-xl border border-line-strong bg-surface p-1 text-[13px] shadow-[0_14px_40px_#0005]"
      :class="alignRight ? 'right-0' : 'left-0'"
      @keydown="onMenuKey"
      @focusout="onPanelFocusOut"
    >
      <template v-if="options !== undefined">
        <button
          v-for="(option, index) in options"
          :key="option.value"
          type="button"
          role="menuitemradio"
          :aria-checked="option.value === model"
          :aria-disabled="option.value === '' ? true : undefined"
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
          :class="option.value === model ? 'text-ink' : 'text-muted'"
          :tabindex="index === active ? 0 : -1"
          @click="option.value === '' ? (open = false) : choose(option.value)"
          @focus="active = index"
        >
          <span class="grid size-4 shrink-0 place-items-center">
            <Icon v-if="option.value === model" name="approve" :size="13" class="text-accent" />
          </span>
          <span class="truncate">{{ option.text }}</span>
        </button>
      </template>
      <div v-else class="p-2"><slot /></div>
    </div>
  </div>
</template>

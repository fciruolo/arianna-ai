<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import Icon from './Icon.vue';

/**
 * A sheet from the bottom of the phone (D-294): a modal dialog over a veil
 * that closes it, inside the safe area and above the keyboard (the classes
 * `phone-overlay-bottom` of style.css). A title, an optional «‹ back» for a
 * page inside the sheet (as the Settings of iOS), the content that scrolls
 * and a footer that stays. Esc goes back a page or closes; the focus goes
 * in and, on close, back to the button that opened it; Tab stays inside.
 */
const props = withDefaults(defineProps<{ title: string; back?: string | null; page?: string }>(), { back: null, page: '' });
const emit = defineEmits<{ close: []; back: [] }>();

const panel = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The control marked `data-autofocus` (the choice made, the row just left), otherwise the first one. */
function focusFirst(): void {
  const marked = panel.value?.querySelector<HTMLElement>('[data-autofocus]');
  const first = panel.value?.querySelector<HTMLElement>(FOCUSABLE);
  (marked ?? first ?? panel.value)?.focus({ preventScroll: true });
}

function onKey(event: KeyboardEvent): void {
  // Esc goes back one page, as «‹» does; on the first page it closes the sheet.
  if (event.key === 'Escape') {
    event.preventDefault();
    if (props.back !== null) emit('back');
    else emit('close');
    return;
  }
  if (event.key !== 'Tab' || panel.value === null) return;
  const items = [...panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(focusFirst);
});
onBeforeUnmount(() => {
  if (opener?.isConnected === true) opener.focus({ preventScroll: true });
});
// Another page of the sheet: the focus goes to its first control.
watch(
  () => props.page,
  () => void nextTick(focusFirst),
);
</script>

<template>
  <div class="phone-overlay-bottom fixed inset-0 z-50 grid bg-black/50" @click.self="emit('close')">
    <section
      ref="panel"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      class="hud-card flex max-h-[calc(var(--vv-height,100dvh)-var(--safe-top)-var(--safe-bottom)-1rem)] w-full flex-col bg-surface outline-none"
      @keydown="onKey"
    >
      <header class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        <button v-if="back !== null" type="button" class="flex min-h-11 items-center gap-0.5 rounded-md pr-2 text-[15px] text-accent" @click="emit('back')">
          <Icon name="back" :size="18" />{{ back }}
        </button>
        <h2 class="min-w-0 flex-1 truncate px-2 text-[16px] font-semibold" :class="back !== null ? 'text-center' : ''">{{ title }}</h2>
        <button type="button" class="grid size-11 shrink-0 place-items-center rounded-md text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="flex shrink-0 gap-2 border-t border-line px-3 py-2.5">
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>

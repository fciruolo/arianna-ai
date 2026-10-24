<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { themeNoticeText, type ThemeListing, type ThemeNotice } from '../lib/themes.ts';
import Icon from './Icon.vue';

/**
 * The window of an automatic change of theme (D-315): a feast began, or it
 * ended. «Va bene» and «Torna a Base» are answers the core keeps for every
 * device; Esc, the cross and a click outside close it without answering, so
 * it comes back the next time the chat opens. Focus stays inside.
 */
const props = withDefaults(defineProps<{ listing: ThemeListing; notice: ThemeNotice; busy?: boolean; problem?: string | null }>(), { busy: false, problem: null });
const emit = defineEmits<{ ok: []; back: []; close: []; settings: [] }>();
const dialog = ref<HTMLElement | null>(null);
const first = ref<HTMLButtonElement | null>(null);
const words = computed(() => themeNoticeText(props.listing, props.notice));

function close(): void {
  if (!props.busy) emit('close');
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Heard first (capture): no other window of the page closes with the same key.
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
    return;
  }
  if (event.key !== 'Tab' || dialog.value === null) return;
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];
  const head = focusable[0];
  const tail = focusable[focusable.length - 1];
  if (head === undefined || tail === undefined) {
    // Everything disabled while the answer is saved: the focus stays on the window.
    event.preventDefault();
    dialog.value.focus();
    return;
  }
  const inside = dialog.value.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === head || !inside)) {
    event.preventDefault();
    tail.focus();
  } else if (!event.shiftKey && (document.activeElement === tail || !inside)) {
    event.preventDefault();
    head.focus();
  }
}
// Where the focus was before the window: it goes back there when the window closes.
let before: HTMLElement | null = null;
onMounted(() => {
  before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener('keydown', onKey, true);
  void nextTick(() => (first.value ?? dialog.value)?.focus());
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  if (before?.isConnected === true) before.focus();
});
// While the answer is saved the buttons are disabled: the focus moves to the window, not to the page.
watch(
  () => props.busy,
  (busy) => {
    if (busy) dialog.value?.focus();
    else void nextTick(() => first.value?.focus());
  },
);
</script>

<template>
  <div class="phone-overlay-bottom fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" @click.self="close">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="theme-notice-title" aria-describedby="theme-notice-text" tabindex="-1" class="phone-sheet-bottom hud-card flex max-h-[90vh] w-full max-w-[440px] flex-col bg-surface outline-none">
      <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <h2 id="theme-notice-title" class="min-w-0 flex-1 truncate font-medium">{{ words.title }}</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi, me lo richiedi la prossima volta" :disabled="busy" @click="close"><Icon name="close" :size="16" /></button>
      </header>
      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-[15px] py-3 text-[14.5px]">
        <p id="theme-notice-text">{{ words.text }}</p>
        <p class="text-[13px] text-muted">
          Il tema vale su tutti i dispositivi.
          <button type="button" class="text-accent underline underline-offset-2 hover:text-ink" :disabled="busy" @click="emit('settings')">Cambia tema</button>
        </p>
        <p v-if="problem !== null" class="text-xs text-danger" role="alert">{{ problem }}</p>
      </div>
      <footer class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-[15px] py-2.5">
        <button v-if="words.back !== undefined" type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="emit('back')">{{ words.back }}</button>
        <button ref="first" type="button" class="btn btn-primary px-3 py-1 text-[14px]" :disabled="busy" @click="emit('ok')">Va bene</button>
      </footer>
    </section>
  </div>
</template>

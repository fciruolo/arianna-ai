import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/**
 * The behaviour of a modal window of the left bar (D-097), as in "Decisioni in
 * attesa" (D-091): Esc closes it before anything under it sees the key, Tab
 * stays inside, and the focus goes back where it was when it closes.
 *
 * `holder: true` is for a window that holds other windows and menus (the
 * cardwall in the office, D-165): it hears the keys after everything inside
 * it, and leaves alone a key they already took (a menu's Esc, the Tab of a
 * card's detail), so Esc closes the innermost one first.
 */
export function useModal(dialog: Ref<HTMLElement | null>, close: () => void, first?: Ref<HTMLElement | null>, options: { holder?: boolean } = {}): void {
  const capture = options.holder !== true;
  let opener: Element | null = null;

  function focusables(): HTMLElement[] {
    return [
      ...(dialog.value?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
  }

  function onKey(event: KeyboardEvent): void {
    if (!capture && event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (capture) event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const list = focusables();
    const head = list[0];
    const tail = list.at(-1);
    if (head === undefined || tail === undefined) {
      event.preventDefault();
      dialog.value?.focus();
      return;
    }
    const active = document.activeElement;
    const inside = active !== null && dialog.value?.contains(active) === true;
    if (event.shiftKey && (active === head || !inside || active === dialog.value)) {
      event.preventDefault();
      tail.focus();
    } else if (!event.shiftKey && (active === tail || !inside)) {
      event.preventDefault();
      head.focus();
    }
  }

  onMounted(() => {
    opener = document.activeElement;
    window.addEventListener('keydown', onKey, capture);
    (first?.value ?? dialog.value)?.focus();
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey, capture);
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  });
}

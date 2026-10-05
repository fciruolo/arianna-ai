import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/**
 * The behaviour of a modal window of the left bar (D-097), as in "Decisioni in
 * attesa" (D-091): Esc closes it before anything under it sees the key, Tab
 * stays inside, and the focus goes back where it was when it closes.
 */
export function useModal(dialog: Ref<HTMLElement | null>, close: () => void, first?: Ref<HTMLElement | null>): void {
  let opener: Element | null = null;

  function focusables(): HTMLElement[] {
    return [
      ...(dialog.value?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
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
    window.addEventListener('keydown', onKey, true);
    (first?.value ?? dialog.value)?.focus();
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey, true);
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  });
}

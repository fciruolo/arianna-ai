/**
 * The «@» menu of a composer (D-107, tappa B2, D-219), for the chat and for a
 * new conversation before its first message: while the field is «@» and a
 * name, the agents «@» may call that match; arrows, Invio or Tab and Esc.
 */
import { computed, ref, watch, type Ref } from 'vue';

import { filterMentions, mentionQuery, moveSelection } from './commands.ts';

export function useMentionMenu(text: Ref<string>, enabled: () => boolean, agents: () => readonly string[] | undefined, choose: (agent: string) => void) {
  const active = ref(0);
  const dismissed = ref<string | null>(null);
  const items = computed(() => {
    const query = mentionQuery(text.value);
    const list = agents();
    if (query === undefined || !enabled() || list === undefined) return [];
    return filterMentions(query, list);
  });
  const open = computed(() => items.value.length > 0 && text.value !== dismissed.value);
  watch(items, () => {
    active.value = 0;
  });

  /** A key of the field: true when the menu took it. */
  function onKey(event: KeyboardEvent): boolean {
    if (!open.value) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active.value = moveSelection(active.value, event.key === 'ArrowDown' ? 1 : -1, items.value.length);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissed.value = text.value;
      return true;
    }
    const agent = items.value[active.value];
    if (agent !== undefined && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      choose(agent);
      return true;
    }
    return false;
  }

  return { items, open, active, onKey, choose };
}

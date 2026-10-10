<script setup lang="ts">
/**
 * The agents in the conversation as a pile of small avatars beside Arianna's
 * in the head of the chat (D-162, in place of the bar of D-125). Hovering an
 * avatar gives its name; a click (or Enter) opens a small menu under the pile
 * with the name, where it works and "Togli dalla chat". Beyond four avatars a
 * "+N" opens the others as a list. Esc, a click outside or the focus leaving
 * the menu close it; Esc gives the focus back to the avatar.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { agentName } from '../lib/italian.ts';
import { executorText, participantPose, removeText, stackOf } from '../lib/participants.ts';
import type { AgentStatus, CharacterChoice, Participant } from '../lib/types.ts';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

const props = defineProps<{
  participants: readonly Participant[];
  characters: Record<string, CharacterChoice> | undefined;
  agents: readonly AgentStatus[] | undefined;
}>();
const emit = defineEmits<{ remove: [agent: string] }>();

/** The key of the open menu: an agent, or MORE for the list behind "+N". */
const MORE = '\u0000more';
const open = ref<string | null>(null);
const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);

const stack = computed(() => stackOf(props.participants));
/** The participants the open menu shows; empty when the agent opened has just gone. */
const inMenu = computed<Participant[]>(() => {
  if (open.value === null) return [];
  if (open.value === MORE) return stack.value.hidden;
  return props.participants.filter((participant) => participant.agent === open.value);
});

// The agent of the open menu taken out (from here or from another tab): the menu closes.
watch(inMenu, (now) => {
  if (open.value !== null && now.length === 0) open.value = null;
});

function trigger(key: string): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null;
}

function onDocument(event: PointerEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) open.value = null;
}

watch(open, async (now, before) => {
  if (now !== null && before === null) document.addEventListener('pointerdown', onDocument, true);
  if (now === null) document.removeEventListener('pointerdown', onDocument, true);
  if (now !== null) {
    await nextTick();
    menu.value?.querySelector<HTMLElement>('button')?.focus();
  }
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocument, true));

function toggle(key: string): void {
  open.value = open.value === key ? null : key;
}

function close(focusBack: boolean): void {
  const key = open.value;
  open.value = null;
  if (focusBack && key !== null) trigger(key)?.focus();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value !== null) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }
}

/** The menu closes when the focus leaves the pile and its menu (Tab). */
function onFocusOut(event: FocusEvent): void {
  if (!(event.relatedTarget instanceof Node && root.value?.contains(event.relatedTarget) === true)) open.value = null;
}

function remove(agent: string): void {
  const many = open.value === MORE && stack.value.hidden.length > 1;
  emit('remove', agent);
  // From the list behind "+N" the others stay; otherwise the menu goes and the focus lands on the pile.
  if (!many) {
    open.value = null;
    void nextTick(() => root.value?.querySelector<HTMLElement>('[data-key]')?.focus());
  }
}
</script>

<template>
  <div v-if="participants.length > 0" ref="root" class="relative flex items-center" @keydown="onKey" @focusout="onFocusOut">
    <button
      v-for="(participant, index) in stack.shown"
      :key="participant.agent"
      type="button"
      :data-key="participant.agent"
      class="relative grid size-8 place-items-center overflow-hidden rounded-full border-2 border-bg bg-surface-2 transition-transform hover:-translate-y-0.5"
      :class="[index > 0 ? '-ml-2.5' : '', open === participant.agent ? 'ring-1 ring-accent' : '']"
      :style="{ zIndex: open === participant.agent ? 20 : stack.shown.length - index }"
      :title="agentName(participant.agent)"
      :aria-label="`${agentName(participant.agent)}: dettagli`"
      aria-haspopup="menu"
      :aria-expanded="open === participant.agent"
      @click="toggle(participant.agent)"
    >
      <PixelAgent :choice="characters?.[participant.agent]" :pose="participantPose(participant.agent, agents)" :scale="1" class="translate-y-1" />
    </button>
    <button
      v-if="stack.hidden.length > 0"
      type="button"
      :data-key="MORE"
      class="relative -ml-2.5 grid size-8 place-items-center rounded-full border-2 border-bg bg-surface-2 font-mono text-[11px] font-medium text-muted hover:text-ink"
      :class="open === MORE ? 'ring-1 ring-accent' : ''"
      :title="stack.hidden.map((participant) => agentName(participant.agent)).join(', ')"
      :aria-label="`Altri ${String(stack.hidden.length)} partecipanti`"
      aria-haspopup="menu"
      :aria-expanded="open === MORE"
      @click="toggle(MORE)"
    >+{{ stack.hidden.length }}</button>

    <div
      v-if="open !== null && inMenu.length > 0"
      ref="menu"
      role="menu"
      :aria-label="open === MORE ? 'Altri partecipanti' : agentName(open)"
      class="absolute top-full left-0 z-30 mt-1.5 w-max max-w-[min(260px,calc(100vw-2rem))] min-w-[200px] rounded-xl border border-line-strong bg-surface p-1 text-[13px] shadow-[0_14px_40px_#0005]"
    >
      <div v-for="participant in inMenu" :key="participant.agent" class="flex items-center gap-2 rounded-lg px-2 py-1.5">
        <PixelAgent :choice="characters?.[participant.agent]" :pose="participantPose(participant.agent, agents)" :scale="1" />
        <div class="min-w-0 flex-1 leading-tight">
          <div class="truncate font-medium text-ink">{{ agentName(participant.agent) }}</div>
          <div class="truncate font-mono text-[10.5px] text-muted">{{ executorText(participant) }}</div>
        </div>
        <button
          v-if="open === MORE"
          type="button"
          role="menuitem"
          class="grid size-7 shrink-0 place-items-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-ink focus-visible:bg-surface-2"
          :aria-label="removeText(participant)"
          :title="removeText(participant)"
          @click="remove(participant.agent)"
        ><Icon name="close" :size="14" /></button>
      </div>
      <button
        v-if="open !== MORE && inMenu[0] !== undefined"
        type="button"
        role="menuitem"
        class="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-muted outline-none hover:bg-surface-2 hover:text-ink focus-visible:bg-surface-2"
        :title="removeText(inMenu[0])"
        @click="remove(inMenu[0].agent)"
      ><Icon name="close" :size="14" />Togli dalla chat</button>
    </div>
  </div>
</template>

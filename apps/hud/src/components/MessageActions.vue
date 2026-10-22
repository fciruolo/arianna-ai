<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import { copyText, COPY_FEEDBACK_MS, type ClipboardLike, type CopyResult } from '../lib/clipboard.ts';
import { COPY_TEXT, SAVE_TO_INBOX_HINT, SAVE_TO_INBOX_TEXT } from '../lib/italian.ts';
import {
  COPY_HINT,
  inboxNodeId,
  isSaved,
  OPEN_IN_KNOWLEDGE_HINT,
  OPEN_IN_KNOWLEDGE_TEXT,
  SAVED_HINT,
  SAVED_TEXT,
  SAVING_TEXT,
  saveMessage,
} from '../lib/message-actions.ts';
import { SIDE_ACTION_TEXT, SIDE_HINT, SIDE_REOPEN_TEXT } from '../lib/side-chat.ts';
import { PIN_HINT, PIN_TEXT, PINNED_TEXT } from '../lib/dashboard.ts';
import type { Message } from '../lib/types.ts';
import Icon from './Icon.vue';

/**
 * "Copia" and "Salva in inbox" over a message (D-099). Hidden until the
 * pointer passes on the message (the parent's `.msg-row:hover`), the keyboard
 * reaches a button (focus-within) or always on a touch screen. "Copia" copies
 * the message's source text, never the rendered HTML; "Salva in inbox" sends
 * the message id, and once saved (now, before, or 409) says "Salvato". The
 * save button stays the same element, focusable, when it turns into
 * "Salvato" (aria-disabled, never `disabled`), so the keyboard focus does not
 * fall back to the page. Once saved, and when the note has a name (up to
 * L2), "Apri nella Conoscenza" opens it selected in the graph (D-090); like
 * the save, not for a message whose save is not offered. One announcement for screen readers: the hidden
 * `role="status"` line; the visible texts carry no live region of their own.
 */
const props = defineProps<{
  message: Message;
  /** Already in kb/inbox (from GET /api/conversations/:id/saved or a save on this page). */
  saved: boolean;
  /** The note's file name, when known and up to L2: shown in the title of "Salvato". */
  note: string | null;
  /** Whether "Salva in inbox" is offered: not for system lines nor above L2. */
  canSave: boolean;
  /** «Chiedi a lato» (D-232): `ask` on an answer, `reopen` when it has a side thread already; absent where it is not offered. */
  side?: 'ask' | 'reopen' | undefined;
  /** «Fissa alla Dashboard» (D-248): `pin` on an answer, `pinned` when it is in the Dashboard already; absent where it is not offered. */
  pin?: 'pin' | 'pinned' | undefined;
}>();
const emit = defineEmits<{
  saved: [messageId: string, note: string | null];
  /** "Apri nella Conoscenza": the node of the saved note in the graph of kb/. */
  openKnowledge: [nodeId: string];
  /** «Chiedi a lato» (D-232): the panel of the side thread on this answer. */
  side: [messageId: string];
  /** «Fissa alla Dashboard» (D-248): the dialog to pin this answer. */
  pin: [messageId: string];
  /** «Fissato · Apri nella Dashboard». */
  openDashboard: [];
}>();

/** How long the reason of a failed save stays next to the button. */
const ERROR_MS = 6000;

const copyState = ref<'idle' | CopyResult>('idle');
const saving = ref(false);
const error = ref<string | null>(null);
/** What the status line says, for screen readers: the last feedback. */
const announcement = ref('');
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let errorTimer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  // navigator.clipboard is undefined outside a secure context, whatever the types say.
  const clipboard = (navigator as { clipboard?: ClipboardLike }).clipboard;
  copyState.value = await copyText(props.message.body, clipboard);
  announcement.value = COPY_TEXT[copyState.value];
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copyState.value = 'idle'), COPY_FEEDBACK_MS);
}

async function save(): Promise<void> {
  if (props.saved || saving.value) return;
  saving.value = true;
  error.value = null;
  clearTimeout(errorTimer);
  try {
    const outcome = await saveMessage(props.message);
    if (isSaved(outcome)) {
      announcement.value = SAVED_TEXT;
      emit('saved', props.message.id, outcome.note);
    } else {
      error.value = outcome.text;
      announcement.value = outcome.text;
      errorTimer = setTimeout(() => (error.value = null), ERROR_MS);
    }
  } finally {
    saving.value = false;
  }
}

onBeforeUnmount(() => {
  clearTimeout(copyTimer);
  clearTimeout(errorTimer);
});

/** Feedback in progress keeps the actions on screen after the pointer leaves. */
const busy = computed(() => copyState.value !== 'idle' || saving.value || error.value !== null);
const savedTitle = computed(() => (props.note === null ? SAVED_HINT : `${SAVED_HINT}: ${props.note}`));
</script>

<template>
  <!-- `relative`: the sr-only status below is absolute; without a positioned box here it hangs off the page and makes it scroll past the chat. -->
  <span class="msg-actions relative inline-flex items-center gap-2.5 font-mono text-[12px] text-muted" :class="{ 'msg-actions-busy': busy }">
    <button type="button" class="action" :class="{ 'text-warn': copyState === 'unavailable' }" :title="COPY_HINT" @click="copy">
      <Icon :name="copyState === 'copied' ? 'saved' : 'copy'" :size="12" class="action-icon" /><span class="action-text">{{ COPY_TEXT[copyState] }}</span>
    </button>
    <button
      v-if="canSave"
      type="button"
      class="action"
      :class="{ 'text-ok': saved }"
      :title="saved ? savedTitle : SAVE_TO_INBOX_HINT"
      :aria-disabled="saved || saving"
      :aria-busy="saving"
      @click="save"
    >
      <Icon :name="saved ? 'saved' : 'inbox'" :size="12" class="action-icon" /><span class="action-text">{{ saved ? SAVED_TEXT : saving ? SAVING_TEXT : SAVE_TO_INBOX_TEXT }}</span>
    </button>
    <button v-if="canSave && saved && note !== null" type="button" class="action" :title="`${OPEN_IN_KNOWLEDGE_HINT}: ${note}`" @click="emit('openKnowledge', inboxNodeId(note))">
      <Icon name="knowledge" :size="12" class="action-icon" /><span class="action-text">{{ OPEN_IN_KNOWLEDGE_TEXT }}</span>
    </button>
    <button v-if="side !== undefined" type="button" class="action" :title="SIDE_HINT" @click="emit('side', message.id)">
      <Icon name="panel" :size="12" class="action-icon" /><span class="action-text">{{ side === 'reopen' ? SIDE_REOPEN_TEXT : SIDE_ACTION_TEXT }}</span>
    </button>
    <button v-if="pin === 'pin'" type="button" class="action" :title="PIN_HINT" @click="emit('pin', message.id)">
      <Icon name="pin" :size="12" class="action-icon" /><span class="action-text">{{ PIN_TEXT }}</span>
    </button>
    <button v-else-if="pin === 'pinned'" type="button" class="action text-ok" @click="emit('openDashboard')">
      <Icon name="dashboard" :size="12" class="action-icon" /><span class="action-text">{{ PINNED_TEXT }}</span>
    </button>
    <span v-if="error !== null" class="text-warn">{{ error }}</span>
    <span role="status" class="sr-only">{{ announcement }}</span>
  </span>
</template>

<style scoped>
/*
 * Hidden until the message is under the pointer (the rule on `.msg-row:hover`
 * is in ChatView.vue, which owns the row), a button has the keyboard focus, or
 * feedback is on screen. Opacity, not display: the buttons stay in the tab
 * order and the row does not move when they appear. Always visible where
 * there is no hover (touch).
 */
.msg-actions {
  opacity: 0;
  transition: opacity 120ms ease-out;
}
.msg-actions:focus-within,
.msg-actions-busy {
  opacity: 1;
}
@media (hover: none) {
  .msg-actions {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .msg-actions {
    transition: none;
  }
}
.action {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border-radius: 0.25rem;
}
.action:hover:not([aria-disabled='true']) {
  color: var(--ink);
}
.action[aria-disabled='true'] {
  cursor: default;
}
.action[aria-busy='true'] {
  cursor: progress;
}
/* The phone (D-293): only the icons, each a target for a finger; the words stay for screen readers. */
@media (max-width: 47.98rem) {
  .msg-actions {
    gap: 0.125rem;
  }
  .action {
    justify-content: center;
    min-width: 2.5rem;
    min-height: 2.5rem;
  }
  .action-icon {
    width: 17px;
    height: 17px;
  }
  .action-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { restartGodConversation } from '../lib/api.ts';
import { type CarryMessage, loadDeclined, proposeCarry, saveDeclined } from '../lib/god.ts';
import { errorText } from '../lib/italian.ts';

/**
 * "Riassumi e riparti" proposed by GOD (D-127, G4, choice of the user of
 * 2026-10-11): when the chat is long, at its end GOD asks whether to restart
 * from a summary. «Sì» opens a new conversation with a fresh session from a
 * summary written by the code (this one stays whole, and does not ask
 * again); «No» hides the question for CARRY_PROPOSE_AGAIN more messages,
 * remembered in this browser. Not a message: nothing is saved in the
 * conversation. Shown only after an answer of GOD, never while it works
 * (`sending`: a message on its way or an answer streaming).
 */
const props = defineProps<{ conversationId: string; messages: readonly CarryMessage[]; sending: boolean; name: string }>();
const emit = defineEmits<{ open: [id: string] }>();

const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
const declinedAfter = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.conversationId,
  (id) => {
    declinedAfter.value = loadDeclined(storage, id);
    busy.value = false;
    error.value = null;
  },
  { immediate: true },
);

const shown = computed(() => !props.sending && proposeCarry(props.messages, declinedAfter.value));

/** Not again in this conversation for CARRY_PROPOSE_AGAIN messages. */
function answered(conversationId: string, latest: string | undefined): void {
  if (latest === undefined) return;
  saveDeclined(storage, conversationId, latest);
  if (conversationId === props.conversationId) declinedAfter.value = latest;
}

function decline(): void {
  answered(props.conversationId, props.messages.at(-1)?.id);
}

async function restart(): Promise<void> {
  const from = props.conversationId;
  const latest = props.messages.at(-1)?.id;
  busy.value = true;
  try {
    const conversation = await restartGodConversation(from);
    answered(from, latest);
    // Another chat opened meanwhile: the user stays there.
    if (props.conversationId !== from) return;
    error.value = null;
    emit('open', conversation.id);
  } catch (cause) {
    if (props.conversationId === from) error.value = `Non sono riuscita a ripartire. ${errorText(cause)}`;
  } finally {
    if (props.conversationId === from) busy.value = false;
  }
}
</script>

<template>
  <!-- Always there, so a screen reader reads the question when it appears -->
  <div aria-live="polite">
    <div v-if="shown" class="max-w-[92%]">
      <div class="mb-1.5 font-hud text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">{{ name }}</div>
      <p class="text-[14px]">
        La chat è lunga: riparto da un riassunto? Si apre una chat nuova che parte da quello che abbiamo deciso qui; questa resta intera.
      </p>
      <div class="mt-2 flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy" @click="restart">{{ busy ? 'Riassumo…' : 'Sì, riparti' }}</button>
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="decline">No, continua qui</button>
      </div>
      <p v-if="error !== null" role="alert" class="mt-2 text-[12.5px] text-danger">{{ error }}</p>
    </div>
  </div>
</template>

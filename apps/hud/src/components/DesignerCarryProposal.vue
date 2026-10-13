<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { startDesignerSession } from '../lib/api.ts';
import { contextMeter } from '../lib/direct-chat.ts';
import { errorText } from '../lib/italian.ts';
import { loadCarryDeclined, proposeDesignerCarry, saveCarryDeclined } from '../lib/studio.ts';

/**
 * The proposal of «Nuova sessione» (I-20, D-185, choice of the user): every
 * message resumes the Designer's session, and the model reads it all again
 * each time. When the context is heavy, after an answer the chat asks
 * whether to start a new session in this conversation (the history stays,
 * the Designer reads a short summary written by the code); «No» asks again
 * only when the context has grown further, remembered in this browser. The
 * button «Nuova sessione» of the chat does the same at any time. Not a message.
 */
const props = defineProps<{ conversationId: string; contextTokens: number | null; lastRole: string | undefined; sending: boolean; name: string; open?: string | undefined }>();
const emit = defineEmits<{ restarted: [id: string] }>();

const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
const declinedAt = ref<number | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.conversationId,
  (id) => {
    declinedAt.value = loadCarryDeclined(storage, id);
    busy.value = false;
    error.value = null;
  },
  { immediate: true },
);

const percent = computed(() => contextMeter(props.contextTokens).percent);
const shown = computed(() => !props.sending && proposeDesignerCarry(percent.value, props.lastRole, declinedAt.value));

function decline(): void {
  saveCarryDeclined(storage, props.conversationId, percent.value);
  declinedAt.value = percent.value;
}

async function restart(): Promise<void> {
  const from = props.conversationId;
  busy.value = true;
  try {
    const conversation = await startDesignerSession(from, props.open);
    if (props.conversationId !== from) return;
    error.value = null;
    emit('restarted', conversation.id);
  } catch (cause) {
    if (props.conversationId === from) error.value = `Non sono riuscito ad aprire la sessione nuova. ${errorText(cause)}`;
  } finally {
    if (props.conversationId === from) busy.value = false;
  }
}
</script>

<template>
  <!-- Always there, so a screen reader reads the question when it appears -->
  <div aria-live="polite">
    <div v-if="shown" class="max-w-[92%]">
      <div class="mb-1.5 font-hud text-[12px] font-semibold tracking-[0.16em] text-accent uppercase">{{ name }}</div>
      <p class="text-[14px]">
        La sessione è pesante ({{ percent }}% del contesto): ogni messaggio mi fa rileggere tutto. Apro una sessione nuova? La conversazione resta qui com'è; io riparto da un breve riassunto (le tue ultime richieste e la variante aperta) e dai mockup del progetto.
      </p>
      <div class="mt-2 flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy" @click="restart">{{ busy ? 'Apro…' : 'Sì, sessione nuova' }}</button>
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="decline">No, continua qui</button>
      </div>
      <p v-if="error !== null" role="alert" class="mt-2 text-[13.5px] text-danger">{{ error }}</p>
    </div>
  </div>
</template>

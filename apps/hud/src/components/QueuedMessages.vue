<script setup lang="ts">
/**
 * The messages waiting for the answer at work (D-218, idea 4 of OpenWork,
 * D-093), above the field: each can be changed or removed before it leaves.
 * After "Ferma" the queue is paused: "Invia ora" sends one, "Riprendi la
 * coda" lets them leave again one at a time.
 */
import { nextTick, ref } from 'vue';
import { queueHint } from '../lib/queue.ts';
import type { QueueView } from '../lib/types.ts';

defineProps<{
  queue: QueueView;
  /** An answer of this conversation is at work: "Invia ora" waits for it. */
  working: boolean;
  /** Waiting for a decision of the user on a request above, not for an answer. */
  waitingDecision: boolean;
}>();
const emit = defineEmits<{
  edit: [id: string, body: string];
  remove: [id: string];
  send: [id: string];
  resume: [];
}>();

const editing = ref<string | null>(null);
const text = ref('');
const field = ref<HTMLTextAreaElement[] | null>(null);

function startEdit(id: string, body: string): void {
  editing.value = id;
  text.value = body;
  void nextTick(() => field.value?.[0]?.focus());
}

function save(id: string): void {
  if (text.value.trim() === '') return;
  emit('edit', id, text.value);
  editing.value = null;
}

function onKey(event: KeyboardEvent, id: string): void {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    editing.value = null;
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    save(id);
  }
}

</script>

<template>
  <section
    v-if="queue.messages.length > 0"
    class="mx-auto mb-2 flex max-w-[780px] flex-col gap-1.5 rounded-[16px] border border-line bg-surface px-3 py-2"
    aria-label="Messaggi in coda"
  >
    <header class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      <span class="font-semibold text-ink">In coda · {{ queue.messages.length }}</span>
      <span class="min-w-0 flex-1 text-muted">{{ queueHint(queue, working, waitingDecision) }}</span>
      <button v-if="queue.paused" type="button" class="btn px-2.5 py-0.5 text-[13px]" :disabled="working" @click="emit('resume')">Riprendi la coda</button>
    </header>
    <ol class="flex flex-col gap-1">
      <li v-for="message in queue.messages" :key="message.id" class="flex items-start gap-2 rounded-lg bg-bg/60 px-2.5 py-1.5 text-[14px]">
        <template v-if="editing === message.id">
          <label :for="`queued-${message.id}`" class="sr-only">Modifica il messaggio in coda</label>
          <textarea
            :id="`queued-${message.id}`"
            ref="field"
            v-model="text"
            rows="2"
            maxlength="16000"
            class="min-w-0 flex-1 resize-y border-0 bg-transparent text-ink outline-none focus-visible:outline-none"
            @keydown="onKey($event, message.id)"
          />
          <div class="flex shrink-0 gap-1">
            <button type="button" class="btn px-2 py-0.5 text-[13px]" :disabled="text.trim() === ''" @click="save(message.id)">Salva</button>
            <button type="button" class="rounded-md px-2 py-0.5 text-[13px] text-muted hover:text-ink" @click="editing = null">Annulla</button>
          </div>
        </template>
        <template v-else>
          <p class="min-w-0 flex-1 truncate text-ink" :title="message.body">{{ message.body }}</p>
          <div class="flex shrink-0 gap-1 text-[13px]">
            <button v-if="queue.paused" type="button" class="rounded-md px-1.5 text-info hover:underline disabled:opacity-40" :disabled="working" @click="emit('send', message.id)">Invia ora</button>
            <button type="button" class="rounded-md px-1.5 text-muted hover:text-ink" @click="startEdit(message.id, message.body)">Modifica</button>
            <button type="button" class="rounded-md px-1.5 text-muted hover:text-danger" @click="emit('remove', message.id)">Togli</button>
          </div>
        </template>
      </li>
    </ol>
  </section>
</template>

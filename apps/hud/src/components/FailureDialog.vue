<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { chatCanHelp, failureText } from '../lib/failures.ts';
import type { Task, TaskFailure } from '../lib/types.ts';
import Icon from './Icon.vue';

/**
 * Why a task failed (D-064): explanation and steps from the page's catalog,
 * the technical details as they were stored, "Riprova" and the system chat.
 */
const props = defineProps<{ task: Task; failure: TaskFailure | null; loading: boolean }>();
const emit = defineEmits<{ close: []; retry: [taskId: string]; chat: [taskId: string] }>();

const text = computed(() => (props.failure === null ? undefined : failureText(props.failure)));
const details = computed(() => Object.entries(props.failure?.details ?? {}));
const dialog = ref<HTMLElement | null>(null);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  dialog.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" @click.self="emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="failure-title"
      tabindex="-1"
      class="hud-card flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-y-auto bg-surface outline-none"
    >
      <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span class="grid size-6 shrink-0 place-items-center rounded-full bg-danger/15 font-mono font-bold text-danger" aria-hidden="true">!</span>
        <h2 id="failure-title" class="min-w-0 flex-1 truncate font-medium">{{ text?.title ?? 'Perché il task è fallito' }}</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="flex flex-col gap-3 px-[15px] py-3 text-[13.5px]">
        <p class="truncate text-xs text-muted" :title="task.title">Task: {{ task.title }}</p>
        <p v-if="loading" class="text-muted">Leggo l’errore…</p>
        <template v-else-if="failure === null || text === undefined">
          <p>Per questo task non è stato salvato un errore: è fallito prima degli errori leggibili, oppure è stato chiuso con l’eliminazione della sua conversazione.</p>
        </template>
        <template v-else>
          <p>{{ text.explanation }}</p>
          <div>
            <h3 class="hud-title mb-1.5">Cosa fare</h3>
            <ol class="flex list-decimal flex-col gap-1 pl-5">
              <li v-for="step in text.steps" :key="step">{{ step }}</li>
            </ol>
          </div>
          <details class="text-xs text-muted">
            <summary class="cursor-pointer">Dettagli tecnici</summary>
            <dl class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
              <dt>codice</dt>
              <dd class="break-all text-ink">{{ failure.code }}</dd>
              <template v-for="[key, value] in details" :key="key">
                <dt>{{ key }}</dt>
                <dd class="break-all text-ink">{{ value }}</dd>
              </template>
              <dt>quando</dt>
              <dd class="text-ink">{{ new Date(failure.ts).toLocaleString('it-IT') }}</dd>
            </dl>
          </details>
          <p v-if="!chatCanHelp(failure)" class="text-xs text-muted">
            La chat di sistema risponde con il modello locale, che è proprio quello che non funziona: potrai usarla quando sarà di nuovo attivo.
          </p>
        </template>
      </div>

      <footer class="flex flex-wrap justify-end gap-2 border-t border-line px-[15px] py-2.5">
        <button v-if="failure !== null" type="button" class="btn" @click="emit('chat', task.id)">
          <Icon name="system" :size="16" />Apri la chat di sistema
        </button>
        <button type="button" class="btn btn-primary" :disabled="task.status !== 'failed'" @click="emit('retry', task.id)">
          <Icon name="retry" :size="16" />Riprova
        </button>
      </footer>
    </section>
  </div>
</template>

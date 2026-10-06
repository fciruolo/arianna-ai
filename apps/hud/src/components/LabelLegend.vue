<script setup lang="ts">
import { ref } from 'vue';

import { LABEL_CLASS, LABEL_LEGEND, LABEL_RULE, LABEL_TEXT } from '../lib/labels.ts';
import { useModal } from '../lib/modal.ts';
import Icon from './Icon.vue';

/** What the labels mean (etichette parlanti): every label, an example, where it may go. */
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
useModal(dialog, () => emit('close'));
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]" @click.self="emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legend-title"
      tabindex="-1"
      class="hud-card flex max-h-[80vh] w-full max-w-[520px] flex-col bg-surface outline-none"
    >
      <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span class="text-accent"><Icon name="gateway" :size="18" /></span>
        <h2 id="legend-title" class="flex-1 font-medium">Cosa vogliono dire le etichette</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="flex flex-col gap-3 overflow-y-auto px-[15px] py-3.5 text-[13px]">
        <p class="text-muted">Ogni messaggio, nota e documento porta un'etichetta: dice fin dove può arrivare.</p>
        <dl class="flex flex-col gap-3">
          <div v-for="entry in LABEL_LEGEND" :key="entry.label" class="flex flex-col gap-0.5">
            <dt class="inline-flex items-center gap-2 font-medium" :class="LABEL_CLASS[entry.label]">
              <i class="size-2 rounded-full bg-current" aria-hidden="true" />{{ LABEL_TEXT[entry.label] }}
            </dt>
            <dd class="text-ink">{{ entry.meaning }}</dd>
            <dd class="text-muted">Per esempio: {{ entry.example }}</dd>
            <dd class="text-muted">{{ entry.goes }}</dd>
          </div>
        </dl>
        <p class="border-t border-line pt-3 text-muted">{{ LABEL_RULE }}</p>
      </div>
    </section>
  </div>
</template>

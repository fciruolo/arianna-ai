<script setup lang="ts">
import { ref } from 'vue';

import { END_CONFIRM_TEXT } from '../lib/incognito.ts';
import { useModal } from '../lib/modal.ts';
import type { ConversationMode } from '../lib/types.ts';
import Icon from './Icon.vue';
import IncognitoNotice from './IncognitoNotice.vue';

/** "Termina" of an incognito conversation (D-136): asks, with what stays outside, before the core deletes. */
defineProps<{ mode: ConversationMode; project?: string | undefined; ending: boolean }>();
const emit = defineEmits<{ close: []; confirm: [] }>();

const dialog = ref<HTMLElement | null>(null);
const cancel = ref<HTMLElement | null>(null);
useModal(dialog, () => emit('close'), cancel);
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[14vh]" @click.self="emit('close')">
    <section
      ref="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="incognito-end-title"
      aria-describedby="incognito-end-text"
      tabindex="-1"
      class="hud-card flex w-full max-w-[480px] flex-col bg-surface outline-none"
    >
      <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <Icon name="incognito" :size="18" />
        <h2 id="incognito-end-title" class="flex-1 font-medium">Termina la conversazione incognita</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="flex flex-col gap-3 px-[15px] py-3.5">
        <p id="incognito-end-text" class="text-sm">{{ END_CONFIRM_TEXT }}</p>
        <IncognitoNotice :mode="mode" :project="project" />
        <div class="flex justify-end gap-2">
          <button ref="cancel" type="button" class="btn px-3 py-1.5 text-sm" @click="emit('close')">Annulla</button>
          <button type="button" class="btn border-danger/60 px-3 py-1.5 text-sm text-danger" :disabled="ending" @click="emit('confirm')">
            <Icon name="delete" :size="14" />{{ ending ? 'Cancello…' : 'Termina e cancella' }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { MODE_HINT, MODE_TEXT } from '../lib/labels.ts';
import type { ConversationMode } from '../lib/types.ts';

const emit = defineEmits<{ create: [mode: ConversationMode, workspace?: string] }>();
const mode = ref<ConversationMode>('private');
const workspace = ref('');
const modes: ConversationMode[] = ['private', 'work'];

function submit(): void {
  const trimmed = workspace.value.trim();
  if (mode.value === 'work' && trimmed !== '') emit('create', mode.value, trimmed);
  else emit('create', mode.value);
  workspace.value = '';
}
</script>

<template>
  <form class="flex flex-col gap-2" @submit.prevent="submit">
    <div class="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-800" role="radiogroup" aria-label="Modalità">
      <button
        v-for="option in modes"
        :key="option"
        type="button"
        role="radio"
        :aria-checked="mode === option"
        class="rounded-md px-2 py-1.5 text-sm font-medium transition"
        :class="
          mode === option
            ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-white'
            : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200'
        "
        @click="mode = option"
      >
        {{ MODE_TEXT[option] }}
      </button>
    </div>
    <p class="text-xs leading-snug text-stone-500 dark:text-stone-400">{{ MODE_HINT[mode] }}</p>
    <input
      v-if="mode === 'work'"
      v-model="workspace"
      type="text"
      placeholder="Repository (facoltativo), es. repos/sito"
      class="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-stone-700 dark:bg-stone-900"
    />
    <button
      type="submit"
      class="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
    >
      Nuova conversazione
    </button>
  </form>
</template>

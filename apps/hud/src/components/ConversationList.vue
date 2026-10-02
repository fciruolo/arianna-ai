<script setup lang="ts">
import { MODE_TEXT } from '../lib/labels.ts';
import type { Conversation } from '../lib/types.ts';

defineProps<{ conversations: Conversation[]; selected: string | null }>();
const emit = defineEmits<{ open: [id: string] }>();

const format = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function when(conversation: Conversation): string {
  return format.format(new Date(conversation.lastMessageAt ?? conversation.createdAt));
}
</script>

<template>
  <nav aria-label="Conversazioni">
    <p v-if="conversations.length === 0" class="px-2 text-sm text-stone-500 dark:text-stone-400">Nessuna conversazione.</p>
    <ul class="flex flex-col gap-0.5">
      <li v-for="conversation in conversations" :key="conversation.id">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition"
          :class="
            conversation.id === selected
              ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100'
              : 'hover:bg-stone-100 dark:hover:bg-stone-800'
          "
          :aria-current="conversation.id === selected ? 'true' : undefined"
          @click="emit('open', conversation.id)"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="conversation.mode === 'private' ? 'bg-violet-500' : 'bg-sky-500'"
            :title="MODE_TEXT[conversation.mode]"
          />
          <span class="font-medium">{{ MODE_TEXT[conversation.mode] }}</span>
          <span v-if="conversation.workspace" class="truncate text-stone-500 dark:text-stone-400">{{ conversation.workspace }}</span>
          <span class="ml-auto shrink-0 text-xs text-stone-500 dark:text-stone-400">{{ when(conversation) }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

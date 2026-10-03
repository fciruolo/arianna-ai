<script setup lang="ts">
import { nextTick, ref } from 'vue';

import { MODE_TEXT } from '../lib/labels.ts';
import type { Conversation } from '../lib/types.ts';

const props = defineProps<{
  conversations: Conversation[];
  archived: Conversation[];
  selected: string | null;
  rename: (id: string, title: string) => Promise<boolean>;
}>();
const emit = defineEmits<{ open: [id: string]; archive: [id: string, archived: boolean] }>();

const format = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function when(conversation: Conversation): string {
  return format.format(new Date(conversation.lastMessageAt ?? conversation.createdAt));
}

function titleOf(conversation: Conversation): string {
  return conversation.title ?? 'Nuova conversazione';
}

/** The conversation whose title is being edited, and the draft. */
const editing = ref<string | null>(null);
const draft = ref('');
const input = ref<HTMLInputElement[]>([]);
/** The conversation waiting for the user to confirm the archive. */
const confirming = ref<string | null>(null);
const showArchived = ref(false);

async function startRename(conversation: Conversation): Promise<void> {
  confirming.value = null;
  editing.value = conversation.id;
  draft.value = conversation.title ?? '';
  await nextTick();
  input.value[0]?.focus();
  input.value[0]?.select();
}

async function saveRename(conversation: Conversation): Promise<void> {
  if (editing.value !== conversation.id) return;
  const title = draft.value.trim();
  editing.value = null;
  if (title === '' || title === conversation.title) return;
  if (!(await props.rename(conversation.id, title))) {
    editing.value = conversation.id;
    draft.value = title;
    await nextTick();
    input.value[0]?.focus();
  }
}

function onRenameKey(event: KeyboardEvent, conversation: Conversation): void {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    void saveRename(conversation);
  } else if (event.key === 'Escape') {
    editing.value = null;
  }
}

function confirmArchive(id: string): void {
  emit('archive', id, true);
  confirming.value = null;
}
</script>

<template>
  <nav aria-label="Conversazioni" class="flex flex-col">
    <p v-if="conversations.length === 0" class="px-2 text-sm text-stone-500 dark:text-stone-400">Nessuna conversazione.</p>
    <ul class="flex flex-col gap-0.5">
      <li v-for="conversation in conversations" :key="conversation.id" class="group relative">
        <div v-if="editing === conversation.id" class="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <label :for="`title-${conversation.id}`" class="sr-only">Titolo della conversazione</label>
          <input
            :id="`title-${conversation.id}`"
            ref="input"
            v-model="draft"
            type="text"
            maxlength="200"
            class="min-w-0 flex-1 rounded-md border border-indigo-400 bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 dark:bg-stone-900"
            @keydown="onRenameKey($event, conversation)"
            @blur="saveRename(conversation)"
          />
        </div>
        <div
          v-else-if="confirming === conversation.id"
          class="flex items-center gap-2 rounded-lg bg-amber-50 px-2 py-2 text-sm dark:bg-amber-950/40"
          role="group"
          :aria-label="`Archiviare ${titleOf(conversation)}?`"
        >
          <span class="min-w-0 flex-1" title="Sparisce dalla lista; i messaggi restano e la ritrovi in Archiviate. I task già avviati finiscono il loro lavoro.">
            Archiviare? <span class="text-xs text-stone-500 dark:text-stone-400">I task avviati finiscono.</span>
          </span>
          <button
            type="button"
            class="rounded-md bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-500"
            @click="confirmArchive(conversation.id)"
          >
            Archivia
          </button>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-stone-200 dark:text-stone-300 dark:hover:bg-stone-800"
            @click="confirming = null"
          >
            Annulla
          </button>
        </div>
        <template v-else>
          <button
            type="button"
            class="flex w-full flex-col rounded-lg px-2 py-2 pr-16 text-left text-sm transition md:pr-2"
            :class="
              conversation.id === selected
                ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100'
                : 'hover:bg-stone-100 dark:hover:bg-stone-800'
            "
            :aria-current="conversation.id === selected ? 'true' : undefined"
            @click="emit('open', conversation.id)"
          >
            <span class="flex w-full items-center gap-2">
              <span
                class="size-2 shrink-0 rounded-full"
                :class="conversation.mode === 'private' ? 'bg-violet-500' : 'bg-sky-500'"
                :title="MODE_TEXT[conversation.mode]"
              />
              <span class="truncate font-medium" :class="conversation.title === null ? 'text-stone-500 dark:text-stone-400' : ''">
                {{ titleOf(conversation) }}
              </span>
            </span>
            <span class="flex w-full items-center gap-1.5 pl-4 text-xs text-stone-500 dark:text-stone-400">
              <span>{{ MODE_TEXT[conversation.mode] }}</span>
              <span v-if="conversation.telegram">· Telegram</span>
              <span v-if="conversation.workspace" class="truncate">· {{ conversation.workspace }}</span>
              <span class="ml-auto shrink-0">{{ when(conversation) }}</span>
            </span>
          </button>
          <div
            class="absolute top-1.5 right-1.5 flex gap-0.5 rounded-md transition md:bg-white md:opacity-0 md:shadow-sm md:group-focus-within:opacity-100 md:group-hover:opacity-100 dark:md:bg-stone-900"
          >
            <button
              type="button"
              class="rounded-md p-1 text-stone-500 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100"
              :aria-label="`Rinomina ${titleOf(conversation)}`"
              title="Rinomina"
              @click="startRename(conversation)"
            >
              <svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <path d="M13.5 3.5l3 3L7 16H4v-3l9.5-9.5z" stroke-linejoin="round" />
              </svg>
            </button>
            <button
              v-if="!conversation.telegram"
              type="button"
              class="rounded-md p-1 text-stone-500 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100"
              :aria-label="`Archivia ${titleOf(conversation)}`"
              title="Archivia"
              @click="confirming = conversation.id"
            >
              <svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <rect x="3" y="4" width="14" height="4" rx="1" />
                <path d="M4.5 8v7a1 1 0 001 1h9a1 1 0 001-1V8M8 11h4" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </template>
      </li>
    </ul>

    <div v-if="archived.length > 0" class="mt-4 border-t border-stone-200 pt-3 dark:border-stone-800">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
        :aria-expanded="showArchived"
        @click="showArchived = !showArchived"
      >
        <svg class="size-3 transition" :class="showArchived ? 'rotate-90' : ''" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        Archiviate ({{ archived.length }})
      </button>
      <ul v-if="showArchived" class="mt-1 flex flex-col gap-0.5">
        <li v-for="conversation in archived" :key="conversation.id" class="flex items-center gap-1">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-stone-600 transition dark:text-stone-300"
            :class="
              conversation.id === selected
                ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100'
                : 'hover:bg-stone-100 dark:hover:bg-stone-800'
            "
            :aria-current="conversation.id === selected ? 'true' : undefined"
            @click="emit('open', conversation.id)"
          >
            <span
              class="size-2 shrink-0 rounded-full opacity-60"
              :class="conversation.mode === 'private' ? 'bg-violet-500' : 'bg-sky-500'"
              :title="MODE_TEXT[conversation.mode]"
            />
            <span class="truncate">{{ titleOf(conversation) }}</span>
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-stone-200 dark:text-stone-300 dark:hover:bg-stone-700"
            :aria-label="`Ripristina ${titleOf(conversation)}`"
            @click="emit('archive', conversation.id, false)"
          >
            Ripristina
          </button>
        </li>
      </ul>
    </div>
  </nav>
</template>

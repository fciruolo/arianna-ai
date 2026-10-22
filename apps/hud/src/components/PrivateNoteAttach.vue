<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { readProjectKnowledge, readProjectNote } from '../lib/api.ts';
import { browseErrorText, type KnowledgeNote, type OpenedNote } from '../lib/projects.ts';
import Icon from './Icon.vue';
import NoteRelease from './NoteRelease.vue';

/**
 * "Allega nota privata" of a work chat on a project (D-187): the Private
 * notes of its project, then the panel of "Fai uscire una volta" with this
 * conversation fixed. The released text arrives in the chat as a message.
 */
const props = defineProps<{ project: string; conversation: string }>();
const emit = defineEmits<{ close: [] }>();

const notes = ref<KnowledgeNote[] | null>(null);
const problem = ref<string | null>(null);
const opened = ref<OpenedNote | null>(null);
const opening = ref(false);
const dialog = ref<HTMLElement | null>(null);

const privateNotes = computed(() => (notes.value ?? []).filter((note) => note.label === 'L2'));

async function open(note: KnowledgeNote): Promise<void> {
  opening.value = true;
  problem.value = null;
  try {
    opened.value = await readProjectNote(props.project, note.path);
  } catch (cause) {
    problem.value = browseErrorText(cause);
  } finally {
    opening.value = false;
  }
}

function onKey(event: KeyboardEvent): void {
  // Esc closes only the list: the panel has its own Annulla, so a key never drops a text being corrected.
  if (event.key === 'Escape' && opened.value === null) emit('close');
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  dialog.value?.focus();
  try {
    notes.value = (await readProjectKnowledge(props.project)).notes;
  } catch (cause) {
    problem.value = browseErrorText(cause);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="phone-overlay fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" @click.self="opened === null && emit('close')">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="attach-title" tabindex="-1" class="phone-sheet hud-card flex max-h-[90vh] w-full max-w-[1100px] flex-col bg-surface outline-none">
      <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <Icon name="gateway" :size="16" class="text-muted" />
        <h2 id="attach-title" class="min-w-0 flex-1 truncate font-medium">{{ opened === null ? `Allega una nota privata di ${project}` : opened.title }}</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="min-h-0 overflow-y-auto overscroll-contain">
        <NoteRelease
          v-if="opened"
          :project="project"
          :path="opened.path"
          :original="opened.body"
          :version="opened.version"
          :conversation="conversation"
          @close="opened = null"
          @released="emit('close')"
        />
        <div v-else class="flex flex-col gap-2 px-[15px] py-3 text-[14.5px]">
          <p class="text-muted">Le note Private di {{ project }} non arrivano mai in chat da sole. Scegline una: ne fai una versione senza nomi né importi e, con la master password, la mandi qui una volta, come messaggio Interno.</p>
          <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
          <p v-else-if="notes === null" class="text-muted">Leggo le note del progetto…</p>
          <p v-else-if="privateNotes.length === 0" class="text-muted">Il progetto non ha note Private. Le note Interne il Coder le legge già da solo.</p>
          <ul v-else class="flex flex-col divide-y divide-line rounded-lg border border-line">
            <li v-for="note in privateNotes" :key="note.path">
              <button type="button" class="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-surface-2" :disabled="opening" @click="open(note)">
                <span class="min-w-0 flex-1 truncate text-ink">{{ note.title }}</span>
                <span class="shrink-0 font-mono text-[12.5px] text-muted">{{ note.path }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

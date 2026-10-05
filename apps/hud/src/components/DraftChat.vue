<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

import type { Draft } from '../lib/draft.ts';
import { MODE_HINT, MODE_TEXT } from '../lib/labels.ts';
import type { CharacterChoice } from '../lib/types.ts';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

/**
 * A new conversation before its first message (D-108): an empty chat and the
 * field ready. Nothing exists in the core until "Invia"; the text stays in
 * the field until the message is in.
 */
const props = defineProps<{
  draft: Draft;
  /** Why the project of a work draft cannot be used, said before the first message. */
  projectProblem?: string | undefined;
  sending: boolean;
  send: (text: string) => Promise<boolean>;
  arianna: CharacterChoice | undefined;
}>();

const text = ref('');
const field = ref<HTMLTextAreaElement | null>(null);

function grow(): void {
  const element = field.value;
  if (element === null) return;
  element.style.height = 'auto';
  element.style.height = `${String(element.scrollHeight)}px`;
}

async function submit(): Promise<void> {
  if (props.sending || text.value.trim() === '') return;
  if (await props.send(text.value)) {
    text.value = '';
    await nextTick();
    grow();
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

onMounted(() => field.value?.focus());
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-1 items-center justify-center overflow-y-auto p-8 text-center">
      <div class="flex max-w-sm flex-col items-center gap-4">
        <PixelAgent :choice="arianna" pose="idle" :scale="3" bubble label="Arianna" />
        <h2 class="font-hud text-lg font-semibold tracking-[0.05em]">
          Nuova conversazione {{ draft.mode === 'private' ? 'privata' : 'di lavoro' }}
        </h2>
        <p class="inline-flex items-center gap-1.5 text-sm text-muted">
          <Icon :name="draft.mode" :size="14" />{{ MODE_TEXT[draft.mode] }}<template v-if="draft.project"> · {{ draft.project }}</template>
        </p>
        <p class="text-sm text-muted">{{ MODE_HINT[draft.mode] }}</p>
        <p class="text-xs text-muted">La conversazione nasce con il primo messaggio.</p>
        <p v-if="projectProblem !== undefined" role="alert" class="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-left text-sm text-warn">{{ projectProblem }}</p>
      </div>
    </div>
    <div class="shrink-0 border-t border-line px-4 pt-3 pb-4 md:px-5.5">
      <p class="mb-1.5 min-h-4 px-1 font-mono text-[10.5px] text-muted" role="status" aria-live="polite">{{ sending ? 'Creo la conversazione…' : '' }}</p>
      <form :aria-busy="sending" class="flex items-end gap-2.5 rounded-[22px] border border-line-strong bg-surface py-2 pr-2 pl-4" @submit.prevent="submit">
        <label for="composer" class="sr-only">Primo messaggio</label>
        <textarea
          id="composer"
          ref="field"
          v-model="text"
          rows="1"
          maxlength="16000"
          placeholder="Scrivi ad Arianna…"
          class="max-h-48 min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-ink outline-none placeholder:text-muted"
          @keydown="onKey"
          @input="grow"
        />
        <button
          type="submit"
          :disabled="sending || text.trim() === ''"
          class="grid size-[38px] shrink-0 place-items-center rounded-full bg-accent text-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Invia"
        >
          <Icon name="send" />
        </button>
      </form>
    </div>
  </div>
</template>

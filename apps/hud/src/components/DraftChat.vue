<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

import { goesToArianna } from '../lib/commands.ts';
import { coderWarning, firstMessageProblem, longMessageStep, type Draft } from '../lib/draft.ts';
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
  /** The Coder's character, for the direct chat (D-111). */
  coder?: CharacterChoice | undefined;
}>();

/** A long first message of the direct chat waits for "Invia comunque" (D-111). */
const confirmLong = ref(false);

const text = ref('');
watch(text, () => {
  confirmLong.value = false;
});
const field = ref<HTMLTextAreaElement | null>(null);

function grow(): void {
  const element = field.value;
  if (element === null) return;
  element.style.height = 'auto';
  element.style.height = `${String(element.scrollHeight)}px`;
}

const confirmButton = ref<HTMLButtonElement | null>(null);

/** `confirmed`: only from "Invia comunque" (D-111). */
async function submit(confirmed = false): Promise<void> {
  if (props.sending || text.value.trim() === '') return;
  // A first message the store refuses anyway never asks.
  const goes = firstMessageProblem(text.value, goesToArianna, props.draft.agent) === undefined;
  const step = longMessageStep(props.draft.agent, text.value, goes, { asking: confirmLong.value, confirmed });
  if (step === 'wait') return;
  if (step === 'ask') {
    confirmLong.value = true;
    await nextTick();
    confirmButton.value?.focus();
    return;
  }
  confirmLong.value = false;
  if (await props.send(text.value)) {
    text.value = '';
    await nextTick();
    grow();
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    // A held key never sends again.
    if (!event.repeat) void submit();
  }
}

onMounted(() => field.value?.focus());
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-1 items-center justify-center overflow-y-auto p-8 text-center">
      <div class="flex max-w-sm flex-col items-center gap-4">
        <template v-if="draft.agent === 'coder'">
          <PixelAgent :choice="coder" pose="idle" :scale="3" bubble label="Coder" />
          <h2 class="font-hud text-lg font-semibold tracking-[0.05em]">Con il Coder</h2>
          <p class="inline-flex items-center gap-1.5 text-sm text-muted"><Icon name="coder" :size="14" />Claude Code · {{ draft.project }}</p>
          <p role="note" class="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-left text-sm text-warn">{{ coderWarning(draft.project) }}</p>
        </template>
        <template v-else>
          <PixelAgent :choice="arianna" pose="idle" :scale="3" bubble label="Arianna" />
          <h2 class="font-hud text-lg font-semibold tracking-[0.05em]">
            Nuova conversazione {{ draft.mode === 'private' ? 'privata' : 'di lavoro' }}
          </h2>
          <p class="inline-flex items-center gap-1.5 text-sm text-muted">
            <Icon :name="draft.mode" :size="14" />{{ MODE_TEXT[draft.mode] }}<template v-if="draft.project"> · {{ draft.project }}</template>
          </p>
          <p class="text-sm text-muted">{{ MODE_HINT[draft.mode] }}</p>
        </template>
        <p class="text-xs text-muted">La conversazione nasce con il primo messaggio.</p>
        <p v-if="projectProblem !== undefined" role="alert" class="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-left text-sm text-warn">{{ projectProblem }}</p>
      </div>
    </div>
    <div class="shrink-0 border-t border-line px-4 pt-3 pb-4 md:px-5.5">
      <p class="mb-1.5 min-h-4 px-1 font-mono text-[10.5px] text-muted" role="status" aria-live="polite">{{ sending ? 'Creo la conversazione…' : '' }}</p>
      <div v-if="confirmLong" role="alert" class="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-[13px] text-warn">
        <span class="min-w-0 flex-1">Va davvero a Claude? Il messaggio è lungo ({{ text.length }} caratteri) e parte così com'è: lo scanner non riconosce i dati personali scritti in prosa.</span>
        <button ref="confirmButton" type="button" class="btn px-2.5 py-1 text-xs" @click="submit(true)">Invia comunque</button>
        <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink" @click="confirmLong = false">Annulla</button>
      </div>
      <form :aria-busy="sending" class="flex items-end gap-2.5 rounded-[22px] border border-line-strong bg-surface py-2 pr-2 pl-4" @submit.prevent="submit()">
        <label for="composer" class="sr-only">Primo messaggio</label>
        <textarea
          id="composer"
          ref="field"
          v-model="text"
          rows="1"
          maxlength="16000"
          :placeholder="draft.agent === 'coder' ? 'Scrivi al Coder…' : 'Scrivi ad Arianna…'"
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

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { ApiError, pinTile, suggestTile } from '../lib/api.ts';
import {
  dashboardErrorText,
  PIN_CONFIRM,
  PIN_DIALOG_TITLE,
  PIN_FALLBACK,
  PIN_LABEL_NOTE,
  PIN_QUESTION_HINT,
  PIN_QUESTION_LABEL,
  PIN_SUGGESTING,
  PIN_TITLE_LABEL,
  PIN_WIDTH_LABEL,
  WIDTH_TEXT,
  type DashboardTile,
  type TileWidth,
} from '../lib/dashboard.ts';
import type { Label } from '../lib/types.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * «Fissa al Cruscotto» (D-248): the title, the question «Aggiorna» will ask
 * again (rewritten complete by the local model, the user's answer 2; checked
 * and corrected here), the width, and the label of the answer, shown and not
 * changed. The core takes text and label from the message, never from here.
 */
const props = defineProps<{ messageId: string; label: Label }>();
const emit = defineEmits<{ pinned: [tile: DashboardTile]; cancel: [] }>();

const INPUT = 'field w-full px-2.5 py-1.5 text-[14px] text-ink disabled:opacity-60';
const WIDTHS: readonly TileWidth[] = ['narrow', 'wide'];

const title = ref('');
const question = ref('');
const width = ref<TileWidth>('narrow');
const tileLabel = ref<Label>(props.label);
const suggesting = ref(true);
const fallback = ref(false);
const busy = ref(false);
const problem = ref<string | null>(null);

onMounted(async () => {
  try {
    const suggestion = await suggestTile(props.messageId);
    title.value = suggestion.title;
    question.value = suggestion.question;
    tileLabel.value = suggestion.label;
    fallback.value = suggestion.fallback;
  } catch (error) {
    fallback.value = true;
    problem.value = error instanceof ApiError ? dashboardErrorText(error.status, 'Non riesco a proporre la domanda: scrivila tu.') : 'Non riesco a proporre la domanda: scrivila tu.';
  } finally {
    suggesting.value = false;
  }
});

const ready = computed(() => !suggesting.value && title.value.trim() !== '' && question.value.trim() !== '');

async function confirm(): Promise<void> {
  if (!ready.value || busy.value) return;
  busy.value = true;
  problem.value = null;
  try {
    emit('pinned', await pinTile(props.messageId, title.value.trim(), question.value.trim(), width.value));
  } catch (error) {
    problem.value = error instanceof ApiError ? dashboardErrorText(error.status, error.message) : 'Non sono riuscita a fissarla.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ConfirmDialog :title="PIN_DIALOG_TITLE" :confirm-text="PIN_CONFIRM" :busy="busy" :problem="problem" :disabled="!ready" @confirm="confirm" @cancel="emit('cancel')">
    <p v-if="suggesting" class="text-[13px] text-muted" role="status">{{ PIN_SUGGESTING }}</p>
    <label class="flex flex-col gap-1 text-[13px] text-muted">
      {{ PIN_TITLE_LABEL }}
      <input v-model="title" :class="INPUT" maxlength="80" :disabled="suggesting || busy" />
    </label>
    <label class="flex flex-col gap-1 text-[13px] text-muted">
      {{ PIN_QUESTION_LABEL }}
      <textarea v-model="question" rows="3" :class="INPUT" maxlength="2000" :disabled="suggesting || busy" />
    </label>
    <p class="-mt-1 text-[12.5px] text-muted">{{ PIN_QUESTION_HINT }}</p>
    <p v-if="fallback && !suggesting" class="text-[12.5px] text-warn">{{ PIN_FALLBACK }}</p>
    <div class="flex flex-wrap items-center gap-2 text-[13px] text-muted">
      {{ PIN_WIDTH_LABEL }}
      <span class="inline-flex overflow-hidden rounded-full border border-line-strong" role="group" :aria-label="PIN_WIDTH_LABEL">
        <button
          v-for="choice in WIDTHS"
          :key="choice"
          type="button"
          class="px-3 py-0.5 text-[13px]"
          :class="width === choice ? 'bg-accent text-accent-ink' : 'text-ink'"
          :aria-pressed="width === choice"
          @click="width = choice"
        >{{ WIDTH_TEXT[choice] }}</button>
      </span>
    </div>
    <div class="flex flex-wrap items-center gap-2 text-[13px] text-muted">
      <LabelBadge :label="tileLabel" /><span>{{ PIN_LABEL_NOTE }}</span>
    </div>
  </ConfirmDialog>
</template>

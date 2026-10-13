<script setup lang="ts">
import { LABEL_CLASS, LABEL_LEGEND, LABEL_TEXT } from '../lib/labels.ts';
import type { Label } from '../lib/types.ts';

/**
 * A label as the user reads it: a coloured dot and its word (Pubblico, Interno, Privato, Segreto); the meaning on hover.
 * `dot` (D-150): only the coloured dot, where the room is short (the list of conversations on a laptop); the word stays
 * in the title and for screen readers.
 */
const props = defineProps<{ label: Label; dot?: boolean }>();
const meaning = (label: Label): string => LABEL_LEGEND.find((entry) => entry.label === label)?.meaning ?? '';
</script>

<template>
  <span v-if="props.dot" class="inline-grid size-4 shrink-0 place-items-center" :class="LABEL_CLASS[props.label]" :title="`${LABEL_TEXT[props.label]}: ${meaning(props.label)}`">
    <i class="size-2 rounded-full bg-current" aria-hidden="true" /><span class="sr-only">{{ LABEL_TEXT[props.label] }}: {{ meaning(props.label) }}</span>
  </span>
  <span v-else class="lab inline-flex items-center gap-1" :class="LABEL_CLASS[props.label]" :title="`${LABEL_TEXT[props.label]}: ${meaning(props.label)}`">
    <i class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />{{ LABEL_TEXT[props.label] }}<span class="sr-only">: {{ meaning(props.label) }}</span>
  </span>
</template>

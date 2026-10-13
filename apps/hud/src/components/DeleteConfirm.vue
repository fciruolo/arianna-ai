<script setup lang="ts">
import { ERASE_QUESTION } from '../lib/erase.ts';
import Icon from './Icon.vue';

/**
 * The confirmation of "Elimina" for good (D-157), in place of what is being
 * deleted: the question, what goes and stays, and the two buttons.
 */
withDefaults(defineProps<{ text: string; subject?: string | null; extra?: string | null; busy?: boolean }>(), { subject: null, extra: null, busy: false });
const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <div class="flex flex-col gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm" role="group" aria-label="Conferma dell'eliminazione definitiva">
    <p class="font-medium">
      {{ ERASE_QUESTION }}<template v-if="subject !== null">{{ ' ' }}<span class="break-words text-muted">“{{ subject }}”</span></template>
    </p>
    <p class="text-xs leading-snug text-muted">{{ text }}</p>
    <p v-if="extra !== null" class="text-xs leading-snug text-warn">{{ extra }}</p>
    <div class="flex gap-2">
      <button type="button" class="btn btn-danger px-2 py-1 text-xs" :disabled="busy" @click="emit('confirm')"><Icon name="delete" :size="14" />Elimina per sempre</button>
      <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink" :disabled="busy" @click="emit('cancel')">Annulla</button>
    </div>
  </div>
</template>

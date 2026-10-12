<script setup lang="ts">
import { computed } from 'vue';

import { unsavedText } from '../lib/settings-index.ts';

/**
 * The one save bar of a section of the settings (D-192): it appears only when
 * something changed, is saving, was just saved or failed. In a section that
 * lets data out it is amber and its button is «Rivedi cosa esce…», which opens
 * the confirmation of the exits (PrivacyConfirm): nothing is written before it.
 */
const props = defineProps<{
  /** Something differs from what was read. */
  dirty: boolean;
  /** How many parts changed; the text says «N modifiche non salvate». */
  count?: number;
  /** Another text for the edits, instead of the count. */
  label?: string;
  privacy?: boolean;
  busy?: boolean;
  /** Saved a moment ago. */
  saved?: boolean;
  error?: string | null | undefined;
  /** Why it cannot be saved as it is. */
  invalid?: string | undefined;
}>();
const emit = defineEmits<{ cancel: []; save: [] }>();

const shown = computed(() => props.dirty || props.busy === true || props.saved === true || (props.error ?? null) !== null);
const text = computed(() => {
  if (props.error) return props.error;
  if (props.busy) return props.privacy ? 'Preparo le uscite…' : 'Salvo…';
  if (props.dirty && props.invalid !== undefined) return props.invalid;
  if (props.dirty) return props.label ?? unsavedText(props.count ?? 1);
  return props.privacy ? 'Confermato e salvato' : 'Salvato';
});
</script>

<template>
  <div
    v-if="shown"
    class="sticky bottom-4 z-10 flex flex-wrap items-center gap-2.5 rounded-xl border bg-surface-2 py-2.5 pr-3 pl-4 text-[14px] shadow-[0_10px_30px_#0003]"
    :class="error ? 'border-danger' : privacy ? 'border-warn' : 'border-accent'"
    role="status"
  >
    <span class="min-w-0 flex-1" :class="error || (dirty && invalid !== undefined) ? 'text-danger' : !dirty ? 'text-ok' : ''" :role="error ? 'alert' : undefined">{{ text }}</span>
    <template v-if="dirty">
      <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="busy" @click="emit('cancel')">Annulla</button>
      <button type="button" class="btn px-3 py-1.5 text-[14px] font-semibold" :class="privacy ? 'btn-warn' : 'btn-primary'" :disabled="busy || invalid !== undefined" @click="emit('save')">
        {{ privacy ? 'Rivedi cosa esce…' : error ? 'Riprova' : 'Salva' }}
      </button>
    </template>
  </div>
</template>

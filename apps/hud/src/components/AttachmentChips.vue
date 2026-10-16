<script setup lang="ts">
/**
 * The attachments in the field of a chat, before the message leaves (D-247):
 * a small preview of each image, the name of each text file, «×» to take one
 * away. Privato: they go only to the model on the Mac.
 */
import type { FieldAttachment } from '../lib/attachment-field.ts';
import Icon from './Icon.vue';

defineProps<{ items: readonly FieldAttachment[] }>();
const emit = defineEmits<{ remove: [key: string] }>();
</script>

<template>
  <ul v-if="items.length > 0" class="flex flex-wrap gap-2 px-1 pb-2" aria-label="Allegati del messaggio">
    <li
      v-for="item in items"
      :key="item.key"
      class="relative flex h-14 max-w-[220px] items-center gap-2 rounded-lg border border-line bg-surface-2 pr-7 pl-1 text-[13px] text-ink"
      :aria-busy="item.info === null"
    >
      <img v-if="item.kind === 'image' && item.preview !== null" :src="item.preview" alt="" class="size-12 shrink-0 rounded-md object-cover" />
      <span v-else class="grid size-12 shrink-0 place-items-center rounded-md bg-surface text-muted"><Icon name="file" :size="18" /></span>
      <span class="min-w-0">
        <span class="block truncate" :title="item.name">{{ item.name }}</span>
        <span class="block font-mono text-[11px] text-muted">{{ item.info === null ? 'carico…' : 'Privato · solo sul Mac' }}</span>
      </span>
      <button
        type="button"
        class="absolute top-1 right-1 grid size-5 place-items-center rounded-full text-muted hover:bg-surface hover:text-ink"
        :aria-label="`Togli ${item.name}`"
        @click="emit('remove', item.key)"
      >
        <Icon name="close" :size="12" />
      </button>
    </li>
  </ul>
</template>

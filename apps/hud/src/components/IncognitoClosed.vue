<script setup lang="ts">
import { onMounted, ref } from 'vue';

import Icon from './Icon.vue';

/**
 * In place of an incognito conversation that closed (D-136): after "Termina",
 * what the core deleted and what stays outside, with its real counts; else why
 * it closed. The page holds none of its texts any more.
 */
defineProps<{ end: { kind: 'ended'; lines: string[] } | { kind: 'closed'; text: string } }>();
const emit = defineEmits<{ back: [] }>();

const button = ref<HTMLButtonElement | null>(null);
onMounted(() => button.value?.focus());
</script>

<template>
  <div class="flex flex-1 items-center justify-center overflow-y-auto p-8">
    <section class="flex w-full max-w-md flex-col gap-3 rounded-[14px] border border-incognito-line bg-incognito px-5 py-4.5 text-incognito-ink" role="status" aria-labelledby="incognito-closed-title">
      <h2 id="incognito-closed-title" class="flex items-center gap-2 font-hud text-lg font-semibold tracking-[0.05em]">
        <Icon name="incognito" :size="20" />{{ end.kind === 'ended' ? 'Conversazione incognita terminata' : 'Conversazione incognita chiusa' }}
      </h2>
      <ul v-if="end.kind === 'ended'" class="flex list-disc flex-col gap-1.5 pl-4.5 text-[13.5px] leading-snug">
        <li v-for="line in end.lines" :key="line" class="break-words">{{ line }}</li>
      </ul>
      <p v-else class="text-[13.5px] leading-snug">{{ end.text }}</p>
      <button ref="button" type="button" class="btn self-end px-3 py-1.5 text-sm" @click="emit('back')">Torna alla lista</button>
    </section>
  </div>
</template>

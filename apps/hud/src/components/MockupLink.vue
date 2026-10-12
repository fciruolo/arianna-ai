<script setup lang="ts">
import { computed } from 'vue';

import { studioPathFor } from '../lib/studio.ts';
import Icon from './Icon.vue';

/**
 * A mockup a delegation wrote (I-19, D-184, tappa O1): its name and "Apri
 * nello Studio", which goes to the page with that project and file. No
 * preview in the chat: at the width of a message it read badly (the user's
 * choice after the trial).
 */
const props = defineProps<{ path: string; project: string }>();

const name = computed(() => props.path.split('/').at(-1) ?? props.path);
const href = computed(() => studioPathFor({ project: props.project, file: props.path }));

/** Inside the page: the address changes and the app follows it, as with "back". */
function openStudio(event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  window.history.pushState(null, '', href.value);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
</script>

<template>
  <p class="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
    <Icon name="studio" :size="14" />
    <span class="truncate font-mono text-[11.5px]">{{ name }}</span>
    <a class="ml-auto shrink-0 font-medium text-accent hover:underline" :href="href" @click="openStudio">Apri nello Studio</a>
  </p>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { loadIncognitoNotice } from '../lib/api.ts';
import { assumedNotice, noticeLines, type IncognitoNotice } from '../lib/incognito.ts';
import type { ConversationMode } from '../lib/types.ts';
import Icon from './Icon.vue';

/**
 * "Cosa resta fuori da Arianna" (D-136): before the first message of an
 * incognito conversation and in the confirmation of "Termina". The core says
 * only whether anything reaches the cloud and the project; the texts are the
 * page's. Until it answers (or if it cannot), a work conversation is taken as
 * one that reaches Claude: the card never says less than true.
 */
const props = defineProps<{ mode: ConversationMode; project?: string | undefined }>();

const notice = ref<IncognitoNotice | undefined>(undefined);
watch(
  () => [props.mode, props.project] as const,
  async ([mode, project]) => {
    notice.value = undefined;
    const read = await loadIncognitoNotice(mode, project).catch(() => undefined);
    if (mode === props.mode && project === props.project) notice.value = read;
  },
  { immediate: true },
);
const lines = computed(() => noticeLines(notice.value ?? assumedNotice(props.mode, props.project)));
</script>

<template>
  <section class="rounded-lg border border-incognito-line bg-incognito px-3.5 py-3 text-left text-[13px] leading-snug text-incognito-ink" aria-labelledby="incognito-notice-title">
    <h3 id="incognito-notice-title" class="mb-1.5 flex items-center gap-2 font-medium"><Icon name="incognito" :size="15" />Cosa resta fuori da Arianna</h3>
    <ul class="flex list-disc flex-col gap-1 pl-4.5 opacity-90">
      <li v-for="line in lines" :key="line">{{ line }}</li>
    </ul>
  </section>
</template>

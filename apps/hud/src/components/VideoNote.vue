<script setup lang="ts">
import { computed } from 'vue';

import { plainLine, videoAt, videoSections } from '../lib/video.ts';
import MarkdownText from './MarkdownText.vue';

/**
 * The note of a YouTube video (D-273, tappa A), as the core wrote it: the
 * minutes of the points, the chapters and the transcript open that second of
 * the video on YouTube in a new tab; the transcript stays closed until asked.
 */
const props = defineProps<{
  body: string;
  videoId: string;
  wikilink: (target: string) => void;
}>();

const sections = computed(() => videoSections(props.body));
</script>

<template>
  <div class="flex flex-col gap-3">
    <template v-for="(section, index) in sections" :key="index">
      <div v-if="section.kind === 'text'">
        <MarkdownText :source="section.heading === null ? section.text : `## ${section.heading}\n\n${section.text}`" :wikilink="wikilink" />
      </div>
      <section v-else-if="section.kind === 'timed'" class="md">
        <h2>{{ section.heading }}</h2>
        <ul class="flex list-none flex-col gap-1.5 pl-0">
          <li v-for="(line, row) in section.lines" :key="row" class="flex items-baseline gap-2">
            <a
              :href="videoAt(videoId, line.at)"
              target="_blank"
              rel="noopener noreferrer nofollow"
              referrerpolicy="no-referrer"
              class="shrink-0 font-mono text-[12.5px] text-accent tabular-nums hover:underline"
              :title="`Apri il video a ${line.clock} su YouTube`"
              >{{ line.clock }}</a
            >
            <span class="min-w-0 break-words">{{ plainLine(line.text) }}</span>
          </li>
        </ul>
        <p v-if="section.rest !== ''" class="text-[13px] text-muted">{{ section.rest }}</p>
      </section>
      <details v-else class="rounded-lg border border-line bg-surface-2 text-[13.5px]">
        <summary class="cursor-pointer px-3 py-2 font-semibold">Trascrizione ({{ section.lines.length }} parti)</summary>
        <ol class="flex max-h-[420px] list-none flex-col gap-1 overflow-y-auto px-3 pb-3">
          <li v-for="(line, row) in section.lines" :key="row" class="flex items-baseline gap-2">
            <a
              :href="videoAt(videoId, line.at)"
              target="_blank"
              rel="noopener noreferrer nofollow"
              referrerpolicy="no-referrer"
              class="shrink-0 font-mono text-[12px] text-accent tabular-nums hover:underline"
              >{{ line.clock }}</a
            >
            <span class="min-w-0 break-words text-ink/85">{{ plainLine(line.text) }}</span>
          </li>
        </ol>
        <p v-if="section.note !== null" class="px-3 pb-3 text-[13px] text-muted">{{ section.note }}</p>
      </details>
    </template>
  </div>
</template>

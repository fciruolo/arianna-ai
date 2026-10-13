<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { readMockup, studioFrame } from '../lib/api.ts';
import type { Mockup } from '../lib/studio.ts';
import { buildSrcdoc } from '../lib/studio-frame.ts';
import { THUMB_PAGE, thumbScale } from '../lib/studio-overview.ts';

/**
 * A thumbnail of a mockup on a card of the Studio without a project (D-194):
 * the same isolated frame as the Studio (the document built with the policy
 * that forbids the network, served back by the core under a token,
 * `sandbox="allow-scripts"`, never `allow-same-origin`), drawn as a desktop
 * page and scaled down. Read only once the card comes into view; it takes no
 * clicks nor focus. When it cannot be had, a neutral box.
 */
const props = defineProps<{ project: string; file: Mockup }>();

const box = ref<HTMLElement | null>(null);
const width = ref(0);
const src = ref<string | undefined>(undefined);
const failed = ref(false);
const scale = computed(() => thumbScale(width.value));

let seen: IntersectionObserver | undefined;
let sized: ResizeObserver | undefined;
let gone = false;

async function load(): Promise<void> {
  try {
    const text = await readMockup(props.project, props.file.path);
    const url = await studioFrame(buildSrcdoc(text.text, 'plain'));
    if (!gone) src.value = url;
  } catch {
    if (!gone) failed.value = true;
  }
}

onMounted(() => {
  const element = box.value;
  if (element === null) return;
  sized = new ResizeObserver(() => {
    width.value = element.clientWidth;
  });
  sized.observe(element);
  seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen?.disconnect();
      void load();
    },
    { rootMargin: '200px' },
  );
  seen.observe(element);
});

onBeforeUnmount(() => {
  gone = true;
  seen?.disconnect();
  sized?.disconnect();
});
</script>

<template>
  <div ref="box" class="relative aspect-[4/3] overflow-hidden rounded border border-line bg-surface-2" aria-hidden="true" inert>
    <div
      v-if="src !== undefined && !failed && scale > 0"
      class="pointer-events-none absolute top-0 left-0 origin-top-left"
      :style="{ width: `${String(THUMB_PAGE.width)}px`, height: `${String(THUMB_PAGE.height)}px`, transform: `scale(${String(scale)})` }"
    >
      <iframe class="block size-full border-0 bg-white" sandbox="allow-scripts" referrerpolicy="no-referrer" tabindex="-1" :title="file.name" :src="src" />
    </div>
  </div>
</template>

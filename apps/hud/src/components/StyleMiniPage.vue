<script setup lang="ts">
import { computed } from 'vue';

import { fontStack, type StyleSample } from '../lib/studio.ts';

/**
 * The same small page in the colors, fonts and corners of a style (I-20,
 * D-185): band, title, button, text, a card and the palette, so two styles
 * side by side show their difference. Values come checked from the core and
 * are set as properties (CSSOM), never as CSS text.
 */
const props = defineProps<{ sample: StyleSample }>();

const display = computed(() => fontStack(props.sample.displayFont));
const body = computed(() => fontStack(props.sample.bodyFont));
const radius = computed(() => `${String(Math.min(props.sample.radius, 999))}px`);
/** The button on the band: its text is the accent's when it is the accent, else the band's own color. */
const heroButtonText = computed(() => (props.sample.heroAction === props.sample.accent ? props.sample.accentText : props.sample.hero));
const swatches = computed(() => props.sample.palette.slice(0, 8));
</script>

<template>
  <div class="overflow-hidden rounded-md border border-line text-left select-none" aria-hidden="true">
    <div class="flex flex-col gap-1.5 px-3 py-2.5" :style="{ backgroundColor: sample.hero, color: sample.heroText, fontFamily: display }">
      <span class="truncate text-[15px] leading-tight" :style="{ fontWeight: sample.titleWeight }">Titolo di prova</span>
      <span class="w-fit px-2.5 py-0.5 text-[12px]" :style="{ backgroundColor: sample.heroAction, color: heroButtonText, borderRadius: radius, fontFamily: body }">Scopri</span>
    </div>
    <div class="flex items-stretch gap-2 px-3 py-2" :style="{ backgroundColor: sample.background, color: sample.text, fontFamily: body }">
      <p class="min-w-0 flex-1 text-[12px] leading-snug">
        Testo della pagina con un <span :style="{ color: sample.accent, textDecoration: 'underline' }">collegamento</span>.
      </p>
      <span class="grid w-14 shrink-0 place-items-center border text-[9px]" :style="{ borderColor: sample.text, borderRadius: radius === '999px' ? '10px' : radius, opacity: 0.85 }">scheda</span>
    </div>
    <div class="flex h-2.5">
      <span v-for="color in swatches" :key="color.hex" class="flex-1" :style="{ backgroundColor: color.hex }" />
    </div>
  </div>
</template>

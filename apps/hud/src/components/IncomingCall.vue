<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

import { RING_TEXT, type Callee } from '../lib/calls.ts';
import type { CharacterChoice } from '../lib/types.ts';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

/**
 * "Arianna ti chiama" (D-066, choice 3): a call of Arianna, or of the agent
 * of a direct chat (D-158), ringing in the chat, with the reason, Rispondi
 * and Rifiuta. The ring is made here with the
 * Web Audio API: no sound file, nothing fetched.
 */
const props = defineProps<{ reason: 'waiting' | 'task-done' | 'scheduled'; title: string; callee: Callee; choice: CharacterChoice | undefined }>();
const emit = defineEmits<{ answer: []; decline: [] }>();

let context: AudioContext | undefined;
let ring: number | undefined;

function beep(): void {
  if (context === undefined) return;
  const now = context.currentTime;
  for (const [at, frequency] of [[0, 660], [0.25, 880]] as const) {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.15, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
    tone.connect(gain).connect(context.destination);
    tone.start(now + at);
    tone.stop(now + at + 0.25);
  }
}

onMounted(() => {
  try {
    context = new AudioContext();
    // Without a recent click the browser may keep it silent: the screen still shows.
    void context.resume().catch(() => undefined);
    beep();
    ring = window.setInterval(beep, 2000);
  } catch {
    context = undefined;
  }
});

onBeforeUnmount(() => {
  window.clearInterval(ring);
  void context?.close();
});
</script>

<template>
  <div class="fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-teal-700 via-teal-900 to-[#06201f] px-6 py-14 text-white" role="alertdialog" :aria-label="`${props.callee.subject} ti chiama`">
    <div class="flex flex-col items-center gap-3 text-center">
      <p class="text-sm tracking-wide text-teal-200 uppercase">Chiamata in arrivo</p>
      <p class="font-hud text-3xl font-semibold tracking-[0.08em]">{{ props.callee.subject }} ti chiama</p>
      <p class="max-w-sm text-white/80">{{ RING_TEXT[props.reason] }}</p>
      <p class="max-w-sm truncate text-sm text-white/60">{{ props.title }}</p>
    </div>
    <div class="animate-call-breathe"><PixelAgent :choice="props.choice" pose="waiting" :scale="5" /></div>
    <footer class="flex items-center gap-14">
      <button type="button" class="flex flex-col items-center gap-2" aria-label="Rifiuta" @click="emit('decline')">
        <span class="grid size-16 place-items-center rounded-full bg-red-600 hover:bg-red-500"><Icon name="phone-off" :size="26" /></span>
        <span class="text-sm">Rifiuta</span>
      </button>
      <button type="button" class="flex flex-col items-center gap-2" aria-label="Rispondi" @click="emit('answer')">
        <span class="grid size-16 place-items-center rounded-full bg-emerald-500 hover:bg-emerald-400"><Icon name="phone" :size="26" /></span>
        <span class="text-sm">Rispondi</span>
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { CallSession } from '../lib/call-session.ts';
import { clock, type Callee } from '../lib/calls.ts';
import type { CharacterChoice, Message } from '../lib/types.ts';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

/**
 * The call screen (D-066, from OpenDots' CallView): Arianna breathing while
 * she speaks, the time, the live captions (the voice messages of the call,
 * which the core stores in the conversation), mute and hang up, and a small
 * version in the corner.
 */
const props = defineProps<{
  session: CallSession;
  title: string;
  messages: readonly Message[];
  /** Who answers (D-158): Arianna, or the agent of the direct chat. */
  callee: Callee;
  choice: CharacterChoice | undefined;
}>();
const emit = defineEmits<{ hangUp: [] }>();

const audio = ref<HTMLAudioElement | null>(null);
const muted = ref(false);
const small = ref(false);
const speaking = ref(false);
const now = ref(Date.now());
let frame: number | undefined;
let tick: number | undefined;

const started = computed(() => Date.parse(props.session.call.answeredAt ?? props.session.call.createdAt));
const elapsed = computed(() => clock((now.value - started.value) / 1000));

/** The last things said in this call, as captions. */
const captions = computed(() =>
  props.messages
    .filter((message) => message.channel === 'voice' && Date.parse(message.ts) >= started.value - 1000)
    .slice(-2)
    .map((message) => ({ id: message.id, who: message.role === 'user' ? 'Tu' : props.callee.name, text: message.body })),
);

function measure(): void {
  speaking.value = props.session.level() > 0.06;
  frame = window.requestAnimationFrame(measure);
}

onMounted(() => {
  if (audio.value !== null) {
    audio.value.srcObject = props.session.remote;
    void audio.value.play().catch(() => undefined);
  }
  frame = window.requestAnimationFrame(measure);
  tick = window.setInterval(() => {
    now.value = Date.now();
  }, 500);
});

watch(muted, (value) => {
  props.session.setMuted(value);
});

onBeforeUnmount(() => {
  if (frame !== undefined) window.cancelAnimationFrame(frame);
  window.clearInterval(tick);
});
</script>

<template>
  <div
    :class="
      small
        ? 'fixed right-4 bottom-4 z-50 flex w-[280px] items-center gap-3 rounded-2xl bg-gradient-to-br from-teal-700 to-teal-950 p-3 text-white shadow-2xl'
        : 'fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-teal-700 via-teal-900 to-[#06201f] px-6 py-10 text-white'
    "
    role="dialog"
    :aria-label="`Chiamata con ${callee.the}`"
  >
    <audio ref="audio" autoplay class="hidden" />

    <template v-if="!small">
      <header class="flex w-full max-w-md items-center justify-between">
        <span class="truncate text-sm text-white/70">{{ title }}</span>
        <button type="button" class="rounded-md px-2 py-1 text-sm text-white/80 hover:bg-white/10" @click="small = true">Riduci</button>
      </header>
      <div class="flex flex-col items-center gap-5">
        <div class="transition-transform duration-300" :class="speaking ? 'animate-call-breathe' : ''">
          <PixelAgent :choice="choice" :pose="speaking ? 'working' : 'idle'" :scale="5" />
        </div>
        <p class="font-hud text-2xl font-semibold tracking-[0.08em]">{{ callee.name }}</p>
        <p class="font-mono text-lg text-white/80" aria-live="off">{{ elapsed }}</p>
      </div>
      <ul class="flex min-h-[96px] w-full max-w-md flex-col gap-2" aria-live="polite">
        <li v-for="line in captions" :key="line.id" class="rounded-xl bg-white/10 px-3 py-2 text-[15px] leading-snug">
          <span class="mr-1.5 text-xs font-semibold tracking-wide text-teal-200 uppercase">{{ line.who }}</span>{{ line.text }}
        </li>
        <li v-if="captions.length === 0" class="text-center text-sm text-white/60">Parla pure: {{ callee.the }} ti sente.</li>
      </ul>
      <footer class="flex items-center gap-8">
        <button
          type="button"
          class="grid size-16 place-items-center rounded-full"
          :class="muted ? 'bg-white text-teal-900' : 'bg-white/15 hover:bg-white/25'"
          :aria-pressed="muted"
          :aria-label="muted ? 'Riattiva il microfono' : 'Muto'"
          @click="muted = !muted"
        >
          <Icon :name="muted ? 'mic-off' : 'mic'" :size="26" />
        </button>
        <button type="button" class="grid size-16 place-items-center rounded-full bg-red-600 hover:bg-red-500" aria-label="Chiudi la chiamata" @click="emit('hangUp')">
          <Icon name="phone-off" :size="26" />
        </button>
      </footer>
    </template>

    <template v-else>
      <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label="Ingrandisci la chiamata" @click="small = false">
        <span :class="speaking ? 'animate-call-breathe' : ''"><PixelAgent :choice="choice" :pose="speaking ? 'working' : 'idle'" :scale="1" /></span>
        <span class="min-w-0">
          <span class="block text-sm font-semibold">{{ callee.name }}</span>
          <span class="block font-mono text-xs text-white/75">{{ elapsed }}</span>
        </span>
      </button>
      <button type="button" class="grid size-9 place-items-center rounded-full" :class="muted ? 'bg-white text-teal-900' : 'bg-white/15'" :aria-label="muted ? 'Riattiva il microfono' : 'Muto'" @click="muted = !muted">
        <Icon :name="muted ? 'mic-off' : 'mic'" :size="16" />
      </button>
      <button type="button" class="grid size-9 place-items-center rounded-full bg-red-600" aria-label="Chiudi la chiamata" @click="emit('hangUp')">
        <Icon name="phone-off" :size="16" />
      </button>
    </template>
  </div>
</template>

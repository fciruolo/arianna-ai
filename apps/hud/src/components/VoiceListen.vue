<script setup lang="ts">
/**
 * «Ascolta» next to «Voce di Arianna» (D-192): says LISTEN_PHRASE with the
 * speech model chosen in Modelli and the voice in the field, also before
 * saving. Same route as the voice trial (D-066); nothing new in the core.
 * Disabled, with the reason, while the voice service is not up or a call is on.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { loadVoiceTrial, speakTrial } from '../lib/api.ts';
import { LISTEN_PHRASE, listenBlocker, listenErrorText, serviceSettling } from '../lib/voice-listen.ts';
import Icon from './Icon.vue';

const props = defineProps<{
  /** The speech model of «Parla con la sua voce» (id), as the page holds it. */
  model: string | undefined;
  /** The voice written in the field. */
  voice: string;
  /** A call is starting, ringing or on. */
  callBusy: boolean;
}>();
const emit = defineEmits<{ trial: [] }>();

const service = ref<string | undefined>(undefined);
const models = ref<{ id: string; kind: string; present: boolean; voices: string[] }[]>([]);
const phase = ref<'idle' | 'loading' | 'playing'>('idle');
const error = ref<string | null>(null);
let audio: HTMLAudioElement | null = null;
let url: string | null = null;
let timer = 0;
/** Bumped by each «Ascolta» and «Ferma»: an answer for an older one is dropped. */
let request = 0;

const chosen = computed(() => models.value.find((model) => model.kind === 'tts' && model.id === props.model));
const blocker = computed(() => listenBlocker({ service: service.value, callBusy: props.callBusy, model: chosen.value, voice: props.voice }));

async function refresh(): Promise<void> {
  try {
    const trial = await loadVoiceTrial();
    service.value = trial.state;
    models.value = trial.models;
  } catch {
    service.value = 'down';
  }
  window.clearTimeout(timer);
  // Starting or unknown: ask again in a while, so «Ascolta» turns on by itself.
  if (serviceSettling(service.value) || service.value === 'off') timer = window.setTimeout(() => void refresh(), 5000);
}

function release(): void {
  if (audio !== null) {
    audio.pause();
    audio = null;
  }
  if (url !== null) {
    URL.revokeObjectURL(url);
    url = null;
  }
}

function stop(): void {
  request += 1;
  release();
  phase.value = 'idle';
}

async function listen(): Promise<void> {
  if (blocker.value !== undefined || props.model === undefined || phase.value !== 'idle') return;
  error.value = null;
  phase.value = 'loading';
  const mine = ++request;
  try {
    const { audio: wav } = await speakTrial(LISTEN_PHRASE, props.model, props.voice.trim());
    // «Ferma» or a new choice while it was being prepared: nothing to play.
    if (mine !== request) return;
    release();
    url = URL.createObjectURL(wav);
    audio = new Audio(url);
    audio.addEventListener('ended', stop);
    phase.value = 'playing';
    await audio.play();
  } catch (cause) {
    if (mine !== request) return;
    stop();
    error.value = listenErrorText(cause);
    void refresh();
  }
}

// Another voice or model, or a call: what plays now is no longer what is chosen.
watch(
  () => [props.voice, props.model, props.callBusy],
  () => {
    if (phase.value !== 'idle') stop();
    error.value = null;
  },
);

onMounted(() => void refresh());
onBeforeUnmount(() => {
  window.clearTimeout(timer);
  release();
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-2.5">
    <button v-if="phase === 'playing'" type="button" class="btn px-3 py-1.5 text-[14px]" @click="stop"><Icon name="stop" :size="15" />Ferma</button>
    <button v-else type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="blocker !== undefined || phase === 'loading'" :aria-describedby="blocker !== undefined ? 'voice-listen-why' : undefined" @click="listen">
      <span v-if="phase === 'loading'" class="inline-block size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent motion-reduce:animate-none" aria-hidden="true"></span>
      <Icon v-else name="play" :size="15" />{{ phase === 'loading' ? 'Preparo la voce…' : error !== null ? 'Riprova' : 'Ascolta' }}
    </button>
    <span v-if="phase === 'loading'" class="text-[13px] text-muted">La prima volta il modello si carica: può volerci fino a un minuto.</span>
    <span v-else-if="phase === 'playing'" class="text-[13px] text-muted" role="status">Sta parlando con la voce <b class="font-semibold text-ink">{{ voice.trim() }}</b>…</span>
    <span v-else-if="blocker === undefined && error === null" class="text-[13px] text-muted">«{{ LISTEN_PHRASE }}»</span>
    <button type="button" class="btn ml-auto px-3 py-1.5 text-[14px]" @click="emit('trial')"><Icon name="mic" :size="15" />Provino della voce ›</button>
    <p v-if="blocker !== undefined && phase === 'idle'" id="voice-listen-why" class="m-0 basis-full text-[13px] text-muted">{{ blocker }}</p>
    <p v-if="error !== null" class="m-0 basis-full text-[13px] text-danger" role="alert">{{ error }}</p>
  </div>
</template>

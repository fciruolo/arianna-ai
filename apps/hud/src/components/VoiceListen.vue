<script setup lang="ts">
/**
 * «Ascolta» next to «Voce di Arianna» (D-192): says LISTEN_PHRASE with the
 * speech model chosen in Modelli and the voice in the field, also before
 * saving. Same route as the voice trial (D-066); nothing new in the core.
 * Disabled, with the reason, while the voice service is not up or a call is
 * on. The state is asked again by itself for about a minute while the
 * service starts or is off, then with «Controlla di nuovo».
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { loadVoiceTrial, speakTrial } from '../lib/api.ts';
import { canRecheck, LISTEN_PHRASE, listenBlocker, listenErrorText, shouldPoll } from '../lib/voice-listen.ts';
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
/** Times the state was asked by itself since the last «Controlla di nuovo». */
const attempts = ref(0);
let audio: HTMLAudioElement | null = null;
let url: string | null = null;
let timer = 0;
/** Bumped by each «Ascolta» and «Ferma»: an answer for an older one is dropped. */
let request = 0;

const chosen = computed(() => models.value.find((model) => model.kind === 'tts' && model.id === props.model));
const blocker = computed(() => listenBlocker({ service: service.value, callBusy: props.callBusy, model: chosen.value, voice: props.voice }));
const recheck = computed(() => phase.value === 'idle' && canRecheck(service.value, attempts.value));

async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    const trial = await loadVoiceTrial();
    service.value = trial.state;
    models.value = trial.models;
  } catch {
    service.value = 'down';
  }
  if (shouldPoll(service.value, attempts.value)) {
    timer = window.setTimeout(() => {
      attempts.value += 1;
      void refresh();
    }, 5000);
  }
}

function again(): void {
  attempts.value = 0;
  error.value = null;
  void refresh();
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

/** «Ferma»: stops what plays, or drops the sentence still being prepared. */
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
    // The service may have gone down: its state is asked again, the error stays.
    attempts.value = 0;
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
    <template v-if="phase !== 'idle'">
      <button type="button" class="btn px-3 py-1.5 text-[14px]" @click="stop"><Icon name="stop" :size="15" />Ferma</button>
      <template v-if="phase === 'loading'">
        <span class="inline-block size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent motion-reduce:animate-none" aria-hidden="true"></span>
        <span class="text-[13px] text-muted" role="status">Preparo la voce… La prima volta il modello si carica: può volerci fino a un minuto.</span>
      </template>
      <span v-else class="text-[13px] text-muted" role="status">Sta parlando con la voce <b class="font-semibold text-ink">{{ voice.trim() }}</b>…</span>
    </template>
    <template v-else>
      <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="blocker !== undefined" :aria-describedby="blocker !== undefined ? 'voice-listen-why' : undefined" @click="listen">
        <Icon name="play" :size="15" />{{ error !== null ? 'Riprova' : 'Ascolta' }}
      </button>
      <button v-if="recheck" type="button" class="btn px-3 py-1.5 text-[14px]" @click="again"><Icon name="retry" :size="15" />Controlla di nuovo</button>
      <span v-if="blocker === undefined && error === null" class="text-[13px] text-muted">«{{ LISTEN_PHRASE }}»</span>
    </template>
    <button type="button" class="btn ml-auto px-3 py-1.5 text-[14px]" @click="emit('trial')"><Icon name="mic" :size="15" />Provino della voce ›</button>
    <p v-if="blocker !== undefined && phase === 'idle'" id="voice-listen-why" class="m-0 basis-full text-[13px] text-muted">{{ blocker }}</p>
    <p v-if="error !== null" class="m-0 basis-full text-[13px] text-danger" role="alert">{{ error }}</p>
  </div>
</template>

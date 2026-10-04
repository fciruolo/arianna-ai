<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { ApiError, loadVoiceTrial, speakTrial, transcribeTrial, type TrialTranscript, type VoiceTrial } from '../lib/api.ts';
import { concat, downsample, MAX_SECONDS, MIN_SECONDS, peak, STT_RATE, toBase64, toPcm16 } from '../lib/audio.ts';
import {
  blocker,
  FAMILY_TEXT,
  missingBytes,
  rolesSnippet,
  secondsText,
  sizeText,
  TRIAL_PHRASE,
  TRIAL_REPLY,
  VOICE_TEXT,
} from '../lib/voice-trial.ts';
import Icon from './Icon.vue';

/**
 * The voice trial page (D-066): the user reads a phrase, the speech-to-text
 * candidates write it; then one reply is spoken by each text-to-speech
 * candidate. Everything runs on this machine; nothing is saved.
 */
const trial = ref<VoiceTrial | null>(null);
const problem = ref<string | null>(null);
let poll: number | undefined;

async function refresh(): Promise<void> {
  try {
    trial.value = await loadVoiceTrial();
    problem.value = null;
  } catch (error) {
    problem.value = error instanceof Error ? error.message : 'errore';
  }
}

onMounted(() => {
  void refresh();
  // Until the service is up, its state changes by itself.
  poll = window.setInterval(() => {
    if (trial.value?.state !== 'up') void refresh();
  }, 3000);
});

const stt = computed(() => trial.value?.models.filter((model) => model.kind === 'stt') ?? []);
const tts = computed(() => trial.value?.models.filter((model) => model.kind === 'tts') ?? []);
const notReady = computed(() => (trial.value === null ? undefined : blocker(trial.value.state)));
const missing = computed(() => missingBytes(trial.value?.models ?? []));
const voices = computed(() => tts.value.find((model) => model.family === 'kokoro' && model.present)?.voices ?? []);
const voice = ref<string>('');
// The voice of [voice] when it is on disk, else the first one there.
const chosenVoice = computed(() => {
  if (voices.value.includes(voice.value)) return voice.value;
  const configured = trial.value?.voice;
  return configured !== null && configured !== undefined && voices.value.includes(configured) ? configured : (voices.value[0] ?? '');
});

// Recording.
type RecordState = 'idle' | 'opening' | 'recording' | 'writing';
const recordState = ref<RecordState>('idle');
const elapsed = ref(0);
const transcripts = ref<TrialTranscript[]>([]);
const recordError = ref<string | null>(null);
let stream: MediaStream | undefined;
let context: AudioContext | undefined;
let chunks: Float32Array[] = [];
let timer: number | undefined;

async function startRecording(): Promise<void> {
  if (recordState.value !== 'idle') return;
  recordState.value = 'opening';
  recordError.value = null;
  transcripts.value = [];
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    recordState.value = 'idle';
    recordError.value = 'Il browser non ha dato il microfono: consentilo per questa pagina e riprova.';
    return;
  }
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule('/recorder-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'arianna-recorder');
    chunks = [];
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      chunks.push(event.data);
    };
    source.connect(node);
  } catch {
    release();
    recordState.value = 'idle';
    recordError.value = 'Il browser non riesce a registrare dal microfono (audio worklet non disponibile).';
    return;
  }
  recordState.value = 'recording';
  elapsed.value = 0;
  const started = Date.now();
  timer = window.setInterval(() => {
    elapsed.value = (Date.now() - started) / 1000;
    if (elapsed.value >= MAX_SECONDS) void stopRecording();
  }, 100);
}

function release(): void {
  window.clearInterval(timer);
  for (const track of stream?.getTracks() ?? []) track.stop();
  void context?.close();
  stream = undefined;
  context = undefined;
}

async function stopRecording(): Promise<void> {
  if (recordState.value !== 'recording' || context === undefined) return;
  const rate = context.sampleRate;
  release();
  // The clock stops a little late: never send more than the core accepts.
  const samples = downsample(concat(chunks), rate).subarray(0, MAX_SECONDS * STT_RATE);
  chunks = [];
  const seconds = samples.length / STT_RATE;
  if (seconds < MIN_SECONDS) {
    recordState.value = 'idle';
    recordError.value = 'Registrazione troppo corta: tieni premuto il tempo di leggere la frase.';
    return;
  }
  if (peak(samples) < 0.01) recordError.value = 'Il microfono ha sentito pochissimo: controlla quale è scelto nel sistema.';
  recordState.value = 'writing';
  try {
    transcripts.value = await transcribeTrial(toBase64(toPcm16(samples)));
  } catch (error) {
    recordError.value = error instanceof ApiError ? `Trascrizione non riuscita: ${error.message}` : 'Trascrizione non riuscita.';
  } finally {
    recordState.value = 'idle';
  }
}

// Speaking.
const reply = ref(TRIAL_REPLY);
const speaking = ref<string | null>(null);
const spoken = ref<Record<string, { url: string; seconds: number | undefined }>>({});
const speakError = ref<string | null>(null);

async function speak(model: string): Promise<void> {
  speakError.value = null;
  speaking.value = model;
  try {
    const { audio, seconds } = await speakTrial(reply.value, model, chosenVoice.value);
    const previous = spoken.value[model];
    if (previous !== undefined) URL.revokeObjectURL(previous.url);
    spoken.value = { ...spoken.value, [model]: { url: URL.createObjectURL(audio), seconds } };
    await new Audio(spoken.value[model]?.url).play().catch(() => undefined);
  } catch (error) {
    speakError.value = error instanceof ApiError ? `Sintesi non riuscita: ${error.message}` : 'Sintesi non riuscita.';
  } finally {
    speaking.value = null;
  }
}

// The choice.
const chosenStt = ref<string | undefined>();
const chosenTts = ref<string | undefined>();
const snippet = computed(() => rolesSnippet(chosenStt.value, chosenTts.value));

onBeforeUnmount(() => {
  window.clearInterval(poll);
  release();
  for (const { url } of Object.values(spoken.value)) URL.revokeObjectURL(url);
});
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8">
    <div class="mx-auto flex max-w-[760px] flex-col gap-5">
      <header>
        <h1 class="font-hud text-xl font-semibold tracking-[0.05em]">Provino della voce</h1>
        <p class="mt-1 text-sm text-muted">
          Scegli a orecchio chi ascolta e chi parla nelle chiamate. Tutto gira su questo computer e non viene salvato nulla.
        </p>
      </header>

      <p v-if="problem !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ problem }}</p>
      <p v-if="trial === null && problem === null" class="text-muted">Leggo lo stato della voce…</p>

      <section v-if="notReady !== undefined" class="hud-card bg-surface px-4 py-3">
        <h2 class="font-medium">{{ notReady.title }}</h2>
        <ol class="mt-2 flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li v-for="step in notReady.steps" :key="step">{{ step }}</li>
        </ol>
      </section>

      <section v-if="trial !== null && missing > 0" class="hud-card bg-surface px-4 py-3 text-sm">
        <h2 class="font-medium">Mancano dei modelli</h2>
        <p class="mt-1">
          Per confrontarli tutti scarica i candidati con <code class="font-mono text-[12.5px]">pnpm arianna:models pull --trial</code>
          ({{ sizeText(missing) }} ancora da scaricare in data/models). Puoi provare intanto quelli già presenti.
        </p>
      </section>

      <template v-if="trial !== null && notReady === undefined">
        <section class="hud-card flex flex-col gap-3 bg-surface px-4 py-4">
          <h2 class="hud-title">1 · Chi ascolta</h2>
          <p class="text-sm">Premi <b>Registra</b>, leggi ad alta voce la frase con calma, poi premi <b>Ferma</b>.</p>
          <blockquote class="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[15px] leading-relaxed">{{ TRIAL_PHRASE }}</blockquote>
          <div class="flex flex-wrap items-center gap-3">
            <button v-if="recordState !== 'recording'" type="button" class="btn btn-primary" :disabled="recordState !== 'idle' || !stt.some((model) => model.present)" @click="startRecording">
              <Icon name="mic" :size="16" />Registra
            </button>
            <button v-else type="button" class="btn btn-primary" @click="stopRecording"><Icon name="stop" :size="16" />Ferma</button>
            <span v-if="recordState === 'recording'" class="font-mono text-sm text-danger" aria-live="polite">● {{ secondsText(elapsed) }} di {{ MAX_SECONDS }} s</span>
            <span v-if="recordState === 'writing'" class="text-sm text-muted" aria-live="polite">Scrivo… la prima volta i modelli si caricano e ci vuole di più.</span>
          </div>
          <p v-if="recordError !== null" role="alert" class="text-sm text-danger">{{ recordError }}</p>
          <ul class="flex flex-col gap-2">
            <li v-for="model in stt" :key="model.id" class="rounded-lg border border-line px-3 py-2">
              <div class="flex flex-wrap items-center gap-2">
                <label class="flex items-center gap-2 font-medium">
                  <input v-model="chosenStt" type="radio" name="stt" :value="model.id" :disabled="!model.present" />
                  {{ FAMILY_TEXT[model.family] ?? model.family }}
                </label>
                <span v-if="model.assigned" class="font-mono text-[10.5px] text-accent">IN USO</span>
                <span v-if="!model.present" class="font-mono text-[10.5px] text-muted">NON SCARICATO · {{ sizeText(model.sizeBytes) }}</span>
                <span v-for="result in transcripts.filter((item) => item.id === model.id)" :key="result.id" class="ml-auto font-mono text-[11px] text-muted">
                  {{ result.seconds === undefined ? '' : secondsText(result.seconds) }}
                </span>
              </div>
              <template v-for="result in transcripts.filter((item) => item.id === model.id)" :key="result.id">
                <p v-if="result.text !== undefined" class="mt-1.5 text-[14.5px]">{{ result.text === '' ? '(niente)' : result.text }}</p>
                <p v-else class="mt-1.5 text-sm text-danger">Non riuscito ({{ result.error }}).</p>
              </template>
            </li>
          </ul>
        </section>

        <section class="hud-card flex flex-col gap-3 bg-surface px-4 py-4">
          <h2 class="hud-title">2 · Chi parla</h2>
          <label class="flex flex-col gap-1 text-sm">
            La risposta da ascoltare (puoi cambiarla)
            <textarea v-model="reply" rows="3" maxlength="400" class="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[14.5px]" />
          </label>
          <label v-if="voices.length > 0" class="flex items-center gap-2 text-sm">
            Voce
            <select :value="chosenVoice" class="rounded-md border border-line bg-surface-2 px-2 py-1" @change="voice = ($event.target as HTMLSelectElement).value">
              <option v-for="name in voices" :key="name" :value="name">{{ VOICE_TEXT[name] ?? name }}</option>
            </select>
          </label>
          <p class="text-xs text-muted">Chatterbox non ha una voce sua: copia la voce scelta di Kokoro da una frase di riferimento.</p>
          <p v-if="speakError !== null" role="alert" class="text-sm text-danger">{{ speakError }}</p>
          <ul class="flex flex-col gap-2">
            <li v-for="model in tts" :key="model.id" class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
              <label class="flex items-center gap-2 font-medium">
                <input v-model="chosenTts" type="radio" name="tts" :value="model.id" :disabled="!model.present" />
                {{ FAMILY_TEXT[model.family] ?? model.family }}
              </label>
              <span v-if="model.assigned" class="font-mono text-[10.5px] text-accent">IN USO</span>
              <span v-if="!model.present" class="font-mono text-[10.5px] text-muted">NON SCARICATO · {{ sizeText(model.sizeBytes) }}</span>
              <span class="flex-1" />
              <span v-if="spoken[model.id]?.seconds !== undefined" class="font-mono text-[11px] text-muted">generata in {{ secondsText(spoken[model.id]?.seconds ?? 0) }}</span>
              <button type="button" class="btn" :disabled="!model.present || speaking !== null || voices.length === 0 || reply.trim() === ''" @click="speak(model.id)">
                <Icon name="play" :size="16" />{{ speaking === model.id ? 'Genero…' : 'Ascolta' }}
              </button>
              <audio v-if="spoken[model.id] !== undefined" :src="spoken[model.id]?.url" controls class="h-8 w-full" />
            </li>
          </ul>
        </section>

        <section class="hud-card flex flex-col gap-2 bg-surface px-4 py-4">
          <h2 class="hud-title">3 · La scelta</h2>
          <p class="text-sm">Scegli un modello per parte con i pallini, poi scrivi queste righe in <code class="font-mono text-[12.5px]">config/arianna.toml</code> (si applicano senza riavvio). Gli altri candidati puoi cancellarli da data/models.</p>
          <pre class="overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[12.5px]">{{ snippet }}</pre>
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { ApiError, deleteCopiedVoice, listCopiedVoices, saveCopiedVoice, speakTrial, type CopiedVoice, type TrialModel } from '../lib/api.ts';
import { concat, downsample, peak, STT_RATE, toBase64, toPcm16 } from '../lib/audio.ts';
import { CLONE_MAX_SECONDS, CLONE_PHRASE, sampleProblem, secondsText } from '../lib/voice-trial.ts';
import Icon from './Icon.vue';

/**
 * Voices copied from a sample (D-069): recorded here reading a phrase, or
 * from a file the user brings, with the text it says and the consent of the
 * person. The sample stays on this computer (L2); Qwen3-TTS Base speaks with it.
 */
const props = defineProps<{ base: TrialModel | undefined; reply: string }>();
const emit = defineEmits<{ changed: [] }>();

const voices = ref<CopiedVoice[]>([]);
const problem = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    voices.value = await listCopiedVoices();
  } catch (error) {
    problem.value = error instanceof ApiError ? error.message : 'Non riesco a leggere le voci copiate.';
  }
}
onMounted(load);

// The new voice.
type Source = 'record' | 'file';
const source = ref<Source>('record');
const name = ref('');
const text = ref(CLONE_PHRASE);
const consent = ref(false);
const samples = ref<Float32Array | null>(null);
const saving = ref(false);
const sampleSeconds = computed(() => (samples.value === null ? 0 : samples.value.length / STT_RATE));

function choose(next: Source): void {
  source.value = next;
  samples.value = null;
  problem.value = null;
  text.value = next === 'record' ? CLONE_PHRASE : '';
}

// Recording: no echo cancellation or noise suppression, they change the timbre.
const recording = ref(false);
const elapsed = ref(0);
let stream: MediaStream | undefined;
let context: AudioContext | undefined;
let chunks: Float32Array[] = [];
let timer: number | undefined;

async function startRecording(): Promise<void> {
  if (recording.value) return;
  problem.value = null;
  samples.value = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    context = new AudioContext();
    await context.audioWorklet.addModule('/recorder-worklet.js');
    const node = new AudioWorkletNode(context, 'arianna-recorder');
    chunks = [];
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      chunks.push(event.data);
    };
    context.createMediaStreamSource(stream).connect(node);
  } catch {
    release();
    problem.value = 'Il browser non ha dato il microfono: consentilo per questa pagina e riprova.';
    return;
  }
  recording.value = true;
  elapsed.value = 0;
  const started = Date.now();
  timer = window.setInterval(() => {
    elapsed.value = (Date.now() - started) / 1000;
    if (elapsed.value >= CLONE_MAX_SECONDS) stopRecording();
  }, 100);
}

function release(): void {
  window.clearInterval(timer);
  for (const track of stream?.getTracks() ?? []) track.stop();
  void context?.close();
  stream = undefined;
  context = undefined;
}

function stopRecording(): void {
  if (!recording.value || context === undefined) return;
  const rate = context.sampleRate;
  release();
  recording.value = false;
  // The clock stops a little late: a recording is cut to the limit, its text is the whole phrase.
  take(downsample(concat(chunks), rate).subarray(0, CLONE_MAX_SECONDS * STT_RATE));
  chunks = [];
}

/** Keeps a sample, or says why it cannot be used. */
function take(audio: Float32Array): void {
  const why = sampleProblem(audio.length / STT_RATE, peak(audio));
  if (why !== undefined) {
    problem.value = why;
    return;
  }
  samples.value = audio;
}

// A file the user brings: decoded by the browser, first channel, at 16 kHz.
async function pickFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  problem.value = null;
  samples.value = null;
  if (file === undefined) return;
  const decoder = new AudioContext();
  try {
    const audio = await decoder.decodeAudioData(await file.arrayBuffer());
    take(downsample(audio.getChannelData(0), audio.sampleRate));
  } catch {
    problem.value = 'Il browser non riesce a leggere questo file audio: prova con un WAV o un MP3.';
  } finally {
    void decoder.close();
  }
}

const canSave = computed(() => samples.value !== null && name.value.trim() !== '' && text.value.trim() !== '' && consent.value && !saving.value);

async function save(): Promise<void> {
  if (!canSave.value || samples.value === null) return;
  saving.value = true;
  problem.value = null;
  try {
    await saveCopiedVoice(name.value.trim(), text.value.trim(), toBase64(toPcm16(samples.value)));
    name.value = '';
    consent.value = false;
    samples.value = null;
    choose(source.value);
    await load();
    emit('changed');
  } catch (error) {
    problem.value = error instanceof ApiError ? `Non salvata: ${error.message}` : 'Non salvata.';
  } finally {
    saving.value = false;
  }
}

// Listening and deleting.
const speaking = ref<string | null>(null);
const heard = ref<Record<string, { url: string; first: number | undefined }>>({});
async function listen(id: string): Promise<void> {
  if (props.base === undefined || !props.base.present) return;
  speaking.value = id;
  problem.value = null;
  try {
    const { audio, first } = await speakTrial(props.reply, props.base.id, id);
    const previous = heard.value[id];
    if (previous !== undefined) URL.revokeObjectURL(previous.url);
    heard.value = { ...heard.value, [id]: { url: URL.createObjectURL(audio), first } };
    await new Audio(heard.value[id]?.url).play().catch(() => undefined);
  } catch (error) {
    problem.value = error instanceof ApiError ? `Sintesi non riuscita: ${error.message}` : 'Sintesi non riuscita.';
  } finally {
    speaking.value = null;
  }
}

// Deleting asks twice, in the page: no browser dialog.
const confirming = ref<string | null>(null);
async function remove(id: string): Promise<void> {
  if (confirming.value !== id) {
    confirming.value = id;
    return;
  }
  confirming.value = null;
  try {
    await deleteCopiedVoice(id);
    await load();
    emit('changed');
  } catch (error) {
    problem.value = error instanceof ApiError ? `Non eliminata: ${error.message}` : 'Non eliminata.';
  }
}

onBeforeUnmount(() => {
  release();
  for (const { url } of Object.values(heard.value)) URL.revokeObjectURL(url);
});
</script>

<template>
  <section class="hud-card flex flex-col gap-3 bg-surface px-4 py-4">
    <h2 class="hud-title">Voci copiate</h2>
    <p class="text-sm">
      Un’alternativa a Serena: Arianna parla con una voce copiata da un campione di 5–30 secondi. Il campione resta su questo computer, non va mai nel cloud, e si
      cancella da qui.
    </p>
    <p v-if="base === undefined || !base.present" class="text-sm text-muted">
      Serve il modello Qwen3-TTS Base: <code class="font-mono text-[12.5px]">pnpm arianna:models pull --trial</code>.
    </p>
    <p v-if="problem !== null" role="alert" class="text-sm text-danger">{{ problem }}</p>

    <ul v-if="voices.length > 0" class="flex flex-col gap-2">
      <li v-for="voice in voices" :key="voice.id" class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
        <span class="font-medium">{{ voice.name }}</span>
        <span class="font-mono text-[11px] text-muted">{{ voice.id }} · {{ secondsText(voice.seconds) }}</span>
        <span class="flex-1" />
        <span v-if="heard[voice.id]?.first !== undefined" class="font-mono text-[11px] text-accent">primo suono {{ secondsText(heard[voice.id]?.first ?? 0) }}</span>
        <button type="button" class="btn" :disabled="base === undefined || !base.present || speaking !== null" @click="listen(voice.id)">
          <Icon name="play" :size="16" />{{ speaking === voice.id ? 'Genero…' : 'Ascolta' }}
        </button>
        <button type="button" class="btn" @click="remove(voice.id)">
          <Icon name="delete" :size="16" />{{ confirming === voice.id ? 'Conferma: elimina' : 'Elimina' }}
        </button>
        <audio v-if="heard[voice.id] !== undefined" :src="heard[voice.id]?.url" controls class="h-8 w-full" />
      </li>
    </ul>
    <p v-else class="text-sm text-muted">Nessuna voce copiata.</p>

    <div class="flex flex-col gap-3 rounded-lg border border-line px-3 py-3">
      <h3 class="text-sm font-medium">Nuova voce</h3>
      <div class="flex gap-2" role="radiogroup" aria-label="Da dove viene il campione">
        <button type="button" class="btn" :class="source === 'record' ? 'btn-primary' : ''" :aria-checked="source === 'record'" role="radio" @click="choose('record')">
          <Icon name="mic" :size="16" />Registra
        </button>
        <button type="button" class="btn" :class="source === 'file' ? 'btn-primary' : ''" :aria-checked="source === 'file'" role="radio" @click="choose('file')">
          <Icon name="attach" :size="16" />Carica un file
        </button>
      </div>

      <template v-if="source === 'record'">
        <p class="text-sm">Fai leggere questa frase alla persona, con calma e con la sua voce di sempre, in una stanza silenziosa:</p>
        <blockquote class="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[15px]">{{ CLONE_PHRASE }}</blockquote>
        <div class="flex items-center gap-3">
          <button v-if="!recording" type="button" class="btn btn-primary" @click="startRecording"><Icon name="mic" :size="16" />Registra</button>
          <button v-else type="button" class="btn btn-primary" @click="stopRecording"><Icon name="stop" :size="16" />Ferma</button>
          <span v-if="recording" class="font-mono text-sm text-danger" aria-live="polite">● {{ secondsText(elapsed) }} di {{ CLONE_MAX_SECONDS }} s</span>
        </div>
      </template>
      <template v-else>
        <label class="flex flex-col gap-1 text-sm">
          File audio (WAV, MP3, M4A…) da 5 a {{ CLONE_MAX_SECONDS }} secondi, con una sola persona che parla
          <input type="file" accept="audio/*" class="text-sm" @change="pickFile" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Cosa dice il file, parola per parola
          <textarea v-model="text" rows="3" maxlength="600" class="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[14.5px]" />
        </label>
      </template>

      <p v-if="samples !== null" class="text-sm text-ok">Campione pronto: {{ secondsText(sampleSeconds) }}.</p>
      <label class="flex flex-col gap-1 text-sm">
        Nome della voce
        <input v-model="name" maxlength="40" class="rounded-md border border-line bg-surface-2 px-2 py-1 text-[14.5px]" />
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input v-model="consent" type="checkbox" class="mt-1" />
        La persona di questa voce sa che la copio e ha acconsentito.
      </label>
      <button type="button" class="btn btn-primary self-start" :disabled="!canSave" @click="save">{{ saving ? 'Salvo…' : 'Salva la voce' }}</button>
    </div>
  </section>
</template>

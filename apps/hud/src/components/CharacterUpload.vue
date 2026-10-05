<script setup lang="ts">
import { computed, ref } from 'vue';

import { uploadCharacter, type UploadedCharacter } from '../lib/api.ts';
import { uploadErrorText } from '../lib/italian.ts';
import { characterNameValid, sheetRowsOf } from '../lib/sprites.ts';
import SheetPreview from './SheetPreview.vue';

/**
 * "Carica PNG" for an agent (D-118): the sheet is read in the page, checked
 * for size and shown with its animations before it leaves; the core checks
 * it again, writes it anew and saves it in data/characters/miei. A character
 * of the same name is replaced only after the user says so.
 */
/** `keep`: how the choice is kept, at the end of the message (the agent's card: "premi Salva"). */
const props = withDefaults(defineProps<{ agentLabel: string; keep?: string }>(), { keep: 'premi Salva per tenerlo' });
const emit = defineEmits<{ uploaded: [character: UploadedCharacter] }>();

const MAX_BYTES = 256 * 1024;
const input = ref<HTMLInputElement | null>(null);
const file = ref<{ dataUrl: string; base64: string; rows: 3 | 4 } | null>(null);
const name = ref('');
const error = ref('');
const done = ref('');
const busy = ref(false);
/** The character of the same name the core already has: the page asks before replacing it. */
const existing = ref<{ id: string; name: string } | null>(null);
const nameValid = computed(() => characterNameValid(name.value));

function clear(): void {
  file.value = null;
  existing.value = null;
  error.value = '';
  name.value = '';
  if (input.value !== null) input.value.value = '';
}

function readDataUrl(chosen: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('unreadable'));
    };
    reader.readAsDataURL(chosen);
  });
}

function size(dataUrl: string): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      resolve(undefined);
    };
    image.src = dataUrl;
  });
}

async function choose(event: Event): Promise<void> {
  const chosen = (event.target as HTMLInputElement).files?.[0];
  clear();
  done.value = '';
  if (chosen === undefined) return;
  if (chosen.size > MAX_BYTES) {
    error.value = 'Il file supera 256 KiB: un foglio di personaggio è molto più piccolo.';
    return;
  }
  let dataUrl: string;
  try {
    dataUrl = await readDataUrl(chosen);
  } catch {
    error.value = 'Non riesco a leggere il file.';
    return;
  }
  const measured = dataUrl.startsWith('data:image/png;base64,') ? await size(dataUrl) : undefined;
  if (measured === undefined) {
    error.value = 'Il file non è un PNG.';
    return;
  }
  const rows = sheetRowsOf(measured.width, measured.height);
  if (rows === undefined) {
    error.value = `Il foglio misura ${String(measured.width)}×${String(measured.height)}: deve essere 112×96 o 112×128 pixel (7 colonne di fotogrammi 16×32).`;
    return;
  }
  file.value = { dataUrl, base64: dataUrl.slice('data:image/png;base64,'.length), rows };
  name.value = chosen.name.replace(/\.png$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 40);
}

async function send(replace: boolean): Promise<void> {
  if (file.value === null || !nameValid.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await uploadCharacter(name.value.trim(), file.value.base64, replace);
    if ('existing' in result) {
      existing.value = result.existing;
      return;
    }
    const saved = result.saved;
    clear();
    done.value = `${saved.replaced ? 'Sostituito' : 'Caricato'} «${saved.name}» nei tuoi personaggi (pacchetto miei) e scelto per ${props.agentLabel}: ${props.keep}.`;
    emit('uploaded', saved);
  } catch (cause) {
    error.value = uploadErrorText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <label class="btn cursor-pointer px-2.5 py-1 text-xs has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
        Carica PNG
        <input ref="input" type="file" accept="image/png" class="sr-only" @change="choose" />
      </label>
      <span class="text-xs text-muted">Un foglio 112×96 o 112×128, nel formato dei pixel agent.</span>
    </div>
    <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
    <p v-if="done" class="text-xs text-ok" role="status">{{ done }}</p>
    <div v-if="file" class="flex flex-col gap-2.5 rounded-[10px] border border-line-strong p-3">
      <SheetPreview :src="file.dataUrl" :rows="file.rows" />
      <label class="flex flex-col gap-1 text-xs text-muted sm:max-w-xs">
        Nome del personaggio
        <input v-model="name" maxlength="40" class="field px-2 py-1.5 text-[13px] text-ink" :disabled="existing !== null" @keydown.enter.prevent="send(false)" />
      </label>
      <p v-if="name.trim() !== '' && !nameValid" class="text-xs text-warn">Il nome deve avere almeno una lettera senza accenti strani o una cifra, su una riga sola.</p>
      <div v-if="existing" class="flex flex-col gap-2 rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2 text-[13px]" role="alert">
        <p>Fra i tuoi personaggi c’è già «{{ existing.name }}». Vuoi sostituirlo con questo foglio? Chi lo usa vedrà quello nuovo.</p>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busy" @click="send(true)">Sostituisci «{{ existing.name }}»</button>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="existing = null">Cambia nome</button>
        </div>
      </div>
      <div v-else class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy || !nameValid" @click="send(false)">Carica</button>
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="clear">Annulla</button>
      </div>
    </div>
  </div>
</template>

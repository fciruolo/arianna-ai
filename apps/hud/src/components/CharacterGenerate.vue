<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { generateSprite, loadSpriteInfo, uploadCharacter, type GeneratedSprite, type SpriteInfo, type UploadedCharacter } from '../lib/api.ts';
import { SPRITE_MODEL_TEXT, spriteErrorText, spriteReasonText, uploadErrorText } from '../lib/italian.ts';
import { characterNameValid } from '../lib/sprites.ts';
import type { CharacterChoice } from '../lib/types.ts';
import PixelAgent from './PixelAgent.vue';
import SheetPreview from './SheetPreview.vue';

/**
 * "Genera personaggio" (D-123): the model of `[sprites]` draws the agent from
 * its name, description and prompt (plus tone and specialization of its
 * persona, read by the core) and an optional hint. The drawing is shown with
 * its animations; nothing is saved until "Tieni", which sends it to the
 * upload of D-118 (pack `miei`, asking before replacing a character).
 */
/** `fetchPrompt`: the prompt read at each drawing (a user's agent in the Agents card); without it, `prompt`. */
const props = withDefaults(defineProps<{ agentLabel: string; name: string; description: string; prompt: string; keep?: string; fetchPrompt?: (() => Promise<string>) | undefined }>(), {
  keep: 'premi Salva per tenerlo',
  fetchPrompt: undefined,
});
/** `busy`: drawing, or a drawing not kept yet; the Agenti page keeps the agent and the tab meanwhile (D-133). */
const emit = defineEmits<{ uploaded: [character: UploadedCharacter]; busy: [busy: boolean] }>();

const MAX_HINT = 300;
const info = ref<SpriteInfo | null>(null);
const open = ref(false);
const hint = ref('');
const busy = ref(false);
const error = ref('');
const done = ref('');
const drawn = ref<GeneratedSprite | null>(null);
// A drawing on its way, or drawn and not kept yet: leaving it would lose the quota it cost.
watch([busy, drawn], () => emit('busy', busy.value || drawn.value !== null));
const characterName = ref('');
const existing = ref<{ id: string; name: string } | null>(null);

async function readInfo(): Promise<void> {
  try {
    info.value = await loadSpriteInfo();
  } catch {
    // Without the route the button stays hidden: an older core.
  }
}
onMounted(readInfo);

/** Read again on opening: the model may have changed in Impostazioni since the page was loaded. */
async function start(): Promise<void> {
  await readInfo();
  if (info.value?.available === true) open.value = true;
}

const modelText = computed(() => (info.value === null ? '' : (SPRITE_MODEL_TEXT[info.value.model] ?? info.value.model)));
const cloud = computed(() => info.value !== null && info.value.model !== 'local');
const ready = computed(() => props.name.trim() !== '' && props.description.trim() !== '');
const dataUrl = computed(() => (drawn.value === null ? undefined : `data:image/png;base64,${drawn.value.png}`));
/** PixelAgent wants a choice for the rows: the sheet itself comes from `src`. */
const previewChoice: CharacterChoice = { pack: '', character: '', rows: 4 };
const nameValid = computed(() => characterNameValid(characterName.value));

async function generate(): Promise<void> {
  if (busy.value || !ready.value) return;
  busy.value = true;
  error.value = '';
  done.value = '';
  existing.value = null;
  try {
    let prompt = props.prompt;
    if (props.fetchPrompt !== undefined) {
      try {
        prompt = await props.fetchPrompt();
      } catch {
        error.value = 'Non riesco a leggere il prompt dell’agente: ricarica la pagina e riprova.';
        return;
      }
    }
    drawn.value = await generateSprite({ name: props.name.trim(), description: props.description.trim(), prompt, hint: hint.value });
    if (characterName.value.trim() === '') characterName.value = props.name.trim().slice(0, 40);
  } catch (cause) {
    error.value = spriteErrorText(cause);
  } finally {
    busy.value = false;
  }
}

function close(): void {
  open.value = false;
  drawn.value = null;
  existing.value = null;
  error.value = '';
  hint.value = '';
  characterName.value = '';
}

async function keep(replace: boolean): Promise<void> {
  const sheet = drawn.value;
  if (sheet === null || busy.value || !nameValid.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await uploadCharacter(characterName.value.trim(), sheet.png, replace);
    if ('existing' in result) {
      existing.value = result.existing;
      return;
    }
    const saved = result.saved;
    close();
    done.value = `${saved.replaced ? 'Sostituito' : 'Salvato'} «${saved.name}» nei tuoi personaggi (pacchetto miei) e scelto per ${props.agentLabel}: ${props.keep}.`;
    emit('uploaded', saved);
  } catch (cause) {
    error.value = uploadErrorText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="info" class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="!info.available || !ready" @click="start">Genera personaggio</button>
      <span class="text-xs text-muted">Disegna {{ modelText }}<template v-if="!ready"> · servono nome e descrizione</template></span>
    </div>
    <p v-if="!info.available && info.reason" class="text-xs text-warn">{{ spriteReasonText(info.reason) }}</p>
    <p v-if="done" class="text-xs text-ok" role="status">{{ done }}</p>
    <div v-if="open" class="flex flex-col gap-2.5 rounded-[10px] border border-line-strong p-3">
      <p class="text-xs" :class="cloud ? 'text-warn' : 'text-muted'">
        <template v-if="cloud">
          Verso {{ modelText }} escono, passando dal gateway: nome, descrizione e prompt dell’agente, tono e specializzazione della sua personalità e il tuo suggerimento (Interno, nessun dato personale).
          Ogni «Genera» o «Rigenera» usa la tua quota di Claude.
        </template>
        <template v-else>Disegna il modello locale: nome, descrizione, prompt, personalità e suggerimento restano su questo computer.</template>
      </p>
      <label class="flex flex-col gap-1 text-xs text-muted">
        <span class="flex gap-2">Suggerimento (facoltativo)<span class="ml-auto font-mono">{{ hint.length }}/{{ MAX_HINT }}</span></span>
        <textarea v-model="hint" rows="2" :maxlength="MAX_HINT" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="capelli verdi, felpa gialla, occhiali tondi" />
      </label>
      <div v-if="drawn && dataUrl" class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex items-end gap-3 rounded-[10px] border border-line bg-surface-2 px-4 py-3">
            <PixelAgent :choice="previewChoice" :src="dataUrl" pose="idle" :scale="2" label="Anteprima, a riposo" />
            <PixelAgent :choice="previewChoice" :src="dataUrl" pose="working" :scale="2" label="Anteprima, al lavoro" />
          </div>
          <span class="text-xs text-muted">Disegnato da {{ SPRITE_MODEL_TEXT[drawn.model] ?? drawn.model }} · Interno</span>
        </div>
        <SheetPreview :src="dataUrl" :rows="drawn.rows" />
        <label class="flex flex-col gap-1 text-xs text-muted sm:max-w-xs">
          Nome del personaggio
          <input v-model="characterName" maxlength="40" class="field px-2 py-1.5 text-[13px] text-ink" :disabled="existing !== null" @keydown.enter.prevent="keep(false)" />
        </label>
        <p v-if="characterName.trim() !== '' && !nameValid" class="text-xs text-warn">Il nome deve avere almeno una lettera senza accenti strani o una cifra, su una riga sola.</p>
        <div v-if="existing" class="flex flex-col gap-2 rounded-[10px] border border-warn/50 bg-warn/10 px-3 py-2 text-[13px]" role="alert">
          <p>Fra i tuoi personaggi c’è già «{{ existing.name }}». Vuoi sostituirlo con questo disegno? Chi lo usa vedrà quello nuovo.</p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-warn px-2.5 py-1 text-xs" :disabled="busy" @click="keep(true)">Sostituisci «{{ existing.name }}»</button>
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="existing = null">Cambia nome</button>
          </div>
        </div>
      </div>
      <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
      <p v-if="busy && !drawn" class="text-xs text-muted" role="status">Sto disegnando e poi ricontrollo il disegno: può volerci qualche minuto.</p>
      <div class="flex flex-wrap gap-2">
        <button v-if="!drawn" type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy || !ready" @click="generate">Genera</button>
        <template v-else-if="!existing">
          <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy || !nameValid" @click="keep(false)">Tieni</button>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy || !ready" @click="generate">{{ busy ? 'Sto disegnando…' : 'Rigenera' }}</button>
        </template>
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="close">Annulla</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { anonymizeProjectNote, noteReleaseTargets, releaseProjectNote, type ReleaseTarget } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import { proposalErrorText, releaseErrorText, targetText, warningText } from '../lib/note-release.ts';
import Icon from './Icon.vue';

/**
 * "Fai uscire una volta" of a Private note (I-11 P5, D-187). The local model
 * proposes an anonymous version; the user reads it beside the original,
 * corrects it, chooses a work conversation of the same project and approves
 * with the master password. Only the text of the field leaves, once, as an
 * Interna message of that conversation; the note stays Private.
 */
/** `conversation`: the chat it was opened from ("Allega nota privata"): no select, the text goes there. */
const props = defineProps<{ project: string; path: string; original: string; version: string; conversation?: string }>();
const emit = defineEmits<{ close: []; open: [conversationId: string]; released: [conversationId: string] }>();

const text = ref('');
/** The text of the latest proposal, to tell whether the user changed it. */
const proposed = ref('');
const proposing = ref(false);
const proposalProblem = ref<string | null>(null);
const warnings = ref<string[]>([]);
const targets = ref<ReleaseTarget[] | null>(null);
const targetsProblem = ref<string | null>(null);
const conversationId = ref('');
const password = ref('');
const busy = ref(false);
const problem = ref<string | null>(null);
const released = ref<{ conversationId: string; title: string } | null>(null);

async function propose(): Promise<void> {
  proposing.value = true;
  proposalProblem.value = null;
  try {
    const proposal = await anonymizeProjectNote(props.project, props.path);
    text.value = proposal.text;
    proposed.value = proposal.text;
    warnings.value = proposal.warnings;
  } catch (cause) {
    proposalProblem.value = proposalErrorText(cause);
  } finally {
    proposing.value = false;
  }
}

/** The original in the field, to anonymize by hand when the model cannot. */
function useOriginal(): void {
  text.value = props.original;
  warnings.value = [];
}

onMounted(async () => {
  void propose();
  if (props.conversation !== undefined) {
    conversationId.value = props.conversation;
    return;
  }
  try {
    targets.value = await noteReleaseTargets(props.project);
    conversationId.value = targets.value[0]?.id ?? '';
  } catch (cause) {
    targetsProblem.value = errorText(cause);
  }
});

/** What the scanner found in the proposal; after a change by hand the core checks again when the text leaves. */
const warning = computed(() => {
  const found = warningText(warnings.value);
  if (found === null) return null;
  return text.value === proposed.value ? found : `${found} (Era nella proposta: se l’hai già tolto, va bene così.)`;
});
const canRelease = computed(() => !busy.value && !proposing.value && text.value.trim() !== '' && conversationId.value !== '' && password.value !== '');

async function release(): Promise<void> {
  if (!canRelease.value) return;
  busy.value = true;
  problem.value = null;
  try {
    const done = await releaseProjectNote(props.project, { path: props.path, version: props.version, text: text.value, conversationId: conversationId.value, password: password.value });
    const target = targets.value?.find((item) => item.id === done.conversationId);
    released.value = { conversationId: done.conversationId, title: target === undefined ? 'la conversazione' : targetText(target) };
    emit('released', done.conversationId);
  } catch (cause) {
    problem.value = releaseErrorText(cause);
  } finally {
    // The password is never kept on the page.
    password.value = '';
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 px-4 py-3.5">
    <template v-if="released">
      <p class="rounded-lg border border-line bg-panel px-3 py-2 text-[14px]">
        <b>Uscito una volta</b> in «{{ released.title }}», come messaggio Interno. La nota resta Privata; l’approvazione e il cambio di label sono registrati.
      </p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-3 py-1 text-[14px]" @click="emit('close')">Chiudi</button>
        <button type="button" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" @click="emit('open', released.conversationId)">Apri la conversazione</button>
      </div>
    </template>
    <form v-else class="flex flex-col gap-3" @submit.prevent="release">
      <p class="text-[14px] text-muted">
        La nota è <b class="text-ink">Privata</b> e non esce mai da sola. Da qui ne esce <b class="text-ink">una volta</b> solo il testo del campo a destra, dopo che l’hai letto e approvato con la master password: va {{ conversation === undefined ? 'nella conversazione di lavoro che scegli' : 'in questa conversazione' }}, come messaggio Interno, e da lì Arianna e il Coder possono usarlo. La versione anonima la propone il modello locale: aiuta, ma non è una garanzia, conta quello che approvi.
      </p>
      <div class="grid gap-3 lg:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-1 text-xs text-muted">
          Originale (resta Privato)
          <div class="field max-h-80 min-h-40 overflow-auto px-2 py-1.5 text-[14px] whitespace-pre-wrap break-words text-ink">{{ original }}</div>
        </div>
        <label class="flex min-w-0 flex-col gap-1 text-xs text-muted">
          <span class="flex items-center gap-2">Testo che esce
            <span v-if="proposing" class="text-muted">· il modello locale scrive la versione anonima…</span>
          </span>
          <textarea v-model="text" rows="12" class="field min-h-40 px-2 py-1.5 text-[14px] text-ink" :disabled="proposing" placeholder="La versione anonima della nota" />
        </label>
      </div>
      <p v-if="proposalProblem" class="text-sm text-danger" role="alert">{{ proposalProblem }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs" :disabled="proposing || busy" @click="propose"><Icon name="retry" :size="13" />Rifai la proposta</button>
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="proposing || busy" title="Copia l’originale nel campo, per togliere a mano i dati" @click="useOriginal">Parti dall’originale</button>
      </div>
      <p v-if="warning" class="rounded-lg border border-danger/40 bg-danger/8 px-3 py-2 text-[14px]" role="alert">{{ warning }}</p>
      <div class="grid gap-3" :class="conversation === undefined ? 'sm:grid-cols-2' : ''">
        <label v-if="conversation === undefined" class="flex flex-col gap-1 text-xs text-muted">Conversazione di lavoro del progetto
          <select v-model="conversationId" class="field px-2 py-1.5 text-[14px] text-ink" :disabled="targets === null || targets.length === 0">
            <option v-for="target in targets ?? []" :key="target.id" :value="target.id">{{ targetText(target) }}</option>
          </select>
          <span v-if="targetsProblem" class="text-danger">{{ targetsProblem }}</span>
          <span v-else-if="targets !== null && targets.length === 0">Nessuna conversazione di lavoro su questo progetto: aprine una, poi torna qui.</span>
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">Master password
          <input v-model="password" type="password" autocomplete="off" maxlength="1024" class="field px-2 py-1.5 text-[14px] text-ink" />
        </label>
      </div>
      <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="emit('close')">Annulla</button>
        <button type="submit" class="btn btn-danger px-3 py-1 text-[14px] font-semibold" :disabled="!canRelease">{{ busy ? 'Controllo…' : 'Fai uscire questo testo' }}</button>
      </div>
    </form>
  </div>
</template>

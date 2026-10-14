<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { ApiError, loadDevUserNote, saveDevUserNote } from '../lib/api.ts';
import Icon from './Icon.vue';

/**
 * «Su di te, per Claude Code» (D-114): what the user wants Claude Code to
 * know about him while it develops Arianna. Saved in data/dev/UTENTE.md,
 * replaced at each save; the text passes the gateway towards Claude Code
 * (cloud) as an answer does, and a block refuses it. Not the profile of
 * «Su di te» in the settings, which stays at home.
 */
const saved = ref<{ text: string; at: string | null } | null>(null);
const draft = ref('');
const max = ref(4000);
const busy = ref(false);
const problem = ref<string | null>(null);
const done = ref(false);

const changed = computed(() => saved.value !== null && draft.value.trim() !== saved.value.text);

function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Arianna non risponde: controlla che sia avviata.';
  if (cause.status === 422) return 'Il gateway l’ha fermato: sembra contenere un dato personale o un segreto (IBAN, codice fiscale, carta, chiave). Non salvato.';
  if (cause.status === 400) return `Non salvato: al massimo ${String(max.value)} caratteri.`;
  return 'Non salvato: riprova.';
}

onMounted(async () => {
  try {
    const loaded = await loadDevUserNote();
    saved.value = loaded.note;
    draft.value = loaded.note.text;
    max.value = loaded.max;
  } catch (cause) {
    problem.value = failure(cause);
  }
});

async function save(): Promise<void> {
  busy.value = true;
  problem.value = null;
  done.value = false;
  try {
    saved.value = await saveDevUserNote(draft.value);
    draft.value = saved.value.text;
    done.value = true;
  } catch (cause) {
    problem.value = failure(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="rounded-xl border border-line bg-surface-2 p-4" aria-labelledby="dev-user-note">
    <h2 id="dev-user-note" class="text-[16px] font-semibold">Su di te, per Claude Code</h2>
    <p class="mt-1 max-w-[80ch] text-[14px] text-muted">
      Quello che vuoi che Claude Code sappia di te mentre sviluppa Arianna: come lavori, cosa preferisci. Lo legge all’inizio di ogni sessione. Ogni salvataggio sostituisce il testo di prima; vuoto, lo cancella.
    </p>
    <p class="mt-2 flex max-w-[80ch] items-start gap-2 text-[13px] text-warn"><Icon name="gateway" :size="14" class="mt-0.5 shrink-0" />Va al cloud: niente dati personali. Il gateway ferma IBAN, codici fiscali, carte e chiavi.</p>
    <form class="mt-3 flex flex-col gap-2" @submit.prevent="save">
      <label for="dev-user-note-text" class="sr-only">Su di te, per Claude Code</label>
      <textarea
        id="dev-user-note-text"
        v-model="draft"
        rows="4"
        :maxlength="max"
        :disabled="saved === null"
        placeholder="Per esempio: preferisco commit piccoli e spiegazioni brevi; lavoro soprattutto la mattina."
        class="field block min-h-[88px] w-full resize-y px-3 py-2 text-[14px] leading-relaxed placeholder:text-muted"
      />
      <div class="flex flex-wrap items-center gap-2">
        <p v-if="problem !== null" role="alert" class="min-w-0 flex-1 text-[13px] text-danger">{{ problem }}</p>
        <p v-else-if="done" role="status" class="min-w-0 flex-1 text-[13px] text-ok">{{ saved?.at === null ? 'Cancellato.' : `Salvato (${saved?.at ?? ''}).` }}</p>
        <p v-else class="min-w-0 flex-1 text-[13px] text-muted">{{ saved?.at ? `Ultimo salvataggio: ${saved.at}` : 'Ancora vuoto.' }} · {{ draft.trim().length }} di {{ max }} caratteri</p>
        <button type="submit" class="btn btn-primary px-3 py-1 text-[13.5px]" :disabled="busy || !changed"><Icon name="saved" :size="14" />{{ busy ? 'Salvo…' : 'Salva' }}</button>
      </div>
    </form>
  </section>
</template>

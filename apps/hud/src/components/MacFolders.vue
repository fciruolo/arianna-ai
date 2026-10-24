<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { addMacFolder, ApiError, loadMacFolders, removeMacFolder, type MacFolderView, type MacFoldersView } from '../lib/api.ts';
import { onRemoteOrigin } from '../lib/remote.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import FormField from './FormField.vue';

/**
 * Impostazioni → Cartelle del Mac (D-314, I-22, tappa M1), on the Mac only:
 * the folders Arianna may read without asking, in a private chat and with
 * the local model alone. At the start there is none; «Sempre» on a card adds
 * one, and here the user adds or takes them off. No agent writes this list.
 */
const remote = onRemoteOrigin(window.location);
const view = ref<MacFoldersView | undefined>(undefined);
const loadProblem = ref<string | null>(null);
const path = ref('');
const busy = ref(false);
const problem = ref<string | null>(null);
const removing = ref<MacFolderView | null>(null);
const removeBusy = ref(false);
const removeProblem = ref<string | null>(null);

async function reload(): Promise<void> {
  try {
    view.value = await loadMacFolders();
    loadProblem.value = null;
  } catch {
    loadProblem.value = 'Il core non risponde: riprova.';
  }
}

onMounted(() => {
  if (!remote) void reload();
});

async function add(): Promise<void> {
  if (path.value.trim() === '') return;
  busy.value = true;
  problem.value = null;
  try {
    view.value = await addMacFolder(path.value);
    path.value = '';
  } catch (error) {
    // The core says why in Italian: it does not exist, it is hidden, the Library, the folder of Arianna.
    problem.value = error instanceof ApiError && error.status === 400 ? error.message : 'Il core non risponde: riprova.';
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  const folder = removing.value;
  if (folder === null) return;
  removeBusy.value = true;
  removeProblem.value = null;
  try {
    view.value = await removeMacFolder(folder.id);
    removing.value = null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      removing.value = null;
      await reload();
    } else removeProblem.value = 'Il core non risponde: riprova.';
  } finally {
    removeBusy.value = false;
  }
}

const input = 'field w-full min-w-0 px-2.5 py-1.5 text-[14px] text-ink';
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <p v-if="remote" class="hud-card px-4 py-3 text-[14.5px] text-muted">Le cartelle del Mac si vedono e si cambiano solo dal Mac: apri Arianna sul Mac.</p>
    <p v-else-if="loadProblem !== null" role="alert" class="hud-card px-4 py-3 text-[14.5px] text-danger">
      {{ loadProblem }} <button type="button" class="text-accent hover:underline" @click="reload">Riprova</button>
    </p>
    <p v-else-if="view === undefined" class="text-[14px] text-muted">Carico…</p>
    <p v-else-if="!view.available" class="hud-card px-4 py-3 text-[14.5px] text-muted">Questo core non legge le cartelle del Mac.</p>
    <template v-else>
      <section class="hud-card flex flex-col gap-2 px-4 py-3">
        <h3 class="text-[15px] font-semibold">Cartelle che Arianna legge senza chiedere</h3>
        <p v-if="view.folders.length === 0" class="text-[14.5px] text-muted">
          Nessuna. Quando Arianna deve guardare una cartella te lo chiede con una scheda: «Sempre» la aggiunge qui.
        </p>
        <ul v-else class="flex flex-col divide-y divide-line">
          <li v-for="folder in view.folders" :key="folder.id" class="flex flex-wrap items-center gap-2.5 py-2">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[14.5px] font-medium">{{ folder.place }}</span>
              <span class="block truncate font-mono text-[12.5px] text-muted">{{ folder.path }}</span>
              <span class="block text-[12.5px] text-muted">{{ folder.via === 'approval' ? 'Aggiunta con «Sempre» da una scheda' : 'Aggiunta da qui' }}</span>
            </span>
            <button type="button" class="btn" @click="removing = folder; removeProblem = null">Togli</button>
          </li>
        </ul>
        <p class="text-[13px] text-muted">Il permesso vale per la cartella e le sue sottocartelle. Arianna legge soltanto, solo nelle chat Private e solo con il modello del Mac; i file nascosti e la Libreria restano fuori.</p>
      </section>

      <section class="hud-card flex flex-col gap-3 px-4 py-3">
        <h3 class="text-[15px] font-semibold">Aggiungi una cartella</h3>
        <form class="flex flex-wrap items-end gap-2.5" @submit.prevent="add">
          <FormField id="mac-folder-path" label="Percorso" :span="4" class="min-w-[220px] flex-1">
            <input id="mac-folder-path" v-model="path" :class="input" maxlength="500" placeholder="~/Documents/Fatture" autocomplete="off" spellcheck="false" :disabled="busy" />
          </FormField>
          <button type="submit" class="btn btn-primary" :disabled="busy || path.trim() === ''">{{ busy ? 'Aggiungo…' : 'Aggiungi' }}</button>
        </form>
        <p class="text-[13px] text-muted">Dalla cartella Inizio (~), anche con i nomi italiani: «Scrivania», «Documenti/Fatture». Per un disco esterno, il suo percorso sotto /Volumes.</p>
        <p v-if="problem !== null" role="alert" class="text-[14px] text-danger">{{ problem }}</p>
      </section>
    </template>

    <ConfirmDialog
      v-if="removing !== null"
      title="Togliere la cartella?"
      confirm-text="Togli"
      :busy="removeBusy"
      :problem="removeProblem"
      @confirm="remove"
      @cancel="removing = null"
    >
      <p class="text-[14.5px] leading-relaxed">Arianna non legge più {{ removing.place }} senza chiedere: la prossima volta compare di nuovo la scheda. Le chat dove hai scelto «Per tutta questa conversazione» la tengono finché restano aperte.</p>
    </ConfirmDialog>
  </div>
</template>

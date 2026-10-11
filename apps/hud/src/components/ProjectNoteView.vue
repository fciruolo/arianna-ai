<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { ApiError, editProjectNote, readProjectNote } from '../lib/api.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import { browseErrorText, lowers, noteLabels, type OpenedNote } from '../lib/projects.ts';
import type { Label } from '../lib/types.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * A note of the tab "Conoscenza" opened: its text read, and "Modifica" to
 * change by hand the title, the label (never below the folder's; a label that
 * goes down says so and asks a second click), the other lines of the header
 * and the text. The core writes only over the file the user opened.
 */
const props = defineProps<{ project: string; path: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const note = ref<OpenedNote | null>(null);
const problem = ref<string | null>(null);

async function load(): Promise<void> {
  const { project, path } = props;
  try {
    const found = await readProjectNote(project, path);
    if (props.project === project && props.path === path) {
      note.value = found;
      problem.value = null;
    }
  } catch (cause) {
    if (props.project === project && props.path === path) problem.value = browseErrorText(cause);
  }
}

const editing = ref<{ title: string; label: Label; header: string; text: string; busy: boolean; error: string | null; confirmLower: boolean } | null>(null);
const titleInput = ref<HTMLInputElement | null>(null);

function startEditing(): void {
  if (note.value === null) return;
  editing.value = { title: note.value.title, label: note.value.label, header: note.value.header.join('\n'), text: note.value.body, busy: false, error: null, confirmLower: false };
  void nextTick(() => titleInput.value?.focus());
}

const labels = computed(() => (note.value === null ? [] : noteLabels(note.value.floor)));
const goesDown = computed(() => note.value !== null && editing.value !== null && lowers(note.value.label, editing.value.label));
const canSave = computed(() => editing.value !== null && !editing.value.busy && editing.value.title.trim() !== '');

// Another label chosen asks the confirmation again.
watch(
  () => editing.value?.label,
  () => {
    if (editing.value !== null) editing.value.confirmLower = false;
  },
);

async function save(): Promise<void> {
  const open = editing.value;
  const current = note.value;
  if (open === null || current === null || !canSave.value) return;
  if (goesDown.value && !open.confirmLower) {
    open.confirmLower = true;
    return;
  }
  open.busy = true;
  open.error = null;
  try {
    note.value = await editProjectNote(props.project, {
      path: current.path,
      title: open.title.trim(),
      label: open.label,
      header: open.header.split('\n').filter((line) => line.trim() !== ''),
      text: open.text,
      version: current.version,
      lower: goesDown.value,
    });
    editing.value = null;
    emit('saved');
  } catch (cause) {
    open.busy = false;
    if (cause instanceof ApiError && cause.status === 409) open.error = 'La nota è cambiata dopo che l’hai aperta: chiudi e riaprila per vedere la versione nuova.';
    else if (cause instanceof ApiError && cause.status === 400) open.error = `Il nucleo ha rifiutato la modifica: ${cause.message}`;
    else open.error = browseErrorText(cause);
  }
}

// Last: it runs at once and resets the state declared above.
watch(
  () => [props.project, props.path],
  () => {
    note.value = null;
    problem.value = null;
    editing.value = null;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="rounded-2xl border border-line bg-surface" aria-labelledby="note-title">
    <header class="flex items-center gap-2 border-b border-line px-4 py-3">
      <Icon name="knowledge" :size="15" class="text-muted" />
      <h2 id="note-title" class="hud-title min-w-0 flex-1 truncate">{{ note?.title ?? 'Nota' }}</h2>
      <LabelBadge v-if="note" :label="note.label" class="text-xs" />
      <button v-if="note && !editing" type="button" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold" @click="startEditing"><Icon name="rename" :size="13" />Modifica</button>
      <button type="button" class="rounded-md p-1 text-muted transition hover:text-ink" aria-label="Chiudi la nota" title="Chiudi" :disabled="editing?.busy === true" @click="emit('close')">
        <Icon name="close" :size="14" />
      </button>
    </header>
    <p v-if="problem" class="p-4 text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-else-if="note === null" class="p-4 text-sm text-muted">Apro la nota…</p>
    <template v-else-if="editing === null">
      <p class="border-b border-line px-4 py-2 font-mono text-[11.5px] text-muted">{{ note.path }}</p>
      <ul v-if="note.header.length > 0" class="flex flex-col gap-0.5 border-b border-line px-4 py-2 font-mono text-[11.5px] text-muted">
        <li v-for="line in note.header" :key="line" class="break-words">{{ line }}</li>
      </ul>
      <MarkdownText v-if="note.body.trim() !== ''" class="px-4 py-3" :source="note.body" />
      <p v-else class="px-4 py-3 text-sm text-muted">La nota non ha testo.</p>
    </template>
    <form v-else class="flex flex-col gap-3 px-4 py-3.5" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label class="flex flex-col gap-1 text-xs text-muted">Titolo
          <input ref="titleInput" v-model="editing.title" maxlength="200" class="field px-2 py-1.5 text-[13px] text-ink" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">Etichetta
          <select v-model="editing.label" class="field px-2 py-1.5 text-[13px] text-ink">
            <option v-for="label in labels" :key="label" :value="label">{{ LABEL_TEXT[label] }}</option>
          </select>
        </label>
      </div>
      <label class="flex flex-col gap-1 text-xs text-muted">Altre righe dell’intestazione (una per riga, «chiave: valore»)
        <textarea v-model="editing.header" rows="3" class="field px-2 py-1.5 font-mono text-[12px] text-ink" placeholder="source: capture:hud:…" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">Testo
        <textarea v-model="editing.text" rows="14" class="field px-2 py-1.5 text-[13px] text-ink" />
      </label>
      <p class="text-xs text-muted">L’etichetta non scende sotto quella della cartella ({{ LABEL_TEXT[note.floor] }}); titolo ed etichetta hanno i loro campi, non vanno fra le righe dell’intestazione.</p>
      <p v-if="goesDown" class="rounded-lg border border-danger/40 bg-danger/8 px-3 py-2 text-[13px]">
        <b>L’etichetta scende</b> da {{ LABEL_TEXT[note.label] }} a {{ LABEL_TEXT[editing.label] }}: la leggerà anche una conversazione che oggi non la vede.
        <template v-if="editing.confirmLower"> Premi di nuovo per confermare.</template>
      </p>
      <p v-if="editing.error" class="text-sm text-danger" role="alert">{{ editing.error }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="editing.busy" @click="editing = null">Annulla</button>
        <button type="submit" class="btn px-3 py-1 text-[13px] font-semibold" :class="goesDown ? 'btn-danger' : 'btn-primary'" :disabled="!canSave">
          {{ goesDown ? (editing.confirmLower ? `Sì, abbassa a ${LABEL_TEXT[editing.label]}` : 'Salva') : 'Salva' }}
        </button>
      </div>
    </form>
  </section>
</template>

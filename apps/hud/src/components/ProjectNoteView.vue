<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { ApiError, editProjectNote, readProjectNote } from '../lib/api.ts';
import { LABEL_OPTION, LABEL_TEXT } from '../lib/labels.ts';
import { browseErrorText, lowers, noteLabels, type OpenedNote } from '../lib/projects.ts';
import { noteHeading, noteMeta, statusTone } from '../lib/projects-page.ts';
import type { Label } from '../lib/types.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import MarkdownText from './MarkdownText.vue';
import NoteRelease from './NoteRelease.vue';

/**
 * A note of the tab "Conoscenza" opened: its text read, and "Modifica" to
 * change by hand the title, the label (never below the folder's; a label that
 * goes down says so and asks a second click), the other lines of the header
 * and the text. The core writes only over the file the user opened.
 */
/** `deleting`: the page's confirmation of "Elimina" is open; never "Modifica" or "Fai uscire una volta" with it. */
const props = withDefaults(defineProps<{ project: string; path: string; deleting?: boolean }>(), { deleting: false });
/** `delete`: the bin of the bar; the page asks the confirmation (DeleteConfirm, in the default slot). */
const emit = defineEmits<{ close: []; saved: []; open: [conversationId: string]; delete: [] }>();

/** "Fai uscire una volta" (I-11 P5, D-187): only for a Private note, never while editing. */
const releasing = ref(false);

const note = ref<OpenedNote | null>(null);
const problem = ref<string | null>(null);

const folderOf = computed(() => props.path.split('/')[0] ?? '');
const fileOf = computed(() => props.path.split('/').slice(1).join('/'));

/** Title, header and text as the note reads (D-193): its leading heading as the title, the header as a row of data. */
const shown = computed(() => (note.value === null ? null : noteHeading(note.value.title, note.value.body)));
const meta = computed(() => noteMeta(note.value?.header ?? []));
const STATUS_CLASS = { done: 'border-ok text-ok', next: 'border-info text-info', plain: '' } as const;

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
    else if (cause instanceof ApiError && cause.status === 400) open.error = `Arianna ha rifiutato la modifica: ${cause.message}`;
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
    releasing.value = false;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="shown?.title ?? 'Nota'">
    <header class="flex min-h-14 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
      <span class="mr-auto flex min-w-0 items-center gap-1.5 text-[13px] text-muted" :title="path">
        <span class="truncate">{{ folderOf }}</span><span aria-hidden="true">›</span><span class="truncate font-mono text-[12.5px]">{{ fileOf }}</span>
      </span>
      <button
        v-if="note && note.label === 'L2' && !editing && !releasing && !deleting"
        type="button"
        class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-[13px]"
        title="Una versione anonima di questa nota esce una volta in una conversazione di lavoro, con la master password"
        @click="releasing = true"
      >
        <Icon name="gateway" :size="13" />Fai uscire una volta
      </button>
      <button v-if="note && !editing && !releasing && !deleting" type="button" class="btn inline-flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-semibold" @click="startEditing"><Icon name="rename" :size="13" />Modifica</button>
      <button
        v-if="note && !editing && !releasing && !deleting"
        type="button"
        class="grid size-8 place-items-center rounded-md text-muted transition hover:text-danger"
        :aria-label="`Elimina per sempre ${note.title}`"
        title="Elimina per sempre"
        @click="emit('delete')"
      >
        <Icon name="delete" :size="15" />
      </button>
      <button type="button" class="grid size-8 place-items-center rounded-md text-muted transition hover:text-ink" aria-label="Chiudi la nota" title="Chiudi" :disabled="editing?.busy === true" @click="emit('close')">
        <Icon name="close" :size="15" />
      </button>
    </header>
    <slot />
    <div class="min-h-0 flex-1 overflow-auto">
      <p v-if="problem" class="p-4 text-sm text-danger" role="alert">{{ problem }}</p>
      <p v-else-if="note === null" class="p-4 text-sm text-muted">Apro la nota…</p>
      <NoteRelease v-else-if="releasing" :project="project" :path="note.path" :original="note.body" :version="note.version" @close="releasing = false" @open="(id) => emit('open', id)" />
      <article v-else-if="editing === null && shown" class="max-w-[760px] px-4 pt-5 pb-10 sm:px-8">
        <h2 class="mb-1.5 text-[22px] leading-tight font-semibold break-words">{{ shown.title }}</h2>
        <!-- The header as a row of data (D-193), not the raw "key: value" lines -->
        <div class="mb-5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[13.5px] text-muted">
          <LabelBadge :label="note.label" class="text-[13px]" />
          <span v-if="meta.im">IM n. {{ meta.im }}</span>
          <span v-if="meta.date">{{ meta.date }}</span>
          <span v-if="meta.status" class="pill px-2 py-0 text-[12.5px]" :class="STATUS_CLASS[statusTone(meta.status)]">{{ meta.status }}</span>
          <span v-for="(entry, index) in meta.other" :key="index" class="text-[12.5px] break-all">
            <template v-if="entry.key">{{ entry.key }}: </template><span class="text-ink/80">{{ entry.value }}</span>
          </span>
        </div>
        <MarkdownText v-if="shown.body.trim() !== ''" :source="shown.body" />
        <p v-else class="text-sm text-muted">La nota non ha testo.</p>
      </article>
      <form v-else-if="editing" class="flex max-w-[760px] flex-col gap-3 px-4 py-4 sm:px-6" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label class="flex flex-col gap-1 text-xs text-muted">Titolo
          <input ref="titleInput" v-model="editing.title" maxlength="200" class="field px-2 py-1.5 text-[14px] text-ink" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">Etichetta di privacy (label)
          <select v-model="editing.label" class="field px-2 py-1.5 text-[14px] text-ink">
            <option v-for="label in labels" :key="label" :value="label">{{ LABEL_OPTION[label] }}</option>
          </select>
        </label>
      </div>
      <label class="flex flex-col gap-1 text-xs text-muted">Altre righe dell’intestazione (una per riga, «chiave: valore»)
        <textarea v-model="editing.header" rows="3" class="field px-2 py-1.5 font-mono text-[13px] text-ink" placeholder="source: capture:hud:…" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">Testo
        <textarea v-model="editing.text" rows="14" class="field px-2 py-1.5 text-[14px] text-ink" />
      </label>
      <p class="text-xs text-muted">Nella select la protezione cresce dall’alto in basso. Alzarla è sempre permesso; abbassarla chiede conferma, e mai sotto quella della cartella ({{ LABEL_TEXT[note.floor] }}). Titolo e label hanno i loro campi, non vanno fra le altre righe dell’intestazione.</p>
      <p v-if="goesDown" class="rounded-lg border border-danger/40 bg-danger/8 px-3 py-2 text-[14px]">
        <b>La protezione scende</b> da {{ LABEL_TEXT[note.label] }} a {{ LABEL_TEXT[editing.label] }}: la leggerà anche una conversazione che oggi non la vede.
        <template v-if="editing.confirmLower"> Premi di nuovo per confermare.</template>
      </p>
      <p v-if="editing.error" class="text-sm text-danger" role="alert">{{ editing.error }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="editing.busy" @click="editing = null">Annulla</button>
        <button type="submit" class="btn px-3 py-1 text-[14px] font-semibold" :class="goesDown ? 'btn-danger' : 'btn-primary'" :disabled="!canSave">
          {{ goesDown ? (editing.confirmLower ? `Sì, abbassa a ${LABEL_TEXT[editing.label]}` : 'Salva') : 'Salva' }}
        </button>
      </div>
      </form>
    </div>
  </section>
</template>

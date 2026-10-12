<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

import { COMMENT_MAX, COMMENTS_MAX, commentProblem, type StudioComment } from '../lib/studio.ts';
import Icon from './Icon.vue';

/**
 * The comments of the Studio (I-19, D-184, O3): the element just picked
 * waits for its comment; the list can be changed and emptied; "Invia al
 * Designer" sends them all as one message in the conversation on the left.
 */
const props = defineProps<{
  comments: StudioComment[];
  /** The element picked in the frame, waiting for its comment. */
  pending: { selector: string; tag: string; excerpt: string } | null;
  sending: boolean;
  /** Why the comments cannot leave now (no chat with the Designer), or undefined. */
  blocked: string | undefined;
}>();
const emit = defineEmits<{
  add: [text: string];
  cancel: [];
  update: [id: number, text: string];
  remove: [id: number];
  focus: [selector: string | null];
  send: [];
}>();

const draft = ref('');
const problem = ref<string | undefined>(undefined);
const field = ref<HTMLTextAreaElement | null>(null);
watch(
  () => props.pending,
  async (pending) => {
    draft.value = '';
    problem.value = undefined;
    // The field of the element just picked (the same one again too), ready to write in.
    if (pending === null) return;
    await nextTick();
    field.value?.focus();
  },
);

function add(): void {
  problem.value = commentProblem(draft.value);
  if (problem.value !== undefined) return;
  emit('add', draft.value.trim());
  draft.value = '';
}

const editing = ref<number | null>(null);
const editText = ref('');
function startEdit(comment: StudioComment): void {
  editing.value = comment.id;
  editText.value = comment.text;
}
function saveEdit(id: number): void {
  if (commentProblem(editText.value) !== undefined) return;
  emit('update', id, editText.value.trim());
  editing.value = null;
}
</script>

<template>
  <section class="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-[13px]" aria-label="Commenti">
    <header class="flex items-center gap-2">
      <Icon name="comment" :size="14" />
      <h3 class="flex-1 font-medium">Commenti ({{ comments.length }})</h3>
    </header>

    <form v-if="pending !== null" class="flex flex-col gap-1.5 rounded-lg border border-accent/60 bg-surface-2 p-2" @submit.prevent="add">
      <p class="text-xs text-muted">
        Su <code class="font-mono">&lt;{{ pending.tag }}&gt;</code><template v-if="pending.excerpt !== ''"> «{{ pending.excerpt }}»</template>
      </p>
      <textarea
        ref="field"
        v-model="draft"
        class="field min-h-[60px] resize-y px-2.5 py-1.5"
        :maxlength="COMMENT_MAX"
        placeholder="Cosa cambiare in questo elemento"
        aria-label="Commento sull’elemento scelto"
        @keydown.enter.meta.prevent="add"
        @keydown.enter.ctrl.prevent="add"
      />
      <p v-if="problem !== undefined" class="text-xs text-danger" role="alert">{{ problem }}</p>
      <div class="flex gap-2">
        <button type="submit" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="comments.length >= COMMENTS_MAX">Aggiungi</button>
        <button type="button" class="btn px-2.5 py-1 text-xs" @click="emit('cancel')">Annulla</button>
      </div>
    </form>
    <p v-else-if="comments.length === 0" class="text-xs text-muted">Con «Commenta» acceso, fai clic su un elemento della pagina per lasciare un commento.</p>

    <ol class="flex flex-col gap-1.5">
      <li
        v-for="(comment, at) in comments"
        :key="comment.id"
        class="flex flex-col gap-1 rounded-lg border border-line px-2.5 py-1.5"
        @mouseenter="emit('focus', comment.selector)"
        @mouseleave="emit('focus', null)"
      >
        <p class="flex items-center gap-2 text-[11px] text-muted">
          <b class="font-mono text-ink">{{ at + 1 }}</b>
          <span class="truncate font-mono" :title="`${comment.file} · ${comment.selector}`">{{ comment.file.split('/').at(-1) }} · &lt;{{ comment.tag }}&gt;</span>
          <span class="ml-auto flex shrink-0 gap-1">
            <button type="button" class="rounded p-0.5 hover:bg-surface-2 hover:text-ink" :aria-label="`Modifica il commento ${at + 1}`" @click="startEdit(comment)"><Icon name="rename" :size="12" /></button>
            <button type="button" class="rounded p-0.5 hover:bg-surface-2 hover:text-danger" :aria-label="`Togli il commento ${at + 1}`" @click="emit('remove', comment.id)"><Icon name="delete" :size="12" /></button>
          </span>
        </p>
        <p v-if="comment.excerpt !== ''" class="truncate text-[11px] text-muted">«{{ comment.excerpt }}»</p>
        <form v-if="editing === comment.id" class="flex flex-col gap-1" @submit.prevent="saveEdit(comment.id)">
          <textarea v-model="editText" class="field min-h-[52px] resize-y px-2 py-1" :maxlength="COMMENT_MAX" :aria-label="`Testo del commento ${at + 1}`" />
          <div class="flex gap-2">
            <button type="submit" class="btn px-2 py-0.5 text-xs" :disabled="commentProblem(editText) !== undefined">Salva</button>
            <button type="button" class="btn px-2 py-0.5 text-xs" @click="editing = null">Annulla</button>
          </div>
        </form>
        <p v-else class="whitespace-pre-wrap">{{ comment.text }}</p>
      </li>
    </ol>

    <div v-if="comments.length > 0" class="flex flex-col gap-1">
      <button type="button" class="btn btn-primary px-3 py-1.5 text-xs" :disabled="sending || blocked !== undefined" @click="emit('send')">
        <Icon name="send" :size="13" />{{ sending ? 'Invio…' : `Invia al Designer (${comments.length})` }}
      </button>
      <p v-if="blocked !== undefined" class="text-[11px] text-warn">{{ blocked }}</p>
      <p v-else class="text-[11px] text-muted">Partono insieme, come un solo messaggio nella conversazione col Designer.</p>
    </div>
  </section>
</template>

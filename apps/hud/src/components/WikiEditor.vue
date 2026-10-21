<script setup lang="ts">
import { Editor, Extension } from '@tiptap/core';
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';

import { loadWikiTargets, type WikiCitationTarget } from '../lib/api.ts';
import { docToMarkdown, markdownToDoc, wikiExtensions } from '../lib/wiki-editor.ts';

/**
 * The editor of a page of the Wiki (D-282): written already formatted, with
 * a bar of buttons, citations `[[nota]]` as labels and «[[» suggesting the
 * notes and pages the save accepts. Underneath it is Markdown, the text the
 * core checks; «Markdown» switches to the plain text. No command for links,
 * images or HTML exists: the schema has none.
 */

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const mode = ref<'rich' | 'markdown'>('rich');
const plain = ref(props.modelValue);
const host = ref<HTMLElement | null>(null);
const editor = shallowRef<Editor | null>(null);
/** Bumped at each change of the editor: the bar reads what is active again. */
const tick = ref(0);

const suggest = reactive<{ open: boolean; items: WikiCitationTarget[]; index: number; top: number; left: number; command: ((item: WikiCitationTarget) => void) | null; loading: boolean }>({
  open: false,
  items: [],
  index: 0,
  top: 0,
  left: 0,
  command: null,
  loading: false,
});

let requests = 0;
let frame: number | undefined;

function place(props: SuggestionProps<WikiCitationTarget, WikiCitationTarget>): void {
  const rect = props.clientRect?.();
  if (rect === null || rect === undefined) return;
  suggest.top = rect.bottom + 4;
  suggest.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300));
}

/** «[[»: a list of the notes and pages a citation may name, chosen with the arrows and Enter or a click. */
const CitationSuggest = Extension.create({
  name: 'wikiCitationSuggest',
  addProseMirrorPlugins() {
    return [
      Suggestion<WikiCitationTarget, WikiCitationTarget>({
        editor: this.editor,
        char: '[[',
        allowSpaces: true,
        // After any character, not only a space: «(vedi [[» too.
        allowedPrefixes: null,
        debounce: 150,
        items: async ({ query }) => {
          // Only the latest request says when the list is ready.
          const asked = ++requests;
          suggest.loading = true;
          try {
            return await loadWikiTargets(query);
          } catch {
            return [];
          } finally {
            if (asked === requests) suggest.loading = false;
          }
        },
        command: ({ editor: current, range, props: item }) => {
          current
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'wikiCitation', attrs: { target: item.target, label: null } },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: () => ({
          onStart: (props) => {
            suggest.open = true;
            suggest.items = props.items;
            suggest.index = 0;
            suggest.command = props.command;
            place(props);
          },
          onUpdate: (props) => {
            suggest.items = props.items;
            suggest.index = Math.min(suggest.index, Math.max(0, props.items.length - 1));
            suggest.command = props.command;
            place(props);
          },
          onExit: () => {
            suggest.open = false;
            suggest.items = [];
            suggest.command = null;
          },
          onKeyDown: ({ event }: SuggestionKeyDownProps) => {
            if (!suggest.open) return false;
            if (event.key === 'ArrowDown') {
              suggest.index = suggest.items.length === 0 ? 0 : (suggest.index + 1) % suggest.items.length;
              return true;
            }
            if (event.key === 'ArrowUp') {
              suggest.index = suggest.items.length === 0 ? 0 : (suggest.index - 1 + suggest.items.length) % suggest.items.length;
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = suggest.items[suggest.index];
              if (item !== undefined) suggest.command?.(item);
              // While the list is coming, Enter waits instead of breaking the line inside «[[…».
              return item !== undefined || suggest.loading;
            }
            if (event.key === 'Escape') {
              suggest.open = false;
              return true;
            }
            return false;
          },
        }),
      }),
    ];
  },
});

function choose(item: WikiCitationTarget): void {
  suggest.command?.(item);
}

function create(text: string): void {
  frame = undefined;
  if (host.value === null) return;
  editor.value = new Editor({
    element: host.value,
    extensions: [
      ...wikiExtensions(),
      UndoRedo,
      Dropcursor,
      Gapcursor,
      Placeholder.configure({ placeholder: 'Scrivi qui. «[[» per citare una nota o una pagina.' }),
      CitationSuggest,
    ],
    content: markdownToDoc(text),
    editorProps: { attributes: { class: 'wiki-editor-content', 'aria-label': 'Testo della pagina', spellcheck: 'true' } },
    onUpdate: ({ editor: current }) => {
      emit('update:modelValue', docToMarkdown(current.getJSON()));
    },
    onTransaction: () => {
      tick.value += 1;
    },
  });
}

function destroy(): void {
  editor.value?.destroy();
  editor.value = null;
}

/** «Markdown»: the plain text and back; what is written passes from one to the other. */
function toggle(): void {
  if (mode.value === 'rich') {
    plain.value = editor.value === null ? props.modelValue : docToMarkdown(editor.value.getJSON());
    destroy();
    mode.value = 'markdown';
  } else {
    const text = plain.value;
    emit('update:modelValue', text);
    mode.value = 'rich';
    // The host is shown again on the next frame; the editor starts from the text as written.
    frame = requestAnimationFrame(() => {
      create(text);
    });
  }
}

function typed(value: string): void {
  plain.value = value;
  emit('update:modelValue', value);
}

function active(name: string, attrs?: Record<string, unknown>): boolean {
  void tick.value;
  return editor.value?.isActive(name, attrs) ?? false;
}

function inTable(): boolean {
  return active('table');
}

type Run = (editor: Editor) => void;
const buttons: { label: string; title: string; run: Run; on?: () => boolean }[] = [
  { label: 'T2', title: 'Titolo', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), on: () => active('heading', { level: 2 }) },
  { label: 'T3', title: 'Sottotitolo', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), on: () => active('heading', { level: 3 }) },
  { label: 'G', title: 'Grassetto', run: (e) => e.chain().focus().toggleBold().run(), on: () => active('bold') },
  { label: 'C', title: 'Corsivo', run: (e) => e.chain().focus().toggleItalic().run(), on: () => active('italic') },
  { label: 'S', title: 'Barrato', run: (e) => e.chain().focus().toggleStrike().run(), on: () => active('strike') },
  { label: '•', title: 'Elenco puntato', run: (e) => e.chain().focus().toggleBulletList().run(), on: () => active('bulletList') },
  { label: '1.', title: 'Elenco numerato', run: (e) => e.chain().focus().toggleOrderedList().run(), on: () => active('orderedList') },
  { label: '❝', title: 'Citazione', run: (e) => e.chain().focus().toggleBlockquote().run(), on: () => active('blockquote') },
  { label: '`c`', title: 'Codice nella riga', run: (e) => e.chain().focus().toggleCode().run(), on: () => active('code') },
  { label: '{ }', title: 'Blocco di codice', run: (e) => e.chain().focus().toggleCodeBlock().run(), on: () => active('codeBlock') },
  { label: '―', title: 'Linea di separazione', run: (e) => e.chain().focus().setHorizontalRule().run() },
  { label: '▦', title: 'Tabella', run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: '[[', title: 'Cita una nota o una pagina', run: (e) => e.chain().focus().insertContent('[[').run() },
  { label: '↶', title: 'Annulla', run: (e) => e.chain().focus().undo().run() },
  { label: '↷', title: 'Ripeti', run: (e) => e.chain().focus().redo().run() },
];
const tableButtons: { label: string; title: string; run: Run }[] = [
  { label: '+ riga', title: 'Aggiungi una riga sotto', run: (e) => e.chain().focus().addRowAfter().run() },
  { label: '+ colonna', title: 'Aggiungi una colonna a destra', run: (e) => e.chain().focus().addColumnAfter().run() },
  { label: '− riga', title: 'Togli la riga', run: (e) => e.chain().focus().deleteRow().run() },
  { label: '− colonna', title: 'Togli la colonna', run: (e) => e.chain().focus().deleteColumn().run() },
  { label: '× tabella', title: 'Togli la tabella', run: (e) => e.chain().focus().deleteTable().run() },
];

function run(action: Run): void {
  if (editor.value !== null) action(editor.value);
}

onMounted(() => {
  create(props.modelValue);
});
onBeforeUnmount(() => {
  if (frame !== undefined) cancelAnimationFrame(frame);
  destroy();
});
</script>

<template>
  <div class="wiki-editor flex flex-col gap-1.5">
    <div class="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Formato del testo">
      <template v-if="mode === 'rich'">
        <button
          v-for="button in buttons"
          :key="button.title"
          type="button"
          class="wiki-tool"
          :class="button.on?.() === true ? 'is-on' : ''"
          :title="button.title"
          :aria-label="button.title"
          :aria-pressed="button.on === undefined ? undefined : button.on()"
          @mousedown.prevent
          @click="run(button.run)"
        >
          {{ button.label }}
        </button>
        <template v-if="inTable()">
          <span class="mx-1 h-4 w-px bg-line" aria-hidden="true" />
          <button v-for="button in tableButtons" :key="button.title" type="button" class="wiki-tool" :title="button.title" :aria-label="button.title" @mousedown.prevent @click="run(button.run)">
            {{ button.label }}
          </button>
        </template>
      </template>
      <label class="ml-auto flex items-center gap-1.5 text-[12.5px] text-muted">
        <input type="checkbox" :checked="mode === 'markdown'" @change="toggle" />
        Markdown
      </label>
    </div>

    <div v-show="mode === 'rich'" ref="host" class="wiki-editor-host rounded-md border border-line bg-surface-2 px-3 py-2" />
    <textarea
      v-if="mode === 'markdown'"
      :value="plain"
      rows="20"
      class="min-h-[320px] resize-y rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[13.5px] leading-relaxed outline-none"
      aria-label="Testo della pagina in Markdown"
      spellcheck="true"
      @input="typed(($event.target as HTMLTextAreaElement).value)"
    />

    <ul
      v-if="suggest.open && mode === 'rich'"
      class="fixed z-50 max-h-64 w-[min(290px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-line bg-surface p-1 text-[13.5px] shadow-lg"
      :style="{ top: `${String(suggest.top)}px`, left: `${String(suggest.left)}px` }"
      role="listbox"
      aria-label="Note e pagine da citare"
    >
      <li v-if="suggest.items.length === 0" class="px-2 py-1 text-muted">{{ suggest.loading ? 'Cerco…' : 'Nessuna nota o pagina con queste parole.' }}</li>
      <li
        v-for="(item, at) in suggest.items"
        :key="item.target"
        role="option"
        :aria-selected="at === suggest.index"
        class="cursor-pointer rounded-md px-2 py-1"
        :class="at === suggest.index ? 'bg-surface-2 text-ink' : ''"
        @mousedown.prevent="choose(item)"
      >
        <span class="block truncate">{{ item.title }}</span>
        <span class="block truncate font-mono text-[11.5px] text-muted">{{ item.kind === 'page' ? item.target : `nota · ${item.target}` }}</span>
      </li>
    </ul>
  </div>
</template>

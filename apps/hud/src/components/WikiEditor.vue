<script setup lang="ts">
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Editor, Extension, posToDOMRect } from '@tiptap/core';
import { PluginKey, TextSelection } from '@tiptap/pm/state';
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';

import { loadWikiTargets, type WikiCitationTarget } from '../lib/api.ts';
import { BLOCK_KINDS, blockAt, canTransform, deleteBlock, duplicateBlock, kindOf, makeKind, slashItems, startBlockDrag, topBlocks, transformBlock, type BlockKind, type SlashItem } from '../lib/wiki-blocks.ts';
import { cursorInCell, docToMarkdown, markdownToDoc, wikiExtensions } from '../lib/wiki-editor.ts';
import { citationKey, citationListNote, citationTitle, nextCitationList, type WikiCitationInfo, type WikiMenuItem } from '../lib/wiki.ts';
import WikiMenu from './WikiMenu.vue';

/**
 * The editor of a page of the Wiki, always open (D-282, D-284): written
 * already formatted as in Notion. «/» opens the blocks (headings, lists,
 * quote, code, table, line, citation of a note); selecting text shows a bar
 * (bold, italic, strike, code, headings); the handle «⋮⋮» on the left of a
 * block drags it, and a click on it deletes, duplicates or turns it into
 * another kind. Citations `[[nota]]` are labels; Cmd (Ctrl) + click follows them.
 * Underneath it is Markdown, the text the core checks; «Markdown» switches
 * to the plain text. No command for links, images or HTML exists: the
 * schema has none. The right click stays the system's (copy, paste, spelling).
 */

/** `autofocus`: the cursor goes in the text as soon as the editor is ready (a new page, D-284). */
/** `citations`: what the citations of the page show (D-288), as the core gave them with the page. */
const props = defineProps<{ modelValue: string; autofocus?: boolean; citations?: Record<string, WikiCitationInfo> }>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** A click on a citation: the page of the Wiki or the note it names. */
  follow: [target: string];
}>();

const mode = ref<'rich' | 'markdown'>('rich');
const plain = ref(props.modelValue);
const host = ref<HTMLElement | null>(null);
const wrap = ref<HTMLElement | null>(null);
const editor = shallowRef<Editor | null>(null);
/** Bumped at each change of the editor: the bars read what is active again. */
const tick = ref(0);

interface ListState<T> {
  open: boolean;
  items: T[];
  index: number;
  top: number;
  left: number;
  command: ((item: T) => void) | null;
  loading: boolean;
  /** The last search failed: the list says so instead of «Nessuna» (D-288). */
  failed: boolean;
}

function listState<T>(): ListState<T> {
  return { open: false, items: [], index: 0, top: 0, left: 0, command: null, loading: false, failed: false };
}

const suggest = reactive<ListState<WikiCitationTarget>>(listState());
const slash = reactive<ListState<SlashItem>>(listState());

/** The titles of the citations chosen from the list in this session, by target: the page's `citations` do not have them yet (D-288). */
const chosenTitles = new Map<string, string>();

/** What a citation shows besides its target: the title of its note or page (D-288). */
function titleOf(target: string): string | undefined {
  return chosenTitles.get(citationKey(target)) ?? citationTitle(props.citations, target);
}

let frame: number | undefined;

function placeList(state: { top: number; left: number }, rect: DOMRect | null | undefined): void {
  if (rect === null || rect === undefined) return;
  const below = rect.bottom + 4;
  // Up when the list would leave the window at the bottom.
  state.top = below + 280 > window.innerHeight ? Math.max(8, rect.top - 284) : below;
  state.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300));
}

/** Arrows, Enter and Esc in an open list of suggestions. */
function listKeys<T>(state: ListState<T>, event: KeyboardEvent): boolean {
  if (!state.open) return false;
  const count = state.items.length;
  if (event.key === 'ArrowDown') {
    state.index = count === 0 ? 0 : (state.index + 1) % count;
    return true;
  }
  if (event.key === 'ArrowUp') {
    state.index = count === 0 ? 0 : (state.index - 1 + count) % count;
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    // While the answer for what was just typed is coming, Enter waits (neither an old item nor a new line).
    if (state.loading) return true;
    const item = state.items[state.index];
    if (item !== undefined) state.command?.(item);
    return item !== undefined;
  }
  if (event.key === 'Escape') {
    state.open = false;
    return true;
  }
  return false;
}

/** Inside code or a cell of a table «/» is only a character: a block cannot go there. */
function slashAllowed(editorState: Editor['state'], at: number): boolean {
  const $at = editorState.doc.resolve(at);
  for (let depth = $at.depth; depth > 0; depth -= 1) {
    const name = $at.node(depth).type.name;
    if (name === 'codeBlock' || name === 'tableCell' || name === 'tableHeader') return false;
  }
  return true;
}

/** «/»: the blocks a line can become, chosen with the arrows and Enter or a click. */
const SlashMenu = Extension.create({
  name: 'wikiSlashMenu',
  priority: 1100,
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('wikiSlashMenu'),
        char: '/',
        allowSpaces: false,
        allow: ({ state, range }) => slashAllowed(state as Editor['state'], range.from),
        items: ({ query }) => slashItems(query),
        command: ({ editor: current, range, props: item }) => {
          current.chain().focus().deleteRange(range).run();
          runSlash(current, item);
        },
        render: () => ({
          onStart: (state) => {
            slash.open = true;
            slash.items = state.items;
            slash.index = 0;
            slash.command = state.command;
            placeList(slash, state.clientRect?.());
          },
          onUpdate: (state) => {
            slash.items = state.items;
            slash.index = Math.min(slash.index, Math.max(0, state.items.length - 1));
            slash.command = state.command;
            placeList(slash, state.clientRect?.());
          },
          onExit: () => {
            slash.open = false;
            slash.items = [];
            slash.command = null;
          },
          onKeyDown: ({ event }: SuggestionKeyDownProps) => listKeys(slash, event),
        }),
      }),
    ];
  },
});

function runSlash(current: Editor, item: SlashItem): void {
  if (item.id === 'table') current.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  else if (item.id === 'rule') current.chain().focus().setHorizontalRule().run();
  else if (item.id === 'citation') current.chain().focus().insertContent('[[').run();
  else {
    makeKind(current, item.id);
    current.commands.focus();
  }
}

/** «[[»: a list of the notes and pages a citation may name, chosen with the arrows and Enter or a click. */
const CitationSuggest = Extension.create({
  name: 'wikiCitationSuggest',
  // Before WikiCellLines (1000): Enter in a cell of a table chooses from the open list instead of being stopped.
  priority: 1100,
  addProseMirrorPlugins() {
    return [
      Suggestion<WikiCitationTarget, WikiCitationTarget>({
        editor: this.editor,
        char: '[[',
        allowSpaces: true,
        // After any character, not only a space: «(vedi [[» too.
        allowedPrefixes: null,
        debounce: 150,
        // When the list is ready says the editor (`loading` of its state, D-288): it drops an answer when a newer search started.
        items: async ({ query, signal }) => {
          try {
            return await loadWikiTargets(query);
          } catch (failure) {
            if (!signal.aborted) suggest.failed = true;
            throw failure;
          }
        },
        command: ({ editor: current, range, props: item }) => {
          chosenTitles.set(citationKey(item.target), item.title);
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
          onStart: (state) => {
            suggest.open = true;
            Object.assign(suggest, nextCitationList({ items: [], loading: false, failed: false }, state));
            suggest.index = 0;
            suggest.command = state.command;
            placeList(suggest, state.clientRect?.());
          },
          onUpdate: (state: SuggestionProps<WikiCitationTarget, WikiCitationTarget>) => {
            const answered = suggest.loading && !state.loading;
            Object.assign(suggest, nextCitationList(suggest, state));
            // New items from an answer: the first is chosen, not the place the arrows had on the old ones.
            suggest.index = answered ? 0 : Math.min(suggest.index, Math.max(0, suggest.items.length - 1));
            suggest.command = state.command;
            placeList(suggest, state.clientRect?.());
          },
          onExit: () => {
            suggest.open = false;
            suggest.items = [];
            suggest.loading = false;
            suggest.failed = false;
            suggest.command = null;
          },
          onKeyDown: ({ event }: SuggestionKeyDownProps) => listKeys(suggest, event),
        }),
      }),
    ];
  },
});

// ---------------------------------------------------------------------------
// The bar on the selection, and the one of a table

const bubble = ref<HTMLElement | null>(null);
const bubbleShown = ref(false);
const tableBar = ref<HTMLElement | null>(null);
const tableShown = ref(false);

function inCode(current: Editor): boolean {
  return current.isActive('codeBlock');
}

async function placeBars(current: Editor): Promise<void> {
  const { selection } = current.state;
  const view = current.view;
  bubbleShown.value = view.hasFocus() && selection instanceof TextSelection && !selection.empty && !inCode(current);
  tableShown.value = view.hasFocus() && cursorInCell(current);
  await nextTick();
  if (bubbleShown.value && bubble.value !== null) {
    const { from, to } = selection;
    const reference = { getBoundingClientRect: () => posToDOMRect(view, from, to) };
    const at = await computePosition(reference, bubble.value, { placement: 'top', strategy: 'fixed', middleware: [offset(8), flip(), shift({ padding: 8 })] });
    Object.assign(bubble.value.style, { left: `${String(at.x)}px`, top: `${String(at.y)}px` });
  }
  if (tableShown.value && tableBar.value !== null) {
    const dom = view.domAtPos(selection.from).node;
    const table = (dom instanceof HTMLElement ? dom : dom.parentElement)?.closest('table');
    if (table !== null && table !== undefined) {
      const at = await computePosition(table, tableBar.value, { placement: 'top-start', strategy: 'fixed', middleware: [offset(6), flip(), shift({ padding: 8 })] });
      Object.assign(tableBar.value.style, { left: `${String(at.x)}px`, top: `${String(at.y)}px` });
    }
  }
}

function active(name: string, attrs?: Record<string, unknown>): boolean {
  void tick.value;
  return editor.value?.isActive(name, attrs) ?? false;
}

type Run = (editor: Editor) => void;
const marks: { label: string; title: string; run: Run; on: () => boolean; style?: string }[] = [
  { label: 'G', title: 'Grassetto', run: (e) => e.chain().focus().toggleBold().run(), on: () => active('bold'), style: 'font-weight: 700' },
  { label: 'C', title: 'Corsivo', run: (e) => e.chain().focus().toggleItalic().run(), on: () => active('italic'), style: 'font-style: italic' },
  { label: 'S', title: 'Barrato', run: (e) => e.chain().focus().toggleStrike().run(), on: () => active('strike'), style: 'text-decoration: line-through' },
  { label: '</>', title: 'Codice', run: (e) => e.chain().focus().toggleCode().run(), on: () => active('code') },
  { label: 'T1', title: 'Titolo 1', run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), on: () => active('heading', { level: 1 }) },
  { label: 'T2', title: 'Titolo 2', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), on: () => active('heading', { level: 2 }) },
  { label: 'T3', title: 'Titolo 3', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), on: () => active('heading', { level: 3 }) },
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

// ---------------------------------------------------------------------------
// The handle «⋮⋮» of a block

const handle = reactive<{ shown: boolean; pos: number; top: number }>({ shown: false, pos: -1, top: 0 });
const blockMenu = ref<{ x: number; y: number; pos: number } | null>(null);
let hoverFrame: number | undefined;

/** The block under the pointer, by its height on the page: the handle goes next to its first line. */
function hover(event: MouseEvent): void {
  if (blockMenu.value !== null || hoverFrame !== undefined) return;
  const y = event.clientY;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = undefined;
    const current = editor.value;
    if (current === null || wrap.value === null) return;
    const base = wrap.value.getBoundingClientRect();
    for (const { pos } of topBlocks(current.state.doc)) {
      const dom = current.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) continue;
      const rect = dom.getBoundingClientRect();
      if (y >= rect.top - 4 && y <= rect.bottom + 4) {
        handle.shown = true;
        handle.pos = pos;
        handle.top = rect.top - base.top + Math.min(rect.height, 26) / 2 - 12;
        return;
      }
    }
  });
}

function leave(event: MouseEvent): void {
  if (blockMenu.value !== null) return;
  if (event.relatedTarget instanceof Node && wrap.value?.contains(event.relatedTarget) === true) return;
  handle.shown = false;
}

function dragStart(event: DragEvent): void {
  const current = editor.value;
  if (current === null || handle.pos < 0) return;
  const dom = current.view.nodeDOM(handle.pos);
  startBlockDrag(current.view, handle.pos, event, dom instanceof HTMLElement ? dom : null);
}

function dragEnd(): void {
  handle.shown = false;
  // The handle is outside the text: ProseMirror's own dragend never runs, so the drag is forgotten here
  // (after the drop, as ProseMirror does), or a later drop would still move the old block over the selection.
  const view = editor.value?.view;
  setTimeout(() => {
    if (view !== undefined && !view.isDestroyed) view.dragging = null;
  }, 50);
}

function openBlockMenu(event: MouseEvent): void {
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
  blockMenu.value = { x: target === null ? event.clientX : target.right + 4, y: target === null ? event.clientY : target.top, pos: handle.pos };
}

const blockItems = computed<WikiMenuItem[]>(() => {
  void tick.value;
  const at = blockMenu.value;
  const node = at === null || editor.value === null ? null : blockAt(editor.value.state.doc, at.pos);
  if (node === null) return [];
  const now = kindOf(node);
  const transformable = canTransform(node);
  return [
    { id: 'delete', text: 'Elimina', danger: true },
    { id: 'duplicate', text: 'Duplica' },
    { id: 'transform', text: 'Trasforma in', group: true },
    ...BLOCK_KINDS.map(({ kind, text }) => ({ id: `to:${kind}`, text, on: now === kind, ...(transformable ? {} : { off: 'Una tabella o una linea restano come sono.' }) })),
  ];
});

/** Esc or a click outside: the menu goes, the cursor goes back in the text. */
function closeBlockMenu(): void {
  blockMenu.value = null;
  handle.shown = false;
  editor.value?.commands.focus();
}

function chooseBlock(id: string): void {
  const current = editor.value;
  const at = blockMenu.value;
  blockMenu.value = null;
  handle.shown = false;
  if (current === null || at === null) return;
  if (id === 'delete') deleteBlock(current, at.pos);
  else if (id === 'duplicate') duplicateBlock(current, at.pos);
  else if (id.startsWith('to:')) transformBlock(current, at.pos, id.slice(3) as BlockKind);
  // The cursor at the end of what changed, not a selection with its bar.
  current.chain().focus().setTextSelection(current.state.selection.to).run();
}

// ---------------------------------------------------------------------------

function create(text: string): void {
  frame = undefined;
  if (host.value === null) return;
  editor.value = new Editor({
    element: host.value,
    extensions: [
      ...wikiExtensions(titleOf),
      UndoRedo,
      Dropcursor.configure({ color: 'var(--accent)', width: 2 }),
      Gapcursor,
      Placeholder.configure({ placeholder: 'Scrivi qui, «/» per i blocchi, «[[» per citare una nota o una pagina' }),
      SlashMenu,
      CitationSuggest,
    ],
    content: markdownToDoc(text),
    editorProps: {
      attributes: { class: 'wiki-editor-content', 'aria-label': 'Testo della pagina', spellcheck: 'true' },
      // A citation leads, as in Notion, with Cmd (Ctrl) + click: to the page of the Wiki, or to the note in Conoscenza.
      // A plain click places the cursor, as on any other text.
      handleClickOn: (_view, _pos, node, _nodePos, event) => {
        if (node.type.name !== 'wikiCitation' || !(event.metaKey || event.ctrlKey)) return false;
        const target = typeof node.attrs.target === 'string' ? node.attrs.target : '';
        if (target !== '') emit('follow', target);
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      // The blocks moved: the handle shows again at the next move of the pointer, never on an old place.
      if (blockMenu.value === null) handle.shown = false;
      emit('update:modelValue', docToMarkdown(current.getJSON()));
    },
    onTransaction: ({ editor: current }) => {
      tick.value += 1;
      void placeBars(current);
    },
    onBlur: () => {
      bubbleShown.value = false;
      tableShown.value = false;
    },
    onFocus: ({ editor: current }) => {
      void placeBars(current);
    },
  });
  if (props.autofocus === true) editor.value.commands.focus('end');
}

function destroy(): void {
  editor.value?.destroy();
  editor.value = null;
  bubbleShown.value = false;
  tableShown.value = false;
  handle.shown = false;
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

/** The cursor at the start of the text: Enter in the title goes here, as in Notion. */
function focus(): void {
  editor.value?.chain().focus('start').run();
}
defineExpose({ focus });

onMounted(() => {
  create(props.modelValue);
});
onBeforeUnmount(() => {
  if (frame !== undefined) cancelAnimationFrame(frame);
  if (hoverFrame !== undefined) cancelAnimationFrame(hoverFrame);
  destroy();
});
</script>

<template>
  <div class="wiki-editor flex flex-col gap-2">
    <div ref="wrap" class="relative md:-ml-9 md:pl-9" @mousemove="hover" @mouseleave="leave">
      <button
        v-if="mode === 'rich' && handle.shown"
        type="button"
        class="wiki-handle absolute left-1 grid h-6 w-6 cursor-grab place-items-center rounded text-muted hover:bg-surface-2 hover:text-ink"
        :style="{ top: `${String(handle.top)}px` }"
        draggable="true"
        title="Trascina per spostare il blocco, clic per le azioni"
        aria-label="Azioni del blocco"
        aria-haspopup="menu"
        :aria-expanded="blockMenu !== null"
        @dragstart="dragStart"
        @dragend="dragEnd"
        @click="openBlockMenu"
      >
        <span aria-hidden="true" class="text-[13px] leading-none tracking-[-2px]">⋮⋮</span>
      </button>
      <div v-show="mode === 'rich'" ref="host" class="wiki-editor-host" />
      <textarea
        v-if="mode === 'markdown'"
        :value="plain"
        rows="20"
        class="min-h-[360px] w-full resize-y rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[13.5px] leading-relaxed outline-none"
        aria-label="Testo della pagina in Markdown"
        spellcheck="true"
        @input="typed(($event.target as HTMLTextAreaElement).value)"
      />
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2 text-[12.5px] text-muted">
      <span class="min-w-0 flex-1">«/» per i blocchi · «[[» per citare (⌘ o Ctrl + clic la apre) · ⋮⋮ a sinistra per spostare un blocco. Niente link, immagini o indirizzi: la pagina resta sul Mac.</span>
      <label class="flex items-center gap-1.5">
        <input type="checkbox" :checked="mode === 'markdown'" @change="toggle" />
        Markdown
      </label>
    </div>

    <!-- The bar on the selection -->
    <div v-if="mode === 'rich' && bubbleShown" ref="bubble" class="fixed z-40 flex items-center gap-0.5 rounded-lg border border-line-strong bg-surface p-0.5 shadow-lg" role="toolbar" aria-label="Formato del testo selezionato">
      <button
        v-for="mark in marks"
        :key="mark.title"
        type="button"
        class="wiki-tool"
        :class="mark.on() ? 'is-on' : ''"
        :style="mark.style"
        :title="mark.title"
        :aria-label="mark.title"
        :aria-pressed="mark.on()"
        @mousedown.prevent
        @click="run(mark.run)"
      >
        {{ mark.label }}
      </button>
    </div>

    <!-- The bar of a table, while the cursor is in a cell -->
    <div v-if="mode === 'rich' && tableShown && !bubbleShown" ref="tableBar" class="fixed z-30 flex flex-wrap items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow" role="toolbar" aria-label="Righe e colonne della tabella">
      <button v-for="button in tableButtons" :key="button.title" type="button" class="wiki-tool" :title="button.title" :aria-label="button.title" @mousedown.prevent @click="run(button.run)">
        {{ button.label }}
      </button>
    </div>

    <WikiMenu v-if="blockMenu !== null" :items="blockItems" :x="blockMenu.x" :y="blockMenu.y" label="Azioni del blocco" @choose="chooseBlock" @close="closeBlockMenu" />

    <ul
      v-if="slash.open && mode === 'rich'"
      class="fixed z-50 max-h-72 w-[min(290px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-line bg-surface p-1 text-[13.5px] shadow-lg"
      :style="{ top: `${String(slash.top)}px`, left: `${String(slash.left)}px` }"
      role="listbox"
      aria-label="Blocchi"
    >
      <li v-if="slash.items.length === 0" class="px-2 py-1 text-muted">Nessun blocco con queste parole.</li>
      <li
        v-for="(item, at) in slash.items"
        :key="item.id"
        role="option"
        :aria-selected="at === slash.index"
        class="cursor-pointer rounded-md px-2 py-1"
        :class="at === slash.index ? 'bg-surface-2 text-ink' : ''"
        @mousedown.prevent="slash.command?.(item)"
      >
        <span class="block truncate">{{ item.text }}</span>
        <span class="block truncate text-[11.5px] text-muted">{{ item.hint }}</span>
      </li>
    </ul>

    <ul
      v-if="suggest.open && mode === 'rich'"
      class="fixed z-50 max-h-64 w-[min(290px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-line bg-surface p-1 text-[13.5px] shadow-lg"
      :style="{ top: `${String(suggest.top)}px`, left: `${String(suggest.left)}px` }"
      role="listbox"
      aria-label="Note e pagine da citare"
    >
      <li v-if="citationListNote(suggest) !== null" class="px-2 py-1 text-muted">{{ citationListNote(suggest) }}</li>
      <li
        v-for="(item, at) in suggest.items"
        :key="item.target"
        role="option"
        :aria-selected="at === suggest.index"
        class="cursor-pointer rounded-md px-2 py-1"
        :class="at === suggest.index ? 'bg-surface-2 text-ink' : ''"
        @mousedown.prevent="suggest.command?.(item)"
      >
        <span class="block truncate">{{ item.title }}</span>
        <span class="block truncate font-mono text-[11.5px] text-muted">{{ item.kind === 'page' ? item.target : `nota · ${item.target}` }}</span>
      </li>
    </ul>
  </div>
</template>

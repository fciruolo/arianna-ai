import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * The blocks of a page of the Wiki as Notion has them (D-284): the «/» menu
 * that turns the line into a heading, a list, a table…; the handle «⋮⋮» on
 * the left of each block that drags it, deletes it, duplicates it or turns
 * it into another kind. Only what the schema of D-282 has: no link, image or
 * HTML. Pure functions over the editor, tested without a browser.
 */

/** What a block can become with «Trasforma in…» (and what «/» makes of the line). */
export type BlockKind = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'bulletList' | 'orderedList' | 'taskList' | 'blockquote' | 'codeBlock';

export const BLOCK_KINDS: readonly { kind: BlockKind; text: string }[] = [
  { kind: 'paragraph', text: 'Testo' },
  { kind: 'heading1', text: 'Titolo 1' },
  { kind: 'heading2', text: 'Titolo 2' },
  { kind: 'heading3', text: 'Titolo 3' },
  { kind: 'bulletList', text: 'Elenco puntato' },
  { kind: 'orderedList', text: 'Elenco numerato' },
  { kind: 'taskList', text: 'Elenco da fare' },
  { kind: 'blockquote', text: 'Citazione' },
  { kind: 'codeBlock', text: 'Codice' },
];

export type SlashId = BlockKind | 'table' | 'rule' | 'citation';

export interface SlashItem {
  id: SlashId;
  text: string;
  hint: string;
  /** Other words that find it: «h1», «lista», «todo»… */
  words: readonly string[];
}

/** The «/» menu, in the order Notion shows it. */
export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'paragraph', text: 'Testo', hint: 'Un paragrafo semplice', words: ['paragrafo', 'testo', 'text'] },
  { id: 'heading1', text: 'Titolo 1', hint: 'Titolo grande di sezione', words: ['h1', 'titolo', 'heading'] },
  { id: 'heading2', text: 'Titolo 2', hint: 'Titolo medio', words: ['h2', 'titolo', 'heading'] },
  { id: 'heading3', text: 'Titolo 3', hint: 'Titolo piccolo', words: ['h3', 'titolo', 'heading'] },
  { id: 'bulletList', text: 'Elenco puntato', hint: 'Un elenco semplice', words: ['lista', 'punti', 'bullet', 'ul'] },
  { id: 'orderedList', text: 'Elenco numerato', hint: 'Un elenco con i numeri', words: ['lista', 'numeri', 'ol'] },
  { id: 'taskList', text: 'Elenco da fare', hint: 'Cose da spuntare', words: ['lista', 'todo', 'cose', 'checkbox', 'spunta'] },
  { id: 'blockquote', text: 'Citazione', hint: 'Un brano messo in evidenza', words: ['quote', 'citazione'] },
  { id: 'codeBlock', text: 'Codice', hint: 'Un blocco di codice', words: ['code', 'codice', 'pre'] },
  { id: 'table', text: 'Tabella', hint: 'Tre righe e tre colonne', words: ['tabella', 'table', 'griglia'] },
  { id: 'rule', text: 'Linea', hint: 'Una linea di separazione', words: ['linea', 'separatore', 'hr', 'divider'] },
  { id: 'citation', text: 'Citazione di nota', hint: '«[[» cita una nota o una pagina', words: ['nota', 'pagina', 'wiki', '[['] },
];

function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** The entries of «/» that the words typed after it find; all of them for nothing typed. */
export function slashItems(query: string): SlashItem[] {
  const words = folded(query).split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter((item) => {
    const hay = [item.text, ...item.words].map(folded);
    return words.every((word) => hay.some((piece) => piece.includes(word)));
  });
}

/** The top-level block at `pos` (the position just before it), or null. */
export function blockAt(doc: PmNode, pos: number): PmNode | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  const $pos = doc.resolve(pos);
  if ($pos.depth !== 0) return null;
  return doc.nodeAt(pos);
}

/** Whether a block can become another kind: not a table nor a line. */
export function canTransform(node: PmNode): boolean {
  return node.type.name !== 'table' && node.type.name !== 'horizontalRule';
}

/** The kind a block is now, for «Trasforma in…» to mark it; null for a table or a line. */
export function kindOf(node: PmNode): BlockKind | null {
  switch (node.type.name) {
    case 'paragraph':
      return 'paragraph';
    case 'heading': {
      const level = Number(node.attrs.level);
      return level === 1 ? 'heading1' : level === 2 ? 'heading2' : level === 3 ? 'heading3' : null;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
    case 'blockquote':
    case 'codeBlock':
      return node.type.name;
    default:
      return null;
  }
}

/**
 * The lines of a block as plain paragraphs, each with its text and marks:
 * a list, a quote or a code block taken apart before it becomes another kind.
 */
function plainLines(node: PmNode, paragraph: NonNullable<PmNode['type']['schema']['nodes']['paragraph']>): PmNode[] {
  const line = (block: PmNode): PmNode => {
    if (block.type.name !== 'codeBlock') return paragraph.create(null, block.content);
    return paragraph.create(null, block.textContent === '' ? null : paragraph.schema.text(block.textContent));
  };
  if (node.isTextblock) {
    // A code block is one line per line of code.
    if (node.type.name === 'codeBlock') return node.textContent.split('\n').map((text) => paragraph.create(null, text === '' ? null : paragraph.schema.text(text)));
    return [line(node)];
  }
  const out: PmNode[] = [];
  node.descendants((child) => {
    if (!child.isTextblock) return true;
    out.push(...plainLines(child, paragraph));
    return false;
  });
  return out.length === 0 ? [paragraph.create()] : out;
}

/** Makes the line of the cursor (or the lines selected) a block of `kind`: «/» and «Trasforma in…». */
export function makeKind(editor: Editor, kind: BlockKind): boolean {
  const chain = editor.chain();
  switch (kind) {
    case 'paragraph':
      return chain.setParagraph().run();
    case 'heading1':
      return chain.setHeading({ level: 1 }).run();
    case 'heading2':
      return chain.setHeading({ level: 2 }).run();
    case 'heading3':
      return chain.setHeading({ level: 3 }).run();
    case 'bulletList':
      return chain.toggleBulletList().run();
    case 'orderedList':
      return chain.toggleOrderedList().run();
    case 'taskList':
      return chain.toggleTaskList().run();
    case 'blockquote':
      return chain.setBlockquote().run();
    case 'codeBlock':
      return chain.setCodeBlock().run();
  }
}

/** «Trasforma in…» of the handle: the whole block at `pos` becomes `kind`. */
export function transformBlock(editor: Editor, pos: number, kind: BlockKind): boolean {
  const node = blockAt(editor.state.doc, pos);
  const { paragraph, codeBlock } = editor.state.schema.nodes;
  if (node === null || !canTransform(node) || paragraph === undefined || codeBlock === undefined) return false;
  const lines = plainLines(node, paragraph);
  if (kind === 'codeBlock') {
    // All the lines in one block of code.
    const text = lines.map((line) => line.textContent).join('\n');
    return editor
      .chain()
      .command(({ tr }) => {
        tr.replaceWith(pos, pos + node.nodeSize, codeBlock.create(null, text === '' ? null : editor.state.schema.text(text)));
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
        return true;
      })
      .run();
  }
  const size = lines.reduce((sum, line) => sum + line.nodeSize, 0);
  const taken = editor
    .chain()
    .command(({ tr }) => {
      tr.replaceWith(pos, pos + node.nodeSize, lines);
      tr.setSelection(TextSelection.between(tr.doc.resolve(pos + 1), tr.doc.resolve(pos + size - 1)));
      return true;
    })
    .run();
  return taken && (kind === 'paragraph' || makeKind(editor, kind));
}

/** «Duplica»: the same block again, just below. */
export function duplicateBlock(editor: Editor, pos: number): boolean {
  const node = blockAt(editor.state.doc, pos);
  if (node === null) return false;
  return editor
    .chain()
    .command(({ tr }) => {
      tr.insert(pos + node.nodeSize, node);
      return true;
    })
    .run();
}

/** «Elimina»: the block goes; the last block of the page leaves an empty line to write on. */
export function deleteBlock(editor: Editor, pos: number): boolean {
  const { doc, schema } = editor.state;
  const node = blockAt(doc, pos);
  if (node === null) return false;
  const paragraph = schema.nodes.paragraph;
  return editor
    .chain()
    .command(({ tr }) => {
      if (doc.childCount === 1 && paragraph !== undefined) tr.replaceWith(pos, pos + node.nodeSize, paragraph.create());
      else tr.delete(pos, pos + node.nodeSize);
      return true;
    })
    .run();
}

/** The top-level blocks with their place, for the handle to find the one under the pointer. */
export function topBlocks(doc: PmNode): { pos: number; node: PmNode }[] {
  const out: { pos: number; node: PmNode }[] = [];
  doc.forEach((node, offset) => {
    out.push({ pos: offset, node });
  });
  return out;
}

/**
 * The drag of the handle: the block becomes the selection and ProseMirror
 * moves it where it is dropped, as a drag started inside the text would
 * (the drop cursor shows where). Nothing leaves the page: only the block's
 * own text goes in the drag data.
 */
export function startBlockDrag(view: EditorView, pos: number, event: DragEvent, image: HTMLElement | null): boolean {
  const node = blockAt(view.state.doc, pos);
  if (node === null || event.dataTransfer === null) return false;
  const selection = NodeSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(selection));
  const slice = selection.content();
  event.dataTransfer.clearData();
  event.dataTransfer.setData('text/plain', node.textContent);
  event.dataTransfer.effectAllowed = 'copyMove';
  if (image !== null) event.dataTransfer.setDragImage(image, 0, 0);
  // prosemirror-view 1.42.6 declares `dragging` as { slice, move }, while its drop handler also reads `node`
  // (its own Dragging class has it): with `node` the drop replaces exactly the block dragged, whatever the
  // selection is by then. A variable of the wider type is assignable without a cast.
  const drag: NonNullable<EditorView['dragging']> & { node: NodeSelection } = { slice, move: true, node: selection };
  view.dragging = drag;
  return true;
}

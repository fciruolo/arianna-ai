import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Italic } from '@tiptap/extension-italic';
import { BulletList, ListItem, ListKeymap, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Text } from '@tiptap/extension-text';
import { Extension, Node, nodeInputRule, nodePasteRule, type AnyExtension, type Editor, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';

/**
 * The editor of the Wiki (D-282): what the user writes already formatted is
 * Markdown underneath, the same text the core checks on save (D-280). Only
 * what a page may hold is in the schema: headings, bold, italic, strike,
 * lists, quotes, code, tables, rules and the citations `[[nota]]`. There is
 * no link, image or HTML node or mark: a link pasted or typed stays text,
 * and the save refuses an address with the line, as in the plain editor.
 */

/** A citation as written: `[[target]]` or `[[target|label]]`, on one line. */
const CITATION = /^\[\[([^[\]\n|]{1,400})(?:\|([^[\]\n]{1,400}))?\]\]/;

export interface CitationAttrs {
  /** What goes between the brackets: a note's vault id (`inbox/x`) or `wiki/<page>`. */
  target: string;
  /** The text after `|`, when the citation has one. */
  label: string | null;
}

/** What a citation shows: its label, or the last part of its target. */
export function citationText(attrs: CitationAttrs): string {
  if (attrs.label !== null && attrs.label !== '') return attrs.label;
  return attrs.target.split('/').at(-1) ?? attrs.target;
}

/** A citation back to Markdown, as the core reads it. */
export function citationMarkdown(attrs: CitationAttrs): string {
  return `[[${attrs.target}${attrs.label !== null && attrs.label !== '' ? `|${attrs.label}` : ''}]]`;
}

function attrsOf(value: Record<string, unknown> | undefined): CitationAttrs {
  const target = typeof value?.target === 'string' ? value.target : '';
  const label = typeof value?.label === 'string' ? value.label : null;
  return { target, label };
}

/** The citation `[[nota]]` as a label in the editor: one piece, never a link. */
export const WikiCitation = Node.create({
  name: 'wikiCitation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      target: { default: '' },
      label: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-citation]',
        getAttrs: (element) => (typeof element === 'string' ? false : { target: element.getAttribute('data-target') ?? '', label: element.getAttribute('data-label') }),
      },
    ];
  },

  renderHTML({ node }) {
    const attrs = attrsOf(node.attrs);
    return [
      'span',
      { 'data-wiki-citation': '', 'data-target': attrs.target, ...(attrs.label === null ? {} : { 'data-label': attrs.label }), class: 'wiki-citation', title: citationMarkdown(attrs) },
      citationText(attrs),
    ];
  },

  renderText({ node }) {
    return citationMarkdown(attrsOf(node.attrs));
  },

  // Typing or pasting `[[nota]]` makes the label at once, so it goes back to Markdown as a citation.
  addInputRules() {
    return [nodeInputRule({ find: /\[\[([^[\]\n|]{1,400})(?:\|([^[\]\n]{1,400}))?\]\]$/, type: this.type, getAttributes: (match) => ({ target: (match[1] ?? '').trim(), label: match[2]?.trim() ?? null }) })];
  },

  addPasteRules() {
    return [nodePasteRule({ find: /\[\[([^[\]\n|]{1,400})(?:\|([^[\]\n]{1,400}))?\]\]/g, type: this.type, getAttributes: (match) => ({ target: (match[1] ?? '').trim(), label: match[2]?.trim() ?? null }) })];
  },

  markdownTokenName: 'wikiCitation',
  markdownTokenizer: {
    name: 'wikiCitation',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize: (src: string) => {
      const match = CITATION.exec(src);
      if (match === null) return undefined;
      return { type: 'wikiCitation', raw: match[0], target: (match[1] ?? '').trim(), label: match[2]?.trim() ?? null };
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode('wikiCitation', { target: String(token.target ?? ''), label: typeof token.label === 'string' ? token.label : null }),
  renderMarkdown: (node) => citationMarkdown(attrsOf(node.attrs)),
});

/** Whether the cursor of the editor is inside a cell of a table. */
export function cursorInCell(editor: Pick<Editor, 'state'>): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

/**
 * A cell of a table is one line of Markdown: Enter, Shift+Enter and
 * Mod+Enter add no line inside it, which the serializer would write as
 * `<br>` and the core would refuse as HTML (D-282).
 */
export const WikiCellLines = Extension.create({
  name: 'wikiCellLines',
  priority: 1000,
  addKeyboardShortcuts() {
    const stay = (): boolean => cursorInCell(this.editor);
    return { Enter: stay, 'Shift-Enter': stay, 'Mod-Enter': stay };
  },
});

/** The inline content of a cell on one line: blocks and line breaks become a space. */
function cellLine(cell: JSONContent): JSONContent {
  const inline: JSONContent[] = [];
  const space = (): void => {
    const last = inline.at(-1);
    if (last !== undefined && !(last.type === 'text' && /\s$/.test(last.text ?? ''))) inline.push({ type: 'text', text: ' ' });
  };
  const walk = (node: JSONContent): void => {
    if (node.type === 'hardBreak') {
      space();
      return;
    }
    if (node.type === 'text') {
      const text = (node.text ?? '').replace(/\s*\n\s*/g, ' ');
      if (text !== '') inline.push({ ...node, text });
      return;
    }
    if (node.type === 'wikiCitation') {
      inline.push(node);
      return;
    }
    // A block (paragraph, list, code…) inside the cell: its content, then a space before the next.
    if (inline.length > 0) space();
    for (const child of node.content ?? []) walk(child);
  };
  for (const child of cell.content ?? []) walk(child);
  while (inline.at(-1)?.type === 'text' && inline.at(-1)?.text === ' ') inline.pop();
  return { ...cell, content: [{ type: 'paragraph', ...(inline.length > 0 ? { content: inline } : {}) }] };
}

/**
 * The document with every cell of a table on one line (D-282): a line break
 * or a second paragraph in a cell, pasted or from an older page, goes back
 * to Markdown as a space, never as `<br>`.
 */
export function flattenCells(doc: JSONContent): JSONContent {
  if (doc.type === 'tableCell' || doc.type === 'tableHeader') return cellLine(doc);
  if (doc.content === undefined) return doc;
  return { ...doc, content: doc.content.map(flattenCells) };
}

/** The schema of a page: nothing that could load or follow something. */
export function wikiExtensions(): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    Heading.configure({ levels: [1, 2, 3, 4] }),
    Bold,
    Italic,
    Strike,
    Code,
    CodeBlock,
    Blockquote,
    BulletList,
    OrderedList,
    ListItem,
    ListKeymap,
    TaskList,
    TaskItem.configure({ nested: true }),
    HardBreak,
    HorizontalRule,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    WikiCitation,
    WikiCellLines,
  ];
}

let manager: MarkdownManager | undefined;
function markdown(): MarkdownManager {
  manager ??= new MarkdownManager({ extensions: wikiExtensions() });
  return manager;
}

/** The text of a page (Markdown) as the editor's document. */
export function markdownToDoc(text: string): JSONContent {
  return markdown().parse(text);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** The entities of a piece of text outside code back to characters. */
function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** A line with its code spans (a run of backticks to the same run) kept as written, the rest decoded. */
function decodeOutsideSpans(line: string): string {
  let out = '';
  let at = 0;
  while (at < line.length) {
    const open = line.indexOf('`', at);
    if (open === -1) break;
    let run = open;
    while (line.charAt(run) === '`') run += 1;
    const ticks = line.slice(open, run);
    const close = line.indexOf(ticks, run);
    if (close === -1) break;
    out += decode(line.slice(at, open)) + line.slice(open, close + ticks.length);
    at = close + ticks.length;
  }
  return out + decode(line.slice(at));
}

/**
 * The entities the serializer writes (`R&amp;D`, `a &lt; b`) back to the
 * characters, outside code (spans and fenced blocks, also inside quotes and
 * lists): the page shows the text as written, and the core sees a `<` that
 * opens a tag for what it is and refuses it. Code stays as the user wrote it.
 */
export function plainEntities(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^[\s>]*(-\s+|\d+[.)]\s+)?(`{3,}|~{3,})/.exec(line)?.[2];
      if (marker !== undefined && (fence === null || marker.startsWith(fence))) {
        fence = fence === null ? marker : null;
        return line;
      }
      return fence !== null ? line : decodeOutsideSpans(line);
    })
    .join('\n');
}

/** The editor's document back to Markdown, what the save sends to the core. */
/**
 * The document without its empty paragraphs between blocks: the serializer
 * writes one as `&nbsp;`, which the page then shows as text (the line the
 * editor leaves before a table, D-282). A blank line says the same in Markdown.
 */
export function withoutEmptyParagraphs(doc: JSONContent): JSONContent {
  const empty = (node: JSONContent): boolean =>
    node.type === 'paragraph' && (node.content ?? []).every((child) => child.type === 'text' && (child.text ?? '').trim() === '');
  const content = doc.content?.filter((node) => !empty(node)).map((node) => (node.type === 'blockquote' ? withoutEmptyParagraphs(node) : node));
  return content === undefined ? doc : { ...doc, content };
}

export function docToMarkdown(doc: JSONContent): string {
  return `${plainEntities(markdown().serialize(flattenCells(withoutEmptyParagraphs(doc)))).replace(/\s+$/, '')}\n`;
}

/** Whether the document holds a mark or node the schema of a page does not know (never: the schema has no link). */
export function unknownTypes(doc: JSONContent): string[] {
  const known = new Set(['doc', 'paragraph', 'text', 'heading', 'bold', 'italic', 'strike', 'code', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'hardBreak', 'horizontalRule', 'table', 'tableRow', 'tableHeader', 'tableCell', 'wikiCitation']);
  const found = new Set<string>();
  const walk = (node: JSONContent): void => {
    if (node.type !== undefined && !known.has(node.type)) found.add(node.type);
    for (const mark of node.marks ?? []) if (!known.has(mark.type)) found.add(mark.type);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return [...found];
}

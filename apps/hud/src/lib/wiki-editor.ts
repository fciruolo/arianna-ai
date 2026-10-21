import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Italic } from '@tiptap/extension-italic';
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Text } from '@tiptap/extension-text';
import { Node, nodeInputRule, nodePasteRule, type AnyExtension, type JSONContent } from '@tiptap/core';
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
    HardBreak,
    HorizontalRule,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    WikiCitation,
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

/** The editor's document back to Markdown, what the save sends to the core. */
export function docToMarkdown(doc: JSONContent): string {
  return `${markdown().serialize(doc).replace(/\s+$/, '')}\n`;
}

/** Whether the document holds a mark or node the schema of a page does not know (never: the schema has no link). */
export function unknownTypes(doc: JSONContent): string[] {
  const known = new Set(['doc', 'paragraph', 'text', 'heading', 'bold', 'italic', 'strike', 'code', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'hardBreak', 'horizontalRule', 'table', 'tableRow', 'tableHeader', 'tableCell', 'wikiCitation']);
  const found = new Set<string>();
  const walk = (node: JSONContent): void => {
    if (node.type !== undefined && !known.has(node.type)) found.add(node.type);
    for (const mark of node.marks ?? []) if (!known.has(mark.type)) found.add(mark.type);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return [...found];
}

<script lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, ref, type PropType, type VNode, type VNodeChild } from 'vue';

import { copyText, COPY_FEEDBACK_MS, type ClipboardLike, type CopyResult } from '../lib/clipboard.ts';
import { COPY_TEXT } from '../lib/italian.ts';
import { inlineText, parseMarkdown, safeHref, type Block, type Inline } from '../lib/markdown.ts';
import Icon from './Icon.vue';

/**
 * A reply's Markdown as Vue nodes (D-065): the tree of lib/markdown.ts, never
 * v-html. Links open in a new tab without referrer; when the label is not the
 * address, the address's host is shown next to it, so a link cannot hide
 * where it goes. `cursor` adds the blinking cursor of a reply still arriving.
 */
/**
 * "Copia" in the top right corner of a code block (D-084): the exact text of
 * the block, then "Copiato" for two seconds, or "Copia non disponibile" when
 * the page has no clipboard (plain HTTP from the phone).
 */
const CopyButton = defineComponent({
  name: 'CopyButton',
  props: {
    text: { type: String, required: true },
    lang: { type: String as PropType<string | null>, default: null },
  },
  setup(props) {
    const state = ref<'idle' | CopyResult>('idle');
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function copy(): Promise<void> {
      // navigator.clipboard is undefined outside a secure context, whatever the types say.
      const clipboard = (navigator as { clipboard?: ClipboardLike }).clipboard;
      state.value = await copyText(props.text, clipboard);
      clearTimeout(timer);
      timer = setTimeout(() => (state.value = 'idle'), COPY_FEEDBACK_MS);
    }
    onBeforeUnmount(() => clearTimeout(timer));
    return () =>
      h('div', { class: 'md-code-bar' }, [
        props.lang === null ? null : h('span', { class: 'md-code-lang' }, props.lang),
        h(
          'button',
          { type: 'button', class: ['md-copy', { 'md-copy-off': state.value === 'unavailable' }], onClick: () => void copy() },
          [h(Icon, { name: state.value === 'copied' ? 'saved' : 'copy', size: 12 }), h('span', { 'aria-live': 'polite' }, COPY_TEXT[state.value])],
        ),
      ]);
  },
});

function inline(node: Inline): VNodeChild {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'break':
      return h('br');
    case 'code':
      return h('code', node.text);
    case 'strong':
      return h('strong', node.children.map(inline));
    case 'em':
      return h('em', node.children.map(inline));
    case 'strike':
      return h('s', node.children.map(inline));
    case 'link': {
      const url = new URL(node.href);
      const where = url.protocol === 'mailto:' ? url.pathname || node.href : url.host;
      // Compared normalized: a bare URL is its own label even when URL adds a slash or lowercases the host.
      const label = inlineText(node.children);
      const anchor = h('a', { href: node.href, target: '_blank', rel: 'noopener noreferrer nofollow', referrerpolicy: 'no-referrer', title: node.href }, node.children.map(inline));
      return safeHref(label) === node.href || label === where ? anchor : [anchor, h('span', { class: 'md-host' }, where)];
    }
  }
}

function block(node: Block, tail: VNode[] = []): VNode {
  switch (node.kind) {
    case 'paragraph':
      return h('p', [...node.inlines.map(inline), ...tail]);
    case 'heading':
      return h(`h${node.level}`, [...node.inlines.map(inline), ...tail]);
    case 'code':
      return h('div', { class: 'md-code' }, [
        h('pre', node.lang === null ? {} : { 'data-lang': node.lang }, [h('code', node.text), ...tail]),
        h(CopyButton, { text: node.text, lang: node.lang }),
      ]);
    case 'list':
      return h(
        node.ordered ? 'ol' : 'ul',
        node.ordered && node.start !== 1 ? { start: node.start } : {},
        node.items.map((item, index) => h('li', blocks(item, index === node.items.length - 1 ? tail : []))),
      );
    case 'quote':
      return h('blockquote', blocks(node.blocks, tail));
    case 'rule':
      return tail.length === 0 ? h('hr') : h('div', [h('hr'), ...tail]);
    case 'table': {
      const style = (index: number): Record<string, string> => (node.align[index] === null ? {} : { textAlign: node.align[index] as string });
      return h('div', { class: 'md-table' }, [
        h('table', [
          h('thead', h('tr', node.head.map((cell, index) => h('th', { style: style(index) }, cell.map(inline))))),
          h('tbody', node.rows.map((row) => h('tr', row.map((cell, index) => h('td', { style: style(index) }, cell.map(inline)))))),
        ]),
        ...tail,
      ]);
    }
  }
}

/** The blocks, with `tail` (the cursor) inside the last one so it follows the text. */
function blocks(nodes: readonly Block[], tail: VNode[]): VNode[] {
  if (nodes.length === 0) return tail;
  return nodes.map((node, index) => block(node, index === nodes.length - 1 ? tail : []));
}

export default defineComponent({
  name: 'MarkdownText',
  props: {
    source: { type: String, required: true },
    cursor: { type: Boolean, default: false },
  },
  setup(props) {
    const tree = computed(() => parseMarkdown(props.source));
    return () => {
      const tail = props.cursor
        ? [h('span', { class: 'animate-hud-blink ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-accent', 'aria-hidden': 'true' })]
        : [];
      return h('div', { class: 'md' }, blocks(tree.value, tail));
    };
  },
});
</script>

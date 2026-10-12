/**
 * The isolated canvas of the Studio (I-19, D-184, docs/STUDIO-API.md): the
 * `srcdoc` of a mockup with a Content-Security-Policy that forbids the
 * network in front of it, the Studio's own script (marked
 * `data-arianna-studio`) and the fixed shapes of the messages it exchanges
 * with the page. Pure: tested with node:test, no DOM needed.
 *
 * The iframe is always `sandbox="allow-scripts"`, never `allow-same-origin`:
 * the mockup runs in an opaque origin, reads nothing of the chat and reaches
 * nothing on the network. The page trusts a message only when it comes from
 * the window of its own iframe and has one of the shapes below.
 */

/** Marks every message of the Studio, both ways. */
export const STUDIO_SOURCE = 'arianna-studio';

/** Network off: styles, scripts, images, fonts and media only inline, from `data:` or from `blob:`. */
export const STUDIO_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ');

/** The longest excerpt of an element's text the frame sends. */
export const EXCERPT_MAX = 120;
/** The longest selector the page accepts (a deep page still fits). */
export const SELECTOR_MAX = 2000;

/** One step of the path from `body` to an element: its tag and its place among the siblings with the same tag (from 1). */
export interface PathStep {
  tag: string;
  index: number;
}

/**
 * The CSS selector of an element from its path below `body`:
 * `body > main:nth-of-type(1) > h1:nth-of-type(1)`. Every step carries
 * `:nth-of-type`, so the selector names one element only. Self-contained:
 * it is also copied into the frame's script.
 */
export function nthSelector(chain: readonly PathStep[]): string {
  let selector = 'body';
  for (const step of chain) selector += ' > ' + step.tag + ':nth-of-type(' + String(step.index) + ')';
  return selector;
}

/** The text of an element on one line, cut at `max` characters with an ellipsis. Self-contained: copied into the frame's script. */
export function excerptOf(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : line.slice(0, max - 1).trimEnd() + '…';
}

/**
 * The Studio's script, as it runs in the frame. Self-contained apart from
 * `nthSelector` and `excerptOf`, which the script defines before it; written
 * in plain DOM calls so that its source text works once copied.
 *
 * Comment mode: the element under the pointer is outlined; a click sends
 * its selector, its box, its tag and an excerpt of its text, and does
 * nothing else (no link followed, no button pressed). From the page:
 * `mode` turns comment mode on or off, `highlight` outlines the element of
 * a selector (or none).
 */
export function studioAgent(win: Window): void {
  const doc = win.document;
  const source = 'arianna-studio';
  let commenting = false;

  function overlay(color: string, style: string): HTMLElement {
    const box = doc.createElement('div');
    box.setAttribute('data-arianna-studio', '');
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border-radius:3px;display:none;border:2px ' + style + ' ' + color + ';background:' + color + '14;';
    // Outside body: the selectors count the elements of body only.
    doc.documentElement.appendChild(box);
    return box;
  }
  const hover = overlay('#4fd1c1', 'solid');
  const marked = overlay('#f2b34b', 'dashed');

  function place(box: HTMLElement, element: Element | null): void {
    if (element === null) {
      box.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    box.style.left = String(rect.left) + 'px';
    box.style.top = String(rect.top) + 'px';
    box.style.width = String(rect.width) + 'px';
    box.style.height = String(rect.height) + 'px';
    box.style.display = 'block';
  }

  function pathOf(element: Element): { tag: string; index: number }[] | null {
    const chain: { tag: string; index: number }[] = [];
    let node: Element = element;
    while (node !== doc.body) {
      const parent = node.parentElement;
      if (parent === null) return null;
      const tag = node.localName;
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(tag)) return null;
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling !== null) {
        if (sibling.localName === tag) index += 1;
        sibling = sibling.previousElementSibling;
      }
      chain.unshift({ tag, index });
      node = parent;
    }
    return chain;
  }

  /** The element an event points at: never one of ours, never outside body. */
  function targetOf(event: Event): Element | null {
    let element = event.target instanceof Element ? event.target : null;
    while (element !== null && (element.hasAttribute('data-arianna-studio') || pathOf(element) === null)) element = element.parentElement;
    return element !== null && doc.body.contains(element) ? element : null;
  }

  function post(message: Record<string, unknown>): void {
    win.parent.postMessage({ source, ...message }, '*');
  }

  let markedSelector: string | null = null;
  function remark(): void {
    let element: Element | null = null;
    if (markedSelector !== null) {
      try {
        element = doc.querySelector(markedSelector);
      } catch {
        element = null;
      }
    }
    place(marked, element);
  }

  doc.addEventListener(
    'mouseover',
    (event) => {
      if (commenting) place(hover, targetOf(event));
    },
    true,
  );
  doc.addEventListener(
    'click',
    (event) => {
      if (!commenting) return;
      event.preventDefault();
      event.stopPropagation();
      const element = targetOf(event);
      if (element === null) return;
      const chain = pathOf(element);
      if (chain === null) return;
      const rect = element.getBoundingClientRect();
      post({
        type: 'pick',
        selector: nthSelector(chain),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        tag: element.localName,
        excerpt: excerptOf(element.textContent, 120),
      });
    },
    true,
  );
  // A form in comment mode never submits.
  doc.addEventListener(
    'submit',
    (event) => {
      if (commenting) event.preventDefault();
    },
    true,
  );
  win.addEventListener('scroll', remark, true);
  win.addEventListener('resize', remark);
  win.addEventListener('message', (event) => {
    if (event.source !== win.parent) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const message = data as Record<string, unknown>;
    if (message.source !== source) return;
    if (message.type === 'mode') {
      commenting = message.comment === true;
      doc.documentElement.style.cursor = commenting ? 'crosshair' : '';
      if (!commenting) place(hover, null);
    } else if (message.type === 'highlight') {
      markedSelector = typeof message.selector === 'string' && message.selector.length <= 2000 ? message.selector : null;
      remark();
    }
  });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => {
      post({ type: 'ready' });
    });
  else post({ type: 'ready' });
}

/** The source of the Studio's script, as it goes in the `srcdoc`. */
export function studioScript(): string {
  return `${nthSelector.toString()}\n${excerptOf.toString()}\n(${studioAgent.toString()})(window);`;
}

/** The script of the frame used to print (PDF): opens the browser's print once the page is in. */
export const PRINT_SCRIPT = "window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 150); });";

/** What goes in the frame besides the mockup: nothing (a preview), the Studio's script, or the print. */
export type FrameMode = 'plain' | 'studio' | 'print';

/** Leading comments, the doctype if any: the policy goes right after them, before any element of the mockup. */
const PROLOGUE = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>)?/i;

/**
 * The `srcdoc` of a mockup: the policy first (right after the doctype, so
 * it covers every element the mockup has, the `<head>` included), then the
 * script of the mode, then the mockup as it is. A doctype stays first, so
 * the page renders as it would on its own.
 */
export function buildSrcdoc(source: string, mode: FrameMode): string {
  const prologue = PROLOGUE.exec(source)?.[0] ?? '';
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STUDIO_CSP}">`;
  const script = mode === 'studio' ? studioScript() : mode === 'print' ? PRINT_SCRIPT : '';
  // A "</script" in our code would close the element early; there is none, and this keeps it so.
  const tag = script === '' ? '' : `<script data-arianna-studio>${script.replace(/<\/(script)/gi, '<\\/$1')}</script>`;
  return `${prologue}${meta}${tag}${source.slice(prologue.length)}`;
}

/** The box of an element in the frame, in CSS pixels. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the frame may send: it is ready, or the user clicked an element in comment mode. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'pick'; selector: string; rect: FrameRect; tag: string; excerpt: string };

/** A selector as the frame writes it: `body`, then `> tag:nth-of-type(n)` steps. */
const SELECTOR = /^body(?: > [a-z][a-z0-9-]{0,63}:nth-of-type\([1-9][0-9]{0,4}\))*$/;

export function isStudioSelector(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SELECTOR_MAX && SELECTOR.test(value);
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

/**
 * A message from the frame, when it has one of the fixed shapes; undefined
 * otherwise. The page also checks that it came from its own iframe.
 */
export function parseFrameMessage(data: unknown): FrameMessage | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const message = data as Record<string, unknown>;
  if (message.source !== STUDIO_SOURCE) return undefined;
  if (message.type === 'ready') return Object.keys(message).length === 2 ? { type: 'ready' } : undefined;
  if (message.type !== 'pick') return undefined;
  const { selector, rect, tag, excerpt } = message;
  if (Object.keys(message).length !== 6) return undefined;
  if (!isStudioSelector(selector)) return undefined;
  if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) return undefined;
  if (typeof excerpt !== 'string' || excerpt.length > EXCERPT_MAX) return undefined;
  if (typeof rect !== 'object' || rect === null) return undefined;
  const box = rect as Record<string, unknown>;
  const { x, y, width, height } = box;
  if (Object.keys(box).length !== 4 || !isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height) || width < 0 || height < 0) return undefined;
  // The selector ends with the tag the frame names.
  const last = selector === 'body' ? 'body' : (/ > ([a-z][a-z0-9-]*):nth-of-type\(\d+\)$/.exec(selector)?.[1] ?? '');
  if (last !== tag) return undefined;
  return { type: 'pick', selector, rect: { x, y, width, height }, tag, excerpt: withoutControls(excerpt) };
}

/** Control characters become spaces: the excerpt goes in a message to the Designer. */
export function withoutControls(text: string): string {
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('');
}

/**
 * The excerpt the page receives for an element whose text is `text`: the
 * frame's `excerptOf` cut, then `parseFrameMessage`'s `withoutControls`, in
 * that order. The direct edit compares it with the element found in the
 * source, so it never writes into another element than the one picked.
 */
export function pickedExcerpt(text: string): string {
  return withoutControls(excerptOf(text, EXCERPT_MAX));
}

/** True when the element of the source has the text of the element picked in the live frame. */
export function excerptMatches(sourceText: string, picked: string): boolean {
  return pickedExcerpt(sourceText) === picked;
}

/** The messages the page sends to the frame. */
export function modeMessage(comment: boolean): { source: string; type: 'mode'; comment: boolean } {
  return { source: STUDIO_SOURCE, type: 'mode', comment };
}

export function highlightMessage(selector: string | null): { source: string; type: 'highlight'; selector: string | null } {
  return { source: STUDIO_SOURCE, type: 'highlight', selector: selector !== null && isStudioSelector(selector) ? selector : null };
}

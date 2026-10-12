import { excerptMatches, isStudioSelector, type SlideLook } from './studio-frame.ts';
import { deckFromParts, EDIT_STYLES, editProblems, pointsFrom, respace, SEGMENTS_MAX, type Deck, type EditStyle, type SlideParts, type StudioEdit } from './studio.ts';

/**
 * The parts of the Studio that need a DOM (I-19, D-184): they receive a
 * `Document` parsed with `DOMParser`, which runs no script of the mockup, so
 * they are tried in the browser. The direct edit changes the source of the
 * file, never the live page of the iframe (the mockup's scripts may have
 * changed that).
 */

/** Parses a mockup without running it. */
export function parseMockup(source: string): Document {
  return new DOMParser().parseFromString(source, 'text/html');
}

/** The element of a selector of the frame, or null (a selector that the scripts of the mockup made true only live). */
export function elementAt(doc: Document, selector: string): HTMLElement | null {
  if (!isStudioSelector(selector)) return null;
  try {
    const element = doc.querySelector(selector);
    // DOMParser builds its nodes with this window's classes.
    return element instanceof HTMLElement ? element : null;
  } catch {
    return null;
  }
}

/** What the edit panel shows for an element of the source. */
export interface Editable {
  /** The whole text can be changed only when the element holds text alone. */
  textEditable: boolean;
  text: string;
  /** With text and elements mixed: its own text pieces, trimmed, in order (the inner elements stay). */
  segments: string[];
  /** False when its text is not the one of the element picked in the frame (a script of the mockup changed it). */
  matches: boolean;
  styles: Record<EditStyle, string>;
}

export function readEditable(doc: Document, selector: string, excerpt: string): Editable | undefined {
  const element = elementAt(doc, selector);
  if (element === null) return undefined;
  const styles = Object.fromEntries(EDIT_STYLES.map((name) => [name, element.style.getPropertyValue(name)])) as Record<EditStyle, string>;
  const textEditable = element.children.length === 0;
  const segments = textEditable ? [] : ownTexts(element).map((node) => node.data.trim());
  return { textEditable, text: textEditable ? element.textContent : '', segments, matches: excerptMatches(element.textContent, excerpt), styles };
}

/** The text nodes right inside an element that hold more than blanks (at most SEGMENTS_MAX of them). */
function ownTexts(element: Element): Text[] {
  return [...element.childNodes].filter((node): node is Text => node.nodeType === node.TEXT_NODE && (node as Text).data.trim() !== '').slice(0, SEGMENTS_MAX);
}

/** The document back to text, with its doctype. */
export function serializeMockup(doc: Document): string {
  const type = doc.doctype;
  const doctype = type === null ? '' : `<!DOCTYPE ${type.name}${type.publicId ? ` PUBLIC "${type.publicId}"` : ''}${type.systemId ? ` "${type.systemId}"` : ''}>\n`;
  return `${doctype}${doc.documentElement.outerHTML}\n`;
}

export type EditResult = { ok: true; text: string } | { ok: false; reason: 'not-found' | 'invalid' | 'not-text' | 'changed' };

/**
 * Applies an edit to the source of a mockup: the text of the element (when
 * it holds text alone) and the allowed styles, inline on the element. The
 * selector comes from the live frame, so the element found in the source
 * must have the `excerpt` of the one picked: otherwise the mockup's scripts
 * changed the page and the edit would land on another element. The new
 * source, or why not.
 */
export function editSource(source: string, edit: StudioEdit, excerpt: string): EditResult {
  if (editProblems(edit).length > 0) return { ok: false, reason: 'invalid' };
  const doc = parseMockup(source);
  const element = elementAt(doc, edit.selector);
  if (element === null) return { ok: false, reason: 'not-found' };
  if (!excerptMatches(element.textContent, excerpt)) return { ok: false, reason: 'changed' };
  if (edit.text !== undefined && edit.text !== element.textContent) {
    if (element.children.length > 0) return { ok: false, reason: 'not-text' };
    element.textContent = edit.text;
  }
  if (edit.segments !== undefined) {
    const nodes = ownTexts(element);
    // Other pieces than the ones shown: the file changed under the panel.
    if (element.children.length === 0 || nodes.length !== edit.segments.length) return { ok: false, reason: 'changed' };
    nodes.forEach((node, at) => {
      node.data = respace(node.data, edit.segments?.[at] ?? '');
    });
  }
  for (const name of EDIT_STYLES) {
    const value = edit.styles[name];
    if (value === undefined) continue;
    if (value.trim() === '') element.style.removeProperty(name);
    else element.style.setProperty(name, value.trim());
  }
  if (element.getAttribute('style') === '') element.removeAttribute('style');
  return { ok: true, text: serializeMockup(doc) };
}

function textOf(element: Element | null): string | undefined {
  const text = element?.textContent.replace(/\s+/g, ' ').trim();
  return text === undefined || text === '' ? undefined : text;
}

/** True when the mockup is a presentation: at least one `section[data-slide]`. */
export function hasSlides(doc: Document): boolean {
  return doc.querySelector('section[data-slide]') !== null;
}

/**
 * The deck of a presentation (docs/STUDIO-API.md, «Come la pagina trova le
 * slide»): from each `section[data-slide]` the first `h1` or `h2` as title,
 * the first `h3` or `[data-subtitle]` as subtitle, the `p` as paragraphs,
 * the `li` as bullets, an `aside[data-notes]` as notes, `data-background`,
 * `data-color` (and `data-accent`) as colours. The notes' text is not
 * repeated among paragraphs and bullets. Undefined without slides.
 *
 * `looks` is how the slides appear on screen, measured in the frame: when
 * there is one per section, its colours win over the attributes and its
 * fonts and sizes go in the deck, so the PPTX looks like the page. Without
 * them (the frame did not answer, or its scripts changed the slides) the
 * attributes alone.
 */
export function deckFromDocument(doc: Document, fallbackTitle: string, looks?: readonly SlideLook[]): Deck | undefined {
  const sections = [...doc.querySelectorAll('section[data-slide]')];
  const measured = looks !== undefined && looks.length === sections.length ? looks : undefined;
  const parts: SlideParts[] = sections.map((section, at) => {
    const look = measured?.[at];
    const outsideNotes = (element: Element): boolean => element.closest('aside[data-notes]') === null;
    const subtitle = [...section.querySelectorAll('h3, [data-subtitle]')].find(outsideNotes) ?? null;
    return {
      title: textOf([...section.querySelectorAll('h1, h2')].find(outsideNotes) ?? null),
      subtitle: textOf(subtitle),
      paragraphs: [...section.querySelectorAll('p')]
        .filter((element) => outsideNotes(element) && element !== subtitle && element.closest('li') === null)
        .map((element) => textOf(element) ?? '')
        .filter((text) => text !== ''),
      bullets: [...section.querySelectorAll('li')].filter(outsideNotes).map((element) => textOf(element) ?? '').filter((text) => text !== ''),
      notes: section.querySelector('aside[data-notes]')?.textContent ?? undefined,
      background: look?.background ?? section.getAttribute('data-background'),
      color: look?.color ?? section.getAttribute('data-color'),
      accent: look?.accent ?? section.getAttribute('data-accent'),
      titleFont: look?.titleFont,
      bodyFont: look?.bodyFont,
      titleSize: look === undefined ? undefined : pointsFrom(look.titlePx, look.width),
      bodySize: look === undefined ? undefined : pointsFrom(look.bodyPx, look.width),
    };
  });
  return deckFromParts(textOf(doc.querySelector('title')) ?? fallbackTitle, parts);
}

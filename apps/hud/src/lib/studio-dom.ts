import { isStudioSelector } from './studio-frame.ts';
import { deckFromParts, EDIT_STYLES, editProblems, type Deck, type EditStyle, type SlideParts, type StudioEdit } from './studio.ts';

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
  /** The text can be changed only when the element holds text alone. */
  textEditable: boolean;
  text: string;
  styles: Record<EditStyle, string>;
}

export function readEditable(doc: Document, selector: string): Editable | undefined {
  const element = elementAt(doc, selector);
  if (element === null) return undefined;
  const styles = Object.fromEntries(EDIT_STYLES.map((name) => [name, element.style.getPropertyValue(name)])) as Record<EditStyle, string>;
  const textEditable = element.children.length === 0;
  return { textEditable, text: textEditable ? element.textContent : '', styles };
}

/** The document back to text, with its doctype. */
export function serializeMockup(doc: Document): string {
  const type = doc.doctype;
  const doctype = type === null ? '' : `<!DOCTYPE ${type.name}${type.publicId ? ` PUBLIC "${type.publicId}"` : ''}${type.systemId ? ` "${type.systemId}"` : ''}>\n`;
  return `${doctype}${doc.documentElement.outerHTML}\n`;
}

export type EditResult = { ok: true; text: string } | { ok: false; reason: 'not-found' | 'invalid' | 'not-text' };

/**
 * Applies an edit to the source of a mockup: the text of the element (when
 * it holds text alone) and the allowed styles, inline on the element. The
 * new source, or why not.
 */
export function editSource(source: string, edit: StudioEdit): EditResult {
  if (editProblems(edit).length > 0) return { ok: false, reason: 'invalid' };
  const doc = parseMockup(source);
  const element = elementAt(doc, edit.selector);
  if (element === null) return { ok: false, reason: 'not-found' };
  if (edit.text !== undefined && edit.text !== element.textContent) {
    if (element.children.length > 0) return { ok: false, reason: 'not-text' };
    element.textContent = edit.text;
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
 */
export function deckFromDocument(doc: Document, fallbackTitle: string): Deck | undefined {
  const sections = [...doc.querySelectorAll('section[data-slide]')];
  const parts: SlideParts[] = sections.map((section) => {
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
      background: section.getAttribute('data-background'),
      color: section.getAttribute('data-color'),
      accent: section.getAttribute('data-accent'),
    };
  });
  return deckFromParts(textOf(doc.querySelector('title')) ?? fallbackTitle, parts);
}

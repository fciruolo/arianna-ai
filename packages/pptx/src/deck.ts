/** A slide of the Studio's export (docs/STUDIO-API.md). */
export interface Slide {
  title?: string;
  subtitle?: string;
  paragraphs?: string[];
  bullets?: string[];
  notes?: string;
  /** `#rrggbb` */
  background?: string;
  /** `#rrggbb`, the text colour */
  color?: string;
  /** `#rrggbb`, the title colour */
  accent?: string;
}

export interface Deck {
  title: string;
  slides: Slide[];
}

export class DeckError extends Error {
  override name = 'DeckError';
}

// Limits of docs/STUDIO-API.md.
export const MAX_SLIDES = 200;
export const MAX_DECK_TITLE = 200;
export const MAX_SLIDE_TEXT = 300;
export const MAX_ITEMS = 30;
export const MAX_PARAGRAPH = 2000;
export const MAX_BULLET = 500;
export const MAX_NOTES = 5000;

const COLOR = /^#[0-9a-fA-F]{6}$/;
// C0 controls except \t and \n, DEL and C1 controls and the two XML 1.0
// noncharacters: none of these can be written in a slide. Lone surrogates are
// refused separately (String.prototype.isWellFormed).
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u{fffe}\u{ffff}]/u;
const FORBIDDEN_GLOBAL = new RegExp(FORBIDDEN.source, 'gu');

const SLIDE_KEYS = new Set(['title', 'subtitle', 'paragraphs', 'bullets', 'notes', 'background', 'color', 'accent']);
const DECK_KEYS = new Set(['title', 'slides']);

/** Removes the characters a slide cannot hold (the writer's last line of defence). */
export function stripForbidden(text: string): string {
  return text.toWellFormed().replace(FORBIDDEN_GLOBAL, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new DeckError(`${where}: unknown key "${key}"`);
  }
}

function text(value: unknown, where: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new DeckError(`${where}: expected a string`);
  if (!value.isWellFormed() || FORBIDDEN.test(value)) throw new DeckError(`${where}: control characters are not allowed`);
  // Length in code points, as a person counts characters.
  const length = Array.from(value).length;
  if (length < min) throw new DeckError(`${where}: must not be empty`);
  if (length > max) throw new DeckError(`${where}: longer than ${String(max)} characters`);
  return value;
}

function texts(value: unknown, where: string, max: number): string[] {
  if (!Array.isArray(value)) throw new DeckError(`${where}: expected an array`);
  if (value.length > MAX_ITEMS) throw new DeckError(`${where}: more than ${String(MAX_ITEMS)} items`);
  return value.map((item, i) => text(item, `${where}[${String(i)}]`, 0, max));
}

function color(value: unknown, where: string): string {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new DeckError(`${where}: expected #rrggbb`);
  return value.toLowerCase();
}

function parseSlide(raw: unknown, where: string): Slide {
  if (!isRecord(raw)) throw new DeckError(`${where}: expected an object`);
  checkKeys(raw, SLIDE_KEYS, where);
  const slide: Slide = {};
  if (raw.title !== undefined) slide.title = text(raw.title, `${where}.title`, 0, MAX_SLIDE_TEXT);
  if (raw.subtitle !== undefined) slide.subtitle = text(raw.subtitle, `${where}.subtitle`, 0, MAX_SLIDE_TEXT);
  if (raw.paragraphs !== undefined) slide.paragraphs = texts(raw.paragraphs, `${where}.paragraphs`, MAX_PARAGRAPH);
  if (raw.bullets !== undefined) slide.bullets = texts(raw.bullets, `${where}.bullets`, MAX_BULLET);
  if (raw.notes !== undefined) slide.notes = text(raw.notes, `${where}.notes`, 0, MAX_NOTES);
  if (raw.background !== undefined) slide.background = color(raw.background, `${where}.background`);
  if (raw.color !== undefined) slide.color = color(raw.color, `${where}.color`);
  if (raw.accent !== undefined) slide.accent = color(raw.accent, `${where}.accent`);
  return slide;
}

/** Checks an untrusted value against the limits of docs/STUDIO-API.md. */
export function parseDeck(raw: unknown): Deck {
  if (!isRecord(raw)) throw new DeckError('deck: expected an object');
  checkKeys(raw, DECK_KEYS, 'deck');
  const title = text(raw.title, 'deck.title', 1, MAX_DECK_TITLE);
  if (title.trim() === '') throw new DeckError('deck.title: must not be empty');
  if (!Array.isArray(raw.slides)) throw new DeckError('deck.slides: expected an array');
  if (raw.slides.length < 1) throw new DeckError('deck.slides: at least one slide');
  if (raw.slides.length > MAX_SLIDES) throw new DeckError(`deck.slides: more than ${String(MAX_SLIDES)} slides`);
  const slides = raw.slides.map((slide, i) => parseSlide(slide, `deck.slides[${String(i)}]`));
  return { title, slides };
}

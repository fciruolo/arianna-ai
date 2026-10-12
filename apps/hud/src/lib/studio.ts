import { ApiError } from './api.ts';
import { withoutControls } from './studio-frame.ts';

/**
 * The page «Studio» (I-19, D-184): pure helpers. The shapes of the API of
 * docs/STUDIO-API.md (repeated here: the page does not import the core nor
 * @arianna/pptx), the address, the variants of a mockup in groups, the one
 * message of revision for the Designer, the styles the direct edit may
 * change and the deck of a presentation within its limits.
 */

export const STUDIO_PATH = '/studio';

export function isStudioPath(pathname: string): boolean {
  return pathname === STUDIO_PATH || pathname === `${STUDIO_PATH}/`;
}

/** What the address of the Studio chooses: a project and a mockup of it. */
export interface StudioAddress {
  project?: string;
  file?: string;
}

/** `/studio?progetto=<name>&file=<folder>/<name>.html`, each part only when given. */
export function studioPathFor(address: StudioAddress = {}): string {
  const params = new URLSearchParams();
  if (address.project !== undefined && address.project !== '') params.set('progetto', address.project);
  if (address.file !== undefined && address.file !== '') params.set('file', address.file);
  const query = params.toString();
  return query === '' ? STUDIO_PATH : `${STUDIO_PATH}?${query}`;
}

export function studioFromSearch(search: string): StudioAddress {
  const params = new URLSearchParams(search);
  const project = params.get('progetto')?.trim();
  const file = params.get('file')?.trim();
  return { ...(project ? { project } : {}), ...(file ? { file } : {}) };
}

/** The agent the Studio talks with (D-159). */
export const DESIGNER_AGENT = 'designer';

// ---------------------------------------------------------------------------
// Shapes of the API (docs/STUDIO-API.md)
// ---------------------------------------------------------------------------

export interface Mockup {
  path: string;
  name: string;
  group: string;
  variant: number | null;
  bytes: number;
  modified: string;
  sha256: string;
}

export interface MockupList {
  folder: string;
  files: Mockup[];
}

export interface MockupText {
  path: string;
  text: string;
  sha256: string;
}

/** The mockups folder in a path of a delegation's file: `mockups/x.html` or `docs/mockups/x.html`, directly inside. */
export function isMockupPath(path: string): boolean {
  return /^(?:docs\/)?mockups\/[^/.][^/]*\.html$/i.test(path);
}

/** The error of a call of the Studio, in Italian. */
export function studioErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return cause instanceof TypeError ? 'Il nucleo non risponde: controlla che sia avviato.' : 'Errore imprevisto.';
  if (cause.status === 404) return 'Non trovato: il progetto non è fra quelli approvati, il file non c’è più, o il nucleo non ha ancora lo Studio.';
  if (cause.status === 403) return 'Il nucleo ha rifiutato: il file è fuori dalla cartella dei mockup, è nascosto o contiene un valore protetto.';
  if (cause.status === 409) return 'Il file è cambiato nel frattempo (forse l’ha riscritto il Designer): lo ricarico, rifai la modifica.';
  if (cause.status === 413) return 'Il file è troppo grande per lo Studio (al massimo 2 MiB).';
  if (cause.status === 400) return 'Richiesta non valida.';
  if (cause.status >= 500) return 'Errore del nucleo: riprova fra poco.';
  return 'Richiesta non riuscita.';
}

// ---------------------------------------------------------------------------
// Variants (O4)
// ---------------------------------------------------------------------------

export interface MockupGroup {
  group: string;
  /** The files without a number first, then by number. */
  variants: Mockup[];
}

export function groupMockups(files: readonly Mockup[]): MockupGroup[] {
  const groups = new Map<string, Mockup[]>();
  for (const file of files) groups.set(file.group, [...(groups.get(file.group) ?? []), file]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, variants]) => ({
      group,
      variants: [...variants].sort((a, b) => (a.variant ?? 0) - (b.variant ?? 0) || a.name.localeCompare(b.name)),
    }));
}

/** The file to show first: the one asked for when it is there, otherwise the most recent. */
export function pickMockup(files: readonly Mockup[], wanted: string | undefined): Mockup | undefined {
  const asked = wanted === undefined ? undefined : files.find((file) => file.path === wanted);
  if (asked !== undefined) return asked;
  return [...files].sort((a, b) => b.modified.localeCompare(a.modified))[0];
}

/** The label of a variant in the bar: "v2", or "base" for the file without a number. */
export function variantLabel(file: Mockup): string {
  return file.variant === null ? 'base' : `v${String(file.variant)}`;
}

/** The name of the variant after the last one of a group: `landing-3.html`. */
export function nextVariantName(group: string, files: readonly Mockup[]): string {
  const numbers = files.filter((file) => file.group === group).map((file) => file.variant ?? 1);
  return `${group}-${String(Math.max(1, ...numbers) + 1)}.html`;
}

// ---------------------------------------------------------------------------
// Comments (O3)
// ---------------------------------------------------------------------------

export interface StudioComment {
  id: number;
  /** The mockup the element is in. */
  file: string;
  selector: string;
  tag: string;
  excerpt: string;
  text: string;
}

export const COMMENT_MAX = 2000;
export const COMMENTS_MAX = 50;

/** Why a comment cannot be kept, or undefined. */
export function commentProblem(text: string): string | undefined {
  if (text.trim() === '') return 'Scrivi il commento.';
  if (text.length > COMMENT_MAX) return `Al massimo ${String(COMMENT_MAX)} caratteri.`;
  return undefined;
}

/**
 * The one message of revision for the Designer: the comments together, by
 * file, each with the element (selector, tag, excerpt) and what the user
 * wants. The Designer writes the next variant of each file.
 */
export function reviewMessage(comments: readonly StudioComment[], files: readonly Mockup[]): string {
  const byFile = new Map<string, StudioComment[]>();
  for (const comment of comments) byFile.set(comment.file, [...(byFile.get(comment.file) ?? []), comment]);
  const lines: string[] = ['Revisione dallo Studio: applica questi commenti in una variante nuova, senza toccare il file di partenza e senza cambiare il resto della pagina.'];
  let number = 0;
  for (const [file, list] of byFile) {
    const known = files.find((entry) => entry.path === file);
    const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    const next = known === undefined ? undefined : `${folder}${nextVariantName(known.group, files)}`;
    lines.push('', `File: ${file}${next === undefined ? '' : ` → scrivi ${next}`}`);
    for (const comment of list) {
      number += 1;
      const excerpt = withoutControls(comment.excerpt).trim();
      lines.push(`${String(number)}. Elemento \`${comment.selector}\` (${comment.tag}${excerpt === '' ? '' : `, «${excerpt}»`})`);
      lines.push(`   Commento: ${withoutControls(comment.text).replace(/\s+/g, ' ').trim()}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Direct edit (O6)
// ---------------------------------------------------------------------------

export const EDIT_STYLES = ['color', 'background-color', 'font-size', 'font-weight', 'padding', 'margin', 'text-align', 'border-radius'] as const;
export type EditStyle = (typeof EDIT_STYLES)[number];

export const STYLE_LABEL: Record<EditStyle, string> = {
  color: 'Colore del testo',
  'background-color': 'Colore di sfondo',
  'font-size': 'Dimensione del testo',
  'font-weight': 'Peso del testo',
  padding: 'Spaziatura interna',
  margin: 'Margine',
  'text-align': 'Allineamento',
  'border-radius': 'Arrotondamento',
};

export const STYLE_HINT: Record<EditStyle, string> = {
  color: '#1f2933, rgb(31 41 51) o un nome',
  'background-color': '#ffffff, rgb(255 255 255) o un nome',
  'font-size': '16px, 1.25rem, 120%',
  'font-weight': '400, 700, normal, bold',
  padding: '16px oppure 8px 16px',
  margin: '0 auto oppure 24px 0',
  'text-align': 'left, center, right, justify',
  'border-radius': '8px oppure 50%',
};

export function isEditStyle(name: string): name is EditStyle {
  return (EDIT_STYLES as readonly string[]).includes(name);
}

const COLOR = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}%?(?:\s*[,\s]\s*\d{1,3}%?){2}(?:\s*[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%))?\s*\)|hsla?\(\s*\d{1,3}(?:deg)?(?:\s*[,\s]\s*\d{1,3}%){2}(?:\s*[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%))?\s*\)|[a-z]{3,20})$/i;
const LENGTH = '(?:0|-?\\d{1,4}(?:\\.\\d{1,3})?(?:px|rem|em|%|vh|vw))';
const SIZE = new RegExp(`^(?:\\d{1,3}(?:\\.\\d{1,3})?(?:px|rem|em|%)|small|medium|large|x-large|xx-large|smaller|larger)$`);
const BOX = new RegExp(`^${LENGTH}(?:\\s+${LENGTH}){0,3}$`);
const BOX_AUTO = new RegExp(`^(?:${LENGTH}|auto)(?:\\s+(?:${LENGTH}|auto)){0,3}$`);
const RADIUS = new RegExp(`^${LENGTH}(?:\\s+${LENGTH}){0,3}$`);
const WEIGHT = /^(?:[1-9]00|normal|bold|lighter|bolder)$/;
const ALIGN = /^(?:left|center|right|justify|start|end)$/;
/** Words that are not colours but would pass the plain-name pattern. */
const NOT_COLORS = new Set(['inherit', 'initial', 'unset', 'revert', 'expression', 'url', 'var', 'env', 'attr', 'none']);

/**
 * True when `value` is a value the Studio may write for `name`; the empty
 * value removes the property. Only plain values: no `url()`, no `var()`,
 * no `;`, so nothing but that property changes.
 */
export function validStyle(name: EditStyle, value: string): boolean {
  const text = value.trim();
  if (text === '') return true;
  if (text.length > 60 || /[;{}\\<>"']/.test(text)) return false;
  switch (name) {
    case 'color':
    case 'background-color':
      return COLOR.test(text) && !NOT_COLORS.has(text.toLowerCase());
    case 'font-size':
      return SIZE.test(text);
    case 'font-weight':
      return WEIGHT.test(text);
    case 'padding':
      return BOX.test(text) && !text.includes('-');
    case 'margin':
      return BOX_AUTO.test(text);
    case 'text-align':
      return ALIGN.test(text);
    case 'border-radius':
      return RADIUS.test(text) && !text.includes('-');
  }
}

/**
 * An edit of one element: a new text (only for an element with text alone),
 * or, for an element with text and other elements mixed, the new texts of
 * its own text pieces in order (`segments`, the inner elements stay as they
 * are), and the styles to set or (empty) remove.
 */
export interface StudioEdit {
  selector: string;
  text?: string;
  segments?: string[];
  styles: Partial<Record<EditStyle, string>>;
}

export const EDIT_TEXT_MAX = 5000;
/**
 * A text piece of an element rewritten: the blanks around the old one stay,
 * so the words keep apart from the inner elements; the new text is trimmed.
 */
export function respace(old: string, piece: string): string {
  const lead = /^\s*/.exec(old)?.[0] ?? '';
  const trail = /\s*$/.exec(old)?.[0] ?? '';
  return lead + piece.trim() + trail;
}

/** The most text pieces of one element the edit panel shows. */
export const SEGMENTS_MAX = 20;

/** Why a direct edit is refused when the element in the file is not the one picked in the frame. */
export const STUDIO_EDIT_CHANGED = 'L’elemento nel file è diverso da quello scelto (il mockup lo cambia con uno script): chiedi la modifica al Designer.';

/** The styles that are not valid, by their label; empty when the edit can be applied. */
export function editProblems(edit: StudioEdit): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(edit.styles)) {
    if (!isEditStyle(name)) problems.push(name);
    else if (!validStyle(name, value)) problems.push(STYLE_LABEL[name]);
  }
  const texts = [...(edit.text === undefined ? [] : [edit.text]), ...(edit.segments ?? [])];
  if (texts.reduce((total, text) => total + text.length, 0) > EDIT_TEXT_MAX || (edit.segments?.length ?? 0) > SEGMENTS_MAX) problems.push('Testo');
  return problems;
}

// ---------------------------------------------------------------------------
// Presentations (O5): the deck of @arianna/pptx
// ---------------------------------------------------------------------------

export interface Slide {
  title?: string;
  subtitle?: string;
  paragraphs?: string[];
  bullets?: string[];
  notes?: string;
  background?: string;
  color?: string;
  accent?: string;
  titleFont?: string;
  bodyFont?: string;
  titleSize?: number;
  bodySize?: number;
}

export interface Deck {
  title: string;
  slides: Slide[];
}

/** What the page reads from a `section[data-slide]` before the limits. */
export interface SlideParts {
  title?: string | undefined;
  subtitle?: string | undefined;
  paragraphs: string[];
  bullets: string[];
  notes?: string | undefined;
  background?: string | null | undefined;
  color?: string | null | undefined;
  accent?: string | null | undefined;
  /** `font-family` lists as the screen computes them. */
  titleFont?: string | null | undefined;
  bodyFont?: string | null | undefined;
  /** Sizes in points already. */
  titleSize?: number | undefined;
  bodySize?: number | undefined;
}

export const DECK_LIMITS = { slides: 200, title: 200, slideTitle: 300, subtitle: 300, items: 30, paragraph: 2000, bullet: 500, notes: 5000 } as const;

/**
 * Text a slide can hold, as `parseDeck` of `@arianna/pptx` wants it: line
 * ends as `\n` (`\r\n` and `\r` included), and without the C0 controls
 * other than `\n` and `\t`, DEL, the C1 controls, lone surrogates and
 * U+FFFE/U+FFFF.
 */
export function slideText(text: string): string {
  return Array.from(text.replace(/\r\n?/g, '\n'), (char) => {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n' || char === '\t') return char;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) return '';
    return char;
  }).join('');
}

/** At most `max` code points (as `parseDeck` counts), never half of a surrogate pair; `ellipsis` ends a cut text with «…». */
export function cutText(text: string, max: number, ellipsis: boolean): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return ellipsis ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.slice(0, max).join('');
}

/** Text on one line, without control characters, cut at `max`. */
function clean(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  // Controls become spaces first, so the words they separated stay apart.
  const line = slideText(withoutControls(text)).replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  return cutText(line, max, true);
}

/** The notes keep their lines. */
function cleanNotes(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const notes = cutText(slideText(text).trim(), DECK_LIMITS.notes, false).trimEnd();
  return notes === '' ? undefined : notes;
}

function list(items: readonly string[], max: number): string[] {
  return items
    .map((item) => clean(item, max))
    .filter((item): item is string => item !== undefined)
    .slice(0, DECK_LIMITS.items);
}

/** `#rrggbb` from `#rgb` or `#rrggbb`; undefined for anything else. */
export function hexColor(value: string | null | undefined): string | undefined {
  const text = value?.trim().toLowerCase();
  if (text === undefined) return undefined;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  return short === null ? undefined : `#${short[1] ?? ''}${short[1] ?? ''}${short[2] ?? ''}${short[2] ?? ''}${short[3] ?? ''}${short[3] ?? ''}`;
}

/** Generic CSS families: the system sans-serif is the theme's own font, the others a common Office one. */
const GENERIC_FONTS: Record<string, string | undefined> = {
  serif: 'Times New Roman',
  'ui-serif': 'Times New Roman',
  monospace: 'Courier New',
  'ui-monospace': 'Courier New',
  'sans-serif': undefined,
  'ui-sans-serif': undefined,
  'system-ui': undefined,
  '-apple-system': undefined,
  blinkmacsystemfont: undefined,
  cursive: undefined,
  fantasy: undefined,
};

/** Whole points from 8 to 120, as `parseDeck` wants them. */
function wholePoints(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.min(120, Math.max(8, Math.round(value)));
}

/** A family name as `parseDeck` of `@arianna/pptx` accepts it (keep it equal to `FONT` in packages/pptx/src/deck.ts). */
const FONT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,63}$/u;

/**
 * The font of a computed `font-family` list for PowerPoint: the first named
 * family, or the Office equivalent of a generic one; undefined for the
 * system sans-serif (the theme font) and for names PowerPoint cannot take.
 */
export function fontName(family: string | null | undefined): string | undefined {
  if (family === null || family === undefined) return undefined;
  for (const raw of family.split(',')) {
    const name = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (name === '') continue;
    const generic = name.toLowerCase();
    if (generic in GENERIC_FONTS) return GENERIC_FONTS[generic];
    return FONT_NAME.test(name) ? name : undefined;
  }
  return undefined;
}

/** A 16:9 slide is 960 points wide: a size in CSS pixels on a section `width` pixels wide, as whole points from 8 to 120. */
export function pointsFrom(px: number | null | undefined, width: number): number | undefined {
  if (px === null || px === undefined || !Number.isFinite(px) || px <= 0 || !Number.isFinite(width) || width <= 0) return undefined;
  return Math.min(120, Math.max(8, Math.round((px * 960) / width)));
}

/** The deck within the limits of the contract; undefined without any slide. */
export function deckFromParts(title: string, parts: readonly SlideParts[]): Deck | undefined {
  if (parts.length === 0) return undefined;
  const slides = parts.slice(0, DECK_LIMITS.slides).map((part) => {
    const slide: Slide = {};
    const heading = clean(part.title, DECK_LIMITS.slideTitle);
    if (heading !== undefined) slide.title = heading;
    const subtitle = clean(part.subtitle, DECK_LIMITS.subtitle);
    if (subtitle !== undefined) slide.subtitle = subtitle;
    const paragraphs = list(part.paragraphs, DECK_LIMITS.paragraph);
    if (paragraphs.length > 0) slide.paragraphs = paragraphs;
    const bullets = list(part.bullets, DECK_LIMITS.bullet);
    if (bullets.length > 0) slide.bullets = bullets;
    const notes = cleanNotes(part.notes);
    if (notes !== undefined) slide.notes = notes;
    const background = hexColor(part.background);
    if (background !== undefined) slide.background = background;
    const color = hexColor(part.color);
    if (color !== undefined) slide.color = color;
    const accent = hexColor(part.accent);
    if (accent !== undefined) slide.accent = accent;
    const titleFont = fontName(part.titleFont);
    if (titleFont !== undefined) slide.titleFont = titleFont;
    const bodyFont = fontName(part.bodyFont);
    if (bodyFont !== undefined) slide.bodyFont = bodyFont;
    const titleSize = wholePoints(part.titleSize);
    if (titleSize !== undefined) slide.titleSize = titleSize;
    const bodySize = wholePoints(part.bodySize);
    if (bodySize !== undefined) slide.bodySize = bodySize;
    return slide;
  });
  return { title: clean(title, DECK_LIMITS.title) ?? 'Presentazione', slides };
}

// ---------------------------------------------------------------------------
// Views and files
// ---------------------------------------------------------------------------

export type StudioView = 'desktop' | 'tablet' | 'mobile';

/** The width of the canvas in each view; desktop takes the whole area. */
export const VIEW_WIDTH: Record<StudioView, number | null> = { desktop: null, tablet: 820, mobile: 390 };

export const VIEW_TEXT: Record<StudioView, string> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

/** The name of a downloaded file: the mockup's name with another extension. */
export function exportName(path: string, extension: 'html' | 'pptx'): string {
  const name = path.split('/').at(-1) ?? 'mockup.html';
  const base = name.replace(/\.html?$/i, '') || 'mockup';
  return `${base}.${extension}`;
}

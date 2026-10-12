/**
 * The sample of a style of Open Design (I-20, D-185): what the window of the
 * Studio needs to draw the same small page in the colors, fonts and corners
 * of each style, read by our code from its DESIGN.md (no model, no network).
 * Everything here is checked: colors `#rrggbb`, font names of plain
 * characters, numbers in a range; a style that says little gets the defaults.
 */

export interface SampleColor {
  name: string;
  hex: string;
}

export interface StyleSample {
  /** The colors of the palette as the DESIGN.md lists them, at most 12. */
  palette: SampleColor[];
  /** The band at the top: the first color of the palette, the signature of the style. */
  hero: string;
  /** Text on the band, white or near black. */
  heroText: string;
  /** The button on the band. */
  heroAction: string;
  /** The page under the band. */
  background: string;
  text: string;
  /** Buttons and links. */
  accent: string;
  /** Text on the accent. */
  accentText: string;
  /** Font stacks: names (checked), then the generic family. */
  displayFont: string[];
  bodyFont: string[];
  /** 100-900. */
  titleWeight: number;
  /** Corners of the buttons in px; 999 is a pill. */
  radius: number;
}

const MAX_PALETTE = 12;
const MAX_FONTS = 4;
const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/i;
/** A font name the page may put in a style: letters, digits, spaces, dots and dashes. */
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,47}$/;
/** Words of a sentence, not of a font name: "Three weights", "One typeface", "Light as the base". */
const NOT_FONT = /\b(weights?|typeface|system|creates?|expression|family|families|register|base|range|binary|placeholder|fallback|emoji)\b|^ss\d+$|^font-|^(uppercase|lowercase|capitalize|letter-spacing|line-height|normal|italic|bold|inherit|none)$/i;
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'cursive']);

/** `#abc` → `#aabbcc`, lower case. */
function fullHex(hex: string): string {
  const body = hex.slice(1).toLowerCase();
  return `#${body.length === 3 ? body.replace(/./g, (char) => char + char) : body}`;
}

/** Relative luminance (WCAG) of a `#rrggbb`. */
export function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** A color that reads as a color: saturated, neither near black nor near white. */
function vivid(hex: string): boolean {
  const light = luminance(hex);
  return saturation(hex) > 0.25 && light > 0.03 && light < 0.9;
}

function saturation(hex: string): number {
  const values = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(...values);
  const min = Math.min(...values);
  return max === 0 ? 0 : (max - min) / max;
}

/** The lines of the `## ` sections whose title matches. */
function sections(text: string, title: RegExp): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) inside = title.test(line);
    else if (inside) lines.push(line);
  }
  return lines;
}

/** `- **Primary Blue** (`#0071e3`): role` and `- **Primary:** `#FF5701` — role` → name and color, in order, once per color. */
export function paletteOf(text: string): SampleColor[] {
  const lines = sections(text, /colou?r/i);
  const found: SampleColor[] = [];
  const seen = new Set<string>();
  for (const line of lines.length > 0 ? lines : text.split('\n')) {
    const match = HEX.exec(line);
    if (match === null) continue;
    const hex = fullHex(match[0]);
    if (seen.has(hex)) continue;
    const bold = /\*\*([^*]{1,60})\*\*/.exec(line)?.[1];
    const name = (bold ?? line.slice(0, match.index))
      .replace(/[`*:()[\]|_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    seen.add(hex);
    found.push({ name: name === '' ? hex : name, hex });
    if (found.length >= MAX_PALETTE) break;
  }
  return found;
}

const BACKGROUND = /background|surface|canvas|\bpage\b|\bbase\b|\bbg\b|paper/i;
const TEXT = /\btext\b|\bink\b|foreground|\bbody\b|\bcopy\b/i;
const ACCENT = /primary|accent|action|cta|brand|button|link|highlight/i;

/** The roles of the small page, from the names first (the palette's own words), then from light and saturation. */
function roles(palette: readonly SampleColor[]): Pick<StyleSample, 'hero' | 'heroText' | 'heroAction' | 'background' | 'text' | 'accent' | 'accentText'> {
  const named = (pattern: RegExp, skip: ReadonlySet<string> = new Set()): string | undefined => palette.find((color) => pattern.test(color.name) && !skip.has(color.hex))?.hex;
  const background = named(BACKGROUND) ?? [...palette].sort((a, b) => luminance(b.hex) - luminance(a.hex))[0]?.hex ?? '#ffffff';
  const legible = (hex: string | undefined): string | undefined => (hex !== undefined && contrast(hex, background) >= 4.5 ? hex : undefined);
  const text =
    legible(named(TEXT, new Set([background]))) ??
    [...palette].sort((a, b) => contrast(b.hex, background) - contrast(a.hex, background))[0]?.hex ??
    (luminance(background) > 0.4 ? '#111111' : '#f5f5f5');
  const accent =
    palette.find((color) => ACCENT.test(color.name) && vivid(color.hex) && color.hex !== background)?.hex ??
    [...palette].filter((color) => color.hex !== background && vivid(color.hex)).sort((a, b) => saturation(b.hex) - saturation(a.hex))[0]?.hex ??
    text;
  const first = palette[0]?.hex;
  const hero = first !== undefined && first !== background ? first : accent !== background ? accent : text;
  const ink = (on: string): string => (contrast('#ffffff', on) >= contrast('#111111', on) ? '#ffffff' : '#111111');
  return {
    hero,
    heroText: ink(hero),
    // The button on the band: the accent, unless it melts into the band.
    heroAction: contrast(accent, hero) >= 2 ? accent : contrast(background, hero) >= 2 ? background : ink(hero),
    background,
    text: contrast(text, background) >= 4.5 ? text : ink(background),
    accent,
    accentText: ink(accent),
  };
}

/** A font name as the page may use it, or undefined. */
function fontName(raw: string): string | undefined {
  const name = raw.replace(/^['"]|['"]$/g, '').trim();
  if (GENERIC.has(name.toLowerCase())) return name.toLowerCase();
  return FONT_NAME.test(name) && !NOT_FONT.test(name) && name.split(' ').length <= 5 ? name : undefined;
}

/** Names in backticks or bold, then the comma lists after "fallback". */
function fontsOfLine(line: string): string[] {
  const names: string[] = [];
  const add = (raw: string): void => {
    for (const part of raw.split(',')) {
      const name = fontName(part);
      if (name !== undefined && !names.includes(name) && !/^var\b|^\d/.test(name)) names.push(name);
    }
  };
  for (const match of line.matchAll(/`([^`]{1,200})`/g)) add(match[1] ?? '');
  if (names.length === 0) {
    const bold = /\*\*([^*:]{1,60})\*\*/.exec(line)?.[1];
    // A bold name is a font only when it looks like one: every word capitalized ("Airbnb Cereal VF").
    if (bold !== undefined && !/family|primary|display|body|text|heading/i.test(bold) && bold.trim().split(/\s+/).every((word) => /^[A-Z0-9]/.test(word))) add(bold);
  }
  return names;
}

function generic(names: readonly string[]): string {
  const text = names.join(' ').toLowerCase();
  if (/mono|code|courier/.test(text)) return 'monospace';
  if (/\bserif\b(?<!sans-serif)|georgia|times|garamond|playfair|merriweather|lora|tiempos|caslon|baskerville/.test(text.replace(/sans-serif/g, ''))) return 'serif';
  return 'sans-serif';
}

function stack(names: readonly string[]): string[] {
  const named = names.filter((name) => !GENERIC.has(name)).slice(0, MAX_FONTS);
  return [...named, generic(names)];
}

/** Display and body fonts: `Families: primary=X, display=Y`, or lines naming display/heading and body/text. */
export function fontsOf(text: string): Pick<StyleSample, 'displayFont' | 'bodyFont'> {
  const lines = sections(text, /typograph|font/i);
  let display: string[] = [];
  let body: string[] = [];
  for (const line of lines) {
    const families = /families:\*\*\s*(.+)$/i.exec(line)?.[1];
    if (families !== undefined) {
      for (const pair of families.split(',')) {
        const [key, value] = pair.split('=').map((part) => part.trim());
        const name = value === undefined ? undefined : fontName(value);
        if (name === undefined || key === undefined) continue;
        if (/display|heading/i.test(key) && display.length === 0) display = [name];
        if (/primary|body|text/i.test(key) && body.length === 0) body = [name];
      }
      continue;
    }
    if (!/family|families|primary|display|body|text|heading|headline|marketing|fallback/i.test(line)) continue;
    const names = fontsOfLine(line);
    if (names.length === 0) continue;
    if (/display|heading|headline|marketing|hero/i.test(line) && display.length === 0) display = names;
    else if (/body|text|primary|ui\b|interface/i.test(line) && body.length === 0) body = names;
    else if (body.length === 0 && /family|families/i.test(line)) body = names;
  }
  if (body.length === 0) body = display;
  if (display.length === 0) display = body;
  return { displayFont: stack(display), bodyFont: stack(body) };
}

/** The weight of the big titles: the first table row of a display or heading size with a weight. */
export function titleWeightOf(text: string): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || !/display|hero|h1|heading|headline/i.test(line)) continue;
    const weight = /\|\s*([1-9]00)\s*(?:[-–/]\s*[1-9]00\s*)?\|/.exec(line)?.[1];
    if (weight !== undefined) return Number(weight);
  }
  return 700;
}

/** The corners of the buttons: a line about buttons and radius first, then any radius line. */
export function radiusOf(text: string): number {
  const lines = text.split('\n').filter((line) => /radius|rounded|pill/i.test(line));
  const read = (line: string): number | undefined => {
    if (/pill|capsule|9999?px|50%|full/i.test(line) && /button|cta|pill|capsule/i.test(line)) return 999;
    const px = /(\d{1,3})px\s*(?:\(?[a-z ]*\)?\s*)?(?:radius|corner|rounded)|radius[^0-9\n]{0,40}?(\d{1,3})px/i.exec(line);
    const value = px?.[1] ?? px?.[2];
    return value === undefined ? undefined : Math.min(Number(value), 999);
  };
  for (const line of lines.filter((item) => /button|btn|cta/i.test(item))) {
    const value = read(line);
    if (value !== undefined) return value;
  }
  for (const line of lines) {
    const value = read(line);
    if (value !== undefined) return value;
  }
  return 8;
}

export function styleSample(text: string): StyleSample {
  const palette = paletteOf(text);
  return { palette, ...roles(palette), ...fontsOf(text), titleWeight: titleWeightOf(text), radius: radiusOf(text) };
}

/** What the samples are read from: the adopted catalog (design-catalog.ts), a fake in the tests. */
export interface SampleSource {
  list(): { commit: string | null; styles: readonly { slug: string }[] };
  styleText(slug: string): { text: string };
}

export interface StyleSamples {
  commit: string | null;
  samples: Record<string, StyleSample>;
}

/**
 * The samples of every style of the adopted catalog, computed once per
 * version (about 150 files of at most 256 KiB): a style that cannot be read
 * is left out, the window shows it without a sample.
 */
export function createSampleCache(source: SampleSource): () => StyleSamples {
  let cached: StyleSamples | undefined;
  return () => {
    const listing = source.list();
    if (cached !== undefined && cached.commit === listing.commit && listing.commit !== null) return cached;
    const samples: Record<string, StyleSample> = {};
    for (const { slug } of listing.styles) {
      try {
        samples[slug] = styleSample(source.styleText(slug).text);
      } catch {
        // Gone from the disk or changed since it was indexed: no sample.
      }
    }
    cached = { commit: listing.commit, samples };
    return cached;
  };
}

// The persona of an agent (D-107): style only, never permissions. Tone and
// form of address come from closed lists and become fixed sentences of ours
// (L0); the display name and the free text are the user's, labeled L2 unless
// declared L1, and enter a step only when that label fits its clearance.
// Tools, labels, autonomy and approvals are read from agents/*.yaml alone: a
// persona cannot change them, and the response schema depends only on the
// tools offered.
import { personaFits, personaLabel, type Label, type PersonaLabel } from '@arianna/policy';

export const TONES = ['serio', 'equilibrato', 'scherzoso'] as const;
export type Tone = (typeof TONES)[number];

export const ADDRESSES = ['tu', 'lei'] as const;
export type Address = (typeof ADDRESSES)[number];

/** At most 24 characters: letters, spaces, apostrophe, hyphen; it starts with a letter. */
export const MAX_DISPLAY_NAME = 24;
/** At most 250 characters of free text: every token past the cached block is read again at each step. */
export const MAX_TRAITS = 250;
/** The longest block the prompt can receive, in characters (code points, like the other limits). */
export const MAX_PERSONA_BLOCK = 600;

export interface Persona {
  tone: Tone;
  address: Address;
  displayName?: string;
  traits?: string;
  /** Of the display name and the free text: L2 unless declared L1. */
  label: PersonaLabel;
}

/** Today's behavior: no block in the prompt. */
export const DEFAULT_PERSONA: Persona = { tone: 'equilibrato', address: 'tu', label: 'L2' };

/** What enters one step: the closed choices, and the user's text only when it fits. */
export interface PersonaParts {
  tone: Tone;
  address: Address;
  displayName?: string;
  traits?: string;
  /** L0 with the fixed sentences alone, else the persona's label. */
  label: Label;
}

export class PersonaError extends Error {
  override name = 'PersonaError';
}

const KEYS = ['tone', 'address', 'display_name', 'traits', 'label'] as const;
const DISPLAY_NAME = /^\p{L}[\p{L} '’-]*$/u;
// Control characters (C0, C1, DEL), the line and paragraph separators and the
// bidirectional controls that reorder what a person reads; line breaks and
// tabs are allowed in the free text and become spaces in the block.
const CONTROL = /(?![\n\r\t])[\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const TAGS = /<\s*\/?\s*(persona|tool_result)\s*>/giu;

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new PersonaError(`${where}: expected one of ${allowed.join(', ')}`);
  return found;
}

function isDisplayName(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 1 && length <= MAX_DISPLAY_NAME && DISPLAY_NAME.test(value) && value.trim() === value;
}

/**
 * A persona from its table in arianna.toml (`[personas.<agent>]`): `tone`,
 * `address`, `display_name`, `traits`, `label`, each optional. Anything
 * outside the closed lists or the limits is refused, never cut or guessed.
 */
export function parsePersona(value: unknown, where = 'persona'): Persona {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PersonaError(`${where}: expected a table`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new PersonaError(`${where}: expected a table`);
  const table = value as Record<string, unknown>;
  const unknown = Object.keys(table).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new PersonaError(`${where}: unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}`);

  const persona: Persona = {
    tone: table.tone === undefined ? DEFAULT_PERSONA.tone : oneOf(table.tone, TONES, `${where}.tone`),
    address: table.address === undefined ? DEFAULT_PERSONA.address : oneOf(table.address, ADDRESSES, `${where}.address`),
    // Absent, L2 (default-deny); L0 and L3 are refused, not read as L2.
    label: table.label === undefined ? personaLabel(undefined) : oneOf(table.label, ['L1', 'L2'], `${where}.label`),
  };

  if (table.display_name !== undefined) {
    const name = table.display_name;
    if (typeof name !== 'string' || !isDisplayName(name)) {
      throw new PersonaError(`${where}.display_name: 1-${String(MAX_DISPLAY_NAME)} characters, letters, spaces, apostrophe and hyphen`);
    }
    persona.displayName = name;
  }
  if (table.traits !== undefined) {
    const traits = table.traits;
    if (typeof traits !== 'string') throw new PersonaError(`${where}.traits: expected a string`);
    if (CONTROL.test(traits)) throw new PersonaError(`${where}.traits: control characters are not allowed`);
    if (Array.from(traits).length > MAX_TRAITS) throw new PersonaError(`${where}.traits: at most ${String(MAX_TRAITS)} characters`);
    // An empty text is no text.
    if (traits.trim() !== '') persona.traits = traits;
  }
  return persona;
}

/**
 * What of `persona` enters a step with `clearance`: tone and address always
 * (fixed sentences, L0); the display name and the free text only when their
 * label fits the clearance, else dropped. Deterministic: the same inputs give
 * the same parts.
 */
export function personaParts(persona: Persona, clearance: Label): PersonaParts {
  const parts: PersonaParts = { tone: persona.tone, address: persona.address, label: 'L0' };
  if (!personaFits(persona.label, clearance)) return parts;
  if (persona.displayName !== undefined) parts.displayName = persona.displayName;
  if (persona.traits !== undefined) parts.traits = persona.traits;
  if (parts.displayName !== undefined || parts.traits !== undefined) parts.label = personaLabel(persona.label);
  return parts;
}

const HEADER = 'Persona, style only (rules, tools, labels, approvals unchanged):';
const TONE_SENTENCES: Record<Tone, string> = {
  serio: 'Tone: serious, essential, no jokes.',
  // `equilibrato` is today's behavior: no sentence.
  equilibrato: '',
  scherzoso: 'Tone: warm and playful, a short joke when it fits; never about failures, approvals, money or private matters.',
};
const ADDRESS_SENTENCES: Record<Address, string> = {
  tu: 'Address the user with "tu".',
  lei: 'Address the user with "lei".',
};

/** The free text as the block shows it: one line, its tags neutralized, within the limit. */
function traitsLine(traits: string): string {
  const flat = Array.from(traits.replace(/\r\n|[\r\n\t]/g, ' ').replace(new RegExp(CONTROL.source, 'gu'), ''))
    .slice(0, MAX_TRAITS)
    .join('')
    .replace(TAGS, (_tag, name: string) => `[${name.toLowerCase()}]`)
    .trim();
  return flat === '' ? '' : `<persona>${flat}</persona>`;
}

/**
 * The block that goes at the end of the system prompt, before the thought
 * rule (D-075: the cached prefix does not change). Empty with the defaults
 * (`equilibrato`, `tu`, no name, no text): the prompt is then the same byte
 * for byte as without a persona. At most MAX_PERSONA_BLOCK characters.
 */
export function personaBlock(parts: PersonaParts): string {
  const name = parts.displayName !== undefined && isDisplayName(parts.displayName) ? parts.displayName : undefined;
  const traits = parts.traits === undefined ? '' : traitsLine(parts.traits);
  const tone = TONE_SENTENCES[parts.tone];
  if (name === undefined && traits === '' && tone === '' && parts.address === DEFAULT_PERSONA.address) return '';
  const lines = [
    HEADER,
    `${name === undefined ? '' : `Call yourself "${name}". `}${ADDRESS_SENTENCES[parts.address]}`,
    ...(tone === '' ? [] : [tone]),
    ...(traits === '' ? [] : [traits]),
  ];
  return lines.join('\n');
}

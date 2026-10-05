// The persona of an agent (D-107): style and role, never permissions. Tone
// and form of address come from closed lists and become fixed sentences of
// ours (L0); the display name, the free text and the specialization (role and
// expertise) are the user's, L1 by the user's declaration, and enter a step
// only when L1 fits its clearance (never an L0 agent or task). The
// specialization refines the role of agents/<name>.md, which stays whole with
// its rules. Tools, labels, autonomy and approvals are read from
// agents/*.yaml alone: a persona cannot change them, and the response schema
// depends only on the tools offered.
import { PERSONA_LABEL, personaFits, type Label } from '@arianna/policy';

export const TONES = ['serio', 'asciutto', 'equilibrato', 'caloroso', 'scherzoso'] as const;
export type Tone = (typeof TONES)[number];

export const ADDRESSES = ['tu', 'lei'] as const;
export type Address = (typeof ADDRESSES)[number];

/** At most 24 characters: letters, spaces, apostrophe, hyphen; it starts with a letter. */
export const MAX_DISPLAY_NAME = 24;
/** At most 500 characters of free text: every token past the cached block is read again at each step. */
export const MAX_TRAITS = 500;
/** At most 500 characters of role and expertise, for the same reason. */
export const MAX_SPECIALIZATION = 500;
/** The longest block the prompt can receive, in characters (code points, like the other limits). */
export const MAX_PERSONA_BLOCK = 1400;

export interface Persona {
  tone: Tone;
  address: Address;
  displayName?: string;
  traits?: string;
  /** Role and expertise; empty, the role of agents/<name>.md alone. */
  specialization?: string;
}

/** Today's behavior: no block in the prompt. */
export const DEFAULT_PERSONA: Persona = { tone: 'equilibrato', address: 'tu' };

/** What enters one step: the closed choices, and the user's text only when it fits. */
export interface PersonaParts {
  tone: Tone;
  address: Address;
  displayName?: string;
  traits?: string;
  specialization?: string;
  /** L0 with the fixed sentences alone, else the persona's label (L1). */
  label: 'L0' | typeof PERSONA_LABEL;
}

export class PersonaError extends Error {
  override name = 'PersonaError';
}

const KEYS = ['tone', 'address', 'display_name', 'traits', 'specialization'] as const;
const DISPLAY_NAME = /^\p{L}[\p{L} '’-]*$/u;
// Control characters (C0, C1, DEL), the line and paragraph separators and the
// bidirectional controls that reorder what a person reads; line breaks and
// tabs are allowed in the free text and become spaces in the block.
const CONTROL = /(?![\n\r\t])[\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// Attributes and self-closing forms too (`</persona x>`, `<persona/>`): a model could read them as the end of the fence.
const TAGS = /<\s*\/?\s*(persona|specialization|tool_result)\b[^>]*>/giu;

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new PersonaError(`${where}: expected one of ${allowed.join(', ')}`);
  return found;
}

function isDisplayName(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 1 && length <= MAX_DISPLAY_NAME && DISPLAY_NAME.test(value) && value.trim() === value;
}

/** A free text of the user: a string within `max` characters, without control characters; blank is none. */
function freeText(value: unknown, max: number, where: string): string | undefined {
  if (typeof value !== 'string') throw new PersonaError(`${where}: expected a string`);
  if (CONTROL.test(value)) throw new PersonaError(`${where}: control characters are not allowed`);
  if (Array.from(value).length > max) throw new PersonaError(`${where}: at most ${String(max)} characters`);
  return value.trim() === '' ? undefined : value;
}

/**
 * A persona from its table in arianna.toml (`[personas.<agent>]`): `tone`,
 * `address`, `display_name`, `traits`, `specialization`, each optional. Anything
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
  };

  if (table.display_name !== undefined) {
    const name = table.display_name;
    if (typeof name !== 'string' || !isDisplayName(name)) {
      throw new PersonaError(`${where}.display_name: 1-${String(MAX_DISPLAY_NAME)} characters, letters, spaces, apostrophe and hyphen`);
    }
    persona.displayName = name;
  }
  if (table.traits !== undefined) {
    const traits = freeText(table.traits, MAX_TRAITS, `${where}.traits`);
    if (traits !== undefined) persona.traits = traits;
  }
  if (table.specialization !== undefined) {
    const specialization = freeText(table.specialization, MAX_SPECIALIZATION, `${where}.specialization`);
    if (specialization !== undefined) persona.specialization = specialization;
  }
  return persona;
}

/**
 * What of `persona` enters a step with `clearance`: tone and address always
 * (fixed sentences, L0); the display name, the free text and the
 * specialization (L1) only when the clearance admits L1, else dropped.
 * Deterministic: the same inputs give the same parts.
 */
export function personaParts(persona: Persona, clearance: Label): PersonaParts {
  const parts: PersonaParts = { tone: persona.tone, address: persona.address, label: 'L0' };
  if (!personaFits(clearance)) return parts;
  if (persona.displayName !== undefined) parts.displayName = persona.displayName;
  if (persona.traits !== undefined) parts.traits = persona.traits;
  if (persona.specialization !== undefined) parts.specialization = persona.specialization;
  if (parts.displayName !== undefined || parts.traits !== undefined || parts.specialization !== undefined) parts.label = PERSONA_LABEL;
  return parts;
}

const HEADER = 'Persona set by the user (rules, tools, labels, approvals unchanged):';
const SPECIALIZATION_LEAD = 'Role and expertise, refining the role above:';
const TONE_SENTENCES: Record<Tone, string> = {
  serio: 'Tone: serious, essential, no jokes.',
  asciutto: 'Tone: dry and terse, short sentences, no pleasantries.',
  // `equilibrato` is today's behavior: no sentence.
  equilibrato: '',
  caloroso: 'Tone: warm and attentive, encouraging, friendly without fuss.',
  // No taboo subjects (the user's answer to D-107): approvals and notices are texts of the code, not of the model.
  scherzoso: 'Tone: playful, a joke when it fits, on any subject.',
};
const ADDRESS_SENTENCES: Record<Address, string> = {
  tu: 'Address the user with "tu".',
  lei: 'Address the user with "lei".',
};

/** A free text as the block shows it: one line in `<fence>`, its tags neutralized, within `max`. */
function fenced(text: string, max: number, fence: string): string {
  const flat = Array.from(text.replace(/\r\n|[\r\n\t]/g, ' ').replace(new RegExp(CONTROL.source, 'gu'), ''))
    .slice(0, max)
    .join('')
    .replace(TAGS, (_tag, name: string) => `[${name.toLowerCase()}]`)
    .trim();
  return flat === '' ? '' : `<${fence}>${flat}</${fence}>`;
}

/**
 * The block that goes at the end of the system prompt, before the thought
 * rule (D-075: the cached prefix does not change). Empty with the defaults
 * (`equilibrato`, `tu`, no name, no text, no specialization): the prompt is then the same byte
 * for byte as without a persona. At most MAX_PERSONA_BLOCK characters.
 */
export function personaBlock(parts: PersonaParts): string {
  const name = parts.displayName !== undefined && isDisplayName(parts.displayName) ? parts.displayName : undefined;
  const traits = parts.traits === undefined ? '' : fenced(parts.traits, MAX_TRAITS, 'persona');
  const specialization = parts.specialization === undefined ? '' : fenced(parts.specialization, MAX_SPECIALIZATION, 'specialization');
  const tone = TONE_SENTENCES[parts.tone];
  if (name === undefined && traits === '' && specialization === '' && tone === '' && parts.address === DEFAULT_PERSONA.address) return '';
  const lines = [
    HEADER,
    ...(specialization === '' ? [] : [`${SPECIALIZATION_LEAD} ${specialization}`]),
    `${name === undefined ? '' : `Call yourself "${name}". `}${ADDRESS_SENTENCES[parts.address]}`,
    ...(tone === '' ? [] : [tone]),
    ...(traits === '' ? [] : [traits]),
  ];
  return lines.join('\n');
}

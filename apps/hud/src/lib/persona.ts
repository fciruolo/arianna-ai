/**
 * The "Personalità" section of the settings (D-107, tappa A2): the pure parts.
 * From the personas of `/api/settings` to the forms and back, the counters,
 * the estimate of what a text costs at each step, and the fixed texts under
 * the fields. The core checks everything again (`parsePersona`, the scanner,
 * the values of the vault): here only what helps before saving.
 */

export const TONES = ['serio', 'asciutto', 'equilibrato', 'caloroso', 'scherzoso'] as const;
export type Tone = (typeof TONES)[number];
export const ADDRESSES = ['tu', 'lei'] as const;
export type Address = (typeof ADDRESSES)[number];

/** The limits of the persona in packages/agents, in characters (code points); a test keeps them equal. */
export const MAX_DISPLAY_NAME = 24;
export const MAX_TEXT = 500;

/** Agents whose name never changes (D-107, answer 2), as in packages/config. */
export const FIXED_NAMES: readonly string[] = ['arianna'];

/** The fixed notice under the fields (PRIVACY-POLICY-SPEC, "Da dove vengono le etichette"). */
export const PERSONA_NOTICE = 'Questo testo va anche a Claude e Codex: non scriverci dati personali.';

/** Where the user's text of a persona applies: L1 by declaration. */
export const PERSONA_WHERE = 'Vale nelle conversazioni private e di lavoro e nelle deleghe a Claude e Codex; mai per un agente o un compito Pubblico.';

export const TONE_TEXT: Record<Tone, string> = {
  serio: 'Serio',
  asciutto: 'Asciutto',
  equilibrato: 'Equilibrato',
  caloroso: 'Caloroso',
  scherzoso: 'Scherzoso',
};

/** How a short answer sounds in each tone: the same fact, five ways. */
export const TONE_EXAMPLE: Record<Tone, string> = {
  serio: 'Fatto. La riunione è spostata a giovedì alle 10.',
  asciutto: 'Spostata: giovedì, 10:00.',
  equilibrato: 'Ho spostato la riunione a giovedì alle 10 e ho avvisato gli altri.',
  caloroso: 'Fatto! Ho spostato la riunione a giovedì alle 10, così domani hai la mattina libera.',
  scherzoso: 'Riunione spostata a giovedì alle 10: mercoledì è salvo, e anche il tuo caffè.',
};

/** A persona as the core sends it: absent texts are none. */
export interface PersonaValues {
  tone: Tone;
  address: Address;
  displayName?: string;
  traits?: string;
  specialization?: string;
}

/** The form of one agent: every field present, an empty text is none. */
export interface PersonaForm {
  tone: Tone;
  address: Address;
  displayName: string;
  traits: string;
  specialization: string;
}

export const DEFAULT_PERSONA_FORM: Readonly<PersonaForm> = { tone: 'equilibrato', address: 'tu', displayName: '', traits: '', specialization: '' };

/**
 * One form per agent the file names; the page adds the other agents with the
 * defaults (`DEFAULT_PERSONA_FORM`), which are no change.
 */
export function personasForm(values: Record<string, PersonaValues>): Record<string, PersonaForm> {
  return Object.fromEntries(
    Object.entries(values).map(([agent, persona]): [string, PersonaForm] => [
      agent,
      { tone: persona.tone, address: persona.address, displayName: persona.displayName ?? '', traits: persona.traits ?? '', specialization: persona.specialization ?? '' },
    ]),
  );
}

function isDefault(form: PersonaForm): boolean {
  return form.tone === DEFAULT_PERSONA_FORM.tone && form.address === DEFAULT_PERSONA_FORM.address && blank(form.displayName) && blank(form.traits) && blank(form.specialization);
}

function blank(text: string): boolean {
  return text.trim() === '';
}

/** What the page sends: an agent with the defaults is left out, an empty text too. */
export function personasBody(forms: Record<string, PersonaForm>): Record<string, PersonaValues> {
  const body: Record<string, PersonaValues> = {};
  for (const [agent, form] of Object.entries(forms)) {
    if (isDefault(form)) continue;
    const persona: PersonaValues = { tone: form.tone, address: form.address };
    if (!blank(form.displayName)) persona.displayName = form.displayName.trim();
    if (!blank(form.traits)) persona.traits = form.traits;
    if (!blank(form.specialization)) persona.specialization = form.specialization;
    body[agent] = persona;
  }
  return body;
}

/** Characters as the core counts them: code points, so an emoji is one. */
export function characters(text: string): number {
  return Array.from(text).length;
}

/**
 * About 3.5 characters per token for Italian prose; each token past the
 * cached prefix is read again at each step, about 15 ms on the M1 Max with the
 * 27B (D-107: 130-140 tokens, about 2 s). An estimate, to be measured.
 */
const CHARS_PER_TOKEN = 3.5;
const SECONDS_PER_TOKEN = 0.015;

export interface PersonaCost {
  tokens: number;
  seconds: number;
}

export function personaCost(form: PersonaForm): PersonaCost {
  const length = characters(form.displayName.trim()) + characters(form.traits.trim()) + characters(form.specialization.trim());
  const tokens = Math.ceil(length / CHARS_PER_TOKEN);
  return { tokens, seconds: Math.round(tokens * SECONDS_PER_TOKEN * 10) / 10 };
}

/** The cost in Italian: nothing for an empty text. */
export function costText(cost: PersonaCost): string {
  if (cost.tokens === 0) return 'Nessun testo: il prompt non cambia.';
  const seconds = cost.seconds.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `Circa ${String(cost.tokens)} token, circa ${seconds} s in più a ogni passo sull’M1 Max (stima).`;
}

const DISPLAY_NAME = /^\p{L}[\p{L} '’-]*$/u;

/** Why the form of `agent` cannot be saved, in Italian; undefined when it can. */
export function personaProblem(agent: string, form: PersonaForm): string | undefined {
  const name = form.displayName.trim();
  if (name !== '') {
    if (FIXED_NAMES.includes(agent)) return 'Il nome di Arianna non si cambia.';
    if (characters(name) > MAX_DISPLAY_NAME || !DISPLAY_NAME.test(name)) return `Il nome: da 1 a ${String(MAX_DISPLAY_NAME)} lettere, con spazi, apostrofo o trattino.`;
  }
  if (characters(form.traits) > MAX_TEXT) return `La personalità supera i ${String(MAX_TEXT)} caratteri.`;
  if (characters(form.specialization) > MAX_TEXT) return `La specializzazione supera i ${String(MAX_TEXT)} caratteri.`;
  return undefined;
}

/** The first problem among the agents, with the name of the agent. */
export function personasProblem(forms: Record<string, PersonaForm>, nameOf: (agent: string) => string): string | undefined {
  for (const [agent, form] of Object.entries(forms)) {
    const problem = personaProblem(agent, form);
    if (problem !== undefined) return `${nameOf(agent)}: ${problem}`;
  }
  return undefined;
}

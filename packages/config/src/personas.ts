import { parsePersona, PersonaError, type Persona } from '@arianna/agents';

import { CHARACTER_ID } from './characters.ts';
import { asTable, ConfigError } from './validate.ts';

/**
 * The persona of each agent (D-107): `[personas.<agent>]` of arianna.toml,
 * agent id → tone, form of address, display name, free text and
 * specialization (L1 by the user's declaration). Style and role only: an
 * agent's tools, labels and approvals stay in agents/*.yaml. The type and its
 * checks are in @arianna/agents; an agent without a table has the defaults,
 * which add nothing to its prompt.
 */
export type Personas = Record<string, Persona>;

/** Agents whose name never changes (D-107, answer 2): Arianna stays "Arianna". */
export const FIXED_NAMES: readonly string[] = ['arianna'];

export function parsePersonas(value: unknown): Personas {
  if (value === undefined) return {};
  const table = asTable(value, 'personas');
  const personas: Personas = {};
  for (const [agent, raw] of Object.entries(table)) {
    const where = `personas.${agent}`;
    // Same ids as [characters]; `__proto__` and the like never match.
    if (!CHARACTER_ID.test(agent)) throw new ConfigError(`personas: an agent id is lowercase letters, digits, - and _`);
    try {
      personas[agent] = parsePersona(raw, where);
    } catch (error) {
      // The message names the field, never the user's text.
      if (error instanceof PersonaError) throw new ConfigError(error.message);
      throw error;
    }
    if (FIXED_NAMES.includes(agent) && personas[agent].displayName !== undefined) throw new ConfigError(`${where}.display_name: this agent keeps its name`);
  }
  return personas;
}

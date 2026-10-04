import { parse as parseYaml } from 'yaml';

import { AgentCardError } from './card.ts';

/**
 * Parses YAML for agent cards and for the frontmatter of catalog files, with
 * one set of rules: YAML 1.2 core (no `yes`/`no` booleans, `<<` is a plain
 * key and never merges), duplicate keys rejected, `__proto__` kept as an own
 * key so that the callers' key checks see it. Errors become AgentCardError.
 */
export function parseYamlText(text: string, shown: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new AgentCardError(`${shown}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

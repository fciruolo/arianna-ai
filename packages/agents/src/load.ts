import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Label } from '@arianna/policy';

import { AgentCardError, parseAgentCard, type AgentCard } from './card.ts';
import { parseYamlText } from './yaml.ts';

export const AGENTS_DIR = 'agents';

/** The first line of a card written by the Agents page (D-119): a promoted card keeps it. */
export const USER_CARD_MARK = '# Created from the Agents page (D-119)';

export interface LoadedAgent {
  card: AgentCard;
  /** The prompt text, from `agents/<name>.md`. */
  prompt: string;
  /**
   * `user` for a card of `data/agents` (D-119): its prompt is the user's text,
   * L1 by declaration, while the prompts of `agents/` are L0 (in git).
   */
  origin?: 'user';
}

/**
 * The label of an agent's prompt as the gateway reads it: L0 for a prompt in
 * git, L1 for one written by the user (a card of `data/agents`, or a promoted
 * card with `prompt_label: L1`); a card that says its label is read as it says
 * (a third-party prompt of agency-agents is L0, D-119 tappa T3b).
 */
export function promptLabelOf(agent: LoadedAgent): Label {
  return agent.card.promptLabel ?? (agent.origin === 'user' ? 'L1' : 'L0');
}

/** Reads a regular file of the folder; a symbolic link could point anywhere. */
function readRegular(path: string, shown: string): string {
  let regular: boolean;
  try {
    regular = lstatSync(path).isFile();
  } catch {
    throw new AgentCardError(`${shown} not found`);
  }
  if (!regular) throw new AgentCardError(`${shown} is not a regular file`);
  return readFileSync(path, 'utf8');
}

/** Reads and validates `agents/<name>.yaml` and its prompt. */
export function loadAgent(dir: string, name: string): LoadedAgent {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new AgentCardError(`invalid agent name ${JSON.stringify(name)}`);
  const text = readRegular(join(dir, `${name}.yaml`), `agents/${name}.yaml`);
  const card = parseAgentCard(parseYamlText(text, `agents/${name}.yaml`), name);
  // A card the page wrote and promoted before tappa T3b has no prompt_label: its prompt is still the user's (L1).
  if (card.promptLabel === undefined && text.replace(/^\uFEFF/, '').startsWith(USER_CARD_MARK)) card.promptLabel = 'L1';
  const prompt = readRegular(join(dir, card.prompt), `agents/${name}.yaml: prompt ${card.prompt}`);
  if (prompt.trim() === '') throw new AgentCardError(`agents/${card.prompt} is empty`);
  return { card, prompt };
}

/**
 * Every card in the folder; one invalid card fails the whole load. Anything
 * but `<name>.yaml` and `<name>.md` is an error, so that a misnamed card
 * (`coder.yml`) cannot silently disappear.
 */
export function loadAgents(dir: string): Map<string, LoadedAgent> {
  const entries = readdirSync(dir).sort();
  const stray = entries.filter((entry) => !/^[a-z][a-z0-9-]*\.(yaml|md)$/.test(entry));
  if (stray.length > 0) throw new AgentCardError(`agents/: unexpected file(s) ${stray.join(', ')}`);
  const agents = new Map<string, LoadedAgent>();
  for (const entry of entries) {
    if (!entry.endsWith('.yaml')) continue;
    const name = entry.slice(0, -'.yaml'.length);
    agents.set(name, loadAgent(dir, name));
  }
  const prompts = new Set([...agents.values()].map(({ card }) => card.prompt));
  const orphans = entries.filter((entry) => entry.endsWith('.md') && !prompts.has(entry));
  if (orphans.length > 0) throw new AgentCardError(`agents/: prompt(s) without a card ${orphans.join(', ')}`);
  return agents;
}

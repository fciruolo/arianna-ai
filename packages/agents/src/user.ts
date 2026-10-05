import { lstatSync, readdirSync } from 'node:fs';

import { isAtMost } from '@arianna/policy';
import { stringify as stringifyYaml } from 'yaml';

import { AgentCardError, parseAgentCard, type AgentCard } from './card.ts';
import { loadAgent, type LoadedAgent } from './load.ts';
import { CARD_TEMPLATES, type CardTemplate } from './templates.ts';
import type { ToolId } from './tools.ts';
import { parseYamlText } from './yaml.ts';

/**
 * Agents created by the user from the Agents page (D-119): cards in
 * `data/agents/disattivati` and `data/agents/attivi`, outside git. Whatever
 * such a card says, it stays under a ceiling (L1, A1, no approvals, no
 * delegation or channel): only the cards of `agents/` go beyond it, and a
 * card reaches `agents/` only by the user's promotion.
 */
export const USER_AGENT_STATES = ['disabled', 'active'] as const;
export type UserAgentState = (typeof USER_AGENT_STATES)[number];
/** The folder of each state, under `data/agents`: Italian, as the user sees them. */
export const USER_AGENT_FOLDERS: Readonly<Record<UserAgentState, string>> = { disabled: 'disattivati', active: 'attivi' };

const NAME = /^[a-z][a-z0-9-]{1,39}$/;
/** The name of a user's agent: what the page and the routes accept. */
export const USER_AGENT_NAME = NAME;
/** The first line of a card written by the page: a promoted card keeps it, and only such a card goes back (D-119, tappa T3). */
export const USER_CARD_MARK = '# Created from the Agents page (D-119)';
const MAX_DESCRIPTION = 200;
export const MAX_USER_PROMPT = 4000;
const CEILING_TOOLS: readonly ToolId[] = ['task.delegate', 'channel.send'];

/** Throws unless the card stays under the ceiling of the user's cards. */
export function checkUserCeiling(card: AgentCard): void {
  const fail = (message: string): never => {
    throw new AgentCardError(`${card.name}: ${message} (cards made from the Agents page stay at L1 and A1)`);
  };
  if (!isAtMost(card.maxLabel, 'L1')) fail(`max_label ${card.maxLabel} is above L1`);
  if (card.autonomy !== 'A0' && card.autonomy !== 'A1') fail(`autonomy ${card.autonomy} is above A1`);
  if (card.autonomyDecision !== undefined) fail('autonomy_decision is not allowed');
  if (card.approvals.length > 0) fail('approvals are not allowed');
  const forbidden = card.tools.filter((tool) => CEILING_TOOLS.includes(tool));
  if (forbidden.length > 0) fail(`tool(s) ${forbidden.join(', ')} not allowed`);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item) => b.includes(item));

/**
 * The template a card was made from: tools, executors, trifecta and label
 * exactly as the template has them, autonomy and limits at most its own. A
 * card edited by hand beyond its template matches none and is refused.
 */
export function matchingTemplate(card: AgentCard): CardTemplate | undefined {
  return CARD_TEMPLATES.find(
    (template) =>
      sameSet(card.tools, template.tools) &&
      sameSet(card.executors, template.executors) &&
      card.maxLabel === template.maxLabel &&
      card.cloudMaxLabel === undefined &&
      (Object.keys(template.trifecta) as (keyof CardTemplate['trifecta'])[]).every((side) => card.trifecta[side] === template.trifecta[side]) &&
      (card.autonomy === 'A0' || card.autonomy === template.autonomy) &&
      card.limits.maxSteps <= template.limits.maxSteps &&
      card.limits.maxMinutes <= template.limits.maxMinutes &&
      card.limits.maxCost <= template.limits.maxCost,
  );
}

export interface NewUserAgent {
  name: string;
  description: string;
  template: string;
  prompt: string;
}

export interface UserCardFiles {
  name: string;
  yaml: string;
  md: string;
}

function oneLine(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new AgentCardError(`${what} must be text`);
  const text = value.trim();
  if (text === '') throw new AgentCardError(`${what} is empty`);
  if (text.length > max) throw new AgentCardError(`${what} is longer than ${String(max)} characters`);
  // Control characters (newlines included) would break the card or the shown text.
  if (/\p{Cc}/u.test(text)) throw new AgentCardError(`${what} must be one line`);
  return text;
}

export function templateById(id: string): CardTemplate | undefined {
  return CARD_TEMPLATES.find((template) => template.id === id);
}

/**
 * The files of a new card: everything that opens something comes from the
 * template, from the user only name, description and prompt. The result is
 * checked like any card, and against the ceiling, before it is returned.
 */
export function userCard(input: NewUserAgent): UserCardFiles {
  const name = typeof input.name === 'string' ? input.name : '';
  if (!NAME.test(name)) throw new AgentCardError('the name is 2-40 lowercase letters, digits and -, starting with a letter');
  const description = oneLine(input.description, 'the description', MAX_DESCRIPTION);
  const template = typeof input.template === 'string' ? templateById(input.template) : undefined;
  if (template === undefined) throw new AgentCardError('unknown template');
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') throw new AgentCardError('the prompt is empty');
  const prompt = input.prompt.trim().replace(/\r\n?/g, '\n');
  if (prompt.length > MAX_USER_PROMPT) throw new AgentCardError(`the prompt is longer than ${String(MAX_USER_PROMPT)} characters`);
  if (/[\p{Cc}--[\n\t]]/v.test(prompt)) throw new AgentCardError('the prompt holds control characters (only newlines and tabs)');

  const card = {
    name,
    description,
    max_label: template.maxLabel,
    executors: [...template.executors],
    tools: [...template.tools],
    trifecta: { ...template.trifecta },
    autonomy: template.autonomy,
    difficulty: template.difficulty,
    limits: { max_steps: template.limits.maxSteps, max_minutes: template.limits.maxMinutes, max_cost: template.limits.maxCost },
    approvals: [],
    prompt: `${name}.md`,
  };
  const header = [
    `${USER_CARD_MARK}, template ${template.id}.`,
    '# Tools, labels and autonomy come from the template; while the card is in',
    '# data/agents it stays at L1 and A1, whatever is written here.',
  ].join('\n');
  const yaml = `${header}\n${stringifyYaml(card)}`;
  checkUserCeiling(parseAgentCard(parseYamlText(yaml, `${name}.yaml`), name));
  return { name, yaml, md: `${prompt}\n` };
}

export interface RefusedUserAgent {
  name: string;
  reason: string;
}

/**
 * The user's cards of one folder. Unlike `agents/`, one bad card never stops
 * the others: it is refused with its reason. A card over the ceiling, beyond
 * its template, or with the name of a card in `taken` (the official ones), is
 * refused too. A folder that is a symbolic link is never followed. Other
 * files are left alone: a card in the middle of a move has only one of its two.
 */
export function loadUserAgents(dir: string, taken: ReadonlySet<string>): { agents: Map<string, LoadedAgent>; refused: RefusedUserAgent[] } {
  const agents = new Map<string, LoadedAgent>();
  const refused: RefusedUserAgent[] = [];
  let entries: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return { agents, refused };
    entries = readdirSync(dir).sort();
  } catch {
    return { agents, refused };
  }
  for (const entry of entries) {
    const match = /^([a-z][a-z0-9-]*)\.yaml$/.exec(entry);
    const name = match?.[1];
    if (name === undefined) continue;
    if (taken.has(name)) {
      refused.push({ name, reason: 'an official agent has this name' });
      continue;
    }
    try {
      const agent = loadAgent(dir, name);
      checkUserCeiling(agent.card);
      if (matchingTemplate(agent.card) === undefined) throw new AgentCardError(`${name}: the card does not match any template (tools, executors, trifecta or labels changed)`);
      agents.set(name, { ...agent, origin: 'user' });
    } catch (error) {
      // An unreadable file refuses its card only; the message of the file system names no content.
      refused.push({ name, reason: error instanceof AgentCardError ? error.message : `${name}: cannot be read` });
    }
  }
  return { agents, refused };
}

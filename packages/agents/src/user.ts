import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAtMost } from '@arianna/policy';
import { stringify as stringifyYaml } from 'yaml';

import { AGENCY_CARD_MARK, AGENCY_REPOSITORY } from './agency-mark.ts';
import { AgentCardError, parseAgentCard, type AgentCard } from './card.ts';
import { loadAgent, USER_CARD_MARK, type LoadedAgent } from './load.ts';
import { CARD_TEMPLATES } from './templates.ts';
import { isToolId, type ToolId, type TrifectaSide } from './tools.ts';
import { parseYamlText } from './yaml.ts';

/**
 * Agents created by the user from the Agents page (D-119): cards in
 * `data/agents/disattivati` and `data/agents/attivi`, outside git. Whatever
 * such a card says, it stays under a ceiling (L1, A1, no approvals, no
 * delegation or channel) and within the permissions allowed to user cards
 * (tappa T3b): only the cards of `agents/` go beyond them, and a card reaches
 * `agents/` only by the user's promotion.
 */
export const USER_AGENT_STATES = ['disabled', 'active'] as const;
export type UserAgentState = (typeof USER_AGENT_STATES)[number];
/** The folder of each state, under `data/agents`: Italian, as the user sees them. */
export const USER_AGENT_FOLDERS: Readonly<Record<UserAgentState, string>> = { disabled: 'disattivati', active: 'attivi' };

const NAME = /^[a-z][a-z0-9-]{1,39}$/;
/** The name of a user's agent: what the page and the routes accept. */
export const USER_AGENT_NAME = NAME;
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

/**
 * Where a user's agent works (D-119, tappa T3b): one executor, the local model
 * or Claude. Codex runs the official cards since D-140, not a user's yet.
 */
export const USER_EXECUTORS = ['local', 'claude'] as const;
export type UserExecutor = (typeof USER_EXECUTORS)[number];

/**
 * The tools a user's card may list, by where it works: only the tools that a
 * delegated step runs today. A local delegation is one answer without tools;
 * on Claude the repository tools become Read/Glob/Grep, Edit/Write and Bash in
 * the project folder. Other tools join when a delegation runs them.
 */
export const USER_TOOLS: Readonly<Record<UserExecutor, readonly ToolId[]>> = {
  local: [],
  claude: ['repo.read', 'repo.write', 'repo.test'],
};

/** Tools that act: never with A0, which only proposes. */
export const ACTING_TOOLS: readonly ToolId[] = ['repo.write', 'repo.test'];

/** The highest limits of a user's card: the ones of the Coder's template. Cost is always 0 (the subscription). */
export const USER_LIMITS = { maxSteps: 50, maxMinutes: 45 } as const;

/**
 * The trifecta of every user's card, computed and never chosen: no private
 * data (at most L1), untrusted content open (repositories, and the prompt of a
 * third party), no external communication (no web or channel tool; a cloud
 * run is sandboxed without network).
 */
export const USER_TRIFECTA: Readonly<Record<TrifectaSide, boolean>> = { private_data: false, untrusted_content: true, external_comms: false };

/** What the user chooses on the page, within the ceiling. */
export interface UserPermissions {
  executor: UserExecutor;
  tools: ToolId[];
  autonomy: 'A0' | 'A1';
  maxSteps: number;
  maxMinutes: number;
}

/** A card written by the page, or proposed from agency-agents (its prompt is a third party's: L0). */
export type UserCardOrigin = 'page' | 'agency';

/**
 * The origin of a card from the comments at the top of its file: the mark of
 * the importer, or any of its provenance lines (a card whose first line was
 * removed by hand still holds a third party's prompt).
 */
export function userCardOrigin(yamlText: string): UserCardOrigin {
  const header = leadingComments(yamlText.replace(/^\uFEFF/, ''));
  return header.split('\n').some((line) => line.startsWith(AGENCY_CARD_MARK) || line.includes('pnpm agency:import') || line.includes(AGENCY_REPOSITORY)) ? 'agency' : 'page';
}

/** The rules on the permissions alone; the message names the rule, in English like the other card errors. */
function permissionProblem(permissions: UserPermissions): string | undefined {
  const allowed = USER_TOOLS[permissions.executor];
  const outside = permissions.tools.filter((tool) => !allowed.includes(tool));
  if (outside.length > 0) {
    return permissions.executor === 'local'
      ? `tool(s) ${outside.join(', ')} not allowed on the local model: a local agent only answers`
      : `tool(s) ${outside.join(', ')} not allowed for a user's agent`;
  }
  const acting = permissions.tools.filter((tool) => ACTING_TOOLS.includes(tool));
  if (permissions.autonomy === 'A0' && acting.length > 0) return `tool(s) ${acting.join(', ')} act: not allowed with A0, which only proposes`;
  if (permissions.maxSteps > USER_LIMITS.maxSteps) return `max_steps ${String(permissions.maxSteps)} is above ${String(USER_LIMITS.maxSteps)}`;
  if (permissions.maxMinutes > USER_LIMITS.maxMinutes) return `max_minutes ${String(permissions.maxMinutes)} is above ${String(USER_LIMITS.maxMinutes)}`;
  return undefined;
}

const sameTrifecta = (a: Readonly<Record<TrifectaSide, boolean>>, b: Readonly<Record<TrifectaSide, boolean>>): boolean =>
  (Object.keys(USER_TRIFECTA) as TrifectaSide[]).every((side) => a[side] === b[side]);

/**
 * The permissions of a user's card, if it stays within the list allowed to
 * such cards (D-119, tappa T3b; replaces the match with a template): the
 * ceiling, one executor of `USER_EXECUTORS`, tools of `USER_TOOLS` for it, no
 * acting tool with A0, the computed trifecta, label L0 or L1 (L0 and a prompt
 * at L0 for a card of agency-agents), no `cloud_max_label`, difficulty normal,
 * limits under `USER_LIMITS` and cost 0. Throws `AgentCardError` otherwise.
 */
export function checkUserPermissions(card: AgentCard, origin: UserCardOrigin): UserPermissions {
  checkUserCeiling(card);
  const fail = (message: string): never => {
    throw new AgentCardError(`${card.name}: ${message} (permissions of a user's agent, D-119)`);
  };
  const [executor] = card.executors;
  if (card.executors.length !== 1 || executor === undefined || !(USER_EXECUTORS as readonly string[]).includes(executor)) {
    fail(`executors must be one of ${USER_EXECUTORS.join(', ')}`);
  }
  if (!sameTrifecta(card.trifecta, USER_TRIFECTA)) fail('trifecta must be private_data false, untrusted_content true, external_comms false');
  if (card.cloudMaxLabel !== undefined) fail('cloud_max_label is not allowed');
  if (origin === 'agency') {
    if (card.maxLabel !== 'L0') fail('a card of agency-agents stays at L0: its prompt is a third party\'s');
    if (card.promptLabel !== 'L0') fail('a card of agency-agents needs prompt_label L0');
  } else if (card.promptLabel !== undefined && card.promptLabel !== 'L1') {
    fail('the prompt of a user\'s card is L1');
  }
  if (card.difficulty !== 'normal') fail('difficulty must be normal');
  if (card.limits.maxCost !== 0) fail('max_cost must be 0');
  const permissions: UserPermissions = {
    executor: executor as UserExecutor,
    tools: [...card.tools],
    autonomy: card.autonomy as 'A0' | 'A1',
    maxSteps: card.limits.maxSteps,
    maxMinutes: card.limits.maxMinutes,
  };
  const problem = permissionProblem(permissions);
  if (problem !== undefined) fail(problem);
  return permissions;
}

/**
 * The permissions sent by the page, checked: exactly the five fields, an
 * executor and an autonomy of the list, tools of the registry listed once
 * (kept in the order of `USER_TOOLS`), whole limits from 1 to the ceiling,
 * and the rules of `checkUserPermissions`.
 */
export function parseUserPermissions(raw: unknown): UserPermissions {
  const fail = (message: string): never => {
    throw new AgentCardError(`permissions: ${message}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('expected an object');
  const table = Object.assign(Object.create(null) as Record<string, unknown>, raw);
  const keys = ['executor', 'tools', 'autonomy', 'maxSteps', 'maxMinutes'];
  const extra = Object.keys(table).filter((key) => !keys.includes(key));
  if (extra.length > 0) fail(`unknown field(s) ${extra.join(', ')}`);
  const executor = USER_EXECUTORS.find((item) => item === table.executor) ?? fail(`executor must be one of ${USER_EXECUTORS.join(', ')}`);
  const autonomy = (['A0', 'A1'] as const).find((item) => item === table.autonomy) ?? fail('autonomy must be A0 or A1');
  if (!Array.isArray(table.tools)) return fail('tools must be a list');
  const given = table.tools as unknown[];
  for (const tool of given) if (!isToolId(tool)) fail(`tool ${JSON.stringify(tool)} is not in the registry`);
  const tools = given as ToolId[];
  if (new Set(tools).size !== tools.length) fail('a tool is listed twice');
  const whole = (value: unknown, field: string, max: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max ? value : fail(`${field} must be a whole number from 1 to ${String(max)}`);
  const permissions: UserPermissions = {
    executor,
    // The order of the list, whatever the order of the clicks: the same choice writes the same card.
    tools: USER_TOOLS[executor].filter((tool) => tools.includes(tool)),
    autonomy,
    maxSteps: whole(table.maxSteps, 'maxSteps', USER_LIMITS.maxSteps),
    maxMinutes: whole(table.maxMinutes, 'maxMinutes', USER_LIMITS.maxMinutes),
  };
  // Tools outside the list are refused, not dropped: the order filter above would hide them.
  const problem = permissionProblem({ ...permissions, tools });
  if (problem !== undefined) fail(problem);
  return permissions;
}

export interface UserPreset {
  /** The id of the template it comes from. */
  id: string;
  permissions: UserPermissions;
}

/**
 * The starting points of the page: the templates whose permissions fit the
 * list (`code` and `answer`; `web` waits for the web tools). Only a
 * suggestion: the card is checked by the rules, never against a template.
 */
export function userPresets(): UserPreset[] {
  const presets: UserPreset[] = [];
  for (const template of CARD_TEMPLATES) {
    const executor: UserExecutor = template.executors.includes('claude') ? 'claude' : 'local';
    if (template.tools.some((tool) => !USER_TOOLS[executor].includes(tool) && !['task.update', 'user.ask'].includes(tool))) continue;
    const permissions: UserPermissions = {
      executor,
      tools: USER_TOOLS[executor].filter((tool) => template.tools.includes(tool)),
      autonomy: template.autonomy === 'A1' ? 'A1' : 'A0',
      maxSteps: Math.min(template.limits.maxSteps, USER_LIMITS.maxSteps),
      maxMinutes: Math.min(template.limits.maxMinutes, USER_LIMITS.maxMinutes),
    };
    if (permissionProblem(permissions) === undefined) presets.push({ id: template.id, permissions });
  }
  return presets;
}

export interface NewUserAgent {
  name: string;
  description: string;
  prompt: string;
  permissions: unknown;
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

function promptText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new AgentCardError('the prompt is empty');
  const prompt = value.trim().replace(/\r\n?/g, '\n');
  if (prompt.length > MAX_USER_PROMPT) throw new AgentCardError(`the prompt is longer than ${String(MAX_USER_PROMPT)} characters`);
  if (/[\p{Cc}--[\n\t]]/v.test(prompt)) throw new AgentCardError('the prompt holds control characters (only newlines and tabs)');
  return prompt;
}

/** The comment lines at the top of a card file: an agency card keeps its provenance when rewritten. */
function leadingComments(yamlText: string): string {
  const lines: string[] = [];
  for (const line of yamlText.split('\n')) {
    if (!line.startsWith('#')) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * The files of a user's card: name, description and prompt from the user,
 * permissions as chosen within the list; label, prompt label and trifecta
 * computed. A card of agency-agents (`origin: 'agency'`, with `header` its
 * provenance lines) stays at L0 with its prompt at L0. The result is checked
 * like any card, and by `checkUserPermissions`, before it is returned.
 */
export function userCard(input: NewUserAgent, options: { origin?: UserCardOrigin; header?: string } = {}): UserCardFiles {
  const origin = options.origin ?? 'page';
  const name = typeof input.name === 'string' ? input.name : '';
  if (!NAME.test(name)) throw new AgentCardError('the name is 2-40 lowercase letters, digits and -, starting with a letter');
  const description = oneLine(input.description, 'the description', MAX_DESCRIPTION);
  const permissions = parseUserPermissions(input.permissions);
  const prompt = promptText(input.prompt);
  const label = origin === 'agency' ? 'L0' : 'L1';

  const card = {
    name,
    description,
    max_label: label,
    executors: [permissions.executor],
    tools: [...permissions.tools],
    trifecta: { ...USER_TRIFECTA },
    autonomy: permissions.autonomy,
    difficulty: 'normal',
    limits: { max_steps: permissions.maxSteps, max_minutes: permissions.maxMinutes, max_cost: 0 },
    approvals: [],
    prompt: `${name}.md`,
    prompt_label: label,
  };
  const header =
    origin === 'agency'
      ? leadingComments(options.header ?? '')
      : [
          `${USER_CARD_MARK}, permissions chosen within the ceiling (tappa T3b).`,
          '# While the card is in data/agents it stays at L1 and A1, with the tools',
          '# allowed to user cards, whatever is written here.',
        ].join('\n');
  if (origin === 'agency' && !header.startsWith(AGENCY_CARD_MARK)) throw new AgentCardError('a card of agency-agents keeps its provenance');
  const yaml = `${header}\n${stringifyYaml(card)}`;
  checkUserPermissions(parseAgentCard(parseYamlText(yaml, `${name}.yaml`), name), origin);
  return { name, yaml, md: `${prompt}\n` };
}

/** Reads a file without following a link put in its place after `loadAgent` checked it. */
function readNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
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
      checkUserPermissions(agent.card, userCardOrigin(readNoFollow(join(dir, entry))));
      agents.set(name, { ...agent, origin: 'user' });
    } catch (error) {
      // An unreadable file refuses its card only; the message of the file system names no content.
      refused.push({ name, reason: error instanceof AgentCardError ? error.message : `${name}: cannot be read` });
    }
  }
  return { agents, refused };
}

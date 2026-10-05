import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AgentCardError,
  CARD_TEMPLATES,
  loadAgent,
  loadUserAgents,
  USER_AGENT_FOLDERS,
  userCard,
  type AgentCard,
  type LoadedAgent,
  type NewUserAgent,
  type RefusedUserAgent,
  type UserAgentState,
} from '@arianna/agents';
import { scanText } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

/**
 * The agents the user creates from the Agents page (D-119). Their cards live
 * in `data/agents/disattivati` and `data/agents/attivi` and stay under the
 * ceiling of `checkUserCeiling` (L1, A1) and match their template.
 * Activating and deactivating change the map of the running agents at once:
 * a delegation planned for an agent deactivated meanwhile fails, and the task
 * goes on. Promotion moves a card into `agents/`, where the ceiling no longer
 * applies: only on the user's click, with `confirm`.
 */
export class UserAgentError extends Error {
  override name = 'UserAgentError';
  readonly code: 'invalid' | 'conflict' | 'not-found';
  constructor(code: 'invalid' | 'conflict' | 'not-found', message: string) {
    super(message);
    this.code = code;
  }
}

export interface UserAgentView {
  name: string;
  description: string;
  state: UserAgentState | 'official';
  card: CardSummary;
}

export interface CardSummary {
  maxLabel: string;
  cloudMaxLabel?: string;
  executors: string[];
  tools: string[];
  trifecta: AgentCard['trifecta'];
  autonomy: string;
  approvals: string[];
  limits: AgentCard['limits'];
}

export interface UserAgentListing {
  official: UserAgentView[];
  user: UserAgentView[];
  refused: (RefusedUserAgent & { state: UserAgentState })[];
}

export interface UserAgents {
  /** Adds the active cards to the running agents; called once at start. */
  load(): RefusedUserAgent[];
  list(): UserAgentListing;
  sources(): { templates: CardSummaryTemplate[] };
  create(input: NewUserAgent): UserAgentView;
  permissions(name: string): UserAgentView;
  activate(name: string): UserAgentView;
  deactivate(name: string): UserAgentView;
  promote(name: string, confirm: unknown): UserAgentView;
}

export interface CardSummaryTemplate extends CardSummary {
  id: string;
}

function summary(card: AgentCard): CardSummary {
  const result: CardSummary = {
    maxLabel: card.maxLabel,
    executors: [...card.executors],
    tools: [...card.tools],
    trifecta: { ...card.trifecta },
    autonomy: card.autonomy,
    approvals: [...card.approvals],
    limits: { ...card.limits },
  };
  if (card.cloudMaxLabel !== undefined) result.cloudMaxLabel = card.cloudMaxLabel;
  return result;
}

function view(agent: LoadedAgent, state: UserAgentView['state']): UserAgentView {
  return { name: agent.card.name, description: agent.card.description, state, card: summary(agent.card) };
}

/**
 * The user's text is L1 by declaration (like a persona, D-107) and may reach
 * a cloud executor: a finding of the scanner or a value of the vault refuses
 * it, naming the field and the kind, never the text.
 */
function checkText(text: unknown, field: string): void {
  if (typeof text !== 'string') return;
  const kinds = [...new Set(scanText(text).map((finding) => finding.kind))];
  if (kinds.length > 0) throw new UserAgentError('invalid', `${field} looks like personal data or a secret (${kinds.join(', ')}): not saved`);
  if (knownSecrets.find(text).length > 0) throw new UserAgentError('invalid', `${field} holds a value of the vault: not saved`);
}

/** A rename, or a copy when `data/` is on another volume than `agents/` (promotion). */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    rmSync(from);
  }
}

export function createUserAgents(options: {
  home: string;
  dataDir: string;
  /** The running agents, shared with the orchestrator and the worker. */
  agents: Map<string, LoadedAgent>;
  /** The names of the cards of `agents/`, read at start: never a user card's name. */
  official: ReadonlySet<string>;
}): UserAgents {
  const { agents } = options;
  const official = new Set(options.official);
  const officialDir = join(options.home, 'agents');
  const dirOf = (state: UserAgentState): string => join(options.dataDir, 'agents', USER_AGENT_FOLDERS[state]);

  /** The two folders, created if missing; a symbolic link in their place is refused, never followed. */
  function folders(): void {
    for (const state of ['disabled', 'active'] as const) {
      mkdirSync(dirOf(state), { recursive: true, mode: 0o700 });
      if (!lstatSync(dirOf(state)).isDirectory()) throw new UserAgentError('invalid', `data/agents/${USER_AGENT_FOLDERS[state]} is not a folder`);
    }
  }

  function read(state: UserAgentState): { agents: Map<string, LoadedAgent>; refused: RefusedUserAgent[] } {
    return loadUserAgents(dirOf(state), official);
  }

  function find(name: string): { state: UserAgentState; agent: LoadedAgent } {
    for (const state of ['active', 'disabled'] as const) {
      const agent = read(state).agents.get(name);
      if (agent !== undefined) return { state, agent };
    }
    throw new UserAgentError('not-found', `no user agent ${JSON.stringify(name)}`);
  }

  /** The prompt first and the card last: a half move leaves a card without prompt, refused and shown. */
  function move(name: string, from: string, to: string): void {
    moveFile(join(from, `${name}.md`), join(to, `${name}.md`));
    try {
      moveFile(join(from, `${name}.yaml`), join(to, `${name}.yaml`));
    } catch (error) {
      // Never a prompt without its card (in agents/ it would stop the core at start).
      moveFile(join(to, `${name}.md`), join(from, `${name}.md`));
      throw error;
    }
  }

  function taken(name: string): boolean {
    if (official.has(name)) return true;
    return (['disabled', 'active'] as const).some((state) => existsSync(join(dirOf(state), `${name}.yaml`)) || existsSync(join(dirOf(state), `${name}.md`)));
  }

  return {
    load() {
      const { agents: active, refused } = read('active');
      for (const [name, agent] of active) agents.set(name, agent);
      return refused;
    },

    list() {
      const listing: UserAgentListing = { official: [], user: [], refused: [] };
      for (const name of [...official].sort()) {
        const agent = agents.get(name);
        if (agent !== undefined) listing.official.push(view(agent, 'official'));
      }
      const seen = new Set<string>();
      for (const state of ['active', 'disabled'] as const) {
        const { agents: found, refused } = read(state);
        for (const agent of found.values()) {
          // The same name in both folders: the active card counts, the other is shown as refused.
          if (seen.has(agent.card.name)) listing.refused.push({ name: agent.card.name, reason: 'the same agent is also active', state });
          else listing.user.push(view(agent, state));
          seen.add(agent.card.name);
        }
        for (const item of refused) listing.refused.push({ ...item, state });
      }
      return listing;
    },

    sources() {
      // The proposals of agency-agents join in tappa T4, after the review.
      const templates = CARD_TEMPLATES.map((template) => ({
        id: template.id,
        maxLabel: template.maxLabel,
        executors: [...template.executors],
        tools: [...template.tools],
        trifecta: { ...template.trifecta },
        autonomy: template.autonomy,
        approvals: [],
        limits: { ...template.limits },
      }));
      return { templates };
    },

    create(input) {
      const given = input as Partial<Record<keyof NewUserAgent, unknown>>;
      checkText(typeof given.name === 'string' ? given.name.toUpperCase() : given.name, 'the name');
      checkText(given.description, 'the description');
      checkText(given.prompt, 'the prompt');
      let files;
      try {
        files = userCard(input);
      } catch (error) {
        if (error instanceof AgentCardError) throw new UserAgentError('invalid', error.message);
        throw error;
      }
      if (taken(files.name)) throw new UserAgentError('conflict', `an agent named ${files.name} already exists`);
      folders();
      const dir = dirOf('disabled');
      // `wx`: a card written meanwhile is never overwritten.
      writeFileSync(join(dir, `${files.name}.md`), files.md, { mode: 0o600, flag: 'wx' });
      writeFileSync(join(dir, `${files.name}.yaml`), files.yaml, { mode: 0o600, flag: 'wx' });
      return view(loadAgent(dir, files.name), 'disabled');
    },

    permissions(name) {
      const { state, agent } = find(name);
      return view(agent, state);
    },

    activate(name) {
      const { state, agent } = find(name);
      if (state === 'disabled') {
        folders();
        move(name, dirOf('disabled'), dirOf('active'));
      }
      agents.set(name, agent);
      return view(agent, 'active');
    },

    deactivate(name) {
      const { state, agent } = find(name);
      if (state === 'active') {
        folders();
        move(name, dirOf('active'), dirOf('disabled'));
      }
      agents.delete(name);
      return view(agent, 'disabled');
    },

    promote(name, confirm) {
      if (confirm !== true) throw new UserAgentError('invalid', 'promotion needs the confirmation of the user');
      const { state } = find(name);
      if (existsSync(join(officialDir, `${name}.yaml`)) || existsSync(join(officialDir, `${name}.md`))) {
        throw new UserAgentError('conflict', `agents/ already has ${name}`);
      }
      move(name, dirOf(state), officialDir);
      const agent = loadAgent(officialDir, name);
      official.add(name);
      // A promoted agent is active: an official card always is.
      agents.set(name, agent);
      return view(agent, 'official');
    },
  };
}

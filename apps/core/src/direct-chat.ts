import { isFinanceCard, type LoadedAgent } from '@arianna/agents';
import { isAtMost, type ConversationMode } from '@arianna/policy';

import { CLAUDE_CHAT_AGENT, CODEX_CHAT_AGENT, LOCAL_CHAT_AGENT } from './conversations.ts';
import type { TaskLimits } from './limits.ts';
import { GOD_AGENT, GOD_PROJECT } from './god/clone.ts';
import { briefCeiling, CLOUD_DELEGATES, delegationRoute, isCloudRoute } from './orchestrator/delegate.ts';

/**
 * The direct chat with any agent (D-111d): who the user may talk with in
 * place of Arianna, and how, from the agent's card. An agent on Claude Code
 * or Codex (D-140) works in the folder of a project, so it needs a work
 * conversation on one (every message goes as it is to the cloud). A local agent answers with one call to
 * the local model: a work conversation, or a private one when its card may
 * read L2. Arianna is never one: she answers when nobody else does.
 */
export interface DirectPolicy {
  agent: string;
  description: string;
  /** Every message goes to the cloud: the warning, "va a Claude", the context indicator. */
  cloud: boolean;
  /** The cloud executors of its card that run now, in the card's order (D-140): what the warning names. */
  executors: ('claude' | 'codex')[];
  /** The modes the conversation may have with this agent. */
  modes: ConversationMode[];
  /** The conversation needs one of the approved projects. */
  project: boolean;
  /**
   * Only on a part of this project (D-127): GOD works on the clones of
   * Arianna's code alone. The chat opens it from its own entry, not from the
   * list of agents of "+ Nuovo".
   */
  container?: string;
  /**
   * The agent of the Finances (D-183): its conversation is private and marked
   * from birth, and it answers with its read-only tools on the local model.
   */
  finance?: true;
  /**
   * «Con chi parli» (D-111, tappa B): the local model or a plain chat with
   * Claude, offered first in "+ Nuovo"; not an agent of the team.
   */
  interlocutor?: true;
}

/** An interlocutor of «Con chi parli» that cannot answer now, with why: "+ Nuovo" shows it off. */
export interface OffInterlocutor {
  agent: string;
  description: string;
  reason: string;
}

/** What the plain chats say of themselves (L0, ours). */
const CLAUDE_CHAT_DESCRIPTION = 'Chat semplice con Claude, senza strumenti né progetto: ogni messaggio va ad Anthropic';
const CODEX_CHAT_DESCRIPTION = 'Chat semplice con i modelli di ChatGPT nella CLI codex, senza progetto';
/**
 * Why ChatGPT without a project is off (D-111, tappa B): the adapter of Codex
 * runs only in the folder of a project (D-140); a run in an empty folder of
 * the conversation is not built nor tried live yet. With a project, the Coder
 * on Codex answers.
 */
export const CODEX_CHAT_OFF = 'codex does not answer a conversation without a project yet: with a project, talk with the Coder';
export const CLAUDE_CHAT_OFF = 'claude is off or does not run on this machine';

/** The plain chat with Claude (D-111, tappa B), while Claude runs. */
function claudeChatPolicy(): DirectPolicy {
  return { agent: CLAUDE_CHAT_AGENT, description: CLAUDE_CHAT_DESCRIPTION, cloud: true, executors: ['claude'], modes: ['work'], project: false, interlocutor: true };
}

/** The interlocutors of «Con chi parli» that cannot answer now (D-111, tappa B). */
/**
 * The caps of the task of a plain chat with Claude or ChatGPT (D-209): they have
 * no card, and a task without caps never starts. One answer is one step; a
 * resumed session that is gone starts once more (c2), hence two, and a margin.
 */
export const PLAIN_CHAT_LIMITS: Readonly<TaskLimits> = Object.freeze({ maxSteps: 3, maxMinutes: 15 });

/** The caps of a task by its assignee: the card's, the plain chats' fixed ones, none for anyone else. */
export function assigneeLimits(agents: ReadonlyMap<string, LoadedAgent>, assignee: string): TaskLimits {
  if (assignee === CLAUDE_CHAT_AGENT || assignee === CODEX_CHAT_AGENT) return { ...PLAIN_CHAT_LIMITS };
  return agents.get(assignee)?.card.limits ?? {};
}

export function offInterlocutors(available: { claude: boolean; codex: boolean }): OffInterlocutor[] {
  return [
    ...(available.claude ? [] : [{ agent: CLAUDE_CHAT_AGENT, description: CLAUDE_CHAT_DESCRIPTION, reason: CLAUDE_CHAT_OFF }]),
    { agent: CODEX_CHAT_AGENT, description: CODEX_CHAT_DESCRIPTION, reason: CODEX_CHAT_OFF },
  ];
}

/** True when `project` (a part `<container>:<part>`, or a project of one part) belongs to the container the policy asks for, or the policy asks for none. */
export function projectFits(policy: Pick<DirectPolicy, 'container'>, project: string | undefined): boolean {
  if (policy.container === undefined) return true;
  return project !== undefined && (project === policy.container || project.startsWith(`${policy.container}:`));
}

/** The policy of one agent, or undefined when it cannot answer a direct chat now (its executor is off). */
export function directPolicyOf(name: string, agent: LoadedAgent, available: { claude: boolean; codex: boolean }): DirectPolicy | undefined {
  if (name === 'arianna' || name === CLAUDE_CHAT_AGENT || name === CODEX_CHAT_AGENT) return undefined;
  // The local model with the knowledge base read only (D-111, tappa B): a private conversation, its own tools on the local model.
  if (name === LOCAL_CHAT_AGENT) {
    if (!agent.card.executors.every((executor) => executor === 'local')) return undefined;
    return { agent: name, description: agent.card.description, cloud: false, executors: [], modes: ['private'], project: false, interlocutor: true };
  }
  // The agent of the Finances (D-183): only in a private conversation, marked from birth, nothing of it goes out.
  // It answers with its tools on the local model (as Arianna does), not with one call like the other local agents.
  if (isFinanceCard(agent.card) && agent.card.executors.every((executor) => executor === 'local')) {
    return { agent: name, description: agent.card.description, cloud: false, executors: [], modes: ['private'], project: false, finance: true };
  }
  const route = delegationRoute(agent.card);
  if (isCloudRoute(route)) {
    const executors = agent.card.executors.filter((executor): executor is 'claude' | 'codex' => (CLOUD_DELEGATES as readonly string[]).includes(executor) && available[executor as 'claude' | 'codex']);
    if (executors.length === 0) return undefined;
    return { agent: name, description: agent.card.description, cloud: true, executors, modes: ['work'], project: true, ...(name === GOD_AGENT ? { container: GOD_PROJECT } : {}) };
  }
  if (route === 'local') {
    // A brief of a private conversation is L2: only an agent that may read it answers there without a declassification.
    const modes: ConversationMode[] = isAtMost('L2', briefCeiling(agent.card)) ? ['private', 'work'] : ['work'];
    return { agent: name, description: agent.card.description, cloud: false, executors: [], modes, project: false };
  }
  return undefined;
}

/**
 * Every agent the user may talk with now: the interlocutors of «Con chi
 * parli» first (the local model, Claude), then the Coder, then by name.
 */
export function directPolicies(agents: ReadonlyMap<string, LoadedAgent>, available: { claude: boolean; codex: boolean }): DirectPolicy[] {
  const out: DirectPolicy[] = available.claude ? [claudeChatPolicy()] : [];
  for (const [name, agent] of agents) {
    const policy = directPolicyOf(name, agent, available);
    if (policy !== undefined) out.push(policy);
  }
  const rank = (name: string): number => (name === LOCAL_CHAT_AGENT ? 0 : name === CLAUDE_CHAT_AGENT ? 1 : name === 'coder' ? 2 : 3);
  return out.sort((a, b) => rank(a.agent) - rank(b.agent) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
}
